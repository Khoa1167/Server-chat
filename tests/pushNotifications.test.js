const assert = require('node:assert/strict');
const test = require('node:test');

const { buildMessagePush } = require('../src/services/pushNotifications.service');

test('message push only contains generic text and room navigation data', () => {
  const push = buildMessagePush('507f1f77bcf86cd799439011');
  assert.deepEqual(push.notification, { title: 'Chat App', body: 'Bạn có tin nhắn mới' });
  assert.deepEqual(push.data, { type: 'message', roomId: '507f1f77bcf86cd799439011' });
  assert.equal(JSON.stringify(push).includes('content'), false);
});
