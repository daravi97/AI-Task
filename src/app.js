const path = require('node:path');
const express = require('express');
const auth = require('./auth');
const store = require('./store');
const collection = require('./collection');
const notifications = require('./notifications');
const config = require('./config');
const bulk = require('./bulk');
const qr = require('./qr');

const COOKIE = 'sid';
const { version: VERSION } = require('../package.json');

// `email` is { mailer, kick() }: kick() asks the outbox worker to send queued emails now.
function createApp({ db, assistant, email = { mailer: null, kick() {} } }) {
  const mailInfo = () => email.mailer?.info() ?? { mode: 'log' };
  const app = express();
  // Behind a tunnel or host (Cloudflare, Render…) the original https address arrives in X-Forwarded-* headers.
  app.set('trust proxy', true);
  app.use(express.json({ limit: '2mb' })); // large enough for a bulk product CSV
  app.use(express.static(path.join(__dirname, '..', 'public')));
  // QR decoder for the check-in camera scanner (served locally, no CDN needed).
  app.get('/vendor/jsQR.js', (_req, res) => res.sendFile(require.resolve('jsqr/dist/jsQR.js')));

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

  // Public: lets the UI (and a second `npm start`) tell which version is running.
  api.get('/version', (_req, res) => res.json({
    app: 'token-merch-store',
    version: VERSION,
    // Only reveal the demo password on the login page when it's the well-known default.
    demoPassword: process.env.SEED_PASSWORD ? null : 'password123',
  }));

  api.get('/me', requireUser, (req, res) => {
    res.json({
      user: req.user,
      balance: store.getBalance(db, req.user.id),
      assistantMode: assistant.mode,
      // The day a new order would be collected on, for the shop's header.
      nextCollection: collection.nextDay(db, config.today()),
    });
  });

  // ----- Staff -----
  api.get('/products', requireUser, (_req, res) => res.json(store.listProducts(db)));
  api.get('/wallet', requireUser, (req, res) =>
    res.json({ balance: store.getBalance(db, req.user.id), ledger: store.getLedger(db, req.user.id) }));
  api.get('/orders', requireUser, (req, res) => res.json(store.listOrders(db, { userId: req.user.id })));
  api.post('/orders', requireUser, (req, res) => {
    const order = store.placeOrder(db, req.user.id, req.body?.items, { note: req.body?.note });
    email.kick();
    res.status(201).json({ order, balance: store.getBalance(db, req.user.id) });
  });
  api.post('/orders/:id/cancel', requireUser, (req, res) => {
    const order = store.cancelOrder(db, id(req), { byUserId: req.user.id });
    email.kick();
    res.json({ order, balance: store.getBalance(db, req.user.id) });
  });
  // The staff member's own pickup QR code (shown under My Orders).
  api.get('/orders/:id/qr.svg', requireUser, async (req, res) => {
    const order = store.getOrder(db, id(req));
    if (!order || (order.user_id !== req.user.id && req.user.role !== 'admin') || !order.pickup_code) {
      return res.status(404).json({ error: 'Order not found' });
    }
    // Without a configured APP_URL, point the QR at the address this page was opened from
    // (e.g. a phone on the same Wi-Fi or through a tunnel), so scanning it works.
    const base = config.settings.appUrlFixed ? undefined : `${req.protocol}://${req.get('host')}`;
    res.type('image/svg+xml').set('Cache-Control', 'private, max-age=3600').send(await qr.svg(order.pickup_code, base));
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
  // Bulk: CSV template, CSV import (dryRun = preview only), and set many stock levels at once.
  admin.get('/products-template.csv', (_req, res) => {
    res.attachment('products-template.csv').type('text/csv; charset=utf-8').send('\uFEFF' + bulk.TEMPLATE_CSV);
  });
  admin.post('/products-import', (req, res) => {
    res.json(bulk.importProducts(db, req.body?.csv, { dryRun: req.body?.dryRun !== false }));
  });
  admin.put('/products-stock', (req, res) => res.json(bulk.setStockLevels(db, req.body?.updates)));
  admin.get('/orders', (req, res) => res.json(store.listOrders(db, {
    status: req.query.status || null,
    collectionDayId: req.query.day || null,
  })));
  // Bulk: { orderIds, action: 'status', status } or { orderIds, action: 'move', collectionDayId (null = unschedule) }
  admin.post('/orders/bulk', (req, res) => {
    const { orderIds, action, status, collectionDayId } = req.body ?? {};
    let result;
    if (action === 'status') result = store.bulkUpdateStatus(db, orderIds, status, req.user.id);
    else if (action === 'move') {
      result = collection.bulkSetOrderDay(db, orderIds, collectionDayId == null || collectionDayId === '' ? null : Number(collectionDayId));
      email.kick();
    } else return res.status(400).json({ error: 'Unknown bulk action' });
    res.json(result);
  });
  admin.get('/pick-list', (req, res) => {
    if (!req.query.day) return res.status(400).json({ error: 'Choose a collection day' });
    res.json(store.pickList(db, req.query.day));
  });
  admin.put('/orders/:id/status', (req, res) => {
    res.json(store.updateOrderStatus(db, id(req), req.body?.status, req.user.id));
    email.kick();
  });
  admin.put('/orders/:id/collection-day', (req, res) => {
    const dayId = req.body?.collectionDayId == null || req.body.collectionDayId === '' ? null : Number(req.body.collectionDayId);
    collection.setOrderDay(db, id(req), dayId);
    email.kick();
    res.json(store.getOrder(db, id(req)));
  });

  // Collection days
  admin.get('/collection-days', (req, res) => {
    const from = req.query.all ? null : config.addDays(config.today(), -7);
    res.json({ today: config.today(), timezone: config.settings.timezone, days: collection.listDays(db, { from }) });
  });
  admin.post('/collection-days', (req, res) => {
    const result = collection.createDay(db, req.body ?? {});
    email.kick();
    res.status(201).json(result);
  });
  admin.put('/collection-days/:id', (req, res) => {
    const result = collection.updateDay(db, id(req), req.body ?? {});
    email.kick();
    res.json(result);
  });
  admin.delete('/collection-days/:id', (req, res) => { collection.deleteDay(db, id(req)); res.json({ ok: true }); });

  // Email log
  admin.get('/emails', (_req, res) => res.json({
    ...mailInfo(),
    canUseTestInbox: Boolean(email.mailer && !email.mailer.fixed),
    // Render's free plan blocks the usual SMTP ports, which Ethereal needs.
    hostBlocksSmtp: Boolean(process.env.RENDER),
    reminderHour: config.settings.reminderHour, timezone: config.settings.timezone,
    emails: notifications.listEmails(db),
  }));
  // Turn the free Ethereal test inbox on or off (only when SMTP isn't set in the server settings).
  admin.post('/email/test-inbox', async (_req, res) => {
    if (!email.mailer) return res.status(400).json({ error: 'Email is not available' });
    try {
      const info = await email.mailer.useTestInbox();
      res.json(info);
    } catch (err) {
      res.status(502).json({ error: `Could not create a test inbox: ${err.message}` });
    }
  });
  admin.delete('/email/test-inbox', (_req, res) => res.json(email.mailer ? email.mailer.stopTestInbox() : { mode: 'log' }));
  admin.get('/emails/:id', async (req, res) => {
    const e = notifications.getEmail(db, id(req));
    if (!e) return res.status(404).json({ error: 'Email not found' });
    res.json({ ...e, html: await notifications.previewHtml(db, e) });
  });

  // Check-in at the collection desk: look up by scanned QR / typed pickup code, then collect.
  admin.get('/checkin/:code', (req, res) => res.json(store.findByPickupCode(db, req.params.code)));
  admin.post('/checkin/:code/collect', (req, res) => res.json(store.collectByPickupCode(db, req.params.code)));
  admin.post('/emails/:id/retry', (req, res) => {
    if (!notifications.retryEmail(db, id(req))) return res.status(409).json({ error: 'Only failed emails can be retried' });
    email.kick();
    res.json({ ok: true });
  });
  admin.post('/emails/test', (req, res) => {
    notifications.queueTestEmail(db, req.user);
    email.kick();
    res.json({ ok: true, to: req.user.email });
  });
  admin.post('/faqs', (req, res) => res.status(201).json(store.saveFaq(db, req.body ?? {})));
  admin.put('/faqs/:id', (req, res) => res.json(store.saveFaq(db, req.body ?? {}, id(req))));
  admin.delete('/faqs/:id', (req, res) => { store.deleteFaq(db, id(req)); res.json({ ok: true }); });
  api.use('/admin', admin);

  app.use('/api', api);
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof store.StoreError || err instanceof collection.CollectionError || err instanceof bulk.BulkError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That file is too large (max 2 MB)' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  });

  return app;
}

module.exports = { createApp };
