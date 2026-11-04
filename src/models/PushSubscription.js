const mongoose = require('mongoose');

// Token FCM thay đổi độc lập với session/E2EE key, nên tách khỏi User.devices để không lộ token
// qua API quản lý thiết bị và để một token chỉ thuộc về một phiên thiết bị tại một thời điểm.
const pushSubscriptionSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  deviceId: { type: String, required: true },
  token: { type: String, required: true, unique: true, select: false },
}, { timestamps: true });

pushSubscriptionSchema.index({ user: 1, deviceId: 1 }, { unique: true });

module.exports = mongoose.model('PushSubscription', pushSubscriptionSchema);
