const Friendship = require('../../models/Friendship');
const { checkRateWindow } = require('../../utils/rateLimiter');
const sendSocketError = require('../../utils/sendSocketError');

// Chặn spam/quấy rối cuộc gọi: tối đa 5 yêu cầu gọi / 30 giây, cộng dồn qua mọi socket/tab của
// cùng người gọi — phòng khi caller/receiver đã là bạn bè (qua check bên dưới) vẫn spam gọi liên tục.
const NS_CALL_REQUEST = 'call-request';

module.exports = function registerCallHandlers(io, socket) {
  const userId = socket.user._id;

  socket.on('call:request', async ({ receiverId, signalData, type }) => {
    try {
      // Bảo mật: chỉ cho gọi giữa 2 người đã là bạn bè (accepted) — chặn user lạ spam
      // call:request tới bất kỳ receiverId nào để quấy rối/DoS giao diện nạn nhân.
      const uIdStr = userId.toString();
      const areFriends = await Friendship.exists({
        status: 'accepted',
        $or: [
          { sender: uIdStr, receiver: receiverId },
          { sender: receiverId, receiver: uIdStr },
        ],
      });
      if (!areFriends) {
        socket.emit('call:failed', { receiverId, reason: 'not_allowed' });
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
    } catch (err) {
      sendSocketError(socket, err);
    }
  });

  socket.on('call:reject', async ({ callerId }) => {
    try {
      const allSockets = await io.fetchSockets();
      const callerSockets = allSockets.filter(
        s => s.data.user?._id.toString() === callerId
      );

      callerSockets.forEach(s => {
        s.emit('call:reject', {
          receiverId: socket.user._id
        });
      });
    } catch (err) {
      sendSocketError(socket, err);
    }
  });

  socket.on('call:ice-candidate', async ({ targetId, candidate }) => {
    try {
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

  socket.on('call:end', async ({ targetId }) => {
    try {
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
