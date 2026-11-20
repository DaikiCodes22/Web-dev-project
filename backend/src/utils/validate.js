const ApiError = require('./ApiError');

/** Throws 422 listing every missing/blank field. */
function required(body, fields) {
  const missing = fields.filter((f) => body[f] === undefined || body[f] === null || String(body[f]).trim() === '');
  if (missing.length) throw new ApiError(422, `Missing required field(s): ${missing.join(', ')}`, { missing });
}

function oneOf(value, allowed, label) {
  if (!allowed.includes(value)) throw new ApiError(422, `${label} must be one of: ${allowed.join(', ')}`);
  return value;
}

function positiveInt(value, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new ApiError(422, `${label} must be a positive whole number`);
  return n;
}

function isFutureDate(value) {
  const d = new Date(value);
  return !Number.isNaN(d.getTime()) && d.getTime() > Date.now();
}

function pagination(query, defaultLimit = 10) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || defaultLimit));
  return { page, limit, offset: (page - 1) * limit };
}

module.exports = { required, oneOf, positiveInt, isFutureDate, pagination };
