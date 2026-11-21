const Dashboard = require('../models/dashboard.model');
const Invoice = require('../models/invoice.model');
const asyncHandler = require('../utils/asyncHandler');
const { pagination, required } = require('../utils/validate');

exports.dashboard = asyncHandler(async (_req, res) => res.json(await Dashboard.summary()));

exports.sales = asyncHandler(async (req, res) => {
  const period = ['weekly', 'monthly', 'yearly'].includes(req.query.period) ? req.query.period : 'monthly';
  res.json(await Dashboard.sales(period));
});

exports.listInvoices = asyncHandler(async (req, res) => {
  const { page, limit, offset } = pagination(req.query);
  const { rows, total } = await Invoice.list({ status: req.query.status, pharmacyId: req.query.pharmacyId, limit, offset });
  res.json({ data: rows, meta: { page, limit, total } });
});

exports.recordPayment = asyncHandler(async (req, res) => {
  required(req.body, ['amount']);
  res.status(201).json(await Invoice.recordPayment(Number(req.params.id), req.body, req.user.id));
});
