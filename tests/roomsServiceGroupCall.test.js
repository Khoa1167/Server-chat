const assert = require('node:assert/strict');
const test = require('node:test');

// rooms.service.js require User model, và User model require utils/crypto.js — file đó crash
// ngay lúc require() nếu thiếu ENCRYPTION_KEY (chủ đích, không fallback hard-code trong code thật).
// Không file test nào khác chạm tới chain này trước giờ nên chưa lộ ra — set placeholder riêng cho
// tiến trình test, không phải giá trị thật, không đụng .env hay code nguồn.
process.env.ENCRYPTION_KEY ||= 'test-only-placeholder-key-not-used-for-real-data';

const Room = require('../src/models/Room');
const roomsListCache = require('../src/utils/roomsListCache');
const sfu = require('../src/services/sfu.service');
const { leaveRoom } = require('../src/services/rooms.service');

const ROOM_ID = '507f1f77bcf86cd799439011';
const LEAVER_ID = 'user-leaving';
const REMAINING_ID = 'user-remaining';

function makeRoomDoc() {
  return {
    _id: ROOM_ID,
    isDM: false,
    members: [LEAVER_ID, REMAINING_ID],
    admins: [REMAINING_ID],
    createdBy: REMAINING_ID,
    grantedPermissions: new Map(),
    save: async function () { return this; },
  };
}

function mockIo(t) {
  const toEmits = [];
  return {
    fetchSockets: async () => [],
    to: (roomId) => ({ emit: (event, payload) => toEmits.push({ roomId, event, payload }) }),
    toEmits,
  };
}

test('rời phòng trong lúc đang gọi nhóm thì ngắt khỏi SFU và báo call:group-peer-left', async (t) => {
  t.mock.method(Room, 'findById', async () => makeRoomDoc());
  t.mock.method(Room, 'findByIdAndUpdate', async () => ({ senderKeyEpoch: 1 }));
  t.mock.method(roomsListCache, 'invalidate', async () => {});
  const forceLeaveSpy = t.mock.method(sfu, 'forceLeaveRoomForUser', () => ['socket-1']);
  const io = mockIo(t);

  await leaveRoom(ROOM_ID, LEAVER_ID, null, io);

  assert.equal(forceLeaveSpy.mock.calls.length, 1);
  assert.deepEqual(forceLeaveSpy.mock.calls[0].arguments, [ROOM_ID, LEAVER_ID]);
  const peerLeftEvents = io.toEmits.filter(e => e.event === 'call:group-peer-left');
  assert.deepEqual(peerLeftEvents, [{ roomId: ROOM_ID, event: 'call:group-peer-left', payload: { userId: LEAVER_ID } }]);
});

test('rời phòng khi không trong cuộc gọi nhóm thì không báo call:group-peer-left thừa', async (t) => {
  t.mock.method(Room, 'findById', async () => makeRoomDoc());
  t.mock.method(Room, 'findByIdAndUpdate', async () => ({ senderKeyEpoch: 1 }));
  t.mock.method(roomsListCache, 'invalidate', async () => {});
  t.mock.method(sfu, 'forceLeaveRoomForUser', () => []);
  const io = mockIo(t);

  await leaveRoom(ROOM_ID, LEAVER_ID, null, io);

  const peerLeftEvents = io.toEmits.filter(e => e.event === 'call:group-peer-left');
  assert.deepEqual(peerLeftEvents, []);
});
