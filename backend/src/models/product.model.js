const { pool, withTransaction } = require('../config/database');
const { MIN_SHELF_LIFE_DAYS } = require('../utils/pricing');
const ApiError = require('../utils/ApiError');

// Sellable stock = unexpired batches with at least MIN_SHELF_LIFE_DAYS left
const STOCK_JOIN = `
  LEFT JOIN (
    SELECT product_id,
           SUM(CASE WHEN expiry_date >= DATE_ADD(CURDATE(), INTERVAL ${Number(MIN_SHELF_LIFE_DAYS)} DAY) THEN qty_available ELSE 0 END) AS sellable,
           SUM(CASE WHEN expiry_date >= CURDATE() THEN qty_available ELSE 0 END) AS onHand,
           MIN(CASE WHEN qty_available > 0 AND expiry_date >= CURDATE() THEN expiry_date END) AS nextExpiry
    FROM batches GROUP BY product_id
  ) s ON s.product_id = p.id`;

const SELECT = `
  p.id, p.sku, p.name, p.generic_name AS genericName, p.strength, p.dosage_form AS dosageForm, p.pack_size AS packSize,
  p.category, p.manufacturer, p.unit_price AS unitPrice, p.unit_cost AS unitCost, p.image_url AS imageUrl,
  p.reorder_point AS reorderPoint, p.requires_prescription AS requiresPrescription, p.is_active AS isActive,
  COALESCE(s.sellable, 0) AS sellableStock, COALESCE(s.onHand, 0) AS onHand, s.nextExpiry,
  DATEDIFF(s.nextExpiry, CURDATE()) AS nextExpiryDays`;

function stockStatus(p) {
  if (p.onHand <= 0) return 'out';
  if (p.reorderPoint > 0 && p.onHand < p.reorderPoint) return 'low';
  if (p.nextExpiryDays !== null && p.nextExpiryDays <= 60) return 'expiring';
  return 'healthy';
}
const shape = (p) => p && { ...p, requiresPrescription: !!p.requiresPrescription, isActive: !!p.isActive, stockStatus: stockStatus(p) };

async function list({ q, category, includeInactive, limit, offset }) {
  const where = [];
  const params = [];
  if (!includeInactive) where.push('p.is_active = 1');
  if (q) { where.push('(p.name LIKE ? OR p.sku LIKE ? OR p.generic_name LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (category) { where.push('p.category = ?'); params.push(category); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM products p ${clause}`, params);
  const [rows] = await pool.query(`SELECT ${SELECT} FROM products p ${STOCK_JOIN} ${clause} ORDER BY p.name LIMIT ? OFFSET ?`, [...params, limit, offset]);
  const [cats] = await pool.query('SELECT DISTINCT category FROM products WHERE category IS NOT NULL ORDER BY category');
  return { rows: rows.map(shape), total, categories: cats.map((c) => c.category) };
}

async function findById(id) {
  const [[row]] = await pool.query(`SELECT ${SELECT} FROM products p ${STOCK_JOIN} WHERE p.id = ?`, [id]);
  return shape(row);
}

// Multipart forms send everything as text, so "false" must not count as true
const toBool = (v) => v === true || v === 1 || v === '1' || v === 'true';
const orNull = (v) => (v === undefined || v === null || v === '' ? null : v);

async function create(d) {
  const [res] = await pool.query(
    `INSERT INTO products (sku, name, generic_name, strength, dosage_form, pack_size, category, manufacturer, unit_price, unit_cost, image_url, reorder_point, requires_prescription)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [d.sku,
     d.name,
     orNull(d.genericName),
     orNull(d.strength),
     orNull(d.dosageForm),
     orNull(d.packSize),
     orNull(d.category),
     orNull(d.manufacturer),
     Number(d.unitPrice),
     orNull(d.unitCost) === null ? null : Number(d.unitCost),
     d.imageUrl || null,
     Number(d.reorderPoint) || 0,
     toBool(d.requiresPrescription) ? 1 : 0]
  );
  return res.insertId;
}

const FIELD_MAP = {
  name: 'name', genericName: 'generic_name', strength: 'strength', dosageForm: 'dosage_form', packSize: 'pack_size', category: 'category',
  manufacturer: 'manufacturer', unitPrice: 'unit_price', unitCost: 'unit_cost', reorderPoint: 'reorder_point', requiresPrescription: 'requires_prescription', isActive: 'is_active',
};
async function update(id, data) {
  const sets = [];
  const params = [];
  Object.entries(FIELD_MAP).forEach(([key, col]) => {
    if (data[key] !== undefined) {
      sets.push(`${col} = ?`);
      params.push(typeof data[key] === 'boolean' ? Number(data[key]) : data[key]);
    }
  });
  if (!sets.length) throw new ApiError(422, 'Nothing to update');
  await pool.query(`UPDATE products SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
}

const setImage = (id, url) => pool.query('UPDATE products SET image_url = ? WHERE id = ?', [url, id]);

const deactivate = (id) => pool.query('UPDATE products SET is_active = 0 WHERE id = ?', [id]);

async function listBatches(productId) {
  const [rows] = await pool.query(
    `SELECT id, batch_number AS batchNumber, expiry_date AS expiryDate, DATEDIFF(expiry_date, CURDATE()) AS daysLeft,
            qty_received AS qtyReceived, qty_available AS qtyAvailable, cost_price AS costPrice, received_at AS receivedAt
     FROM batches WHERE product_id = ? ORDER BY expiry_date ASC`, [productId]);
  return rows;
}

async function addBatch(productId, { batchNumber, expiryDate, quantity, costPrice }) {
  const [res] = await pool.query(
    'INSERT INTO batches (product_id, batch_number, expiry_date, qty_received, qty_available, cost_price) VALUES (?,?,?,?,?,?)',
    [productId, batchNumber, expiryDate, quantity, quantity, costPrice || null]);
  return res.insertId;
}

/** Products below their reorder point (sellable-or-not on-hand, unexpired) */
async function lowStock(limit) {
  const [rows] = await pool.query(
    `SELECT p.id, p.sku, p.name, p.pack_size AS packSize, p.reorder_point AS reorderPoint, COALESCE(s.onHand, 0) AS onHand
     FROM products p ${STOCK_JOIN}
     WHERE p.is_active = 1 AND p.reorder_point > 0 AND COALESCE(s.onHand, 0) < p.reorder_point
     ORDER BY COALESCE(s.onHand, 0) / p.reorder_point ASC ${limit ? 'LIMIT ' + Number(limit) : ''}`);
  return rows;
}

async function expiring(days = 60, limit = 50) {
  const [rows] = await pool.query(
    `SELECT b.id AS batchId, p.id AS productId, p.name AS productName, b.batch_number AS batchNumber, b.expiry_date AS expiryDate,
            DATEDIFF(b.expiry_date, CURDATE()) AS daysLeft, b.qty_available AS quantity
     FROM batches b JOIN products p ON p.id = b.product_id
     WHERE b.qty_available > 0 AND b.expiry_date >= CURDATE() AND b.expiry_date <= DATE_ADD(CURDATE(), INTERVAL ? DAY)
     ORDER BY b.expiry_date ASC LIMIT ?`, [days, limit]);
  return rows;
}

module.exports = { list, findById, create, update, setImage, deactivate, listBatches, addBatch, lowStock, expiring, withTransaction };
