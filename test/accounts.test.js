const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const { createAssistant } = require('../src/bot');

async function startServer() {
  const db = openDb(':memory:');
  const server = createApp({ db, assistant: createAssistant({ apiKey: '' }) }).listen(0);
  await new Promise((r) => server.once('listening', r));
  return { db, server, base: `http://127.0.0.1:${server.address().port}/api` };
}

function client(base) {
  let cookie = '';
  return async (path, { method = 'GET', body } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return { status: res.status, body: await res.json() };
  };
}

const lastEmailTo = (db, to) => db.prepare('SELECT * FROM email_outbox WHERE to_email = ? ORDER BY id DESC').get(to);
const tokenIn = (email) => email.text.match(/#set-password\/([\w-]+)/)[1];

test('admin registers a person who then sets their own password', async (t) => {
  const { db, server, base } = await startServer();
  t.after(() => server.close());
  const admin = client(base);
  await admin('/login', { method: 'POST', body: { email: 'admin@company.com', password: 'password123' } });

  const add = await admin('/admin/users', {
    method: 'POST', body: { name: 'Nur Aisyah', email: ' Nur.Aisyah@Gmail.com ', department: 'Audit', startingTokens: '150' },
  });
  assert.equal(add.status, 201);
  assert.equal(add.body.user.email, 'nur.aisyah@gmail.com');
  assert.equal(add.body.user.role, 'staff');
  assert.equal((await admin('/admin/users', { method: 'POST', body: { name: 'Again', email: 'NUR.AISYAH@gmail.com' } })).status, 409);
  assert.equal((await admin('/admin/users', { method: 'POST', body: { name: 'Bad', email: 'not-an-email' } })).status, 400);

  const welcome = lastEmailTo(db, 'nur.aisyah@gmail.com');
  assert.equal(welcome.kind, 'welcome');
  assert.match(welcome.text, /150 tokens/);
  assert.match(welcome.html, /Set my password/);
  const token = tokenIn(welcome);
  // Only a hash of the link is stored.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM password_tokens WHERE token_hash = ?').get(token).n, 0);

  const nur = client(base);
  assert.equal((await nur('/login', { method: 'POST', body: { email: 'nur.aisyah@gmail.com', password: 'whatever1' } })).status, 401);
  const link = await nur(`/password-link/${token}`);
  assert.deepEqual(link.body, { name: 'Nur Aisyah', email: 'nur.aisyah@gmail.com', purpose: 'invite' });
  assert.equal((await nur('/set-password', { method: 'POST', body: { token, password: 'short' } })).status, 400);
  const set = await nur('/set-password', { method: 'POST', body: { token, password: 'merch-store-2026' } });
  assert.equal(set.status, 200);
  assert.equal(set.body.user.email, 'nur.aisyah@gmail.com');
  const me = await nur('/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.balance, 150);

  // The link works once.
  assert.equal((await nur('/set-password', { method: 'POST', body: { token, password: 'another-pass' } })).status, 410);
  const again = client(base);
  assert.equal((await again('/login', { method: 'POST', body: { email: 'Nur.Aisyah@gmail.com', password: 'merch-store-2026' } })).status, 200);

  // Staff can't register people.
  assert.equal((await nur('/admin/users', { method: 'POST', body: { name: 'X', email: 'x@gmail.com' } })).status, 403);
});

test('forgot password emails a one-hour link and signs out other sessions', async (t) => {
  const { db, server, base } = await startServer();
  t.after(() => server.close());
  const alice = client(base);
  await alice('/login', { method: 'POST', body: { email: 'alice@company.com', password: 'password123' } });

  const before = db.prepare('SELECT COUNT(*) AS n FROM email_outbox').get().n;
  const unknown = await client(base)('/forgot-password', { method: 'POST', body: { email: 'nobody@gmail.com' } });
  assert.equal(unknown.status, 200); // same answer, so the form can't reveal who is registered
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM email_outbox').get().n, before);

  const anon = client(base);
  assert.equal((await anon('/forgot-password', { method: 'POST', body: { email: 'ALICE@company.com' } })).status, 200);
  const reset = lastEmailTo(db, 'alice@company.com');
  assert.equal(reset.kind, 'password_reset');
  // A second request straight away doesn't send another email.
  await anon('/forgot-password', { method: 'POST', body: { email: 'alice@company.com' } });
  assert.equal(lastEmailTo(db, 'alice@company.com').id, reset.id);

  const token = tokenIn(reset);
  assert.equal((await anon(`/password-link/${token}`)).body.purpose, 'reset');
  assert.equal((await anon('/set-password', { method: 'POST', body: { token, password: 'brand-new-pass' } })).status, 200);
  assert.equal((await alice('/me')).status, 401, 'old session signed out');
  assert.equal((await client(base)('/login', { method: 'POST', body: { email: 'alice@company.com', password: 'password123' } })).status, 401);

  // Expired links are refused.
  const admin = client(base);
  await admin('/login', { method: 'POST', body: { email: 'admin@company.com', password: 'password123' } });
  const bob = db.prepare("SELECT id FROM users WHERE email = 'bob@company.com'").get();
  assert.equal((await admin(`/admin/users/${bob.id}/invite`, { method: 'POST' })).status, 200);
  const bobToken = tokenIn(lastEmailTo(db, 'bob@company.com'));
  db.prepare("UPDATE password_tokens SET expires_at = '2000-01-01T00:00:00.000Z'").run();
  assert.equal((await anon(`/password-link/${bobToken}`)).status, 410);
});
