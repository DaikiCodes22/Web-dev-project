const crypto = require('crypto');
const { pool, withTransaction } = require('../config/database');
const ApiError = require('../utils/ApiError');
const { TERMS_DAYS, MIN_SHELF_LIFE_DAYS, round2 } = require('../utils/pricing');

const PAYMENT_SQL = `
  CASE WHEN i.id IS NULL THEN 'unbilled' WHEN i.status = 'void' THEN 'void' WHEN i.status = 'paid' THEN 'paid'
       WHEN i.due_date < CURDATE() THEN 'overdue' WHEN i.status = 'partial' THEN 'partial' ELSE 'unpaid' END AS paymentStatus,
  DATEDIFF(CURDATE(), i.due_date) AS daysOverdue, DATEDIFF(i.due_date, CURDATE()) AS daysUntilDue, i.due_date AS dueDate,
  i.amount AS invoiceAmount, i.amount_paid AS amountPaid, i.amount - i.amount_paid AS amountDue,
  i.invoice_no AS invoiceNo`;

const SELECT = `
  o.id, o.order_no AS orderNo, o.pharmacy_id AS pharmacyId, ph.name AS pharmacyName, o.status,
  o.payment_method AS paymentMethod, o.payment_status AS paymentStatusField, o.subtotal, o.total, o.notes,
  o.created_at AS createdAt, o.approved_at AS approvedAt, o.shipped_at AS shippedAt, o.delivered_at AS deliveredAt,
  (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS itemCount, ${PAYMENT_SQL}`;
const FROM = `FROM orders o JOIN pharmacies ph ON ph.id = o.pharmacy_id LEFT JOIN invoices i ON i.order_id = o.id`;

async function list({ status, pharmacyId, q, limit, offset }) {
  const where = [];
  const params = [];
  if (status) { where.push('o.status = ?'); params.push(status); }
  if (pharmacyId) { where.push('o.pharmacy_id = ?'); params.push(pharmacyId); }
  if (q) { where.push('(o.order_no LIKE ? OR ph.name LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${FROM} ${clause}`, params);
  const [rows] = await pool.query(`SELECT ${SELECT} ${FROM} ${clause} ORDER BY o.created_at DESC, o.id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { rows, total };
}

async function findById(id) {
  const [[order]] = await pool.query(`SELECT ${SELECT} ${FROM} WHERE o.id = ?`, [id]);
  if (!order) return null;
  const [items] = await pool.query(
    `SELECT oi.id, oi.product_id AS productId, p.sku, p.name, p.pack_size AS packSize, oi.quantity, oi.unit_price AS unitPrice,
            oi.line_total AS lineTotal
     FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ?`, [id]);
  const [alloc] = await pool.query(
    `SELECT oib.order_item_id AS orderItemId, b.batch_number AS batchNumber, b.expiry_date AS expiryDate, oib.quantity
     FROM order_item_batches oib JOIN batches b ON b.id = oib.batch_id
     JOIN order_items oi ON oi.id = oib.order_item_id WHERE oi.order_id = ?`, [id]);
  items.forEach((it) => { it.batches = alloc.filter((a) => a.orderItemId === it.id); });
  return { ...order, items };
}

/** Customer places an order. Prices are always re-read from the DB – never trusted from the client. */
async function create({ pharmacyId, userId, items, paymentMethod, notes }) {
  return withTransaction(async (conn) => {
    const [[pharmacy]] = await conn.query(
      'SELECT id, status FROM pharmacies WHERE id = ? FOR UPDATE',
      [pharmacyId]);
    if (!pharmacy) throw new ApiError(404, 'Pharmacy account not found');
    if (pharmacy.status !== 'active') throw new ApiError(403, `Your account is ${pharmacy.status}. Orders can only be placed by active accounts.`);

    const merged = new Map();
    items.forEach((i) => merged.set(Number(i.productId), (merged.get(Number(i.productId)) || 0) + Number(i.quantity)));
    const ids = [...merged.keys()];

    const [products] = await conn.query('SELECT id, name, unit_price AS unitPrice FROM products WHERE id IN (?) AND is_active = 1', [ids]);
    if (products.length !== ids.length) throw new ApiError(422, 'One or more products are unavailable');
    const [stock] = await conn.query(
      `SELECT product_id AS productId, SUM(qty_available) AS qty FROM batches
       WHERE product_id IN (?) AND expiry_date >= DATE_ADD(CURDATE(), INTERVAL ? DAY) GROUP BY product_id`, [ids, MIN_SHELF_LIFE_DAYS]);
    const stockMap = new Map(stock.map((s) => [s.productId, Number(s.qty)]));

    let subtotal = 0;
    let total = 0;
    const lines = products.map((p) => {
      const qty = merged.get(p.id);
      if ((stockMap.get(p.id) || 0) < qty) throw new ApiError(409, `Not enough stock for ${p.name} (available: ${stockMap.get(p.id) || 0})`);
      const line = round2(qty * p.unitPrice);
      subtotal += line;
      total += line;
      return [p.id, qty, p.unitPrice, 0, line];
    });
    subtotal = round2(subtotal);
    total = round2(total);


    const initialPaymentStatus = paymentMethod === 'COD' ? 'unpaid' : 'paid';

    const [res] = await conn.query(
      `INSERT INTO orders (order_no, pharmacy_id, placed_by, payment_method, payment_status, subtotal, total, notes)
       VALUES (?,?,?,?,?,?,?,?)`,
      [`TMP-${crypto.randomBytes(8).toString("hex")}`, pharmacyId, userId, paymentMethod, initialPaymentStatus, subtotal, total, notes || null]);
    const orderId = res.insertId;
    await conn.query('UPDATE orders SET order_no = ? WHERE id = ?', [`WO-${String(orderId).padStart(5, '0')}`, orderId]);
    await conn.query('INSERT INTO order_items (order_id, product_id, quantity, unit_price, discount_pct, line_total) VALUES ?',
      [lines.map((l) => [orderId, ...l])]);
    return orderId;
  });
}

/**
 * Approve = reserve stock First-Expired-First-Out, issue the invoice and add it to the customer's balance.
 * Everything happens in one transaction – if any item lacks stock nothing is changed.
 */
async function approve(orderId, adminId) {
  return withTransaction(async (conn) => {
    const [[order]] = await conn.query('SELECT * FROM orders WHERE id = ? FOR UPDATE', [orderId]);
    if (!order) throw new ApiError(404, 'Order not found');
    if (order.status !== 'pending_approval') throw new ApiError(409, 'Only orders pending approval can be approved');

    const [[pharmacy]] = await conn.query('SELECT status FROM pharmacies WHERE id = ? FOR UPDATE', [order.pharmacy_id]);
    if (pharmacy.status !== 'active') throw new ApiError(409, `Cannot approve: the pharmacy account is ${pharmacy.status}`);

    const [items] = await conn.query('SELECT id, product_id, quantity FROM order_items WHERE order_id = ?', [orderId]);
    for (const item of items) {
      let need = item.quantity;
      const [batches] = await conn.query(
        `SELECT id, qty_available FROM batches
         WHERE product_id = ? AND qty_available > 0 AND expiry_date >= DATE_ADD(CURDATE(), INTERVAL ? DAY)
         ORDER BY expiry_date ASC, id ASC FOR UPDATE`, [item.product_id, MIN_SHELF_LIFE_DAYS]);
      for (const b of batches) {
        if (need === 0) break;
        const take = Math.min(need, b.qty_available);
        await conn.query('UPDATE batches SET qty_available = qty_available - ? WHERE id = ?', [take, b.id]);
        await conn.query('INSERT INTO order_item_batches (order_item_id, batch_id, quantity) VALUES (?,?,?)', [item.id, b.id, take]);
        need -= take;
      }
      if (need > 0) throw new ApiError(409, `Insufficient stock to approve this order (product #${item.product_id} short by ${need})`);
    }

    const days = TERMS_DAYS[order.payment_method] ?? 0;
    const [inv] = await conn.query(
      `INSERT INTO invoices (invoice_no, order_id, pharmacy_id, amount, issue_date, due_date)
       VALUES (?,?,?,?, CURDATE(), DATE_ADD(CURDATE(), INTERVAL ? DAY))`,
      [`TMP-${crypto.randomBytes(8).toString("hex")}`, orderId, order.pharmacy_id, order.total, days]);
    await conn.query('UPDATE invoices SET invoice_no = ? WHERE id = ?', [`INV-${String(inv.insertId).padStart(5, '0')}`, inv.insertId]);
    await conn.query('UPDATE pharmacies SET current_balance = current_balance + ? WHERE id = ?', [order.total, order.pharmacy_id]);
    await conn.query("UPDATE orders SET status = 'batching', approved_by = ?, approved_at = NOW() WHERE id = ?", [adminId, orderId]);
  });
}

const NEXT = { batching: 'in_transit', in_transit: 'delivered' };
const STAMP = { in_transit: 'shipped_at', delivered: 'delivered_at' };

/** Move an order through the pipeline: pending → batching → in_transit → delivered (or cancelled while pending) */
async function updateStatus(orderId, to, adminId) {
  if (to === 'batching') return approve(orderId, adminId);
  const [[order]] = await pool.query('SELECT status, payment_method FROM orders WHERE id = ?', [orderId]);
  if (!order) throw new ApiError(404, 'Order not found');
  
  if (to === 'cancelled') {
    if (order.status !== 'pending_approval') throw new ApiError(409, 'Only orders pending approval can be cancelled');
    await pool.query("UPDATE orders SET status = 'cancelled' WHERE id = ?", [orderId]);
    return;
  }
  
  if (NEXT[order.status] !== to) throw new ApiError(409, `Cannot move an order from ${order.status} to ${to}`);
  
  let extraUpdate = '';
  if (to === 'delivered' && order.payment_method === 'COD') {
    extraUpdate = ", payment_status = 'paid'";
  }

  await pool.query(`UPDATE orders SET status = ?, ${STAMP[to]} = NOW() ${extraUpdate} WHERE id = ?`, [to, orderId]);
}

module.exports = { list, findById, create, approve, updateStatus };