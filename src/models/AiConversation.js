const mongoose = require('mongoose');

const AI_HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const aiConversationSchema = new mongoose.Schema({
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  clientConversationId: { type: String, required: true, maxlength: 100 },
  keyEnvelopes: { type: Map, of: String, required: true },
  cryptoVersion: { type: Number, default: 1, enum: [1] },
  lastMessageAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, default: () => new Date(Date.now() + AI_HISTORY_RETENTION_MS), expires: 0 },
}, { timestamps: true });

aiConversationSchema.index({ owner: 1, clientConversationId: 1 }, { unique: true });
aiConversationSchema.index({ owner: 1, lastMessageAt: -1, _id: -1 });

module.exports = mongoose.model('AiConversation', aiConversationSchema);
