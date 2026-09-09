const crypto = require('crypto');
const redis = require('../config/redis');

const CACHE_PREFIX = 'ext:safe-browsing:';
const SAFE_TTL_SECONDS = 24 * 60 * 60;
const UNSAFE_TTL_SECONDS = 60 * 60;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function normalizeUrl(value) {
  const parsed = new URL(String(value || '').trim());
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('invalid url');
  parsed.hash = '';
  return parsed.toString();
}

const cacheKey = url => `${CACHE_PREFIX}${crypto.createHash('sha256').update(url).digest('hex')}`;

async function getCached(key) {
  if (redis?.status !== 'ready') return null;
  try { const value = await redis.get(key); return value ? JSON.parse(value) : null; } catch { return null; }
}

async function setCached(key, value, ttlSeconds) {
  if (redis?.status !== 'ready') return;
  try { await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds); } catch {}
}

async function callProvider(endpoint, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: controller.signal });
    if (!response.ok) {
      const error = new Error(`provider ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return response.json();
  } finally { clearTimeout(timer); }
}

async function checkLinkSafety(value, log) {
  let url;
  try { url = normalizeUrl(value); } catch { return { safe: true, unknown: true, message: 'URL không hợp lệ' }; }
  const key = cacheKey(url);
  const cached = await getCached(key);
  if (cached) {
    log.info({ service: 'safe_browsing', result: 'cache_hit' }, 'External service metric');
    return { ...cached, cached: true };
  }

  const apiKey = process.env.SAFE_BROWSING_API_KEY;
  if (!apiKey) return { safe: true, unknown: true, source: 'disabled' };
  const endpoint = `https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${apiKey}`;
  const payload = {
    client: { clientId: 'chat-app-security', clientVersion: '1.0.0' },
    threatInfo: {
      threatTypes: ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE', 'POTENTIALLY_HARMFUL_APPLICATION'],
      platformTypes: ['ANY_PLATFORM'], threatEntryTypes: ['URL'], threatEntries: [{ url }],
    },
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const startedAt = Date.now();
    try {
      const json = await callProvider(endpoint, payload);
      const threat = json.matches?.[0]?.threatType;
      const result = { safe: !threat, threatType: threat || null };
      await setCached(key, result, threat ? UNSAFE_TTL_SECONDS : SAFE_TTL_SECONDS);
      log.info({ service: 'safe_browsing', result: threat ? 'unsafe' : 'safe', attempt, latencyMs: Date.now() - startedAt }, 'External service metric');
      return result;
    } catch (err) {
      const retryable = !err.status || err.status === 429 || err.status >= 500;
      log.warn({ service: 'safe_browsing', result: 'failed', attempt, status: err.status, retryable }, 'External service metric');
      if (!retryable || attempt === 2) break;
      await delay((attempt + 1) * 250 + Math.floor(Math.random() * 100));
    }
  }
  return { safe: true, unknown: true, source: 'unavailable' };
}

module.exports = { checkLinkSafety };
