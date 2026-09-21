const assert = require('node:assert/strict');
const test = require('node:test');
const mediasoupConfig = require('../src/config/mediasoup');
const sfu = require('../src/services/sfu.service');

function fakeProducer(kind) {
  return { id: 'producer-' + Math.random().toString(36).slice(2), kind, close() {} };
}

function fakeConsumer(kind) {
  return { id: 'consumer-' + Math.random().toString(36).slice(2), kind, rtpParameters: {}, resume: async () => {}, close() {} };
}

function fakeTransport() {
  return {
    id: 'transport-' + Math.random().toString(36).slice(2),
    iceParameters: {}, iceCandidates: [], dtlsParameters: {},
    on() {},
    connect: async () => {},
    produce: async ({ kind }) => fakeProducer(kind),
    consume: async ({ kind }) => fakeConsumer(kind || 'video'),
    close() {},
  };
}

let createRouterCallCount = 0;
function fakeRouter() {
  return {
    rtpCapabilities: { codecs: [] },
    createWebRtcTransport: async () => fakeTransport(),
    canConsume: () => true,
    close() {},
  };
}

function mockWorkerCreation(t, { delayed = true } = {}) {
  createRouterCallCount = 0;
  t.mock.method(mediasoupConfig, 'getNextWorker', () => ({
    createRouter: async () => {
      createRouterCallCount += 1;
      if (delayed) await new Promise(resolve => setImmediate(resolve));
      return fakeRouter();
    },
  }));
}

test('2 join đồng thời vào phòng chưa có cuộc gọi chỉ tạo đúng 1 Router', async (t) => {
  mockWorkerCreation(t);
  const roomId = 'room-race-' + Math.random();

  const [a, b] = await Promise.all([
    sfu.joinRoom(roomId, 'socket-a', 'user-a'),
    sfu.joinRoom(roomId, 'socket-b', 'user-b'),
  ]);

  assert.equal(createRouterCallCount, 1);
  assert.deepEqual(a.rtpCapabilities, b.rtpCapabilities);
  assert.equal(sfu.getParticipantCount(roomId), 2);

  sfu.leaveRoom(roomId, 'socket-a');
  sfu.leaveRoom(roomId, 'socket-b');
});

test('phòng đủ 20 người thì join thứ 21 bị từ chối', async (t) => {
  mockWorkerCreation(t, { delayed: false });
  const roomId = 'room-full-' + Math.random();

  for (let i = 0; i < 20; i++) {
    await sfu.joinRoom(roomId, `socket-${i}`, `user-${i}`);
  }
  assert.equal(sfu.getParticipantCount(roomId), 20);

  await assert.rejects(
    () => sfu.joinRoom(roomId, 'socket-21', 'user-21'),
    sfu.RoomFullError,
  );

  for (let i = 0; i < 20; i++) sfu.leaveRoom(roomId, `socket-${i}`);
});

test('người cuối cùng rời phòng thì đóng Router và xóa phòng khỏi state', async (t) => {
  mockWorkerCreation(t, { delayed: false });
  const roomId = 'room-cleanup-' + Math.random();

  await sfu.joinRoom(roomId, 'socket-a', 'user-a');
  await sfu.joinRoom(roomId, 'socket-b', 'user-b');
  sfu.leaveRoom(roomId, 'socket-a');
  assert.equal(sfu.getParticipantCount(roomId), 1);

  sfu.leaveRoom(roomId, 'socket-b');
  assert.equal(sfu.getParticipantCount(roomId), 0);
  assert.equal(sfu._rooms.has(roomId), false);
});

test('chỉ 1 người share màn hình/phòng tại 1 thời điểm', async (t) => {
  mockWorkerCreation(t, { delayed: false });
  const roomId = 'room-share-' + Math.random();

  await sfu.joinRoom(roomId, 'socket-a', 'user-a');
  await sfu.joinRoom(roomId, 'socket-b', 'user-b');

  sfu.startScreenShare(roomId, 'socket-a');
  assert.throws(() => sfu.startScreenShare(roomId, 'socket-b'), sfu.ScreenShareBusyError);

  sfu.stopScreenShare(roomId, 'socket-a');
  assert.doesNotThrow(() => sfu.startScreenShare(roomId, 'socket-b'));

  sfu.leaveRoom(roomId, 'socket-a');
  sfu.leaveRoom(roomId, 'socket-b');
});

test('forceLeaveRoomForUser ngắt đúng peer theo userId và không đụng người khác', async (t) => {
  mockWorkerCreation(t, { delayed: false });
  const roomId = 'room-force-leave-' + Math.random();

  await sfu.joinRoom(roomId, 'socket-a', 'user-a');
  await sfu.joinRoom(roomId, 'socket-b', 'user-b');

  const affected = sfu.forceLeaveRoomForUser(roomId, 'user-a');
  assert.deepEqual(affected, ['socket-a']);
  assert.equal(sfu.getParticipantCount(roomId), 1);

  assert.deepEqual(sfu.forceLeaveRoomForUser(roomId, 'user-does-not-exist'), []);
  assert.deepEqual(sfu.forceLeaveRoomForUser('room-not-exist', 'user-a'), []);

  sfu.leaveRoom(roomId, 'socket-b');
});

test('produce/consume trả về params hợp lệ và canConsume=false thì bị từ chối', async (t) => {
  mockWorkerCreation(t, { delayed: false });
  const roomId = 'room-media-' + Math.random();

  await sfu.joinRoom(roomId, 'socket-a', 'user-a');
  await sfu.joinRoom(roomId, 'socket-b', 'user-b');

  const transportA = await sfu.createWebRtcTransport(roomId, 'socket-a');
  await sfu.connectTransport(roomId, 'socket-a', transportA.id, {});
  const producerId = await sfu.produce(roomId, 'socket-a', transportA.id, 'video', {});

  const transportB = await sfu.createWebRtcTransport(roomId, 'socket-b');
  const consumerParams = await sfu.consume(roomId, 'socket-b', transportB.id, producerId, {});
  assert.equal(consumerParams.producerId, producerId);
  await sfu.resumeConsumer(roomId, 'socket-b', consumerParams.id);

  const room = sfu._rooms.get(roomId);
  t.mock.method(room.router, 'canConsume', () => false);
  await assert.rejects(() => sfu.consume(roomId, 'socket-b', transportB.id, producerId, {}));

  sfu.leaveRoom(roomId, 'socket-a');
  sfu.leaveRoom(roomId, 'socket-b');
});
