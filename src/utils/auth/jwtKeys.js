const jwt = require('jsonwebtoken');

// Không xoay vòng key (khác ENCRYPTION_KEY) — JWT giờ chỉ phục vụ token sống rất ngắn (15m/10m),
// đổi JWT_SECRET chỉ mồ côi vài token đang treo, không đáng giữ keyring như trước.
const secret = process.env.JWT_SECRET;
if (!secret) {
  throw new Error('Thiếu JWT_SECRET trong .env — bắt buộc để ký/xác thực JWT.');
}

const signJwt = (payload, options = {}) => jwt.sign(payload, secret, options);

// Chỉ chấp nhận đúng thuật toán đang dùng — chặn algorithm confusion attack.
const ALLOWED_ALGORITHMS = ['HS256'];

const verifyJwt = (token) => jwt.verify(token, secret, { algorithms: ALLOWED_ALGORITHMS });

module.exports = { signJwt, verifyJwt };
