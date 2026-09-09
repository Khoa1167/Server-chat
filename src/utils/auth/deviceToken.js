const crypto = require('crypto');

// Token thiết bị: chuỗi ngẫu nhiên opaque (không phải JWT) — server chỉ lưu/so khớp hash.
const generateDeviceToken = () => crypto.randomBytes(32).toString('base64url');
const hashDeviceToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

module.exports = { generateDeviceToken, hashDeviceToken };
