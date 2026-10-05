const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { hashPassword } = require('./auth');

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

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  total INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'ready', 'collected', 'cancelled')),
  note TEXT,
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

CREATE INDEX IF NOT EXISTS idx_ledger_user ON token_ledger(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
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
    'Orders go through Pending → Processing → Ready. When your order is Ready, collect it from the office reception / HR desk. The status changes to Collected once picked up.',
    'collect pickup pick up delivery deliver shipping ship receive where when'],
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
  ['Who do I contact for help?',
    'For anything the assistant cannot answer, contact the HR / People team or any store admin.',
    'help contact support human hr admin problem issue'],
];

const DEMO_PASSWORD = 'password123';

function openDb(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  seedIfEmpty(db);
  return db;
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
}

module.exports = { openDb, DEMO_PASSWORD };
