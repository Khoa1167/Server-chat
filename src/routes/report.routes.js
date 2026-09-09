const router = require('express').Router();
const { protect, requireAdmin } = require('../middleware/auth');
const reportController = require('../controllers/report.controller');

// ─── POST /api/reports — Gửi hoặc cập nhật báo cáo tin nhắn ─────────────────────
router.post('/', protect, reportController.submitReport);

// ─── GET /api/reports — Danh sách báo cáo dành cho Admin ──────────────────────
router.get('/', protect, requireAdmin, reportController.listReports);

// ─── POST /api/reports/:id/resolve — Admin xử lý báo cáo ──────────────────────
router.post('/:id/resolve', protect, requireAdmin, reportController.resolveReport);

module.exports = router;
