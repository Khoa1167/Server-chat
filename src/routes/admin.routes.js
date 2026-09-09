const router = require('express').Router();
const { protect, requireAdmin } = require('../middleware/auth');
const adminController = require('../controllers/admin.controller');

// ─── GET /api/admin/users?q=&page= — Danh sách/tìm kiếm user cho admin ────────
router.get('/users', protect, requireAdmin, adminController.listUsers);

// ─── POST /api/admin/users/:id/ban — Khóa tài khoản ────────────────────────────
router.post('/users/:id/ban', protect, requireAdmin, adminController.banUser);

// ─── POST /api/admin/users/:id/unban — Mở khóa tài khoản ───────────────────────
router.post('/users/:id/unban', protect, requireAdmin, adminController.unbanUser);

module.exports = router;
