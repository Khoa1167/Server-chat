const mongoose = require('mongoose');

const AI_HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const aiMessageSchema = new mongoose.Schema({
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'AiConversation', required: true },
  clientMessageId: { type: String, required: true, maxlength: 100 },
  ciphertext: { type: String, required: true, maxlength: 12000 },
  iv: { type: String, required: true, maxlength: 64 },
  cryptoVersion: { type: Number, default: 1, enum: [1] },
  expiresAt: { type: Date, default: () => new Date(Date.now() + AI_HISTORY_RETENTION_MS), expires: 0 },
}, { timestamps: true });

aiMessageSchema.index({ conversation: 1, createdAt: -1, _id: -1 });
aiMessageSchema.index({ owner: 1, clientMessageId: 1 }, { unique: true });

module.exports = mongoose.model('AiMessage', aiMessageSchema);
