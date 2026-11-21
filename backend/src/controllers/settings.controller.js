const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/user.model');
const Activity = require('../models/activity.model');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { required, oneOf } = require('../utils/validate');
const { STAFF_ROLES, ROLE_META, ROLE_PERMISSIONS, PERMISSION_META } = require('../utils/permissions');

const EMAIL = /^\S+@\S+\.\S+$/;
const CATEGORIES = ['auth', 'order', 'customer', 'product', 'batch', 'payment', 'user', 'profile'];
const sign = (u) => jwt.sign({ id: u.id, role: u.role, tv: u.tokenVersion || 0 }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '8h' });
const checkPassword = (pw) => { if (String(pw).length < 8) throw new ApiError(422, 'Password must be at least 8 characters'); };

// ---- My profile -------------------------------------------------------------
exports.getProfile = (req, res) => res.json({ user: User.publicUser(req.user) });

exports.updateProfile = asyncHandler(async (req, res) => {
  required(req.body, ['fullName', 'email']);
  const { fullName, email, phone } = req.body;
  if (!EMAIL.test(email)) throw new ApiError(422, 'Enter a valid email address');
  const taken = await User.findByEmail(email);
  if (taken && taken.id !== req.user.id) throw new ApiError(409, 'That email is already used by another account');
  await User.updateProfile(req.user.id, { fullName: String(fullName).trim(), email, phone });
  res.json({ user: User.publicUser(await User.findById(req.user.id)) });
});

exports.changePassword = asyncHandler(async (req, res) => {
  required(req.body, ['currentPassword', 'newPassword']);
  const { currentPassword, newPassword } = req.body;
  // 422, not 401: the frontend treats 401 as "session expired" and signs you out
  if (!(await bcrypt.compare(currentPassword, req.user.passwordHash))) throw new ApiError(422, 'Your current password is incorrect');
  checkPassword(newPassword);
  if (newPassword === currentPassword) throw new ApiError(422, 'Choose a password you have not used just now');
  await User.setPassword(req.user.id, await bcrypt.hash(newPassword, 10));
  // Every older token is now invalid; hand back a fresh one so this session stays signed in.
  res.json({ token: sign(await User.findById(req.user.id)), message: 'Password updated. Other devices have been signed out.' });
});

// ---- Staff accounts (users.manage) ----------------------------------------------
exports.roles = (_req, res) => res.json({
  roles: STAFF_ROLES.map((key) => ({ key, ...ROLE_META[key], permissions: ROLE_PERMISSIONS[key] })),
  permissions: Object.entries(PERMISSION_META).map(([key, label]) => ({ key, label })),
});

exports.listUsers = asyncHandler(async (_req, res) => res.json({ data: (await User.listStaff()).map(User.publicUser) }));

exports.createUser = asyncHandler(async (req, res) => {
  required(req.body, ['fullName', 'email', 'password', 'role']);
  const b = req.body;
  oneOf(b.role, STAFF_ROLES, 'role');
  if (!EMAIL.test(b.email)) throw new ApiError(422, 'Enter a valid email address');
  checkPassword(b.password);
  if (await User.findByEmail(b.email)) throw new ApiError(409, 'That email is already used by another account');
  const id = await User.create({ email: b.email, passwordHash: await bcrypt.hash(b.password, 10), fullName: String(b.fullName).trim(), phone: b.phone, role: b.role });
  res.status(201).json({ user: User.publicUser(await User.findById(id)) });
});

async function staffTarget(id) {
  const target = await User.findById(id);
  if (!target || !STAFF_ROLES.includes(target.role)) throw new ApiError(404, 'Staff account not found');
  return target;
}

exports.updateUser = asyncHandler(async (req, res) => {
  const target = await staffTarget(req.params.id);
  const patch = {};
  if (req.body.fullName !== undefined) patch.fullName = String(req.body.fullName).trim();
  if (req.body.role !== undefined) patch.role = oneOf(req.body.role, STAFF_ROLES, 'role');
  if (req.body.isActive !== undefined) patch.isActive = !!req.body.isActive;

  const changesRole = patch.role !== undefined && patch.role !== target.role;
  if (target.id === req.user.id && (changesRole || patch.isActive === false)) throw new ApiError(409, "You can't change your own role or deactivate yourself. Ask another admin.");
  const losesAdmin = target.role === 'admin' && target.isActive && ((patch.role && patch.role !== 'admin') || patch.isActive === false);
  if (losesAdmin && (await User.countActiveAdmins()) <= 1) throw new ApiError(409, 'There must always be at least one active admin');

  await User.updateStaff(target.id, patch);
  res.json({ user: User.publicUser(await User.findById(target.id)) });
});

exports.resetPassword = asyncHandler(async (req, res) => {
  const target = await staffTarget(req.params.id);
  required(req.body, ['password']);
  checkPassword(req.body.password);
  await User.setPassword(target.id, await bcrypt.hash(req.body.password, 10));
  res.json({ message: `Password reset. ${target.fullName} has been signed out everywhere.` });
});

// ---- Activity logs (logs.view) ---------------------------------------------------
exports.listLogs = asyncHandler(async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 15));
  const date = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : undefined);
  const { rows, total } = await Activity.list({
    page, limit, q: req.query.q ? String(req.query.q).slice(0, 80) : undefined,
    category: CATEGORIES.includes(req.query.category) ? req.query.category : undefined,
    from: date(req.query.from), to: date(req.query.to),
  });
  res.json({ data: rows, meta: { page, limit, total, categories: CATEGORIES } });
});
