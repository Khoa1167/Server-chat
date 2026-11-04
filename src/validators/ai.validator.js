const AppError = require('../utils/AppError');

function parseAiSettings(body) {
  const allowedKeys = ['enabled', 'shareAiConversationHistory', 'storeAiHistory', 'syncAiHistory', 'enableAiMemory', 'voiceConsent', 'policyId'];
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some((key) => !allowedKeys.includes(key))
    || typeof body.enabled !== 'boolean'
    || typeof body.shareAiConversationHistory !== 'boolean'
    || typeof body.storeAiHistory !== 'boolean'
    || typeof body.syncAiHistory !== 'boolean'
    || typeof body.enableAiMemory !== 'boolean'
    || (body.voiceConsent !== undefined && typeof body.voiceConsent !== 'boolean')
    || typeof body.policyId !== 'string'
    || !body.policyId
    || (!body.enabled && (body.shareAiConversationHistory || body.storeAiHistory || body.syncAiHistory || body.enableAiMemory || body.voiceConsent))
    || (body.syncAiHistory && !body.storeAiHistory)) {
    throw new AppError('Cài đặt Trợ lý AI không hợp lệ', 400, { code: 'INVALID_AI_SETTINGS' });
  }
  return {
    enabled: body.enabled,
    shareAiConversationHistory: body.shareAiConversationHistory,
    storeAiHistory: body.storeAiHistory,
    syncAiHistory: body.syncAiHistory,
    enableAiMemory: body.enableAiMemory,
    voiceConsent: body.voiceConsent === true,
    policyId: body.policyId,
  };
}

function parseAiHistory(history, allowHistory) {
  if (!Array.isArray(history) || history.length === 0 || history.length > 30) {
    throw new AppError('Lịch sử hội thoại không hợp lệ', 400, { code: 'INVALID_AI_HISTORY' });
  }
  if (!allowHistory && history.length !== 1) {
    throw new AppError('Bạn chưa cấp quyền gửi lịch sử trò chuyện AI', 403, { code: 'AI_HISTORY_CONSENT_REQUIRED' });
  }

  const messages = history.map((message) => ({
    role: message?.role,
    content: typeof message?.content === 'string' ? message.content.trim() : '',
  }));
  if (messages.some(({ role, content }) => !['user', 'assistant'].includes(role) || !content || content.length > 4000)
    || messages.at(-1).role !== 'user'
    || (!allowHistory && messages[0].role !== 'user')) {
    throw new AppError('Nội dung hội thoại không hợp lệ', 400, { code: 'INVALID_AI_HISTORY' });
  }
  return messages;
}

function parseAiMemories(memories, allowMemory) {
  if (!allowMemory) {
    if (memories !== undefined && (!Array.isArray(memories) || memories.length > 0)) {
      throw new AppError('Bạn chưa cấp quyền dùng bộ nhớ AI', 403, { code: 'AI_MEMORY_CONSENT_REQUIRED' });
    }
    return [];
  }
  if (!Array.isArray(memories) || memories.length > 20
    || memories.some((memory) => typeof memory !== 'string' || !memory.trim() || memory.trim().length > 500)) {
    throw new AppError('Bộ nhớ AI không hợp lệ', 400, { code: 'INVALID_AI_MEMORY' });
  }
  return memories.map((memory) => memory.trim());
}

// Tên trợ lý được đưa vào chỉ dẫn hệ thống nên chỉ nhận chữ, số và vài ký tự an toàn; sai định dạng thì bỏ qua (null).
function parseAssistantName(name) {
  const value = typeof name === 'string' ? name.trim() : '';
  return /^[\p{L}\p{N} _.'-]{1,24}$/u.test(value) ? value : null;
}

const BASE64 =/^[A-Za-z0-9+/]+={0,2}$/;

function parseEncryptedConversation(body) {
  const allowedKeys = ['clientConversationId', 'keyEnvelopes'];
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some((key) => !allowedKeys.includes(key))
    || !/^[A-Za-z0-9_-]{16,100}$/.test(body.clientConversationId || '')
    || !body.keyEnvelopes || typeof body.keyEnvelopes !== 'object' || Array.isArray(body.keyEnvelopes)) {
    throw new AppError('Cuộc trò chuyện mã hóa không hợp lệ', 400);
  }
  const entries = Object.entries(body.keyEnvelopes);
  if (!entries.length || entries.length > 20
    || entries.some(([key, value]) => !/^[A-Za-z0-9_-]{1,150}$/.test(key)
      || typeof value !== 'string' || value.length > 1024 || !BASE64.test(value))) {
    throw new AppError('Danh sách khóa thiết bị không hợp lệ', 400);
  }
  return { clientConversationId: body.clientConversationId, keyEnvelopes: Object.fromEntries(entries) };
}

function parseEncryptedMessage(body) {
  const allowedKeys = ['clientMessageId', 'ciphertext', 'iv'];
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some((key) => !allowedKeys.includes(key))
    || !/^[A-Za-z0-9_-]{16,100}$/.test(body.clientMessageId || '')
    || typeof body.ciphertext !== 'string' || !body.ciphertext || body.ciphertext.length > 12000 || !BASE64.test(body.ciphertext)
    || typeof body.iv !== 'string' || body.iv.length < 16 || body.iv.length > 64 || !BASE64.test(body.iv)) {
    throw new AppError('Tin nhắn AI mã hóa không hợp lệ', 400);
  }
  return { clientMessageId: body.clientMessageId, ciphertext: body.ciphertext, iv: body.iv };
}

// Chỉ nhận trường quyền có trong danh mục, giá trị boolean, ít nhất một trường.
function parseAiPermissionsPatch(body, fields) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError('Quyền trợ lý không hợp lệ', 400, { code: 'INVALID_AI_PERMISSIONS' });
  }
  const entries = Object.entries(body);
  if (!entries.length || entries.some(([key, value]) => !fields.includes(key) || typeof value !== 'boolean')) {
    throw new AppError('Quyền trợ lý không hợp lệ', 400, { code: 'INVALID_AI_PERMISSIONS' });
  }
  return Object.fromEntries(entries);
}

// Proof tùy chọn: đúng một trong { code } (TOTP 6 số) hoặc { stepUpChallengeToken } (Passkey).
function parseAiPermissionProof(proof) {
  if (proof === undefined) return {};
  const invalid = () => new AppError('Xác nhận không hợp lệ', 400, { code: 'INVALID_AI_PROOF' });
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)) throw invalid();
  const keys = Object.keys(proof);
  if (keys.length !== 1) throw invalid();
  if (keys[0] === 'code' && /^\d{6}$/.test(proof.code)) return { code: proof.code };
  if (keys[0] === 'stepUpChallengeToken' && /^[A-Za-z0-9_-]{16,128}$/.test(proof.stepUpChallengeToken)) {
    return { stepUpChallengeToken: proof.stepUpChallengeToken };
  }
  throw invalid();
}

const MAX_AUDIO_BYTES = 1024 * 1024;

// Audio lệnh giọng nói: WAV (RIFF/WAVE) tối đa 1 MB; chỉ kiểm tra khung, không giải mã.
function parseAiAudio(body) {
  if (!Buffer.isBuffer(body) || body.length < 44 || body.length > MAX_AUDIO_BYTES
    || body.toString('latin1', 0, 4) !== 'RIFF' || body.toString('latin1', 8, 12) !== 'WAVE') {
    throw new AppError('Audio không hợp lệ', 400, { code: 'INVALID_AI_AUDIO' });
  }
  return body;
}

// Body PUT /permissions: { permissions, proof? }.
function parseAiPermissionsUpdate(body, fields) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some((key) => !['permissions', 'proof'].includes(key))) {
    throw new AppError('Quyền trợ lý không hợp lệ', 400, { code: 'INVALID_AI_PERMISSIONS' });
  }
  return { patch: parseAiPermissionsPatch(body.permissions, fields), proof: parseAiPermissionProof(body.proof) };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OBJECT_ID = /^[0-9a-f]{24}$/i;
const CALL_ACTIONS = ['start_audio_call', 'start_video_call'];

function parseAiActionAuthorize(body) {
  const allowedKeys = ['action', 'actionId', 'roomId', 'receiverId'];
  const invalid = () => new AppError('Yêu cầu action trợ lý không hợp lệ', 400, { code: 'INVALID_AI_ACTION' });
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some((key) => !allowedKeys.includes(key))
    || typeof body.action !== 'string' || !UUID.test(body.actionId || '')) {
    throw invalid();
  }
  if (body.action === 'send_message') {
    if (!OBJECT_ID.test(body.roomId || '') || body.receiverId !== undefined) throw invalid();
    return { action: body.action, actionId: body.actionId, roomId: body.roomId };
  }
  if (CALL_ACTIONS.includes(body.action)) {
    if (!OBJECT_ID.test(body.receiverId || '') || body.roomId !== undefined) throw invalid();
    return { action: body.action, actionId: body.actionId, receiverId: body.receiverId };
  }
  throw invalid();
}

module.exports = {
  parseAiSettings, parseAiHistory, parseAiMemories, parseAssistantName, parseEncryptedConversation, parseEncryptedMessage,
  parseAiPermissionsPatch, parseAiPermissionProof, parseAiPermissionsUpdate, parseAiActionAuthorize, parseAiAudio, MAX_AUDIO_BYTES,
};
