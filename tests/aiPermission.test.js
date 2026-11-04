process.env.JWT_SECRET ||= 'test-only-placeholder-jwt-secret';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);

const assert = require('node:assert/strict');
const test = require('node:test');
const AiCapability = require('../src/models/AiCapability');
const AiPermission = require('../src/models/AiPermission');
const Room = require('../src/models/Room');
const Message = require('../src/models/Message');
const User = require('../src/models/User');
const Block = require('../src/models/Block');
const Friendship = require('../src/models/Friendship');
const SenderKeyDistribution = require('../src/models/SenderKeyDistribution');
const registerMessageHandlers = require('../src/socket/handlers/message.handler');
const registerCallHandlers = require('../src/socket/handlers/call.handler');
const { signJwt, verifyJwt } = require('../src/utils/auth/jwtKeys');
const {
  CAPABILITY_CATALOG, PERMISSION_FIELDS, authorizeAction, verifyActionToken, updatePermissions,
} = require('../src/services/aiPermission.service');
const authService = require('../src/services/auth.service');
const PasskeyCredential = require('../src/models/PasskeyCredential');
const MfaChallenge = require('../src/models/MfaChallenge');
const { parseAiPermissionsPatch, parseAiPermissionsUpdate, parseAiActionAuthorize } = require('../src/validators/ai.validator');

const ROOM_ID = '0000000000000000000000a1';
const RECEIVER_ID = '0000000000000000000000b2';
const actionId = (n) => `d0803e35-6b97-47e5-a8d3-b14974e59a${String(n).padStart(2, '0')}`;

// Mock danh mục và bộ quyền của user như khi đọc từ MongoDB.
function mockPermissions(t, permissions) {
  t.mock.method(AiCapability, 'findOne', ({ actions }) => ({
    select: () => ({ lean: async () => CAPABILITY_CATALOG.find((item) => item.actions.includes(actions)) ?? null }),
  }));
  const state = { permissions, version: 0 };
  t.mock.method(AiPermission, 'findOne', () => ({ lean: async () => ({ ...state.permissions, version: state.version }) }));
  return state;
}

test('danh mục không có quyền đổi cài đặt, quyền, khóa, dữ liệu, thiết bị hay mật khẩu', () => {
  const forbidden = /settings\.write|permission|key|delete|device|password|admin/i;
  for (const capability of CAPABILITY_CATALOG) {
    assert.doesNotMatch(capability.key, forbidden);
    capability.actions.forEach((action) => assert.doesNotMatch(action, /settings_|grant|revoke|delete|export|device|password/i));
  }
  const schemaFields = Object.keys(AiPermission.schema.paths).filter((path) => !['user', '_id', '__v', 'createdAt', 'updatedAt', 'version'].includes(path));
  assert.deepEqual([...schemaFields].sort(), [...PERMISSION_FIELDS].sort());
});

test('quyền và action mở cài đặt đã bị loại bỏ vĩnh viễn', () => {
  assert.ok(!CAPABILITY_CATALOG.some(({ key, actions }) => key === 'settings.read' || actions.includes('open_settings')));
  assert.ok(!PERMISSION_FIELDS.includes('settingsRead'));
  assert.ok(!AiPermission.schema.path('settingsRead'));
  assert.throws(() => parseAiPermissionsPatch({ settingsRead: true }, PERMISSION_FIELDS));
});

test('patch quyền chỉ nhận trường trong danh mục với giá trị boolean', () => {
  assert.deepEqual(parseAiPermissionsPatch({ messagesSend: true }, PERMISSION_FIELDS), { messagesSend: true });
  for (const invalid of [{}, [], null, { messagesSend: 'true' }, { settingsWrite: true }, { user: 'x' }]) {
    assert.throws(() => parseAiPermissionsPatch(invalid, PERMISSION_FIELDS));
  }
});

test('authorize chỉ nhận action cấp 2 với đích hợp lệ', () => {
  assert.deepEqual(
    parseAiActionAuthorize({ action: 'send_message', actionId: actionId(1), roomId: ROOM_ID }),
    { action: 'send_message', actionId: actionId(1), roomId: ROOM_ID },
  );
  const invalid = [
    { action: 'open_friends', actionId: actionId(1) },
    { action: 'send_message', actionId: 'not-uuid', roomId: ROOM_ID },
    { action: 'send_message', actionId: actionId(1) },
    { action: 'send_message', actionId: actionId(1), roomId: ROOM_ID, receiverId: RECEIVER_ID },
    { action: 'start_audio_call', actionId: actionId(1), roomId: ROOM_ID },
    { action: 'start_audio_call', actionId: actionId(1), receiverId: RECEIVER_ID, extra: 1 },
  ];
  invalid.forEach((body) => assert.throws(() => parseAiActionAuthorize(body)));
});

test('authorize từ chối khi quyền tắt, action cấp 1 hoặc phòng không phải DM của user', async (t) => {
  const state = mockPermissions(t, { messagesSend: false, contactsRead: true });
  const user = { _id: 'auth-user-1' };
  assert.deepEqual(await authorizeAction(user, { action: 'send_message', actionId: actionId(2), roomId: ROOM_ID }), { allowed: false, reason: 'no_grant' });
  assert.deepEqual(await authorizeAction(user, { action: 'open_friends', actionId: actionId(3) }), { allowed: false, reason: 'unknown_action' });
  state.permissions = { messagesSend: true };
  t.mock.method(Room, 'exists', async () => null);
  assert.deepEqual(await authorizeAction(user, { action: 'send_message', actionId: actionId(4), roomId: ROOM_ID }), { allowed: false, reason: 'invalid_target' });
});

test('token action ràng buộc user, action, đích; không có claim id của token đăng nhập', async (t) => {
  mockPermissions(t, { messagesSend: true });
  t.mock.method(Room, 'exists', async () => ({ _id: ROOM_ID }));
  const result = await authorizeAction({ _id: 'auth-user-2' }, { action: 'send_message', actionId: actionId(5), roomId: ROOM_ID });
  assert.equal(result.allowed, true);
  const payload = verifyJwt(result.token);
  assert.equal(payload.id, undefined);
  assert.equal(payload.aud, 'ai-action');
  assert.equal(payload.sub, 'auth-user-2');
  assert.equal(payload.jti, actionId(5));
  assert.equal(payload.roomId, ROOM_ID);
  assert.equal(payload.exp - payload.iat, 120);
});

test('verify token sai user, action, phòng, jti, loại token hoặc quyền đã thu hồi đều bị từ chối', async (t) => {
  const state = mockPermissions(t, { messagesSend: true });
  t.mock.method(Room, 'exists', async () => ({ _id: ROOM_ID }));
  const { token } = await authorizeAction({ _id: 'auth-user-3' }, { action: 'send_message', actionId: actionId(6), roomId: ROOM_ID });
  const expected = { userId: 'auth-user-3', action: 'send_message', roomId: ROOM_ID, jti: actionId(6) };
  assert.ok(await verifyActionToken(token, expected));
  // Thu hồi rồi bật lại: version đã tăng nên token cũ không sống lại (I8).
  state.version += 1;
  assert.equal(await verifyActionToken(token, expected), null);
  state.version -= 1;
  assert.equal(await verifyActionToken(token, { ...expected, userId: 'other' }), null);
  assert.equal(await verifyActionToken(token, { ...expected, action: 'start_audio_call' }), null);
  assert.equal(await verifyActionToken(token, { ...expected, roomId: '0000000000000000000000ff' }), null);
  assert.equal(await verifyActionToken(token, { ...expected, jti: actionId(7) }), null);
  assert.equal(await verifyActionToken(signJwt({ id: 'auth-user-3' }), expected), null);
  assert.equal(await verifyActionToken(undefined, expected), null);
  state.permissions = { messagesSend: false };
  assert.equal(await verifyActionToken(token, expected), null);
});

test('message:send với token trợ lý sai bị từ chối và không lưu tin', async (t) => {
  mockPermissions(t, { messagesSend: true });
  const handlers = new Map();
  const socket = {
    user: { _id: 'msg-user' }, data: { deviceId: 'device-1' },
    on(event, handler) { handlers.set(event, handler); },
    emit() {},
  };
  t.mock.method(Room, 'findOne', async () => ({ _id: ROOM_ID, members: ['msg-user'], isDM: false, senderKeyEpoch: 0 }));
  t.mock.method(SenderKeyDistribution, 'exists', async () => true);
  t.mock.method(User, 'find', () => ({ select: async () => [] }));
  const create = t.mock.method(Message, 'create', async () => { throw new Error('không được lưu'); });
  registerMessageHandlers({ to: () => ({ emit() {} }) }, socket);
  const wrongRoomToken = signJwt(
    { typ: 'ai-action', action: 'send_message', roomId: '0000000000000000000000ff' },
    { audience: 'ai-action', subject: 'msg-user', jwtid: actionId(8), expiresIn: 120 },
  );
  let result;
  await handlers.get('message:send')({
    clientMsgId: actionId(8), roomId: ROOM_ID, content: 'ciphertext', iv: 'iv', tag: 'tag', type: 'text',
    scheme: 'sender-key', senderDeviceId: 'device-1', epoch: 0, aiActionToken: wrongRoomToken,
  }, (response) => { result = response; });
  assert.equal(result.code, 'AI_NOT_ALLOWED');
  assert.equal(create.mock.calls.length, 0);
});

test('call:request dùng lại token trợ lý thì bị từ chối', async (t) => {
  mockPermissions(t, { callsStart: true });
  t.mock.method(Block, 'exists', async () => null);
  t.mock.method(Friendship, 'exists', async () => ({ _id: 'friendship' }));
  const emitted = [];
  const handlers = new Map();
  const caller = {
    id: 'caller-tab', user: { _id: 'call-user' }, data: { user: { _id: 'call-user' } },
    on(event, handler) { handlers.set(event, handler); },
    emit(event, payload) { emitted.push({ event, payload }); },
  };
  const receiver = { id: 'receiver-tab', data: { user: { _id: RECEIVER_ID } }, emit(event) { emitted.push({ event: `receiver:${event}` }); } };
  registerCallHandlers({ fetchSockets: async () => [caller, receiver] }, caller);
  const { token } = await authorizeAction({ _id: 'call-user' }, { action: 'start_audio_call', actionId: actionId(9), receiverId: RECEIVER_ID });
  const request = { receiverId: RECEIVER_ID, signalData: {}, type: 'audio', aiActionToken: token };
  await handlers.get('call:request')(request);
  await handlers.get('call:request')(request);
  assert.equal(emitted.filter((item) => item.event === 'receiver:call:request').length, 1);
  assert.deepEqual(emitted.find((item) => item.event === 'call:failed')?.payload, { receiverId: RECEIVER_ID, reason: 'ai_not_allowed' });
});

test('call:request với token cuộc gọi video dùng cho cuộc gọi thoại bị từ chối', async (t) => {
  mockPermissions(t, { callsStart: true });
  t.mock.method(Block, 'exists', async () => null);
  t.mock.method(Friendship, 'exists', async () => ({ _id: 'friendship' }));
  const emitted = [];
  const handlers = new Map();
  const caller = {
    id: 'caller-tab-2', user: { _id: 'call-user-2' }, data: { user: { _id: 'call-user-2' } },
    on(event, handler) { handlers.set(event, handler); },
    emit(event, payload) { emitted.push({ event, payload }); },
  };
  registerCallHandlers({ fetchSockets: async () => [caller] }, caller);
  const { token } = await authorizeAction({ _id: 'call-user-2' }, { action: 'start_video_call', actionId: actionId(10), receiverId: RECEIVER_ID });
  await handlers.get('call:request')({ receiverId: RECEIVER_ID, signalData: {}, type: 'audio', aiActionToken: token });
  assert.equal(emitted[0]?.payload?.reason, 'ai_not_allowed');
});

test('body cập nhật quyền chỉ nhận permissions và đúng một proof hợp lệ', () => {
  const ok = parseAiPermissionsUpdate({ permissions: { messagesSend: true }, proof: { code: '123456' } }, PERMISSION_FIELDS);
  assert.deepEqual(ok, { patch: { messagesSend: true }, proof: { code: '123456' } });
  assert.deepEqual(parseAiPermissionsUpdate({ permissions: { callsEnd: false } }, PERMISSION_FIELDS).proof, {});
  const invalid = [
    { messagesSend: true },
    { permissions: { messagesSend: true }, extra: 1 },
    { permissions: { messagesSend: true }, proof: { code: '12345' } },
    { permissions: { messagesSend: true }, proof: { code: 'ABC123' } },
    { permissions: { messagesSend: true }, proof: { code: '123456', stepUpChallengeToken: 'a'.repeat(43) } },
    { permissions: { messagesSend: true }, proof: { stepUpChallengeToken: 'short' } },
    { permissions: { messagesSend: true }, proof: [] },
  ];
  invalid.forEach((body) => assert.throws(() => parseAiPermissionsUpdate(body, PERMISSION_FIELDS)));
});

function mockUpdate(t) {
  const verify = t.mock.method(authService, 'verifyStepUpFactor', async () => {});
  const update = t.mock.method(AiPermission, 'findOneAndUpdate', () => ({ lean: async () => ({ messagesSend: true, version: 1 }) }));
  return { verify, update };
}

test('bật quyền cấp 2 phải qua xác nhận; thiếu hoặc sai thì không ghi DB', async (t) => {
  const { verify, update } = mockUpdate(t);
  verify.mock.mockImplementation(async () => { throw new Error('proof sai'); });
  await assert.rejects(updatePermissions({ _id: 'u1' }, { messagesSend: true }, {}), /proof sai/);
  await assert.rejects(updatePermissions({ _id: 'u1' }, { callsStart: true }, { code: '000000' }), /proof sai/);
  assert.equal(update.mock.calls.length, 0);
});

test('tắt quyền hoặc bật quyền cấp 1 không cần xác nhận; mỗi lần ghi tăng version', async (t) => {
  const { verify, update } = mockUpdate(t);
  await updatePermissions({ _id: 'u1' }, { messagesSend: false, callsStart: false }, {});
  await updatePermissions({ _id: 'u1' }, { contactsRead: true }, {});
  assert.equal(verify.mock.calls.length, 0);
  assert.equal(update.mock.calls.length, 2);
  assert.deepEqual(update.mock.calls[0].arguments[1].$inc, { version: 1 });
  await updatePermissions({ _id: 'u1' }, { messagesSend: true }, { code: '123456' });
  assert.equal(verify.mock.calls.length, 1);
  assert.equal(update.mock.calls.length, 3);
});

test('verifyStepUpFactor từ chối khi chưa có Passkey/TOTP, thiếu mã 6 số hoặc challenge không hợp lệ', async (t) => {
  const state = { totpEnabled: false, passkey: null };
  t.mock.method(User, 'findById', () => ({ select: async () => ({ _id: 'u2', totpEnabled: state.totpEnabled }) }));
  t.mock.method(PasskeyCredential, 'exists', async () => state.passkey);
  t.mock.method(MfaChallenge, 'updateOne', async () => ({ modifiedCount: 0 }));
  await assert.rejects(authService.verifyStepUpFactor({ _id: 'u2' }, { code: '123456' }), { extra: { code: 'AI_PROOF_SETUP_REQUIRED' }, statusCode: 403 });
  state.totpEnabled = true;
  await assert.rejects(authService.verifyStepUpFactor({ _id: 'u2' }, { code: 'ABCDEF12' }), { statusCode: 401 });
  await assert.rejects(authService.verifyStepUpFactor({ _id: 'u2' }, {}), { statusCode: 401 });
  await assert.rejects(authService.verifyStepUpFactor({ _id: 'u2' }, { stepUpChallengeToken: 'a'.repeat(43) }), { statusCode: 401 });
});
