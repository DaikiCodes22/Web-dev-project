const Product = require('../models/product.model');
const Customer = require('../models/customer.model');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { generateSku } = require('../utils/skuGenerator');
const { round2 } = require('../utils/pricing');
const { required, pagination, positiveInt } = require('../utils/validate');
const { publicUrl, removeFile } = require('../middleware/productImage.middleware');

const isStaff = (u) => u.role !== 'pharmacy_owner';

// Pharmacies see list prices and availability only: never cost price, stock counts or internal status
const forCustomer = ({ onHand, reorderPoint, nextExpiry, nextExpiryDays, unitCost, stockStatus, ...p }) => ({
  ...p, discountPct: 0, yourPrice: round2(p.unitPrice),
  availability: p.sellableStock <= 0 ? 'out_of_stock' : p.sellableStock < reorderPoint ? 'low_stock' : 'in_stock',
});

exports.list = asyncHandler(async (req, res) => {
  const { page, limit, offset } = pagination(req.query, 20);
  const { rows, total, categories } = await Product.list({
    q: req.query.q, category: req.query.category, includeInactive: isStaff(req.user) && req.query.includeInactive === 'true', limit, offset,
  });
  const data = isStaff(req.user) ? rows : rows.map(forCustomer);
  res.json({ data, meta: { page, limit, total, categories } });
});

exports.get = asyncHandler(async (req, res) => {
  const product = await Product.findById(req.params.id);
  if (!product) throw new ApiError(404, 'Product not found');
  res.json(isStaff(req.user) ? product : forCustomer(product));
});

exports.create = asyncHandler(async (req, res) => {
  const b = req.body;
  try {
    required(b, ['name', 'unitPrice']);
    if (!(Number(b.unitPrice) > 0)) throw new ApiError(422, 'Unit price must be greater than zero');
    if (b.unitCost !== undefined && b.unitCost !== '' && !(Number(b.unitCost) >= 0)) throw new ApiError(422, 'Cost per pack must be zero or more');

    const sku = b.sku?.trim() || (await generateSku(b));
    const imageUrl = req.file ? publicUrl(req.file.filename) : null; // the photo is optional
    const id = await Product.create({ ...b, sku, imageUrl });
    res.status(201).json(await Product.findById(id));
  } catch (err) {
    removeFile(req.file);
    throw err;
  }
});

exports.update = asyncHandler(async (req, res) => {
  if (!(await Product.findById(req.params.id))) throw new ApiError(404, 'Product not found');
  if (req.body.unitPrice !== undefined && !(Number(req.body.unitPrice) > 0)) throw new ApiError(422, 'Unit price must be greater than zero');
  await Product.update(req.params.id, req.body);
  res.json(await Product.findById(req.params.id));
});

exports.remove = asyncHandler(async (req, res) => {
  if (!(await Product.findById(req.params.id))) throw new ApiError(404, 'Product not found');
  await Product.deactivate(req.params.id); // soft delete keeps order history intact
  res.status(204).end();
});

exports.listBatches = asyncHandler(async (req, res) => res.json(await Product.listBatches(req.params.id)));

exports.addBatch = asyncHandler(async (req, res) => {
  required(req.body, ['batchNumber', 'expiryDate', 'quantity']);
  const quantity = positiveInt(req.body.quantity, 'Quantity');
  if (new Date(req.body.expiryDate) <= new Date()) throw new ApiError(422, 'Expiry date must be in the future');
  if (!(await Product.findById(req.params.id))) throw new ApiError(404, 'Product not found');
  await Product.addBatch(req.params.id, { ...req.body, quantity });
  res.status(201).json(await Product.listBatches(req.params.id));
});

exports.alerts = asyncHandler(async (_req, res) => {
  res.json({ lowStock: await Product.lowStock(), expiring: await Product.expiring(60, 50) });
});

// Add or replace the photo of an existing product
exports.setImage = asyncHandler(async (req, res) => {
  if (!req.file) throw new ApiError(422, 'Choose an image file to upload');
  const product = await Product.findById(req.params.id);
  if (!product) { removeFile(req.file); throw new ApiError(404, 'Product not found'); }
  try {
    await Product.setImage(product.id, publicUrl(req.file.filename));
  } catch (err) { removeFile(req.file); throw err; }
  removeFile(product.imageUrl);
  res.json(await Product.findById(product.id));
});

exports.removeImage = asyncHandler(async (req, res) => {
  const product = await Product.findById(req.params.id);
  if (!product) throw new ApiError(404, 'Product not found');
  await Product.setImage(product.id, null);
  removeFile(product.imageUrl);
  res.json(await Product.findById(product.id));
});
