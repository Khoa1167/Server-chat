const assert = require('node:assert/strict');
const test = require('node:test');
const registerGroupCallHandlers = require('../src/socket/handlers/groupCall.handler');
const Room = require('../src/models/Room');
const sfu = require('../src/services/sfu.service');

function mockSocket(id, user) {
  const handlers = new Map();
  const emitted = [];
  const toRooms = [];
  return {
    id,
    user,
    data: { user },
    emitted,
    toRooms,
    on(event, handler) { handlers.set(event, handler); },
    emit(event, payload) { emitted.push({ event, payload }); },
    to(roomId) {
      return { emit: (event, payload) => toRooms.push({ roomId, event, payload }) };
    },
    trigger(event, payload, ack) { return handlers.get(event)(payload, ack); },
  };
}

const VALID_ROOM_ID = '507f1f77bcf86cd799439011';

test('call:group-join từ chối khi không phải thành viên phòng', async (t) => {
  t.mock.method(Room, 'findOne', () => ({ select: async () => null }));
  const joinSpy = t.mock.method(sfu, 'joinRoom', async () => ({ rtpCapabilities: {} }));
  const socket = mockSocket('socket-1', { _id: 'user-1' });
  const io = {};
  registerGroupCallHandlers(io, socket);

  const acks = [];
  await socket.trigger('call:group-join', { roomId: VALID_ROOM_ID }, (res) => acks.push(res));

  assert.deepEqual(acks, [{ error: 'not_allowed' }]);
  assert.equal(joinSpy.mock.calls.length, 0);
});

test('call:group-join từ chối roomId không hợp lệ mà không đụng DB', async (t) => {
  const findOneSpy = t.mock.method(Room, 'findOne', () => ({ select: async () => ({ _id: VALID_ROOM_ID }) }));
  const socket = mockSocket('socket-1', { _id: 'user-1' });
  registerGroupCallHandlers({}, socket);

  const acks = [];
  await socket.trigger('call:group-join', { roomId: 'not-an-object-id' }, (res) => acks.push(res));

  assert.deepEqual(acks, []);
  assert.equal(findOneSpy.mock.calls.length, 0);
});

test('call:group-join thành công trả rtpCapabilities và broadcast peer-joined', async (t) => {
  t.mock.method(Room, 'findOne', () => ({ select: async () => ({ _id: VALID_ROOM_ID }) }));
  t.mock.method(sfu, 'joinRoom', async () => ({ rtpCapabilities: { codecs: [] } }));
  t.mock.method(sfu, 'listOtherProducers', () => []);
  const socket = mockSocket('socket-1', { _id: 'user-1', username: 'alice' });
  registerGroupCallHandlers({}, socket);

  const acks = [];
  await socket.trigger('call:group-join', { roomId: VALID_ROOM_ID }, (res) => acks.push(res));

  assert.deepEqual(acks, [{ rtpCapabilities: { codecs: [] }, otherProducers: [] }]);
  assert.equal(socket.toRooms.length, 1);
  assert.equal(socket.toRooms[0].roomId, VALID_ROOM_ID);
  assert.equal(socket.toRooms[0].event, 'call:group-peer-joined');
});

test('call:group-join báo call:group-active khi là người đầu tiên vào phòng', async (t) => {
  t.mock.method(Room, 'findOne', () => ({ select: async () => ({ _id: VALID_ROOM_ID }) }));
  t.mock.method(sfu, 'joinRoom', async () => ({ rtpCapabilities: {} }));
  t.mock.method(sfu, 'listOtherProducers', () => []);
  t.mock.method(sfu, 'getParticipantCount', () => 1);
  const socket = mockSocket('socket-1', { _id: 'user-1' });
  registerGroupCallHandlers({}, socket);

  await socket.trigger('call:group-join', { roomId: VALID_ROOM_ID }, () => {});

  const activeEvents = socket.toRooms.filter(e => e.event === 'call:group-active');
  assert.deepEqual(activeEvents, [{ roomId: VALID_ROOM_ID, event: 'call:group-active', payload: { roomId: VALID_ROOM_ID } }]);
});

test('call:group-join không báo lại call:group-active khi phòng đã có người', async (t) => {
  t.mock.method(Room, 'findOne', () => ({ select: async () => ({ _id: VALID_ROOM_ID }) }));
  t.mock.method(sfu, 'joinRoom', async () => ({ rtpCapabilities: {} }));
  t.mock.method(sfu, 'listOtherProducers', () => []);
  t.mock.method(sfu, 'getParticipantCount', () => 2);
  const socket = mockSocket('socket-2', { _id: 'user-2' });
  registerGroupCallHandlers({}, socket);

  await socket.trigger('call:group-join', { roomId: VALID_ROOM_ID }, () => {});

  assert.deepEqual(socket.toRooms.filter(e => e.event === 'call:group-active'), []);
});

test('call:group-leave báo call:group-ended khi là người cuối cùng rời', async (t) => {
  t.mock.method(Room, 'findOne', () => ({ select: async () => ({ _id: VALID_ROOM_ID }) }));
  t.mock.method(sfu, 'joinRoom', async () => ({ rtpCapabilities: {} }));
  t.mock.method(sfu, 'listOtherProducers', () => []);
  t.mock.method(sfu, 'leaveRoom', () => {});
  t.mock.method(sfu, 'getParticipantCount', () => 0);
  const socket = mockSocket('socket-1', { _id: 'user-1' });
  registerGroupCallHandlers({}, socket);
  await socket.trigger('call:group-join', { roomId: VALID_ROOM_ID }, () => {});
  socket.toRooms.length = 0;

  socket.trigger('call:group-leave', { roomId: VALID_ROOM_ID });

  const endedEvents = socket.toRooms.filter(e => e.event === 'call:group-ended');
  assert.deepEqual(endedEvents, [{ roomId: VALID_ROOM_ID, event: 'call:group-ended', payload: { roomId: VALID_ROOM_ID } }]);
});

test('call:group-leave không báo call:group-ended khi phòng còn người khác', async (t) => {
  t.mock.method(Room, 'findOne', () => ({ select: async () => ({ _id: VALID_ROOM_ID }) }));
  t.mock.method(sfu, 'joinRoom', async () => ({ rtpCapabilities: {} }));
  t.mock.method(sfu, 'listOtherProducers', () => []);
  t.mock.method(sfu, 'leaveRoom', () => {});
  t.mock.method(sfu, 'getParticipantCount', () => 1);
  const socket = mockSocket('socket-1', { _id: 'user-1' });
  registerGroupCallHandlers({}, socket);
  await socket.trigger('call:group-join', { roomId: VALID_ROOM_ID }, () => {});
  socket.toRooms.length = 0;

  socket.trigger('call:group-leave', { roomId: VALID_ROOM_ID });

  assert.deepEqual(socket.toRooms.filter(e => e.event === 'call:group-ended'), []);
});

test('call:group-produce bị chặn nếu chưa join phòng qua chính socket này', async (t) => {
  const produceSpy = t.mock.method(sfu, 'produce', async () => 'producer-x');
  const socket = mockSocket('socket-1', { _id: 'user-1' });
  registerGroupCallHandlers({}, socket);

  await socket.trigger('call:group-produce', {
    roomId: VALID_ROOM_ID, transportId: 't1', kind: 'video', rtpParameters: {},
  });

  assert.equal(produceSpy.mock.calls.length, 0);
});

test('disconnect dọn hết các phòng đã join và báo peer-left', async (t) => {
  t.mock.method(Room, 'findOne', () => ({ select: async () => ({ _id: VALID_ROOM_ID }) }));
  t.mock.method(sfu, 'joinRoom', async () => ({ rtpCapabilities: {} }));
  t.mock.method(sfu, 'listOtherProducers', () => []);
  const leaveSpy = t.mock.method(sfu, 'leaveRoom', () => {});
  const socket = mockSocket('socket-1', { _id: 'user-1' });
  registerGroupCallHandlers({}, socket);

  await socket.trigger('call:group-join', { roomId: VALID_ROOM_ID }, () => {});
  await socket.trigger('disconnect');

  assert.equal(leaveSpy.mock.calls.length, 1);
  const peerLeftEvents = socket.toRooms.filter(e => e.event === 'call:group-peer-left');
  assert.equal(peerLeftEvents.length, 1);
});
