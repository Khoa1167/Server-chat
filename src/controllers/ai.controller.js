const AppError = require('../utils/AppError');
const aiService = require('../services/ai.service');
const aiConsentService = require('../services/aiConsent.service');
const aiHistoryService = require('../services/aiHistory.service');
const aiPermissionService = require('../services/aiPermission.service');
const {
  parseAiHistory, parseAiMemories, parseAssistantName, parseAiSettings, parseEncryptedConversation, parseEncryptedMessage,
  parseAiPermissionsUpdate, parseAiActionAuthorize, parseAiAudio,
} = require('../validators/ai.validator');
const { checkRateWindow } = require('../utils/rateLimiter');

const NS_AI_CHAT = 'ai-chat-user';
const NS_AI_TRANSCRIBE = 'ai-transcribe-user';
const NS_AI_HISTORY_WRITE = 'ai-history-write-user';
const NS_AI_PERMISSIONS_WRITE = 'ai-permissions-write-user';

function handleError(req, res, err, fallbackMessage) {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({ message: err.message, ...err.extra });
  }
  req.log.error({ message: err.message }, 'AI request error');
  return res.status(err.statusCode || 502).json({ message: fallbackMessage });
}

exports.getSettings = async (req, res) => {
  try {
    res.json(await aiConsentService.getSettings(req.user));
  } catch (err) {
    handleError(req, res, err, 'Không thể tải cài đặt Trợ lý AI');
  }
};

exports.updateSettings = async (req, res) => {
  try {
    res.json(await aiConsentService.updateSettings(req.user, parseAiSettings(req.body)));
  } catch (err) {
    handleError(req, res, err, 'Không thể cập nhật cài đặt Trợ lý AI');
  }
};

exports.chat = async (req, res) => {
  try {
    const settings = await aiConsentService.requireChatAccess(req.user);
    const messages = parseAiHistory(req.body?.history, settings.shareAiConversationHistory);
    const memories = parseAiMemories(req.body?.memories, settings.enableAiMemory);
    const limit = await checkRateWindow(NS_AI_CHAT, req.user._id.toString(), {
      maxCount: 30,
      windowMs: 60 * 1000,
    });
    if (limit.limited) {
      res.set('Retry-After', String(Math.ceil(limit.retryAfterMs / 1000)));
      return res.status(429).json({ message: 'Bạn gửi quá nhanh, hãy thử lại sau.' });
    }

    return res.json({ reply: await aiService.getReply(messages, memories, parseAssistantName(req.body?.assistantName)) });
  } catch (err) {
    return handleError(req, res, err, 'Không thể kết nối trợ lý AI');
  }
};

exports.transcribe = async (req, res) => {
  try {
    await aiConsentService.requireVoiceAccess(req.user);
    const audio = parseAiAudio(req.body);
    const limit = await checkRateWindow(NS_AI_TRANSCRIBE, req.user._id.toString(), { maxCount: 20, windowMs: 60 * 1000 });
    if (limit.limited) {
      res.set('Retry-After', String(Math.ceil(limit.retryAfterMs / 1000)));
      return res.status(429).json({ message: 'Bạn nói quá nhanh, hãy thử lại sau.' });
    }
    return res.json({ text: await aiService.transcribe(audio, 'audio/wav') });
  } catch (err) {
    return handleError(req, res, err, 'Không thể nhận dạng giọng nói');
  }
};

exports.listConversations = async (req, res) => {
  try {
    await aiConsentService.requireHistorySyncAccess(req.user);
    res.json(await aiHistoryService.listConversations(req.user._id));
  }
  catch (err) { handleError(req, res, err, 'Không thể tải lịch sử Trợ lý AI'); }
};
exports.createConversation = async (req, res) => {
  try {
    await aiConsentService.requireHistorySyncAccess(req.user);
    const limit = await checkRateWindow(NS_AI_HISTORY_WRITE, req.user._id.toString(), { maxCount: 120, windowMs: 60000 });
    if (limit.limited) {
      res.set('Retry-After', String(Math.ceil(limit.retryAfterMs / 1000)));
      return res.status(429).json({ message: 'Đồng bộ quá nhanh, hãy thử lại sau.' });
    }
    res.status(201).json(await aiHistoryService.createConversation(req.user, req.deviceId, parseEncryptedConversation(req.body)));
  }
  catch (err) { handleError(req, res, err, 'Không thể tạo cuộc trò chuyện AI'); }
};
exports.listMessages = async (req, res) => {
  try {
    await aiConsentService.requireHistorySyncAccess(req.user);
    res.json(await aiHistoryService.listMessages(req.user._id, req.params.id, req.query.cursor));
  }
  catch (err) { handleError(req, res, err, 'Không thể tải tin nhắn AI'); }
};
exports.saveMessage = async (req, res) => {
  try {
    await aiConsentService.requireHistorySyncAccess(req.user);
    const limit = await checkRateWindow(NS_AI_HISTORY_WRITE, req.user._id.toString(), { maxCount: 120, windowMs: 60000 });
    if (limit.limited) {
      res.set('Retry-After', String(Math.ceil(limit.retryAfterMs / 1000)));
      return res.status(429).json({ message: 'Đồng bộ quá nhanh, hãy thử lại sau.' });
    }
    res.status(201).json(await aiHistoryService.saveMessage(req.user._id, req.params.id, parseEncryptedMessage(req.body)));
  }
  catch (err) { handleError(req, res, err, 'Không thể lưu tin nhắn AI'); }
};
exports.deleteConversation = async (req, res) => {
  try { await aiHistoryService.deleteConversation(req.user._id, req.params.id); res.status(204).end(); }
  catch (err) { handleError(req, res, err, 'Không thể xóa cuộc trò chuyện AI'); }
};
exports.deleteAllHistory = async (req, res) => {
  try { await aiHistoryService.deleteAll(req.user._id); res.status(204).end(); }
  catch (err) { handleError(req, res, err, 'Không thể xóa lịch sử Trợ lý AI'); }
};

exports.getCapabilities = async (req, res) => {
  try { res.json({ capabilities: await aiPermissionService.getCapabilities() }); }
  catch (err) { handleError(req, res, err, 'Không thể tải danh mục quyền trợ lý'); }
};
exports.getPermissions = async (req, res) => {
  try { res.json({ permissions: await aiPermissionService.getPermissions(req.user._id) }); }
  catch (err) { handleError(req, res, err, 'Không thể tải quyền trợ lý'); }
};
exports.updatePermissions = async (req, res) => {
  try {
    const { patch, proof } = parseAiPermissionsUpdate(req.body, aiPermissionService.PERMISSION_FIELDS);
    const limit = await checkRateWindow(NS_AI_PERMISSIONS_WRITE, req.user._id.toString(), { maxCount: 60, windowMs: 60000 });
    if (limit.limited) {
      res.set('Retry-After', String(Math.ceil(limit.retryAfterMs / 1000)));
      return res.status(429).json({ message: 'Bạn đổi quyền quá nhanh, hãy thử lại sau.' });
    }
    const permissions = await aiPermissionService.updatePermissions(req.user, patch, proof, req.app.get('socketio'));
    res.json({ permissions });
  }
  catch (err) { handleError(req, res, err, 'Không thể cập nhật quyền trợ lý'); }
};
exports.authorizeAction = async (req, res) => {
  try { res.json(await aiPermissionService.authorizeAction(req.user, parseAiActionAuthorize(req.body))); }
  catch (err) { handleError(req, res, err, 'Không thể xác minh quyền trợ lý'); }
};
