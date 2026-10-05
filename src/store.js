// Business logic for wallets, catalog, orders and FAQs. All functions take the db handle first.

class StoreError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const ORDER_STATUSES = ['pending', 'processing', 'ready', 'collected', 'cancelled'];

function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function positiveInt(value, field) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new StoreError(`${field} must be a positive whole number`);
  return n;
}

// ---------- Wallet ----------

function getBalance(db, userId) {
  return db.prepare('SELECT COALESCE(SUM(amount), 0) AS balance FROM token_ledger WHERE user_id = ?').get(userId).balance;
}

function getLedger(db, userId, limit = 50) {
  return db.prepare(
    `SELECT l.id, l.amount, l.type, l.reason, l.order_id, l.created_at, a.name AS awarded_by
       FROM token_ledger l LEFT JOIN users a ON a.id = l.created_by
      WHERE l.user_id = ? ORDER BY l.id DESC LIMIT ?`
  ).all(userId, limit);
}

function awardTokens(db, { userIds, amount, reason, adminId }) {
  amount = positiveInt(amount, 'Amount');
  if (!reason || !String(reason).trim()) throw new StoreError('A reason is required so staff know what the tokens are for');
  if (!Array.isArray(userIds) || userIds.length === 0) throw new StoreError('Select at least one staff member');
  return transaction(db, () => {
    const exists = db.prepare('SELECT id FROM users WHERE id = ?');
    const insert = db.prepare(
      "INSERT INTO token_ledger (user_id, amount, type, reason, created_by) VALUES (?, ?, 'award', ?, ?)"
    );
    for (const id of userIds) {
      if (!exists.get(id)) throw new StoreError(`User ${id} not found`, 404);
      insert.run(id, amount, String(reason).trim(), adminId);
    }
    return { awarded: userIds.length, amount };
  });
}

// ---------- Catalog ----------

function listProducts(db, { includeInactive = false } = {}) {
  const where = includeInactive ? '' : 'WHERE active = 1';
  return db.prepare(`SELECT * FROM products ${where} ORDER BY category, name`).all();
}

function searchProducts(db, query) {
  const q = `%${String(query ?? '').trim()}%`;
  return db.prepare(
    `SELECT id, name, description, category, price, stock FROM products
      WHERE active = 1 AND (name LIKE ? OR description LIKE ? OR category LIKE ?)
      ORDER BY price LIMIT 20`
  ).all(q, q, q);
}

function saveProduct(db, data, id = null) {
  const name = String(data.name ?? '').trim();
  if (!name) throw new StoreError('Name is required');
  const price = positiveInt(data.price, 'Price');
  const stock = Number(data.stock ?? 0);
  if (!Number.isInteger(stock) || stock < 0) throw new StoreError('Stock must be zero or more');
  const values = [
    name,
    String(data.description ?? ''),
    String(data.category ?? 'General').trim() || 'General',
    price,
    stock,
    String(data.image ?? '🎁').trim() || '🎁',
    data.active === false || data.active === 0 ? 0 : 1,
  ];
  if (id == null) {
    const r = db.prepare(
      'INSERT INTO products (name, description, category, price, stock, image, active) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(...values);
    return db.prepare('SELECT * FROM products WHERE id = ?').get(r.lastInsertRowid);
  }
  const r = db.prepare(
    'UPDATE products SET name = ?, description = ?, category = ?, price = ?, stock = ?, image = ?, active = ? WHERE id = ?'
  ).run(...values, id);
  if (r.changes === 0) throw new StoreError('Product not found', 404);
  return db.prepare('SELECT * FROM products WHERE id = ?').get(id);
}

// ---------- Orders ----------

function placeOrder(db, userId, items, note = null) {
  if (!Array.isArray(items) || items.length === 0) throw new StoreError('Your cart is empty');

  // Merge duplicate lines so stock checks see the true quantity per product.
  const qty = new Map();
  for (const item of items) {
    const pid = positiveInt(item.productId, 'Product');
    qty.set(pid, (qty.get(pid) ?? 0) + positiveInt(item.quantity, 'Quantity'));
  }

  return transaction(db, () => {
    const getProduct = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1');
    const lines = [];
    let total = 0;
    for (const [pid, quantity] of qty) {
      const p = getProduct.get(pid);
      if (!p) throw new StoreError(`Product ${pid} is not available`, 404);
      if (p.stock < quantity) throw new StoreError(`Only ${p.stock} × ${p.name} left in stock`, 409);
      lines.push({ p, quantity });
      total += p.price * quantity;
    }

    const balance = getBalance(db, userId);
    if (balance < total) {
      throw new StoreError(`Not enough tokens: this order costs ${total} but your balance is ${balance}`, 402);
    }

    const orderId = db.prepare('INSERT INTO orders (user_id, total, note) VALUES (?, ?, ?)')
      .run(userId, total, note ? String(note).slice(0, 500) : null).lastInsertRowid;
    const insertItem = db.prepare(
      'INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity) VALUES (?, ?, ?, ?, ?)'
    );
    const decStock = db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?');
    for (const { p, quantity } of lines) {
      insertItem.run(orderId, p.id, p.name, p.price, quantity);
      decStock.run(quantity, p.id);
    }
    db.prepare(
      "INSERT INTO token_ledger (user_id, amount, type, reason, order_id) VALUES (?, ?, 'purchase', ?, ?)"
    ).run(userId, -total, `Order #${orderId}`, orderId);

    return getOrder(db, orderId);
  });
}

function getOrder(db, orderId) {
  const order = db.prepare(
    'SELECT o.*, u.name AS user_name, u.email AS user_email FROM orders o JOIN users u ON u.id = o.user_id WHERE o.id = ?'
  ).get(orderId);
  if (!order) return null;
  order.items = db.prepare(
    'SELECT product_id, product_name, unit_price, quantity FROM order_items WHERE order_id = ?'
  ).all(orderId);
  return order;
}

function listOrders(db, { userId = null, status = null } = {}) {
  const where = [];
  const params = [];
  if (userId != null) { where.push('user_id = ?'); params.push(userId); }
  if (status) { where.push('status = ?'); params.push(status); }
  const sql = `SELECT id FROM orders ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC`;
  return db.prepare(sql).all(...params).map((r) => getOrder(db, r.id));
}

// Cancelling refunds the tokens and returns the stock.
function cancelOrder(db, orderId, { byUserId = null, isAdmin = false } = {}) {
  return transaction(db, () => {
    const order = getOrder(db, orderId);
    if (!order) throw new StoreError('Order not found', 404);
    if (!isAdmin && order.user_id !== byUserId) throw new StoreError('Order not found', 404);
    if (order.status === 'cancelled') throw new StoreError('Order is already cancelled', 409);
    if (order.status === 'collected') throw new StoreError('Collected orders cannot be cancelled', 409);
    if (!isAdmin && order.status !== 'pending') {
      throw new StoreError('Only pending orders can be cancelled — please contact an admin', 409);
    }
    const incStock = db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?');
    for (const item of order.items) incStock.run(item.quantity, item.product_id);
    db.prepare(
      "INSERT INTO token_ledger (user_id, amount, type, reason, order_id, created_by) VALUES (?, ?, 'refund', ?, ?, ?)"
    ).run(order.user_id, order.total, `Refund for cancelled order #${orderId}`, orderId, byUserId);
    db.prepare("UPDATE orders SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?").run(orderId);
    return getOrder(db, orderId);
  });
}

function updateOrderStatus(db, orderId, status, adminId) {
  if (!ORDER_STATUSES.includes(status)) throw new StoreError('Invalid status');
  if (status === 'cancelled') return cancelOrder(db, orderId, { byUserId: adminId, isAdmin: true });
  const order = getOrder(db, orderId);
  if (!order) throw new StoreError('Order not found', 404);
  if (order.status === 'cancelled') throw new StoreError('Cancelled orders cannot be reopened', 409);
  db.prepare("UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, orderId);
  return getOrder(db, orderId);
}

// ---------- Users ----------

function listStaff(db) {
  return db.prepare(
    `SELECT u.id, u.name, u.email, u.role, u.department,
            COALESCE((SELECT SUM(amount) FROM token_ledger WHERE user_id = u.id), 0) AS balance
       FROM users u ORDER BY u.name`
  ).all();
}

// ---------- FAQs ----------

function listFaqs(db) {
  return db.prepare('SELECT * FROM faqs ORDER BY id').all();
}

function saveFaq(db, data, id = null) {
  const question = String(data.question ?? '').trim();
  const answer = String(data.answer ?? '').trim();
  if (!question || !answer) throw new StoreError('Question and answer are required');
  const keywords = String(data.keywords ?? '').trim();
  if (id == null) {
    const r = db.prepare('INSERT INTO faqs (question, answer, keywords) VALUES (?, ?, ?)').run(question, answer, keywords);
    return db.prepare('SELECT * FROM faqs WHERE id = ?').get(r.lastInsertRowid);
  }
  const r = db.prepare('UPDATE faqs SET question = ?, answer = ?, keywords = ? WHERE id = ?').run(question, answer, keywords, id);
  if (r.changes === 0) throw new StoreError('FAQ not found', 404);
  return db.prepare('SELECT * FROM faqs WHERE id = ?').get(id);
}

function deleteFaq(db, id) {
  const r = db.prepare('DELETE FROM faqs WHERE id = ?').run(id);
  if (r.changes === 0) throw new StoreError('FAQ not found', 404);
}

module.exports = {
  StoreError, ORDER_STATUSES,
  getBalance, getLedger, awardTokens,
  listProducts, searchProducts, saveProduct,
  placeOrder, getOrder, listOrders, cancelOrder, updateOrderStatus,
  listStaff,
  listFaqs, saveFaq, deleteFaq,
};
