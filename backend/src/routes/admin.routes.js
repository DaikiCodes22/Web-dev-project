const router = require('express').Router();
const ctrl = require('../controllers/admin.controller');
const { adminOnly } = require('../middleware/auth.middleware');

router.use(adminOnly);
router.get('/dashboard', ctrl.dashboard);
router.get('/dashboard/sales', ctrl.sales);
router.get('/invoices', ctrl.listInvoices);
router.post('/invoices/:id/payments', ctrl.recordPayment);

module.exports = router;
