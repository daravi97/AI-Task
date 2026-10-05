const path = require('node:path');
const express = require('express');
const auth = require('./auth');
const store = require('./store');

const COOKIE = 'sid';

function createApp({ db, assistant }) {
  const app = express();
  app.use(express.json({ limit: '100kb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // Attach the logged-in user (if any) to every request.
  app.use((req, _res, next) => {
    req.sessionToken = auth.parseCookies(req.headers.cookie)[COOKIE];
    req.user = auth.getSessionUser(db, req.sessionToken);
    next();
  });

  const requireUser = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Please log in' }));
  const requireAdmin = (req, res, next) =>
    req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Admins only' });
  const id = (req) => Number(req.params.id);

  const api = express.Router();

  // ----- Auth -----
  api.post('/login', (req, res) => {
    const { email, password } = req.body ?? {};
    const row = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email ?? ''));
    if (!row || !auth.verifyPassword(String(password ?? ''), row.password_hash)) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const token = auth.createSession(db, row.id);
    res.cookie(COOKIE, token, {
      httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: auth.SESSION_DAYS * 864e5,
    });
    res.json({ user: auth.getSessionUser(db, token) });
  });

  api.post('/logout', (req, res) => {
    if (req.sessionToken) auth.destroySession(db, req.sessionToken);
    res.clearCookie(COOKIE);
    res.json({ ok: true });
  });

  api.get('/me', requireUser, (req, res) => {
    res.json({ user: req.user, balance: store.getBalance(db, req.user.id), assistantMode: assistant.mode });
  });

  // ----- Staff -----
  api.get('/products', requireUser, (_req, res) => res.json(store.listProducts(db)));
  api.get('/wallet', requireUser, (req, res) =>
    res.json({ balance: store.getBalance(db, req.user.id), ledger: store.getLedger(db, req.user.id) }));
  api.get('/orders', requireUser, (req, res) => res.json(store.listOrders(db, { userId: req.user.id })));
  api.post('/orders', requireUser, (req, res) => {
    const order = store.placeOrder(db, req.user.id, req.body?.items, req.body?.note);
    res.status(201).json({ order, balance: store.getBalance(db, req.user.id) });
  });
  api.post('/orders/:id/cancel', requireUser, (req, res) => {
    const order = store.cancelOrder(db, id(req), { byUserId: req.user.id });
    res.json({ order, balance: store.getBalance(db, req.user.id) });
  });
  api.get('/faqs', requireUser, (_req, res) => res.json(store.listFaqs(db)));
  api.post('/chat', requireUser, async (req, res) => {
    const reply = await assistant.reply(db, req.user, req.body?.message, req.body?.history);
    res.json({ reply });
  });

  // ----- Admin -----
  const admin = express.Router();
  admin.use(requireUser, requireAdmin);
  admin.get('/users', (_req, res) => res.json(store.listStaff(db)));
  admin.post('/award', (req, res) => {
    const { userIds, amount, reason } = req.body ?? {};
    res.json(store.awardTokens(db, { userIds: (userIds ?? []).map(Number), amount, reason, adminId: req.user.id }));
  });
  admin.get('/products', (_req, res) => res.json(store.listProducts(db, { includeInactive: true })));
  admin.post('/products', (req, res) => res.status(201).json(store.saveProduct(db, req.body ?? {})));
  admin.put('/products/:id', (req, res) => res.json(store.saveProduct(db, req.body ?? {}, id(req))));
  admin.get('/orders', (req, res) => res.json(store.listOrders(db, { status: req.query.status || null })));
  admin.put('/orders/:id/status', (req, res) => res.json(store.updateOrderStatus(db, id(req), req.body?.status, req.user.id)));
  admin.post('/faqs', (req, res) => res.status(201).json(store.saveFaq(db, req.body ?? {})));
  admin.put('/faqs/:id', (req, res) => res.json(store.saveFaq(db, req.body ?? {}, id(req))));
  admin.delete('/faqs/:id', (req, res) => { store.deleteFaq(db, id(req)); res.json({ ok: true }); });
  api.use('/admin', admin);

  app.use('/api', api);
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof store.StoreError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  });

  return app;
}

module.exports = { createApp };
