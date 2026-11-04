const { getApps, initializeApp, applicationDefault } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');
const PushSubscription = require('../models/PushSubscription');
const logger = require('../config/logger');

const INVALID_TOKEN_CODES = new Set([
  'messaging/invalid-registration-token',
  'messaging/registration-token-not-registered',
]);

function getFirebaseMessaging() {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) return null;
  try {
    const app = getApps()[0] || initializeApp({ credential: applicationDefault() });
    return getMessaging(app);
  } catch (err) {
    logger.warn({ err }, 'Không thể khởi tạo Firebase Cloud Messaging');
    return null;
  }
}

function buildMessagePush(roomId) {
  return {
    notification: { title: 'Chat App', body: 'Bạn có tin nhắn mới' },
    data: { type: 'message', roomId: String(roomId) },
    android: {
      priority: 'high',
      notification: { channelId: 'messages' },
    },
  };
}

async function sendRoomMessagePush(memberIds, senderId, roomId) {
  const recipientIds = memberIds.filter(id => id.toString() !== senderId.toString());
  if (!recipientIds.length) return;
  const messaging = getFirebaseMessaging();
  if (!messaging) return;

  const subscriptions = await PushSubscription.find({ user: { $in: recipientIds } }).select('+token').lean();
  if (!subscriptions.length) return;

  const response = await messaging.sendEachForMulticast({
    tokens: subscriptions.map(subscription => subscription.token),
    ...buildMessagePush(roomId),
  });
  const invalidTokens = response.responses
    .map((result, index) => (!result.success && INVALID_TOKEN_CODES.has(result.error?.code) ? subscriptions[index].token : null))
    .filter(Boolean);
  if (invalidTokens.length) await PushSubscription.deleteMany({ token: { $in: invalidTokens } });
}

module.exports = { buildMessagePush, sendRoomMessagePush };
