process.env.JWT_SECRET ||= 'test-only-placeholder-jwt-secret';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);

const assert = require('node:assert/strict');
const test = require('node:test');
const AiConsentPolicy = require('../src/models/AiConsentPolicy');
const aiConsentService = require('../src/services/aiConsent.service');
const aiService = require('../src/services/ai.service');
const aiController = require('../src/controllers/ai.controller');
const { parseAiAudio, parseAiSettings } = require('../src/validators/ai.validator');

const POLICY_ID = '507f1f77bcf86cd799439011';
const policy = { _id: POLICY_ID, version: 1, provider: 'Google Gemini', title: 't', notice: 'n', promptLabel: 'p', promptDescription: 'd', historyLabel: 'h', historyDescription: 'd', inaccessibleData: [] };
const wav = (size = 100) => {
  const buffer = Buffer.alloc(size);
  buffer.write('RIFF', 0, 'latin1');
  buffer.write('WAVE', 8, 'latin1');
  return buffer;
};
const settingsOf = (extra) => ({ aiSettings: { enabled: true, policyId: POLICY_ID, decidedAt: new Date(), ...extra } });

test('audio chỉ nhận WAV hợp lệ tối đa 1 MB', () => {
  assert.ok(parseAiAudio(wav()));
  for (const invalid of [undefined, {}, 'text', Buffer.alloc(10), Buffer.alloc(100), wav(1024 * 1024 + 1)]) {
    assert.throws(() => parseAiAudio(invalid), { statusCode: 400 });
  }
});

test('voiceConsent chỉ bật được khi Trợ lý AI đang bật', () => {
  const base = { enabled: true, shareAiConversationHistory: false, storeAiHistory: false, syncAiHistory: false, enableAiMemory: false, policyId: POLICY_ID };
  assert.equal(parseAiSettings({ ...base, voiceConsent: true }).voiceConsent, true);
  assert.equal(parseAiSettings(base).voiceConsent, false);
  assert.throws(() => parseAiSettings({ ...base, enabled: false, voiceConsent: true }));
  assert.throws(() => parseAiSettings({ ...base, voiceConsent: 'yes' }));
});

test('giọng nói cần Hybrid và consent giọng nói riêng', async (t) => {
  t.mock.method(AiConsentPolicy, 'findOne', async () => policy);
  await assert.rejects(aiConsentService.requireVoiceAccess({ aiSettings: {} }), { statusCode: 403 });
  await assert.rejects(aiConsentService.requireVoiceAccess(settingsOf({ voiceConsent: false })), { extra: { code: 'AI_VOICE_CONSENT_REQUIRED' } });
  assert.equal((await aiConsentService.requireVoiceAccess(settingsOf({ voiceConsent: true }))).voiceConsent, true);
  const privateMode = { aiSettings: { enabled: false, voiceConsent: true, policyId: POLICY_ID, decidedAt: new Date() } };
  await assert.rejects(aiConsentService.requireVoiceAccess(privateMode), { statusCode: 403 });
});

test('transcribe gửi audio dạng inlineData và cắt transcript quá dài', async (t) => {
  process.env.GEMINI_API_KEY = 'test-key';
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push(JSON.parse(options.body));
    return { ok: true, headers: new Headers(), text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text: ` ${'a'.repeat(600)} ` }] } }] }) };
  });
  const text = await aiService.transcribe(wav(), 'audio/wav');
  assert.equal(text.length, 500);
  assert.equal(calls[0].contents[0].parts[0].inlineData.mimeType, 'audio/wav');
  assert.equal(calls[0].contents[0].parts[0].inlineData.data, wav().toString('base64'));
});

function runTranscribe(user, body) {
  const res = { statusCode: 200, headers: {}, set(k, v) { this.headers[k] = v; }, status(code) { this.statusCode = code; return this; }, json(payload) { this.payload = payload; return this; } };
  const req = { user: { _id: 'tx-user', ...user }, body, log: { error() {} } };
  return aiController.transcribe(req, res).then(() => res);
}

test('endpoint transcribe từ chối khi thiếu consent và không gọi Gemini', async (t) => {
  t.mock.method(AiConsentPolicy, 'findOne', async () => policy);
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('không được gọi'); });
  const res = await runTranscribe(settingsOf({ voiceConsent: false }), wav());
  assert.equal(res.statusCode, 403);
  assert.equal(res.payload.code, 'AI_VOICE_CONSENT_REQUIRED');
  const invalid = await runTranscribe(settingsOf({ voiceConsent: true }), Buffer.alloc(5));
  assert.equal(invalid.statusCode, 400);
  assert.equal(fetchMock.mock.calls.length, 0);
});

test('endpoint transcribe trả text khi đủ điều kiện và giới hạn tần suất', async (t) => {
  t.mock.method(AiConsentPolicy, 'findOne', async () => policy);
  t.mock.method(aiService, 'transcribe', async () => 'nhắn Bob là tôi về muộn');
  const user = settingsOf({ voiceConsent: true });
  const ok = await runTranscribe({ ...user, _id: 'tx-rate' }, wav());
  assert.deepEqual(ok.payload, { text: 'nhắn Bob là tôi về muộn' });
  let last;
  for (let i = 0; i < 20; i += 1) last = await runTranscribe({ ...user, _id: 'tx-rate' }, wav());
  assert.equal(last.statusCode, 429);
});
