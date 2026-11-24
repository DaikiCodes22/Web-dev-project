const path = require('path');
const Return = require('../models/return.model');
const Customer = require('../models/customer.model');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { pagination } = require('../utils/validate');
const { removeFiles, RETURN_DIR } = require('../middleware/returnPhoto.middleware');

const isOwner = (u) => u.role === 'pharmacy_owner';

async function myPharmacy(req) {
  const ph = await Customer.findByOwner(req.user.id);
  if (!ph) throw new ApiError(404, 'No pharmacy is linked to this account');
  return ph;
}

// ---- pharmacy owner -----------------------------------------------------------
// What can still be returned from an order (also tells the page how long ago it was delivered)
exports.returnable = asyncHandler(async (req, res) => {
  const ph = await myPharmacy(req);
  res.json(await Return.returnable(Number(req.params.orderId), ph.id));
});

// multipart/form-data: orderId, reasonType, details, items (JSON text), photos[] (optional)
exports.create = asyncHandler(async (req, res) => {
  const files = req.files || [];
  try {
    const ph = await myPharmacy(req);
    const b = req.body;
    let items = b.items;
    if (typeof items === 'string') { try { items = JSON.parse(items); } catch { throw new ApiError(422, 'The list of products was not understood'); } }
    const id = await Return.create({ pharmacyId: ph.id, userId: req.user.id, orderId: Number(b.orderId), reasonType: b.reasonType, details: b.details, items, photoFiles: files });
    res.status(201).json(await Return.findById(id));
  } catch (err) {
    removeFiles(files); // the request wasn't saved, so don't keep its photos
    throw err;
  }
});

exports.mine = asyncHandler(async (req, res) => {
  const ph = await myPharmacy(req);
  const { page, limit, offset } = pagination(req.query, 10);
  const { rows, total } = await Return.list({ pharmacyId: ph.id, limit, offset });
  res.json({ data: rows, meta: { page, limit, total } });
});

// ---- admins and managers --------------------------------------------------------
exports.list = asyncHandler(async (req, res) => {
  const { page, limit, offset } = pagination(req.query, 12);
  const { rows, total } = await Return.list({ status: req.query.status, q: req.query.q, limit, offset });
  res.json({ data: rows, meta: { page, limit, total, counts: await Return.statusCounts() } });
});

exports.quarantine = asyncHandler(async (_req, res) => res.json(await Return.quarantine()));

exports.approve = asyncHandler(async (req, res) => res.json(await Return.approve(Number(req.params.id), req.user.id, req.body)));
exports.reject = asyncHandler(async (req, res) => res.json(await Return.reject(Number(req.params.id), req.user.id, req.body.reason)));
exports.receive = asyncHandler(async (req, res) => res.json(await Return.receive(Number(req.params.id), req.user.id, req.body.items)));
exports.resolve = asyncHandler(async (req, res) => res.json(await Return.resolve(Number(req.params.id), req.user.id, req.body.decisions)));

// ---- shared -------------------------------------------------------------------------
async function visible(req) {
  const ret = await Return.findById(Number(req.params.id));
  if (!ret) throw new ApiError(404, 'Return not found');
  if (isOwner(req.user) && ret.pharmacyId !== (await myPharmacy(req)).id) throw new ApiError(404, 'Return not found'); // not yours: same answer as "doesn't exist"
  return ret;
}

exports.get = asyncHandler(async (req, res) => res.json(await visible(req)));

// Photos are evidence: only the pharmacy that sent them and staff can open them
exports.photo = asyncHandler(async (req, res) => {
  await visible(req);
  const p = await Return.photo(Number(req.params.id), Number(req.params.photoId));
  if (!p) throw new ApiError(404, 'Photo not found');
  res.sendFile(path.join(RETURN_DIR, path.basename(p.fileName)));
});
