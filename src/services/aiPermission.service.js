// Phân quyền trợ lý AI: danh mục quyền, bộ boolean theo user và token action một lần cho action cấp 2.
const AiCapability = require('../models/AiCapability');
const AiPermission = require('../models/AiPermission');
const Room = require('../models/Room');
const AppError = require('../utils/AppError');
const logger = require('../config/logger');
const { signJwt, verifyJwt } = require('../utils/auth/jwtKeys');
const { checkRateWindow } = require('../utils/rateLimiter');
const authService = require('./auth.service');

const TOKEN_TYPE = 'ai-action';
const TOKEN_TTL_SECONDS = 120;
const NS_AUTHORIZE_MINUTE = 'ai-authorize-minute';
const NS_AUTHORIZE_DAY = 'ai-authorize-day';
const NS_AI_SEND = 'ai-send-message';

// Cấp 1: đọc/điều hướng. Cấp 2: khoảng chờ hủy + token. Cấp 3: chạm mỗi lần.
// Không bao giờ thêm quyền đổi cài đặt, đổi quyền, xuất khóa, xóa dữ liệu, quản lý thiết bị hay đổi mật khẩu.
const CAPABILITY_CATALOG = [
  { key: 'contacts.read', field: 'contactsRead', tier: 1, actions: ['open_friends', 'open_chat', 'find_contact'], label: 'Xem danh bạ', description: 'Cho phép trợ lý tìm người trong danh sách bạn bè và mở cuộc trò chuyện.' },
  { key: 'messages.read', field: 'messagesRead', tier: 1, actions: [], label: 'Đọc tin nhắn', description: 'Cho phép trợ lý đọc to hoặc tóm tắt tin nhắn trên máy bạn.' },
  { key: 'messages.draft', field: 'messagesDraft', tier: 1, actions: ['draft_message'], label: 'Soạn tin nhắn', description: 'Cho phép trợ lý soạn sẵn nội dung vào ô chat, không tự gửi đi.' },
  { key: 'messages.send', field: 'messagesSend', tier: 2, actions: ['send_message'], label: 'Gửi tin nhắn', description: 'Cho phép trợ lý gửi tin nhắn thay bạn sau 3 giây chờ hủy.' },
  { key: 'calls.start', field: 'callsStart', tier: 2, actions: ['start_audio_call', 'start_video_call'], label: 'Bắt đầu cuộc gọi', description: 'Cho phép trợ lý gọi điện thay bạn sau 3 giây chờ hủy.' },
  { key: 'calls.end', field: 'callsEnd', tier: 1, actions: ['end_call'], label: 'Kết thúc cuộc gọi', description: 'Cho phép trợ lý kết thúc cuộc gọi hiện tại ngay lập tức.' },
].map((capability, order) => ({ ...capability, order }));

const PERMISSION_FIELDS = CAPABILITY_CATALOG.map(({ field }) => field);

const toPermissions = (doc) => Object.fromEntries(PERMISSION_FIELDS.map((field) => [field, doc?.[field] === true]));

async function syncCapabilityCatalog() {
  await Promise.all(CAPABILITY_CATALOG.map((capability) => (
    AiCapability.updateOne({ key: capability.key }, { $set: capability }, { upsert: true })
  )));
  await AiCapability.deleteMany({ key: { $nin: CAPABILITY_CATALOG.map(({ key }) => key) } });
}

const getCapabilities = () => AiCapability.find()
  .select('key field label description tier actions order -_id')
  .sort({ order: 1 })
  .lean();

const findCapabilityForAction = (action) => AiCapability.findOne({ actions: action }).select('field tier').lean();

async function getPermissionState(userId) {
  const doc = await AiPermission.findOne({ user: userId }).lean();
  return { permissions: toPermissions(doc), version: doc?.version ?? 0 };
}

const getPermissions = async (userId) => (await getPermissionState(userId)).permissions;

const TIER_2_FIELDS = CAPABILITY_CATALOG.filter(({ tier }) => tier === 2).map(({ field }) => field);

// Bật quyền cấp 2 cần proof (Passkey/TOTP); tắt quyền hoặc bật quyền cấp 1 thì không. Mỗi lần ghi tăng version để vô hiệu token cũ.
async function updatePermissions(user, patch, proof, io) {
  const userId = user._id;
  if (TIER_2_FIELDS.some((field) => patch[field] === true)) await authService.verifyStepUpFactor(user, proof);
  const doc = await AiPermission.findOneAndUpdate(
    { user: userId },
    { $set: patch, $inc: { version: 1 } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();
  const permissions = toPermissions(doc);
  if (io) {
    const sockets = await io.fetchSockets();
    sockets
      .filter((socket) => socket.data.user?._id.toString() === userId.toString())
      .forEach((socket) => socket.emit('ai:permissions_changed', { permissions }));
  }
  return permissions;
}

async function assertNotLimited(namespace, key, options) {
  const limit = await checkRateWindow(namespace, key, options);
  if (limit.limited) {
    throw new AppError('Trợ lý thao tác quá nhanh, hãy thử lại sau.', 429, {
      code: 'AI_ACTION_RATE_LIMITED',
      retryAfter: Math.ceil(limit.retryAfterMs / 1000),
    });
  }
}

// Trả về { allowed, reason?, token? }; chỉ cấp token cho action cấp 2 khi quyền đang bật.
async function authorizeAction(user, { action, actionId, roomId, receiverId }) {
  const userId = user._id.toString();
  const capability = await findCapabilityForAction(action);
  if (!capability || capability.tier !== 2) return { allowed: false, reason: 'unknown_action' };
  const { permissions, version } = await getPermissionState(userId);
  if (!permissions[capability.field]) return { allowed: false, reason: 'no_grant' };

  await assertNotLimited(NS_AUTHORIZE_MINUTE, userId, { maxCount: 10, windowMs: 60 * 1000 });
  await assertNotLimited(NS_AUTHORIZE_DAY, userId, { maxCount: 100, windowMs: 24 * 60 * 60 * 1000 });

  const target = {};
  if (action === 'send_message') {
    if (!await Room.exists({ _id: roomId, members: user._id, isDM: true })) return { allowed: false, reason: 'invalid_target' };
    await assertNotLimited(NS_AI_SEND, userId, { maxCount: 5, windowMs: 60 * 1000 });
    target.roomId = roomId;
  } else {
    target.receiverId = receiverId;
  }

  const token = signJwt(
    { typ: TOKEN_TYPE, action, ver: version, ...target },
    { audience: TOKEN_TYPE, subject: userId, jwtid: actionId, expiresIn: TOKEN_TTL_SECONDS },
  );
  logger.info({ userId, action, ...target }, 'Cấp token action trợ lý');
  return { allowed: true, token };
}

// Trả về payload token nếu hợp lệ và quyền vẫn đang bật, ngược lại null. Không throw.
async function verifyActionToken(token, { userId, action, roomId, receiverId, jti }) {
  try {
    if (typeof token !== 'string' || !token) return null;
    const payload = verifyJwt(token);
    if (payload.typ !== TOKEN_TYPE || payload.aud !== TOKEN_TYPE) return null;
    if (payload.sub !== userId.toString() || payload.action !== action) return null;
    if (roomId !== undefined && payload.roomId !== roomId?.toString()) return null;
    if (receiverId !== undefined && payload.receiverId !== receiverId?.toString()) return null;
    if (jti !== undefined && payload.jti !== jti) return null;
    const capability = await findCapabilityForAction(action);
    if (!capability || capability.tier !== 2) return null;
    const { permissions, version } = await getPermissionState(userId);
    return permissions[capability.field] && payload.ver === version ? payload : null;
  } catch {
    return null;
  }
}

module.exports = {
  CAPABILITY_CATALOG,
  PERMISSION_FIELDS,
  syncCapabilityCatalog,
  getCapabilities,
  getPermissions,
  updatePermissions,
  authorizeAction,
  verifyActionToken,
};
