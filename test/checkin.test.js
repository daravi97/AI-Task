const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { openDb } = require('../src/db');
const store = require('../src/store');
const qr = require('../src/qr');
const notifications = require('../src/notifications');
const { createApp } = require('../src/app');
const { createAssistant } = require('../src/bot');

function setup() {
  const db = openDb(':memory:');
  const user = (email) => db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  const product = (name) => db.prepare('SELECT * FROM products WHERE name = ?').get(name);
  const alice = user('alice@company.com');
  const order = store.placeOrder(db, alice.id, [{ productId: product('Ceramic Mug').id, quantity: 2 }]);
  return { db, alice, bob: user('bob@company.com'), admin: user('admin@company.com'), order, product };
}

test('pickup codes are 8 unambiguous characters and parse from codes or URLs', () => {
  const codes = new Set(Array.from({ length: 500 }, qr.newPickupCode));
  assert.equal(codes.size, 500);
  for (const c of codes) assert.match(c, /^[A-HJKMNP-Z2-9]{8}$/);
  assert.equal(qr.formatCode('K7PX9M2Q'), 'K7PX-9M2Q');
  assert.equal(qr.parseCode('k7px-9m2q'), 'K7PX9M2Q');
  assert.equal(qr.parseCode(' K7PX9M2Q\n'), 'K7PX9M2Q');
  assert.equal(qr.parseCode('https://merch.acme.com/#checkin/K7PX9M2Q'), 'K7PX9M2Q');
  assert.equal(qr.parseCode('hello'), null);
  assert.match(qr.checkinUrl('K7PX9M2Q'), /\/#checkin\/K7PX9M2Q$/);
});

test('every order gets a unique pickup code', () => {
  const { db, alice, order, product } = setup();
  assert.match(order.pickup_code, /^[A-Z2-9]{8}$/);
  const second = store.placeOrder(db, alice.id, [{ productId: product('Tote Bag').id, quantity: 1 }]);
  assert.notEqual(second.pickup_code, order.pickup_code);
});

test('scanning finds the order and collecting works once', () => {
  const { db, order } = setup();
  const url = qr.checkinUrl(order.pickup_code);
  assert.equal(store.findByPickupCode(db, url).id, order.id);
  assert.equal(store.findByPickupCode(db, qr.formatCode(order.pickup_code).toLowerCase()).id, order.id);
  assert.throws(() => store.findByPickupCode(db, 'ABCDEFGH'), /No order has this pickup code/);
  assert.throws(() => store.findByPickupCode(db, 'nope'), /not a valid pickup code/);

  const collected = store.collectByPickupCode(db, url);
  assert.equal(collected.status, 'collected');
  assert.ok(collected.collected_at);
  assert.throws(() => store.collectByPickupCode(db, url), /already collected/);
});

test('a cancelled order cannot be collected', () => {
  const { db, alice, order } = setup();
  store.cancelOrder(db, order.id, { byUserId: alice.id });
  assert.throws(() => store.collectByPickupCode(db, order.pickup_code), /cancelled — do not hand anything over/);
});

test('collected_at is set when collected and cleared if the status moves back', () => {
  const { db, order, admin } = setup();
  store.bulkUpdateStatus(db, [order.id], 'collected', admin.id);
  assert.ok(store.getOrder(db, order.id).collected_at);
  store.updateOrderStatus(db, order.id, 'ready', admin.id);
  assert.equal(store.getOrder(db, order.id).collected_at, null);
});

test('confirmation email shows the QR code, attached as an inline image when sent', async () => {
  const { db, order } = setup();
  const email = db.prepare("SELECT * FROM email_outbox WHERE kind = 'order_confirmation'").get();
  assert.match(email.html, /src="cid:pickup-qr"/);
  assert.ok(email.html.includes(qr.formatCode(order.pickup_code)));
  assert.match(email.text, new RegExp(`Pickup code: ${qr.formatCode(order.pickup_code)}`));

  const sent = [];
  await notifications.processOutbox(db, { async send(msg) { sent.push(msg); } });
  const [attachment] = sent[0].attachments;
  assert.equal(attachment.cid, 'pickup-qr');
  assert.equal(attachment.contentType, 'image/png');
  assert.deepEqual([...attachment.content.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'PNG data');

  const preview = await notifications.previewHtml(db, email);
  assert.match(preview, /src="data:image\/png;base64,/);
  assert.doesNotMatch(preview, /cid:pickup-qr/);
});

test('existing orders get pickup codes when an older database is upgraded', () => {
  const path = require('node:path').join(require('node:os').tmpdir(), `merch-migrate-${process.pid}-${Date.now()}.db`);
  const db1 = openDb(path);
  const alice = db1.prepare("SELECT id FROM users WHERE email = 'alice@company.com'").get();
  store.placeOrder(db1, alice.id, [{ productId: 1, quantity: 1 }]);
  db1.exec('DROP INDEX idx_orders_pickup_code; ALTER TABLE orders DROP COLUMN pickup_code; ALTER TABLE orders DROP COLUMN collected_at;');
  db1.close();
  assert.ok(!new DatabaseSync(path).prepare('PRAGMA table_info(orders)').all().some((c) => c.name === 'pickup_code'));
  const db2 = openDb(path);
  const row = db2.prepare('SELECT pickup_code FROM orders').get();
  assert.match(row.pickup_code, /^[A-Z2-9]{8}$/);
  db2.close();
  require('node:fs').rmSync(path);
});

test('check-in API is admin-only; staff can only see their own QR code', async (t) => {
  const { db, order } = setup();
  const server = createApp({ db, assistant: createAssistant({ apiKey: '' }) }).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (email) => {
    const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'password123' }) });
    return r.headers.get('set-cookie').split(';')[0];
  };
  const alice = await login('alice@company.com');
  const bob = await login('bob@company.com');
  const admin = await login('admin@company.com');
  const get = (path, cookie, opts = {}) => fetch(base + path, { ...opts, headers: { Cookie: cookie } });

  const own = await get(`/api/orders/${order.id}/qr.svg`, alice);
  assert.equal(own.status, 200);
  assert.match(own.headers.get('content-type'), /image\/svg\+xml/);
  assert.match(await own.text(), /<svg/);
  assert.equal((await get(`/api/orders/${order.id}/qr.svg`, bob)).status, 404, "can't see someone else's code");

  assert.equal((await get(`/api/admin/checkin/${order.pickup_code}`, alice)).status, 403);
  const found = await get(`/api/admin/checkin/${order.pickup_code}`, admin);
  assert.equal((await found.json()).user_name, 'Alice Tan');
  const done = await get(`/api/admin/checkin/${encodeURIComponent(qr.checkinUrl(order.pickup_code))}/collect`, admin, { method: 'POST' });
  assert.equal((await done.json()).status, 'collected');
  const again = await get(`/api/admin/checkin/${order.pickup_code}/collect`, admin, { method: 'POST' });
  assert.equal(again.status, 409);

  const js = await fetch(`${base}/vendor/jsQR.js`);
  assert.equal(js.status, 200);
});

test('QR codes and email links follow the public address (tunnel) instead of localhost', async (t) => {
  const config = require('../src/config');
  const saved = { ...config.settings };
  t.after(() => Object.assign(config.settings, saved));
  Object.assign(config.settings, { appUrl: 'http://localhost:3000', appUrlFixed: false });
  assert.equal(config.isLocalUrl('http://localhost:3000'), true);
  assert.equal(config.isLocalUrl('http://127.0.0.1:3000/'), true);
  assert.equal(config.isLocalUrl('https://laundry-rider-possibly-jaguar.trycloudflare.com'), false);

  const { db } = setup();
  const server = createApp({ db, assistant: createAssistant({ apiKey: '' }) }).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const tunnel = { Host: 'laundry-rider-possibly-jaguar.trycloudflare.com', 'X-Forwarded-Proto': 'https' };
  // fetch() can't set Host, so send tunnel requests the way cloudflared does, with node:http.
  const viaTunnel = (path, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = require('node:http').request(`${base}${path}`, { method, headers: { ...tunnel, ...headers } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ headers: res.headers, json: () => JSON.parse(data) }));
    });
    req.on('error', reject);
    req.end(body);
  });

  // Opening the site locally changes nothing.
  await fetch(`${base}/api/version`);
  assert.equal(config.settings.appUrl, 'http://localhost:3000');

  // Opening it through the tunnel switches QR codes and email links to the tunnel address.
  const login = await viaTunnel('/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'bob@company.com', password: 'password123' }),
  });
  assert.equal(config.settings.appUrl, 'https://laundry-rider-possibly-jaguar.trycloudflare.com');
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  const placed = (await viaTunnel('/api/orders', {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [{ productId: 1, quantity: 1 }] }),
  })).json();
  const email = db.prepare('SELECT * FROM email_outbox WHERE order_id = ? ORDER BY id DESC').get(placed.order.id);
  assert.match(email.text, /https:\/\/laundry-rider-possibly-jaguar\.trycloudflare\.com\/#orders/);
  assert.equal(qr.checkinUrl('K7PX9M2Q'), 'https://laundry-rider-possibly-jaguar.trycloudflare.com/#checkin/K7PX9M2Q');

  // A real APP_URL is never overridden.
  Object.assign(config.settings, { appUrl: 'https://merch.acme.com', appUrlFixed: true });
  await viaTunnel('/api/version');
  assert.equal(config.settings.appUrl, 'https://merch.acme.com');
});
