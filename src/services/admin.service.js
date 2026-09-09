const mongoose = require('mongoose');
const User = require('../models/User');
const AppError = require('../utils/AppError');

const PAGE_SIZE = 20;

async function listUsers({ q, page }) {
  const filter = {};
  if (q && q.trim()) {
    const trimmed = q.trim();
    // Dán nguyên link chia sẻ trang cá nhân (?add-friend=<userId>, xem ShareProfileModal.jsx) hoặc
    // userId trần đều tìm được — trích đúng 24 ký tự hex ObjectId để khớp chính xác 1 user.
    const idMatch = trimmed.match(/[0-9a-fA-F]{24}/);
    if (idMatch && mongoose.Types.ObjectId.isValid(idMatch[0])) {
      filter._id = idMatch[0];
    } else {
      // Không tìm theo username/email — cả 2 không phải thứ admin cần tra (username không đổi
      // được, email giờ mã hóa AES-GCM ở DB nên ciphertext cũng không regex được nữa).
      const escapedQuery = trimmed.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
      filter.nickname = { $regex: escapedQuery, $options: 'i' };
    }
  }

  const [users, total] = await Promise.all([
    User.find(filter)
      .select('username nickname email avatar role isOnline isBanned createdAt')
      .sort({ createdAt: -1 })
      .skip((page - 1) * PAGE_SIZE)
      .limit(PAGE_SIZE),
    User.countDocuments(filter),
  ]);

  return { users, total, page, pageSize: PAGE_SIZE };
}

async function banUser(targetId, actingUserId) {
  if (targetId === actingUserId) {
    throw new AppError('Không thể tự khóa tài khoản của chính mình', 400);
  }

  const target = await User.findById(targetId);
  if (!target) throw new AppError('Không tìm thấy người dùng', 404);
  if (target.role === 'admin') {
    throw new AppError('Không thể khóa tài khoản quản trị viên khác', 400);
  }

  target.isBanned = true;
  await target.save();
  return target;
}

async function unbanUser(targetId) {
  const target = await User.findById(targetId);
  if (!target) throw new AppError('Không tìm thấy người dùng', 404);

  target.isBanned = false;
  await target.save();
  return target;
}

module.exports = { listUsers, banUser, unbanUser };
