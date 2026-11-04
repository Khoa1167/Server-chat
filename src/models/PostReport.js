const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  reporter: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  post: { type: mongoose.Schema.Types.ObjectId, ref: 'Post', required: true },
  comment: { type: mongoose.Schema.Types.ObjectId, ref: 'PostComment', default: null },
  reason: { type: String, enum: ['spam', 'scam', 'harassment', 'abuse', 'other'], required: true },
  status: { type: String, enum: ['pending', 'removed', 'dismissed'], default: 'pending' },
  resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });
schema.index({ reporter: 1, post: 1, comment: 1 }, { unique: true });
schema.index({ status: 1, _id: -1 });
module.exports = mongoose.model('PostReport', schema);
