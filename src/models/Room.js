const mongoose = require('mongoose');
const crypto   = require('crypto');
const { CHAT_BACKGROUND_KEYS } = require('../utils/chatBackgrounds');
const roomsListCache = require('../utils/roomsListCache');

const roomSchema = new mongoose.Schema({
  name:        { type: String, trim: true },
  avatar:      { type: String, default: '' }, // Icon nhóm — chỉ áp dụng phòng nhóm, DM dùng avatar của đối phương
  // Nền khung chat — lưu key thay vì CSS thô; danh sách CSS thật ở client/src/utils/chatBackgrounds.js.
  chatBackground: { type: String, enum: CHAT_BACKGROUND_KEYS, default: 'default' },
  chatBackgroundImage: { type: String, default: '' },
  chatMessageColor: { type: String, default: 'default' },
  description: { type: String, default: '' },
  isPrivate:   { type: Boolean, default: false },
  isDM:        { type: Boolean, default: false },
  inviteCode:  {
    type: String,
    default: () => crypto.randomBytes(6).toString('hex'), // mã 12 ký tự ngẫu nhiên
  },
  // Link/QR mời hết hạn sau 7 ngày — reset lại khi chủ phòng bấm "Tạo lại link" (PUT /:id/rotate-invite)
  inviteCodeExpiresAt: {
    type: Date,
    default: () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  },
  members:     [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  admins:      [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  // Ngày từng thành viên gia nhập (key = userId) — không backfill cho thành viên cũ. getRoomMessages()
  // dùng field này để thành viên mới chỉ thấy tin nhắn từ lúc join trở đi.
  memberJoinedAt: { type: Map, of: Date, default: () => new Map() },
  // Mốc mỗi thành viên mở phòng lần gần nhất — nguồn tính unread + "Đã xem" (read receipt DM).
  lastReadAt: { type: Map, of: Date, default: () => new Map() },
  // Chỉ áp dụng luồng tìm-và-vào phòng công khai (/join). Tham gia qua link/QR mời LUÔN vào hàng chờ duyệt bất kể giá trị này.
  joinPolicy:  { type: String, enum: ['open', 'approval'], default: 'open' },
  // Mọi lượt xin vào (browse-list phòng công khai hoặc link/QR mời) đều vào hàng chờ này,
  // chủ phòng/admin duyệt mới thành thành viên — không có đường tắt tự vào.
  pendingRequests: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  // Lời mời đích danh do admin/chủ phòng gửi qua "Thêm thành viên" — người được mời tự
  // accept/decline, khác pendingRequests (người ngoài tự xin vào, admin duyệt).
  pendingInvites:  [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  createdBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  lastMessage: { type: mongoose.Schema.Types.ObjectId, ref: 'Message' },
  // Quyền lẻ host cấp riêng cho 1 thành viên thường (vd ghim tin nhắn/tạo khảo sát) mà không cần phong admin —
  // key = userId (string), value = danh sách permission key. Whitelist ở rooms.service.js.
  grantedPermissions: { type: Map, of: [String], default: () => new Map() },
  // Chỉ giữ ID để server không thấy nội dung tin nhắn E2EE; client tự tải và giải mã tin đã ghim.
  pinnedMessage: { type: mongoose.Schema.Types.ObjectId, ref: 'Message', default: null },
  // Epoch hiện tại của Sender Key mã hóa nhóm — tăng lên khi rotate khóa (server/src/routes/rooms.js PUT /:id/rotate-key)
  senderKeyEpoch: { type: Number, default: 0 },
}, { timestamps: true });

// Room.find({members: userId}) chạy ở MỖI lần connect socket (join lại toàn bộ phòng) + mọi route
// kiểm tra quyền thành viên — không có index này là quét toàn bộ collection Room mỗi lần.
roomSchema.index({ members: 1 });

// GET /api/rooms/all lọc theo isPrivate:false — collection nhỏ hơn Message nhiều nên ưu tiên thấp
// hơn, nhưng vẫn nên có khi danh sách phòng công khai lớn dần.
roomSchema.index({ isPrivate: 1 });

// Partial unique index thay vì unique:true thẳng — phòng cũ có inviteCode:null sẽ lỗi E11000 nếu không loại trừ.
roomSchema.index(
  { inviteCode: 1 },
  { unique: true, partialFilterExpression: { inviteCode: { $type: 'string' } } }
);

// Invalidate roomsListCache cho mọi thành viên khi Room đổi — tập trung ở tầng model thay vì rải rác từng hàm service.
function invalidateMembersCache(doc) {
  // doc = null khi findOneAndUpdate/findOneAndDelete không khớp document nào (vd ID không tồn tại).
  if (!doc || !Array.isArray(doc.members)) return;
  doc.members.forEach(id => { if (id) roomsListCache.invalidate(id).catch(() => {}); });
}
roomSchema.post('save', invalidateMembersCache);
roomSchema.post('findOneAndUpdate', invalidateMembersCache); // bắt luôn alias findByIdAndUpdate
roomSchema.post('findOneAndDelete', invalidateMembersCache); // bắt luôn alias findByIdAndDelete

module.exports = mongoose.model('Room', roomSchema);
