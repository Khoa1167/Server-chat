const mongoose = require('mongoose');

// Zero-Knowledge Relay: server chỉ lưu/relay bản mã Sender Key, không bao giờ thấy khóa gốc. 1 doc/thiết bị gửi/epoch.
const senderKeyDistributionSchema = new mongoose.Schema({
  room:           { type: mongoose.Schema.Types.ObjectId, ref: 'Room', required: true },
  epoch:          { type: Number, required: true },
  senderUser:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  senderDeviceId: { type: String, required: true },
  encryptedKeys:  { type: Map, of: String, default: {} }, // Map: recipientDeviceId -> RSA-wrapped Sender Key (base64)
}, { timestamps: true });

senderKeyDistributionSchema.index({ room: 1, epoch: 1, senderDeviceId: 1 }, { unique: true });

module.exports = mongoose.model('SenderKeyDistribution', senderKeyDistributionSchema);
