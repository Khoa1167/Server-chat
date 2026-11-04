const assert = require('node:assert/strict');
const test = require('node:test');
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
// accountDeletion.service.js require auth.service.js (để tái dùng generateOTP/hashOTP) — file đó
// require jwtKeys.js, throw ngay lúc require() nếu thiếu JWT_SECRET. Giá trị placeholder riêng cho
// tiến trình test, không phải giá trị thật.
process.env.JWT_SECRET ||= 'test-only-placeholder-jwt-secret';

const crypto = require('crypto');
const User = require('../src/models/User');
const AccountRecovery = require('../src/models/AccountRecovery');
const Room = require('../src/models/Room');
const Friendship = require('../src/models/Friendship');
const Block = require('../src/models/Block');
const Notification = require('../src/models/Notification');
const LoginHistory = require('../src/models/LoginHistory');
const PasskeyCredential = require('../src/models/PasskeyCredential');
const PushSubscription = require('../src/models/PushSubscription');
const AiConversation = require('../src/models/AiConversation');
const AiMessage = require('../src/models/AiMessage');
const cloudinary = require('../src/config/cloudinary');
const roomsService = require('../src/services/rooms.service');
const {
  requestAccountDeletion, requestAccountRecovery, verifyAccountRecovery, purgeExpiredAccountDeletions,
} = require('../src/services/accountDeletion.service');

function hashOTP(otp) {
  return crypto.createHash('sha256').update(otp).digest('hex');
}

test('requestAccountDeletion đặt lịch xóa + thu hồi devices khi đúng mật khẩu', async (t) => {
  const user = {
    _id: 'u1',
    email: 'ciphertext',
    devices: [{ deviceId: 'd1' }],
    pendingDeletionAt: null,
    comparePassword: async (pw) => pw === 'correct',
    save: async function () { return this; },
  };
  t.mock.method(User, 'findById', async () => user);
  t.mock.method(PushSubscription, 'deleteMany', async () => {});

  const result = await requestAccountDeletion({ _id: 'u1' }, { currentPassword: 'correct' });

  assert.ok(result.pendingDeletionAt instanceof Date);
  assert.ok(user.pendingDeletionAt instanceof Date);
  assert.deepEqual(user.devices, []);
});

test('requestAccountDeletion reject khi sai mật khẩu', async (t) => {
  const user = {
    _id: 'u1',
    comparePassword: async () => false,
    save: async function () { throw new Error('không được lưu'); },
  };
  t.mock.method(User, 'findById', async () => user);

  await assert.rejects(
    requestAccountDeletion({ _id: 'u1' }, { currentPassword: 'wrong' }),
    { statusCode: 401 }
  );
});

test('requestAccountRecovery không lộ thông tin khi email không tồn tại hoặc không chờ xóa', async (t) => {
  t.mock.method(User, 'findOne', async () => null);
  const result = await requestAccountRecovery('unknown@example.com');
  assert.match(result.message, /Nếu email này/);
});

test('verifyAccountRecovery đúng OTP thì gỡ pendingDeletionAt', async (t) => {
  const user = { _id: 'u1', pendingDeletionAt: new Date(), save: async function () { return this; } };
  const otp = '123456';
  const record = { _id: 'rec1', otp: hashOTP(otp), attempts: 0, expiresAt: new Date(Date.now() + 60000) };
  t.mock.method(User, 'findOne', async () => user);
  t.mock.method(AccountRecovery, 'findOne', async () => record);
  const deleteSpy = t.mock.method(AccountRecovery, 'deleteOne', async () => {});

  const result = await verifyAccountRecovery('u1@example.com', otp);

  assert.equal(user.pendingDeletionAt, null);
  assert.equal(deleteSpy.mock.calls.length, 1);
  assert.match(result.message, /khôi phục/);
});

test('verifyAccountRecovery sai OTP thì tăng attempts và reject', async (t) => {
  const user = { _id: 'u1', pendingDeletionAt: new Date() };
  const record = { _id: 'rec1', otp: hashOTP('654321'), attempts: 0, expiresAt: new Date(Date.now() + 60000), save: async function () { return this; } };
  t.mock.method(User, 'findOne', async () => user);
  t.mock.method(AccountRecovery, 'findOne', async () => record);

  await assert.rejects(verifyAccountRecovery('u1@example.com', '111111'), { statusCode: 400 });
  assert.equal(record.attempts, 1);
});

test('verifyAccountRecovery hết hạn OTP thì xóa record và reject', async (t) => {
  const user = { _id: 'u1', pendingDeletionAt: new Date() };
  const record = { _id: 'rec1', otp: hashOTP('654321'), attempts: 0, expiresAt: new Date(Date.now() - 1000) };
  t.mock.method(User, 'findOne', async () => user);
  t.mock.method(AccountRecovery, 'findOne', async () => record);
  const deleteSpy = t.mock.method(AccountRecovery, 'deleteOne', async () => {});

  await assert.rejects(verifyAccountRecovery('u1@example.com', '654321'), { statusCode: 400 });
  assert.equal(deleteSpy.mock.calls.length, 1);
});

test('purgeExpiredAccountDeletions rời nhóm thường, bỏ qua DM, ghi tombstone đúng field', async (t) => {
  const postPurge = t.mock.method(require('../src/services/posts.service'), 'purgeUser', async () => {});
  const normalRoom = { _id: 'room1', isDM: false };
  const dmRoom = { _id: 'room2', isDM: true };
  const user = {
    _id: 'u1', avatar: 'avatar-url', cover: 'cover-url', devices: [{ deviceId: 'd1' }],
    aiSettings: { enabled: true, shareAiConversationHistory: true, storeAiHistory: true, syncAiHistory: true, enableAiMemory: true, voiceConsent: true, policyId: 'policy1', decidedAt: new Date() },
    save: async function () { return this; },
  };

  t.mock.method(User, 'find', async () => [user]);
  t.mock.method(Room, 'find', async () => [normalRoom, dmRoom]);
  const leaveRoomSpy = t.mock.method(roomsService, 'leaveRoom', async () => {});
  t.mock.method(Friendship, 'deleteMany', async () => {});
  t.mock.method(Block, 'deleteMany', async () => {});
  t.mock.method(Notification, 'deleteMany', async () => {});
  t.mock.method(LoginHistory, 'deleteMany', async () => {});
  t.mock.method(PasskeyCredential, 'deleteMany', async () => {});
  t.mock.method(AiConversation, 'deleteMany', async () => {});
  t.mock.method(AiMessage, 'deleteMany', async () => {});
  t.mock.method(PushSubscription, 'deleteMany', async () => {});
  const cloudinarySpy = t.mock.method(cloudinary, 'deleteCloudinaryImage', () => {});

  await purgeExpiredAccountDeletions(null);

  assert.equal(leaveRoomSpy.mock.calls.length, 1);
  assert.equal(postPurge.mock.calls.length, 1);
  assert.equal(postPurge.mock.calls[0].arguments[0], 'u1');
  assert.equal(leaveRoomSpy.mock.calls[0].arguments[0], 'room1');
  assert.equal(cloudinarySpy.mock.calls.length, 2); // avatar + cover
  assert.equal(user.nickname, 'Người dùng đã xóa');
  assert.equal(user.username, 'deleted-u1');
  assert.equal(user.isDeleted, true);
  assert.equal(user.pendingDeletionAt, null);
  assert.deepEqual(user.devices, []);
  assert.deepEqual(user.aiSettings, {
    enabled: false, shareAiConversationHistory: false, storeAiHistory: false, syncAiHistory: false, enableAiMemory: false, voiceConsent: false, policyId: null, decidedAt: null,
  });
});
