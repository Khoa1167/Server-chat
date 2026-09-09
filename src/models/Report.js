const mongoose = require('mongoose');

const reportSchema = new mongoose.Schema({
  reporter:           { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  reportedUser:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  messageId:          { type: mongoose.Schema.Types.ObjectId, ref: 'Message', required: true },
  roomId:             { type: mongoose.Schema.Types.ObjectId, ref: 'Room', required: true },
  decryptedContent:   { type: String },       // Mã hóa AES-256-GCM (encryptPII) at-rest
  ciphertextHash:     { type: String },       // SHA-256 hash của ciphertext gốc — để đối chiếu
  reason:             { type: String, enum: ['spam', 'scam', 'harassment', 'abuse', 'other'], required: true },
  status:             { type: String, enum: ['pending', 'reviewed', 'dismissed'], default: 'pending' },
  integrityMismatch:  { type: Boolean, default: false },
  suspectedBrigading: { type: Boolean, default: false },
  expiresAt:          { type: Date, default: null },
}, { timestamps: true });

reportSchema.index({ reporter: 1, messageId: 1 }, { unique: true });

// Weighted anti-brigading check (POST /) lọc theo reportedUser + khoảng thời gian gần đây
reportSchema.index({ reportedUser: 1, createdAt: 1 });

// TTL Index tự động xóa report 'dismissed' sau khi hết hạn expiresAt
reportSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('Report', reportSchema);
