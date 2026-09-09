const User = require('../../models/User');
const logger = require('../../config/logger');
const { getFriendIdSet } = require('../../utils/presenceVisibility');
const presenceStore = require('../../utils/presenceStore');

// Chờ 1 khoảng trước khi ghi Mongo/broadcast offline thật — tránh ghi liên tục khi socket
// disconnect/reconnect ngắn hạn (chuyển trang khiến SocketProvider unmount/remount, mạng chập
// chờn). Hủy hẹn giờ này nếu user reconnect trong lúc chờ.
const OFFLINE_GRACE_MS = 8000;
// userId(string) -> Timeout, sống trong RAM process — single-instance-only, giống io.fetchSockets()
// trong file này (chưa gắn @socket.io/redis-adapter, xem presenceStore.js).
const pendingOfflineTimers = new Map();

// Chỉ báo online/offline cho người được phép thấy theo privacySettings.activityStatus của chính userId.
async function broadcastPresence(io, userId, event, payload) {
  const user = await User.findById(userId).select('privacySettings.activityStatus');
  if (user?.privacySettings?.activityStatus === 'private') return;

  const friendIdSet = await getFriendIdSet(userId);
  if (friendIdSet.size === 0) return;

  const allSockets = await io.fetchSockets();
  allSockets
    .filter(s => s.data.user && friendIdSet.has(s.data.user._id.toString()))
    .forEach(s => s.emit(event, payload));
}

module.exports = async function registerPresenceHandlers(io, socket) {
  const userId = socket.user._id;
  const userKey = userId.toString();

  // Reconnect trong lúc đang chờ xác nhận offline (grace period) → hủy, không có gì để ghi vì
  // Mongo/presenceStore vẫn đang coi user là online.
  clearTimeout(pendingOfflineTimers.get(userKey));
  pendingOfflineTimers.delete(userKey);

  if (!(await presenceStore.isOnline(userId))) {
    await User.findByIdAndUpdate(userId, { isOnline: true });
    await presenceStore.markOnline(userId);
    await broadcastPresence(io, userId, 'user:online', { userId });
  }

  socket.on('disconnect', async () => {
    try {
      const activeSockets = await io.fetchSockets();
      const hasOtherConnections = activeSockets.some(
        s => s.data.user?._id.toString() === userKey
      );

      if (hasOtherConnections) {
        logger.debug(`🟡 ${socket.user.username} disconnected one of their connections`);
        return;
      }

      const timer = setTimeout(async () => {
        pendingOfflineTimers.delete(userKey);
        try {
          const stillActive = (await io.fetchSockets()).some(
            s => s.data.user?._id.toString() === userKey
          );
          if (stillActive) return;

          await User.findByIdAndUpdate(userId, { isOnline: false, lastSeen: new Date() });
          await presenceStore.markOffline(userId);
          await broadcastPresence(io, userId, 'user:offline', { userId });
          logger.info({ userId, username: socket.user.username }, `🔴 ${socket.user.username} disconnected`);
        } catch (err) {
          logger.error({ err, userId }, 'Lỗi khi xác nhận offline sau grace period');
        }
      }, OFFLINE_GRACE_MS).unref();
      pendingOfflineTimers.set(userKey, timer);
    } catch (err) {
      // Socket đã ngắt kết nối lúc này — không còn cách nào emit lỗi lại cho client, chỉ log.
      logger.error({ err, userId }, 'Lỗi khi xử lý disconnect');
    }
  });
};
