const mongoose = require('mongoose');

// Server chỉ giữ bản mã do client tạo; không có recovery key hoặc private key ở đây.
const historyBackupSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  version: { type: Number, required: true, default: 1 },
  ciphertext: { type: String, required: true, maxlength: 7 * 1024 * 1024 },
  iv: { type: String, required: true, maxlength: 64 },
  sourceDeviceId: { type: String, required: true, maxlength: 128 },
  sourceE2eeKeyId: { type: String, required: true, maxlength: 128 },
}, { timestamps: true });

module.exports = mongoose.model('HistoryBackup', historyBackupSchema);
