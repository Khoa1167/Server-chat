// Cache kết quả THÔ (trước mask presence) của listMyRooms() — chỉ cache phần query, presence vẫn
// mask live mỗi request vì đổi liên tục. TTL + invalidate() chủ động qua Room model hooks. Redis
// khi có, Map RAM khi không (chỉ đúng 1 instance) — giống mẫu deviceKeysCache.js.
const redis = require('../config/redis');

const TTL_SECONDS = 300;
const memoryCache = new Map(); // userId(string) -> { rooms, expiresAt }
const key = (userId) => `user:${userId}:rooms_raw`;

async function get(userId) {
  if (redis && redis.status === 'ready') {
    const cached = await redis.get(key(userId));
    return cached ? JSON.parse(cached) : null;
  }
  const entry = memoryCache.get(userId.toString());
  if (!entry || entry.expiresAt < Date.now()) return null;
  return entry.rooms;
}

async function set(userId, rooms) {
  if (redis && redis.status === 'ready') {
    await redis.set(key(userId), JSON.stringify(rooms), 'EX', TTL_SECONDS);
    return rooms;
  }
  memoryCache.set(userId.toString(), { rooms, expiresAt: Date.now() + TTL_SECONDS * 1000 });
  return rooms;
}

async function invalidate(userId) {
  if (redis && redis.status === 'ready') {
    await redis.del(key(userId));
    return;
  }
  memoryCache.delete(userId.toString());
}

module.exports = { get, set, invalidate };
