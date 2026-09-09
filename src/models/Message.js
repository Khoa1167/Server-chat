const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  content:   { type: String, required: true, maxlength: 2000 },
  sender:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  room:      { type: mongoose.Schema.Types.ObjectId, ref: 'Room', required: true },
  type:      { type: String, enum: ['text', 'image', 'system', 'audio', 'file', 'poll'], default: 'text' },
  fileName:  { type: String, default: null },
  replyTo:   { type: mongoose.Schema.Types.ObjectId, ref: 'Message', default: null },
  forwardedFrom: { type: mongoose.Schema.Types.ObjectId, ref: 'Message', default: null },
  reactions: [{ emoji: String, users: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }] }],
  isDeleted: { type: Boolean, default: false },
  isEdited:  { type: Boolean, default: false },
  iv:           { type: String, default: null },
  tag:          { type: String, default: null },
  encryptedKeys:{ type: Map, of: String, default: {} }, // Map: deviceId -> encryptedSessionKey (Hex)
  // Sender Key (nhóm) — 'sender-key' dùng khóa AES tĩnh theo epoch thay vì RSA-wrap từng thiết bị mỗi tin nhắn
  scheme:         { type: String, enum: ['rsa-per-device', 'sender-key'], default: 'rsa-per-device' },
  senderDeviceId: { type: String, default: null },
  epoch:          { type: Number, default: null },
  // key = userId, value = phiếu bầu đã mã hóa E2EE. Server chỉ biết ai đã bỏ phiếu, không biết lựa chọn.
  pollVotes: { type: Map, of: mongoose.Schema.Types.Mixed, default: () => new Map() },
  // Tin nhắn tự hủy — expires:0 tạo TTL index, MongoDB tự xóa document đúng lúc expiresAt (quét ~60s/lần).
  expiresAt: { type: Date, default: null, expires: 0 },
}, { timestamps: true });

// Truy vấn nặng/thường xuyên nhất của app — không có index này thì mở 1 đoạn chat quét toàn bộ collection Message.
messageSchema.index({ room: 1, createdAt: -1 });

module.exports = mongoose.model('Message', messageSchema);
