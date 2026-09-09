const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const User = require('../models/User');

// publicKey lưu dạng chuỗi JSON JWK (RSA-OAEP, xem client/src/crypto/deviceKeys.js#exportPublicKey)
// — thiết bị nào có publicKey không parse được (vd dữ liệu test/fixture cũ, đã hết đường vào từ
// registerOrRenewDevice sau khi thêm validate) sẽ khiến MỌI người gửi tin trong phòng chung với
// chủ thiết bị đó dính console warning "Cannot encrypt key for device..." mỗi lần gửi — thiết bị
// đó vĩnh viễn không giải mã được gì nên xóa đi là đúng, không có cách nào "sửa" lại key giả.
// Mặc định chỉ liệt kê (dry-run). Chạy: node src/scripts/clean-invalid-device-keys.js --fix

function isValidRsaJwk(publicKey) {
  try {
    const jwk = JSON.parse(publicKey);
    return jwk?.kty === 'RSA' && !!jwk.n && !!jwk.e;
  } catch {
    return false;
  }
}

const run = async () => {
  const shouldFix = process.argv.includes('--fix');

  try {
    const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017/chatapp';
    console.log('🔄 Đang kết nối MongoDB:', mongoUri);
    await mongoose.connect(mongoUri);

    const users = await User.find({ 'devices.0': { $exists: true } }).select('username devices');
    let totalBad = 0;

    for (const user of users) {
      const badDevices = user.devices.filter(d => !isValidRsaJwk(d.publicKey));
      if (badDevices.length === 0) continue;

      totalBad += badDevices.length;
      console.log(`\nUser: ${user.username} (${user._id})`);
      badDevices.forEach(d => console.log(`  - deviceId=${d.deviceId} deviceName="${d.deviceName}" publicKey=${JSON.stringify(d.publicKey).slice(0, 60)}`));

      if (shouldFix) {
        user.devices = user.devices.filter(d => isValidRsaJwk(d.publicKey));
        await user.save();
        console.log(`  Đã xóa ${badDevices.length} thiết bị hỏng.`);
      }
    }

    if (totalBad === 0) {
      console.log('Không tìm thấy thiết bị nào có publicKey hỏng.');
    } else if (!shouldFix) {
      console.log(`\nTổng cộng ${totalBad} thiết bị hỏng. Chạy lại kèm --fix để xóa: node src/scripts/clean-invalid-device-keys.js --fix`);
    }
  } catch (err) {
    console.error('Lỗi:', err);
  } finally {
    await mongoose.disconnect();
    console.log('👋 Đã ngắt kết nối MongoDB.');
    process.exit(0);
  }
};

run();
