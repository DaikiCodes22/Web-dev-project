const router = require('express').Router();
const { adminOnly } = require('../middleware/auth.middleware');
const { requirePermission } = require('../middleware/permission.middleware');
const c = require('../controllers/settings.controller');

router.use(adminOnly); // every staff role may reach /settings; the pages below add their own permission

// My profile
router.get('/profile', c.getProfile);
router.patch('/profile', c.updateProfile);
router.put('/password', c.changePassword);

// Staff accounts + RBAC matrix
router.get('/roles', requirePermission('users.manage'), c.roles);
router.get('/users', requirePermission('users.manage'), c.listUsers);
router.post('/users', requirePermission('users.manage'), c.createUser);
router.patch('/users/:id', requirePermission('users.manage'), c.updateUser);
router.post('/users/:id/reset-password', requirePermission('users.manage'), c.resetPassword);

// Activity logs
router.get('/logs', requirePermission('logs.view'), c.listLogs);

module.exports = router;
