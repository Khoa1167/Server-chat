const crypto = require('crypto');

const STUN_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];
const CREDENTIAL_TTL_SECONDS = 60 * 60;

function turnUrls() {
  return (process.env.TURN_URLS || '').split(',').map(url => url.trim()).filter(Boolean);
}

function getCallIceServers(userId, now = Date.now()) {
  const urls = turnUrls();
  const secret = process.env.TURN_SHARED_SECRET;
  const iceServers = [...STUN_SERVERS];
  if (!urls.length || !secret) return iceServers;

  const username = `${Math.floor(now / 1000) + CREDENTIAL_TTL_SECONDS}:${userId}`;
  const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');
  iceServers.push({ urls, username, credential });
  return iceServers;
}

module.exports = { getCallIceServers };
