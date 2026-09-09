const router = require('express').Router();
const { protect } = require('../middleware/auth');
const securityController = require('../controllers/security.controller');

// ─── POST /api/security/check-link — Proxy kiểm tra Safe Browsing ──────────────
router.post('/check-link', protect, securityController.checkLink);

module.exports = router;
