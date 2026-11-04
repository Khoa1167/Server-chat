const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const User = require('../models/User');
const AccountRecovery = require('../models/AccountRecovery');
const Room = require('../models/Room');
const Friendship = require('../models/Friendship');
const Block = require('../models/Block');
const Notification = require('../models/Notification');
const LoginHistory = require('../models/LoginHistory');
const PasskeyCredential = require('../models/PasskeyCredential');
const AiConversation = require('../models/AiConversation');
const AiMessage = require('../models/AiMessage');
const AppError = require('../utils/AppError');
const { decryptPII, hashBlindIndexAllKeys } = require('../utils/crypto');
// require nguyên module (không destructure) — cùng lý do với roomsService ở dưới, giữ mock được trong test.
const cloudinary = require('../config/cloudinary');
const { generateOTP, hashOTP } = require('./auth.service');
// require nguyên module (không destructure) để test mock được roomsService.leaveRoom — destructure
// sẽ chụp cứng reference gốc lúc require, mock sau đó trên module.exports không có tác dụng.
const roomsService = require('./rooms.service');
const { sendAccountDeletionScheduledEmail, sendAccountRecoveryOTPEmail } = require('../config/mailer');
const { removeUserPushSubscriptions } = require('./pushSubscriptions.service');

const GRACE_PERIOD_MS = 14 * 24 * 60 * 60 * 1000;
const RECOVERY_OTP_TTL_MS = 10 * 60 * 1000;
const MAX_RECOVERY_ATTEMPTS = 5;

async function requestAccountDeletion(currentUser, { currentPassword }) {
  if (typeof currentPassword !== 'string') {
    throw new AppError('Thiếu mật khẩu xác nhận', 400);
  }
  const user = await User.findById(currentUser._id);
  if (!user || !await user.comparePassword(currentPassword)) {
    throw new AppError('Mật khẩu không đúng', 401);
  }

  user.pendingDeletionAt = new Date(Date.now() + GRACE_PERIOD_MS);
  // Thu hồi toàn bộ device token — đăng xuất khắp nơi ngay, giống hành vi đổi mật khẩu.
  user.devices = [];
  await user.save();
  await removeUserPushSubscriptions(user._id);

  const email = decryptPII(user.email);
  if (email) {
    sendAccountDeletionScheduledEmail(email).catch(() => {});
  }

  return { pendingDeletionAt: user.pendingDeletionAt };
}

async function requestAccountRecovery(email) {
  const lowerEmail = (email || '').trim().toLowerCase();
  const user = await User.findOne({ emailHash: { $in: hashBlindIndexAllKeys(lowerEmail) } });
  const genericResponse = { message: 'Nếu email này có tài khoản đang chờ xóa, mã khôi phục đã được gửi.' };
  // Không lộ email nào tồn tại/đang chờ xóa — luôn trả cùng message, giống tinh thần chống dò
  // email trong forgotPassword().
  if (!user || !user.pendingDeletionAt) {
    return genericResponse;
  }

  const otp = generateOTP();
  await AccountRecovery.findOneAndUpdate(
    { userId: user._id },
    { otp: hashOTP(otp), attempts: 0, expiresAt: new Date(Date.now() + RECOVERY_OTP_TTL_MS) },
    { upsert: true }
  );
  const realEmail = decryptPII(user.email);
  if (realEmail) sendAccountRecoveryOTPEmail(realEmail, otp).catch(() => {});

  return genericResponse;
}

async function verifyAccountRecovery(email, otp) {
  if (!email || !otp) throw new AppError('Thiếu email hoặc mã OTP', 400);
  const lowerEmail = email.trim().toLowerCase();
  const user = await User.findOne({ emailHash: { $in: hashBlindIndexAllKeys(lowerEmail) } });
  if (!user || !user.pendingDeletionAt) {
    throw new AppError('Không tìm thấy yêu cầu khôi phục', 400);
  }

  const record = await AccountRecovery.findOne({ userId: user._id });
  if (!record) throw new AppError('Không tìm thấy yêu cầu khôi phục', 400);

  if (new Date() > record.expiresAt) {
    await AccountRecovery.deleteOne({ _id: record._id });
    throw new AppError('Mã OTP đã hết hạn, vui lòng yêu cầu lại', 400);
  }
  if (record.attempts >= MAX_RECOVERY_ATTEMPTS) {
    await AccountRecovery.deleteOne({ _id: record._id });
    throw new AppError('Quá nhiều lần nhập sai mã OTP, vui lòng yêu cầu lại', 400);
  }

  const hashedInputOtp = hashOTP(otp.trim());
  if (record.otp !== hashedInputOtp) {
    record.attempts += 1;
    await record.save();
    throw new AppError(`Mã OTP không chính xác, còn ${MAX_RECOVERY_ATTEMPTS - record.attempts} lần thử`, 400);
  }

  user.pendingDeletionAt = null;
  await user.save();
  await AccountRecovery.deleteOne({ _id: record._id });
  return { message: 'Đã khôi phục tài khoản, hãy đăng nhập lại' };
}

async function purgeOneAccount(user, io) {
  await require('./posts.service').purgeUser(user._id, io);
  const rooms = await Room.find({ members: user._id });
  for (const room of rooms) {
    // DM giữ nguyên members — getDMPartner() (client) cần tìm thấy đối phương trong room.members
    // để hiện placeholder "Người dùng đã xóa"; tombstone User doc ở dưới là đủ, không cần đụng room.
    if (room.isDM) continue;
    // Tái dùng nguyên hàm rời nhóm đã có — tự chuyển quyền chủ phòng/xóa phòng rỗng, tự dọn call SFU.
    await roomsService.leaveRoom(room._id, user._id, null, io).catch(() => {});
  }

  await Promise.all([
    Friendship.deleteMany({ $or: [{ sender: user._id }, { receiver: user._id }] }),
    Block.deleteMany({ $or: [{ blocker: user._id }, { blocked: user._id }] }),
    // Giữ notification người khác nhận có fromUser=user._id — lịch sử của họ, không phải của người bị purge.
    Notification.deleteMany({ user: user._id }),
    LoginHistory.deleteMany({ user: user._id }),
    PasskeyCredential.deleteMany({ user: user._id }),
    AiConversation.deleteMany({ owner: user._id }),
    AiMessage.deleteMany({ owner: user._id }),
    removeUserPushSubscriptions(user._id),
  ]);

  if (user.avatar) cloudinary.deleteCloudinaryImage(user.avatar);
  if (user.cover) cloudinary.deleteCloudinaryImage(user.cover);

  user.nickname = 'Người dùng đã xóa';
  user.username = `deleted-${user._id}`; // giải phóng username gốc cho người khác đăng ký lại
  user.email = '';
  user.emailHash = undefined;
  user.phone = '';
  user.phoneHash = '';
  user.dateOfBirth = '';
  user.gender = '';
  user.bio = '';
  user.avatar = '';
  user.cover = '';
  // Mật khẩu ngẫu nhiên không ai biết — không thể đăng nhập dù có bypass check isDeleted/pendingDeletionAt ở nơi khác.
  user.password = await bcrypt.hash(crypto.randomUUID(), 12);
  user.devices = [];
  user.totpEnabled = false;
  user.totpSecret = '';
  user.totpPendingSecret = '';
  user.totpRecoveryCodes = [];
  user.aiSettings = {
    enabled: false,
    voiceConsent: false,
    shareAiConversationHistory: false,
    storeAiHistory: false,
    syncAiHistory: false,
    enableAiMemory: false,
    policyId: null,
    decidedAt: null,
  };
  user.isDeleted = true;
  user.pendingDeletionAt = null;
  await user.save();
}

async function purgeExpiredAccountDeletions(io) {
  const dueUsers = await User.find({ pendingDeletionAt: { $lte: new Date() }, isDeleted: false });
  for (const user of dueUsers) {
    await purgeOneAccount(user, io).catch(err => console.error('[AccountDeletion] Purge lỗi:', user._id, err));
  }
}

module.exports = {
  requestAccountDeletion,
  requestAccountRecovery,
  verifyAccountRecovery,
  purgeExpiredAccountDeletions,
};
