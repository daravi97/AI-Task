const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const { createAssistant } = require('../src/bot');

async function startServer(assistant = createAssistant({ apiKey: '' })) {
  const db = openDb(':memory:');
  const server = createApp({ db, assistant }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  return { db, server, base };
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

test('end-to-end staff and admin flow', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());

  const alice = client(base);
  assert.equal((await alice('/products')).status, 401);
  assert.equal((await alice('/login', { method: 'POST', body: { email: 'alice@company.com', password: 'nope' } })).status, 401);
  const login = await alice('/login', { method: 'POST', body: { email: 'ALICE@company.com', password: 'password123' } });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.role, 'staff');

  const me = await alice('/me');
  assert.equal(me.body.balance, 450);
  assert.equal(me.body.assistantMode, 'faq');
  assert.equal((await alice('/admin/users')).status, 403);

  const products = (await alice('/products')).body;
  const tote = products.find((p) => p.name === 'Tote Bag');
  const placed = await alice('/orders', { method: 'POST', body: { items: [{ productId: tote.id, quantity: 2 }] } });
  assert.equal(placed.status, 201);
  assert.equal(placed.body.balance, 410);

  const tooMuch = await alice('/orders', { method: 'POST', body: { items: [{ productId: tote.id, quantity: 50 }] } });
  assert.equal(tooMuch.status, 402);
  assert.match(tooMuch.body.error, /Not enough tokens/);

  const chat = await alice('/chat', { method: 'POST', body: { message: 'how many tokens do I have left?' } });
  assert.match(chat.body.reply, /410 tokens/);

  // Admin moves the order along and awards tokens.
  const admin = client(base);
  await admin('/login', { method: 'POST', body: { email: 'admin@company.com', password: 'password123' } });
  const orderId = placed.body.order.id;
  assert.equal((await admin(`/admin/orders/${orderId}/status`, { method: 'PUT', body: { status: 'ready' } })).body.status, 'ready');
  assert.equal((await alice(`/orders/${orderId}/cancel`, { method: 'POST' })).status, 409);

  const users = (await admin('/admin/users')).body;
  const aliceId = users.find((u) => u.email === 'alice@company.com').id;
  const award = await admin('/admin/award', { method: 'POST', body: { userIds: [aliceId], amount: 100, reason: 'Great demo' } });
  assert.equal(award.status, 200);
  assert.equal((await alice('/wallet')).body.balance, 510);

  const newFaq = await admin('/admin/faqs', { method: 'POST', body: { question: 'Is there a store holiday?', answer: 'Closed on public holidays.', keywords: 'holiday closed' } });
  assert.equal(newFaq.status, 201);
  assert.match((await alice('/chat', { method: 'POST', body: { message: 'is it closed on a holiday?' } })).body.reply, /public holidays/);

  await alice('/logout', { method: 'POST' });
  assert.equal((await alice('/me')).status, 401);
});

test('chat uses Claude with tools when a client is configured', async (t) => {
  const calls = [];
  const fakeClient = {
    beta: {
      messages: {
        async create(params) {
          calls.push({ ...params, messages: [...params.messages] });
          if (calls.length === 1) {
            return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_1', name: 'get_my_wallet', input: {} }] };
          }
          const result = JSON.parse(params.messages.at(-1).content[0].content);
          return { stop_reason: 'end_turn', content: [{ type: 'text', text: `You have ${result.balance} tokens.` }] };
        },
      },
    },
  };
  const { server, base } = await startServer(createAssistant({ client: fakeClient }));
  t.after(() => server.close());

  const alice = client(base);
  await alice('/login', { method: 'POST', body: { email: 'alice@company.com', password: 'password123' } });
  assert.equal((await alice('/me')).body.assistantMode, 'claude');
  const res = await alice('/chat', { method: 'POST', body: { message: 'balance?', history: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }] } });
  assert.equal(res.body.reply, 'You have 450 tokens.');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].model, 'claude-opus-5-5');
  assert.equal(calls[0].messages.length, 3);
  assert.match(calls[0].system[0].text, /Do my tokens expire\?/);
});

test('bulk product upload and stock API is admin-only and works end to end', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const staff = client(base);
  await staff('/login', { method: 'POST', body: { email: 'bob@company.com', password: 'password123' } });
  assert.equal((await staff('/admin/products-import', { method: 'POST', body: { csv: 'name,price\nX,1' } })).status, 403);
  assert.equal((await staff('/admin/products-stock', { method: 'PUT', body: { updates: [] } })).status, 403);

  const admin = client(base);
  await admin('/login', { method: 'POST', body: { email: 'admin@company.com', password: 'password123' } });
  const csv = 'name,price,stock\nLanyard,15,100\nKeychain,10,50';
  const preview = await admin('/admin/products-import', { method: 'POST', body: { csv } });
  assert.equal(preview.body.applied, false, 'preview is the default');
  assert.equal(preview.body.summary.create, 2);
  const done = await admin('/admin/products-import', { method: 'POST', body: { csv, dryRun: false } });
  assert.equal(done.body.applied, true);

  const products = (await admin('/admin/products')).body;
  const lanyard = products.find((p) => p.name === 'Lanyard');
  assert.equal(lanyard.stock, 100);
  const stock = await admin('/admin/products-stock', { method: 'PUT', body: { updates: [{ id: lanyard.id, stock: 7 }] } });
  assert.deepEqual(stock.body, { updated: 1 });
  assert.equal((await staff('/products')).body.find((p) => p.name === 'Lanyard').stock, 7);

  const bad = await admin('/admin/products-import', { method: 'POST', body: { csv: 'title\nX' } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /"name" column/);
});
