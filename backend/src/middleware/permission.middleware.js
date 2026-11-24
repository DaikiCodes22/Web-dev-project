const ApiError = require('../utils/ApiError');
const { authenticate } = require('./auth.middleware');
const { STAFF_ROLES, RULES, can } = require('../utils/permissions');

const PROTECTED = /^\/(admin|customers|products|orders|finance|returns)(\/|$)/;
const deny = (role, permission) =>
  new ApiError(403, `Your ${role} role doesn't have permission to do this${permission ? ` (${permission})` : ''}. Ask an admin if you need access.`);


function permissionGate(req, res, next) {
  if (!PROTECTED.test(req.path)) return next();
  authenticate(req, res, (err) => {
    if (err) return next(err);
    if (!STAFF_ROLES.includes(req.user.role)) return next();
    const rule = RULES.find(([method, re]) => (method === '*' || method === req.method) && re.test(req.path));
    if (!rule) return req.user.role === 'admin' ? next() : next(deny(req.user.role));
    return can(req.user.role, rule[2]) ? next() : next(deny(req.user.role, rule[2]));
  });
}

const requirePermission = (permission) => (req, _res, next) => (can(req.user.role, permission) ? next() : next(deny(req.user.role, permission)));

module.exports = { permissionGate, requirePermission };
