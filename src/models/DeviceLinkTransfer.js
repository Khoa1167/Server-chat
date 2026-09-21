const mongoose = require('mongoose');

const deviceLinkTransferSchema = new mongoose.Schema({
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  targetDeviceId: { type: String, required: true, index: true },
  targetPublicKey: { type: mongoose.Schema.Types.Mixed, required: true },
  manualCodeHash: { type: String, required: true, select: false },
  sourceDeviceId: { type: String, default: null },
  sourcePublicKey: { type: mongoose.Schema.Types.Mixed, default: null },
  objectKey: { type: String, default: null },
  uploadId: { type: String, default: null },
  archiveDeadline: { type: Date, default: null },
  lastVerifiedPart: { type: Number, default: 0 },
  finalPartNumber: { type: Number, default: null },
  status: { type: String, enum: ['waiting', 'approved', 'uploading', 'ready'], default: 'waiting' },
  usableUntil: { type: Date, default: () => new Date(Date.now() + 10 * 60 * 1000), index: true },
  // Giữ document thêm 2 phút để worker xóa object R2 trước khi Mongo TTL dọn fallback.
  expiresAt: { type: Date, default: () => new Date(Date.now() + 12 * 60 * 1000), expires: 0 },
}, { timestamps: true });

deviceLinkTransferSchema.index({ owner: 1, targetDeviceId: 1, status: 1 });
deviceLinkTransferSchema.index({ owner: 1, manualCodeHash: 1, status: 1 });

module.exports = mongoose.model('DeviceLinkTransfer', deviceLinkTransferSchema);
