const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const ctrl = require('../controllers/auth.controller');
const { authenticate } = require('../middleware/auth.middleware');

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false, message: { message: 'Too many attempts, try again later' } });

router.post('/login', authLimiter, ctrl.login);
router.post('/register', authLimiter, ctrl.register);
router.get('/me', authenticate, ctrl.me);

module.exports = router;
