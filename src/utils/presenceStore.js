// Cờ "user có socket đang kết nối" — presence.handler.js chỉ ghi Mongo khi cờ đổi trạng thái, không
// phải mỗi lần connect/disconnect. Có REDIS_URL → lưu Redis; không thì rơi về Set in-memory (chỉ
// đúng 1 instance, giống rateLimiter.js).
const redis = require('../config/redis');

const memorySet = new Set();
const key = (userId) => `presence:${userId}`;

async function isOnline(userId) {
  if (redis && redis.status === 'ready') return (await redis.exists(key(userId))) === 1;
  return memorySet.has(userId.toString());
}

async function markOnline(userId) {
  if (redis && redis.status === 'ready') return void await redis.set(key(userId), '1');
  memorySet.add(userId.toString());
}

async function markOffline(userId) {
  if (redis && redis.status === 'ready') return void await redis.del(key(userId));
  memorySet.delete(userId.toString());
}

module.exports = { isOnline, markOnline, markOffline };
