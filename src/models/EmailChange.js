const mongoose = require('mongoose');

const emailChangeSchema = new mongoose.Schema({
  userId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  newEmail:   { type: String, required: true, lowercase: true, trim: true },
  otp:        { type: String, required: true },
  attempts:   { type: Number, default: 0 },
  expiresAt:  { type: Date, required: true },
}, { timestamps: true });

// Tự động xóa record khi hết hạn (TTL Index 5 phút)
emailChangeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('EmailChange', emailChangeSchema);
