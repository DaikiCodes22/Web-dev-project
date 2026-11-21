const router = require('express').Router();
const ctrl = require('../controllers/customer.controller');
const { adminOnly, ownerOnly } = require('../middleware/auth.middleware');
const { permitUpload } = require('../middleware/upload.middleware');

router.get('/me', ownerOnly, ctrl.mine); // must be declared before '/:id'

router.use(adminOnly);
router.get('/', ctrl.list);
router.post('/', permitUpload.single('permit'), ctrl.create);
router.get('/:id', ctrl.get);
router.put('/:id', ctrl.update);
router.patch('/:id/status', ctrl.updateStatus);
router.post('/:id/document', permitUpload.single('permit'), ctrl.uploadDocument);
router.get('/:id/document', ctrl.downloadDocument);

module.exports = router;
