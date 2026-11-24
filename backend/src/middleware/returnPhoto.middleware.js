const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const ApiError = require('../utils/ApiError');

// Photos of damaged goods are evidence, so they are NOT public: they are only streamed through an authenticated endpoint.
const RETURN_DIR = path.resolve(__dirname, '..', '..', process.env.RETURN_PHOTO_DIR || 'uploads/returns');
fs.mkdirSync(RETURN_DIR, { recursive: true });

const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, RETURN_DIR),
    filename: (_req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + EXT[file.mimetype]),
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 5 },
  fileFilter: (_req, file, cb) => (EXT[file.mimetype] ? cb(null, true) : cb(new ApiError(422, 'Photos must be JPG, PNG or WebP files'))),
}).array('photos', 5);

/** Optional photos (field "photos", up to 5). Plain JSON requests pass straight through. */
const returnPhotoUpload = (req, res, next) => upload(req, res, (err) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') return next(new ApiError(422, 'Each photo must be under 5 MB'));
  if (err && err.code === 'LIMIT_UNEXPECTED_FILE') return next(new ApiError(422, 'You can attach up to 5 photos'));
  return next(err);
});

/** Deletes stored photos (multer files or file names). Never throws, and can't leave RETURN_DIR. */
function removeFiles(list = []) {
  for (const f of list) {
    try { fs.unlinkSync(path.join(RETURN_DIR, path.basename(typeof f === 'string' ? f : f.filename))); } catch { /* already gone */ }
  }
}

module.exports = { returnPhotoUpload, removeFiles, RETURN_DIR };
