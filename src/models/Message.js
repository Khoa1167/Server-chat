const mongoose = require('mongoose');

const SERVER_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const messageSchema = new mongoose.Schema({
  content:   { type: String, required: true, maxlength: 2000 },
  sender:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  room:      { type: mongoose.Schema.Types.ObjectId, ref: 'Room', required: true },
  type:      { type: String, enum: ['text', 'image', 'system', 'audio', 'file', 'poll'], default: 'text' },
  fileName:  { type: String, default: null },
  attachment: { type: mongoose.Schema.Types.ObjectId, ref: 'Attachment', default: null },
  replyTo:   { type: mongoose.Schema.Types.ObjectId, ref: 'Message', default: null },
  forwardedFrom: { type: mongoose.Schema.Types.ObjectId, ref: 'Message', default: null },
  reactions: [{ emoji: String, users: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }] }],
  isDeleted: { type: Boolean, default: false },
  isEdited:  { type: Boolean, default: false },
  iv:           { type: String, default: null },
  tag:          { type: String, default: null },
  encryptedKeys:{ type: Map, of: String, default: {} }, // Luôn rỗng: Sender Key được phân phối riêng theo epoch.
  // Sender Key cho DM lẫn nhóm — không RSA-wrap khóa riêng theo từng tin nhắn.
  scheme:         { type: String, enum: ['sender-key'], default: 'sender-key' },
  senderDeviceId: { type: String, default: null },
  epoch:          { type: Number, default: null },
  // key = userId, value = phiếu bầu đã mã hóa E2EE. Server chỉ biết ai đã bỏ phiếu, không biết lựa chọn.
  pollVotes: { type: Map, of: mongoose.Schema.Types.Mixed, default: () => new Map() },
  // Tin nhắn tự hủy — expires:0 tạo TTL index, MongoDB tự xóa document đúng lúc expiresAt (quét ~60s/lần).
  expiresAt: { type: Date, default: null, expires: 0 },
  // Ciphertext trên server chỉ dùng để đồng bộ thiết bị; lịch sử lâu dài nằm ở client.
  serverExpiresAt: { type: Date, default: () => new Date(Date.now() + SERVER_RETENTION_MS), expires: 0, select: false },
}, { timestamps: true });

// Truy vấn nặng/thường xuyên nhất của app — không có index này thì mở 1 đoạn chat quét toàn bộ collection Message.
messageSchema.index({ room: 1, createdAt: -1, _id: -1 });

// TTL monitor chạy theo chu kỳ; chặn đọc/chỉnh sửa ciphertext đã quá hạn ngay cả trong khoảng chờ xóa vật lý.
messageSchema.pre(/^find/, function() {
  this.where({ serverExpiresAt: { $gt: new Date() } });
});

const Message = mongoose.model('Message', messageSchema);
Message.SERVER_RETENTION_MS = SERVER_RETENTION_MS;
module.exports = Message;
