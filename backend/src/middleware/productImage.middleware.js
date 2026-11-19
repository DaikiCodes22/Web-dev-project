const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const ApiError = require('../utils/ApiError');

// Product photos are public catalog content, so they get their own folder. Permits (uploads/permits) are never served.
const PRODUCT_DIR = path.resolve(__dirname, '..', '..', process.env.PRODUCT_IMAGE_DIR);
fs.mkdirSync(PRODUCT_DIR, { recursive: true });

const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const MAX_BYTES = 5 * 1024 * 1024;
const PUBLIC_PATH = '/api/uploads/products';

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, PRODUCT_DIR),
    filename: (_req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + EXT[file.mimetype]),
  }),
  limits: { fileSize: MAX_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => (EXT[file.mimetype] ? cb(null, true) : cb(new ApiError(422, 'The image must be a JPG, PNG or WebP file'))),
}).single('image');

const productImageUpload = (req, res, next) => upload(req, res, (err) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') return next(new ApiError(422, 'The image is too large (max 5 MB)'));
  return next(err);
});

const publicUrl = (filename) => `${PUBLIC_PATH}/${filename}`;

function removeFile(ref) {
  try {
    const name = typeof ref === 'string' ? path.basename(ref) : ref && ref.filename;
    if (name) fs.unlinkSync(path.join(PRODUCT_DIR, path.basename(name)));
  } catch { /* already gone */ }
}

module.exports = { productImageUpload, PRODUCT_DIR, PUBLIC_PATH, publicUrl, removeFile };
