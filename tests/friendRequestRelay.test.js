const assert = require('node:assert/strict');
const test = require('node:test');
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
const Friendship = require('../src/models/Friendship');
const Block = require('../src/models/Block');
const Notification = require('../src/models/Notification');
const { sendFriendRequest } = require('../src/services/friends.service');

test('friend request reaches every receiver device from the saved friendship', async (t) => {
  const friendship = {
    _id: 'request',
    sender: 'sender',
    receiver: 'receiver',
    async populate() { return this; },
  };
  t.mock.method(Friendship, 'findOne', async () => null);
  t.mock.method(Block, 'exists', async () => null);
  t.mock.method(Friendship, 'create', async () => friendship);
  t.mock.method(Notification, 'create', async () => ({ async populate() {} }));

  const socket = id => ({
    data: { user: { _id: id } },
    events: [],
    emit(event, payload) { this.events.push({ event, payload }); },
  });
  const web = socket('receiver');
  const phone = socket('receiver');
  const sender = socket('sender');
  const stranger = socket('stranger');
  const io = { fetchSockets: async () => [web, phone, sender, stranger] };

  const result = await sendFriendRequest('sender', 'receiver', io);

  assert.equal(result.friendship, friendship);
  assert.equal(result.isNew, true);
  for (const receiver of [web, phone]) {
    assert.deepEqual(receiver.events.map(e => e.event), ['notification:new', 'friend:request_received']);
    assert.equal(receiver.events[1].payload, friendship);
  }
  assert.deepEqual(sender.events, []);
  assert.deepEqual(stranger.events, []);
});
