const transcriptionService = require('../services/transcription');
const handleError = require('../utils/handleError');
const { checkRateWindow } = require('../utils/rateLimiter');

const NS_TRANSCRIBE_USER = 'transcribe-user';
const NS_TRANSCRIBE_IP = 'transcribe-ip';

exports.transcribe = async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'Thiếu file audio' });

  const [userLimit, ipLimit] = await Promise.all([
    checkRateWindow(NS_TRANSCRIBE_USER, req.user._id.toString(), { maxCount: 20, windowMs: 24 * 60 * 60 * 1000 }),
    checkRateWindow(NS_TRANSCRIBE_IP, req.ip, { maxCount: 60, windowMs: 24 * 60 * 60 * 1000 }),
  ]);
  if (userLimit.limited || ipLimit.limited) {
    const retryAfterMs = Math.max(userLimit.retryAfterMs || 0, ipLimit.retryAfterMs || 0);
    res.set('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
    return res.status(429).json({ message: 'Bạn đã dùng hết lượt chuyển giọng nói hôm nay.' });
  }

  try {
    const result = await transcriptionService.transcribeAudio(req.file.buffer, req.log);
    res.json(result);
  } catch (err) {
    handleError(res, err);
  }
};
