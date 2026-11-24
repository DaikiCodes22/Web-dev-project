const { pool } = require('../config/database');

const num = (v) => Number(v || 0);

/**
 * The payment ledger = every row in `payments` (money in is positive, refunds out are negative)
 * PLUS a synthetic "auto-recorded" row for any invoice whose paid amount isn't covered by payment rows
 * (e.g. bank / e-wallet invoices that were marked paid automatically). So the ledger is complete however an invoice got paid.
 */
const LEDGER = `(
  SELECT p.id, p.invoice_id, p.amount, p.method, p.reference, p.paid_at, p.recorded_by, p.return_id, 0 AS implicit FROM payments p
  UNION ALL
  SELECT NULL, i.id, i.amount_paid - COALESCE(s.total, 0), 'auto', CONCAT('AUTO-', i.invoice_no), i.issue_date, NULL, NULL, 1
  FROM invoices i LEFT JOIN (SELECT invoice_id, SUM(amount) AS total FROM payments GROUP BY invoice_id) s ON s.invoice_id = i.id
  WHERE i.amount_paid - COALESCE(s.total, 0) > 0.005
) l
JOIN invoices i ON i.id = l.invoice_id
JOIN orders o ON o.id = i.order_id
JOIN pharmacies ph ON ph.id = i.pharmacy_id
LEFT JOIN users u ON u.id = l.recorded_by
LEFT JOIN return_requests rr ON rr.id = l.return_id`;

async function listPayments({ direction, method, q, from, to, limit, offset }) {
  const where = []; const p = [];
  if (direction === 'in') where.push('l.amount > 0');
  if (direction === 'out') where.push('l.amount < 0');
  if (method) { where.push('l.method = ?'); p.push(method); }
  if (q) { where.push('(i.invoice_no LIKE ? OR o.order_no LIKE ? OR ph.name LIKE ? OR l.reference LIKE ?)'); p.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
  if (from) { where.push('l.paid_at >= ?'); p.push(`${from} 00:00:00`); }
  if (to) { where.push('l.paid_at <= ?'); p.push(`${to} 23:59:59`); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [[t]] = await pool.query(
    `SELECT COUNT(*) AS count, COALESCE(SUM(CASE WHEN l.amount > 0 THEN l.amount END), 0) AS moneyIn,
            COALESCE(SUM(CASE WHEN l.amount < 0 THEN -l.amount END), 0) AS refundsOut FROM ${LEDGER} ${clause}`, p);
  const [rows] = await pool.query(
    `SELECT l.id, l.invoice_id AS invoiceId, i.invoice_no AS invoiceNo, i.order_id AS orderId, o.order_no AS orderNo, ph.name AS pharmacyName,
            l.amount, IF(l.amount < 0, 'out', 'in') AS direction, l.method, l.reference, l.paid_at AS paidAt,
            u.full_name AS recordedBy, l.implicit, rr.return_no AS returnNo
     FROM ${LEDGER} ${clause} ORDER BY l.paid_at DESC, l.invoice_id DESC, l.id DESC LIMIT ? OFFSET ?`, [...p, limit, offset]);
  return {
    rows: rows.map((r) => ({ ...r, amount: num(r.amount), implicit: !!r.implicit })),
    total: num(t.count),
    totals: { moneyIn: num(t.moneyIn), refundsOut: num(t.refundsOut), net: Math.round((num(t.moneyIn) - num(t.refundsOut)) * 100) / 100 },
  };
}

async function listInvoices({ status, q, limit, offset }) {
  const where = []; const p = [];
  if (status === 'overdue') where.push("i.status IN ('unpaid','partial') AND i.due_date < CURDATE()");
  else if (status) { where.push('i.status = ?'); p.push(status); }
  if (q) { where.push('(i.invoice_no LIKE ? OR o.order_no LIKE ? OR ph.name LIKE ?)'); p.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const from = 'FROM invoices i JOIN orders o ON o.id = i.order_id JOIN pharmacies ph ON ph.id = i.pharmacy_id';
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${from} ${clause}`, p);
  const [rows] = await pool.query(
    `SELECT i.id, i.invoice_no AS invoiceNo, i.order_id AS orderId, o.order_no AS orderNo, o.payment_method AS paymentMethod, o.status AS orderStatus,
            ph.name AS pharmacyName, i.amount, i.credited_amount AS creditedAmount, i.amount + i.credited_amount AS originalAmount,
            i.amount_paid AS amountPaid, i.amount - i.amount_paid AS balance, i.issue_date AS issueDate, i.due_date AS dueDate, i.status,
            (i.status IN ('unpaid','partial') AND i.due_date < CURDATE()) AS isOverdue, DATEDIFF(CURDATE(), i.due_date) AS daysOverdue
     ${from} ${clause} ORDER BY isOverdue DESC, i.issue_date DESC, i.id DESC LIMIT ? OFFSET ?`, [...p, limit, offset]);
  return {
    rows: rows.map((r) => ({
      ...r, amount: num(r.amount), creditedAmount: num(r.creditedAmount), originalAmount: num(r.originalAmount), amountPaid: num(r.amountPaid),
      balance: Math.max(num(r.balance), 0), isOverdue: !!r.isOverdue, daysOverdue: num(r.daysOverdue),
    })),
    total,
  };
}

async function invoiceSummary() {
  const [[r]] = await pool.query(
    `SELECT COALESCE(SUM(CASE WHEN status IN ('unpaid','partial') THEN amount - amount_paid END), 0) AS receivable,
            COALESCE(SUM(CASE WHEN status IN ('unpaid','partial') AND due_date < CURDATE() THEN amount - amount_paid END), 0) AS overdue,
            COALESCE(SUM(status IN ('unpaid','partial') AND due_date < CURDATE()), 0) AS overdueCount,
            COALESCE(SUM(credited_amount), 0) AS credited FROM invoices`);
  return { receivable: num(r.receivable), overdue: num(r.overdue), overdueCount: num(r.overdueCount), credited: num(r.credited) };
}

module.exports = { listPayments, listInvoices, invoiceSummary };
