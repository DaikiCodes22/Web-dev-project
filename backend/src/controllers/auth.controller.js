const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { withTransaction } = require('../config/database');
const User = require('../models/user.model');
const Customer = require('../models/customer.model');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { required, oneOf, isFutureDate } = require('../utils/validate');

const sign = (user) => jwt.sign({ id: user.id, role: user.role, tv: user.tokenVersion || 0 }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN });

exports.login = asyncHandler(async (req, res) => {
  required(req.body, ['email', 'password']);
  const user = await User.findByEmail(req.body.email);
  if (!user || !user.isActive || !(await bcrypt.compare(req.body.password, user.passwordHash))) throw new ApiError(401, 'Incorrect email or password');
  await User.touchLogin(user.id);
  res.json({ token: sign(user), user: User.publicUser(user) });
});

exports.register = asyncHandler(async (req, res) => {
  const b = req.body;
  required(b, ['fullName', 'email', 'password', 'phone', 'pharmacyName', 'tin', 'streetAddress', 'city', 'postalCode', 'licenseNumber', 'licenseExpiry']);
  if (String(b.password).length < 8) throw new ApiError(422, 'Password must be at least 8 characters');
  if (!/^\S+@\S+\.\S+$/.test(b.email)) throw new ApiError(422, 'Enter a valid email address');
  if (!isFutureDate(b.licenseExpiry)) throw new ApiError(422, 'Your license has already expired');
  const storeType = oneOf(b.storeType || 'independent', ['independent', 'chain', 'hospital'], 'storeType');

  const userId = await withTransaction(async (conn) => {
    const id = await User.create({ email: b.email, passwordHash: await bcrypt.hash(b.password, 10), fullName: b.fullName, phone: b.phone, role: 'pharmacy_owner' }, conn);
    await Customer.create({
      ownerUserId: id, name: b.pharmacyName, storeType, tin: b.tin, streetAddress: b.streetAddress, city: b.city, postalCode: b.postalCode,
      contactName: b.fullName, contactEmail: b.email, contactPhone: b.phone, licenseType: b.licenseType === 'FDA' ? 'FDA' : 'LTO',
      licenseNumber: b.licenseNumber, licenseExpiry: b.licenseExpiry,
    }, conn);
    return id;
  });
  const user = await User.findById(userId);
  res.status(201).json({ token: sign(user), user: User.publicUser(user), message: 'Account created. Our team will verify your license before you can order.' });
});

exports.me = asyncHandler(async (req, res) => {
  const pharmacy = req.user.role === 'pharmacy_owner' ? await Customer.findByOwner(req.user.id) : null;
  res.json({ user: User.publicUser(req.user), pharmacy });
});
