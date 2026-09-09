const COOKIE_NAME = 'token';

// docker-compose demo chạy HTTP dù NODE_ENV=production nên không suy secure thẳng từ đó —
// COOKIE_SECURE override rõ ràng, mặc định theo NODE_ENV khi không set.
const isSecure = process.env.COOKIE_SECURE
  ? process.env.COOKIE_SECURE === 'true'
  : process.env.NODE_ENV === 'production';

// Cookie phiên (không maxAge/expires, tự xóa khi đóng trình duyệt), httpOnly chống XSS đọc được.
const setAuthCookie = (res, token) => {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: isSecure,
    sameSite: 'lax',
    path: '/',
  });
};

const clearAuthCookie = (res) => {
  res.clearCookie(COOKIE_NAME, { path: '/' });
};

module.exports = { setAuthCookie, clearAuthCookie, isSecure };
