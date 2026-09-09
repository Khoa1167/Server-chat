const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PERIOD_SECONDS = 30;

function encodeBase32(buffer) {
  let bits = '';
  for (const byte of buffer) bits += byte.toString(2).padStart(8, '0');
  let output = '';
  for (let i = 0; i < bits.length; i += 5) {
    output += ALPHABET[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  }
  return output;
}

function decodeBase32(value) {
  let bits = '';
  for (const char of String(value).replace(/=+$/g, '').toUpperCase()) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new Error('TOTP secret không hợp lệ');
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function codeAtStep(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = crypto.createHmac('sha1', decodeBase32(secret)).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = (digest.readUInt32BE(offset) & 0x7fffffff) % 1000000;
  return binary.toString().padStart(6, '0');
}

function verifyTotp(secret, input, now = Date.now()) {
  const code = String(input || '').trim();
  if (!/^\d{6}$/.test(code)) return null;
  const currentStep = Math.floor(now / 1000 / PERIOD_SECONDS);
  for (const offset of [0, -1, 1]) {
    const step = currentStep + offset;
    const expected = codeAtStep(secret, step);
    if (crypto.timingSafeEqual(Buffer.from(code), Buffer.from(expected))) return step;
  }
  return null;
}

const generateTotpSecret = () => encodeBase32(crypto.randomBytes(20));

const buildTotpUri = (secret, username) => {
  const issuer = 'Chat Server';
  const label = `${issuer}:${username}`;
  return `otpauth://totp/${encodeURIComponent(label)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${PERIOD_SECONDS}`;
};

const generateRecoveryCodes = () => Array.from({ length: 10 }, () => {
  const raw = crypto.randomBytes(8).toString('hex').toUpperCase();
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12)}`;
});

const normalizeRecoveryCode = (value) => String(value || '').replace(/[^a-fA-F0-9]/g, '').toUpperCase();

module.exports = {
  generateTotpSecret,
  buildTotpUri,
  verifyTotp,
  generateRecoveryCodes,
  normalizeRecoveryCode,
};
