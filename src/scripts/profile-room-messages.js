// Script chẩn đoán tạm thời — đo thời gian thật getRoomMessages() (tách chi phí populate vs query
// chính) trên phòng nhiều tin nhất, để quyết định có đáng đổi sang aggregation không. Chỉ đọc DB.
const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const Message = require('../models/Message');
const Room = require('../models/Room');
const userFields = require('../utils/publicUserFields');

const ITERATIONS = 20;

async function time(label, fn) {
  const samples = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const start = process.hrtime.bigint();
    await fn();
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    samples.push(ms);
  }
  samples.sort((a, b) => a - b);
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  const p50 = samples[Math.floor(samples.length / 2)];
  const p95 = samples[Math.floor(samples.length * 0.95)];
  console.log(`${label}: avg=${avg.toFixed(2)}ms  p50=${p50.toFixed(2)}ms  p95=${p95.toFixed(2)}ms  (n=${ITERATIONS})`);
}

async function main() {
  const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017/chatapp';
  console.log('🔄 Đang kết nối MongoDB:', mongoUri);
  await mongoose.connect(mongoUri);

  const [top] = await Message.aggregate([
    { $group: { _id: '$room', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 1 },
  ]);

  if (!top) {
    console.error('Không có tin nhắn nào trong DB để đo.');
    process.exit(1);
  }

  const roomId = top._id;
  console.log(`📊 Phòng nhiều tin nhắn nhất: ${roomId} (${top.count} tin)`);

  const query = {
    room: roomId,
    isDeleted: false,
    $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
  };

  // Warmup — bỏ qua lần đầu để không lệch trung bình.
  await Message.find(query).sort({ createdAt: -1 }).limit(30).lean();

  await time('1. Chỉ Message.find() (không populate)', () =>
    Message.find(query).sort({ createdAt: -1 }).limit(30).lean()
  );

  await time('2. + populate sender', () =>
    Message.find(query).sort({ createdAt: -1 }).limit(30)
      .populate('sender', userFields.BASIC)
      .lean()
  );

  await time('3. + toàn bộ populate chain (như getRoomMessages hiện tại)', () =>
    Message.find(query).sort({ createdAt: -1 }).limit(30)
      .populate('sender', userFields.BASIC)
      .populate({ path: 'replyTo', select: 'sender content type fileName isDeleted iv tag', populate: { path: 'sender', select: userFields.BASIC } })
      .populate({ path: 'forwardedFrom', select: 'sender content iv tag', populate: { path: 'sender', select: userFields.MINIMAL } })
      .populate('reactions.users', userFields.MINIMAL)
      .lean()
  );

  await time('4. requireMembership check (Room.findById) — chi phí đứng trước populate chain', () =>
    Room.findById(roomId)
  );

  await mongoose.disconnect();
  console.log('👋 Đã ngắt kết nối MongoDB.');
  process.exit(0);
}

main().catch(err => {
  console.error('Lỗi:', err);
  process.exit(1);
});
