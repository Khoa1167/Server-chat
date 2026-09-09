const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const User = require('../models/User');
const { encryptPII, decryptPII, hashBlindIndex } = require('../utils/crypto');

const migratePII = async () => {
  try {
    const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017/chatapp';
    console.log('🔄 Đang kết nối MongoDB:', mongoUri);
    await mongoose.connect(mongoUri);

    const users = await User.find({});
    console.log(`🔍 Tìm thấy ${users.length} người dùng cần kiểm tra mã hóa PII...`);

    let updatedCount = 0;

    for (const user of users) {
      let isModified = false;

      if (user.email && !user.email.includes(':')) {
        const rawEmail = user.email.trim().toLowerCase();
        user.emailHash = hashBlindIndex(rawEmail);
        user.email = encryptPII(rawEmail);
        isModified = true;
      } else if (user.email && user.email.includes(':') && !user.emailHash) {
        const rawEmail = decryptPII(user.email);
        if (rawEmail) {
          user.emailHash = hashBlindIndex(rawEmail);
          isModified = true;
        }
      }

      if (user.phone && !user.phone.includes(':')) {
        const rawPhone = user.phone.trim();
        user.phoneHash = hashBlindIndex(rawPhone);
        user.phone = encryptPII(rawPhone);
        isModified = true;
      } else if (user.phone && user.phone.includes(':') && !user.phoneHash) {
        const rawPhone = decryptPII(user.phone);
        if (rawPhone) {
          user.phoneHash = hashBlindIndex(rawPhone);
          isModified = true;
        }
      }

      if (user.dateOfBirth && !String(user.dateOfBirth).includes(':')) {
        const rawDob = String(user.dateOfBirth).trim();
        user.dateOfBirth = encryptPII(rawDob);
        isModified = true;
      }

      if (isModified) {
        await user.save();
        updatedCount++;
        console.log(`Đã mã hóa PII cho user: ${user.username} (${user._id})`);
      }
    }

    console.log(`🎉 Migration hoàn tất! Đã cập nhật mã hóa PII cho ${updatedCount}/${users.length} người dùng.`);
  } catch (err) {
    console.error('Lỗi trong quá trình migration PII:', err);
  } finally {
    await mongoose.disconnect();
    console.log('👋 Đã ngắt kết nối MongoDB.');
    process.exit(0);
  }
};

migratePII();
