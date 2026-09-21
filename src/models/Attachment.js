const mongoose = require('mongoose');

// Chỉ giữ metadata cần để cấp quyền đọc/xóa object R2. Tên, MIME, kích thước thật
// và nội dung đều nằm trong attachment đã mã hóa ở client.
const attachmentSchema = new mongoose.Schema({
  attachmentId: { type: String, required: true, unique: true, index: true },
  room: { type: mongoose.Schema.Types.ObjectId, ref: 'Room', required: true, index: true },
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  message: { type: mongoose.Schema.Types.ObjectId, ref: 'Message', default: null, index: true },
  objectKey: { type: String, required: true, unique: true },
  type: { type: String, enum: ['image', 'audio', 'file'], required: true },
  expectedSize: { type: Number, required: true },
  status: { type: String, enum: ['pending', 'uploaded'], default: 'pending', index: true },
  // Pending upload tự hết hạn ở Mongo; object chưa hoàn tất không bao giờ được cấp URL tải.
  expiresAt: { type: Date, default: null, expires: 0 },
  // Tách khỏi TTL Mongo để worker có thể xóa object R2 trước khi document bị TTL dọn.
  objectExpiresAt: { type: Date, default: null, index: true },
}, { timestamps: true });

module.exports = mongoose.model('Attachment', attachmentSchema);
