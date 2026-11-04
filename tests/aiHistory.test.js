const assert = require('node:assert/strict');
const test = require('node:test');

process.env.ENCRYPTION_KEY ||= '0'.repeat(64);

const AiConversation = require('../src/models/AiConversation');
const AiMessage = require('../src/models/AiMessage');
const aiHistoryService = require('../src/services/aiHistory.service');

const USER_ID = '507f1f77bcf86cd799439011';
const CONVERSATION_ID = '507f1f77bcf86cd799439012';
const MESSAGE_ID = '507f1f77bcf86cd799439013';

test('tạo lịch sử chỉ nhận envelope của thiết bị thuộc người dùng', async (t) => {
  const currentUser = {
    _id: USER_ID,
    devices: [{ deviceId: 'device_1', e2eeKeyId: 'key_1', isRevoked: false }],
  };
  await assert.rejects(aiHistoryService.createConversation(currentUser, 'device_1', {
    clientConversationId: 'conversation_123456789',
    keyEnvelopes: { attacker_key: 'YWJjZA==' },
  }), { statusCode: 400, extra: { code: 'INVALID_AI_KEY_ENVELOPES' } });

  const created = {
    _id: CONVERSATION_ID,
    clientConversationId: 'conversation_123456789',
    keyEnvelopes: new Map([['key_1', 'YWJjZA==']]),
    cryptoVersion: 1,
    lastMessageAt: new Date(),
    createdAt: new Date(),
  };
  const createSpy = t.mock.method(AiConversation, 'findOneAndUpdate', async () => created);
  const result = await aiHistoryService.createConversation(currentUser, 'device_1', {
    clientConversationId: 'conversation_123456789',
    keyEnvelopes: { key_1: 'YWJjZA==' },
  });

  assert.equal(result.id, CONVERSATION_ID);
  assert.deepEqual(result.keyEnvelopes, { key_1: 'YWJjZA==' });
  assert.deepEqual(createSpy.mock.calls[0].arguments[0], {
    owner: USER_ID, clientConversationId: 'conversation_123456789',
  });
});

test('lưu ciphertext luôn scope conversation theo owner và idempotency key', async (t) => {
  const conversation = {
    _id: CONVERSATION_ID,
    lastMessageAt: new Date(),
    expiresAt: new Date(),
    save: async () => {},
  };
  t.mock.method(AiConversation, 'findOne', async (query) => {
    assert.equal(query.owner, USER_ID);
    return conversation;
  });
  const messageSpy = t.mock.method(AiMessage, 'findOneAndUpdate', async () => ({
    _id: MESSAGE_ID,
    conversation: CONVERSATION_ID,
    clientMessageId: 'message_1234567890',
  }));

  const result = await aiHistoryService.saveMessage(USER_ID, CONVERSATION_ID, {
    clientMessageId: 'message_1234567890', ciphertext: 'YWJjZA==', iv: 'YWJjZGVmZ2hpamts',
  });

  assert.equal(result.id, MESSAGE_ID);
  assert.deepEqual(messageSpy.mock.calls[0].arguments[0], {
    owner: USER_ID, clientMessageId: 'message_1234567890',
  });
});

test('cursor lịch sử trỏ tới tin cũ nhất của trang, không trùng trang kế tiếp', async (t) => {
  t.mock.method(AiConversation, 'findOne', async () => ({ _id: CONVERSATION_ID }));
  const rows = Array.from({ length: 51 }, (_, index) => ({
    _id: { toString: () => String(100 - index).padStart(24, '0') },
    clientMessageId: `message_${index}`,
    ciphertext: 'YWJjZA==',
    iv: 'YWJjZGVmZ2hpamts',
    cryptoVersion: 1,
    createdAt: new Date(index),
  }));
  t.mock.method(AiMessage, 'find', () => ({
    sort: () => ({ limit: async () => rows }),
  }));

  const result = await aiHistoryService.listMessages(USER_ID, CONVERSATION_ID);

  assert.equal(result.nextCursor, rows[49]._id.toString());
  assert.equal(result.items[0].clientMessageId, 'message_49');
  assert.equal(result.items.at(-1).clientMessageId, 'message_0');
});
