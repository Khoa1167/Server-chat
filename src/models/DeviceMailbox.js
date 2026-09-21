const mongoose = require('mongoose');

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const deviceMailboxSchema = new mongoose.Schema({
  recipientDeviceId: { type: String, required: true, index: true },
  event: { type: String, required: true },
  payload: { type: mongoose.Schema.Types.Mixed, required: true },
  expiresAt: { type: Date, default: () => new Date(Date.now() + RETENTION_MS), expires: 0 },
}, { timestamps: true });

deviceMailboxSchema.index({ recipientDeviceId: 1, createdAt: 1, _id: 1 });

module.exports = mongoose.model('DeviceMailbox', deviceMailboxSchema);
