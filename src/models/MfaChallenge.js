const mongoose = require('mongoose');

const mfaChallengeSchema = new mongoose.Schema({
  tokenHash: { type: String, required: true, unique: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  ip: { type: String, default: '' },
  userAgent: { type: String, default: '' },
  attempts: { type: Number, default: 0 },
  purpose: { type: String, enum: ['login', 'registration', 'step-up'], required: true, default: 'login' },
  method: { type: String, enum: ['totp', 'passkey'], default: null },
  webAuthnChallenge: { type: String, default: null },
  verifiedAt: { type: Date, default: null },
  usedAt: { type: Date, default: null },
  expiresAt: { type: Date, required: true },
}, { timestamps: true });

mfaChallengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('MfaChallenge', mfaChallengeSchema);
