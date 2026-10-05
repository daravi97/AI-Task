const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const bulk = require('../src/bulk');

const product = (db, name) => db.prepare('SELECT * FROM products WHERE name = ?').get(name);
const count = (db) => db.prepare('SELECT COUNT(*) AS n FROM products').get().n;

test('CSV parser handles quotes, commas, newlines, CRLF, BOM and semicolons', () => {
  assert.deepEqual(
    bulk.parseCsv('﻿name,description\r\n"Mug","Big, ""blue"" mug"\r\n"Pen","line1\nline2"\r\n\r\n'),
    [['name', 'description'], ['Mug', 'Big, "blue" mug'], ['Pen', 'line1\nline2']],
  );
  assert.deepEqual(bulk.parseCsv('name;price\nMug;25'), [['name', 'price'], ['Mug', '25']]);
  assert.throws(() => bulk.parseCsv('name\n"oops'), /unclosed quote/);
});

test('imports 10 new products with stock in one go', () => {
  const db = openDb(':memory:');
  const before = count(db);
  const lines = ['name,description,category,price,stock,icon,active'];
  for (let i = 1; i <= 10; i++) lines.push(`Item ${i},Desc ${i},Bulk,${i * 10},${i * 5},🎁,yes`);
  const r = bulk.importProducts(db, lines.join('\n'), { dryRun: false });
  assert.equal(r.applied, true);
  assert.deepEqual(r.summary, { total: 10, create: 10, update: 0, unchanged: 0, error: 0 });
  assert.equal(count(db), before + 10);
  assert.equal(product(db, 'Item 7').stock, 35);
  assert.equal(product(db, 'Item 7').price, 70);
});

test('dry run previews without saving', () => {
  const db = openDb(':memory:');
  const before = count(db);
  const r = bulk.importProducts(db, 'name,price,stock\nNew Thing,10,5', { dryRun: true });
  assert.equal(r.applied, false);
  assert.equal(r.rows[0].action, 'create');
  assert.equal(count(db), before);
});

test('matching names update existing products; blank cells keep current values', () => {
  const db = openDb(':memory:');
  const hoodie = product(db, 'Company Hoodie');
  const csv = 'Product Name,Qty,Price (tokens),Category\ncompany hoodie,99,,\nCeramic Mug,80,25,Drinkware\nTote Bag,,,';
  const r = bulk.importProducts(db, csv, { dryRun: false });
  assert.equal(r.applied, true);
  assert.deepEqual(r.summary, { total: 3, create: 0, update: 1, unchanged: 2, error: 0 });
  assert.deepEqual(r.rows[0].changes, [{ field: 'stock', from: hoodie.stock, to: 99 }]);
  const after = product(db, 'Company Hoodie');
  assert.equal(after.stock, 99);
  assert.equal(after.price, hoodie.price);
  assert.equal(after.description, hoodie.description);
});

test('any invalid row means nothing is saved, with a reason per row', () => {
  const db = openDb(':memory:');
  const before = count(db);
  const hoodieStock = product(db, 'Company Hoodie').stock;
  const csv = [
    'name,price,stock,active',
    'Good One,10,5,yes',
    'Company Hoodie,,1,',
    ',10,5,',
    'Bad Price,abc,5,',
    'Negative,10,-3,',
    'No Price,,5,',
    'Good One,10,5,',
    'Weird,10,5,maybe',
  ].join('\n');
  const r = bulk.importProducts(db, csv, { dryRun: false });
  assert.equal(r.applied, false);
  assert.equal(r.summary.error, 6);
  const errs = Object.fromEntries(r.rows.filter((x) => x.action === 'error').map((x) => [x.line, x.errors.join('; ')]));
  assert.match(errs[4], /Name is required/);
  assert.match(errs[5], /Price must be/);
  assert.match(errs[6], /Stock must be/);
  assert.match(errs[7], /Price is required for a new product/);
  assert.match(errs[8], /Same product as row 2/);
  assert.match(errs[9], /Active must be yes or no/);
  assert.equal(count(db), before);
  assert.equal(product(db, 'Company Hoodie').stock, hoodieStock);
});

test('file-level problems give a clear message', () => {
  const db = openDb(':memory:');
  assert.throws(() => bulk.importProducts(db, ''), /no product rows/);
  assert.throws(() => bulk.importProducts(db, 'name,price'), /no product rows/);
  assert.throws(() => bulk.importProducts(db, 'title,price\nX,1'), /"name" column/);
  assert.throws(() => bulk.importProducts(db, 'name,stock,qty\nX,1,2'), /more than once/);
  const r = bulk.importProducts(db, 'name,price,colour\nX,5,red', { dryRun: true });
  assert.deepEqual(r.unknownColumns, ['colour']);
});

test('the downloadable template imports cleanly', () => {
  const db = openDb(':memory:');
  const r = bulk.importProducts(db, bulk.TEMPLATE_CSV, { dryRun: false });
  assert.equal(r.applied, true);
  assert.equal(r.summary.create, 3);
  assert.equal(r.summary.update, 1);
  assert.equal(product(db, 'Sticker Pack').description, 'Set of 10 vinyl stickers, assorted');
  assert.equal(product(db, 'Company Hoodie').stock, 50);
});

test('setStockLevels updates many products atomically', () => {
  const db = openDb(':memory:');
  const mug = product(db, 'Ceramic Mug');
  const cap = product(db, 'Baseball Cap');
  assert.deepEqual(bulk.setStockLevels(db, [{ id: mug.id, stock: 3 }, { id: cap.id, stock: 0 }]), { updated: 2 });
  assert.equal(product(db, 'Ceramic Mug').stock, 3);
  assert.equal(product(db, 'Baseball Cap').stock, 0);

  assert.throws(() => bulk.setStockLevels(db, [{ id: mug.id, stock: 10 }, { id: 99999, stock: 1 }]), /not found/);
  assert.equal(product(db, 'Ceramic Mug').stock, 3, 'rolled back');
  assert.throws(() => bulk.setStockLevels(db, [{ id: mug.id, stock: -1 }]), /0 or more/);
  assert.throws(() => bulk.setStockLevels(db, [{ id: mug.id, stock: 1.5 }]), /whole number/);
  assert.throws(() => bulk.setStockLevels(db, []), /No stock changes/);
});
