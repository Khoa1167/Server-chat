const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const crypto = require('crypto');
const User = require('../models/User');
const Room = require('../models/Room');
const PendingUser = require('../models/PendingUser');
const PasswordReset = require('../models/PasswordReset');
const EmailChange = require('../models/EmailChange');
const LoginHistory = require('../models/LoginHistory');
const MfaChallenge = require('../models/MfaChallenge');
const PasskeyCredential = require('../models/PasskeyCredential');
const HistoryBackup = require('../models/HistoryBackup');
const webauthn = require('../utils/auth/webauthn');
const { isAdminIpAllowed } = require('../middleware/auth');
const {
  sendOTPEmail,
  sendResetPasswordOTPEmail,
  sendEmailChangeOTPEmail,
  sendEmailChangeNoticeEmail
} = require('../config/mailer');
const { deleteCloudinaryImage } = require('../config/cloudinary');
const {
  decryptPII,
  hashBlindIndexAllKeys,
  encryptMfaSecret,
  decryptMfaSecret,
  hashMfaValue,
  hashMfaValueAllKeys,
} = require('../utils/crypto');
const { checkLock, recordFailure, clearFailures, checkRateWindow } = require('../utils/rateLimiter');
const { verifyTurnstile } = require('../utils/auth/turnstile');
const deviceKeysCache = require('../utils/deviceKeysCache');
const { signJwt, verifyJwt } = require('../utils/auth/jwtKeys');
const { generateDeviceToken, hashDeviceToken } = require('../utils/auth/deviceToken');
const AppError = require('../utils/AppError');
const {
  generateTotpSecret,
  buildTotpUri,
  verifyTotp,
  generateRecoveryCodes,
  normalizeRecoveryCode,
} = require('../utils/auth/totp');
const {
  normalizeEmail,
  normalizePhone,
  isValidEmail,
  isValidPhone,
  isValidUsername,
  isValidPassword,
  normalizeNickname,
  isValidNickname,
} = require('../validators/auth.validator');

// Bootstrap token (hạn 15m, chưa đăng ký device) — vẫn là JWT vì ngắn hạn, tự chứa hạn dùng.
const genBootstrapToken = (id) =>
  signJwt({ id }, { expiresIn: '15m' });

const genToken = genBootstrapToken;

// Tạo OTP 6 số ngẫu nhiên an toàn bảo mật (Crypto Secure PRNG)
const generateOTP = () =>
  crypto.randomInt(100000, 1000000).toString();

const hashOTP = (otp) =>
  crypto.createHash('sha256').update(otp).digest('hex');

// Chống spam OTP đốt hạn ngạch email (Brevo free tier 300/ngày) — 3 lớp: theo IP, theo email đích,
// và ngân sách toàn hệ thống/ngày dùng chung 1 bộ đếm (chặn botnet rải nhiều IP/email).
const NS_SEND_OTP_IP = 'send-otp-ip';
const NS_SEND_OTP_EMAIL = 'send-otp-email';
const NS_FORGOT_PASSWORD_IP = 'forgot-password-ip';
const NS_FORGOT_PASSWORD_EMAIL = 'forgot-password-email';
// Check-username chỉ lộ true/false, không cần bảo mật cao — giới hạn rộng để không cấn gõ/sửa liên tục lúc đăng ký.
const NS_CHECK_USERNAME = 'check-username';
// Dùng checkRateWindow (Redis khi nhiều instance) thay vì biến RAM — biến RAM chỉ đúng 1 instance.
const NS_DAILY_OTP_BUDGET = 'daily-otp-budget';
const DAILY_OTP_BUDGET_MAX = 200; // chừa dư cho đổi email cũng dùng chung quota Brevo
const DAY_MS = 24 * 60 * 60 * 1000;

// ─── Đăng ký (OTP) ───────────────────────────────────────────────────────────

async function sendRegisterOtp({ username, password, email, phone, turnstileToken }, ip, log) {
  const normalizedEmail = normalizeEmail(email);
  const normalizedPhone = normalizePhone(phone || '');

  // Chặn bot trước cả rate-limit theo IP/email bên dưới (rate-limit chỉ giới hạn tốc độ,
  // không phân biệt được người thật hay script tự động)
  if (!(await verifyTurnstile(turnstileToken, ip))) {
    throw new AppError('Xác minh CAPTCHA thất bại, vui lòng thử lại', 400);
  }

  if (typeof username !== 'string' || typeof password !== 'string' || !normalizedEmail)
    throw new AppError('Vui lòng điền đầy đủ thông tin', 400);
  if (!isValidUsername(username))
    throw new AppError('Tên tài khoản chỉ được chứa chữ cái và số (không kí tự đặc biệt), 3-16 ký tự', 400);
  if (!isValidPassword(password))
    throw new AppError('Mật khẩu phải có từ 8-30 ký tự', 400);
  if (!isValidEmail(normalizedEmail))
    throw new AppError('Email không hợp lệ', 400);
  if (phone && !isValidPhone(normalizedPhone))
    throw new AppError('Số điện thoại không hợp lệ', 400);

  // Chống spam: tối đa 5 lần gửi OTP/15 phút theo IP, 3 lần theo email đích
  const ipLock = await checkLock(NS_SEND_OTP_IP, ip);
  if (ipLock.locked) {
    throw new AppError(`Bạn đã yêu cầu OTP quá nhiều lần. Thử lại sau ${ipLock.waitMinutes} phút.`, 429);
  }
  const emailLock = await checkLock(NS_SEND_OTP_EMAIL, normalizedEmail);
  if (emailLock.locked) {
    throw new AppError(`Email này đã yêu cầu OTP quá nhiều lần. Thử lại sau ${emailLock.waitMinutes} phút.`, 429);
  }

  const usernameExists = await User.findOne({ username });
  if (usernameExists)
    throw new AppError('Tên tài khoản đã tồn tại', 400, { field: 'username' });

  const emailExists = await User.findOne({ emailHash: { $in: hashBlindIndexAllKeys(normalizedEmail) } });
  if (emailExists)
    throw new AppError('Email đã được sử dụng', 400, { field: 'email' });

  const otp            = generateOTP();
  const hashedOtp      = hashOTP(otp);
  const hashedPassword = await bcrypt.hash(password, 12);
  const expiresAt      = new Date(Date.now() + 5 * 60 * 1000); // 5 phút

  await PendingUser.deleteOne({ email: normalizedEmail });
  try {
    await PendingUser.create({
      username, hashedPassword, email: normalizedEmail,
      phone: normalizedPhone, otp: hashedOtp, expiresAt, attempts: 0,
    });
  } catch (err) {
    // Race condition: 2 người đăng ký cùng username/email gần như đồng thời — unique index chặn ở đây.
    if (err.code === 11000 && err.keyPattern?.username) {
      throw new AppError('Tên tài khoản đang được người khác đăng ký, vui lòng thử tên khác', 400, { field: 'username' });
    }
    if (err.code === 11000 && err.keyPattern?.email) {
      throw new AppError('Email này đang được người khác đăng ký, vui lòng thử lại sau', 400, { field: 'email' });
    }
    throw err;
  }

  // Giữ chỗ ngân sách OTP NGAY TRƯỚC khi tốn quota Brevo — atomic check+increment tránh TOCTOU.
  const budgetCheck = await checkRateWindow(NS_DAILY_OTP_BUDGET, 'global', { maxCount: DAILY_OTP_BUDGET_MAX, windowMs: DAY_MS });
  if (budgetCheck.limited) {
    throw new AppError('Hệ thống tạm ngừng gửi email OTP hôm nay, vui lòng thử lại vào ngày mai.', 503);
  }

  await sendOTPEmail(normalizedEmail, otp);
  if (process.env.NODE_ENV !== 'production') log.debug(`[DEBUG] OTP for ${normalizedEmail}: ${otp}`);

  await recordFailure(NS_SEND_OTP_IP, ip);
  await recordFailure(NS_SEND_OTP_EMAIL, normalizedEmail, { maxAttempts: 3, lockMinutes: 15 });

  return { message: 'OTP đã được gửi tới email của bạn' };
}

async function verifyRegisterOtp({ email, otp }) {
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedEmail || !otp)
    throw new AppError('Thiếu email hoặc OTP', 400);
  if (!isValidEmail(normalizedEmail))
    throw new AppError('Email không hợp lệ', 400);

  const pending = await PendingUser.findOne({ email: normalizedEmail });
  if (!pending)
    throw new AppError('Không tìm thấy yêu cầu đăng ký', 400);

  if (new Date() > pending.expiresAt) {
    await PendingUser.deleteOne({ email: normalizedEmail });
    throw new AppError('OTP đã hết hạn, vui lòng đăng ký lại', 400);
  }

  if (pending.attempts >= 5) {
    await PendingUser.deleteOne({ email: normalizedEmail });
    throw new AppError('Quá nhiều lần nhập sai, vui lòng đăng ký lại', 400);
  }

  const hashedInputOtp = hashOTP(otp.trim());
  if (pending.otp !== hashedInputOtp) {
    pending.attempts += 1;
    await pending.save();
    const remaining = 5 - pending.attempts;
    throw new AppError(`OTP không đúng, còn ${remaining} lần thử`, 400);
  }

  // OTP đúng → tạo tài khoản thật
  const user = new User({
    username: pending.username,
    email:    pending.email,
    phone:    pending.phone,
    nickname: `user_${Date.now()}`,
    password: pending.hashedPassword,
  });
  // KHÔNG xóa activePaths.states.modify để bypass hook — xóa modify-state kiểu đó tắt cả cờ mã hóa email/phone.
  try {
    await user.save({ validateBeforeSave: false });
  } catch (err) {
    if (err.code === 11000) {
      // Lưới an toàn cuối cho race condition — unique index của User chặn, xóa pending thay vì trả 500.
      await PendingUser.deleteOne({ email: normalizedEmail });
      const field = err.keyPattern?.username ? 'username' : err.keyPattern?.emailHash ? 'email' : 'nickname';
      const fieldMessage = {
        username: 'Tên tài khoản vừa bị người khác đăng ký trước, vui lòng đăng ký lại với tên khác',
        email:    'Email này vừa được đăng ký bởi tài khoản khác, vui lòng đăng ký lại với email khác',
        nickname: 'Đã có lỗi trùng lặp khi tạo tài khoản, vui lòng đăng ký lại',
      }[field];
      throw new AppError(fieldMessage, 409, { field });
    }
    throw err;
  }

  await PendingUser.deleteOne({ email: normalizedEmail });

  return { message: 'Đăng ký thành công!', token: genToken(user._id), user };
}

async function checkUsernameAvailable(username, ip) {
  const limit = await checkRateWindow(NS_CHECK_USERNAME, ip, { maxCount: 30, windowMs: 60000 });
  if (limit.limited) {
    throw new AppError('Kiểm tra quá nhanh, vui lòng thử lại sau.', 429);
  }

  if (!isValidUsername(username))
    return { available: false };
  const exists = await User.findOne({ username });
  return { available: !exists };
}

async function setNickname(user, nickname) {
  const normalizedNickname = normalizeNickname(nickname);
  if (!isValidNickname(normalizedNickname))
    throw new AppError('Tên hiển thị không hợp lệ (2-20 ký tự, không chứa ký tự ẩn/điều khiển)', 400);

  // Chỉ cho phép thiết lập nickname lần đầu khi mới đăng ký tài khoản
  if (user.nicknameChangedAt) {
    throw new AppError('Bạn đã thiết lập tên hiển thị trước đó. Vui lòng đổi tên trong trang cá nhân.', 400);
  }

  return await User.findByIdAndUpdate(
    user._id, { nickname: normalizedNickname, nicknameChangedAt: new Date() }, { new: true, runValidators: true }
  );
}

// ─── Đăng nhập ───────────────────────────────────────────────────────────────

// Chống brute-force đăng nhập: tối đa 5 lần sai / 15 phút, tính theo username
const NS_LOGIN = 'login';
const NS_MFA_LOGIN = 'mfa-login';
const NS_MFA_LOGIN_IP = 'mfa-login-ip';
const NS_TOTP_MANAGEMENT_PASSWORD = 'totp-management-password';
const NS_MFA_MANAGEMENT_FACTOR = 'mfa-management-factor';
const NS_HISTORY_BACKUP = 'history-backup';
const NS_TOTP_SETUP_CONFIRM = 'totp-setup-confirm';
const TOTP_USER_FIELDS = '+totpSecret +totpPendingSecret +totpPendingExpiresAt +totpLastUsedStep +totpRecoveryCodes';

const challengeHash = (token) => crypto.createHash('sha256').update(token).digest('hex');

async function consumeSecondFactor(user, value) {
  const input = String(value || '').trim();
  if (/^\d{6}$/.test(input)) {
    const step = verifyTotp(decryptMfaSecret(user.totpSecret), input);
    if (step === null) return false;
    const result = await User.updateOne(
      {
        _id: user._id,
        totpEnabled: true,
        $or: [{ totpLastUsedStep: { $lt: step } }, { totpLastUsedStep: { $exists: false } }],
      },
      { $set: { totpLastUsedStep: step } }
    );
    return result.modifiedCount === 1;
  }

  const normalized = normalizeRecoveryCode(input);
  if (normalized.length !== 16) return false;
  const candidates = hashMfaValueAllKeys(normalized);
  const storedHash = user.totpRecoveryCodes.find(hash => candidates.includes(hash));
  if (!storedHash) return false;
  const result = await User.updateOne(
    { _id: user._id, totpRecoveryCodes: storedHash },
    { $pull: { totpRecoveryCodes: storedHash } }
  );
  return result.modifiedCount === 1;
}

async function verifyMfaPassword(userId, password) {
  if (typeof password !== 'string' || !password) throw new AppError('Vui lòng nhập mật khẩu hiện tại', 400);
  const key = userId.toString();
  const lock = await checkLock(NS_TOTP_MANAGEMENT_PASSWORD, key);
  if (lock.locked) throw new AppError(`Bạn đã xác nhận sai quá nhiều lần. Thử lại sau ${lock.waitMinutes} phút.`, 429);
  const user = await User.findById(userId).select(`+password ${TOTP_USER_FIELDS}`);
  if (!user || !(await user.comparePassword(password))) {
    await recordFailure(NS_TOTP_MANAGEMENT_PASSWORD, key);
    throw new AppError('Mật khẩu hiện tại không đúng', 401);
  }
  await clearFailures(NS_TOTP_MANAGEMENT_PASSWORD, key);
  return user;
}

async function consumeManagedFactor(user, code) {
  const key = user._id.toString();
  const lock = await checkLock(NS_MFA_MANAGEMENT_FACTOR, key);
  if (lock.locked) throw new AppError(`Bạn đã nhập sai quá nhiều lần. Thử lại sau ${lock.waitMinutes} phút.`, 429);
  if (!(await consumeSecondFactor(user, code))) {
    await recordFailure(NS_MFA_MANAGEMENT_FACTOR, key);
    throw new AppError('Mã xác thực không đúng hoặc đã được sử dụng', 401);
  }
  await clearFailures(NS_MFA_MANAGEMENT_FACTOR, key);
}

function revokeOtherDevices(user, currentDeviceId) {
  const revokedDeviceIds = [];
  for (const device of user.devices) {
    if (device.deviceId !== currentDeviceId && device.tokenHash) {
      device.tokenHash = null;
      device.isRevoked = true;
      device.revokedAt = new Date();
      revokedDeviceIds.push(device.deviceId);
    }
  }
  return revokedDeviceIds;
}

async function finishSecurityChange(io, userId, revokedDeviceIds) {
  if (!revokedDeviceIds.length) return;
  triggerDebouncedKeyChanged(io, userId);
  if (!io) return;
  const revoked = new Set(revokedDeviceIds);
  const sockets = await io.fetchSockets();
  sockets
    .filter(socket => socket.data.user?._id.toString() === userId.toString() && revoked.has(socket.data.deviceId))
    .forEach(socket => socket.disconnect(true));
}

async function login({ username, password, turnstileToken }, ip, userAgent, log) {
  if (typeof username !== 'string' || typeof password !== 'string')
    throw new AppError('Tên tài khoản hoặc mật khẩu không hợp lệ', 400);

  // Chặn bot/credential-stuffing trước cả rate-limit theo username bên dưới
  if (!(await verifyTurnstile(turnstileToken, ip))) {
    throw new AppError('Xác minh CAPTCHA thất bại, vui lòng thử lại', 400);
  }

  const lock = await checkLock(NS_LOGIN, username);
  if (lock.locked) {
    throw new AppError(`Tài khoản tạm thời bị khóa đăng nhập do nhập sai mật khẩu quá nhiều lần. Thử lại sau ${lock.waitMinutes} phút.`, 429);
  }

  // Ghi lịch sử đăng nhập — không await/không để lỗi ghi log làm hỏng luồng đăng nhập chính,
  // chỉ log lỗi nếu ghi thất bại. Chỉ ghi khi xác định được đúng user (sai cả username thì
  // không có tài khoản nào để gắn lịch sử vào — không đáng để tra cứu/lưu trữ).
  const recordLoginHistory = (userId, success) => {
    LoginHistory.create({ user: userId, success, ip, userAgent: userAgent || '' })
      .catch(err => log.error({ err }, 'Ghi login history thất bại'));
  };

  const user = await User.findOne({ username });
  if (!user || !(await user.comparePassword(password))) {
    await recordFailure(NS_LOGIN, username);
    if (user) recordLoginHistory(user._id, false);
    throw new AppError('Sai tên tài khoản hoặc mật khẩu', 401);
  }
  await clearFailures(NS_LOGIN, username);

  if (user.isBanned) {
    recordLoginHistory(user._id, false);
    throw new AppError('Tài khoản đã bị khóa bởi quản trị viên', 403);
  }

  if (user.role === 'admin' && !isAdminIpAllowed(ip)) {
    recordLoginHistory(user._id, false);
    throw new AppError('Địa chỉ IP này không được phép đăng nhập tài khoản quản trị viên', 403);
  }

  const hasPasskey = !!(await PasskeyCredential.exists({ user: user._id }));
  if (user.totpEnabled || hasPasskey) {
    const userWithCodes = await User.findById(user._id).select('+totpRecoveryCodes');
    const challengeToken = crypto.randomBytes(32).toString('base64url');
    await MfaChallenge.deleteMany({ user: user._id, purpose: 'login', usedAt: null });
    await MfaChallenge.create({
      tokenHash: challengeHash(challengeToken),
      user: user._id,
      ip,
      userAgent: userAgent || '',
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    });
    return { mfaRequired: true, challengeToken, methods: { totp: user.totpEnabled, passkey: hasPasskey, recovery: (userWithCodes?.totpRecoveryCodes?.length || 0) > 0 } };
  }

  recordLoginHistory(user._id, true);

  return { token: genToken(user._id), user };
}

async function verifyTotpLogin({ challengeToken, code } = {}, ip, log) {
  if (typeof challengeToken !== 'string' || challengeToken.length > 200 || typeof code !== 'string') {
    throw new AppError('Yêu cầu xác thực không hợp lệ', 400);
  }
  const ipLimit = await checkRateWindow(NS_MFA_LOGIN_IP, ip, { maxCount: 20, windowMs: 15 * 60 * 1000 });
  if (ipLimit.limited) throw new AppError('Quá nhiều lần xác thực. Vui lòng thử lại sau.', 429);

  const challenge = await MfaChallenge.findOne({ tokenHash: challengeHash(challengeToken), purpose: 'login', usedAt: null, expiresAt: { $gt: new Date() } });
  if (!challenge || challenge.attempts >= 5) {
    throw new AppError('Phiên xác thực đã hết hạn, vui lòng đăng nhập lại', 401);
  }

  const user = await User.findById(challenge.user).select(TOTP_USER_FIELDS);
  const hasPasskey = user ? !!(await PasskeyCredential.exists({ user: user._id })) : false;
  if (!user || (!user.totpEnabled && !hasPasskey) || user.isBanned ||
      (user.passwordChangedAt && challenge.createdAt < user.passwordChangedAt)) {
    challenge.usedAt = new Date();
    await challenge.save();
    throw new AppError('Phiên xác thực không còn hợp lệ', 401);
  }
  if (user.role === 'admin' && !isAdminIpAllowed(ip)) {
    throw new AppError('Địa chỉ IP này không được phép đăng nhập tài khoản quản trị viên', 403);
  }

  const lock = await checkLock(NS_MFA_LOGIN, user._id.toString());
  if (lock.locked) throw new AppError(`Bạn đã nhập sai quá nhiều lần. Thử lại sau ${lock.waitMinutes} phút.`, 429);

  if (!(await consumeSecondFactor(user, code))) {
    challenge.attempts += 1;
    if (challenge.attempts >= 5) challenge.usedAt = new Date();
    await challenge.save();
    await recordFailure(NS_MFA_LOGIN, user._id.toString());
    throw new AppError(`Mã xác thực không đúng, còn ${Math.max(0, 5 - challenge.attempts)} lần thử`, 401);
  }

  const consumed = await MfaChallenge.updateOne(
    { _id: challenge._id, usedAt: null, expiresAt: { $gt: new Date() } },
    { $set: { usedAt: new Date() } }
  );
  if (consumed.modifiedCount !== 1) throw new AppError('Phiên xác thực đã được sử dụng', 401);
  await clearFailures(NS_MFA_LOGIN, user._id.toString());
  LoginHistory.create({ user: user._id, success: true, ip, userAgent: challenge.userAgent })
    .catch(err => log.error({ err }, 'Ghi login history thất bại'));

  return { token: genBootstrapToken(user._id), user };
}

async function verifyManagementAuth(currentUser, { currentPassword, currentCode, code, stepUpChallengeToken } = {}) {
  const user = await verifyMfaPassword(currentUser._id, currentPassword);
  const hasPasskey = !!(await PasskeyCredential.exists({ user: user._id }));
  if (!user.totpEnabled && !hasPasskey) return user;
  if (stepUpChallengeToken) {
    const consumed = await MfaChallenge.updateOne(
      activeChallenge(stepUpChallengeToken, 'step-up', { user: user._id, verifiedAt: { $ne: null } }),
      { $set: { usedAt: new Date() } },
    );
    if (consumed.modifiedCount !== 1) throw new AppError('Xác thực Passkey đã hết hạn hoặc đã được sử dụng', 401);
    return user;
  }
  await consumeManagedFactor(user, currentCode || code);
  return user;
}

async function beginTotpSetup(currentUser, proof = {}) {
  const user = await verifyManagementAuth(currentUser, proof);

  const secret = generateTotpSecret();
  user.totpPendingSecret = encryptMfaSecret(secret);
  user.totpPendingExpiresAt = new Date(Date.now() + 10 * 60 * 1000);
  await user.save();
  return {
    secret,
    otpauthUri: buildTotpUri(secret, user.username),
    expiresAt: user.totpPendingExpiresAt,
  };
}

async function confirmTotpSetup(currentUser, { code } = {}, currentDeviceId, io) {
  const user = await User.findById(currentUser._id).select(TOTP_USER_FIELDS);
  if (!user?.totpPendingSecret || !user.totpPendingExpiresAt || user.totpPendingExpiresAt <= new Date()) {
    throw new AppError('Phiên thiết lập đã hết hạn, vui lòng bắt đầu lại', 400);
  }
  const key = user._id.toString();
  const lock = await checkLock(NS_TOTP_SETUP_CONFIRM, key);
  if (lock.locked) throw new AppError(`Bạn đã nhập sai quá nhiều lần. Thử lại sau ${lock.waitMinutes} phút.`, 429);
  const secret = decryptMfaSecret(user.totpPendingSecret);
  const step = verifyTotp(secret, code);
  if (step === null) {
    await recordFailure(NS_TOTP_SETUP_CONFIRM, key);
    throw new AppError('Mã xác thực không đúng', 401);
  }
  await clearFailures(NS_TOTP_SETUP_CONFIRM, key);

  const recoveryCodes = generateRecoveryCodes();
  user.totpEnabled = true;
  user.totpSecret = encryptMfaSecret(secret);
  user.totpPendingSecret = '';
  user.totpPendingExpiresAt = null;
  user.totpLastUsedStep = step;
  user.totpRecoveryCodes = recoveryCodes.map(codeValue => hashMfaValue(normalizeRecoveryCode(codeValue)));
  const revokedDeviceIds = revokeOtherDevices(user, currentDeviceId);
  await user.save();
  await MfaChallenge.deleteMany({ user: user._id });
  await finishSecurityChange(io, user._id, revokedDeviceIds);
  return { message: 'Đã bật xác thực hai bước', recoveryCodes, user };
}

async function disableTotp(currentUser, proof = {}, currentDeviceId, io) {
  const user = await verifyManagementAuth(currentUser, proof);
  if (!user.totpEnabled) throw new AppError('Xác thực hai bước chưa được bật', 400);

  const freshUser = await User.findById(user._id).select(TOTP_USER_FIELDS);
  freshUser.totpEnabled = false;
  freshUser.totpSecret = '';
  freshUser.totpPendingSecret = '';
  freshUser.totpPendingExpiresAt = null;
  freshUser.totpLastUsedStep = -1;
  if (!(await PasskeyCredential.exists({ user: freshUser._id }))) freshUser.totpRecoveryCodes = [];
  const revokedDeviceIds = revokeOtherDevices(freshUser, currentDeviceId);
  await freshUser.save();
  await MfaChallenge.deleteMany({ user: freshUser._id });
  await finishSecurityChange(io, freshUser._id, revokedDeviceIds);
  return { message: 'Đã tắt xác thực hai bước', user: freshUser };
}

async function regenerateTotpRecoveryCodes(currentUser, proof = {}, currentDeviceId, io) {
  const user = await verifyManagementAuth(currentUser, proof);
  if (!user.totpEnabled && !(await PasskeyCredential.exists({ user: user._id }))) {
    throw new AppError('Cần có TOTP hoặc Passkey trước khi tạo mã khôi phục', 400);
  }

  const recoveryCodes = generateRecoveryCodes();
  const freshUser = await User.findById(user._id).select(TOTP_USER_FIELDS);
  freshUser.totpRecoveryCodes = recoveryCodes.map(codeValue => hashMfaValue(normalizeRecoveryCode(codeValue)));
  const revokedDeviceIds = revokeOtherDevices(freshUser, currentDeviceId);
  await freshUser.save();
  await MfaChallenge.deleteMany({ user: freshUser._id });
  await finishSecurityChange(io, freshUser._id, revokedDeviceIds);
  return { message: 'Đã tạo bộ mã khôi phục mới', recoveryCodes, user: freshUser };
}

const activeChallenge = (token, purpose, extra = {}) => ({ tokenHash: challengeHash(token), purpose, usedAt: null, expiresAt: { $gt: new Date() }, ...extra });

async function getPasskeyLoginOptions(challengeToken, ip) {
  const challenge = await MfaChallenge.findOne(activeChallenge(challengeToken, 'login'));
  if (!challenge || challenge.attempts >= 5) throw new AppError('Phiên xác thực đã hết hạn, vui lòng đăng nhập lại', 401);
  const credentials = await PasskeyCredential.find({ user: challenge.user });
  if (!credentials.length) throw new AppError('Không tìm thấy Passkey', 401);
  const options = await webauthn.generateAuthenticationOptions(credentials);
  challenge.webAuthnChallenge = options.challenge;
  challenge.method = 'passkey';
  await challenge.save();
  return options;
}

async function advanceCounter(credential, newCounter) {
  if (credential.counter === 0 && newCounter === 0) return;
  if (newCounter <= credential.counter) throw new AppError('Xác thực Passkey thất bại', 401);
  const updated = await PasskeyCredential.updateOne({ _id: credential._id, counter: credential.counter }, { $set: { counter: newCounter, lastUsedAt: new Date() } });
  if (updated.modifiedCount !== 1) throw new AppError('Xác thực Passkey thất bại', 401);
}

async function verifyPasskeyLogin({ challengeToken, assertionBody } = {}, ip, log) {
  const ipLimit = await checkRateWindow(NS_MFA_LOGIN_IP, ip, { maxCount: 20, windowMs: 15 * 60 * 1000 });
  if (ipLimit.limited) throw new AppError('Quá nhiều lần xác thực. Vui lòng thử lại sau.', 429);
  const challenge = await MfaChallenge.findOne(activeChallenge(challengeToken, 'login', { method: 'passkey' }));
  if (!challenge || challenge.attempts >= 5) throw new AppError('Phiên xác thực đã hết hạn, vui lòng đăng nhập lại', 401);
  const credential = await PasskeyCredential.findOne({ credentialId: assertionBody?.id, user: challenge.user });
  try {
    if (!credential) throw new Error('credential missing');
    const result = await webauthn.verifyAuthentication(assertionBody, credential, challenge.webAuthnChallenge);
    if (!result.verified) throw new Error('not verified');
    await advanceCounter(credential, result.authenticationInfo.newCounter);
  } catch (err) {
    challenge.attempts += 1; if (challenge.attempts >= 5) challenge.usedAt = new Date(); await challenge.save();
    await recordFailure(NS_MFA_LOGIN, challenge.user.toString());
    throw err instanceof AppError ? err : new AppError('Xác thực Passkey thất bại', 401);
  }
  const consumed = await MfaChallenge.updateOne(activeChallenge(challengeToken, 'login', { _id: challenge._id }), { $set: { usedAt: new Date() } });
  if (consumed.modifiedCount !== 1) throw new AppError('Phiên xác thực đã được sử dụng', 401);
  await clearFailures(NS_MFA_LOGIN, challenge.user.toString());
  const user = await User.findById(challenge.user);
  LoginHistory.create({ user: user._id, success: true, ip, userAgent: challenge.userAgent }).catch(err => log.error({ err }, 'Ghi login history thất bại'));
  return { token: genBootstrapToken(user._id), user };
}

async function getMfaStatus(userId) {
  const [passkeyCount, user] = await Promise.all([PasskeyCredential.countDocuments({ user: userId }), User.findById(userId).select('+totpRecoveryCodes')]);
  return { totpEnabled: !!user?.totpEnabled, passkeyCount, hasRecoveryCodes: (user?.totpRecoveryCodes?.length || 0) > 0 };
}

async function listPasskeys(userId) { return PasskeyCredential.find({ user: userId }).select('credentialId name transports aaguid lastUsedAt createdAt').sort({ createdAt: -1 }); }

async function createPasskeyChallenge(userId, purpose, options, ip = '') {
  const challengeToken = crypto.randomBytes(32).toString('base64url');
  await MfaChallenge.create({
    tokenHash: challengeHash(challengeToken), user: userId, purpose, method: 'passkey',
    webAuthnChallenge: options.challenge, ip, expiresAt: new Date(Date.now() + 5 * 60 * 1000),
  });
  return { challengeToken, options };
}

async function beginPasskeyStepUp(currentUser, ip) {
  const credentials = await PasskeyCredential.find({ user: currentUser._id });
  if (!credentials.length) throw new AppError('Không tìm thấy Passkey để xác thực', 400);
  return createPasskeyChallenge(currentUser._id, 'step-up', await webauthn.generateAuthenticationOptions(credentials), ip);
}

async function verifyPasskeyStepUp(currentUser, { challengeToken, assertionBody } = {}) {
  const challenge = await MfaChallenge.findOne(activeChallenge(challengeToken, 'step-up', { user: currentUser._id, method: 'passkey', verifiedAt: null }));
  if (!challenge || challenge.attempts >= 5) throw new AppError('Phiên xác thực đã hết hạn, vui lòng thử lại', 401);
  const credential = await PasskeyCredential.findOne({ credentialId: assertionBody?.id, user: currentUser._id });
  try {
    if (!credential) throw new Error('credential missing');
    const result = await webauthn.verifyAuthentication(assertionBody, credential, challenge.webAuthnChallenge);
    if (!result.verified) throw new Error('not verified');
    await advanceCounter(credential, result.authenticationInfo.newCounter);
  } catch (err) {
    challenge.attempts += 1;
    if (challenge.attempts >= 5) challenge.usedAt = new Date();
    await challenge.save();
    await recordFailure(NS_MFA_MANAGEMENT_FACTOR, currentUser._id.toString());
    throw err instanceof AppError ? err : new AppError('Xác thực Passkey thất bại', 401);
  }
  const marked = await MfaChallenge.updateOne(activeChallenge(challengeToken, 'step-up', { _id: challenge._id, verifiedAt: null }), { $set: { verifiedAt: new Date() } });
  if (!marked.modifiedCount) throw new AppError('Phiên xác thực đã được sử dụng', 401);
  await clearFailures(NS_MFA_MANAGEMENT_FACTOR, currentUser._id.toString());
  return { challengeToken };
}

async function beginPasskeyRegistration(currentUser, proof = {}, ip) {
  const user = await verifyManagementAuth(currentUser, proof);
  const credentials = await PasskeyCredential.find({ user: user._id });
  return createPasskeyChallenge(user._id, 'registration', await webauthn.generateRegistrationOptions(user, credentials), ip);
}

async function finishPasskeyRegistration(currentUser, { challengeToken, registrationBody, name } = {}) {
  const challenge = await MfaChallenge.findOne(activeChallenge(challengeToken, 'registration', { user: currentUser._id, method: 'passkey' }));
  if (!challenge || challenge.attempts >= 5) throw new AppError('Phiên đăng ký đã hết hạn, vui lòng thử lại', 401);
  let result;
  try {
    result = await webauthn.verifyRegistration(registrationBody, challenge.webAuthnChallenge);
    if (!result.verified) throw new Error('not verified');
  } catch (err) {
    challenge.attempts += 1;
    if (challenge.attempts >= 5) challenge.usedAt = new Date();
    await challenge.save();
    await recordFailure(NS_MFA_MANAGEMENT_FACTOR, currentUser._id.toString());
    throw new AppError('Đăng ký Passkey thất bại', 400);
  }
  const info = result.registrationInfo;
  const credential = info.credential;
  const count = await PasskeyCredential.countDocuments({ user: currentUser._id });
  let created;
  try {
    created = await PasskeyCredential.create({ user: currentUser._id, credentialId: credential.id, publicKey: credential.publicKey, counter: credential.counter, transports: credential.transports || [], aaguid: info.aaguid || '', name: String(name || 'Passkey').trim().slice(0, 50) || 'Passkey' });
  } catch (err) {
    if (err?.code === 11000) throw new AppError('Passkey này đã được đăng ký', 409);
    throw err;
  }
  const consumed = await MfaChallenge.updateOne(activeChallenge(challengeToken, 'registration', { _id: challenge._id }), { $set: { usedAt: new Date() } });
  if (!consumed.modifiedCount) throw new AppError('Phiên đăng ký đã được sử dụng', 401);
  let recoveryCodes;
  const user = await User.findById(currentUser._id).select(TOTP_USER_FIELDS);
  if (count === 0 && !user.totpEnabled) {
    recoveryCodes = generateRecoveryCodes();
    user.totpRecoveryCodes = recoveryCodes.map(value => hashMfaValue(normalizeRecoveryCode(value)));
    await user.save();
  }
  return { credential: created, recoveryCodes };
}

async function renamePasskey(currentUser, credentialId, name) {
  const value = String(name || '').trim();
  if (!value || value.length > 50) throw new AppError('Tên Passkey phải dài 1-50 ký tự', 400);
  const credential = await PasskeyCredential.findOneAndUpdate({ user: currentUser._id, credentialId }, { $set: { name: value } }, { new: true });
  if (!credential) throw new AppError('Không tìm thấy Passkey', 404);
  return credential;
}

async function removePasskey(currentUser, credentialId, proof = {}) {
  await verifyManagementAuth(currentUser, proof);
  const credential = await PasskeyCredential.findOne({ user: currentUser._id, credentialId });
  if (!credential) throw new AppError('Không tìm thấy Passkey', 404);
  const remaining = await PasskeyCredential.countDocuments({ user: currentUser._id, credentialId: { $ne: credentialId } });
  if (!remaining && !currentUser.totpEnabled) throw new AppError('Bật TOTP hoặc thêm Passkey khác trước khi gỡ Passkey cuối.', 400);
  await credential.deleteOne();
  return { message: 'Đã gỡ Passkey' };
}

async function saveHistoryBackup(currentUser, { ciphertext, iv, sourceDeviceId, sourceE2eeKeyId, ...proof } = {}) {
  await verifyManagementAuth(currentUser, proof);
  if (![ciphertext, iv, sourceDeviceId, sourceE2eeKeyId].every(value => typeof value === 'string' && value.length)) {
    throw new AppError('Bản sao lưu không hợp lệ', 400);
  }
  if (ciphertext.length > 7 * 1024 * 1024 || iv.length > 64 || sourceDeviceId.length > 128 || sourceE2eeKeyId.length > 128) {
    throw new AppError('Bản sao lưu vượt quá giới hạn cho phép', 413);
  }
  const limit = await checkRateWindow(NS_HISTORY_BACKUP, currentUser._id.toString(), { maxCount: 10, windowMs: 60 * 60 * 1000 });
  if (limit.limited) throw new AppError('Bạn đã cập nhật bản sao lưu quá nhiều lần. Vui lòng thử lại sau.', 429);
  const backup = await HistoryBackup.findOneAndUpdate(
    { user: currentUser._id },
    { $set: { version: 1, ciphertext, iv, sourceDeviceId, sourceE2eeKeyId } },
    { new: true, upsert: true, runValidators: true },
  );
  return { message: 'Đã lưu bản sao lưu lịch sử được mã hóa', updatedAt: backup.updatedAt };
}

async function getHistoryBackup(userId) {
  const backup = await HistoryBackup.findOne({ user: userId }).select('version ciphertext iv sourceDeviceId sourceE2eeKeyId updatedAt');
  if (!backup) throw new AppError('Chưa có bản sao lưu lịch sử', 404);
  return backup;
}

async function deleteHistoryBackup(currentUser, proof = {}) {
  await verifyManagementAuth(currentUser, proof);
  await HistoryBackup.deleteOne({ user: currentUser._id });
  return { message: 'Đã xóa bản sao lưu lịch sử' };
}

async function getLoginHistory(userId) {
  return LoginHistory.find({ user: userId })
    .sort({ createdAt: -1 })
    .limit(50);
}

// ─── Hồ sơ cá nhân ───────────────────────────────────────────────────────────

const PRIVACY_SETTING_KEYS = ['bio', 'activityStatus', 'joinDate', 'gender', 'dateOfBirth', 'email', 'phone', 'readReceipts'];

async function updateProfile(currentUser, { nickname, email, phone, dateOfBirth, gender, bio, privacySettings }) {
  const updates = {};

  if (nickname && nickname !== currentUser.nickname) {
    const normalizedNickname = normalizeNickname(nickname);
    if (!isValidNickname(normalizedNickname))
      throw new AppError('Tên hiển thị không hợp lệ (2-20 ký tự, không chứa ký tự ẩn/điều khiển)', 400);

    if (currentUser.nicknameChangedAt) {
      const daysSinceChange = (Date.now() - new Date(currentUser.nicknameChangedAt)) / (1000 * 60 * 60 * 24);
      if (daysSinceChange < 7) {
        const daysLeft = Math.ceil(7 - daysSinceChange);
        throw new AppError(`Bạn chỉ có thể đổi tên hiển thị sau ${daysLeft} ngày nữa`, 400);
      }
    }

    updates.nickname = normalizedNickname;
    updates.nicknameChangedAt = new Date();
  }

  if (email && email !== decryptPII(currentUser.email)) {
    throw new AppError('Để đổi email, vui lòng sử dụng tính năng Đổi Email riêng có xác thực bảo mật.', 400);
  }

  const user = await User.findById(currentUser._id);
  if (!user) {
    throw new AppError('Không tìm thấy người dùng', 404);
  }

  if (updates.nickname) {
    user.nickname = updates.nickname;
    user.nicknameChangedAt = updates.nicknameChangedAt;
  }

  if (phone !== undefined) {
    const normalizedPhone = normalizePhone(phone);
    if (normalizedPhone && !isValidPhone(normalizedPhone))
      throw new AppError('Số điện thoại không hợp lệ', 400);
    user.phone = normalizedPhone;
  }

  if (dateOfBirth !== undefined) {
    const newDob = dateOfBirth ? String(dateOfBirth) : '';
    const currentDob = decryptPII(currentUser.dateOfBirth) || '';
    if (newDob !== currentDob) {
      if (currentUser.dateOfBirthChangedAt) {
        const daysSinceChange = (Date.now() - new Date(currentUser.dateOfBirthChangedAt)) / (1000 * 60 * 60 * 24);
        if (daysSinceChange < 7) {
          const daysLeft = Math.ceil(7 - daysSinceChange);
          throw new AppError(`Bạn chỉ có thể đổi ngày sinh sau ${daysLeft} ngày nữa`, 400);
        }
      }
      user.dateOfBirth = newDob;
      user.dateOfBirthChangedAt = new Date();
    }
  }

  if (gender !== undefined) {
    const newGender = ['male', 'female', 'other'].includes(gender) ? gender : '';
    if (newGender !== currentUser.gender) {
      if (currentUser.genderChangedAt) {
        const daysSinceChange = (Date.now() - new Date(currentUser.genderChangedAt)) / (1000 * 60 * 60 * 24);
        if (daysSinceChange < 7) {
          const daysLeft = Math.ceil(7 - daysSinceChange);
          throw new AppError(`Bạn chỉ có thể đổi giới tính sau ${daysLeft} ngày nữa`, 400);
        }
      }
      user.gender = newGender;
      user.genderChangedAt = new Date();
    }
  }

  if (bio !== undefined) {
    user.bio = bio.slice(0, 150);
  }

  // Chỉ nhận đúng các key đã khai báo trong schema (whitelist) — bỏ qua key lạ thay vì lưu rác;
  // giá trị sai enum ('friends'/'private') để Mongoose tự chặn lúc user.save() bên dưới.
  if (privacySettings !== undefined) {
    const privacyUpdates = {};
    for (const key of PRIVACY_SETTING_KEYS) {
      if (privacySettings[key] !== undefined) privacyUpdates[key] = privacySettings[key];
    }
    user.privacySettings = { ...user.privacySettings, ...privacyUpdates };
  }

  await user.save();

  return user;
}

async function requestEmailChange(currentUser, { currentPassword, newEmail }, log) {
  if (!currentPassword || !newEmail)
    throw new AppError('Vui lòng nhập đầy đủ mật khẩu hiện tại và email mới', 400);

  const lowerNewEmail = normalizeEmail(newEmail);
  if (!isValidEmail(lowerNewEmail))
    throw new AppError('Email mới không hợp lệ', 400);
  if (lowerNewEmail === decryptPII(currentUser.email).toLowerCase()) {
    throw new AppError('Email mới trùng với email hiện tại', 400);
  }

  const user = await User.findById(currentUser._id);
  const isMatch = await user.comparePassword(currentPassword);
  if (!isMatch)
    throw new AppError('Mật khẩu hiện tại không đúng', 401);

  const emailExists = await User.findOne({ emailHash: { $in: hashBlindIndexAllKeys(lowerNewEmail) } });
  if (emailExists)
    throw new AppError('Email này đã được sử dụng bởi tài khoản khác', 400);

  const existingRecord = await EmailChange.findOne({ userId: currentUser._id });
  if (existingRecord && existingRecord.updatedAt) {
    const secondsSinceLastRequest = (Date.now() - new Date(existingRecord.updatedAt).getTime()) / 1000;
    if (secondsSinceLastRequest < 60) {
      throw new AppError(`Vui lòng chờ ${Math.ceil(60 - secondsSinceLastRequest)} giây trước khi gửi lại mã`, 429);
    }
  }

  const otp = generateOTP();
  const hashedOtp = hashOTP(otp);
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 phút

  await EmailChange.findOneAndUpdate(
    { userId: currentUser._id },
    {
      newEmail: lowerNewEmail,
      otp: hashedOtp,
      expiresAt,
      attempts: 0,
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  // Gửi OTP về Email Mới để xác nhận quyền sở hữu hộp thư mới
  try {
    await sendEmailChangeOTPEmail(lowerNewEmail, otp);
    if (process.env.NODE_ENV !== 'production') log.debug(`[SECURITY DEBUG] Email Change OTP for new email ${lowerNewEmail}: ${otp}`);
  } catch (mailErr) {
    log.warn({ err: mailErr }, 'Lỗi gửi mail OTP đổi email');
  }

  // Gửi email cảnh báo bảo mật tới Email CŨ
  try {
    await sendEmailChangeNoticeEmail(decryptPII(currentUser.email), lowerNewEmail);
  } catch (noticeErr) {
    log.warn({ err: noticeErr }, 'Lỗi gửi mail cảnh báo bảo mật tới email cũ');
  }

  return { message: 'Mã OTP xác thực đã được gửi tới email mới của bạn. Chúng tôi cũng đã gửi một email cảnh báo bảo mật tới địa chỉ email hiện tại.' };
}

async function verifyEmailChange(currentUser, { newEmail, otp }) {
  if (!newEmail || !otp)
    throw new AppError('Thiếu email mới hoặc mã OTP', 400);

  const lowerNewEmail = normalizeEmail(newEmail);
  if (!isValidEmail(lowerNewEmail))
    throw new AppError('Email mới không hợp lệ', 400);

  const record = await EmailChange.findOne({ userId: currentUser._id, newEmail: lowerNewEmail });
  if (!record)
    throw new AppError('Không tìm thấy yêu cầu thay đổi email', 400);

  if (new Date() > record.expiresAt) {
    await EmailChange.deleteOne({ _id: record._id });
    throw new AppError('Mã OTP đã hết hạn, vui lòng thực hiện lại', 400);
  }

  if (record.attempts >= 5) {
    await EmailChange.deleteOne({ _id: record._id });
    throw new AppError('Quá nhiều lần nhập sai mã OTP, vui lòng thực hiện lại', 400);
  }

  const hashedInputOtp = hashOTP(otp.trim());
  if (record.otp !== hashedInputOtp) {
    record.attempts += 1;
    await record.save();
    const remaining = 5 - record.attempts;
    throw new AppError(`Mã OTP không chính xác, còn ${remaining} lần thử`, 400);
  }

  // Kiểm tra lại lần nữa phòng trường hợp email vừa bị chiếm trong khi chờ nhập OTP
  const emailExists = await User.findOne({ emailHash: { $in: hashBlindIndexAllKeys(lowerNewEmail) }, _id: { $ne: currentUser._id } });
  if (emailExists) {
    await EmailChange.deleteOne({ _id: record._id });
    throw new AppError('Email này đã được tài khoản khác sử dụng', 400);
  }

  // Dùng .save() thay vì findByIdAndUpdate — findByIdAndUpdate bỏ qua pre('save') hook nên sẽ
  // ghi thẳng email dạng plaintext, không mã hóa/không cập nhật emailHash.
  const updatedUser = await User.findById(currentUser._id);
  updatedUser.email = lowerNewEmail;
  await updatedUser.save();

  await EmailChange.deleteOne({ _id: record._id });

  return { message: 'Đổi email thành công!', user: updatedUser };
}

async function changePassword(currentUser, { currentPassword, newPassword }) {
  if (!currentPassword || !newPassword)
    throw new AppError('Vui lòng nhập đầy đủ thông tin', 400);
  if (!isValidPassword(newPassword))
    throw new AppError('Mật khẩu mới phải có từ 8-30 ký tự', 400);

  if (currentUser.passwordChangeRequestedAt) {
    const daysSinceChange = (Date.now() - new Date(currentUser.passwordChangeRequestedAt)) / (1000 * 60 * 60 * 24);
    if (daysSinceChange < 14) {
      const daysLeft = Math.ceil(14 - daysSinceChange);
      throw new AppError(`Bạn chỉ có thể đổi mật khẩu sau ${daysLeft} ngày nữa`, 400);
    }
  }

  const user = await User.findById(currentUser._id);
  const isMatch = await user.comparePassword(currentPassword);
  if (!isMatch)
    throw new AppError('Mật khẩu hiện tại không đúng', 401);

  user.password = newPassword; // sẽ tự hash qua pre('save')
  user.passwordChangeRequestedAt = new Date();
  await user.save();

  return { message: 'Đổi mật khẩu thành công' };
}

async function updateAvatar(currentUser, file) {
  if (!file)
    throw new AppError('Không có file ảnh', 400);

  if (currentUser.avatarChangedAt) {
    const daysSinceChange = (Date.now() - new Date(currentUser.avatarChangedAt)) / (1000 * 60 * 60 * 24);
    if (daysSinceChange < 1) {
      const hoursLeft = Math.ceil((1 - daysSinceChange) * 24);
      throw new AppError(`Bạn chỉ có thể đổi ảnh đại diện sau ${hoursLeft} giờ nữa`, 400);
    }
  }

  const oldAvatar = currentUser.avatar;
  const avatarUrl = file.path; // Cloudinary trả về URL trong path

  const user = await User.findByIdAndUpdate(
    currentUser._id,
    { avatar: avatarUrl, avatarChangedAt: new Date() },
    { returnDocument: 'after' }
  );

  if (oldAvatar && oldAvatar !== avatarUrl) {
    deleteCloudinaryImage(oldAvatar);
  }

  return user;
}

// Dùng chung bởi updateCover/removeCover — cooldown 1 ngày tính chung cho cả đổi lẫn xóa cover.
function checkCoverCooldown(currentUser) {
  if (!currentUser.coverChangedAt) return;
  const daysSinceChange = (Date.now() - new Date(currentUser.coverChangedAt)) / (1000 * 60 * 60 * 24);
  if (daysSinceChange < 1) {
    const hoursLeft = Math.ceil((1 - daysSinceChange) * 24);
    throw new AppError(`Bạn chỉ có thể đổi ảnh bìa sau ${hoursLeft} giờ nữa`, 400);
  }
}

async function updateCover(currentUser, file) {
  if (!file)
    throw new AppError('Không có file ảnh', 400);
  checkCoverCooldown(currentUser);

  const oldCover = currentUser.cover;
  const coverUrl = file.path; // Cloudinary trả về URL trong path

  const user = await User.findByIdAndUpdate(
    currentUser._id,
    { cover: coverUrl, coverChangedAt: new Date() },
    { returnDocument: 'after' }
  );

  if (oldCover && oldCover !== coverUrl) {
    deleteCloudinaryImage(oldCover);
  }

  return user;
}

async function removeCover(currentUser) {
  checkCoverCooldown(currentUser);

  const oldCover = currentUser.cover;

  const user = await User.findByIdAndUpdate(
    currentUser._id,
    { cover: '', coverChangedAt: new Date() },
    { returnDocument: 'after' }
  );

  if (oldCover) {
    deleteCloudinaryImage(oldCover);
  }

  return user;
}

// ─── Quên mật khẩu / đặt lại mật khẩu ───────────────────────────────────────

async function forgotPassword({ email, turnstileToken }, ip, log) {
  if (!email)
    throw new AppError('Vui lòng nhập email', 400);

  // Chặn bot trước cả rate-limit theo IP/email bên dưới
  if (!(await verifyTurnstile(turnstileToken, ip))) {
    throw new AppError('Xác minh CAPTCHA thất bại, vui lòng thử lại', 400);
  }

  const lowerEmail = normalizeEmail(email);
  if (!isValidEmail(lowerEmail))
    throw new AppError('Email không hợp lệ', 400);

  // Chống spam: tối đa 5 lần yêu cầu/15 phút theo IP — chặn trước khi chạm DB
  const ipLock = await checkLock(NS_FORGOT_PASSWORD_IP, ip);
  if (ipLock.locked) {
    throw new AppError(`Bạn đã yêu cầu quá nhiều lần. Thử lại sau ${ipLock.waitMinutes} phút.`, 429);
  }
  await recordFailure(NS_FORGOT_PASSWORD_IP, ip);

  const user = await User.findOne({ emailHash: { $in: hashBlindIndexAllKeys(lowerEmail) } });

  // Trả về thông báo chung để chống lộ thông tin người dùng (User Enumeration Protection)
  const genericResponse = {
    message: 'Nếu email tồn tại trên hệ thống, mã OTP đã được gửi tới email của bạn'
  };

  if (!user) {
    return genericResponse;
  }

  const existingRecord = await PasswordReset.findOne({ email: lowerEmail });
  if (existingRecord && existingRecord.updatedAt) {
    const secondsSinceLastRequest = (Date.now() - new Date(existingRecord.updatedAt).getTime()) / 1000;
    if (secondsSinceLastRequest < 60) {
      throw new AppError(`Vui lòng chờ ${Math.ceil(60 - secondsSinceLastRequest)} giây trước khi gửi lại mã`, 429);
    }
  }

  // Thêm trần 3 lần/15 phút theo email đích (cooldown 60s ở trên chỉ chặn dồn dập sát nhau,
  // vẫn lọt nếu request đúng cách nhau >60s liên tục) + ngân sách chung toàn hệ thống/ngày
  const emailLock = await checkLock(NS_FORGOT_PASSWORD_EMAIL, lowerEmail);
  if (emailLock.locked) {
    throw new AppError(`Email này đã yêu cầu quá nhiều lần. Thử lại sau ${emailLock.waitMinutes} phút.`, 429);
  }

  const otp       = generateOTP();
  const hashedOtp = hashOTP(otp);
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 phút

  // Sử dụng findOneAndUpdate với upsert để phòng tránh Race Conditions
  await PasswordReset.findOneAndUpdate(
    { email: lowerEmail },
    {
      otp: hashedOtp,
      expiresAt,
      attempts: 0,
      isVerified: false,
      resetToken: null,
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  // Giữ chỗ ngân sách OTP toàn hệ thống/ngày NGAY TRƯỚC khi tốn quota Brevo thật — cùng lý do
  // atomic check+increment như send-otp phía trên.
  const budgetCheck = await checkRateWindow(NS_DAILY_OTP_BUDGET, 'global', { maxCount: DAILY_OTP_BUDGET_MAX, windowMs: DAY_MS });
  if (budgetCheck.limited) {
    throw new AppError('Hệ thống tạm ngừng gửi email OTP hôm nay, vui lòng thử lại vào ngày mai.', 503);
  }

  // Gửi Email OTP và bắt lỗi gián đoạn dịch vụ SMTP
  try {
    await sendResetPasswordOTPEmail(lowerEmail, otp);
    if (process.env.NODE_ENV !== 'production') log.debug(`[SECURITY DEBUG] Reset Password OTP for ${lowerEmail}: ${otp}`);
  } catch (mailErr) {
    log.warn({ err: mailErr }, 'Lỗi dịch vụ gửi mail SMTP');
  }
  await recordFailure(NS_FORGOT_PASSWORD_EMAIL, lowerEmail, { maxAttempts: 3, lockMinutes: 15 });

  return genericResponse;
}

async function verifyResetOtp({ email, otp }) {
  const lowerEmail = normalizeEmail(email);
  if (!lowerEmail || !otp)
    throw new AppError('Thiếu email hoặc mã OTP', 400);
  if (!isValidEmail(lowerEmail))
    throw new AppError('Email không hợp lệ', 400);

  const record = await PasswordReset.findOne({ email: lowerEmail });
  if (!record)
    throw new AppError('Không tìm thấy yêu cầu đặt lại mật khẩu', 400);

  if (new Date() > record.expiresAt) {
    await PasswordReset.deleteOne({ email: lowerEmail });
    throw new AppError('Mã OTP đã hết hạn, vui lòng yêu cầu gửi lại mã mới', 400);
  }

  if (record.attempts >= 5) {
    await PasswordReset.deleteOne({ email: lowerEmail });
    throw new AppError('Quá nhiều lần nhập sai mã OTP, vui lòng thực hiện lại từ đầu', 400);
  }

  const hashedInputOtp = hashOTP(otp.trim());
  if (record.otp !== hashedInputOtp) {
    record.attempts += 1;
    await record.save();
    const remaining = 5 - record.attempts;
    throw new AppError(`Mã OTP không chính xác, còn ${remaining} lần thử`, 400);
  }

  const resetToken = signJwt(
    { email: lowerEmail, purpose: 'password_reset' },
    { expiresIn: '10m' }
  );

  record.isVerified = true;
  record.resetToken = resetToken;
  await record.save();

  return { message: 'Xác thực OTP thành công', resetToken };
}

async function resetPassword({ email, resetToken, newPassword }) {
  const lowerEmail = normalizeEmail(email);
  if (!lowerEmail || !resetToken || !newPassword)
    throw new AppError('Vui lòng điền đầy đủ thông tin', 400);
  if (!isValidEmail(lowerEmail))
    throw new AppError('Email không hợp lệ', 400);

  if (!isValidPassword(newPassword))
    throw new AppError('Mật khẩu mới phải có từ 8-30 ký tự', 400);

  const hasLetter = /[a-zA-Z]/.test(newPassword);
  const hasNumber = /[0-9]/.test(newPassword);
  if (!hasLetter || !hasNumber) {
    throw new AppError('Mật khẩu mới phải bao gồm cả chữ cái và chữ số', 400);
  }

  let decoded;
  try {
    decoded = verifyJwt(resetToken);
  } catch {
    throw new AppError('Phiên làm việc đã hết hạn, vui lòng thực hiện lại từ đầu', 400);
  }

  if (decoded.purpose !== 'password_reset' || decoded.email !== lowerEmail) {
    throw new AppError('Mã token khôi phục không hợp lệ', 400);
  }

  const record = await PasswordReset.findOne({
    email: lowerEmail,
    resetToken,
    isVerified: true,
  });
  if (!record) {
    throw new AppError('Yêu cầu không hợp lệ hoặc đã hết hạn', 400);
  }

  const user = await User.findOne({ emailHash: { $in: hashBlindIndexAllKeys(lowerEmail) } });
  if (!user) {
    throw new AppError('Không tìm thấy người dùng', 404);
  }

  user.password = newPassword; // sẽ tự hash trong userSchema.pre('save')
  await user.save();

  await PasswordReset.deleteOne({ email: lowerEmail });

  return { message: 'Đặt lại mật khẩu thành công! Vui lòng đăng nhập bằng mật khẩu mới.' };
}

// ─── Thiết bị (device management) ───────────────────────────────────────────

// Rate limit namespaces cho device management
const NS_DEVICE_PASSWORD = 'device-password';
const NS_DEVICE_MUTATION = 'device-mutation';
const NS_DEVICE_RENEWAL = 'device-renewal';

// Helper emit debounced key:changed event
const debouncedKeyChangedTimers = new Map();
function triggerDebouncedKeyChanged(io, userId) {
  // Invalidate cache publicKey NGAY, độc lập debounce 30s bên dưới (debounce chỉ hoãn báo socket).
  deviceKeysCache.invalidate(userId).catch(() => {});

  if (!io) return;
  const uIdStr = userId.toString();
  if (debouncedKeyChangedTimers.has(uIdStr)) {
    clearTimeout(debouncedKeyChangedTimers.get(uIdStr));
  }
  const timer = setTimeout(async () => {
    debouncedKeyChangedTimers.delete(uIdStr);
    // Bảo mật: chỉ báo cho người CÙNG PHÒNG với user này biết — io.emit() cũ phát cho TOÀN
    // SERVER, lộ metadata "user X vừa đổi/thêm/gỡ thiết bị" cho cả người lạ không liên quan.
    const rooms = await Room.find({ members: userId }).select('_id');
    rooms.forEach(r => io.to(r._id.toString()).emit('key:changed', { userId: uIdStr, timestamp: Date.now() }));
  }, 30000);
  debouncedKeyChangedTimers.set(uIdStr, timer);
}

// Cache kết quả "Mongo có hỗ trợ transaction không" (replica set/mongos) qua các request, tránh dò lại mỗi lần.
let transactionsSupported = null;

// publicKey lưu dạng chuỗi JSON JWK (RSA-OAEP, xem client/src/crypto/deviceKeys.js#exportPublicKey)
// — không check thì dữ liệu rác (vd chuỗi test không phải JSON) lọt vào DB, khiến MỌI người gửi
// tin trong phòng chung với chủ thiết bị đó dính lỗi JSON.parse lúc mã hóa (wrapKeyForDevices tự
// bỏ qua không crash, nhưng thiết bị đó vĩnh viễn không giải mã được gì).
function isValidRsaJwk(publicKey) {
  try {
    const jwk = JSON.parse(publicKey);
    return jwk?.kty === 'RSA' && !!jwk.n && !!jwk.e;
  } catch {
    return false;
  }
}

async function registerOrRenewDevice(currentUser, { deviceId, e2eeKeyId, publicKey, deviceName, currentPassword }, io) {
  if (!deviceId || !publicKey || !currentPassword) {
    throw new AppError('Vui lòng cung cấp đầy đủ deviceId, publicKey và mật khẩu xác nhận', 400);
  }
  if (!isValidRsaJwk(publicKey)) {
    throw new AppError('publicKey không đúng định dạng JWK (RSA-OAEP)', 400);
  }

  const userId = currentUser._id.toString();

  // 1. Password Brute-Force Rate Limiter (Max 5 sai / 15m)
  const lock = await checkLock(NS_DEVICE_PASSWORD, userId);
  if (lock.locked) {
    throw new AppError(`Tài khoản tạm thời bị khóa đăng ký thiết bị do nhập sai mật khẩu quá 5 lần. Thử lại sau ${lock.waitMinutes} phút.`, 429);
  }

  // req.user không có field password (bị protect middleware loại bỏ), phải fetch riêng để so khớp
  const userWithPassword = await User.findById(currentUser._id);
  const isMatch = await userWithPassword.comparePassword(currentPassword);
  if (!isMatch) {
    await recordFailure(NS_DEVICE_PASSWORD, userId);
    throw new AppError('Mật khẩu xác nhận không chính xác', 401);
  }
  await clearFailures(NS_DEVICE_PASSWORD, userId);

  // Xử lý 3 nhánh bằng Transaction (kèm fallback nếu không có replica set)
  let finalShouldEmit = false;
  let finalRawToken = null;
  let retries = 3;

  while (retries > 0) {
    let shouldEmitThisTry = false;
    let session = null;
    let isReplicaSet = transactionsSupported !== false;
    // Sinh mới mỗi lần thử — token cũ của lần thử thất bại (transient transaction error) không
    // được lưu nên tự động bỏ đi, không cần dọn dẹp riêng.
    const rawToken = generateDeviceToken();
    const tokenHash = hashDeviceToken(rawToken);

    if (isReplicaSet) {
      try {
        session = await mongoose.startSession();
        session.startTransaction();
      } catch {
        isReplicaSet = false;
        transactionsSupported = false;
        if (session) session.endSession();
      }
    }

    try {
      const user = isReplicaSet
        ? await User.findById(currentUser._id).session(session)
        : await User.findById(currentUser._id);

      const existingDevice = user.devices.find(d => d.deviceId === deviceId);

      if (!existingDevice) {
        // Nhánh 1: Device chưa tồn tại (Device Mới)
        const activeDevicesCount = user.devices.filter(d => !d.isRevoked).length;
        if (activeDevicesCount >= 5) {
          if (isReplicaSet && session) { await session.abortTransaction(); session.endSession(); }
          throw new AppError('Tài khoản đã đạt giới hạn 5 thiết bị đang hoạt động. Vui lòng gỡ bớt thiết bị cũ.', 400);
        }

        const mutLimit = await checkRateWindow(NS_DEVICE_MUTATION, userId, { maxCount: 3, windowMs: 3600000 });
        if (mutLimit.limited) {
          if (isReplicaSet && session) { await session.abortTransaction(); session.endSession(); }
          throw new AppError('Bạn đã thay đổi thiết bị quá 3 lần/giờ. Vui lòng thử lại sau.', 429);
        }

        user.devices.push({
          deviceId,
          e2eeKeyId: e2eeKeyId || deviceId,
          publicKey,
          deviceName: deviceName || 'Unknown Device',
          tokenHash,
          isRevoked: false,
          registeredAt: new Date(),
          lastActiveAt: new Date(),
        });
        shouldEmitThisTry = true;
      } else if (existingDevice.isRevoked) {
        // Nhánh 2: Device tồn tại và isRevoked === true (Reactivation)
        const mutLimit = await checkRateWindow(NS_DEVICE_MUTATION, userId, { maxCount: 3, windowMs: 3600000 });
        if (mutLimit.limited) {
          if (isReplicaSet && session) { await session.abortTransaction(); session.endSession(); }
          throw new AppError('Bạn đã thay đổi thiết bị quá 3 lần/giờ. Vui lòng thử lại sau.', 429);
        }

        existingDevice.isRevoked = false;
        existingDevice.revokedAt = null;
        existingDevice.publicKey = publicKey;
        existingDevice.deviceName = deviceName || existingDevice.deviceName;
        existingDevice.tokenHash = tokenHash;
        existingDevice.lastActiveAt = new Date();
        shouldEmitThisTry = true;
      } else {
        // Nhánh 3: Device tồn tại và isRevoked === false (Active Device)
        if (existingDevice.publicKey === publicKey) {
          // Case 3a: gia hạn token bình thường — token opaque cũ bị thay hẳn, không song song với token mới.
          const renewLimit = await checkRateWindow(NS_DEVICE_RENEWAL, userId, { maxCount: 30, windowMs: 3600000 });
          if (renewLimit.limited) {
            if (isReplicaSet && session) { await session.abortTransaction(); session.endSession(); }
            throw new AppError('Quá nhiều yêu cầu gia hạn thiết bị. Thử lại sau.', 429);
          }

          existingDevice.tokenHash = tokenHash;
          existingDevice.lastActiveAt = new Date();
          if (deviceName) existingDevice.deviceName = deviceName;
          shouldEmitThisTry = false;
        } else {
          // Case 3b: Key Rotation / Mất Storage (publicKey khác cũ)
          const mutLimit = await checkRateWindow(NS_DEVICE_MUTATION, userId, { maxCount: 3, windowMs: 3600000 });
          if (mutLimit.limited) {
            if (isReplicaSet && session) { await session.abortTransaction(); session.endSession(); }
            throw new AppError('Bạn đã thay đổi thiết bị quá 3 lần/giờ. Vui lòng thử lại sau.', 429);
          }

          existingDevice.publicKey = publicKey;
          if (deviceName) existingDevice.deviceName = deviceName;
          existingDevice.tokenHash = tokenHash;
          existingDevice.lastActiveAt = new Date();
          shouldEmitThisTry = true;
        }
      }

      if (isReplicaSet && session) {
        await user.save({ session });
        await session.commitTransaction();
        session.endSession();
        transactionsSupported = true;
      } else {
        await user.save();
      }

      finalShouldEmit = shouldEmitThisTry;
      finalRawToken = rawToken;
      break;
    } catch (err) {
      if (isReplicaSet && session) {
        try { await session.abortTransaction(); } catch { /* session có thể đã hỏng sẵn, bỏ qua */ }
        session.endSession();
      }

      if (err instanceof AppError) throw err;

      // Standalone Mongo từ chối transaction ở query đầu tiên gắn session, không phải lúc startTransaction()
      // — phát hiện lỗi code 20, nhớ lại, thử lại ngay không dùng session (không tính vào retries).
      if (isReplicaSet && err.code === 20 && /replica set|mongos/i.test(err.message || '')) {
        transactionsSupported = false;
        continue;
      }

      if (err.hasErrorLabel && err.hasErrorLabel('TransientTransactionError') && retries > 1) {
        retries--;
        continue;
      }
      throw err;
    }
  }

  if (finalShouldEmit) {
    triggerDebouncedKeyChanged(io, currentUser._id);
  }

  return {
    message: 'Đăng ký thiết bị thành công',
    token: finalRawToken,
    deviceId,
  };
}

async function revokeDevice(currentUser, deviceId, currentPassword, io) {
  if (!currentPassword) {
    throw new AppError('Vui lòng nhập mật khẩu để xác nhận gỡ thiết bị', 400);
  }

  const device = currentUser.devices.find(d => d.deviceId === deviceId);
  if (!device) {
    throw new AppError('Không tìm thấy thiết bị cần gỡ', 404);
  }

  if (device.isRevoked) {
    return { message: 'Thiết bị này đã bị gỡ trước đó' };
  }

  // Bắt buộc xác nhận lại mật khẩu — token bị đánh cắp không đủ để gỡ thiết bị khác mà không biết mật khẩu.
  const userId = currentUser._id.toString();
  const lock = await checkLock(NS_DEVICE_PASSWORD, userId);
  if (lock.locked) {
    throw new AppError(`Tài khoản tạm thời bị khóa do nhập sai mật khẩu quá nhiều lần. Thử lại sau ${lock.waitMinutes} phút.`, 429);
  }

  // req.user không có field password (bị protect middleware loại bỏ), phải fetch riêng để so khớp
  const userWithPassword = await User.findById(currentUser._id);
  const isMatch = await userWithPassword.comparePassword(currentPassword);
  if (!isMatch) {
    await recordFailure(NS_DEVICE_PASSWORD, userId);
    throw new AppError('Mật khẩu xác nhận không chính xác', 401);
  }
  await clearFailures(NS_DEVICE_PASSWORD, userId);

  device.isRevoked = true;
  device.revokedAt = new Date();
  device.tokenHash = null;

  await currentUser.save();

  triggerDebouncedKeyChanged(io, currentUser._id);

  return { message: 'Đã gỡ bỏ thiết bị thành công', deviceId };
}

// tokenHash không bao giờ được lộ ra ngoài (kể cả đã hash) — subdocument không đi qua
// User.toJSON() như document cha nên phải tự lọc ở đây.
function listDevices(currentUser, includeRevoked) {
  return currentUser.devices
    .filter(d => includeRevoked || !d.isRevoked)
    .map(d => { const { tokenHash, ...rest } = d.toObject(); return rest; });
}

// Logout: thu hồi token hiện tại (xóa tokenHash của thiết bị) — khác revokeDevice, không xóa hẳn thiết bị.
async function logout(currentUser, deviceId) {
  if (deviceId) {
    const device = currentUser.devices.find(d => d.deviceId === deviceId);
    if (device) {
      device.tokenHash = null;
      await currentUser.save();
    }
  }
  // Bootstrap token (chưa đăng ký thiết bị, hạn sẵn 15 phút) — không có gì để thu hồi thêm
  return { message: 'Đã đăng xuất' };
}

module.exports = {
  sendRegisterOtp,
  verifyRegisterOtp,
  checkUsernameAvailable,
  setNickname,
  login,
  verifyTotpLogin,
  beginTotpSetup,
  confirmTotpSetup,
  disableTotp,
  regenerateTotpRecoveryCodes,
  getPasskeyLoginOptions,
  verifyPasskeyLogin,
  getMfaStatus,
  listPasskeys,
  beginPasskeyStepUp,
  verifyPasskeyStepUp,
  beginPasskeyRegistration,
  finishPasskeyRegistration,
  renamePasskey,
  removePasskey,
  saveHistoryBackup,
  getHistoryBackup,
  deleteHistoryBackup,
  getLoginHistory,
  updateProfile,
  requestEmailChange,
  verifyEmailChange,
  changePassword,
  updateAvatar,
  updateCover,
  removeCover,
  forgotPassword,
  verifyResetOtp,
  resetPassword,
  registerOrRenewDevice,
  revokeDevice,
  listDevices,
  logout,
};
