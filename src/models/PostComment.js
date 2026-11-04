const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  post: { type: mongoose.Schema.Types.ObjectId, ref: 'Post', required: true },
  author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  clientId: { type: String, required: true },
  parent: { type: mongoose.Schema.Types.ObjectId, ref: 'PostComment', default: null },
  content: { type: String, required: true, maxlength: 3000 },
  deleted: { type: Boolean, default: false },
  editedAt: { type: Date, default: null },
}, { timestamps: true });
schema.index({ author: 1, clientId: 1 }, { unique: true });
schema.index({ post: 1, parent: 1, _id: -1 });
module.exports = mongoose.model('PostComment', schema);
