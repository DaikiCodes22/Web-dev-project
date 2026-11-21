const { pool } = require('../config/database');
const Product = require('./product.model');

const rows = async (sql, params = []) => (await pool.query(sql, params))[0];
const one = async (sql, params = []) => (await rows(sql, params))[0];
const num = (v) => Number(v || 0);
const pctChange = (cur, prev) => (prev ? Math.round(((cur - prev) / prev) * 1000) / 10 : null);

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const addMonths = (d, n) => new Date(d.getFullYear(), d.getMonth() + n, 1);
const SALES_STATUS = "status NOT IN ('cancelled','pending_approval')"; // an order counts as a sale once approved

/* ---------------------------------------------------------------- KPI cards */
async function kpis() {
  const ord = await one(
    `SELECT COALESCE(SUM(created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)), 0) AS cur,
            COALESCE(SUM(created_at < DATE_SUB(NOW(), INTERVAL 30 DAY) AND created_at >= DATE_SUB(NOW(), INTERVAL 60 DAY)), 0) AS prev
     FROM orders WHERE status <> 'cancelled'`
  );

  const sls = await one(
    `SELECT COALESCE(SUM(CASE WHEN created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY) THEN total ELSE 0 END), 0) AS cur,
            COALESCE(SUM(CASE WHEN created_at < DATE_SUB(NOW(), INTERVAL 30 DAY) AND created_at >= DATE_SUB(NOW(), INTERVAL 60 DAY) THEN total ELSE 0 END), 0) AS prev
     FROM orders WHERE ${SALES_STATUS}`
  );

  const rev = await one(
    `SELECT COALESCE(SUM(CASE WHEN paid_at >= DATE_SUB(NOW(), INTERVAL 30 DAY) THEN amount ELSE 0 END), 0) AS cur,
            COALESCE(SUM(CASE WHEN paid_at < DATE_SUB(NOW(), INTERVAL 30 DAY) AND paid_at >= DATE_SUB(NOW(), INTERVAL 60 DAY) THEN amount ELSE 0 END), 0) AS prev
     FROM payments`
  );

  const prf = await one(
    `SELECT
       COALESCE(SUM(CASE WHEN o.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY) THEN oi.quantity * (oi.unit_price - p.unit_cost) ELSE 0 END), 0) AS cur,
       COALESCE(SUM(CASE WHEN o.created_at < DATE_SUB(NOW(), INTERVAL 30 DAY) AND o.created_at >= DATE_SUB(NOW(), INTERVAL 60 DAY) THEN oi.quantity * (oi.unit_price - p.unit_cost) ELSE 0 END), 0) AS prev
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     JOIN products p ON p.id = oi.product_id
     WHERE o.${SALES_STATUS}`
  );

  const curOrders = num(ord.cur);
  const prevOrders = num(ord.prev);
  const curSales = num(sls.cur);
  const prevSales = num(sls.prev);
  const curRevenue = num(rev.cur);
  const prevRevenue = num(rev.prev);
  const curProfit = num(prf.cur);
  const prevProfit = num(prf.prev);

  return {
    totalOrders: { count: curOrders, changePct: pctChange(curOrders, prevOrders), previous: prevOrders },
    totalSales: { amount: curSales, changePct: pctChange(curSales, prevSales), previous: prevSales },
    revenue: { amount: curRevenue, changePct: pctChange(curRevenue, prevRevenue), previous: prevRevenue },
    profit: {
      amount: curProfit,
      changePct: pctChange(curProfit, prevProfit),
      previous: prevProfit,
      marginPct: curSales > 0 ? Math.round((curProfit / curSales) * 1000) / 10 : 0,
    },
  };
}

/* ------------------------------------------------------------ Revenue trend */
async function revenueTrend() {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  const buckets = Array.from({ length: 12 }, (_, i) => addMonths(first, -(11 - i))).map((d) => ({
    key: `${d.getFullYear()}-${pad(d.getMonth() + 1)}`,
    label: d.toLocaleDateString('en-US', { month: 'short' }),
    start: d,
  }));

  const data = await rows(
    `SELECT DATE_FORMAT(paid_at, '%Y-%m') AS k, COALESCE(SUM(amount), 0) AS v
     FROM payments
     WHERE paid_at >= ?
     GROUP BY k`,
    [ymd(buckets[0].start)]
  );

  const map = new Map(data.map((d) => [String(d.k), num(d.v)]));
  const points = buckets.map((b) => ({
    key: b.key,
    label: b.label,
    value: map.get(b.key) || 0,
  }));

  const curMonth = points[points.length - 1]?.value || 0;
  const prevMonth = points[points.length - 2]?.value || 0;

  return {
    total: curMonth,
    changePct: pctChange(curMonth, prevMonth),
    points,
  };
}

/* ----------------------------------------------------------------- Pipeline */
async function pipeline() {
  const r = await one(
    `SELECT COALESCE(SUM(status = 'pending_approval'), 0) AS pendingApproval, COALESCE(SUM(status = 'batching'), 0) AS batching,
            COALESCE(SUM(status = 'in_transit'), 0) AS inTransit,
            COALESCE(SUM(status = 'delivered' AND DATE(delivered_at) = CURDATE()), 0) AS deliveredToday FROM orders`
  );
  const out = Object.fromEntries(Object.entries(r).map(([k, v]) => [k, num(v)]));
  return { ...out, openOrders: out.pendingApproval + out.batching + out.inTransit };
}

/* ------------------------------------------------------------------- FEFO */
async function fefo() {
  const r = await one(
    `SELECT COALESCE(SUM(CASE WHEN expiry_date <= DATE_ADD(CURDATE(), INTERVAL 30 DAY) THEN qty_available END), 0) AS d30,
            COALESCE(SUM(CASE WHEN expiry_date > DATE_ADD(CURDATE(), INTERVAL 30 DAY) AND expiry_date <= DATE_ADD(CURDATE(), INTERVAL 60 DAY) THEN qty_available END), 0) AS d60,
            COALESCE(SUM(CASE WHEN expiry_date > DATE_ADD(CURDATE(), INTERVAL 60 DAY) THEN qty_available END), 0) AS d90
     FROM batches WHERE qty_available > 0 AND expiry_date >= CURDATE() AND expiry_date <= DATE_ADD(CURDATE(), INTERVAL 90 DAY)`
  );
  const tiers = [
    { key: 'd30', label: '≤ 30 days', units: num(r.d30) },
    { key: 'd60', label: '31–60 days', units: num(r.d60) },
    { key: 'd90', label: '61–90 days', units: num(r.d90) },
  ];
  return {
    tiers,
    totalUnits: tiers.reduce((s, t) => s + t.units, 0),
    unitsWithin30: tiers[0].units,
    nextToExpire: await Product.expiring(60, 3),
  };
}

/* ----------------------------------------------------------- Best sellers */
async function bestSellers(lowStockItems) {
  const top = await rows(
    `SELECT p.id, p.sku, p.name, p.pack_size AS packSize, SUM(oi.quantity) AS unitsSold, SUM(oi.line_total) AS revenue
     FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN products p ON p.id = oi.product_id
     WHERE o.status <> 'cancelled' AND o.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
     GROUP BY p.id ORDER BY revenue DESC LIMIT 5`
  );
  if (!top.length) return [];
  const ids = top.map((t) => t.id);
  const prev = await rows(
    `SELECT oi.product_id AS id, SUM(oi.line_total) AS revenue FROM order_items oi JOIN orders o ON o.id = oi.order_id
     WHERE o.status <> 'cancelled' AND o.created_at < DATE_SUB(NOW(), INTERVAL 30 DAY) AND o.created_at >= DATE_SUB(NOW(), INTERVAL 60 DAY)
       AND oi.product_id IN (?) GROUP BY oi.product_id`,
    [ids]
  );
  const expiring = await rows(
    'SELECT DISTINCT product_id AS id FROM batches WHERE qty_available > 0 AND expiry_date >= CURDATE() AND expiry_date <= DATE_ADD(CURDATE(), INTERVAL 60 DAY)'
  );
  const prevMap = new Map(prev.map((p) => [p.id, num(p.revenue)]));
  const lowSet = new Set(lowStockItems.map((l) => l.id));
  const expSet = new Set(expiring.map((e) => e.id));
  return top.map((t) => ({
    ...t,
    unitsSold: num(t.unitsSold),
    revenue: num(t.revenue),
    trend: num(t.revenue) >= (prevMap.get(t.id) || 0) ? 'up' : 'down',
    stockStatus: lowSet.has(t.id) ? 'low' : expSet.has(t.id) ? 'expiring' : 'healthy',
  }));
}

/* ----------------------------------------------------------- Recent orders */
async function recentOrders() {
  const list = await rows(
    `SELECT o.id, o.order_no AS orderNo, o.created_at AS createdAt, ph.name AS pharmacyName,
            (SELECT COUNT(*) FROM order_items WHERE order_id = o.id) AS itemCount,
            o.total, o.status, o.payment_method AS paymentMethod,
            i.status AS invoiceStatus, DATEDIFF(CURDATE(), i.due_date) AS daysOverdue,
            EXISTS(SELECT 1 FROM invoices x WHERE x.pharmacy_id = o.pharmacy_id AND x.status IN ('unpaid','partial') AND x.due_date < CURDATE()) AS accountOverdue
     FROM orders o
     JOIN pharmacies ph ON ph.id = o.pharmacy_id
     LEFT JOIN invoices i ON i.order_id = o.id
     ORDER BY o.created_at DESC
     LIMIT 5`
  );

  const terms = { COD: 'Cash on delivery', BANK: 'Online / bank', EWALLET: 'E-wallet' };
  return list.map((o) => {
    const payment = (() => {
      if (o.status === 'cancelled' || o.invoiceStatus === 'void') return { tone: 'neutral', label: 'Cancelled' };
      if (o.invoiceStatus === 'paid') return { tone: 'green', label: 'Paid' };
      if (o.invoiceStatus && o.daysOverdue > 0) return { tone: 'red', label: `Overdue ${o.daysOverdue} day${o.daysOverdue === 1 ? '' : 's'}` };
      if (o.invoiceStatus === 'partial') return { tone: 'yellow', label: 'Partly paid' };
      if (o.invoiceStatus) {
        if (o.paymentMethod === 'COD' && o.status !== 'delivered') return { tone: 'neutral', label: 'Pay on delivery' };   // still on its way
        if (o.daysOverdue === 0) return { tone: 'yellow', label: 'Due today' };
        if (o.daysOverdue >= -3) return { tone: 'yellow', label: `Due in ${-o.daysOverdue} day${o.daysOverdue === -1 ? '' : 's'}` };
        return { tone: 'neutral', label: 'Unpaid' };
      }
      if (o.accountOverdue) return { tone: 'red', label: 'Account overdue' };    // not invoiced yet, but this pharmacy already owes money
      return { tone: 'neutral', label: 'Not invoiced yet' };
    })();

    const { invoiceStatus, daysOverdue, accountOverdue, ...rest } = o;
    return { ...rest, total: num(o.total), itemCount: num(o.itemCount), payment };
  });
}

/* ---------------------------------------------------------------- Summary */
async function summary() {
  const lowStockAll = await Product.lowStock();
  const [k, revTrend, pipe, fe, best, recent] = await Promise.all([
    kpis(),
    revenueTrend(),
    pipeline(),
    fefo(),
    bestSellers(lowStockAll),
    recentOrders(),
  ]);

  return {
    kpis: k,
    revenueTrend: revTrend,
    pipeline: pipe,
    fefo: fe,
    lowStock: { count: lowStockAll.length, items: lowStockAll.slice(0, 5) },
    bestSellers: best,
    recentOrders: recent,
    priorityOrders: recent,
  };
}

/* ------------------------------------------------------------ Sales chart */
async function rangeStats(from, to) {
  const r = await one(
    `SELECT COALESCE(SUM(total), 0) AS total, COUNT(*) AS orders, COUNT(DISTINCT pharmacy_id) AS pharmacies
     FROM orders WHERE ${SALES_STATUS} AND created_at >= ? AND created_at < ?`,
    [from, to]
  );
  return { total: num(r.total), orders: num(r.orders), pharmacies: num(r.pharmacies) };
}

async function sales(period) {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const tomorrow = ymd(addDays(now, 1));
  let buckets; let sql; let head;

  if (period === 'weekly') {
    const monday = addDays(now, -((now.getDay() + 6) % 7));
    buckets = Array.from({ length: 8 }, (_, i) => addDays(monday, -7 * (7 - i)));
    sql = `SELECT DATE_FORMAT(DATE_SUB(DATE(created_at), INTERVAL WEEKDAY(created_at) DAY), '%Y-%m-%d') AS k, SUM(total) AS v
           FROM orders WHERE ${SALES_STATUS} AND created_at >= ? GROUP BY k`;
    buckets = buckets.map((d) => ({ key: ymd(d), label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), start: d }));
    head = { cur: [ymd(buckets[4].start), tomorrow], prev: [ymd(buckets[0].start), ymd(buckets[4].start)], caption: 'Last 4 weeks vs previous 4 weeks' };
  } else if (period === 'yearly') {
    buckets = Array.from({ length: 5 }, (_, i) => new Date(now.getFullYear() - 4 + i, 0, 1));
    sql = `SELECT CAST(YEAR(created_at) AS CHAR) AS k, SUM(total) AS v FROM orders WHERE ${SALES_STATUS} AND created_at >= ? GROUP BY k`;
    buckets = buckets.map((d, i) => ({ key: String(d.getFullYear()), label: i === 4 ? `${d.getFullYear()} YTD` : String(d.getFullYear()), start: d }));
    const yearAgo = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());
    const twoAgo = new Date(now.getFullYear() - 2, now.getMonth(), now.getDate());
    head = { cur: [ymd(yearAgo), tomorrow], prev: [ymd(twoAgo), ymd(yearAgo)], caption: 'Last 12 months vs previous year' };
  } else {
    period = 'monthly';
    const first = new Date(now.getFullYear(), now.getMonth(), 1);
    buckets = Array.from({ length: 12 }, (_, i) => addMonths(first, -(11 - i)));
    sql = `SELECT DATE_FORMAT(created_at, '%Y-%m') AS k, SUM(total) AS v FROM orders WHERE ${SALES_STATUS} AND created_at >= ? GROUP BY k`;
    buckets = buckets.map((d) => ({ key: `${d.getFullYear()}-${pad(d.getMonth() + 1)}`, label: d.toLocaleDateString('en-US', { month: 'short' }), start: d }));
    const cur = buckets[11].start; const prev = buckets[10].start;
    head = {
      cur: [ymd(cur), ymd(addMonths(cur, 1))],
      prev: [ymd(prev), ymd(cur)],
      caption: `${cur.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })} vs ${prev.toLocaleDateString('en-US', { month: 'long' })}`,
    };
  }

  const data = await rows(sql, [ymd(buckets[0].start)]);
  const map = new Map(data.map((d) => [String(d.k), num(d.v)]));
  const points = buckets.map((b) => ({ key: b.key, label: b.label, value: map.get(b.key) || 0 }));

  const [cur, prev] = [await rangeStats(...head.cur), await rangeStats(...head.prev)];
  const [{ c: totalPharmacies }] = await rows("SELECT COUNT(*) AS c FROM pharmacies WHERE status = 'active'");
  return {
    period,
    points,
    headline: { total: cur.total, changePct: pctChange(cur.total, prev.total), caption: head.caption },
    stats: {
      orders: cur.orders,
      avgOrderValue: cur.orders ? Math.round((cur.total / cur.orders) * 100) / 100 : 0,
      activePharmacies: cur.pharmacies,
      totalPharmacies: num(totalPharmacies),
    },
  };
}

module.exports = { summary, sales };