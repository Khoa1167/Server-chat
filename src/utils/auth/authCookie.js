const COOKIE_NAME = 'token';

// docker-compose demo chạy HTTP dù NODE_ENV=production nên không suy secure thẳng từ đó —
// COOKIE_SECURE override rõ ràng, mặc định theo NODE_ENV khi không set.
const isSecure = process.env.COOKIE_SECURE
  ? process.env.COOKIE_SECURE === 'true'
  : process.env.NODE_ENV === 'production';

const REMEMBER_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 ngày

// Mặc định cookie phiên (không maxAge, tự xóa khi đóng trình duyệt), httpOnly chống XSS đọc được.
// remember=true (user tự chọn "Ghi nhớ đăng nhập") mới kéo dài thành cookie 30 ngày.
const setAuthCookie = (res, token, remember = false) => {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: isSecure,
    sameSite: 'lax',
    path: '/',
    ...(remember ? { maxAge: REMEMBER_MAX_AGE_MS } : {}),
  });
};

const clearAuthCookie = (res) => {
  res.clearCookie(COOKIE_NAME, { path: '/' });
};

module.exports = { setAuthCookie, clearAuthCookie, isSecure };
