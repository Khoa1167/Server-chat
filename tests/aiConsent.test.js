const assert = require('node:assert/strict');
const test = require('node:test');

process.env.ENCRYPTION_KEY ||= '0'.repeat(64);

const AiConsentPolicy = require('../src/models/AiConsentPolicy');
const User = require('../src/models/User');
const aiConsentService = require('../src/services/aiConsent.service');
const {
  parseAiHistory, parseAiMemories, parseAiSettings, parseEncryptedConversation, parseEncryptedMessage,
} = require('../src/validators/ai.validator');

const POLICY_ID = '507f1f77bcf86cd799439011';
const policy = {
  _id: POLICY_ID,
  version: 1,
  provider: 'Google Gemini',
  title: 'Trợ lý AI',
  notice: 'Không được bảo vệ bằng mã hóa đầu cuối.',
  promptLabel: 'Bật Trợ lý AI',
  promptDescription: 'Gửi nội dung bạn nhập tới Gemini.',
  historyLabel: 'Dùng lịch sử trò chuyện AI',
  historyDescription: 'Gửi lại lịch sử trong panel AI.',
  inaccessibleData: ['Tin nhắn phòng'],
};

test('người dùng chưa quyết định có trạng thái pending', async (t) => {
  t.mock.method(AiConsentPolicy, 'findOne', async () => policy);
  const result = await aiConsentService.getSettings({ aiSettings: {} });
  assert.equal(result.settings.status, 'pending');
  assert.equal(result.policy.id, POLICY_ID);
});

test('database trống vẫn dùng chính sách mặc định để người dùng quyết định', async (t) => {
  t.mock.method(AiConsentPolicy, 'findOne', async () => null);
  const result = await aiConsentService.getSettings({ aiSettings: {} });
  assert.equal(result.settings.status, 'pending');
  assert.equal(result.policy.provider, 'Google Gemini');
});

test('chat chỉ được mở với quyết định bật trên policy hiện hành', async (t) => {
  t.mock.method(AiConsentPolicy, 'findOne', async () => policy);
  const settings = await aiConsentService.requireChatAccess({
    aiSettings: {
      enabled: true,
      shareAiConversationHistory: true,
      policyId: POLICY_ID,
      decidedAt: new Date(),
    },
  });
  assert.equal(settings.shareAiConversationHistory, true);
});

test('chế độ Hybrid/Riêng tư suy ra từ quyết định và Riêng tư không được gọi Gemini', async (t) => {
  t.mock.method(AiConsentPolicy, 'findOne', async () => policy);
  const decided = (enabled) => ({
    aiSettings: { enabled, policyId: POLICY_ID, decidedAt: new Date() },
  });

  assert.equal((await aiConsentService.getSettings({ aiSettings: {} })).settings.mode, null);
  assert.equal((await aiConsentService.getSettings(decided(true))).settings.mode, 'hybrid');
  assert.equal((await aiConsentService.getSettings(decided(false))).settings.mode, 'private');
  await assert.rejects(
    aiConsentService.requireChatAccess(decided(false)),
    { statusCode: 403, extra: { code: 'AI_CONSENT_REQUIRED' } },
  );
});

test('chỉ policy đang active mới được ghi nhận', async (t) => {
  t.mock.method(AiConsentPolicy, 'findOne', async () => policy);
  await assert.rejects(
    aiConsentService.updateSettings(
      { _id: 'user1' },
      { enabled: true, shareAiConversationHistory: false, storeAiHistory: false, syncAiHistory: false, enableAiMemory: false, policyId: '507f1f77bcf86cd799439012' },
    ),
    { statusCode: 409, extra: { code: 'AI_CONSENT_POLICY_CHANGED' } },
  );
});

test('lưu quyết định tắt đồng thời tắt quyền gửi lịch sử', async (t) => {
  t.mock.method(AiConsentPolicy, 'findOne', async () => policy);
  const user = { _id: 'user1', aiSettings: {}, save: async function save() { return this; } };
  t.mock.method(User, 'findById', async () => user);

  const result = await aiConsentService.updateSettings(
    { _id: 'user1' },
    { enabled: false, shareAiConversationHistory: false, storeAiHistory: false, syncAiHistory: false, enableAiMemory: false, policyId: POLICY_ID },
  );

  assert.equal(result.settings.status, 'disabled');
  assert.equal(user.aiSettings.shareAiConversationHistory, false);
});

test('API không nhận lịch sử nhiều lượt khi chưa được cấp quyền', () => {
  assert.throws(
    () => parseAiHistory([
      { role: 'user', content: 'Câu trước' },
      { role: 'assistant', content: 'Trả lời trước' },
      { role: 'user', content: 'Câu mới' },
    ], false),
    { statusCode: 403, extra: { code: 'AI_HISTORY_CONSENT_REQUIRED' } },
  );
  assert.deepEqual(parseAiHistory([{ role: 'user', content: '  Câu mới  ' }], false), [
    { role: 'user', content: 'Câu mới' },
  ]);
});

test('cài đặt AI từ chối field lạ và lịch sử khi chatbot đang tắt', () => {
  assert.throws(() => parseAiSettings({
    enabled: false,
    shareAiConversationHistory: true,
    storeAiHistory: false,
    syncAiHistory: false,
    enableAiMemory: false,
    policyId: POLICY_ID,
    role: 'admin',
  }), { statusCode: 400 });
});

test('bộ nhớ AI cần consent riêng và có giới hạn', () => {
  assert.deepEqual(parseAiMemories([' Trả lời ngắn gọn '], true), ['Trả lời ngắn gọn']);
  assert.throws(() => parseAiMemories(['Không được gửi'], false), {
    statusCode: 403, extra: { code: 'AI_MEMORY_CONSENT_REQUIRED' },
  });
});

test('đồng bộ lịch sử cần consent riêng', async (t) => {
  t.mock.method(AiConsentPolicy, 'findOne', async () => policy);
  await assert.rejects(aiConsentService.requireHistorySyncAccess({
    aiSettings: {
      enabled: true,
      shareAiConversationHistory: true,
      storeAiHistory: true,
      syncAiHistory: false,
      enableAiMemory: false,
      policyId: POLICY_ID,
      decidedAt: new Date(),
    },
  }), { statusCode: 403, extra: { code: 'AI_HISTORY_SYNC_REQUIRED' } });
});

test('payload lịch sử mã hóa chỉ nhận ID và base64 giới hạn', () => {
  assert.deepEqual(parseEncryptedConversation({
    clientConversationId: 'conversation_123456789',
    keyEnvelopes: { device_1: 'YWJjZA==' },
  }), {
    clientConversationId: 'conversation_123456789',
    keyEnvelopes: { device_1: 'YWJjZA==' },
  });
  assert.deepEqual(parseEncryptedMessage({
    clientMessageId: 'message_1234567890',
    ciphertext: 'YWJjZA==',
    iv: 'YWJjZGVmZ2hpamts',
  }), {
    clientMessageId: 'message_1234567890',
    ciphertext: 'YWJjZA==',
    iv: 'YWJjZGVmZ2hpamts',
  });
  assert.throws(() => parseEncryptedMessage({
    clientMessageId: 'message_1234567890', ciphertext: '<script>', iv: 'YWJjZGVmZ2hpamts',
  }), { statusCode: 400 });
});
