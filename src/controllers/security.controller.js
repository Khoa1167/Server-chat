const securityService = require('../services/security.service');
const { checkRateWindow } = require('../utils/rateLimiter');

const NS_CHECK_LINK_USER = 'check-link-user';
const NS_CHECK_LINK_IP = 'check-link-ip';

exports.checkLink = async (req, res) => {
  try {
    const { url } = req.body;
    if (typeof url !== 'string' || !url || url.length > 2048) {
      return res.status(400).json({ message: 'Thiếu URL cần kiểm tra' });
    }

    const userId = req.user._id.toString();
    const [userLimit, ipLimit] = await Promise.all([
      checkRateWindow(NS_CHECK_LINK_USER, userId, { maxCount: 100, windowMs: 60 * 60 * 1000 }),
      checkRateWindow(NS_CHECK_LINK_IP, req.ip, { maxCount: 300, windowMs: 60 * 60 * 1000 }),
    ]);
    if (userLimit.limited || ipLimit.limited) {
      const retryAfterMs = Math.max(userLimit.retryAfterMs || 0, ipLimit.retryAfterMs || 0);
      res.set('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
      return res.status(429).json({ safe: true, unknown: true, message: 'Bạn đã dùng hết lượt kiểm tra liên kết, hãy thử lại sau.' });
    }

    const result = await securityService.checkLinkSafety(url, req.log);
    res.json(result);
  } catch (err) {
    req.log.error({ err }, 'Check link error');
    res.json({ safe: true }); // Fallback an toàn, không crash app
  }
};
