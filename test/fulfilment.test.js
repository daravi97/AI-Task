const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const store = require('../src/store');
const collection = require('../src/collection');

const TODAY = '2026-10-05';

function setup() {
  const db = openDb(':memory:');
  db.exec('DELETE FROM collection_days; DELETE FROM email_outbox;');
  const user = (email) => db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  const product = (name) => db.prepare('SELECT * FROM products WHERE name = ?').get(name);
  const day1 = collection.createDay(db, { date: '2026-10-09', start_time: '10:00', end_time: '16:00', location: 'Reception' }, { today: TODAY }).day;
  const day2 = collection.createDay(db, { date: '2026-10-16', start_time: '10:00', end_time: '16:00', location: 'Lobby' }, { today: TODAY }).day;
  const alice = user('alice@company.com');
  const bob = user('bob@company.com');
  const order = (u, lines) => store.placeOrder(db, u.id, lines.map(([name, quantity]) => ({ productId: product(name).id, quantity })), { today: TODAY });
  const a1 = order(alice, [['Ceramic Mug', 2], ['Tote Bag', 1]]);
  const a2 = order(alice, [['Ceramic Mug', 1]]);
  const b1 = order(bob, [['Tote Bag', 3], ['Baseball Cap', 1]]);
  const b2 = order(bob, [['Logo T-Shirt', 1]]);
  store.cancelOrder(db, b2.id, { byUserId: bob.id });
  return { db, day1, day2, alice, bob, a1, a2, b1, b2, admin: user('admin@company.com') };
}

test('bulk status change updates many orders and skips the ones that cannot change', () => {
  const { db, a1, a2, b1, b2, admin } = setup();
  const r = store.bulkUpdateStatus(db, [a1.id, a2.id, b1.id, b2.id, 9999], 'processing', admin.id);
  assert.deepEqual(r.updated.sort(), [a1.id, a2.id, b1.id].sort());
  assert.deepEqual(r.skipped, [{ id: b2.id, reason: 'cancelled' }, { id: 9999, reason: 'not found' }]);
  assert.equal(store.getOrder(db, a1.id).status, 'processing');

  const again = store.bulkUpdateStatus(db, [a1.id, a2.id], 'ready', admin.id);
  assert.equal(again.updated.length, 2);
  assert.deepEqual(store.bulkUpdateStatus(db, [a1.id], 'ready', admin.id).skipped, [{ id: a1.id, reason: 'already ready' }]);

  assert.throws(() => store.bulkUpdateStatus(db, [a1.id], 'cancelled', admin.id), /Invalid status/);
  assert.throws(() => store.bulkUpdateStatus(db, [], 'ready', admin.id), /Select at least one/);
});

test('marking orders processing stops staff cancelling them (the cut-off)', () => {
  const { db, a1, alice, admin } = setup();
  store.bulkUpdateStatus(db, [a1.id], 'processing', admin.id);
  assert.throws(() => store.cancelOrder(db, a1.id, { byUserId: alice.id }), /Only pending orders/);
});

test('orders can be filtered by collection day and "active"', () => {
  const { db, day1, a1, a2, b1, b2 } = setup();
  const ids = (list) => list.map((o) => o.id).sort();
  assert.deepEqual(ids(store.listOrders(db, { collectionDayId: day1.id })), [a1.id, a2.id, b1.id, b2.id].sort());
  assert.deepEqual(ids(store.listOrders(db, { status: 'active', collectionDayId: day1.id })), [a1.id, a2.id, b1.id].sort());
  assert.deepEqual(store.listOrders(db, { collectionDayId: 'none' }), []);
  const one = store.listOrders(db, { status: 'active' }).find((o) => o.id === a1.id);
  assert.equal(one.items.length, 2, 'items are loaded in the batched query');
  assert.equal(one.user_name, 'Alice Tan');
});

test('bulk move sends each staff member an update and skips closed orders', () => {
  const { db, day2, a1, b1, b2 } = setup();
  db.exec('DELETE FROM email_outbox');
  const r = collection.bulkSetOrderDay(db, [a1.id, b1.id, b2.id], day2.id, { today: TODAY });
  assert.deepEqual(r.updated.sort(), [a1.id, b1.id].sort());
  assert.equal(r.skipped[0].id, b2.id);
  assert.equal(store.getOrder(db, a1.id).collection_location, 'Lobby');
  const emails = db.prepare("SELECT * FROM email_outbox WHERE kind = 'collection_updated'").all();
  assert.equal(emails.length, 2);
  assert.throws(() => collection.bulkSetOrderDay(db, [a1.id], 9999, { today: TODAY }), /not found/);
});

test('pick list totals items per product and lists each person to pack for', () => {
  const { db, day1, a1, a2, b1 } = setup();
  const pl = store.pickList(db, day1.id);
  assert.equal(pl.day.location, 'Reception');
  const totals = Object.fromEntries(pl.products.map((p) => [p.product_name, p.quantity]));
  assert.deepEqual(totals, { 'Baseball Cap': 1, 'Ceramic Mug': 3, 'Tote Bag': 4 }, 'cancelled order excluded');
  assert.deepEqual(pl.orders.map((o) => o.id), [a1.id, a2.id, b1.id], 'sorted by name then order');
  assert.equal(pl.orders[2].user_name, 'Bob Lim');
});
