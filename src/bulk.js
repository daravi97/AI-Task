// Bulk product management: CSV import (create + update in one go) and bulk stock updates.

class BulkError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const MAX_ROWS = 1000;

// Minimal RFC 4180 CSV parser: quoted fields, escaped quotes (""), commas/newlines inside
// quotes, CRLF, a UTF-8 BOM, and Excel's semicolon-separated variant (some regional settings).
function parseCsv(text) {
  text = String(text ?? '').replace(/^﻿/, '');
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
  const delimiter = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';

  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"' && field === '') {
      inQuotes = true;
    } else if (c === delimiter) {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else {
      field += c;
    }
  }
  if (inQuotes) throw new BulkError('The file has an unclosed quote (") — check the last rows');
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

// Accept the column names people naturally use in a spreadsheet.
const HEADER_ALIASES = {
  name: ['name', 'product', 'product name', 'item', 'item name'],
  description: ['description', 'desc', 'details'],
  category: ['category', 'type'],
  price: ['price', 'price (tokens)', 'tokens', 'token price', 'cost'],
  stock: ['stock', 'qty', 'quantity', 'stock qty', 'stock quantity', 'inventory'],
  image: ['icon', 'image', 'emoji'],
  active: ['active', 'visible', 'status', 'enabled'],
};

function mapHeaders(headerRow) {
  const columns = {};
  const unknown = [];
  headerRow.forEach((raw, index) => {
    const h = raw.trim().toLowerCase();
    if (!h) return;
    const key = Object.keys(HEADER_ALIASES).find((k) => HEADER_ALIASES[k].includes(h));
    if (!key) unknown.push(raw.trim());
    else if (key in columns) throw new BulkError(`Column "${raw.trim()}" appears more than once`);
    else columns[key] = index;
  });
  if (!('name' in columns)) throw new BulkError('The file needs a "name" column (see the template)');
  return { columns, unknown };
}

function parseActive(value) {
  const v = value.trim().toLowerCase();
  if (['', 'yes', 'y', 'true', '1', 'active', 'visible', 'on'].includes(v)) return v === '' ? null : 1;
  if (['no', 'n', 'false', '0', 'hidden', 'inactive', 'off'].includes(v)) return 0;
  return undefined;
}

function parseWhole(value) {
  const v = value.trim().replace(/,/g, '');
  if (v === '') return null;
  return /^-?\d+$/.test(v) ? Number(v) : NaN;
}

const FIELDS = ['name', 'description', 'category', 'price', 'stock', 'image', 'active'];

// Validate every row and work out what it would do, without writing anything.
// A row whose name matches an existing product (case-insensitive) updates it; blank cells
// keep the existing value, so a sheet with just "name, stock" is a quick restock.
function planImport(db, csvText) {
  const table = parseCsv(csvText);
  if (table.length < 2) throw new BulkError('The file has no product rows under the header');
  if (table.length - 1 > MAX_ROWS) throw new BulkError(`Too many rows — the limit is ${MAX_ROWS} per upload`);
  const { columns, unknown } = mapHeaders(table[0]);

  const existing = new Map(db.prepare('SELECT * FROM products').all().map((p) => [p.name.toLowerCase(), p]));
  const seen = new Map();
  const rows = table.slice(1).map((cells, i) => {
    const line = i + 2; // spreadsheet row number (header is row 1)
    const cell = (key) => (key in columns ? String(cells[columns[key]] ?? '') : '');
    const errors = [];
    const name = cell('name').trim();
    if (!name) errors.push('Name is required');
    else if (name.length > 120) errors.push('Name is too long (max 120 characters)');
    const key = name.toLowerCase();
    if (name && seen.has(key)) errors.push(`Same product as row ${seen.get(key)}`);
    else if (name) seen.set(key, line);

    const price = parseWhole(cell('price'));
    const stock = parseWhole(cell('stock'));
    const active = parseActive(cell('active'));
    if (Number.isNaN(price) || (price !== null && price <= 0)) errors.push('Price must be a whole number above 0');
    if (Number.isNaN(stock) || (stock !== null && stock < 0)) errors.push('Stock must be a whole number, 0 or more');
    if (active === undefined) errors.push('Active must be yes or no');

    const current = existing.get(key);
    if (!current && price === null && !errors.length) errors.push('Price is required for a new product');

    const incoming = {
      name,
      description: 'description' in columns ? cell('description').trim() : null,
      category: 'category' in columns ? cell('category').trim() : null,
      price,
      stock,
      image: 'image' in columns ? cell('image').trim() : null,
      active,
    };
    if (errors.length) return { line, name, action: 'error', errors };

    if (!current) {
      const product = {
        name,
        description: incoming.description ?? '',
        category: incoming.category || 'General',
        price,
        stock: stock ?? 0,
        image: incoming.image || '🎁',
        active: active ?? 1,
      };
      return { line, name, action: 'create', product, changes: [] };
    }

    // Blank / missing cells keep what's already there.
    const product = { ...current };
    for (const f of FIELDS) {
      const v = incoming[f];
      if (v === null || v === '' || f === 'name') continue;
      product[f] = v;
    }
    const changes = FIELDS.filter((f) => f !== 'name' && product[f] !== current[f])
      .map((f) => ({ field: f, from: current[f], to: product[f] }));
    return { line, name: current.name, id: current.id, action: changes.length ? 'update' : 'unchanged', product, changes };
  });

  const count = (a) => rows.filter((r) => r.action === a).length;
  return {
    rows,
    unknownColumns: unknown,
    summary: { total: rows.length, create: count('create'), update: count('update'), unchanged: count('unchanged'), error: count('error') },
  };
}

// Apply an import. All-or-nothing: if any row has an error, nothing is saved.
function importProducts(db, csvText, { dryRun = false } = {}) {
  const plan = planImport(db, csvText);
  if (dryRun || plan.summary.error > 0) return { ...plan, applied: false };

  db.exec('BEGIN IMMEDIATE');
  try {
    const insert = db.prepare(
      'INSERT INTO products (name, description, category, price, stock, image, active) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    const update = db.prepare(
      'UPDATE products SET description = ?, category = ?, price = ?, stock = ?, image = ?, active = ? WHERE id = ?'
    );
    for (const r of plan.rows) {
      const p = r.product;
      if (r.action === 'create') {
        r.id = Number(insert.run(p.name, p.description, p.category, p.price, p.stock, p.image, p.active).lastInsertRowid);
      } else if (r.action === 'update') {
        update.run(p.description, p.category, p.price, p.stock, p.image, p.active, r.id);
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { ...plan, applied: true };
}

// Set the stock of many products at once: [{ id, stock }]. All-or-nothing.
function setStockLevels(db, updates) {
  if (!Array.isArray(updates) || updates.length === 0) throw new BulkError('No stock changes to save');
  const clean = updates.map((u) => {
    const id = Number(u?.id);
    const stock = Number(u?.stock);
    if (!Number.isInteger(id)) throw new BulkError('Invalid product');
    if (!Number.isInteger(stock) || stock < 0) throw new BulkError('Stock must be a whole number, 0 or more');
    return { id, stock };
  });
  db.exec('BEGIN IMMEDIATE');
  try {
    const stmt = db.prepare('UPDATE products SET stock = ? WHERE id = ?');
    for (const { id, stock } of clean) {
      if (stmt.run(stock, id).changes === 0) throw new BulkError(`Product ${id} not found`, 404);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { updated: clean.length };
}

const TEMPLATE_CSV = [
  'name,description,category,price,stock,icon,active',
  'Company Umbrella,Compact umbrella with logo,Accessories,60,40,☂️,yes',
  'Phone Stand,Aluminium phone stand,Tech,35,25,📱,yes',
  '"Sticker Pack","Set of 10 vinyl stickers, assorted",Stationery,10,200,🏷️,yes',
  'Company Hoodie,,,,50,,',
].join('\r\n') + '\r\n';

module.exports = { BulkError, parseCsv, planImport, importProducts, setStockLevels, TEMPLATE_CSV, MAX_ROWS };
