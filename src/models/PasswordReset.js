const mongoose = require('mongoose');

const passwordResetSchema = new mongoose.Schema({
  email:      { type: String, required: true, lowercase: true, trim: true, index: true },
  otp:        { type: String, required: true },
  resetToken: { type: String, default: null },
  attempts:   { type: Number, default: 0 },
  expiresAt:  { type: Date, required: true },
  isVerified: { type: Boolean, default: false },
}, { timestamps: true });

// Tự động xóa record khi hết hạn (TTL Index)
passwordResetSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('PasswordReset', passwordResetSchema);
