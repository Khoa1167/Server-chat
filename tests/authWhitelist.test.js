const test = require('node:test');
const assert = require('node:assert/strict');

// authWhitelist.js đọc ADMIN_IP_WHITELIST từ process.env lúc module load, nên mỗi test cần
// set env RỒI xoá cache require để load lại module với giá trị whitelist mong muốn.
const loadModule = (adminIpWhitelist) => {
  const modulePath = require.resolve('../src/middleware/authWhitelist');
  delete require.cache[modulePath];
  if (adminIpWhitelist === undefined) {
    delete process.env.ADMIN_IP_WHITELIST;
  } else {
    process.env.ADMIN_IP_WHITELIST = adminIpWhitelist;
  }
  return require(modulePath);
};

test('isAdminIpAllowed - không set ADMIN_IP_WHITELIST thì cho phép mọi IP', () => {
  const { isAdminIpAllowed } = loadModule(undefined);
  assert.equal(isAdminIpAllowed('1.2.3.4'), true);
  assert.equal(isAdminIpAllowed(''), true);
});

test('isAdminIpAllowed - có whitelist thì chỉ cho phép IP nằm trong danh sách', () => {
  const { isAdminIpAllowed } = loadModule('1.1.1.1, 2.2.2.2');
  assert.equal(isAdminIpAllowed('1.1.1.1'), true);
  assert.equal(isAdminIpAllowed('2.2.2.2'), true);
  assert.equal(isAdminIpAllowed('3.3.3.3'), false);
});

test('isBootstrapWhitelisted - khớp đúng các path exact-match', () => {
  const { isBootstrapWhitelisted } = loadModule(undefined);
  assert.equal(isBootstrapWhitelisted('/api/auth/me'), true);
  assert.equal(isBootstrapWhitelisted('/api/auth/profile'), true);
  assert.equal(isBootstrapWhitelisted('/api/auth/devices'), true);
  assert.equal(isBootstrapWhitelisted('/api/auth/set-nickname'), true);
});

test('isBootstrapWhitelisted - KHÔNG khớp path chỉ chung tiền tố (substring)', () => {
  const { isBootstrapWhitelisted } = loadModule(undefined);
  assert.equal(isBootstrapWhitelisted('/api/auth/devices/export-all'), false);
  assert.equal(isBootstrapWhitelisted('/api/auth/set-nickname-and-x'), false);
  assert.equal(isBootstrapWhitelisted('/api/auth/me/extra'), false);
});

test('isBootstrapWhitelisted - khớp DELETE /devices/:deviceId đúng định dạng dev_<32 hex>', () => {
  const { isBootstrapWhitelisted } = loadModule(undefined);
  const validDeviceId = 'dev_' + '0'.repeat(32);
  assert.equal(isBootstrapWhitelisted(`/api/auth/devices/${validDeviceId}`), true);
});

test('isBootstrapWhitelisted - từ chối deviceId sai định dạng', () => {
  const { isBootstrapWhitelisted } = loadModule(undefined);
  assert.equal(isBootstrapWhitelisted('/api/auth/devices/dev_short'), false);
  assert.equal(isBootstrapWhitelisted('/api/auth/devices/dev_' + 'g'.repeat(32)), false);
  assert.equal(isBootstrapWhitelisted('/api/auth/devices/dev_' + '0'.repeat(32) + '/extra'), false);
});

test('isBootstrapWhitelisted - path không liên quan trả false', () => {
  const { isBootstrapWhitelisted } = loadModule(undefined);
  assert.equal(isBootstrapWhitelisted('/api/rooms'), false);
});
