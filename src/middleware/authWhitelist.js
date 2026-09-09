// Giới hạn IP cho tài khoản role admin — không set ADMIN_IP_WHITELIST thì không giới hạn (dev convenience).
const ADMIN_IP_WHITELIST = (process.env.ADMIN_IP_WHITELIST || '')
  .split(',')
  .map(ip => ip.trim())
  .filter(Boolean);

const isAdminIpAllowed = (ip) => ADMIN_IP_WHITELIST.length === 0 || ADMIN_IP_WHITELIST.includes(ip);

// Whitelist route cho Bootstrap Token — exact-match, không dùng includes() (khớp nhầm substring).
const BOOTSTRAP_WHITELIST_EXACT_PATHS = [
  '/api/auth/me',
  '/api/auth/profile',
  '/api/auth/devices',
  '/api/auth/set-nickname',
];

// DELETE /api/auth/devices/:deviceId — whitelist riêng để gỡ thiết bị cũ khi đã đạt giới hạn 5 thiết bị; khớp đúng định dạng "dev_"+32 hex, không match path con bất kỳ.
const DEVICE_ID_SUBPATH_RE = /^\/api\/auth\/devices\/dev_[0-9a-f]{32}$/;

const isBootstrapWhitelisted = (fullPath) =>
  BOOTSTRAP_WHITELIST_EXACT_PATHS.includes(fullPath) || DEVICE_ID_SUBPATH_RE.test(fullPath);

module.exports = { isAdminIpAllowed, isBootstrapWhitelisted };
