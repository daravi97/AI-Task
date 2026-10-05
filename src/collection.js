// Collection days: when and where staff pick up their orders.
// Admins schedule days in the portal; each order is booked onto the next available day.
const config = require('./config');
const { queueOrderEmail, ACTIVE_STATUSES } = require('./notifications');

class CollectionError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

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

function getDay(db, id) {
  return db.prepare('SELECT * FROM collection_days WHERE id = ?').get(id) ?? null;
}

function listDays(db, { from = null } = {}) {
  return db.prepare(
    `SELECT d.*,
            (SELECT COUNT(*) FROM orders o WHERE o.collection_day_id = d.id AND o.status IN ${ACTIVE_STATUSES}) AS active_orders,
            (SELECT COUNT(*) FROM orders o WHERE o.collection_day_id = d.id AND o.status = 'collected') AS collected_orders
       FROM collection_days d
      ${from ? 'WHERE d.date >= ?' : ''}
      ORDER BY d.date, d.start_time`
  ).all(...(from ? [from] : []));
}

// Orders placed today are collected from tomorrow onwards, giving admins time to prepare them.
function nextDay(db, today = config.today()) {
  return db.prepare('SELECT * FROM collection_days WHERE date >= ? ORDER BY date, start_time LIMIT 1')
    .get(config.addDays(today, 1)) ?? null;
}

// If the collection day is tomorrow (or sooner), the email being sent now already serves
// as the reminder, so mark it to stop the reminder job sending a second one.
function reminderStamp(day, today) {
  return day && day.date <= config.addDays(today, 1) ? new Date().toISOString() : null;
}

function validate(data, today) {
  const date = String(data.date ?? '');
  const start = String(data.start_time ?? '');
  const end = String(data.end_time ?? '');
  const location = String(data.location ?? '').trim();
  if (!config.isValidDate(date)) throw new CollectionError('Pick a valid date');
  if (date < today) throw new CollectionError('Collection days cannot be in the past');
  if (!config.isValidTime(start) || !config.isValidTime(end)) throw new CollectionError('Times must be in HH:MM format');
  if (start >= end) throw new CollectionError('End time must be after start time');
  if (!location) throw new CollectionError('Location is required');
  return { date, start_time: start, end_time: end, location, notes: String(data.notes ?? '').trim() };
}

// Book every active order without a collection day onto the next available day and email them.
function assignUnscheduledOrders(db, today) {
  const day = nextDay(db, today);
  if (!day) return 0;
  const orders = db.prepare(
    `SELECT id FROM orders WHERE collection_day_id IS NULL AND status IN ${ACTIVE_STATUSES}`
  ).all();
  const update = db.prepare("UPDATE orders SET collection_day_id = ?, reminder_sent_at = ?, updated_at = datetime('now') WHERE id = ?");
  for (const { id } of orders) {
    update.run(day.id, reminderStamp(day, today), id);
    queueOrderEmail(db, id, 'collection_updated');
  }
  return orders.length;
}

function createDay(db, data, { today = config.today() } = {}) {
  const v = validate(data, today);
  return transaction(db, () => {
    const id = db.prepare(
      'INSERT INTO collection_days (date, start_time, end_time, location, notes) VALUES (?, ?, ?, ?, ?)'
    ).run(v.date, v.start_time, v.end_time, v.location, v.notes).lastInsertRowid;
    const assigned = assignUnscheduledOrders(db, today);
    return { day: getDay(db, id), assignedOrders: assigned };
  });
}

function updateDay(db, id, data, { today = config.today() } = {}) {
  const v = validate(data, today);
  return transaction(db, () => {
    const before = getDay(db, id);
    if (!before) throw new CollectionError('Collection day not found', 404);
    db.prepare('UPDATE collection_days SET date = ?, start_time = ?, end_time = ?, location = ?, notes = ? WHERE id = ?')
      .run(v.date, v.start_time, v.end_time, v.location, v.notes, id);
    const changed = ['date', 'start_time', 'end_time', 'location', 'notes'].some((k) => before[k] !== v[k]);
    let notified = 0;
    if (changed) {
      const day = getDay(db, id);
      const orders = db.prepare(
        `SELECT id FROM orders WHERE collection_day_id = ? AND status IN ${ACTIVE_STATUSES}`
      ).all(id);
      const stamp = db.prepare('UPDATE orders SET reminder_sent_at = ? WHERE id = ?');
      for (const o of orders) {
        stamp.run(reminderStamp(day, today), o.id);
        queueOrderEmail(db, o.id, 'collection_updated');
      }
      notified = orders.length;
    }
    return { day: getDay(db, id), notifiedOrders: notified };
  });
}

function deleteDay(db, id) {
  return transaction(db, () => {
    if (!getDay(db, id)) throw new CollectionError('Collection day not found', 404);
    const { n } = db.prepare(
      `SELECT COUNT(*) AS n FROM orders WHERE collection_day_id = ? AND status IN ${ACTIVE_STATUSES}`
    ).get(id);
    if (n > 0) throw new CollectionError(`${n} active order(s) are booked on this day — move them to another day first`, 409);
    db.prepare('UPDATE orders SET collection_day_id = NULL WHERE collection_day_id = ?').run(id);
    db.prepare('DELETE FROM collection_days WHERE id = ?').run(id);
  });
}

// Move one order to a different collection day (or null to unschedule it) and email the owner.
function setOrderDay(db, orderId, dayId, { today = config.today() } = {}) {
  return transaction(db, () => {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!order) throw new CollectionError('Order not found', 404);
    if (!['pending', 'processing', 'ready'].includes(order.status)) {
      throw new CollectionError(`Cannot change collection for a ${order.status} order`, 409);
    }
    const day = dayId == null ? null : getDay(db, dayId);
    if (dayId != null && !day) throw new CollectionError('Collection day not found', 404);
    if (day && day.date < today) throw new CollectionError('That collection day has already passed');
    if ((order.collection_day_id ?? null) === (day?.id ?? null)) return order;
    db.prepare("UPDATE orders SET collection_day_id = ?, reminder_sent_at = ?, updated_at = datetime('now') WHERE id = ?")
      .run(day?.id ?? null, reminderStamp(day, today), orderId);
    queueOrderEmail(db, orderId, 'collection_updated');
  });
}

module.exports = {
  CollectionError, getDay, listDays, nextDay, reminderStamp, createDay, updateDay, deleteDay, setOrderDay,
};
