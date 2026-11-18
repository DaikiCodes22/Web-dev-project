const fs = require('fs');
const path = require('path');
const Customer = require('../models/customer.model');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { UPLOAD_DIR } = require('../middleware/upload.middleware');
const { required, oneOf, pagination, isFutureDate } = require('../utils/validate');

const TERMS = ['COD', 'BANK', 'EWALLET'];
const TYPES = ['independent', 'chain', 'hospital'];

const removeFile = (file) => file && fs.unlink(file.path, () => {});

exports.list = asyncHandler(async (req, res) => {
  const { page, limit, offset } = pagination(req.query);
  const { q, paymentTerms, status } = req.query;
  const { rows, total, summary } = await Customer.list({ q, paymentTerms, status, limit, offset });
  res.json({ data: rows, meta: { page, limit, total, ...summary } });
});

exports.get = asyncHandler(async (req, res) => {
  const customer = await Customer.findById(req.params.id);
  if (!customer) throw new ApiError(404, 'Pharmacy not found');
  res.json(customer);
});

exports.mine = asyncHandler(async (req, res) => {
  const customer = await Customer.findByOwner(req.user.id);
  if (!customer) throw new ApiError(404, 'No pharmacy is linked to this login');
  res.json(customer);
});

exports.create = asyncHandler(async (req, res) => {
  const b = req.body;
  try {
    required(b, ['name', 'tin', 'streetAddress', 'city', 'postalCode', 'contactName', 'contactEmail', 'contactPhone', 'licenseNumber', 'licenseExpiry']);
    oneOf(b.storeType || 'independent', TYPES, 'storeType');
    if (b.paymentTerms) oneOf(b.paymentTerms, TERMS, 'paymentTerms');
    if (!isFutureDate(b.licenseExpiry)) throw new ApiError(422, 'License expiry date must be in the future');
    const creditLimit = Number(b.creditLimit || 0);
    if (!(creditLimit >= 0)) throw new ApiError(422, 'Credit limit must be zero or more');

    const id = await Customer.create({
      ...b, storeType: b.storeType || 'independent', creditLimit, documentPath: req.file ? req.file.filename : null,
    });
    res.status(201).json(await Customer.findById(id));
  } catch (err) {
    removeFile(req.file);
    throw err;
  }
});

exports.update = asyncHandler(async (req, res) => {
  const b = req.body;
  if (b.paymentTerms) oneOf(b.paymentTerms, TERMS, 'paymentTerms');
  if (b.storeType) oneOf(b.storeType, TYPES, 'storeType');
  if (b.creditLimit !== undefined && !(Number(b.creditLimit) >= 0)) throw new ApiError(422, 'Credit limit must be zero or more');
  if (!(await Customer.findById(req.params.id))) throw new ApiError(404, 'Pharmacy not found');
  await Customer.update(req.params.id, b);
  res.json(await Customer.findById(req.params.id));
});

/** verify | reject | freeze | unfreeze */
const ACTIONS = { verify: 'active', reject: 'rejected', freeze: 'frozen', unfreeze: 'active' };
exports.updateStatus = asyncHandler(async (req, res) => {
  const { action, reason } = req.body;
  oneOf(action, Object.keys(ACTIONS), 'action');
  const customer = await Customer.findById(req.params.id);
  if (!customer) throw new ApiError(404, 'Pharmacy not found');

  if (action === 'verify') {
    if (customer.status !== 'pending') throw new ApiError(409, 'Only pending accounts can be verified');
    if (customer.licenseDaysLeft < 0) throw new ApiError(422, 'Cannot verify: the license has expired');
    if (!customer.hasDocument && req.body.skipDocumentCheck !== true) throw new ApiError(422, 'Upload the LTO/FDA permit before verifying this account');
  }
  if (action === 'reject' && !reason) throw new ApiError(422, 'Please provide a reason for rejecting this account');
  if (action === 'freeze' && customer.status !== 'active') throw new ApiError(409, 'Only active accounts can be frozen');
  if (action === 'unfreeze' && customer.status !== 'frozen') throw new ApiError(409, 'Account is not frozen');

  await Customer.setStatus(customer.id, ACTIONS[action], { adminId: req.user.id, reason });
  res.json(await Customer.findById(customer.id));
});

exports.updateTerms = asyncHandler(async (req, res) => {
  const { paymentTerms, creditLimit } = req.body;
  if (paymentTerms) oneOf(paymentTerms, TERMS, 'paymentTerms');
  if (creditLimit !== undefined && !(Number(creditLimit) >= 0)) throw new ApiError(422, 'Credit limit must be zero or more');
  if (!(await Customer.findById(req.params.id))) throw new ApiError(404, 'Pharmacy not found');
  await Customer.update(req.params.id, { paymentTerms, creditLimit });
  res.json(await Customer.findById(req.params.id));
});

exports.uploadDocument = asyncHandler(async (req, res) => {
  if (!req.file) throw new ApiError(422, 'Attach the permit file in the "permit" field');
  if (!(await Customer.findById(req.params.id))) { removeFile(req.file); throw new ApiError(404, 'Pharmacy not found'); }
  const previous = await Customer.getDocumentPath(req.params.id);
  await Customer.setDocument(req.params.id, req.file.filename);
  if (previous) fs.unlink(path.join(UPLOAD_DIR, path.basename(previous)), () => {});
  res.json(await Customer.findById(req.params.id));
});

// Permits are private: only streamed to authenticated admins, never served as public static files
exports.downloadDocument = asyncHandler(async (req, res) => {
  const file = await Customer.getDocumentPath(req.params.id);
  if (!file) throw new ApiError(404, 'No permit on file');
  res.sendFile(path.join(UPLOAD_DIR, path.basename(file)));
});
