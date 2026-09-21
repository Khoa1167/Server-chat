const assert = require('node:assert/strict');
const test = require('node:test');
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
const Block = require('../src/models/Block');
const Friendship = require('../src/models/Friendship');
const User = require('../src/models/User');
const Room = require('../src/models/Room');
const { isBlocked } = require('../src/services/blocks.service');
const { blockUser, sendFriendRequest, getDmRoom, acceptFriendRequest } = require('../src/services/friends.service');
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

test('blocking removes an existing friendship before notifying both parties', async (t) => {
  const actions = [];
  t.mock.method(User, 'exists', async () => true);
  t.mock.method(Block, 'updateOne', async () => { actions.push('block'); });
  t.mock.method(Friendship, 'findOneAndDelete', async () => {
    actions.push('remove friendship');
    return { _id: 'friendship', status: 'accepted' };
  });
  const sockets = ['a', 'b'].map(id => ({ data: { user: { _id: id } }, emit(event) { actions.push(`${id}:${event}`); } }));
  await blockUser('a', 'b', { fetchSockets: async () => sockets });
  assert.deepEqual(actions, ['block', 'remove friendship', 'a:friend:unfriended', 'b:friend:unfriended']);
});

test('blocked users cannot send friend requests or ring a receiver', async (t) => {
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
