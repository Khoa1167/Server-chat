const router = require('express').Router();
const { protect } = require('../middleware/auth');
const usersController = require('../controllers/users.controller');

// ─── GET /api/users/:userId/devices — Lấy publicKeys các thiết bị của user khác
router.get('/:userId/devices', protect, usersController.getUserDevices);

module.exports = router;
