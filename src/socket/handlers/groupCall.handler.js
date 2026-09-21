const mongoose = require('mongoose');
const Room = require('../../models/Room');
const sfu = require('../../services/sfu.service');
const { checkRateWindow } = require('../../utils/rateLimiter');
const sendSocketError = require('../../utils/sendSocketError');
const { isBoundedObject, isNonEmptyString, isValidMediaKind } = require('../../validators/groupCall.validator');

// Chặn spam join/leave gây tạo/hủy Transport liên tục — tốn tài nguyên mediasoup Worker hơn hẳn
// relay tin nhắn thường (mỗi participant giữ 1 tiến trình con xử lý media).
const NS_GROUP_CALL_JOIN = 'group-call-join';

// Thành viên phòng đã join call này qua chính socket hiện tại — dọn đúng phần khi disconnect,
// không cần quét toàn bộ sfu.service khi 1 socket chỉ thường ở trong đúng 1 cuộc gọi tại 1 thời điểm.
function isValidRoomId(roomId) {
  return typeof roomId === 'string' && mongoose.Types.ObjectId.isValid(roomId);
}

// Chỉ cho gọi nhóm ở phòng nhóm (không phải DM) mà user đang là thành viên — check tươi từ DB,
// không tin socket.join() cũ (dùng cho broadcast tin nhắn, không phải bằng chứng quyền gọi call).
async function canJoinGroupCall(userId, roomId) {
  const room = await Room.findOne({ _id: roomId, members: userId, isDM: false }).select('_id');
  return Boolean(room);
}

module.exports = function registerGroupCallHandlers(io, socket) {
  const userId = socket.user._id;
  const joinedRoomIds = new Set();

  socket.on('call:group-join', async (payload, ack) => {
    try {
      const { roomId } = payload || {};
      if (!isValidRoomId(roomId)) return;

      const limit = await checkRateWindow(NS_GROUP_CALL_JOIN, userId.toString(), { maxCount: 10, windowMs: 30000 });
      if (limit.limited) return ack?.({ error: 'rate_limited' });

      if (!await canJoinGroupCall(userId, roomId)) return ack?.({ error: 'not_allowed' });

      const username = socket.user.nickname || socket.user.username;
      const { rtpCapabilities } = await sfu.joinRoom(roomId, socket.id, userId.toString(), username);
      joinedRoomIds.add(roomId);

      const otherProducers = sfu.listOtherProducers(roomId, socket.id);
      ack?.({ rtpCapabilities, otherProducers });

      // Người đầu tiên vào phòng — báo cho cả phòng (kể cả ai chưa join call) để hiện banner
      // "đang có cuộc gọi". Các lượt join sau không cần báo lại, phòng đã active từ trước.
      if (sfu.getParticipantCount(roomId) === 1) {
        socket.to(roomId).emit('call:group-active', { roomId });
      }
      socket.to(roomId).emit('call:group-peer-joined', {
        userId, username: socket.user.nickname || socket.user.username,
      });
    } catch (err) {
      if (err.code === 'ROOM_FULL') return ack?.({ error: 'room_full' });
      sendSocketError(socket, err);
    }
  });

  socket.on('call:group-create-transport', async (payload, ack) => {
    try {
      const { roomId } = payload || {};
      if (!isValidRoomId(roomId) || !joinedRoomIds.has(roomId)) return;

      const params = await sfu.createWebRtcTransport(roomId, socket.id, {
        announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP,
      });
      ack?.(params);
    } catch (err) {
      sendSocketError(socket, err);
    }
  });

  socket.on('call:group-connect-transport', async (payload, ack) => {
    try {
      const { roomId, transportId, dtlsParameters } = payload || {};
      if (!isValidRoomId(roomId) || !joinedRoomIds.has(roomId)) return;
      if (!isNonEmptyString(transportId) || !isBoundedObject(dtlsParameters)) return;

      await sfu.connectTransport(roomId, socket.id, transportId, dtlsParameters);
      ack?.({ ok: true });
    } catch (err) {
      sendSocketError(socket, err);
    }
  });

  socket.on('call:group-produce', async (payload, ack) => {
    try {
      const { roomId, transportId, kind, rtpParameters } = payload || {};
      if (!isValidRoomId(roomId) || !joinedRoomIds.has(roomId)) return;
      if (!isNonEmptyString(transportId) || !isValidMediaKind(kind) || !isBoundedObject(rtpParameters)) return;

      const producerId = await sfu.produce(roomId, socket.id, transportId, kind, rtpParameters);
      ack?.({ id: producerId });

      socket.to(roomId).emit('call:group-new-producer', { producerId, kind, userId });
    } catch (err) {
      sendSocketError(socket, err);
    }
  });

  socket.on('call:group-consume', async (payload, ack) => {
    try {
      const { roomId, transportId, producerId, rtpCapabilities } = payload || {};
      if (!isValidRoomId(roomId) || !joinedRoomIds.has(roomId)) return;
      if (!isNonEmptyString(transportId) || !isNonEmptyString(producerId) || !isBoundedObject(rtpCapabilities)) return;

      const params = await sfu.consume(roomId, socket.id, transportId, producerId, rtpCapabilities);
      ack?.(params);
    } catch (err) {
      sendSocketError(socket, err);
    }
  });

  socket.on('call:group-resume-consumer', async (payload, ack) => {
    try {
      const { roomId, consumerId } = payload || {};
      if (!isValidRoomId(roomId) || !joinedRoomIds.has(roomId) || !isNonEmptyString(consumerId)) return;

      await sfu.resumeConsumer(roomId, socket.id, consumerId);
      ack?.({ ok: true });
    } catch (err) {
      sendSocketError(socket, err);
    }
  });

  socket.on('call:group-screen-share', async (payload) => {
    try {
      const { roomId, sharing } = payload || {};
      if (!isValidRoomId(roomId) || !joinedRoomIds.has(roomId) || typeof sharing !== 'boolean') return;

      if (sharing) {
        sfu.startScreenShare(roomId, socket.id);
      } else {
        sfu.stopScreenShare(roomId, socket.id);
      }
      socket.to(roomId).emit('call:group-screen-share', { userId, sharing });
    } catch (err) {
      if (err.code === 'SCREEN_SHARE_BUSY') return socket.emit('call:group-failed', { reason: 'screen_share_busy' });
      sendSocketError(socket, err);
    }
  });

  function notifyLeave(roomId) {
    sfu.leaveRoom(roomId, socket.id);
    socket.to(roomId).emit('call:group-peer-left', { userId });
    if (sfu.getParticipantCount(roomId) === 0) {
      socket.to(roomId).emit('call:group-ended', { roomId });
    }
  }

  function leaveAllGroupCalls() {
    joinedRoomIds.forEach(notifyLeave);
    joinedRoomIds.clear();
  }

  socket.on('call:group-leave', (payload) => {
    const { roomId } = payload || {};
    if (!isValidRoomId(roomId) || !joinedRoomIds.has(roomId)) return;
    notifyLeave(roomId);
    joinedRoomIds.delete(roomId);
  });

  socket.on('disconnect', leaveAllGroupCalls);
};
