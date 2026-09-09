const Room = require('../../models/Room');
const logger = require('../../config/logger');

module.exports = function registerRoomHandlers(io, socket) {
  const userId = socket.user._id;

  socket.on('room:join', async (roomId) => {
    try {
      // Bảo mật: chặn subscribe vào broadcast realtime của phòng không phải thành viên
      // (rò rỉ room:updated/member_joined/settings_updated... cho người ngoài nếu không check)
      const room = await Room.findOne({ _id: roomId, members: userId }).select('_id');
      if (!room) return;

      socket.join(roomId);
      socket.to(roomId).emit('room:user_joined', {
        userId, username: socket.user.nickname || socket.user.username,
      });
    } catch (err) {
      logger.error({ err, userId, roomId }, 'Lỗi room:join');
    }
  });
};
