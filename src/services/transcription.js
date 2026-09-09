const logger = require('../config/logger');
const AppError = require('../utils/AppError');
const redis = require('../config/redis');

let circuitOpenUntil = 0;
const CIRCUIT_KEY = 'ext:circuit:transcription';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function callProvider(url, apiKey, buffer) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: buffer, signal: controller.signal });
    if (!response.ok) {
      const error = new Error(`provider ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return response.json();
  } finally { clearTimeout(timer); }
}

async function circuitIsOpen() {
  if (redis?.status === 'ready') {
    try { return !!(await redis.get(CIRCUIT_KEY)); } catch {}
  }
  return Date.now() < circuitOpenUntil;
}

async function openCircuit() {
  circuitOpenUntil = Date.now() + 60 * 1000;
  if (redis?.status === 'ready') {
    try { await redis.set(CIRCUIT_KEY, '1', 'PX', 60 * 1000); } catch {}
  }
}

async function closeCircuit() {
  circuitOpenUntil = 0;
  if (redis?.status === 'ready') {
    try { await redis.del(CIRCUIT_KEY); } catch {}
  }
}

async function transcribeAudio(buffer, log = logger) {
  const apiKey = process.env.TRANSCRIBE_API_KEY;
  const baseUrl = process.env.TRANSCRIBE_API_BASE_URL;
  if (!apiKey || apiKey === 'your_optional_transcribe_api_key_here' || !baseUrl) {
    throw new AppError('Tính năng chuyển giọng nói thành văn bản chưa được cấu hình', 503);
  }
  if (await circuitIsOpen()) throw new AppError('Dịch vụ chuyển giọng nói đang tạm thời quá tải', 503);

  const model = process.env.TRANSCRIBE_MODEL || '@cf/openai/whisper-large-v3-turbo';
  const url = `${baseUrl}/ai/run/${model}`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const startedAt = Date.now();
    try {
      const data = await callProvider(url, apiKey, buffer);
      const text = data.result?.transcription_info?.text ?? data.result?.text;
      if (typeof text !== 'string') throw new Error('invalid provider response');
      await closeCircuit();
      log.info({ service: 'transcription', mode: 'cloud', result: 'success', attempt, latencyMs: Date.now() - startedAt }, 'External service metric');
      return { text };
    } catch (err) {
      const retryable = !err.status || err.status === 429 || err.status >= 500;
      log.warn({ service: 'transcription', mode: 'cloud', result: 'failed', attempt, status: err.status, retryable }, 'External service metric');
      if (!retryable || attempt === 2) break;
      await delay((attempt + 1) * 500 + Math.floor(Math.random() * 200));
    }
  }
  await openCircuit();
  throw new AppError('Không thể chuyển giọng nói thành văn bản', 502);
}

module.exports = { transcribeAudio };
