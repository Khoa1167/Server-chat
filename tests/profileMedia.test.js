const assert = require('node:assert/strict');
const test = require('node:test');
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.JWT_SECRET ||= 'test-only-placeholder-jwt-secret';

const User = require('../src/models/User');
const { removeAvatar } = require('../src/services/auth.service');

test('removeAvatar xóa avatar và đặt cooldown', async (t) => {
  const updated = { _id: 'u1', avatar: '', avatarChangedAt: new Date() };
  t.mock.method(User, 'findByIdAndUpdate', async (id, changes) => {
    assert.equal(id, 'u1');
    assert.equal(changes.avatar, '');
    assert.ok(changes.avatarChangedAt instanceof Date);
    return updated;
  });

  assert.equal(await removeAvatar({ _id: 'u1', avatar: '' }), updated);
});

test('removeAvatar chặn khi avatar vừa thay trong 24 giờ', async () => {
  await assert.rejects(
    removeAvatar({ _id: 'u1', avatar: '', avatarChangedAt: new Date() }),
    { statusCode: 400 }
  );
});
