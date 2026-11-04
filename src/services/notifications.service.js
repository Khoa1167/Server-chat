const Notification = require('../models/Notification');
const userFields = require('../utils/publicUserFields');

// Tạo + đẩy real-time cho đúng user đó (mọi tab/thiết bị đang mở) — dùng chung cho mọi loại thông
// báo rời rạc (lời mời kết bạn, thêm/kick khỏi nhóm...). Gọi tại nơi phát sinh sự kiện gốc, không
// suy luận lại từ nơi khác.
async function createNotification(io, { user, type, fromUser, room, post, comment }) {
  const notif = await Notification.create({ user, type, fromUser, room, post, comment });

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
  const rows = await Notification.find({ user: userId })
    .sort({ createdAt: -1 })
    .limit(50)
    .populate('fromUser', userFields.BASIC)
    .populate('room', 'name isDM')
    .lean();
  if (!rows.some(n => n.post)) return rows;
  const access = require('./postAccess.service');
  const ctx = await access.context(userId);
  const visible = await Promise.all(rows.map(async n => {
    if (!n.post) return true;
    if (ctx.blocked.has(String(n.fromUser?._id))) return false;
    try { await access.requirePost(String(n.post), ctx); return true; }
    catch (err) { if (err.statusCode === 404) return false; throw err; }
  }));
  return rows.filter((n, index) => visible[index]);
}

async function markAllRead(userId) {
  await Notification.updateMany({ user: userId, isRead: false }, { isRead: true });
}

module.exports = { createNotification, listNotifications, markAllRead };
