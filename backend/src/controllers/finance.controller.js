const Finance = require('../models/finance.model');
const asyncHandler = require('../utils/asyncHandler');
const { pagination } = require('../utils/validate');

const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : undefined);

exports.payments = asyncHandler(async (req, res) => {
  const { page, limit, offset } = pagination(req.query, 15);
  const direction = ['in', 'out'].includes(req.query.direction) ? req.query.direction : undefined;
  const { rows, total, totals } = await Finance.listPayments({ direction, method: req.query.method, q: req.query.q, from: day(req.query.from), to: day(req.query.to), limit, offset });
  res.json({ data: rows, meta: { page, limit, total, totals } });
});

exports.invoices = asyncHandler(async (req, res) => {
  const { page, limit, offset } = pagination(req.query, 15);
  const { rows, total } = await Finance.listInvoices({ status: req.query.status, q: req.query.q, limit, offset });
  res.json({ data: rows, meta: { page, limit, total, summary: await Finance.invoiceSummary() } });
});
