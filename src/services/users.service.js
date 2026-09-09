const User = require('../models/User');
const Room = require('../models/Room');
const AppError = require('../utils/AppError');
const deviceKeysCache = require('../utils/deviceKeysCache');

// Lọc publicKey thiết bị active rồi cache lại — dùng chung cho getUserDevices và getUsersDevicesBatch.
function formatAndCache(userDoc) {
  const devices = userDoc.devices
    .filter(d => !d.isRevoked)
  .map(d => ({ deviceId: d.deviceId, e2eeKeyId: d.e2eeKeyId || d.deviceId, publicKey: d.publicKey }));
  return deviceKeysCache.set(userDoc._id, devices);
}

async function getUserDevices(callerId, targetUserId) {
  // Chỉ cho xem publicKey/deviceId của user chung ít nhất 1 phòng — chặn enumerate metadata thiết bị.
  const sharesRoom = await Room.exists({ members: { $all: [callerId, targetUserId] } });
  if (!sharesRoom) {
    throw new AppError('Bạn không có phòng chung với người dùng này', 403);
  }

  const cached = await deviceKeysCache.get(targetUserId);
  if (cached) return cached;

  const targetUser = await User.findById(targetUserId).select('devices');
  if (!targetUser) {
    throw new AppError('Không tìm thấy người dùng', 404);
  }

  return formatAndCache(targetUser);
}

// Thay cho việc gọi getUserDevices lặp lại theo từng thành viên phòng (N+1 request).
async function getUsersDevicesBatch(callerId, userIds) {
  // Yêu cầu có 1 phòng chứa đủ caller lẫn toàn bộ userIds — chặn enumerate publicKey user không chung phòng.
  const sharesRoom = await Room.exists({ members: { $all: [callerId, ...userIds] } });
  if (!sharesRoom) {
    throw new AppError('Bạn không có phòng chung với các người dùng này', 403);
  }

  // Cache theo từng user (tận dụng lại giữa các phòng chung thành viên) — chỉ cache-miss mới cần 1 query $in gộp.
  const cacheResults = await Promise.all(
    userIds.map(async id => [id.toString(), await deviceKeysCache.get(id)])
  );
  const missedIds = cacheResults.filter(([, cached]) => !cached).map(([id]) => id);

  const freshByUserId = new Map();
  if (missedIds.length > 0) {
    const users = await User.find({ _id: { $in: missedIds } }).select('devices');
    await Promise.all(users.map(async u => freshByUserId.set(u._id.toString(), await formatAndCache(u))));
  }

  return cacheResults.flatMap(([id, cached]) => cached || freshByUserId.get(id) || []);
}

module.exports = { getUserDevices, getUsersDevicesBatch };
