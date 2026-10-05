// Email delivery: SMTP transport, a durable outbox with retries, and the day-before reminder job.
const nodemailer = require('nodemailer');
const { templates, QR_CID } = require('./emails');
const qr = require('./qr');
const config = require('./config');

const MAX_ATTEMPTS = 5;
const ACTIVE_STATUSES = "('pending', 'processing', 'ready')";

// ---------- Transport ----------

const ETHEREAL_LOGIN = 'https://ethereal.email/login';
// Fail fast instead of hanging for minutes when a host blocks SMTP ports (e.g. Render's free plan).
const TIMEOUTS = { connectionTimeout: 15_000, greetingTimeout: 10_000, socketTimeout: 30_000 };

function smtpTransport({ host, port, secure, user, pass }) {
  return nodemailer.createTransport({ host, port, secure, auth: user ? { user, pass } : undefined, ...TIMEOUTS });
}

// Three ways to send, switchable at runtime:
//   smtp     – SMTP_HOST is set (your mail server, Mailtrap, Brevo, Gmail…)
//   ethereal – a free fake inbox at ethereal.email; emails never reach real people. Turned on
//              from Admin → Emails, or with SMTP_HOST=ethereal. The account is kept in the
//              database so the same inbox is reused after a restart.
//   log      – nothing configured: emails are only recorded in Admin → Emails.
function createMailer(env = process.env, { db = null, etherealApi } = {}) {
  const from = env.MAIL_FROM || 'Merch Store <no-reply@merch-store.local>';
  const host = String(env.SMTP_HOST || '').trim();
  const fixedSmtp = host && !['ethereal', 'none'].includes(host.toLowerCase());
  let impl = null;

  const logImpl = {
    mode: 'log',
    async send(msg) {
      console.log(`[email:log] to=${msg.to} subject="${msg.subject}" (SMTP not configured, not delivered)`);
      return { messageId: null };
    },
  };

  function useAccount(account) {
    const transport = smtpTransport({
      host: account.smtp.host, port: account.smtp.port, secure: account.smtp.secure, user: account.user, pass: account.pass,
    });
    impl = {
      mode: 'ethereal',
      account,
      send: async (msg) => {
        const info = await transport.sendMail({ from, ...msg });
        return { ...info, previewUrl: nodemailer.getTestMessageUrl(info) || null };
      },
      verify: () => transport.verify(),
    };
  }

  const savedAccount = () => {
    if (!db) return null;
    const row = db.prepare("SELECT value FROM app_settings WHERE key = 'ethereal_account'").get();
    return row ? JSON.parse(row.value) : null;
  };

  if (fixedSmtp) {
    const port = Number(env.SMTP_PORT || 587);
    const transport = smtpTransport({
      host, port, secure: env.SMTP_SECURE ? env.SMTP_SECURE === 'true' : port === 465, user: env.SMTP_USER, pass: env.SMTP_PASS,
    });
    impl = {
      mode: 'smtp',
      host,
      port,
      send: async (msg) => {
        const info = await transport.sendMail({ from, ...msg });
        // An Ethereal account typed into .env also gets "Delivered copy" links.
        return { ...info, previewUrl: nodemailer.getTestMessageUrl(info) || null };
      },
      verify: () => transport.verify(),
    };
  } else if (host.toLowerCase() !== 'none' && savedAccount()) {
    useAccount(savedAccount());
  } else {
    impl = logImpl;
  }

  const manager = {
    from,
    get mode() { return impl.mode; },
    // Configured through environment variables, so the admin screen can't switch it.
    fixed: Boolean(fixedSmtp),
    info() {
      const base = { mode: impl.mode, from };
      if (impl.mode === 'smtp') return { ...base, host: impl.host, port: impl.port };
      if (impl.mode === 'ethereal') {
        return { ...base, host: impl.account.smtp.host, inbox: { loginUrl: ETHEREAL_LOGIN, user: impl.account.user, pass: impl.account.pass } };
      }
      return base;
    },
    send: (msg) => impl.send(msg),
    verify: () => (impl.verify ? impl.verify() : Promise.resolve(true)),

    // Create (or reuse) a free Ethereal inbox and start sending to it.
    async useTestInbox() {
      if (fixedSmtp) throw new Error('SMTP is set in the server settings (SMTP_HOST), so the test inbox is not used');
      const account = savedAccount() ?? await nodemailer.createTestAccount(etherealApi);
      const keep = { user: account.user, pass: account.pass, smtp: account.smtp, web: account.web };
      db?.prepare("INSERT INTO app_settings (key, value) VALUES ('ethereal_account', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(JSON.stringify(keep));
      useAccount(keep);
      return manager.info();
    },
    stopTestInbox() {
      if (fixedSmtp) return manager.info();
      db?.prepare("DELETE FROM app_settings WHERE key = 'ethereal_account'").run();
      impl = logImpl;
      return manager.info();
    },
  };

  // SMTP_HOST=ethereal: set the test inbox up at start-up.
  if (host.toLowerCase() === 'ethereal' && impl.mode !== 'ethereal') {
    manager.useTestInbox()
      .then((i) => console.log(`[email] Ethereal test inbox ready: log in at ${ETHEREAL_LOGIN} as ${i.inbox.user} / ${i.inbox.pass}`))
      .catch((err) => console.error(`[email] Could not create an Ethereal test inbox: ${err.message}`));
  }
  return manager;
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
      const info = await mailer.send({
        to: email.to_name ? `"${email.to_name.replace(/"/g, '')}" <${email.to_email}>` : email.to_email,
        subject: email.subject,
        html: email.html,
        text: email.text,
        attachments: await qrAttachments(db, email),
      });
      db.prepare(
        `UPDATE email_outbox SET status = 'sent', attempts = attempts + 1, sent_at = datetime('now'), last_error = NULL,
                preview_url = ? WHERE id = ?`
      ).run(info?.previewUrl ?? null, email.id);
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

// Emails that show a pickup QR code reference it as cid:pickup-qr; attach the image.
async function qrAttachments(db, email) {
  if (!email.order_id || !email.html.includes(`cid:${QR_CID}`)) return [];
  const row = db.prepare('SELECT pickup_code FROM orders WHERE id = ?').get(email.order_id);
  if (!row?.pickup_code) return [];
  return [{ filename: 'pickup-qr.png', content: await qr.png(row.pickup_code), cid: QR_CID, contentType: 'image/png' }];
}

// For the admin preview: swap the cid: reference for an inline image the browser can show.
async function previewHtml(db, email) {
  const [attachment] = await qrAttachments(db, email);
  if (!attachment) return email.html;
  return email.html.replaceAll(`cid:${QR_CID}`, `data:image/png;base64,${attachment.content.toString('base64')}`);
}

function retryEmail(db, id) {
  return db.prepare(
    "UPDATE email_outbox SET status = 'queued', attempts = 0, next_attempt_at = ? WHERE id = ? AND status = 'failed'"
  ).run(new Date().toISOString(), id).changes > 0;
}

function listEmails(db, { limit = 100 } = {}) {
  return db.prepare(
    `SELECT id, kind, to_email, to_name, subject, order_id, status, attempts, last_error, created_at, sent_at, preview_url
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
  createMailer, queueOrderEmail, queueTestEmail, processOutbox, retryEmail, listEmails, getEmail, previewHtml,
  runReminders, startScheduler, ACTIVE_STATUSES,
};
