const mongoose = require('mongoose');
const AiConversation = require('../models/AiConversation');
const AiMessage = require('../models/AiMessage');
const AppError = require('../utils/AppError');

const serializeConversation = (conversation) => ({
  id: conversation._id.toString(),
  clientConversationId: conversation.clientConversationId,
  keyEnvelopes: conversation.keyEnvelopes instanceof Map
    ? Object.fromEntries(conversation.keyEnvelopes)
    : conversation.keyEnvelopes,
  cryptoVersion: conversation.cryptoVersion,
  lastMessageAt: conversation.lastMessageAt,
  createdAt: conversation.createdAt,
});

const listConversations = async (userId) => {
  const conversations = await AiConversation.find({ owner: userId, expiresAt: { $gt: new Date() } })
    .sort({ lastMessageAt: -1, _id: -1 })
    .limit(50);
  return conversations.map(serializeConversation);
};

const createConversation = async (currentUser, deviceId, payload) => {
  const allowedKeyIds = new Set(currentUser.devices
    .filter((device) => !device.isRevoked)
    .map((device) => device.e2eeKeyId || device.deviceId));
  const currentDevice = currentUser.devices.find((device) => device.deviceId === deviceId && !device.isRevoked);
  const currentKeyId = currentDevice?.e2eeKeyId || currentDevice?.deviceId;
  if (!currentKeyId || !payload.keyEnvelopes[currentKeyId]
    || Object.keys(payload.keyEnvelopes).some((keyId) => !allowedKeyIds.has(keyId))) {
    throw new AppError('Danh sách khóa thiết bị không hợp lệ', 400, { code: 'INVALID_AI_KEY_ENVELOPES' });
  }

  const conversation = await AiConversation.findOneAndUpdate(
    { owner: currentUser._id, clientConversationId: payload.clientConversationId },
    { $setOnInsert: { keyEnvelopes: payload.keyEnvelopes, cryptoVersion: 1 } },
    { upsert: true, new: true, runValidators: true },
  );
  return serializeConversation(conversation);
};

const getOwnedConversation = async (userId, conversationId) => {
  if (!mongoose.Types.ObjectId.isValid(conversationId)) throw new AppError('Cuộc trò chuyện không hợp lệ', 400);
  const conversation = await AiConversation.findOne({ _id: conversationId, owner: userId, expiresAt: { $gt: new Date() } });
  if (!conversation) throw new AppError('Không tìm thấy cuộc trò chuyện', 404);
  return conversation;
};

const listMessages = async (userId, conversationId, cursor) => {
  await getOwnedConversation(userId, conversationId);
  const query = { owner: userId, conversation: conversationId, expiresAt: { $gt: new Date() } };
  if (cursor) {
    if (!mongoose.Types.ObjectId.isValid(cursor)) throw new AppError('Con trỏ không hợp lệ', 400);
    query._id = { $lt: cursor };
  }
  const rows = await AiMessage.find(query).sort({ _id: -1 }).limit(51);
  const page = rows.slice(0, 50);
  const nextCursor = rows.length > 50 ? page.at(-1)._id.toString() : null;
  return {
    items: [...page].reverse().map((message) => ({
      id: message._id.toString(),
      clientMessageId: message.clientMessageId,
      ciphertext: message.ciphertext,
      iv: message.iv,
      cryptoVersion: message.cryptoVersion,
      createdAt: message.createdAt,
    })),
    nextCursor,
  };
};

const saveMessage = async (userId, conversationId, payload) => {
  const conversation = await getOwnedConversation(userId, conversationId);
  const message = await AiMessage.findOneAndUpdate(
    { owner: userId, clientMessageId: payload.clientMessageId },
    { $setOnInsert: { conversation: conversation._id, ...payload, cryptoVersion: 1 } },
    { upsert: true, new: true, runValidators: true },
  );
  if (message.conversation.toString() !== conversation._id.toString()) {
    throw new AppError('Mã tin nhắn đã được sử dụng', 409);
  }
  conversation.lastMessageAt = new Date();
  conversation.expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await conversation.save();
  return { id: message._id.toString(), clientMessageId: message.clientMessageId };
};

const deleteConversation = async (userId, conversationId) => {
  const conversation = await getOwnedConversation(userId, conversationId);
  await AiMessage.deleteMany({ owner: userId, conversation: conversation._id });
  await AiConversation.deleteOne({ _id: conversation._id, owner: userId });
};

const deleteAll = async (userId) => {
  await Promise.all([
    AiMessage.deleteMany({ owner: userId }),
    AiConversation.deleteMany({ owner: userId }),
  ]);
};

module.exports = { listConversations, createConversation, listMessages, saveMessage, deleteConversation, deleteAll };
