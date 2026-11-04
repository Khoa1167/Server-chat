const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  clientId: { type: String, required: true },
  content: { type: String, default: '', maxlength: 10000 },
  audience: { type: String, enum: ['public', 'friends', 'private'], required: true },
  media: [{ type: mongoose.Schema.Types.ObjectId, ref: 'PostMedia' }],
  original: { type: mongoose.Schema.Types.ObjectId, ref: 'Post', default: null },
  status: { type: String, enum: ['publishing', 'active', 'deleted'], default: 'publishing' },
  editedAt: { type: Date, default: null },
  cleanedAt: { type: Date, default: null },
  editLease: { type: Date, default: null },
  lastEditId: { type: String, default: null },
}, { timestamps: true });
schema.index({ author: 1, clientId: 1 }, { unique: true });
schema.index({ author: 1, status: 1, _id: -1 });
schema.index({ audience: 1, status: 1, _id: -1 });
schema.index({ original: 1, status: 1 });
schema.index({ content: 'text' }, { default_language: 'none' });
module.exports = mongoose.model('Post', schema);
