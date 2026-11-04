const mongoose = require('mongoose');

// Chỉ các sự kiện rời rạc (không tự suy ra được từ state khác) mới cần lưu ở đây — tin nhắn
// chưa đọc KHÔNG nằm trong bảng này, đã có sẵn Room.lastReadAt + rooms.service.js#listMyRooms.
const notificationSchema = new mongoose.Schema({
  user:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type:       { type: String, enum: ['friend_request', 'friend_accepted', 'group_added', 'group_kicked', 'post_reacted', 'post_commented', 'post_replied', 'post_shared'], required: true },
  fromUser:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  room:       { type: mongoose.Schema.Types.ObjectId, ref: 'Room' },
  post:       { type: mongoose.Schema.Types.ObjectId, ref: 'Post' },
  comment:    { type: mongoose.Schema.Types.ObjectId, ref: 'PostComment' },
  isRead:     { type: Boolean, default: false },
}, { timestamps: true });

notificationSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);
