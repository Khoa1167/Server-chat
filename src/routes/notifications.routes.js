const router = require('express').Router();
const { protect } = require('../middleware/auth');
const notificationsController = require('../controllers/notifications.controller');

// GET /api/notifications — 50 thông báo gần nhất
router.get('/', protect, notificationsController.list);

// PUT /api/notifications/read — đánh dấu toàn bộ đã đọc (gọi khi mở panel thông báo)
router.put('/read', protect, notificationsController.markAllRead);

module.exports = router;
