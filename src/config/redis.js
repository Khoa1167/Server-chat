// Client Redis dùng chung toàn server, chỉ khởi tạo khi có REDIS_URL — không set thì export null,
// các module gọi (vd rateLimiter.js) tự rơi về in-memory.
const Redis = require('ioredis');
const logger = require('./logger');

const redisUrl = process.env.REDIS_URL;
const redisClient = redisUrl ? new Redis(redisUrl) : null;

if (redisClient) {
  redisClient.on('error', (err) => logger.error({ err }, '[Redis] Lỗi kết nối'));
  redisClient.on('connect', () => logger.info(`🔴 Đã kết nối Redis: ${redisUrl}`));
}

module.exports = redisClient;
