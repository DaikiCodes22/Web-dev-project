const Order = require('../models/order.model');
const Customer = require('../models/customer.model');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { oneOf, pagination, positiveInt } = require('../utils/validate');

const STATUSES = ['pending_approval', 'batching', 'in_transit', 'delivered', 'cancelled'];
const isOwner = (u) => u.role === 'pharmacy_owner';

exports.create = asyncHandler(async (req, res) => {
  const pharmacy = await Customer.findByOwner(req.user.id);
  if (!pharmacy) throw new ApiError(404, 'No pharmacy is linked to this login');
  const { items, notes } = req.body;
  if (!Array.isArray(items) || !items.length) throw new ApiError(422, 'Your cart is empty');
  const clean = items.map((i) => ({ productId: positiveInt(i.productId, 'productId'), quantity: positiveInt(i.quantity, 'quantity') }));
  const id = await Order.create({ pharmacyId: pharmacy.id, userId: req.user.id, items: clean, notes });
  res.status(201).json(await Order.findById(id));
});

exports.list = asyncHandler(async (req, res) => {
  const { page, limit, offset } = pagination(req.query);
  const filters = { limit, offset, q: req.query.q };
  if (req.query.status) filters.status = oneOf(req.query.status, STATUSES, 'status');
  if (isOwner(req.user)) {
    const pharmacy = await Customer.findByOwner(req.user.id);
    if (!pharmacy) return res.json({ data: [], meta: { page, limit, total: 0 } });
    filters.pharmacyId = pharmacy.id; // owners can only ever see their own orders
  } else if (req.query.pharmacyId) filters.pharmacyId = Number(req.query.pharmacyId);
  const { rows, total } = await Order.list(filters);
  res.json({ data: rows, meta: { page, limit, total } });
});

exports.get = asyncHandler(async (req, res) => {
  const order = await Order.findById(req.params.id);
  if (!order) throw new ApiError(404, 'Order not found');
  if (isOwner(req.user)) {
    const pharmacy = await Customer.findByOwner(req.user.id);
    if (!pharmacy || pharmacy.id !== order.pharmacyId) throw new ApiError(404, 'Order not found');
  }
  res.json(order);
});

exports.updateStatus = asyncHandler(async (req, res) => {
  const to = oneOf(req.body.status, ['batching', 'in_transit', 'delivered', 'cancelled'], 'status');
  await Order.updateStatus(Number(req.params.id), to, req.user.id);
  res.json(await Order.findById(req.params.id));
});
