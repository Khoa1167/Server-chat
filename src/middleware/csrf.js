const crypto = require('crypto');
const cookie = require('cookie');
const { isSecure } = require('../utils/auth/authCookie');

// Parse header Cookie thô thành req.cookies — thay cookie-parser (package "cookie" đã có
// sẵn qua Express, không cần thêm dependency chỉ để làm việc này).
function parseCookies(req, res, next) {
  req.cookies = cookie.parse(req.headers.cookie || '');
  next();
}

const CSRF_COOKIE_NAME = 'csrf_token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Double-submit cookie: cấp giá trị ngẫu nhiên qua cookie không httpOnly cho MỌI request, kể cả chưa đăng nhập.
function issueCsrfCookie(req, res, next) {
  if (!req.cookies?.[CSRF_COOKIE_NAME]) {
    const token = crypto.randomBytes(32).toString('base64url');
    res.cookie(CSRF_COOKIE_NAME, token, { httpOnly: false, secure: isSecure, sameSite: 'lax', path: '/' });
    req.cookies = { ...req.cookies, [CSRF_COOKIE_NAME]: token };
  }
  next();
}

// Đứng độc lập, không gộp vào protect — route mutate không qua protect (login...) vẫn cần chặn CSRF.
function verifyCsrf(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  const header = req.headers['x-csrf-token'];
  if (!header || header !== req.cookies?.[CSRF_COOKIE_NAME]) {
    return res.status(403).json({ message: 'Thiếu hoặc sai CSRF token' });
  }
  next();
}

module.exports = { parseCookies, issueCsrfCookie, verifyCsrf };
