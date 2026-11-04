const PushSubscription = require('../models/PushSubscription');
const AppError = require('../utils/AppError');

const isValidToken = token => typeof token === 'string' && token.length >= 20 && token.length <= 4096 && !/\s/.test(token);

async function registerPushSubscription(userId, deviceId, token) {
  if (!isValidToken(token)) throw new AppError('Token thông báo không hợp lệ', 400);

  const existing = await PushSubscription.findOne({ token }).select('+token');
  await PushSubscription.deleteMany({
    user: userId,
    deviceId,
    ...(existing ? { _id: { $ne: existing._id } } : {}),
  });
  await PushSubscription.findOneAndUpdate(
    { token },
    { $set: { user: userId, deviceId, token } },
    { upsert: true, setDefaultsOnInsert: true }
  );
}

const removePushSubscription = (userId, deviceId) => PushSubscription.deleteOne({ user: userId, deviceId });
const removeUserPushSubscriptions = userId => PushSubscription.deleteMany({ user: userId });

module.exports = { registerPushSubscription, removePushSubscription, removeUserPushSubscriptions };
