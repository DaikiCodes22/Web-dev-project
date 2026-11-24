const jwt = require('jsonwebtoken');
const User = require('../models/user.model');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');

const authenticate = asyncHandler(async (req, _res, next) => {
  if (req.user) return next(); // already checked earlier in this request
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw new ApiError(401, 'Authentication required');
  let payload;
  try { payload = jwt.verify(token, process.env.JWT_SECRET); } catch { throw new ApiError(401, 'Session expired, please sign in again'); }
  const user = await User.findById(payload.id);
  if (!user || !user.isActive) throw new ApiError(401, 'Account is not active');
  // A password change or reset bumps token_version, which signs out every older session
  if ((payload.tv || 0) !== user.tokenVersion) throw new ApiError(401, 'Your password was changed, please sign in again');
  req.user = user;
  next();
});

const requireRole = (...roles) => [
  authenticate,
  (req, _res, next) => (roles.includes(req.user.role) ? next() : next(new ApiError(403, 'You do not have permission to do that'))),
];

module.exports = {
  authenticate,
  requireRole,
  adminOnly: requireRole('admin', 'manager', 'staff'),
  ownerOnly: requireRole('pharmacy_owner'),
};
