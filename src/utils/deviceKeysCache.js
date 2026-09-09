// Cache publicKey thiết bị active của 1 user (client gọi lại mỗi tin DM, tốn 1 query Mongo/lần dù
// key ít đổi). TTL 5 phút + invalidate() chủ động khi devices đổi thật. Redis khi có, Map RAM khi
// không (chỉ đúng 1 instance) — giống mẫu rateLimiter.js.
const redis = require('../config/redis');

const TTL_SECONDS = 300;
const memoryCache = new Map(); // userId(string) -> { devices, expiresAt }
const key = (userId) => `user:${userId}:device_keys`;

async function get(userId) {
  if (redis && redis.status === 'ready') {
    const cached = await redis.get(key(userId));
    return cached ? JSON.parse(cached) : null;
  }
  const entry = memoryCache.get(userId.toString());
  if (!entry || entry.expiresAt < Date.now()) return null;
  return entry.devices;
}

async function set(userId, devices) {
  if (redis && redis.status === 'ready') {
    await redis.set(key(userId), JSON.stringify(devices), 'EX', TTL_SECONDS);
    return devices;
  }
  memoryCache.set(userId.toString(), { devices, expiresAt: Date.now() + TTL_SECONDS * 1000 });
  return devices;
}

async function invalidate(userId) {
  if (redis && redis.status === 'ready') {
    await redis.del(key(userId));
    return;
  }
  memoryCache.delete(userId.toString());
}

module.exports = { get, set, invalidate };
