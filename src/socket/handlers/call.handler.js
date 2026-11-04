const Friendship = require('../../models/Friendship');
const { checkRateWindow } = require('../../utils/rateLimiter');
const sendSocketError = require('../../utils/sendSocketError');
const { isBlocked } = require('../../services/blocks.service');
const { verifyActionToken } = require('../../services/aiPermission.service');

// Chặn spam/quấy rối cuộc gọi: tối đa 5 yêu cầu gọi / 30 giây, cộng dồn qua mọi socket/tab của
// cùng người gọi — phòng khi caller/receiver đã là bạn bè (qua check bên dưới) vẫn spam gọi liên tục.
const NS_CALL_REQUEST = 'call-request';
const NS_AI_CALL_TOKEN = 'ai-call-token';
const AI_CALL_ACTIONS = { audio: 'start_audio_call', video: 'start_video_call' };

// Cuộc gọi do trợ lý bắt đầu: token đúng người nhận, đúng loại gọi, quyền còn bật và chỉ dùng một lần.
async function isAiCallAllowed(userId, receiverId, type, token) {
  const action = AI_CALL_ACTIONS[type];
  if (!action) return false;
  const payload = await verifyActionToken(token, { userId, action, receiverId });
  if (!payload?.jti) return false;
  const used = await checkRateWindow(NS_AI_CALL_TOKEN, `${userId}:${payload.jti}`, { maxCount: 1, windowMs: 120000 });
  return !used.limited;
}

async function canSignal(userId, targetId) {
  if (!targetId || await isBlocked(userId, targetId)) return false;
  return Boolean(await Friendship.exists({
    status: 'accepted',
    $or: [
      { sender: userId, receiver: targetId },
      { sender: targetId, receiver: userId },
    ],
  }));
}

module.exports = function registerCallHandlers(io, socket) {
  const userId = socket.user._id;

  socket.on('call:request', async ({ receiverId, signalData, type, aiActionToken }) => {
    try {
      // Bảo mật: chỉ cho gọi giữa 2 người đã là bạn bè (accepted) — chặn user lạ spam
      // call:request tới bất kỳ receiverId nào để quấy rối/DoS giao diện nạn nhân.
      const uIdStr = userId.toString();
      if (!await canSignal(userId, receiverId)) {
        socket.emit('call:failed', { receiverId, reason: 'not_allowed' });
        return;
      }
      if (aiActionToken !== undefined && !await isAiCallAllowed(userId, receiverId, type, aiActionToken)) {
        socket.emit('call:failed', { receiverId, reason: 'ai_not_allowed' });
        return;
      }

      const callLimit = await checkRateWindow(NS_CALL_REQUEST, uIdStr, { maxCount: 5, windowMs: 30000 });
      if (callLimit.limited) {
        socket.emit('call:failed', { receiverId, reason: 'rate_limited' });
        return;
      }

      const allSockets = await io.fetchSockets();
      const receiverSockets = allSockets.filter(
        s => s.data.user?._id.toString() === receiverId
      );

      if (receiverSockets.length === 0) {
        socket.emit('call:failed', { receiverId, reason: 'offline' });
        return;
      }

      const callerInfo = {
        _id: socket.user._id,
        username: socket.user.username,
        nickname: socket.user.nickname,
        avatar: socket.user.avatar
      };

      receiverSockets.forEach(s => {
        s.emit('call:request', {
          caller: callerInfo,
          signalData,
          type
        });
      });
    } catch (err) {
      sendSocketError(socket, err);
    }
  });

  socket.on('call:accept', async ({ callerId, signalData }) => {
    try {
      if (!await canSignal(userId, callerId)) return;
      const allSockets = await io.fetchSockets();
      const callerSockets = allSockets.filter(
        s => s.data.user?._id.toString() === callerId
      );

      callerSockets.forEach(s => {
        s.emit('call:accept', {
          receiverId: socket.user._id,
          signalData
        });
      });
      allSockets
        .filter(s => s.id !== socket.id && s.data.user?._id.toString() === userId.toString())
        .forEach(s => s.emit('call:resolved', { callerId }));
    } catch (err) {
      sendSocketError(socket, err);
    }
  });

  socket.on('call:reject', async ({ callerId }) => {
    try {
      if (!await canSignal(userId, callerId)) return;
      const allSockets = await io.fetchSockets();
      const callerSockets = allSockets.filter(
        s => s.data.user?._id.toString() === callerId
      );

      callerSockets.forEach(s => {
        s.emit('call:reject', {
          receiverId: socket.user._id
        });
      });
      allSockets
        .filter(s => s.id !== socket.id && s.data.user?._id.toString() === userId.toString())
        .forEach(s => s.emit('call:resolved', { callerId }));
    } catch (err) {
      sendSocketError(socket, err);
    }
  });

  socket.on('call:ice-candidate', async ({ targetId, candidate }) => {
    try {
      if (!await canSignal(userId, targetId)) return;
      const allSockets = await io.fetchSockets();
      const targetSockets = allSockets.filter(
        s => s.data.user?._id.toString() === targetId
      );

      targetSockets.forEach(s => {
        s.emit('call:ice-candidate', {
          senderId: socket.user._id,
          candidate
        });
      });
    } catch (err) {
      sendSocketError(socket, err);
    }
  });

  socket.on('call:screen-share', async ({ targetId, sharing }) => {
    try {
      if (typeof sharing !== 'boolean' || !await canSignal(userId, targetId)) return;
      const allSockets = await io.fetchSockets();
      allSockets
        .filter(s => s.data.user?._id.toString() === targetId)
        .forEach(s => s.emit('call:screen-share', {
          senderId: socket.user._id,
          sharing,
        }));
    } catch (err) {
      sendSocketError(socket, err);
    }
  });

  socket.on('call:end', async ({ targetId }) => {
    try {
      if (!await canSignal(userId, targetId)) return;
      const allSockets = await io.fetchSockets();
      const targetSockets = allSockets.filter(
        s => s.data.user?._id.toString() === targetId
      );

      targetSockets.forEach(s => {
        s.emit('call:end', {
          senderId: socket.user._id
        });
      });
    } catch (err) {
      sendSocketError(socket, err);
    }
  });
};
