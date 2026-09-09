const Notification = require('../models/Notification');
const userFields = require('../utils/publicUserFields');

// Tạo + đẩy real-time cho đúng user đó (mọi tab/thiết bị đang mở) — dùng chung cho mọi loại thông
// báo rời rạc (lời mời kết bạn, thêm/kick khỏi nhóm...). Gọi tại nơi phát sinh sự kiện gốc, không
// suy luận lại từ nơi khác.
async function createNotification(io, { user, type, fromUser, room }) {
  const notif = await Notification.create({ user, type, fromUser, room });

  if (io) {
    await notif.populate('fromUser', userFields.BASIC);
    if (room) await notif.populate('room', 'name isDM');
    const allSockets = await io.fetchSockets();
    allSockets
      .filter(s => s.data.user && s.data.user._id.toString() === user.toString())
      .forEach(s => s.emit('notification:new', notif));
  }

  return notif;
}

async function listNotifications(userId) {
  return Notification.find({ user: userId })
    .sort({ createdAt: -1 })
    .limit(50)
    .populate('fromUser', userFields.BASIC)
    .populate('room', 'name isDM')
    .lean();
}

async function markAllRead(userId) {
  await Notification.updateMany({ user: userId, isRead: false }, { isRead: true });
}

module.exports = { createNotification, listNotifications, markAllRead };
