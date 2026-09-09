// Gỡ index unique cũ trên User.nickname sau khi bỏ ràng buộc trong schema — sửa schema không tự
// xóa index vật lý trong MongoDB, không chạy script này thì vẫn bị chặn lỗi 11000.
const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const User = require('../models/User');

const dropNicknameUniqueIndex = async () => {
  try {
    const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017/chatapp';
    console.log('🔄 Đang kết nối MongoDB:', mongoUri);
    await mongoose.connect(mongoUri);

    const before = await User.collection.indexes();
    console.log('📋 Index hiện có trên collection users:', before.map(i => i.name));

    // syncIndexes() đối chiếu index vật lý với schema — tự xóa/tạo lại cho khớp.
    const dropped = await User.syncIndexes();
    console.log('🗑️  Index đã bị xóa (không còn khớp schema):', dropped.length ? dropped : '(không có)');

    const after = await User.collection.indexes();
    console.log('📋 Index sau khi đồng bộ:', after.map(i => i.name));
    console.log('Hoàn tất — nickname không còn bị chặn trùng ở tầng DB.');
  } catch (err) {
    console.error('Lỗi khi đồng bộ index:', err);
  } finally {
    await mongoose.disconnect();
    console.log('👋 Đã ngắt kết nối MongoDB.');
    process.exit(0);
  }
};

dropNicknameUniqueIndex();
