// Logger cấu trúc (JSON) dùng chung toàn server — thay console.log/error rải rác, có level lọc
// được, redact tự động các field nhạy cảm nếu ai đó lỡ log nguyên req.body/user object.
const pino = require('pino');

const isProduction = process.env.NODE_ENV === 'production';

const logger = pino({
  level: process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug'),
  redact: {
    paths: [
      'password', 'newPassword', 'currentPassword', 'hashedPassword',
      'otp', 'token', 'turnstileToken', 'resetToken', 'accessToken',
      'req.body.password', 'req.body.newPassword', 'req.body.currentPassword', 'req.body.otp',
      'req.body.token', 'req.body.turnstileToken', 'req.body.resetToken',
      'req.headers.authorization', 'req.headers.cookie',
      '*.password', '*.hashedPassword', '*.otp', '*.token',
    ],
    censor: '[REDACTED]',
  },
  transport: isProduction ? undefined : {
    target: 'pino-pretty',
    options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
  },
});

module.exports = logger;
