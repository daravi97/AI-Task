const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { hashPassword } = require('./auth');
const { today, addDays } = require('./config');
const { newPickupCode } = require('./qr');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('staff', 'admin')),
  department TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

-- Every token movement is a ledger row; a balance is the sum of a user's rows.
CREATE TABLE IF NOT EXISTS token_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  amount INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('award', 'purchase', 'refund', 'adjustment')),
  reason TEXT,
  order_id INTEGER REFERENCES orders(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'General',
  price INTEGER NOT NULL CHECK (price > 0),
  stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
  image TEXT NOT NULL DEFAULT '🎁',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Days when staff can pick up their orders, scheduled by admins in the portal.
CREATE TABLE IF NOT EXISTS collection_days (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,              -- YYYY-MM-DD in the company timezone
  start_time TEXT NOT NULL,        -- HH:MM
  end_time TEXT NOT NULL,          -- HH:MM
  location TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  total INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'ready', 'collected', 'cancelled')),
  note TEXT,
  collection_day_id INTEGER REFERENCES collection_days(id),
  reminder_sent_at TEXT,
  pickup_code TEXT,                -- shown as a QR code; scanned at the collection desk
  collected_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  product_name TEXT NOT NULL,
  unit_price INTEGER NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0)
);

CREATE TABLE IF NOT EXISTS faqs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  keywords TEXT NOT NULL DEFAULT ''
);

-- Emails are queued here (in the same transaction as the change that caused them)
-- and delivered by a background worker, so checkout never waits on the SMTP server.
CREATE TABLE IF NOT EXISTS email_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  to_email TEXT NOT NULL,
  to_name TEXT,
  subject TEXT NOT NULL,
  html TEXT NOT NULL,
  text TEXT NOT NULL,
  order_id INTEGER REFERENCES orders(id),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_at TEXT NOT NULL,   -- ISO timestamp
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT,
  preview_url TEXT                 -- link to the delivered copy in a test inbox (Ethereal)
);

-- Small key/value store for settings changed from the admin screens (e.g. the test inbox).
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ledger_user ON token_ledger(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_collection_days_date ON collection_days(date);
CREATE INDEX IF NOT EXISTS idx_outbox_status ON email_outbox(status, next_attempt_at);
`;

const SEED_PRODUCTS = [
  ['Company Hoodie', 'Soft fleece hoodie with the embroidered company logo.', 'Apparel', 120, 25, '🧥'],
  ['Logo T-Shirt', '100% cotton crew-neck tee.', 'Apparel', 50, 60, '👕'],
  ['Baseball Cap', 'Adjustable cap with stitched logo.', 'Apparel', 40, 40, '🧢'],
  ['Insulated Water Bottle', 'Keeps drinks cold for 24h, hot for 12h.', 'Drinkware', 45, 50, '🍶'],
  ['Ceramic Mug', '350ml mug, dishwasher safe.', 'Drinkware', 25, 80, '☕'],
  ['Laptop Backpack', 'Fits 16" laptops, water resistant.', 'Bags', 150, 15, '🎒'],
  ['Tote Bag', 'Reusable canvas tote.', 'Bags', 20, 100, '👜'],
  ['Notebook & Pen Set', 'A5 hardcover notebook with a matching pen.', 'Stationery', 30, 70, '📓'],
  ['Wireless Earbuds', 'Bluetooth earbuds with charging case.', 'Tech', 300, 10, '🎧'],
  ['Desk Plant', 'Low-maintenance succulent in a branded pot.', 'Desk', 35, 30, '🪴'],
];

const SEED_FAQS = [
  ['What are appreciation tokens?',
    'Appreciation tokens are a thank-you currency awarded by managers and admins for great work, milestones and recognition moments. You spend them in this store on company merchandise. Tokens have no cash value.',
    'token tokens what appreciation currency points'],
  ['How do I earn tokens?',
    'Tokens are awarded by admins/managers — for example for peer recognition, project milestones, work anniversaries and company events. Each award shows up in your wallet history with the reason.',
    'earn get receive award awarded more how'],
  ['Do my tokens expire?',
    'No. Tokens stay in your wallet until you spend them.',
    'expire expiry expiration lose keep'],
  ['How do I buy an item?',
    'Browse the Shop, add items to your cart, then press Checkout. The total is deducted from your token balance immediately and your order appears under My Orders.',
    'buy purchase order checkout cart how'],
  ['How do I collect my order?',
    'Each order is booked onto the next scheduled collection day. Your confirmation email (and My Orders) shows the date, time and location, and you get a reminder email the day before. Just turn up in the time window and the status changes to Collected once picked up.',
    'collect pickup pick up delivery deliver shipping ship receive where when date day location'],
  ['When is the next collection day?',
    'Collection days are scheduled by the admin team. Your order shows its collection date under My Orders. If it says "to be confirmed", you will get an email as soon as a date is set.',
    'next collection day date schedule when email reminder'],
  ['Can I cancel an order?',
    'Yes, while the order is still Pending you can cancel it from My Orders and the tokens are refunded to your wallet straight away. After that, contact an admin.',
    'cancel cancellation refund return undo'],
  ['Can I exchange an item for a different size?',
    'Contact the HR team within 14 days of collecting the item. Exchanges depend on stock availability.',
    'exchange size swap wrong fit return'],
  ['Can I transfer tokens to a colleague?',
    'Not at the moment — tokens are personal. If you want to recognise a colleague, ask your manager or an admin to award them tokens.',
    'transfer give send colleague gift share'],
  ['What if an item is out of stock?',
    'Out-of-stock items cannot be ordered. Admins restock regularly, so check back later.',
    'stock out available availability sold restock'],
  ['What do I bring to collect my order?',
    'Your pickup QR code. It is in your confirmation and reminder emails, and under My Orders in the store. Show it at the collection desk and it gets scanned. You can also just give your name.',
    'qr code bring show scan pickup collect desk id'],
  ['Who do I contact for help?',
    'For anything the assistant cannot answer, contact the HR / People team or any store admin.',
    'help contact support human hr admin problem issue'],
];

// Password for the seeded demo accounts. Set SEED_PASSWORD when the site is public
// (e.g. on Render) so the published default can't be used to log in as admin.
const DEMO_PASSWORD = process.env.SEED_PASSWORD || 'password123';

function openDb(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  migrate(db);
  seedIfEmpty(db);
  return db;
}

// Add columns introduced after the first release to databases created before them.
function migrate(db) {
  const cols = db.prepare('PRAGMA table_info(orders)').all().map((c) => c.name);
  if (!cols.includes('collection_day_id')) {
    db.exec('ALTER TABLE orders ADD COLUMN collection_day_id INTEGER REFERENCES collection_days(id)');
  }
  if (!cols.includes('reminder_sent_at')) db.exec('ALTER TABLE orders ADD COLUMN reminder_sent_at TEXT');
  if (!cols.includes('pickup_code')) db.exec('ALTER TABLE orders ADD COLUMN pickup_code TEXT');
  if (!cols.includes('collected_at')) db.exec('ALTER TABLE orders ADD COLUMN collected_at TEXT');
  const outboxCols = db.prepare('PRAGMA table_info(email_outbox)').all().map((c) => c.name);
  if (!outboxCols.includes('preview_url')) db.exec('ALTER TABLE email_outbox ADD COLUMN preview_url TEXT');
  // Give orders placed before pickup codes existed a code of their own.
  const setCode = db.prepare('UPDATE orders SET pickup_code = ? WHERE id = ?');
  for (const { id } of db.prepare('SELECT id FROM orders WHERE pickup_code IS NULL').all()) setCode.run(newPickupCode(), id);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_pickup_code ON orders(pickup_code)');
}

function seedIfEmpty(db) {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM users').get();
  if (n > 0) return;

  const insertUser = db.prepare(
    'INSERT INTO users (name, email, password_hash, role, department) VALUES (?, ?, ?, ?, ?)'
  );
  const hash = hashPassword(DEMO_PASSWORD);
  const admin = insertUser.run('Store Admin', 'admin@company.com', hash, 'admin', 'People & Culture');
  const alice = insertUser.run('Alice Tan', 'alice@company.com', hash, 'staff', 'Engineering');
  const bob = insertUser.run('Bob Lim', 'bob@company.com', hash, 'staff', 'Sales');

  const award = db.prepare(
    "INSERT INTO token_ledger (user_id, amount, type, reason, created_by) VALUES (?, ?, 'award', ?, ?)"
  );
  award.run(alice.lastInsertRowid, 300, 'Welcome bonus', admin.lastInsertRowid);
  award.run(alice.lastInsertRowid, 150, 'Shipped the Q3 release', admin.lastInsertRowid);
  award.run(bob.lastInsertRowid, 200, 'Welcome bonus', admin.lastInsertRowid);

  const insertProduct = db.prepare(
    'INSERT INTO products (name, description, category, price, stock, image) VALUES (?, ?, ?, ?, ?, ?)'
  );
  for (const p of SEED_PRODUCTS) insertProduct.run(...p);

  const insertFaq = db.prepare('INSERT INTO faqs (question, answer, keywords) VALUES (?, ?, ?)');
  for (const f of SEED_FAQS) insertFaq.run(...f);

  db.prepare('INSERT INTO collection_days (date, start_time, end_time, location, notes) VALUES (?, ?, ?, ?, ?)')
    .run(addDays(today(), 3), '10:00', '16:00', 'Level 3 Reception (HR desk)', 'Bring your staff ID.');
}

module.exports = { openDb, DEMO_PASSWORD };
