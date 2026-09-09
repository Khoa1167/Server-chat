const logger = require('../config/logger');

// Trả lỗi 500 cho client mà không lộ chi tiết lỗi nội bộ (message DB, đường dẫn file...) khi production.
// Luôn log đầy đủ lỗi ở server để debug; ở dev vẫn trả err.message cho tiện làm việc.
module.exports = function sendServerError(res, err, fallback = 'Đã xảy ra lỗi hệ thống, vui lòng thử lại sau') {
  // res.req.log (gắn bởi pino-http) mang theo req.id — tra được đúng request nào gây lỗi này
  // giữa hàng ngàn dòng log khác. Rơi về logger gốc nếu vì lý do gì đó không có (không nên xảy ra).
  const log = res.req?.log || logger;
  log.error({ err }, err.message);
  const message = process.env.NODE_ENV === 'production' ? fallback : err.message;
  res.status(500).json({ message });
};
