const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  credentialId: { type: String, required: true, unique: true },
  publicKey: { type: Buffer, required: true },
  counter: { type: Number, default: 0 },
  transports: { type: [String], default: [] },
  aaguid: { type: String, default: '' },
  name: { type: String, default: 'Passkey', maxlength: 50 },
  lastUsedAt: { type: Date, default: null },
}, { timestamps: true });

module.exports = mongoose.model('PasskeyCredential', schema);
