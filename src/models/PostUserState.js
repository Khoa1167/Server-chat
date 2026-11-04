const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  post: { type: mongoose.Schema.Types.ObjectId, ref: 'Post', required: true },
  saved: { type: Boolean, default: false },
  hidden: { type: Boolean, default: false },
}, { timestamps: true });
schema.index({ user: 1, post: 1 }, { unique: true });
schema.index({ user: 1, saved: 1, post: -1 });
module.exports = mongoose.model('PostUserState', schema);
