const assert = require('node:assert/strict');
const test = require('node:test');
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
const Room = require('../src/models/Room');
const User = require('../src/models/User');
const deviceKeysCache = require('../src/utils/deviceKeysCache');
const { getRoomDevices, getUserDevices } = require('../src/services/users.service');

test('room device lookup uses current server membership', async (t) => {
  const callerId = 'caller';
  const currentMemberId = 'current-member';
  t.mock.method(Room, 'findOne', query => {
    assert.deepEqual(query, { _id: 'room', members: callerId });
    return { select: async () => ({ members: [callerId, currentMemberId] }) };
  });
  t.mock.method(User, 'find', query => {
    assert.deepEqual(query, { _id: { $in: [callerId, currentMemberId] } });
    return {
      select: async () => [
        { _id: callerId, devices: [{ deviceId: 'caller-device', publicKey: { kty: 'EC' } }] },
        { _id: currentMemberId, devices: [{ deviceId: 'member-device', publicKey: { kty: 'EC' } }] },
      ],
    };
  });

  const devices = await getRoomDevices(callerId, 'room');
  assert.deepEqual(devices.map(device => device.deviceId), ['caller-device', 'member-device']);
});

test('room device lookup denies a caller outside the room', async (t) => {
  t.mock.method(Room, 'findOne', () => ({ select: async () => null }));
  await assert.rejects(
    () => getRoomDevices('outside-caller', 'room'),
    error => error.statusCode === 403,
  );
});

test('user device lookup refreshes old cache and returns registration times', async (t) => {
  t.mock.method(Room, 'exists', async () => true);
  t.mock.method(deviceKeysCache, 'get', async () => [{ deviceId: 'old', publicKey: 'old-key' }]);
  t.mock.method(deviceKeysCache, 'set', async (_id, devices) => devices);
  t.mock.method(User, 'findById', () => ({
    select: async () => ({
      _id: 'contact',
      devices: [
        { deviceId: 'old', publicKey: 'old-key', registeredAt: new Date('2026-01-01') },
        { deviceId: 'new', publicKey: 'new-key', registeredAt: new Date('2026-02-01') },
      ],
    }),
  }));

  const devices = await getUserDevices('caller', 'contact');
  assert.deepEqual(devices.map(d => d.registeredAt), [new Date('2026-01-01'), new Date('2026-02-01')]);
});
