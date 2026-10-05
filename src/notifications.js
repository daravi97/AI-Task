// Email delivery: SMTP transport, a durable outbox with retries, and the day-before reminder job.
const nodemailer = require('nodemailer');
const { templates } = require('./emails');
const config = require('./config');

const MAX_ATTEMPTS = 5;
const ACTIVE_STATUSES = "('pending', 'processing', 'ready')";

// ---------- Transport ----------

// Uses SMTP when SMTP_HOST is set; otherwise emails are only written to the log so
// development and demos work without a mail server.
function createMailer(env = process.env) {
  const from = env.MAIL_FROM || 'Merch Store <no-reply@localhost>';
  if (!env.SMTP_HOST) {
    return {
      mode: 'log',
      from,
      async send(msg) {
        console.log(`[email:log] to=${msg.to} subject="${msg.subject}" (SMTP not configured, not delivered)`);
        return { messageId: null };
      },
    };
  }
  const port = Number(env.SMTP_PORT || 587);
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port,
    secure: env.SMTP_SECURE ? env.SMTP_SECURE === 'true' : port === 465,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
  });
  return {
    mode: 'smtp',
    from,
    send: (msg) => transport.sendMail({ from, ...msg }),
    verify: () => transport.verify(),
  };
}

// ---------- Queueing ----------

function loadOrder(db, orderId) {
  const order = db.prepare(
    'SELECT o.*, u.name AS user_name, u.email AS user_email FROM orders o JOIN users u ON u.id = o.user_id WHERE o.id = ?'
  ).get(orderId);
  if (!order) return null;
  order.items = db.prepare('SELECT product_name, unit_price, quantity FROM order_items WHERE order_id = ?').all(orderId);
  return order;
}

function enqueue(db, { kind, toEmail, toName, subject, html, text, orderId = null }) {
  db.prepare(
    `INSERT INTO email_outbox (kind, to_email, to_name, subject, html, text, order_id, next_attempt_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(kind, toEmail, toName ?? null, subject, html, text, orderId, new Date().toISOString());
}

// Queue an order email of the given kind (a key of `templates`). Call inside the same
// transaction as the change so the email is sent if and only if the change commits.
function queueOrderEmail(db, orderId, kind) {
  const order = loadOrder(db, orderId);
  if (!order) return;
  const day = order.collection_day_id
    ? db.prepare('SELECT * FROM collection_days WHERE id = ?').get(order.collection_day_id)
    : null;
  const { subject, html, text } = templates[kind](order, day);
  enqueue(db, { kind, toEmail: order.user_email, toName: order.user_name, subject, html, text, orderId });
}

function queueTestEmail(db, user) {
  const { subject, html, text } = templates.test(user);
  enqueue(db, { kind: 'test', toEmail: user.email, toName: user.name, subject, html, text });
}

// ---------- Delivery worker ----------

async function processOutbox(db, mailer, { batchSize = 25, now = new Date() } = {}) {
  const due = db.prepare(
    "SELECT * FROM email_outbox WHERE status = 'queued' AND next_attempt_at <= ? ORDER BY id LIMIT ?"
  ).all(now.toISOString(), batchSize);

  let sent = 0;
  for (const email of due) {
    try {
      await mailer.send({
        to: email.to_name ? `"${email.to_name.replace(/"/g, '')}" <${email.to_email}>` : email.to_email,
        subject: email.subject,
        html: email.html,
        text: email.text,
      });
      db.prepare(
        "UPDATE email_outbox SET status = 'sent', attempts = attempts + 1, sent_at = datetime('now'), last_error = NULL WHERE id = ?"
      ).run(email.id);
      sent++;
    } catch (err) {
      const attempts = email.attempts + 1;
      const failed = attempts >= MAX_ATTEMPTS;
      // Back off 1, 4, 9, 16 minutes between retries.
      const next = new Date(now.getTime() + attempts * attempts * 60_000).toISOString();
      db.prepare(
        'UPDATE email_outbox SET status = ?, attempts = ?, last_error = ?, next_attempt_at = ? WHERE id = ?'
      ).run(failed ? 'failed' : 'queued', attempts, String(err.message).slice(0, 500), next, email.id);
      console.error(`[email] failed to send #${email.id} to ${email.to_email} (attempt ${attempts}): ${err.message}`);
    }
  }
  return { attempted: due.length, sent };
}

function retryEmail(db, id) {
  return db.prepare(
    "UPDATE email_outbox SET status = 'queued', attempts = 0, next_attempt_at = ? WHERE id = ? AND status = 'failed'"
  ).run(new Date().toISOString(), id).changes > 0;
}

function listEmails(db, { limit = 100 } = {}) {
  return db.prepare(
    `SELECT id, kind, to_email, to_name, subject, order_id, status, attempts, last_error, created_at, sent_at
       FROM email_outbox ORDER BY id DESC LIMIT ?`
  ).all(limit);
}

function getEmail(db, id) {
  return db.prepare('SELECT * FROM email_outbox WHERE id = ?').get(id) ?? null;
}

// ---------- Reminder job ----------

// Queue a reminder for every active order whose collection day is tomorrow and that
// hasn't had one yet. Runs from the reminder hour onwards so emails arrive in the morning.
function runReminders(db, { now = new Date(), timezone = config.settings.timezone, reminderHour = config.settings.reminderHour } = {}) {
  if (config.currentHour(timezone, now) < reminderHour) return { queued: 0 };
  const tomorrow = config.addDays(config.today(timezone, now), 1);
  const orders = db.prepare(
    `SELECT o.id FROM orders o JOIN collection_days d ON d.id = o.collection_day_id
      WHERE d.date = ? AND o.status IN ${ACTIVE_STATUSES} AND o.reminder_sent_at IS NULL`
  ).all(tomorrow);

  const mark = db.prepare('UPDATE orders SET reminder_sent_at = ? WHERE id = ?');
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const { id } of orders) {
      queueOrderEmail(db, id, 'collection_reminder');
      mark.run(now.toISOString(), id);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { queued: orders.length };
}

// ---------- Scheduler ----------

function startScheduler(db, mailer, { outboxEveryMs = 30_000, remindersEveryMs = 15 * 60_000 } = {}) {
  let busy = false;
  const drain = async () => {
    if (busy) return;
    busy = true;
    try { await processOutbox(db, mailer); } catch (err) { console.error('[email] outbox error:', err); } finally { busy = false; }
  };
  const remind = () => {
    try {
      const { queued } = runReminders(db);
      if (queued) console.log(`[email] queued ${queued} collection reminder(s)`);
      drain();
    } catch (err) { console.error('[email] reminder job error:', err); }
  };
  const timers = [setInterval(drain, outboxEveryMs), setInterval(remind, remindersEveryMs)];
  remind();
  return {
    drain,
    stop: () => timers.forEach(clearInterval),
  };
}

module.exports = {
  createMailer, queueOrderEmail, queueTestEmail, processOutbox, retryEmail, listEmails, getEmail,
  runReminders, startScheduler, ACTIVE_STATUSES,
};
