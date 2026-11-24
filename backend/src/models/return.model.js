const crypto = require('crypto');
const { pool, withTransaction } = require('../config/database');
const ApiError = require('../utils/ApiError');
const { MIN_SHELF_LIFE_DAYS, round2 } = require('../utils/pricing');

// Policy: ordinary returns within 30 days of delivery, damaged goods any time. Nothing is blocked automatically;
// the request is flagged so the reviewer can decide. Change the number with RETURN_WINDOW_DAYS in .env.
const WINDOW_DAYS = Number(process.env.RETURN_WINDOW_DAYS || 30);
const REASONS = ['damaged', 'wrong_item', 'not_as_described', 'changed_mind', 'other'];
const num = (v) => Number(v || 0);

const HEAD = `
  SELECT r.id, r.return_no AS returnNo, r.order_id AS orderId, o.order_no AS orderNo, r.pharmacy_id AS pharmacyId, ph.name AS pharmacyName,
         r.reason_type AS reasonType, r.details, r.status, r.collect_goods AS collectGoods, r.refund_amount AS refundAmount,
         r.decision_note AS decisionNote, r.decided_at AS decidedAt, r.received_at AS receivedAt, r.completed_at AS completedAt, r.created_at AS createdAt,
         o.delivered_at AS deliveredAt, DATEDIFF(r.created_at, o.delivered_at) AS daysAfterDelivery,
         (SELECT COALESCE(SUM(ri.quantity), 0) FROM return_items ri WHERE ri.return_id = r.id) AS unitCount,
         (SELECT COALESCE(SUM(ri.quantity * ri.unit_price), 0) FROM return_items ri WHERE ri.return_id = r.id) AS requestedValue,
         (SELECT COALESCE(SUM(ri.qty_received - ri.qty_restocked - ri.qty_disposed), 0) FROM return_items ri WHERE ri.return_id = r.id) AS quarantineUnits
  FROM return_requests r JOIN orders o ON o.id = r.order_id JOIN pharmacies ph ON ph.id = r.pharmacy_id`;

function shape(r) {
  if (!r) return r;
  return {
    ...r, collectGoods: !!r.collectGoods, refundAmount: num(r.refundAmount), requestedValue: round2(num(r.requestedValue)),
    unitCount: num(r.unitCount), quarantineUnits: num(r.quarantineUnits),
    windowDays: WINDOW_DAYS, outsideWindow: r.reasonType !== 'damaged' && r.daysAfterDelivery != null && r.daysAfterDelivery > WINDOW_DAYS,
  };
}

async function list({ status, q, pharmacyId, limit, offset }) {
  const where = []; const p = [];
  if (status) { where.push('r.status = ?'); p.push(status); }
  if (pharmacyId) { where.push('r.pharmacy_id = ?'); p.push(pharmacyId); }
  if (q) { where.push('(r.return_no LIKE ? OR o.order_no LIKE ? OR ph.name LIKE ?)'); p.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM return_requests r JOIN orders o ON o.id = r.order_id JOIN pharmacies ph ON ph.id = r.pharmacy_id ${clause}`, p);
  const [rows] = await pool.query(`${HEAD} ${clause} ORDER BY r.id DESC LIMIT ? OFFSET ?`, [...p, limit, offset]);
  return { rows: rows.map(shape), total };
}

async function statusCounts() {
  const [rows] = await pool.query('SELECT status, COUNT(*) AS n FROM return_requests GROUP BY status');
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

async function findById(id, conn = pool) {
  const [[head]] = await conn.query(`${HEAD} WHERE r.id = ?`, [id]);
  if (!head) return null;
  const [items] = await conn.query(
    `SELECT ri.id, ri.order_item_id AS orderItemId, ri.product_id AS productId, p.sku, p.name, p.pack_size AS packSize, ri.quantity, ri.unit_price AS unitPrice,
            ri.qty_received AS qtyReceived, ri.qty_restocked AS qtyRestocked, ri.qty_disposed AS qtyDisposed,
            ri.qty_received - ri.qty_restocked - ri.qty_disposed AS quarantine
     FROM return_items ri JOIN products p ON p.id = ri.product_id WHERE ri.return_id = ? ORDER BY ri.id`, [id]);
  if (items.length) {
    const [alloc] = await conn.query(
      `SELECT oib.order_item_id AS orderItemId, b.id AS batchId, b.batch_number AS batchNumber, b.expiry_date AS expiryDate,
              DATEDIFF(b.expiry_date, CURDATE()) AS daysLeft, oib.quantity
       FROM order_item_batches oib JOIN batches b ON b.id = oib.batch_id WHERE oib.order_item_id IN (?)
       ORDER BY oib.quantity DESC, b.expiry_date DESC`, [items.map((i) => i.orderItemId)]);
    items.forEach((it) => {
      it.sourceBatches = alloc.filter((a) => a.orderItemId === it.orderItemId).map((a) => ({ ...a, canResell: a.daysLeft >= MIN_SHELF_LIFE_DAYS }));
    });
  }
  const [photos] = await conn.query('SELECT id, file_name AS fileName FROM return_photos WHERE return_id = ? ORDER BY id', [id]);
  return { ...shape(head), items, photos, minShelfLifeDays: MIN_SHELF_LIFE_DAYS };
}

/** What can still be returned from an order (ordered - already in a non-rejected request) */
async function returnable(orderId, pharmacyId, conn = pool) {
  const [[order]] = await conn.query(
    'SELECT id, order_no AS orderNo, pharmacy_id AS pharmacyId, status, delivered_at AS deliveredAt, DATEDIFF(NOW(), delivered_at) AS daysSinceDelivered FROM orders WHERE id = ?', [orderId]);
  if (!order || order.pharmacyId !== pharmacyId) throw new ApiError(404, 'Order not found');
  const [items] = await conn.query(
    `SELECT oi.id AS orderItemId, oi.product_id AS productId, p.name, p.pack_size AS packSize, oi.quantity, ROUND(oi.line_total / oi.quantity, 2) AS unitPrice,
            COALESCE((SELECT SUM(ri.quantity) FROM return_items ri JOIN return_requests rr ON rr.id = ri.return_id WHERE ri.order_item_id = oi.id AND rr.status <> 'rejected'), 0) AS returned
     FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ?`, [orderId]);
  return {
    order: { ...order, canRequest: order.status === 'delivered', windowDays: WINDOW_DAYS },
    items: items.map((i) => ({ ...i, quantity: num(i.quantity), unitPrice: num(i.unitPrice), returned: num(i.returned), remaining: num(i.quantity) - num(i.returned) })),
  };
}

async function create({ pharmacyId, userId, orderId, reasonType, details, items, photoFiles = [] }) {
  if (!REASONS.includes(reasonType)) throw new ApiError(422, 'Choose a reason for the return');
  if (!details || String(details).trim().length < 10) throw new ApiError(422, 'Please describe the problem in at least 10 characters');
  if (!Array.isArray(items) || !items.length) throw new ApiError(422, 'Choose at least one product to return');
  return withTransaction(async (conn) => {
    await conn.query('SELECT id FROM orders WHERE id = ? FOR UPDATE', [orderId]); // two requests for the same order can't both claim the same units
    const { order, items: avail } = await returnable(orderId, pharmacyId, conn);
    if (order.status !== 'delivered') throw new ApiError(409, 'You can only return an order after it has been delivered');

    const picked = new Map();
    for (const it of items) {
      const line = avail.find((a) => a.orderItemId === Number(it.orderItemId));
      const qty = Number(it.quantity);
      if (!line) throw new ApiError(422, 'One of the products is not part of this order');
      if (!Number.isInteger(qty) || qty < 1) throw new ApiError(422, 'Quantities must be whole numbers of 1 or more');
      picked.set(line.orderItemId, { line, qty: (picked.get(line.orderItemId)?.qty || 0) + qty });
    }
    for (const { line, qty } of picked.values()) {
      if (qty > line.remaining) throw new ApiError(422, `You can return at most ${line.remaining} of ${line.name} (the rest is already in a return request)`);
    }

    const [res] = await conn.query(
      'INSERT INTO return_requests (return_no, order_id, pharmacy_id, requested_by, reason_type, details) VALUES (?,?,?,?,?,?)',
      [`TMP-${crypto.randomBytes(8).toString('hex')}`, orderId, pharmacyId, userId, reasonType, String(details).trim()]);
    const id = res.insertId;
    await conn.query('UPDATE return_requests SET return_no = ? WHERE id = ?', [`RT-${String(id).padStart(5, '0')}`, id]);
    await conn.query('INSERT INTO return_items (return_id, order_item_id, product_id, quantity, unit_price) VALUES ?',
      [[...picked.values()].map(({ line, qty }) => [id, line.orderItemId, line.productId, qty, line.unitPrice])]);
    if (photoFiles.length) await conn.query('INSERT INTO return_photos (return_id, file_name) VALUES ?', [photoFiles.map((f) => [id, f.filename])]);
    return id;
  });
}

/**
 * Takes `amount` off the order's invoice.
 *  - the unpaid part is simply reduced (nothing to pay back)
 *  - the rest was already paid, so it is recorded as a NEGATIVE payment (a refund going out)
 * invoices.amount stays the net amount; credited_amount remembers how much was taken off.
 */
async function applyRefund(conn, orderId, returnId, returnNo, amount, userId) {
  if (!(amount > 0)) return { reducedUnpaid: 0, refundedOut: 0 };
  const [[inv]] = await conn.query("SELECT * FROM invoices WHERE order_id = ? AND status <> 'void' FOR UPDATE", [orderId]);
  if (!inv) throw new ApiError(409, 'This order has no open invoice to adjust');
  if (amount > round2(inv.amount) + 0.001) throw new ApiError(422, `The refund is more than what is left on the invoice (${round2(inv.amount)})`);

  const unpaid = Math.max(round2(inv.amount - inv.amount_paid), 0);
  const reducedUnpaid = round2(Math.min(amount, unpaid));
  const refundedOut = round2(amount - reducedUnpaid);
  const newAmount = round2(inv.amount - amount);
  const newPaid = round2(inv.amount_paid - refundedOut);
  const status = newAmount <= 0 ? 'void' : newPaid >= newAmount ? 'paid' : newPaid > 0 ? 'partial' : 'unpaid';

  await conn.query('UPDATE invoices SET amount = ?, amount_paid = ?, credited_amount = credited_amount + ?, status = ? WHERE id = ?', [newAmount, newPaid, amount, status, inv.id]);
  if (refundedOut > 0) {
    await conn.query('INSERT INTO payments (invoice_id, amount, method, reference, recorded_by, return_id) VALUES (?,?,?,?,?,?)', [inv.id, -refundedOut, 'refund', returnNo, userId, returnId]);
  }
  if (reducedUnpaid > 0) await conn.query('UPDATE pharmacies SET current_balance = GREATEST(0, current_balance - ?) WHERE id = ?', [reducedUnpaid, inv.pharmacy_id]);
  return { reducedUnpaid, refundedOut };
}

async function lock(conn, id) {
  const [[r]] = await conn.query('SELECT * FROM return_requests WHERE id = ? FOR UPDATE', [id]);
  if (!r) throw new ApiError(404, 'Return not found');
  return r;
}

async function approve(id, userId, { refundAmount, collectGoods = true, note } = {}) {
  return withTransaction(async (conn) => {
    const r = await lock(conn, id);
    if (r.status !== 'requested') throw new ApiError(409, `This return is already ${r.status}`);
    const [[{ value }]] = await conn.query('SELECT COALESCE(SUM(quantity * unit_price), 0) AS value FROM return_items WHERE return_id = ?', [id]);
    const max = round2(value);
    const refund = refundAmount === undefined || refundAmount === null || refundAmount === '' ? max : round2(Number(refundAmount));
    if (!(refund >= 0) || refund > max + 0.001) throw new ApiError(422, `The refund must be between 0 and ${max}`);

    await applyRefund(conn, r.order_id, id, r.return_no, refund, userId);
    const collect = collectGoods === false || collectGoods === 'false' ? 0 : 1;
    await conn.query(
      `UPDATE return_requests SET status = ?, collect_goods = ?, refund_amount = ?, decision_note = ?, decided_by = ?, decided_at = NOW(),
              completed_at = IF(? = 0, NOW(), NULL) WHERE id = ?`,
      [collect ? 'approved' : 'completed', collect, refund, note ? String(note).slice(0, 500) : null, userId, collect, id]);
    return findById(id, conn);
  });
}

async function reject(id, userId, reason) {
  if (!reason || !String(reason).trim()) throw new ApiError(422, 'Give a reason so the pharmacy knows why it was rejected');
  return withTransaction(async (conn) => {
    const r = await lock(conn, id);
    if (r.status !== 'requested') throw new ApiError(409, `This return is already ${r.status}`);
    await conn.query("UPDATE return_requests SET status = 'rejected', decision_note = ?, decided_by = ?, decided_at = NOW() WHERE id = ?", [String(reason).trim().slice(0, 500), userId, id]);
    return findById(id, conn);
  });
}

/** The goods arrived: they go to quarantine (NOT sellable stock) until someone decides restock or dispose */
async function receive(id, userId, received = []) {
  return withTransaction(async (conn) => {
    const r = await lock(conn, id);
    if (r.status !== 'approved' || !r.collect_goods) throw new ApiError(409, 'Only approved returns that need the goods back can be marked received');
    const [items] = await conn.query('SELECT id, quantity FROM return_items WHERE return_id = ? FOR UPDATE', [id]);
    for (const it of items) {
      const given = received.find((x) => Number(x.returnItemId) === it.id);
      const qty = given === undefined ? it.quantity : Number(given.qtyReceived);
      if (!Number.isInteger(qty) || qty < 0 || qty > it.quantity) throw new ApiError(422, `Received quantity must be between 0 and ${it.quantity}`);
      await conn.query('UPDATE return_items SET qty_received = ? WHERE id = ?', [qty, it.id]);
    }
    await conn.query("UPDATE return_requests SET status = 'received', received_at = NOW() WHERE id = ?", [id]);
    await finishIfEmpty(conn, id);
    return findById(id, conn);
  });
}

async function finishIfEmpty(conn, id) {
  const [[{ q }]] = await conn.query('SELECT COALESCE(SUM(qty_received - qty_restocked - qty_disposed), 0) AS q FROM return_items WHERE return_id = ?', [id]);
  if (Number(q) === 0) await conn.query("UPDATE return_requests SET status = 'completed', completed_at = NOW() WHERE id = ? AND status = 'received'", [id]);
}

/**
 * Decide what happens to units in quarantine: put some back on sale as a "return batch" and/or dispose of them.
 * Restocking needs: the units are sealed and undamaged (confirmed by the reviewer) AND the source batch still has
 * at least MIN_SHELF_LIFE_DAYS left. The return batch keeps the source batch's expiry date.
 */
async function resolve(id, userId, decisions = []) {
  if (!Array.isArray(decisions) || !decisions.length) throw new ApiError(422, 'Choose what to do with the quarantined units');
  return withTransaction(async (conn) => {
    const r = await lock(conn, id);
    if (r.status !== 'received') throw new ApiError(409, 'Only returns whose goods have been received can be resolved');
    let touched = 0;
    for (const d of decisions) {
      const restock = Number(d.restock || 0); const dispose = Number(d.dispose || 0);
      if (!Number.isInteger(restock) || !Number.isInteger(dispose) || restock < 0 || dispose < 0) throw new ApiError(422, 'Quantities must be whole numbers');
      if (restock + dispose === 0) continue;
      const [[ri]] = await conn.query('SELECT * FROM return_items WHERE id = ? AND return_id = ? FOR UPDATE', [d.returnItemId, id]);
      if (!ri) throw new ApiError(422, 'One of the items is not part of this return');
      const quarantine = ri.qty_received - ri.qty_restocked - ri.qty_disposed;
      if (restock + dispose > quarantine) throw new ApiError(422, `Only ${quarantine} unit(s) of this product are in quarantine`);

      if (restock > 0) {
        if (d.sealedAndUndamaged !== true) throw new ApiError(422, 'Confirm the units are sealed and undamaged before putting them back on sale');
        const [alloc] = await conn.query(
          `SELECT b.id, b.batch_number, b.expiry_date, b.cost_price, DATEDIFF(b.expiry_date, CURDATE()) AS daysLeft
           FROM order_item_batches oib JOIN batches b ON b.id = oib.batch_id WHERE oib.order_item_id = ? ORDER BY oib.quantity DESC, b.expiry_date DESC`, [ri.order_item_id]);
        if (!alloc.length) throw new ApiError(422, 'This order has no batch record, so its units cannot go back on sale. Dispose of them instead');
        const src = d.batchId ? alloc.find((a) => a.id === Number(d.batchId)) : alloc[0];
        if (!src) throw new ApiError(422, 'That batch was not used for this order');
        if (src.daysLeft < MIN_SHELF_LIFE_DAYS) throw new ApiError(422, `Only units with at least ${MIN_SHELF_LIFE_DAYS} days of shelf life can go back on sale (this batch has ${Math.max(src.daysLeft, 0)}). Dispose of them instead`);
        await conn.query(
          `INSERT INTO batches (product_id, batch_number, expiry_date, qty_received, qty_available, cost_price, received_at)
           VALUES (?,?,?,?,?,?, NOW())
           ON DUPLICATE KEY UPDATE qty_received = qty_received + VALUES(qty_received), qty_available = qty_available + VALUES(qty_available)`,
          [ri.product_id, `RET-${r.return_no.replace('RT-', '')}-${src.batch_number}`.slice(0, 60), src.expiry_date, restock, restock, src.cost_price]);
      }
      await conn.query('UPDATE return_items SET qty_restocked = qty_restocked + ?, qty_disposed = qty_disposed + ? WHERE id = ?', [restock, dispose, ri.id]);
      touched++;
    }
    if (!touched) throw new ApiError(422, 'Enter how many units to restock or dispose of');
    await finishIfEmpty(conn, id);
    return findById(id, conn);
  });
}

/** Every unit currently in quarantine, across all returns */
async function quarantine() {
  const [rows] = await pool.query(
    `SELECT ri.id AS returnItemId, r.id AS returnId, r.return_no AS returnNo, ph.name AS pharmacyName, p.sku, p.name AS productName,
            ri.qty_received - ri.qty_restocked - ri.qty_disposed AS units, r.received_at AS receivedAt, r.reason_type AS reasonType
     FROM return_items ri JOIN return_requests r ON r.id = ri.return_id JOIN pharmacies ph ON ph.id = r.pharmacy_id JOIN products p ON p.id = ri.product_id
     WHERE r.status = 'received' AND ri.qty_received - ri.qty_restocked - ri.qty_disposed > 0 ORDER BY r.received_at`);
  return { items: rows.map((r) => ({ ...r, units: num(r.units) })), totalUnits: rows.reduce((s, r) => s + num(r.units), 0) };
}

async function photo(returnId, photoId) {
  const [[row]] = await pool.query(
    'SELECT p.file_name AS fileName, r.pharmacy_id AS pharmacyId FROM return_photos p JOIN return_requests r ON r.id = p.return_id WHERE p.id = ? AND p.return_id = ?', [photoId, returnId]);
  return row;
}

module.exports = { WINDOW_DAYS, REASONS, list, statusCounts, findById, returnable, create, approve, reject, receive, resolve, quarantine, photo };
