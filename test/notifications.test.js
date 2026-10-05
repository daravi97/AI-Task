const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const store = require('../src/store');
const collection = require('../src/collection');
const notifications = require('../src/notifications');

const TODAY = '2026-10-05';
const NOW_9AM = new Date('2026-10-05T09:30:00Z');
const NOW_7AM = new Date('2026-10-05T07:00:00Z');
const REMIND = { timezone: 'UTC', reminderHour: 9 };

function setup() {
  const db = openDb(':memory:');
  db.exec('DELETE FROM collection_days; DELETE FROM email_outbox;');
  const user = (email) => db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  const product = (name) => db.prepare('SELECT * FROM products WHERE name = ?').get(name);
  const outbox = () => db.prepare('SELECT * FROM email_outbox ORDER BY id').all();
  const addDay = (date, location = 'Level 3 Reception') =>
    collection.createDay(db, { date, start_time: '10:00', end_time: '16:00', location }, { today: TODAY }).day;
  const order = (u, name = 'Ceramic Mug', today = TODAY) =>
    store.placeOrder(db, u.id, [{ productId: product(name).id, quantity: 1 }], { today });
  return { db, alice: user('alice@company.com'), bob: user('bob@company.com'), admin: user('admin@company.com'), outbox, addDay, order };
}

function fakeMailer({ failWith = null } = {}) {
  return {
    sent: [],
    async send(msg) {
      if (failWith) throw new Error(failWith);
      this.sent.push(msg);
    },
  };
}

test('checkout books the next collection day and queues a confirmation email', async () => {
  const { db, alice, outbox, addDay, order } = setup();
  addDay('2026-10-05'); // today: too soon for new orders
  const day = addDay('2026-10-09');
  addDay('2026-10-16');

  const o = order(alice);
  assert.equal(o.collection_day_id, day.id);
  assert.equal(o.collection_location, 'Level 3 Reception');

  const [email] = outbox();
  assert.equal(email.kind, 'order_confirmation');
  assert.equal(email.to_email, 'alice@company.com');
  assert.match(email.subject, /Order #\d+ confirmed – collect on Friday, 9 October 2026/);
  assert.match(email.html, /10:00–16:00/);
  assert.match(email.text, /Where: Level 3 Reception/);

  const mailer = fakeMailer();
  assert.deepEqual(await notifications.processOutbox(db, mailer), { attempted: 1, sent: 1 });
  assert.equal(mailer.sent[0].to, '"Alice Tan" <alice@company.com>');
  assert.equal(outbox()[0].status, 'sent');
  assert.deepEqual(await notifications.processOutbox(db, mailer), { attempted: 0, sent: 0 });
});

test('orders without a scheduled day are booked and emailed when an admin adds one', () => {
  const { db, alice, bob, outbox, addDay, order } = setup();
  const a = order(alice);
  const b = order(bob);
  assert.equal(a.collection_day_id, null);
  assert.match(outbox()[0].text, /to be confirmed/);

  const day = addDay('2026-10-12');
  assert.equal(store.getOrder(db, a.id).collection_day_id, day.id);
  assert.equal(store.getOrder(db, b.id).collection_day_id, day.id);
  const updates = outbox().filter((e) => e.kind === 'collection_updated');
  assert.equal(updates.length, 2);
  assert.match(updates[0].subject, /collection on Monday, 12 October 2026/);
});

test('reminder is sent once, the day before, from the reminder hour', () => {
  const { db, alice, bob, outbox, addDay, order } = setup();
  addDay('2026-10-06'); // tomorrow
  // Orders placed earlier (before the day became "tomorrow") still need a reminder.
  const a = order(alice, 'Ceramic Mug', '2026-10-01');
  const b = order(bob, 'Tote Bag', '2026-10-01');
  store.cancelOrder(db, b.id, { byUserId: bob.id });

  assert.deepEqual(notifications.runReminders(db, { now: NOW_7AM, ...REMIND }), { queued: 0 }, 'too early in the day');
  assert.deepEqual(notifications.runReminders(db, { now: NOW_9AM, ...REMIND }), { queued: 1 }, 'cancelled order skipped');
  assert.deepEqual(notifications.runReminders(db, { now: NOW_9AM, ...REMIND }), { queued: 0 }, 'not sent twice');

  const reminder = outbox().find((e) => e.kind === 'collection_reminder');
  assert.equal(reminder.order_id, a.id);
  assert.match(reminder.subject, /Reminder: collect your order #\d+ tomorrow/);
  assert.match(reminder.text, /come and pick it up at the designated location/i);
  assert.match(reminder.text, /Tuesday, 6 October 2026, 10:00–16:00/);
});

test('ordering for tomorrow does not send a separate reminder (the confirmation covers it)', () => {
  const { db, alice, outbox, addDay, order } = setup();
  addDay('2026-10-06');
  const o = order(alice);
  assert.ok(store.getOrder(db, o.id).reminder_sent_at);
  assert.deepEqual(notifications.runReminders(db, { now: NOW_9AM, ...REMIND }), { queued: 0 });
  assert.equal(outbox().length, 1);
});

test('rescheduling a day emails affected staff and re-arms the reminder', () => {
  const { db, alice, outbox, addDay, order } = setup();
  const day = addDay('2026-10-06');
  const o = order(alice); // reminder covered by confirmation
  const r = collection.updateDay(db, day.id, { ...day, date: '2026-10-08', location: 'Lobby' }, { today: TODAY });
  assert.equal(r.notifiedOrders, 1);
  assert.equal(store.getOrder(db, o.id).reminder_sent_at, null, 'reminder re-armed for the new date');
  const update = outbox().at(-1);
  assert.equal(update.kind, 'collection_updated');
  assert.match(update.text, /Thursday, 8 October 2026/);
  assert.match(update.text, /Where: Lobby/);

  // Saving without changes sends nothing.
  assert.equal(collection.updateDay(db, day.id, r.day, { today: TODAY }).notifiedOrders, 0);
});

test('admin can move a single order to another day', () => {
  const { db, alice, outbox, addDay, order } = setup();
  addDay('2026-10-09');
  const later = addDay('2026-10-20', 'Warehouse');
  const o = order(alice);
  collection.setOrderDay(db, o.id, later.id, { today: TODAY });
  assert.equal(store.getOrder(db, o.id).collection_location, 'Warehouse');
  assert.match(outbox().at(-1).text, /Warehouse/);
});

test('collection day validation and safe deletion', () => {
  const { db, alice, addDay, order } = setup();
  const bad = (data) => () => collection.createDay(db, { date: '2026-10-09', start_time: '10:00', end_time: '16:00', location: 'X', ...data }, { today: TODAY });
  assert.throws(bad({ date: '2026-10-01' }), /past/);
  assert.throws(bad({ date: '2026-02-30' }), /valid date/);
  assert.throws(bad({ end_time: '09:00' }), /after start/);
  assert.throws(bad({ start_time: '25:00' }), /HH:MM/);
  assert.throws(bad({ location: ' ' }), /Location/);

  const day = addDay('2026-10-09');
  const o = order(alice);
  assert.throws(() => collection.deleteDay(db, day.id), /move them/);
  store.cancelOrder(db, o.id, { byUserId: alice.id });
  collection.deleteDay(db, day.id);
  assert.equal(collection.getDay(db, day.id), null);
});

test('cancelling an order emails a refund confirmation', () => {
  const { db, alice, outbox, order } = setup();
  const o = order(alice);
  store.cancelOrder(db, o.id, { byUserId: alice.id });
  const email = outbox().at(-1);
  assert.equal(email.kind, 'order_cancelled');
  assert.match(email.subject, /cancelled – 25 tokens refunded/);
});

test('failed sends are retried with backoff, then marked failed and can be retried manually', async () => {
  const { db, alice, outbox, order } = setup();
  order(alice);
  const mailer = fakeMailer({ failWith: 'Connection refused' });
  let now = new Date();
  for (let i = 0; i < 5; i++) {
    await notifications.processOutbox(db, mailer, { now });
    now = new Date(now.getTime() + 60 * 60_000);
  }
  const [email] = outbox();
  assert.equal(email.status, 'failed');
  assert.equal(email.attempts, 5);
  assert.equal(email.last_error, 'Connection refused');

  assert.ok(notifications.retryEmail(db, email.id));
  await notifications.processOutbox(db, fakeMailer());
  assert.equal(outbox()[0].status, 'sent');
});

test('email HTML escapes user-controlled text', () => {
  const { db, alice, outbox, addDay } = setup();
  addDay('2026-10-09', '<img src=x onerror=alert(1)>');
  const p = store.saveProduct(db, { name: '<script>alert(1)</script>', price: 5, stock: 5 });
  store.placeOrder(db, alice.id, [{ productId: p.id, quantity: 1 }], { today: TODAY });
  const { html } = outbox().at(-1);
  assert.doesNotMatch(html, /<script>|<img src=x/);
  assert.match(html, /&lt;script&gt;/);
});

test('without SMTP settings the mailer only logs', async () => {
  const mailer = notifications.createMailer({});
  assert.equal(mailer.mode, 'log');
  const smtp = notifications.createMailer({ SMTP_HOST: 'smtp.example.com', SMTP_PORT: '587' });
  assert.equal(smtp.mode, 'smtp');
});
