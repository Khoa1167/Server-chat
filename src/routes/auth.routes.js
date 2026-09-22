const router = require('express').Router();
const { protect, requireDeviceSession } = require('../middleware/auth');
const { uploadAvatar, uploadCover } = require('../config/cloudinary');
const authController = require('../controllers/auth.controller');

// ─── Đăng ký (OTP) ───────────────────────────────────────────────────────────
router.post('/send-otp', authController.sendRegisterOtp);
router.post('/verify-otp', authController.verifyRegisterOtp);
router.post('/check-username', authController.checkUsernameAvailable);
router.post('/set-nickname', protect, authController.setNickname);

// ─── Đăng nhập ───────────────────────────────────────────────────────────────
router.post('/login', authController.login);
router.post('/totp/login', authController.verifyTotpLogin);
router.post('/passkey/login/options', authController.getPasskeyLoginOptions);
router.post('/passkey/login/verify', authController.verifyPasskeyLogin);
router.get('/login-history', protect, authController.getLoginHistory);
router.get('/me', protect, authController.me);
router.get('/call-ice-servers', protect, requireDeviceSession, authController.getCallIceServers);

// ─── Authenticator App (TOTP) — chỉ phiên thiết bị đầy đủ được quản lý ───────
router.post('/totp/setup', protect, requireDeviceSession, authController.beginTotpSetup);
router.post('/totp/confirm', protect, requireDeviceSession, authController.confirmTotpSetup);
router.post('/totp/recovery-codes', protect, requireDeviceSession, authController.regenerateTotpRecoveryCodes);
router.delete('/totp', protect, requireDeviceSession, authController.disableTotp);
router.get('/mfa-status', protect, requireDeviceSession, authController.getMfaStatus);
router.get('/passkeys', protect, requireDeviceSession, authController.listPasskeys);
router.post('/passkey/step-up/options', protect, requireDeviceSession, authController.beginPasskeyStepUp);
router.post('/passkey/step-up/verify', protect, requireDeviceSession, authController.verifyPasskeyStepUp);
router.post('/passkey/register/options', protect, requireDeviceSession, authController.beginPasskeyRegistration);
router.post('/passkey/register/verify', protect, requireDeviceSession, authController.finishPasskeyRegistration);
router.patch('/passkeys/:credentialId', protect, requireDeviceSession, authController.renamePasskey);
router.delete('/passkeys/:credentialId', protect, requireDeviceSession, authController.removePasskey);
router.post('/device-link', protect, requireDeviceSession, authController.createDeviceLinkTransfer);
router.post('/device-link/code', protect, requireDeviceSession, authController.approveDeviceLinkByCode);
router.post('/device-link/:id/approve', protect, requireDeviceSession, authController.approveDeviceLinkTransfer);
router.post('/device-link/:id/archive', protect, requireDeviceSession, authController.reserveDeviceLinkArchive);
router.post('/device-link/:id/archive/parts/:partNumber', protect, requireDeviceSession, authController.getDeviceLinkArchivePartUploadUrl);
router.post('/device-link/:id/archive/complete', protect, requireDeviceSession, authController.completeDeviceLinkArchive);
router.get('/device-link/:id/archive', protect, requireDeviceSession, authController.getDeviceLinkArchive);
router.delete('/device-link/:id/archive', protect, requireDeviceSession, authController.acknowledgeDeviceLinkArchive);

// ─── Hồ sơ cá nhân ───────────────────────────────────────────────────────────
router.put('/profile', protect, authController.updateProfile);
router.post('/request-email-change', protect, authController.requestEmailChange);
router.post('/verify-email-change', protect, authController.verifyEmailChange);
router.put('/change-password', protect, authController.changePassword);
router.post('/avatar', protect, uploadAvatar.single('avatar'), authController.updateAvatar);
router.post('/cover', protect, uploadCover.single('cover'), authController.updateCover);
router.delete('/cover', protect, authController.removeCover);

// ─── Quên mật khẩu / đặt lại mật khẩu ───────────────────────────────────────
router.post('/forgot-password', authController.forgotPassword);
router.post('/verify-reset-otp', authController.verifyResetOtp);
router.post('/reset-password', authController.resetPassword);

// ─── Xóa tài khoản / khôi phục trong 14 ngày ────────────────────────────────
router.post('/request-account-deletion', protect, authController.requestAccountDeletion);
router.post('/request-account-recovery', authController.requestAccountRecovery);
router.post('/verify-account-recovery', authController.verifyAccountRecovery);

// ─── Thiết bị (device management) ───────────────────────────────────────────
router.put('/devices', protect, authController.registerOrRenewDevice);
router.delete('/devices/:deviceId', protect, authController.revokeDevice);
router.get('/devices', protect, authController.listDevices);

// ─── POST /api/auth/logout — Thu hồi token hiện tại ──────────────────────────
router.post('/logout', protect, authController.logout);

module.exports = router;
