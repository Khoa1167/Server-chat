const User = require('../models/User');
const Room = require('../models/Room');
const AppError = require('../utils/AppError');
const deviceKeysCache = require('../utils/deviceKeysCache');

// Lọc publicKey thiết bị active rồi cache lại — dùng chung cho các luồng lấy device key.
function formatAndCache(userDoc) {
  const devices = userDoc.devices
    .filter(d => !d.isRevoked)
  .map(d => ({ deviceId: d.deviceId, e2eeKeyId: d.e2eeKeyId || d.deviceId, publicKey: d.publicKey, registeredAt: d.registeredAt }));
  return deviceKeysCache.set(userDoc._id, devices);
}

async function getUserDevices(callerId, targetUserId) {
  // Chỉ cho xem publicKey/deviceId của user chung ít nhất 1 phòng — chặn enumerate metadata thiết bị.
  const sharesRoom = await Room.exists({ members: { $all: [callerId, targetUserId] } });
  if (!sharesRoom) {
    throw new AppError('Bạn không có phòng chung với người dùng này', 403);
  }

  const cached = await deviceKeysCache.get(targetUserId);
  if (cached?.every(d => d.registeredAt)) return cached;

  const targetUser = await User.findById(targetUserId).select('devices');
  if (!targetUser) {
    throw new AppError('Không tìm thấy người dùng', 404);
  }

  return formatAndCache(targetUser);
}

// Thành viên phòng luôn do server đọc để client state cũ không chặn phân phối Sender Key.
async function getRoomDevices(callerId, roomId) {
  const room = await Room.findOne({ _id: roomId, members: callerId }).select('members');
  if (!room) {
    throw new AppError('Bạn không có quyền truy cập phòng này', 403);
  }
  const userIds = room.members;

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

module.exports = { getUserDevices, getRoomDevices };
