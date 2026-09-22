const authService = require('../services/auth.service');
const accountDeletionService = require('../services/accountDeletion.service');
const AppError = require('../utils/AppError');
const handleError = require('../utils/handleError');
const { setAuthCookie, clearAuthCookie } = require('../utils/auth/authCookie');
const deviceLinkService = require('../services/deviceLink.service');
const { getCallIceServers } = require('../services/turnCredentials.service');
const { checkRateWindow } = require('../utils/rateLimiter');

const NS_DEVICE_LINK = 'device-link';
const NS_DEVICE_LINK_CODE = 'device-link-code';
const NS_DEVICE_LINK_PART = 'device-link-part';
const allowDeviceLink = async (req, res) => {
  const { limited } = await checkRateWindow(NS_DEVICE_LINK, req.user._id.toString(), { maxCount: 20, windowMs: 10 * 60 * 1000 });
  if (!limited) return true;
  res.status(429).json({ message: 'Thao tác liên kết thiết bị quá nhanh, vui lòng thử lại sau' });
  return false;
};
const allowDeviceLinkCode = async (req, res) => {
  const [userLimit, ipLimit] = await Promise.all([
    checkRateWindow(NS_DEVICE_LINK_CODE, req.user._id.toString(), { maxCount: 5, windowMs: 10 * 60 * 1000 }),
    checkRateWindow(`${NS_DEVICE_LINK_CODE}:ip`, req.ip, { maxCount: 15, windowMs: 10 * 60 * 1000 }),
  ]);
  if (!userLimit.limited && !ipLimit.limited) return true;
  res.status(429).json({ message: 'Thao tác liên kết thiết bị quá nhanh, vui lòng thử lại sau' });
  return false;
};
const allowDeviceLinkPart = async (req, res) => {
  const { limited } = await checkRateWindow(
    NS_DEVICE_LINK_PART,
    `${req.user._id}:${req.params.id}`,
    { maxCount: 300, windowMs: 10 * 60 * 1000 },
  );
  if (!limited) return true;
  res.status(429).json({ message: 'Cấp URL archive quá nhanh, vui lòng thử lại sau' });
  return false;
};

// Dịch AppError thành đúng status/message/field, khác handleError dùng chung ở chỗ fallback 500
// là message tĩnh do route tự chọn (giữ đúng hành vi gốc của từng route) thay vì sendServerError.
function handleWithCustomFallback(res, err, log, logMsg, fallbackMessage) {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({ message: err.message, ...err.extra });
  }
  log.error({ err }, logMsg);
  res.status(500).json({ message: fallbackMessage });
}

exports.sendRegisterOtp = async (req, res) => {
  try {
    const result = await authService.sendRegisterOtp(req.body, req.ip, req.log);
    res.json(result);
  } catch (err) {
    handleWithCustomFallback(res, err, req.log, 'send-otp error', 'Lỗi gửi OTP, vui lòng thử lại');
  }
};

exports.verifyRegisterOtp = async (req, res) => {
  try {
    const { token, ...result } = await authService.verifyRegisterOtp(req.body);
    setAuthCookie(res, token);
    res.status(201).json(result);
  } catch (err) {
    handleError(res, err);
  }
};

exports.checkUsernameAvailable = async (req, res) => {
  try {
    res.json(await authService.checkUsernameAvailable(req.body.username, req.ip));
  } catch (err) {
    handleError(res, err);
  }
};

exports.setNickname = async (req, res) => {
  try {
    res.json(await authService.setNickname(req.user, req.body.nickname));
  } catch (err) {
    handleError(res, err);
  }
};

exports.login = async (req, res) => {
  try {
    const { token, ...result } = await authService.login(req.body, req.ip, req.headers['user-agent'], req.log);
    if (token) setAuthCookie(res, token);
    else clearAuthCookie(res);
    res.json(result);
  } catch (err) {
    handleError(res, err);
  }
};

exports.verifyTotpLogin = async (req, res) => {
  try {
    const { token, ...result } = await authService.verifyTotpLogin(req.body, req.ip, req.log);
    setAuthCookie(res, token);
    res.json(result);
  } catch (err) {
    handleError(res, err);
  }
};

exports.getPasskeyLoginOptions = async (req, res) => {
  try { res.json(await authService.getPasskeyLoginOptions(req.body.challengeToken, req.ip)); } catch (err) { handleError(res, err); }
};
exports.verifyPasskeyLogin = async (req, res) => {
  try { const { token, ...result } = await authService.verifyPasskeyLogin(req.body, req.ip, req.log); setAuthCookie(res, token); res.json(result); } catch (err) { handleError(res, err); }
};
exports.getMfaStatus = async (req, res) => {
  try { res.json(await authService.getMfaStatus(req.user._id)); } catch (err) { handleError(res, err); }
};
exports.getCallIceServers = (req, res) => {
  res.json({ iceServers: getCallIceServers(req.user._id.toString()) });
};
exports.listPasskeys = async (req, res) => {
  try { res.json(await authService.listPasskeys(req.user._id)); } catch (err) { handleError(res, err); }
};
exports.beginPasskeyStepUp = async (req, res) => {
  try { res.json(await authService.beginPasskeyStepUp(req.user, req.ip)); } catch (err) { handleError(res, err); }
};
exports.verifyPasskeyStepUp = async (req, res) => {
  try { res.json(await authService.verifyPasskeyStepUp(req.user, req.body)); } catch (err) { handleError(res, err); }
};
exports.beginPasskeyRegistration = async (req, res) => {
  try { res.json(await authService.beginPasskeyRegistration(req.user, req.body, req.ip)); } catch (err) { handleError(res, err); }
};
exports.finishPasskeyRegistration = async (req, res) => {
  try { res.status(201).json(await authService.finishPasskeyRegistration(req.user, req.body)); } catch (err) { handleError(res, err); }
};
exports.renamePasskey = async (req, res) => {
  try { res.json(await authService.renamePasskey(req.user, req.params.credentialId, req.body.name)); } catch (err) { handleError(res, err); }
};
exports.removePasskey = async (req, res) => {
  try { res.json(await authService.removePasskey(req.user, req.params.credentialId, req.body)); } catch (err) { handleError(res, err); }
};
exports.createDeviceLinkTransfer = async (req, res) => {
  try { if (await allowDeviceLink(req, res)) res.status(201).json(await deviceLinkService.createTransfer(req.user, req.deviceId, req.body.publicKey)); } catch (err) { handleError(res, err); }
};
exports.approveDeviceLinkTransfer = async (req, res) => {
  try { if (await allowDeviceLink(req, res)) res.json(await deviceLinkService.approveTransfer(req.params.id, req.user, req.deviceId, req.app.get('socketio'))); } catch (err) { handleError(res, err); }
};
exports.approveDeviceLinkByCode = async (req, res) => {
  try { if (await allowDeviceLinkCode(req, res)) res.json(await deviceLinkService.approveTransferByCode(req.body?.code, req.user, req.deviceId, req.app.get('socketio'))); } catch (err) { handleError(res, err); }
};
exports.reserveDeviceLinkArchive = async (req, res) => {
  try { if (await allowDeviceLink(req, res)) res.json(await deviceLinkService.reserveArchiveUpload(req.params.id, req.user, req.deviceId, req.body)); } catch (err) { handleError(res, err); }
};
exports.getDeviceLinkArchivePartUploadUrl = async (req, res) => {
  try {
    if (await allowDeviceLinkPart(req, res)) {
      res.json(await deviceLinkService.getArchivePartUploadUrl(req.params.id, req.user, req.deviceId, {
        ...req.body,
        partNumber: Number(req.params.partNumber),
      }));
    }
  } catch (err) { handleError(res, err); }
};
exports.completeDeviceLinkArchive = async (req, res) => {
  try { if (await allowDeviceLink(req, res)) { await deviceLinkService.completeArchiveUpload(req.params.id, req.user, req.deviceId, req.app.get('socketio')); res.json({ message: 'Đã gửi archive mã hóa' }); } } catch (err) { handleError(res, err); }
};
exports.getDeviceLinkArchive = async (req, res) => {
  try { if (await allowDeviceLink(req, res)) res.json(await deviceLinkService.getArchiveDownload(req.params.id, req.user, req.deviceId)); } catch (err) { handleError(res, err); }
};
exports.acknowledgeDeviceLinkArchive = async (req, res) => {
  try { if (await allowDeviceLink(req, res)) { await deviceLinkService.acknowledgeArchive(req.params.id, req.user, req.deviceId); res.json({ message: 'Đã nhập archive' }); } } catch (err) { handleError(res, err); }
};

exports.beginTotpSetup = async (req, res) => {
  try {
    res.json(await authService.beginTotpSetup(req.user, req.body));
  } catch (err) {
    handleError(res, err);
  }
};

exports.confirmTotpSetup = async (req, res) => {
  try {
    const io = req.app.get('socketio');
    res.json(await authService.confirmTotpSetup(req.user, req.body, req.deviceId, io));
  } catch (err) {
    handleError(res, err);
  }
};

exports.disableTotp = async (req, res) => {
  try {
    const io = req.app.get('socketio');
    res.json(await authService.disableTotp(req.user, req.body, req.deviceId, io));
  } catch (err) {
    handleError(res, err);
  }
};

exports.regenerateTotpRecoveryCodes = async (req, res) => {
  try {
    const io = req.app.get('socketio');
    res.json(await authService.regenerateTotpRecoveryCodes(req.user, req.body, req.deviceId, io));
  } catch (err) {
    handleError(res, err);
  }
};

exports.getLoginHistory = async (req, res) => {
  try {
    res.json(await authService.getLoginHistory(req.user._id));
  } catch (err) {
    handleError(res, err);
  }
};

exports.me = (req, res) => res.json(req.user);

exports.updateProfile = async (req, res) => {
  try {
    res.json(await authService.updateProfile(req.user, req.body));
  } catch (err) {
    handleError(res, err);
  }
};

exports.requestEmailChange = async (req, res) => {
  try {
    const result = await authService.requestEmailChange(req.user, req.body, req.log);
    res.json(result);
  } catch (err) {
    handleWithCustomFallback(res, err, req.log, 'request-email-change error', 'Lỗi hệ thống, vui lòng thử lại sau');
  }
};

exports.verifyEmailChange = async (req, res) => {
  try {
    const result = await authService.verifyEmailChange(req.user, req.body);
    res.json(result);
  } catch (err) {
    handleWithCustomFallback(res, err, req.log, 'verify-email-change error', 'Lỗi xác thực đổi email, vui lòng thử lại');
  }
};

exports.changePassword = async (req, res) => {
  try {
    res.json(await authService.changePassword(req.user, req.body));
  } catch (err) {
    handleError(res, err);
  }
};

exports.updateAvatar = async (req, res) => {
  try {
    res.json(await authService.updateAvatar(req.user, req.file));
  } catch (err) {
    handleError(res, err);
  }
};

exports.updateCover = async (req, res) => {
  try {
    res.json(await authService.updateCover(req.user, req.file));
  } catch (err) {
    handleError(res, err);
  }
};

exports.removeCover = async (req, res) => {
  try {
    res.json(await authService.removeCover(req.user));
  } catch (err) {
    handleError(res, err);
  }
};

exports.forgotPassword = async (req, res) => {
  try {
    const result = await authService.forgotPassword(req.body, req.ip, req.log);
    res.json(result);
  } catch (err) {
    handleWithCustomFallback(res, err, req.log, 'forgot-password error', 'Đã xảy ra lỗi hệ thống, vui lòng thử lại sau');
  }
};

exports.verifyResetOtp = async (req, res) => {
  try {
    const result = await authService.verifyResetOtp(req.body);
    res.json(result);
  } catch (err) {
    handleWithCustomFallback(res, err, req.log, 'verify-reset-otp error', 'Lỗi xác thực OTP, vui lòng thử lại');
  }
};

exports.requestAccountDeletion = async (req, res) => {
  try {
    const result = await accountDeletionService.requestAccountDeletion(req.user, req.body);
    res.json(result);
  } catch (err) {
    handleWithCustomFallback(res, err, req.log, 'request-account-deletion error', 'Lỗi hệ thống, vui lòng thử lại sau');
  }
};

exports.requestAccountRecovery = async (req, res) => {
  try {
    const result = await accountDeletionService.requestAccountRecovery(req.body.email);
    res.json(result);
  } catch (err) {
    handleWithCustomFallback(res, err, req.log, 'request-account-recovery error', 'Lỗi hệ thống, vui lòng thử lại sau');
  }
};

exports.verifyAccountRecovery = async (req, res) => {
  try {
    const result = await accountDeletionService.verifyAccountRecovery(req.body.email, req.body.otp);
    res.json(result);
  } catch (err) {
    handleWithCustomFallback(res, err, req.log, 'verify-account-recovery error', 'Lỗi xác thực OTP, vui lòng thử lại');
  }
};

exports.resetPassword = async (req, res) => {
  try {
    const result = await authService.resetPassword(req.body);
    res.json(result);
  } catch (err) {
    handleWithCustomFallback(res, err, req.log, 'reset-password error', 'Lỗi đặt lại mật khẩu, vui lòng thử lại');
  }
};

exports.registerOrRenewDevice = async (req, res) => {
  try {
    const io = req.app.get('socketio');
    const { token, ...result } = await authService.registerOrRenewDevice(req.user, req.body, io);
    setAuthCookie(res, token);
    res.json(result);
  } catch (err) {
    handleWithCustomFallback(res, err, req.log, 'PUT /api/auth/devices error', 'Lỗi đăng ký thiết bị');
  }
};

exports.revokeDevice = async (req, res) => {
  try {
    const io = req.app.get('socketio');
    const result = await authService.revokeDevice(req.user, req.params.deviceId, req.body.currentPassword, io);
    // Gỡ đúng thiết bị đang gọi request này ➔ cookie hiện tại cũng đã hết tác dụng, dọn luôn.
    if (req.deviceId === req.params.deviceId) clearAuthCookie(res);
    res.json(result);
  } catch (err) {
    handleWithCustomFallback(res, err, req.log, 'DELETE /api/auth/devices error', 'Lỗi gỡ bỏ thiết bị');
  }
};

exports.listDevices = async (req, res) => {
  try {
    const includeRevoked = req.query.includeRevoked === 'true';
    res.json(authService.listDevices(req.user, includeRevoked));
  } catch (err) {
    handleError(res, err);
  }
};

exports.logout = async (req, res) => {
  try {
    const result = await authService.logout(req.user, req.deviceId);
    clearAuthCookie(res);
    res.json(result);
  } catch (err) {
    handleError(res, err);
  }
};
