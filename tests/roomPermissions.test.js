const assert = require('node:assert/strict');
const test = require('node:test');
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
const { hasRoomPermission, ROOM_PERMISSIONS } = require('../src/services/rooms.service');

test('owner and admin inherit both room permissions; members need a grant', () => {
  const room = {
    isDM: false,
    createdBy: 'owner',
    admins: ['admin'],
    grantedPermissions: new Map([['member', [ROOM_PERMISSIONS.PIN_MESSAGES]]]),
  };

  for (const key of Object.values(ROOM_PERMISSIONS)) {
    assert.equal(hasRoomPermission(room, 'owner', key), true);
    assert.equal(hasRoomPermission(room, 'admin', key), true);
  }
  assert.equal(hasRoomPermission(room, 'member', ROOM_PERMISSIONS.PIN_MESSAGES), true);
  assert.equal(hasRoomPermission(room, 'member', ROOM_PERMISSIONS.CREATE_POLLS), false);
  assert.equal(hasRoomPermission(room, 'other', ROOM_PERMISSIONS.PIN_MESSAGES), false);
  room.isDM = true;
  assert.equal(hasRoomPermission(room, 'admin', ROOM_PERMISSIONS.PIN_MESSAGES), true);
  assert.equal(hasRoomPermission(room, 'admin', ROOM_PERMISSIONS.CREATE_POLLS), false);
});
