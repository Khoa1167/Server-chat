const assert = require('node:assert/strict');
const test = require('node:test');
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
const Block = require('../src/models/Block');
const Friendship = require('../src/models/Friendship');
const User = require('../src/models/User');
const Room = require('../src/models/Room');
const { isBlocked } = require('../src/services/blocks.service');
const { blockUser, sendFriendRequest, getDmRoom, acceptFriendRequest, searchUsers } = require('../src/services/friends.service');
const { createRoom, inviteFriend, approveJoinRequest } = require('../src/services/rooms.service');
const registerCallHandlers = require('../src/socket/handlers/call.handler');
const registerMessageHandlers = require('../src/socket/handlers/message.handler');

test('block predicate checks both directions', async (t) => {
  t.mock.method(Block, 'exists', async (query) => {
    assert.deepEqual(query.$or, [
      { blocker: 'a', blocked: 'b' },
      { blocker: 'b', blocked: 'a' },
    ]);
    return { _id: 'block' };
  });
  assert.ok(await isBlocked('a', 'b'));
});

test('blocking cancels a pending friend request and notifies both parties', async (t) => {
  const actions = [];
  t.mock.method(User, 'exists', async () => true);
  t.mock.method(Block, 'updateOne', async () => { actions.push('block'); });
  t.mock.method(Friendship, 'findOneAndDelete', async (query) => {
    assert.equal(query.status, 'pending');
    actions.push('remove pending request');
    return { _id: 'friendship' };
  });
  const sockets = ['a', 'b'].map(id => ({ data: { user: { _id: id } }, emit(event) { actions.push(`${id}:${event}`); } }));
  await blockUser('a', 'b', { fetchSockets: async () => sockets });
  assert.deepEqual(actions, ['block', 'remove pending request', 'a:friend:request_cancelled', 'b:friend:request_cancelled']);
});

test('blocking keeps an existing accepted friendship intact', async (t) => {
  const actions = [];
  t.mock.method(User, 'exists', async () => true);
  t.mock.method(Block, 'updateOne', async () => { actions.push('block'); });
  // Query thật lọc status:'pending' — friendship accepted không khớp nên Mongo không xóa gì, trả null.
  t.mock.method(Friendship, 'findOneAndDelete', async () => null);
  const sockets = ['a', 'b'].map(id => ({ data: { user: { _id: id } }, emit(event) { actions.push(`${id}:${event}`); } }));
  await blockUser('a', 'b', { fetchSockets: async () => sockets });
  assert.deepEqual(actions, ['block']);
});

test('blocked users cannot send friend requests or ring a receiver', async (t) => {
  t.mock.method(User, 'findById', () => ({ select: () => Promise.resolve({ isDeleted: false }) }));
  t.mock.method(Block, 'exists', async () => ({ _id: 'block' }));
  await assert.rejects(sendFriendRequest('a', 'b'), { statusCode: 403 });

  t.mock.method(Friendship, 'exists', async () => ({ _id: 'friendship' }));
  const handlers = new Map();
  const emitted = [];
  const socket = {
    user: { _id: 'a' },
    on(event, handler) { handlers.set(event, handler); },
    emit(event, payload) { emitted.push({ event, payload }); },
  };
  registerCallHandlers({ fetchSockets: async () => { throw new Error('must not relay'); } }, socket);
  await handlers.get('call:request')({ receiverId: 'b', signalData: {}, type: 'audio' });
  assert.deepEqual(emitted, [{ event: 'call:failed', payload: { receiverId: 'b', reason: 'not_allowed' } }]);
});

test('blocked users cannot open a DM or accept a pending request', async (t) => {
  t.mock.method(Block, 'exists', async () => ({ _id: 'block' }));
  t.mock.method(Friendship, 'findOne', async () => ({
    sender: 'a', receiver: 'b',
    async save() { throw new Error('must not accept'); },
  }));
  await assert.rejects(getDmRoom('a', 'b'), { statusCode: 403 });
  await assert.rejects(acceptFriendRequest('request', 'b'), { statusCode: 403 });
});

test('blocked or unfriended users cannot relay a message through an existing DM room', async (t) => {
  const handlers = new Map();
  const emitted = [];
  let blocked = true;
  t.mock.method(Room, 'findOne', async () => ({ isDM: true, members: ['a', 'b'] }));
  t.mock.method(Block, 'exists', async () => blocked ? { _id: 'block' } : null);
  t.mock.method(Friendship, 'exists', async () => null);
  const socket = {
    user: { _id: 'a' }, data: { deviceId: 'device' },
    on(event, handler) { handlers.set(event, handler); },
    emit(event, payload) { emitted.push({ event, payload }); },
  };
  registerMessageHandlers({}, socket);
  await handlers.get('message:send')({ roomId: 'room', type: 'text' });
  assert.equal(emitted[0].payload.code, 'DM_NOT_ALLOWED');
  blocked = false;
  await handlers.get('message:send')({ roomId: 'room', type: 'text' });
  assert.equal(emitted[1].payload.code, 'DM_NOT_ALLOWED');
});

test('searching users excludes people blocked in either direction', async (t) => {
  const blockDocs = [
    { blocker: 'me', blocked: 'blocked-by-me' },
    { blocker: 'blocked-me', blocked: 'me' },
  ];
  t.mock.method(Block, 'find', () => ({ select: () => ({ lean: async () => blockDocs }) }));
  let capturedQuery;
  t.mock.method(User, 'find', (query) => {
    capturedQuery = query;
    return { select: () => ({ limit: () => ({ lean: async () => [] }) }) };
  });
  // getFriendIdSet() (chạy nội bộ trong searchUsers, xem presenceVisibility.js) await trực tiếp
  // Friendship.find(...).select(...) rồi .forEach() luôn — không qua .lean(). Trả mảng rỗng có gắn
  // thêm .lean() để cùng lúc đáp ứng cả 2 kiểu gọi (searchUsers tự gọi .select().lean() riêng).
  t.mock.method(Friendship, 'find', () => ({
    select: () => {
      const rows = [];
      rows.lean = async () => rows;
      return rows;
    },
  }));

  await searchUsers('me', 'query');

  assert.deepEqual([...capturedQuery._id.$nin].sort(), ['blocked-by-me', 'blocked-me', 'me'].sort());
});

test('creating a room rejects an initial member who is blocked', async (t) => {
  t.mock.method(Block, 'exists', async () => ({ _id: 'block' }));
  const createSpy = t.mock.method(Room, 'create', async () => { throw new Error('must not create'); });

  await assert.rejects(
    createRoom({ name: 'Nhóm', members: ['blocked-user'] }, 'creator', null),
    { statusCode: 403 }
  );
  assert.equal(createSpy.mock.calls.length, 0);
});

test('inviting a blocked user into a group is rejected before the friendship check', async (t) => {
  const room = { _id: 'room', isDM: false, createdBy: 'owner', members: ['owner'], pendingInvites: [] };
  t.mock.method(Room, 'findById', async () => room);
  t.mock.method(Block, 'exists', async () => ({ _id: 'block' }));
  const friendshipSpy = t.mock.method(Friendship, 'findOne', async () => { throw new Error('must not check friendship'); });

  await assert.rejects(
    inviteFriend('room', { _id: 'owner' }, 'target', null),
    { statusCode: 403 }
  );
  assert.equal(friendshipSpy.mock.calls.length, 0);
});

test('approving a join request from a blocked user is rejected', async (t) => {
  const room = {
    _id: 'room', createdBy: 'admin', admins: [], members: ['admin'],
    pendingRequests: ['target'], memberJoinedAt: new Map(), save: async () => {},
  };
  t.mock.method(Room, 'findById', async () => room);
  t.mock.method(User, 'findById', () => ({ select: () => Promise.resolve({ _id: 'target' }) }));
  t.mock.method(Block, 'exists', async () => ({ _id: 'block' }));

  await assert.rejects(
    approveJoinRequest('room', 'admin', 'target', null),
    { statusCode: 403 }
  );
  assert.equal(room.members.length, 1);
});
