// Xác minh Cloudflare Turnstile (CAPTCHA) ở đăng ký/quên mật khẩu — chưa cấu hình secret key thì
// bỏ qua verify (dev local không cần tài khoản Cloudflare).
const logger = require('../../config/logger');

const verifyTurnstile = async (token, remoteip) => {
  const secretKey = process.env.CLOUDFLARE_TURNSTILE_SECRET_KEY;
  if (!secretKey) return true; // Chưa cấu hình — coi như không bật Turnstile

  if (!token) return false;

  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: secretKey, response: token, remoteip: remoteip || '' }),
      signal: AbortSignal.timeout(10000), // tránh treo request login/register phía trên nếu siteverify chậm
    });
    const data = await res.json();
    return !!data.success;
  } catch (err) {
    logger.error({ err }, 'Turnstile verify error');
    return false; // fail-closed khi lỗi mạng/Cloudflare gián đoạn
  }
};

module.exports = { verifyTurnstile };
