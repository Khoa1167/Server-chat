const mongoose = require('mongoose');

// Audit log các lần đăng nhập (thành công lẫn thất bại) — khác User.devices (chỉ lưu trạng thái
// HIỆN TẠI của tối đa 5 thiết bị đang hoạt động), đây là lịch sử theo thời gian, append-only.
const loginHistorySchema = new mongoose.Schema({
  user:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  success:   { type: Boolean, required: true },
  ip:        { type: String, default: '' },
  userAgent: { type: String, default: '' },
  // TTL tự xóa sau 90 ngày — tránh phình collection vô hạn, đủ dài để người dùng tự soát lại nếu
  // nghi ngờ tài khoản bị truy cập trái phép.
  expiresAt: { type: Date, default: () => new Date(Date.now() + 90 * 24 * 60 * 60 * 1000) },
}, { timestamps: true });

// Truy vấn chính: lấy lịch sử của 1 user, mới nhất trước.
loginHistorySchema.index({ user: 1, createdAt: -1 });
loginHistorySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('LoginHistory', loginHistorySchema);
