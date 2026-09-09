const logger = require('../config/logger');

// Phiên bản socket của sendServerError.js — emit lỗi cho client mà không lộ chi tiết lỗi nội bộ
// (message DB, stack trace...) khi production. Luôn log đầy đủ lỗi ở server để debug.
module.exports = function sendSocketError(socket, err, fallback = 'Đã xảy ra lỗi hệ thống, vui lòng thử lại sau') {
  // Gắn socketId/userId — socket không có req.id như HTTP, đây là cách duy nhất để sau này tra
  // ngược lỗi này thuộc về phiên kết nối/người dùng nào giữa nhiều connection đồng thời.
  logger.error({ err, socketId: socket.id, userId: socket.data?.user?._id }, err.message);
  const message = process.env.NODE_ENV === 'production' ? fallback : err.message;
  socket.emit('error', { message });
};
