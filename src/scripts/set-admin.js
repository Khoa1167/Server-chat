const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const User = require('../models/User');
const { decryptPII, hashBlindIndexAllKeys } = require('../utils/crypto');

const setAdmin = async () => {
  const identifier = process.argv[2];

  if (!identifier) {
    console.error('Cần truyền email hoặc username. Ví dụ: node src/scripts/set-admin.js user@example.com');
    process.exit(1);
  }

  try {
    const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017/chatapp';
    console.log('🔄 Đang kết nối MongoDB:', mongoUri);
    await mongoose.connect(mongoUri);

    const user = await User.findOne({
      $or: [{ emailHash: { $in: hashBlindIndexAllKeys(identifier.toLowerCase()) } }, { username: identifier }],
    });

    if (!user) {
      console.error(`Không tìm thấy user với email/username: ${identifier}`);
      process.exit(1);
    }

    user.role = 'admin';
    await user.save();
    console.log(`Đã cấp quyền admin hệ thống cho: ${user.username} (${decryptPII(user.email)})`);
  } catch (err) {
    console.error('Lỗi khi cấp quyền admin:', err);
  } finally {
    await mongoose.disconnect();
    console.log('👋 Đã ngắt kết nối MongoDB.');
    process.exit(0);
  }
};

setAdmin();
