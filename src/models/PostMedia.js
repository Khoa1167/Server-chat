const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  post: { type: mongoose.Schema.Types.ObjectId, ref: 'Post', default: null },
  objectKey: { type: String, required: true, select: false },
  type: { type: String, enum: ['image', 'video'], required: true },
  mime: { type: String, required: true },
  size: { type: Number, required: true },
  status: { type: String, enum: ['pending', 'ready', 'deleting'], default: 'pending' },
  uploadExpiresAt: { type: Date, default: () => new Date(Date.now() + 6 * 60000) },
}, { timestamps: true });
schema.index({ post: 1 });
schema.index({ owner: 1, post: 1, createdAt: 1 });
module.exports = mongoose.model('PostMedia', schema);
