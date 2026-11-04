// Placeholder JWT_SECRET cho test: socket handler require aiPermission.service → jwtKeys.js.
process.env.JWT_SECRET ||= 'test-only-placeholder-jwt-secret';

const assert = require('node:assert/strict');
const test = require('node:test');
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
const Message = require('../src/models/Message');
const Room = require('../src/models/Room');
const User = require('../src/models/User');
const SenderKeyDistribution = require('../src/models/SenderKeyDistribution');
const registerMessageHandlers = require('../src/socket/handlers/message.handler');

test('retry after a lost acknowledgement returns the saved message without inserting or broadcasting twice', async (t) => {
  const handlers = new Map();
  const events = [];
  const socket = {
    user: { _id: 'user-1' }, data: { deviceId: 'device-1' },
    on(event, handler) { handlers.set(event, handler); },
    emit(event, payload) { events.push({ event, payload }); },
  };
  const room = { _id: 'room-1', members: ['user-1'], isDM: false, senderKeyEpoch: 0 };
  t.mock.method(Room, 'findOne', async () => room);
  t.mock.method(Room, 'findByIdAndUpdate', async () => room);
  t.mock.method(Room, 'findOneAndUpdate', async () => ({ senderKeyEpochMessageCount: 1, senderKeyEpochStartedAt: new Date() }));
  t.mock.method(SenderKeyDistribution, 'exists', async () => true);
  t.mock.method(User, 'find', () => ({ select: async () => [] }));
  const create = t.mock.method(Message, 'create', async (data) => ({
    async populate() {},
    toObject() { return { ...data, sender: { _id: 'user-1' } }; },
  }));
  const broadcasts = [];
  registerMessageHandlers({ to: () => ({ emit: (event, payload) => broadcasts.push({ event, payload }) }) }, socket);
  const payload = {
    clientMsgId: 'd0803e35-6b97-47e5-a8d3-b14974e59acf', roomId: 'room-1',
    content: 'ciphertext', iv: 'iv', tag: 'tag', type: 'text',
    scheme: 'sender-key', senderDeviceId: 'device-1', epoch: 0,
  };
  await handlers.get('message:send')(payload); // server saves; client never receives acknowledgement
  let retry;
  await handlers.get('message:send')(payload, result => { retry = result; });
  assert.equal(create.mock.calls.length, 1);
  assert.equal(create.mock.calls[0].arguments[0].clientMsgId, undefined);
  assert.equal(broadcasts.filter(event => event.event === 'message:new').length, 1);
  assert.equal(retry.success, true);
  assert.equal(retry.message.clientMsgId, payload.clientMsgId);
  assert.equal(events.filter(event => event.event === 'message:new').length, 1);
});

test('releases a rejected client message claim so its ID can send exactly once on retry', async (t) => {
  const handlers = new Map();
  const socket = {
    user: { _id: 'user-2' }, data: { deviceId: 'device-2' },
    on(event, handler) { handlers.set(event, handler); },
    emit() {},
  };
  const room = {
    _id: 'room-2', members: ['user-2'], isDM: false, senderKeyEpoch: 0,
    createdBy: 'owner', admins: [], grantedPermissions: new Map(),
  };
  t.mock.method(Room, 'findOne', async () => room);
  t.mock.method(Room, 'findByIdAndUpdate', async () => room);
  t.mock.method(Room, 'findOneAndUpdate', async () => ({ senderKeyEpochMessageCount: 1, senderKeyEpochStartedAt: new Date() }));
  t.mock.method(SenderKeyDistribution, 'exists', async () => true);
  t.mock.method(User, 'find', () => ({ select: async () => [] }));
  const create = t.mock.method(Message, 'create', async (data) => ({
    async populate() {},
    toObject() { return { ...data, sender: { _id: 'user-2' } }; },
  }));
  const withdrawnForward = () => ({ select: () => ({ lean: async () => ({ isDeleted: true }) }) });
  t.mock.method(Message, 'findById', withdrawnForward);
  registerMessageHandlers({ to: () => ({ emit() {} }) }, socket);

  const send = handlers.get('message:send');
  const rejected = [
    { type: 'poll' },
    { type: 'text', forwardedFrom: '000000000000000000000001' },
    { type: 'image' },
  ];
  for (const [index, invalid] of rejected.entries()) {
    const clientMsgId = `d0803e35-6b97-47e5-a8d3-b14974e59ac${index}`;
    const base = {
      clientMsgId, roomId: 'room-2', content: 'ciphertext', iv: 'iv', tag: 'tag',
      scheme: 'sender-key', senderDeviceId: 'device-2', epoch: 0,
    };
    let denied;
    await send({ ...base, ...invalid }, result => { denied = result; });
    assert.notEqual(denied?.code, 'IN_PROGRESS');
    assert.equal(create.mock.calls.length, index * 1);

    let retried;
    await send({ ...base, type: 'text' }, result => { retried = result; });
    assert.equal(retried?.success, true);
    assert.notEqual(retried?.code, 'IN_PROGRESS');
    assert.equal(create.mock.calls.length, index + 1);
  }
});

test('retry resolves a message committed before populate fails', async (t) => {
  const handlers = new Map();
  const socket = {
    user: { _id: 'user-3', username: 'sender', nickname: 'Sender' }, data: { deviceId: 'device-3' },
    on(event, handler) { handlers.set(event, handler); },
    emit() {},
  };
  const room = { _id: 'room-3', members: ['user-3'], isDM: false, senderKeyEpoch: 0 };
  t.mock.method(Room, 'findOne', async () => room);
  t.mock.method(SenderKeyDistribution, 'exists', async () => true);
  let populateCalls = 0;
  const create = t.mock.method(Message, 'create', async (data) => ({
    async populate() {
      populateCalls++;
      throw new Error('populate failed');
    },
    toObject() { return { ...data, sender: { _id: 'user-3' } }; },
  }));
  registerMessageHandlers({ to: () => ({ emit() {} }) }, socket);
  const payload = {
    clientMsgId: 'd0803e35-6b97-47e5-a8d3-b14974e59ad0', roomId: 'room-3',
    content: 'ciphertext', iv: 'iv', tag: 'tag', type: 'text',
    scheme: 'sender-key', senderDeviceId: 'device-3', epoch: 0,
  };
  await handlers.get('message:send')(payload);
  let retry;
  await handlers.get('message:send')(payload, result => { retry = result; });
  assert.equal(populateCalls, 1);
  assert.equal(create.mock.calls.length, 1);
  assert.equal(retry?.success, true);
  assert.equal(retry?.code, undefined);
  assert.equal(retry?.message.clientMsgId, payload.clientMsgId);
  assert.equal(retry?.message.sender.nickname, 'Sender');
});
