// Job re-encrypt khi xoay vòng ENCRYPTION_KEY (khác migrate-pii-encryption.js — script đó chỉ
// chạy 1 lần để mã hóa PII plaintext ban đầu). Chạy sau khi đã thêm key mới vào ENCRYPTION_KEYS +
// đổi ENCRYPTION_KEY_CURRENT_KID; xác nhận log hết dữ liệu chưa chuyển rồi mới xóa key cũ.
const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const User = require('../models/User');
const Report = require('../models/Report');
const { encryptPII, decryptPII, encryptReportContent, decryptReportContent, hashBlindIndex } = require('../utils/crypto');

// Trích kid từ ciphertext "kid:iv:tag:cipher" — định dạng cũ không có kid coi như luôn cần re-encrypt.
const currentKidOf = (encrypted) => {
  if (!encrypted || typeof encrypted !== 'string' || !encrypted.includes(':')) return null;
  const parts = encrypted.split(':');
  return parts.length === 4 ? parts[0] : 'LEGACY_NO_KID';
};

const rotateUsers = async (currentKid) => {
  const users = await User.find({});
  console.log(`🔍 Tìm thấy ${users.length} user cần kiểm tra.`);
  let migrated = 0;

  for (const user of users) {
    let isModified = false;

    for (const field of ['email', 'phone', 'dateOfBirth']) {
      const raw = user[field];
      if (!raw) continue;
      if (currentKidOf(raw) === currentKid) continue; // đã ở key hiện tại, bỏ qua
      const plain = decryptPII(raw);
      user[field] = encryptPII(plain);
      isModified = true;
    }

    // Tính lại emailHash/phoneHash theo key hiện tại một khi đã re-encrypt.
    if (isModified) {
      const rawEmail = decryptPII(user.email);
      if (rawEmail) user.emailHash = hashBlindIndex(rawEmail);
      const rawPhone = user.phone ? decryptPII(user.phone) : '';
      if (rawPhone) user.phoneHash = hashBlindIndex(rawPhone);

      await user.save();
      migrated++;
      console.log(`Re-encrypt user: ${user.username} (${user._id})`);
    }
  }

  return migrated;
};

const rotateReports = async (currentKid) => {
  const reports = await Report.find({ decryptedContent: { $ne: '' } });
  console.log(`🔍 Tìm thấy ${reports.length} report có decryptedContent cần kiểm tra.`);
  let migrated = 0;

  for (const report of reports) {
    if (currentKidOf(report.decryptedContent) === currentKid) continue;
    const plain = decryptReportContent(report.decryptedContent);
    report.decryptedContent = encryptReportContent(plain);
    await report.save();
    migrated++;
    console.log(`Re-encrypt report: ${report._id}`);
  }

  return migrated;
};

const rotate = async () => {
  const currentKid = process.env.ENCRYPTION_KEY_CURRENT_KID || 'k1';
  try {
    const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017/chatapp';
    console.log('🔄 Đang kết nối MongoDB:', mongoUri);
    console.log('🔑 Key hiện tại (kid):', currentKid);
    await mongoose.connect(mongoUri);

    const usersMigrated = await rotateUsers(currentKid);
    const reportsMigrated = await rotateReports(currentKid);

    console.log(`🎉 Hoàn tất! Đã re-encrypt ${usersMigrated} user, ${reportsMigrated} report sang key "${currentKid}".`);
    console.log('   Xác nhận không còn lỗi ở trên rồi mới xóa key cũ khỏi ENCRYPTION_KEYS trong .env.');
  } catch (err) {
    console.error('Lỗi trong quá trình rotate:', err);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
    console.log('👋 Đã ngắt kết nối MongoDB.');
    process.exit();
  }
};

rotate();
