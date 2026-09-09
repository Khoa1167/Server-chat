const usersService = require('../services/users.service');
const handleError = require('../utils/handleError');
const { checkRateWindow } = require('../utils/rateLimiter');

const NS_GET_DEVICES = 'get-devices';

// Rate limit 60 req/phút/user — dùng chung cho cả 2 endpoint bên dưới
async function isDeviceRateLimited(callerId) {
  const limit = await checkRateWindow(NS_GET_DEVICES, callerId, { maxCount: 60, windowMs: 60000 });
  return limit.limited;
}

exports.getUserDevices = async (req, res) => {
  try {
    const callerId = req.user._id.toString();

    if (await isDeviceRateLimited(callerId)) {
      return res.status(429).json({ message: 'Quá nhiều yêu cầu truy vấn thiết bị' });
    }

    const activeDevices = await usersService.getUserDevices(callerId, req.params.userId);
    res.json(activeDevices);
  } catch (err) {
    handleError(res, err);
  }
};

exports.getUsersDevicesBatch = async (req, res) => {
  try {
    const callerId = req.user._id.toString();

    if (await isDeviceRateLimited(callerId)) {
      return res.status(429).json({ message: 'Quá nhiều yêu cầu truy vấn thiết bị' });
    }

    const { userIds } = req.body;
    if (!Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({ message: 'userIds phải là mảng không rỗng' });
    }

    const activeDevices = await usersService.getUsersDevicesBatch(callerId, userIds);
    res.json(activeDevices);
  } catch (err) {
    handleError(res, err);
  }
};
