// Placeholder khóa cho test: socket handler require aiPermission.service → jwtKeys.js và auth.service → crypto.js.
process.env.JWT_SECRET ||= 'test-only-placeholder-jwt-secret';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);

const assert = require('node:assert/strict');
const test = require('node:test');
const registerCallHandlers = require('../src/socket/handlers/call.handler');
const Block = require('../src/models/Block');
const Friendship = require('../src/models/Friendship');

function mockSocket(id, user) {
  const handlers = new Map();
  const emitted = [];
  return {
    id,
    user,
    data: { user },
    emitted,
    on(event, handler) { handlers.set(event, handler); },
    emit(event, payload) { emitted.push({ event, payload }); },
    trigger(event, payload) { return handlers.get(event)(payload); },
  };
}

test('accepting or rejecting on one receiver device resolves ringing on its other devices', async (t) => {
  t.mock.method(Block, 'exists', async () => null);
  t.mock.method(Friendship, 'exists', async () => ({ _id: 'friendship' }));
  const caller = mockSocket('caller-tab', { _id: 'caller' });
  const acceptingDevice = mockSocket('receiver-phone', { _id: 'receiver' });
  const otherReceiverDevice = mockSocket('receiver-laptop', { _id: 'receiver' });
  const io = { fetchSockets: async () => [caller, acceptingDevice, otherReceiverDevice] };
  registerCallHandlers(io, acceptingDevice);

  await acceptingDevice.trigger('call:accept', { callerId: 'caller', signalData: { type: 'answer' } });
  assert.deepEqual(caller.emitted, [{
    event: 'call:accept',
    payload: { receiverId: 'receiver', signalData: { type: 'answer' } },
  }]);
  assert.deepEqual(otherReceiverDevice.emitted, [{ event: 'call:resolved', payload: { callerId: 'caller' } }]);
  assert.deepEqual(acceptingDevice.emitted, []);

  caller.emitted.length = 0;
  otherReceiverDevice.emitted.length = 0;
  await acceptingDevice.trigger('call:reject', { callerId: 'caller' });
  assert.deepEqual(caller.emitted, [{ event: 'call:reject', payload: { receiverId: 'receiver' } }]);
  assert.deepEqual(otherReceiverDevice.emitted, [{ event: 'call:resolved', payload: { callerId: 'caller' } }]);
});

test('screen-share state only relays boolean values to an allowed peer', async (t) => {
  t.mock.method(Block, 'exists', async () => null);
  t.mock.method(Friendship, 'exists', async () => ({ _id: 'friendship' }));
  const sender = mockSocket('sender-tab', { _id: 'sender' });
  const receiver = mockSocket('receiver-tab', { _id: 'receiver' });
  const io = { fetchSockets: async () => [sender, receiver] };
  registerCallHandlers(io, sender);

  await sender.trigger('call:screen-share', { targetId: 'receiver', sharing: 'yes' });
  assert.deepEqual(receiver.emitted, []);

  await sender.trigger('call:screen-share', { targetId: 'receiver', sharing: true });
  assert.deepEqual(receiver.emitted, [{
    event: 'call:screen-share',
    payload: { senderId: 'sender', sharing: true },
  }]);
});
