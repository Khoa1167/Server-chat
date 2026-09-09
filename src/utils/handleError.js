const AppError = require('./AppError');
const sendServerError = require('./sendServerError');

// Controller gọi trong catch — AppError (throw từ Service) trả đúng status/message dự kiến,
// lỗi khác rơi về sendServerError như quy ước 500 hiện có (không lộ chi tiết nội bộ khi production).
module.exports = function handleError(res, err) {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({ message: err.message, ...err.extra });
  }
  sendServerError(res, err);
};
