const router = require('express').Router();
const ctrl = require('../controllers/order.controller');
const { authenticate, adminOnly, ownerOnly } = require('../middleware/auth.middleware');

router.post('/', ownerOnly, ctrl.create);
router.get('/', authenticate, ctrl.list);
router.get('/:id', authenticate, ctrl.get);
router.patch('/:id/status', adminOnly, ctrl.updateStatus);

module.exports = router;
