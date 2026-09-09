// Rate-limit dùng chung ("sai N lần→khóa X phút" / "N request/cửa sổ") thay code viết tay lặp
// lại ở nhiều route. Có REDIS_URL và đang ready → lưu Redis (đúng khi nhiều instance); không thì
// rơi về Map RAM (chỉ đúng 1 instance). Namespace tách bộ đếm giữa các route dùng chung store.

const redis = require('../config/redis');

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_LOCK_MINUTES = 15;

const lockRedisKey = (ns, key) => `rl:lock:${ns}:${key}`;
const countRedisKey = (ns, key) => `rl:count:${ns}:${key}`;
const windowRedisKey = (ns, key) => `rw:${ns}:${key}`;

// Fallback in-memory — 1 Map dùng chung, phân biệt bằng key ghép `namespace:key`.
const memoryStore = new Map();

// Sweep định kỳ dọn entry hết hạn — Map không tự có TTL như Redis, tránh leak.
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [k, entry] of memoryStore) {
    const expiresAt = Math.max(entry.lockUntil || 0, entry.expiresAt || 0, entry.resetTime || 0);
    if (now > expiresAt) memoryStore.delete(k);
  }
}, SWEEP_INTERVAL_MS).unref();

// Kiểm tra key có đang bị khóa không — gọi trước khi xác thực.
async function checkLock(namespace, key) {
  if (redis && redis.status === 'ready') {
    const ttl = await redis.pttl(lockRedisKey(namespace, key));
    if (ttl > 0) return { locked: true, waitMinutes: Math.ceil(ttl / 60000) };
    return { locked: false };
  }

  const entry = memoryStore.get(`${namespace}:${key}`);
  if (!entry) return { locked: false };
  const now = Date.now();
  if (now < entry.lockUntil) {
    return { locked: true, waitMinutes: Math.ceil((entry.lockUntil - now) / 60000) };
  }
  return { locked: false };
}

// Ghi nhận 1 lần xác thực sai, tự khóa nếu chạm ngưỡng — gọi khi xác thực thất bại.
async function recordFailure(namespace, key, { maxAttempts = DEFAULT_MAX_ATTEMPTS, lockMinutes = DEFAULT_LOCK_MINUTES } = {}) {
  if (redis && redis.status === 'ready') {
    const count = await redis.incr(countRedisKey(namespace, key));
    if (count === 1) await redis.pexpire(countRedisKey(namespace, key), lockMinutes * 60 * 1000);
    if (count >= maxAttempts) {
      await redis.set(lockRedisKey(namespace, key), '1', 'PX', lockMinutes * 60 * 1000);
      await redis.del(countRedisKey(namespace, key));
    }
    return;
  }

  const mapKey = `${namespace}:${key}`;
  const entry = memoryStore.get(mapKey) || { count: 0, lockUntil: 0, expiresAt: 0 };
  entry.count += 1;
  entry.expiresAt = Date.now() + lockMinutes * 60 * 1000;
  if (entry.count >= maxAttempts) {
    entry.lockUntil = Date.now() + lockMinutes * 60 * 1000;
    entry.count = 0;
  }
  memoryStore.set(mapKey, entry);
}

// Xóa bộ đếm khi xác thực thành công.
async function clearFailures(namespace, key) {
  if (redis && redis.status === 'ready') {
    await redis.del(countRedisKey(namespace, key), lockRedisKey(namespace, key));
    return;
  }
  memoryStore.delete(`${namespace}:${key}`);
}

// Giới hạn N request/cửa sổ trượt (khác checkLock/recordFailure — không phải khóa sau auth-fail).
// Check + tăng đếm gộp 1 lần gọi.
async function checkRateWindow(namespace, key, { maxCount, windowMs }) {
  if (redis && redis.status === 'ready') {
    const rKey = windowRedisKey(namespace, key);
    // INCR + PEXPIRE (chỉ đặt lần đầu) — atomic đủ dùng cho rate-limit, không cần Lua script.
    const count = await redis.incr(rKey);
    if (count === 1) await redis.pexpire(rKey, windowMs);
    if (count > maxCount) {
      const ttl = await redis.pttl(rKey);
      return { limited: true, retryAfterMs: ttl > 0 ? ttl : windowMs };
    }
    return { limited: false };
  }

  const mapKey = `${namespace}:${key}`;
  const now = Date.now();
  const entry = memoryStore.get(mapKey) || { count: 0, resetTime: now + windowMs };
  if (now > entry.resetTime) {
    entry.count = 0;
    entry.resetTime = now + windowMs;
  }
  if (entry.count >= maxCount) {
    memoryStore.set(mapKey, entry);
    return { limited: true, retryAfterMs: entry.resetTime - now };
  }
  entry.count += 1;
  memoryStore.set(mapKey, entry);
  return { limited: false };
}

module.exports = { checkLock, recordFailure, clearFailures, checkRateWindow };
