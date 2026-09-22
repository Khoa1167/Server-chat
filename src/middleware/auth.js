const User = require('../models/User');
const { verifyJwt } = require('../utils/auth/jwtKeys');
const { hashDeviceToken } = require('../utils/auth/deviceToken');
const { isAdminIpAllowed, isBootstrapWhitelisted } = require('./authWhitelist');

const protect = async (req, res, next) => {
  try {
    const token = req.cookies?.token;
    if (!token) return res.status(401).json({ message: 'Chưa đăng nhập' });

    // 1. Thử Device Token trước (opaque, so hash trực tiếp trong DB). isRevoked check là defense-in-depth.
    const tokenHash = hashDeviceToken(token);
    const deviceOwner = await User.findOne({
      devices: { $elemMatch: { tokenHash, isRevoked: false } },
    }).select('-password');
    if (deviceOwner) {
      if (deviceOwner.isBanned) return res.status(403).json({ message: 'Tài khoản đã bị khóa bởi quản trị viên' });
      if (deviceOwner.isDeleted) return res.status(403).json({ message: 'Tài khoản đã bị xóa' });
      if (deviceOwner.pendingDeletionAt) return res.status(403).json({ message: 'Tài khoản đang chờ xóa', code: 'PENDING_DELETION' });
      req.user = deviceOwner;
      req.deviceId = deviceOwner.devices.find(d => d.tokenHash === tokenHash && !d.isRevoked).deviceId;
      return next();
    }

    // 2. Không khớp thiết bị nào ➔ thử Bootstrap Token (JWT ngắn hạn 15m, chưa đăng ký thiết bị)
    const decoded = verifyJwt(token);
    if (decoded.deviceId) {
      // JWT thiết bị từ trước khi chuyển sang opaque token — không còn hợp lệ
      return res.status(401).json({
        message: 'Phiên làm việc trên thiết bị này đã bị gỡ bỏ hoặc không còn hợp lệ',
        code: 'DEVICE_SESSION_INVALID'
      });
    }

    req.user = await User.findById(decoded.id).select('-password');
    if (!req.user) return res.status(401).json({ message: 'User không tồn tại' });
    if (req.user.isBanned) return res.status(403).json({ message: 'Tài khoản đã bị khóa bởi quản trị viên' });
    if (req.user.isDeleted) return res.status(403).json({ message: 'Tài khoản đã bị xóa' });
    if (req.user.pendingDeletionAt) return res.status(403).json({ message: 'Tài khoản đang chờ xóa', code: 'PENDING_DELETION' });

    // So sánh ở độ chính xác giây (giống JWT `iat`) để tránh lệch do phần mili-giây bị cắt.
    if (decoded.iat && req.user.passwordChangedAt) {
      const passwordChangedAtSeconds = Math.floor(new Date(req.user.passwordChangedAt).getTime() / 1000);
      if (decoded.iat < passwordChangedAtSeconds) {
        return res.status(401).json({ message: 'Token đã hết hạn do thay đổi mật khẩu' });
      }
    }

    const baseUrl = req.baseUrl || '';
    const path = req.path || '';
    const fullPath = (baseUrl + path).toLowerCase();
    if (!isBootstrapWhitelisted(fullPath)) {
      return res.status(403).json({
        message: 'Yêu cầu đăng ký thiết bị trước khi truy cập dữ liệu',
        code: 'REQUIRE_DEVICE_REGISTRATION'
      });
    }
    req.isBootstrapToken = true;
    next();
  } catch (err) {
    res.status(401).json({ message: 'Token không hợp lệ hoặc đã hết hạn' });
  }
};

// Dùng sau protect — chặn các route quản trị toàn hệ thống (duyệt report...) khỏi user thường.
// Khác "chủ phòng/quản trị viên nhóm" (Room.createdBy/admins) — đây là role toàn app trên User.
const requireAdmin = (req, res, next) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ message: 'Chỉ quản trị viên hệ thống mới có quyền truy cập' });
  }
  if (!isAdminIpAllowed(req.ip)) {
    return res.status(403).json({ message: 'Địa chỉ IP này không được phép truy cập trang quản trị' });
  }
  next();
};

const requireDeviceSession = (req, res, next) => {
  if (req.isBootstrapToken || !req.deviceId) {
    return res.status(403).json({ message: 'Thao tác này yêu cầu một thiết bị đã đăng nhập đầy đủ' });
  }
  next();
};

module.exports = { protect, requireAdmin, requireDeviceSession, isAdminIpAllowed };
