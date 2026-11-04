const mongoose = require('mongoose');
const AiConsentPolicy = require('../models/AiConsentPolicy');
const User = require('../models/User');
const AppError = require('../utils/AppError');

// Chính sách mặc định là cấu hình bắt buộc của sản phẩm, không phụ thuộc seed/database.
// Khi nội dung thay đổi phải đổi cả version và _id để người dùng xác nhận lại.
const DEFAULT_POLICY = Object.freeze({
  _id: new mongoose.Types.ObjectId('68e300000000000000000001'),
  version: 1,
  provider: 'Google Gemini',
  title: 'Trợ lý AI',
  notice: 'Nội dung bạn gửi cho Trợ lý AI sẽ được chuyển tới Google Gemini để xử lý và không được bảo vệ bằng mã hóa đầu cuối trong thời gian xử lý.',
  promptLabel: 'Bật Trợ lý AI',
  promptDescription: 'Cho phép gửi câu hỏi bạn chủ động nhập tới Google Gemini.',
  historyLabel: 'Dùng lịch sử trò chuyện AI',
  historyDescription: 'Gửi các lượt gần đây trong chính cuộc trò chuyện với Trợ lý AI để duy trì ngữ cảnh.',
  inaccessibleData: ['Tin nhắn cá nhân và phòng nhóm', 'Tệp đính kèm', 'Khóa mã hóa và khóa thiết bị'],
});

const getActivePolicy = async () => {
  const policy = await AiConsentPolicy.findOne({ scope: 'chatbot', status: 'active' });
  return policy || DEFAULT_POLICY;
};

const sameId = (left, right) => left && right && left.toString() === right.toString();

const serializePolicy = (policy) => ({
  id: policy._id.toString(),
  version: policy.version,
  provider: policy.provider,
  title: policy.title,
  notice: policy.notice,
  promptLabel: policy.promptLabel,
  promptDescription: policy.promptDescription,
  historyLabel: policy.historyLabel,
  historyDescription: policy.historyDescription,
  inaccessibleData: policy.inaccessibleData || [],
});

const serializeSettings = (user, policy) => {
  const settings = user.aiSettings || {};
  const configured = Boolean(settings.decidedAt && sameId(settings.policyId, policy._id));
  return {
    status: configured ? (settings.enabled ? 'enabled' : 'disabled') : 'pending',
    // Hybrid = đã đồng ý dùng Gemini; Riêng tư = đã quyết định nhưng không dùng Gemini.
    mode: configured ? (settings.enabled ? 'hybrid' : 'private') : null,
    enabled: configured && Boolean(settings.enabled),
    shareAiConversationHistory: configured && Boolean(settings.shareAiConversationHistory),
    storeAiHistory: configured && Boolean(settings.storeAiHistory),
    syncAiHistory: configured && Boolean(settings.syncAiHistory),
    enableAiMemory: configured && Boolean(settings.enableAiMemory),
    voiceConsent: configured && Boolean(settings.enabled && settings.voiceConsent),
    policyId: configured ? settings.policyId.toString() : null,
    decidedAt: configured ? settings.decidedAt : null,
  };
};

const getSettings = async (currentUser) => {
  const policy = await getActivePolicy();
  return { policy: serializePolicy(policy), settings: serializeSettings(currentUser, policy) };
};

const updateSettings = async (currentUser, {
  enabled, shareAiConversationHistory, storeAiHistory, syncAiHistory, enableAiMemory, voiceConsent, policyId,
}) => {
  const policy = await getActivePolicy();
  if (!mongoose.Types.ObjectId.isValid(policyId) || !sameId(policyId, policy._id)) {
    throw new AppError('Chính sách Trợ lý AI đã thay đổi, vui lòng đọc và xác nhận lại', 409, {
      code: 'AI_CONSENT_POLICY_CHANGED',
    });
  }

  const user = await User.findById(currentUser._id);
  if (!user) throw new AppError('Không tìm thấy người dùng', 404);

  user.aiSettings = {
    enabled,
    shareAiConversationHistory: enabled && shareAiConversationHistory,
    storeAiHistory: enabled && storeAiHistory,
    syncAiHistory: enabled && storeAiHistory && syncAiHistory,
    enableAiMemory: enabled && enableAiMemory,
    voiceConsent: enabled && voiceConsent === true,
    policyId: policy._id,
    decidedAt: new Date(),
  };
  await user.save();

  return { policy: serializePolicy(policy), settings: serializeSettings(user, policy) };
};

const requireChatAccess = async (currentUser) => {
  const policy = await getActivePolicy();
  const settings = serializeSettings(currentUser, policy);
  if (settings.status !== 'enabled') {
    throw new AppError('Bạn cần cấu hình quyền Trợ lý AI', 403, { code: 'AI_CONSENT_REQUIRED' });
  }
  return settings;
};

// Audio chỉ được gửi tới Gemini khi ở Hybrid và đã đồng ý riêng cho giọng nói.
const requireVoiceAccess = async (currentUser) => {
  const settings = await requireChatAccess(currentUser);
  if (!settings.voiceConsent) {
    throw new AppError('Bạn chưa cho phép gửi giọng nói tới Trợ lý AI', 403, { code: 'AI_VOICE_CONSENT_REQUIRED' });
  }
  return settings;
};

const requireHistorySyncAccess = async (currentUser) => {
  const settings = await requireChatAccess(currentUser);
  if (!settings.syncAiHistory) {
    throw new AppError('Bạn chưa bật đồng bộ lịch sử Trợ lý AI', 403, { code: 'AI_HISTORY_SYNC_REQUIRED' });
  }
  return settings;
};

module.exports = { getSettings, updateSettings, requireChatAccess, requireVoiceAccess, requireHistorySyncAccess };
