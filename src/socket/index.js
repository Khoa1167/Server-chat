const cookie = require('cookie');
const User = require('../models/User');
const Room = require('../models/Room');
const { hashDeviceToken } = require('../utils/auth/deviceToken');
const logger = require('../config/logger');

const registerMessageHandlers = require('./handlers/message.handler');
const registerRoomHandlers = require('./handlers/room.handler');
const registerCallHandlers = require('./handlers/call.handler');
const registerGroupCallHandlers = require('./handlers/groupCall.handler');
const registerPresenceHandlers = require('./handlers/presence.handler');

const setupSocket = (io) => {
  io.use(async (socket, next) => {
    try {
      const cookies = cookie.parse(socket.handshake.headers.cookie || '');
      const token = cookies.token;
      if (!token) return next(new Error('Authentication error'));
      // Chỉ chấp nhận Device Token (opaque, đã đăng ký thiết bị) — bootstrap token (chưa đăng ký
      // thiết bị, chưa có E2EE key) vốn không dùng được phòng chat mã hóa nên không cần hỗ trợ ở đây.
      const tokenHash = hashDeviceToken(token);
      socket.user = await User.findOne({
        devices: { $elemMatch: { tokenHash, isRevoked: false } },
      }).select('-password');
      if (!socket.user) return next(new Error('User not found'));
      if (socket.user.isBanned) return next(new Error('Account banned'));
      if (socket.user.isDeleted || socket.user.pendingDeletionAt) return next(new Error('Account deleted'));
      socket.data.user = socket.user;
      socket.data.deviceId = socket.user.devices.find(device =>
        device.tokenHash === tokenHash && !device.isRevoked
      )?.deviceId;
      next();
    } catch {
      next(new Error('Authentication error'));
    }
  });

  io.on('connection', async (socket) => {
    const userId = socket.user._id;
    logger.info({ userId, username: socket.user.username }, `🟢 ${socket.user.username} connected`);

    // Lỗi tầng transport của riêng socket này — EventEmitter throw nếu 'error' không có listener, sập cả server.
    socket.on('error', (err) => {
      logger.error({ err, userId }, `Socket error từ ${socket.user.username}`);
    });

    // presence.handler tự đánh dấu online + broadcast trước khi đăng ký disconnect — giữ đúng
    // thứ tự gốc (online trước, join room sau) dù giờ tách file.
    await registerPresenceHandlers(io, socket);

    // Join tất cả room của user — mọi handler bên dưới (message, room...) đều cần socket đã
    // join sẵn để io.to(roomId).emit(...) tới được đúng người.
    const rooms = await Room.find({ members: userId });
    rooms.forEach(r => {
      socket.join(r._id.toString());
      logger.debug(`🟢 ${socket.user.username} joined socket room: ${r._id}`);
    });

    registerMessageHandlers(io, socket);
    registerRoomHandlers(io, socket);
    registerCallHandlers(io, socket);
    registerGroupCallHandlers(io, socket);
  });
};

module.exports = setupSocket;
