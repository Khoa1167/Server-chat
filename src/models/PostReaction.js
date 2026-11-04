const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  post: { type: mongoose.Schema.Types.ObjectId, ref: 'Post', required: true },
  comment: { type: mongoose.Schema.Types.ObjectId, ref: 'PostComment', default: null },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  kind: { type: String, enum: ['like', 'love', 'care', 'haha', 'wow', 'sad', 'angry'], required: true },
}, { timestamps: true });
schema.index({ post: 1, comment: 1, user: 1 }, { unique: true });
schema.index({ user: 1 });
module.exports = mongoose.model('PostReaction', schema);
