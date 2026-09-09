const router = require('express').Router();
const multer = require('multer');
const { protect } = require('../middleware/auth');
const transcribeController = require('../controllers/transcribe.controller');

// Không thuộc /rooms — route này không đọc/ghi Room/Message nào, chỉ proxy audio đã giải mã sẵn
// từ client lên dịch vụ ASR ngoài (xem services/transcription.js). Trần dung lượng khớp
// uploadAudio trong rooms.routes.js (cùng là audio 1 tin nhắn thoại).
const uploadAudio = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// POST /api/transcribe — chuyển audio (đã giải mã) thành văn bản, opt-in mỗi tin nhắn
router.post('/', protect, (req, res, next) => {
  uploadAudio.single('audio')(req, res, (err) => {
    if (err) return res.status(400).json({ message: err.message });
    next();
  });
}, transcribeController.transcribe);

module.exports = router;
