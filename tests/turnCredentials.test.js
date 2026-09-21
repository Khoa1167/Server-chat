const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { getCallIceServers } = require('../src/services/turnCredentials.service');

test('issues a short-lived coturn credential without exposing its shared secret', (t) => {
  const oldUrls = process.env.TURN_URLS;
  const oldSecret = process.env.TURN_SHARED_SECRET;
  t.after(() => {
    if (oldUrls === undefined) delete process.env.TURN_URLS;
    else process.env.TURN_URLS = oldUrls;
    if (oldSecret === undefined) delete process.env.TURN_SHARED_SECRET;
    else process.env.TURN_SHARED_SECRET = oldSecret;
  });
  process.env.TURN_URLS = 'turn:relay.example:3478?transport=udp, turns:relay.example:5349';
  process.env.TURN_SHARED_SECRET = 'test-shared-secret';

  const now = Date.UTC(2026, 0, 1);
  const iceServers = getCallIceServers('user-123', now);
  const turn = iceServers.at(-1);
  const expectedUsername = `${Math.floor(now / 1000) + 3600}:user-123`;
  assert.deepEqual(turn.urls, ['turn:relay.example:3478?transport=udp', 'turns:relay.example:5349']);
  assert.equal(turn.username, expectedUsername);
  assert.equal(turn.credential, crypto.createHmac('sha1', 'test-shared-secret').update(expectedUsername).digest('base64'));
});
