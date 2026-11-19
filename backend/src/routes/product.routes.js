const router = require('express').Router();
const ctrl = require('../controllers/product.controller');
const { authenticate, adminOnly } = require('../middleware/auth.middleware');

router.get('/', authenticate, ctrl.list);               // catalog (customers) + inventory (admins)
router.get('/alerts', adminOnly, ctrl.alerts);          // low stock + expiring batches
router.get('/:id', authenticate, ctrl.get);
router.post('/', adminOnly, ctrl.create);
router.put('/:id', adminOnly, ctrl.update);
router.delete('/:id', adminOnly, ctrl.remove);
router.get('/:id/batches', adminOnly, ctrl.listBatches);
router.post('/:id/batches', adminOnly, ctrl.addBatch);

module.exports = router;
