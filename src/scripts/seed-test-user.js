// Tạo user cố định cho test tự động (security.test.js gọi thẳng API, không qua flow OTP). Chỉ
// chạy trên DB test/CI — idempotent, bỏ qua nếu đã có.
const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const User = require('../models/User');

const TEST_USERNAME = 'user2';
const TEST_PASSWORD = '123456';
const TEST_EMAIL = 'user2-test@example.com';
const TEST_NICKNAME = 'user2_test';

const seedTestUser = async () => {
  try {
    const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017/chatapp';
    console.log('🔄 Đang kết nối MongoDB:', mongoUri);
    await mongoose.connect(mongoUri);

    const existing = await User.findOne({ username: TEST_USERNAME });
    if (existing) {
      console.log(`ℹ️  User test "${TEST_USERNAME}" đã tồn tại, bỏ qua.`);
    } else {
      const user = new User({
        username: TEST_USERNAME,
        email: TEST_EMAIL,
        nickname: TEST_NICKNAME,
        password: TEST_PASSWORD, // tự hash qua pre('save') của User model
      });
      await user.save();
      console.log(`Đã tạo user test: ${TEST_USERNAME} / ${TEST_PASSWORD}`);
    }
  } catch (err) {
    console.error('Lỗi khi seed user test:', err);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
    process.exit();
  }
};

seedTestUser();
