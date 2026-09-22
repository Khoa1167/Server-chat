const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { encryptPII, decryptPII, hashBlindIndex } = require('../utils/crypto');

const userSchema = new mongoose.Schema({
  username:          { type: String, required: true, unique: true, trim: true },
  nickname:          { type: String, required: true, trim: true }, // Tên hiển thị — không unique, phân biệt người trùng tên qua QR/link kết bạn (userId)
  // null = chưa từng đổi thủ công (lần đổi đầu tiên luôn tự do) — chỉ set khi user chủ động đổi
  // qua updateProfile(), KHÔNG set lúc tạo tài khoản.
  nicknameChangedAt: { type: Date, default: null },
  email:             { type: String, required: true, lowercase: true, trim: true }, // Chuỗi mã hóa AES-256-GCM
  // unique thật nằm ở emailHash, không phải email — ciphertext AES-GCM khác nhau mỗi lần mã hóa dù cùng email thật.
  emailHash:         { type: String, unique: true, sparse: true },
  phone:             { type: String, default: '' },             // Chuỗi mã hóa AES-256-GCM
  phoneHash:         { type: String, default: '', index: true }, // HMAC-SHA256 để truy vấn tìm kiếm
  dateOfBirth:       { type: String, default: '' },             // Chuỗi mã hóa AES-256-GCM
  // null = chưa từng đổi thủ công (lần đổi đầu tiên luôn tự do) — chỉ set khi user chủ động đổi
  // dateOfBirth qua updateProfile().
  dateOfBirthChangedAt: { type: Date, default: null },
  gender:            { type: String, enum: ['male', 'female', 'other', ''], default: '' },
  // null = chưa từng đổi thủ công (lần đổi đầu tiên luôn tự do) — cooldown 7 ngày giữa các lần
  // đổi gender sau đó.
  genderChangedAt:   { type: Date, default: null },
  bio:               { type: String, default: '', maxlength: 150 },
  password:          { type: String, required: true, minlength: 6 },
  passwordChangedAt: { type: Date, default: Date.now }, // Dùng để vô hiệu hóa JWT cũ khi đổi mật khẩu — KHÔNG dùng cho cooldown (bị set ngay lúc tạo tài khoản)
  // Cooldown 14 ngày — tách riêng khỏi passwordChangedAt vì field đó set ngay lúc đăng ký.
  passwordChangeRequestedAt: { type: Date, default: null },
  totpEnabled:          { type: Boolean, default: false },
  totpSecret:           { type: String, default: '', select: false },
  totpPendingSecret:    { type: String, default: '', select: false },
  totpPendingExpiresAt: { type: Date, default: null, select: false },
  totpLastUsedStep:     { type: Number, default: -1, select: false },
  totpRecoveryCodes:    { type: [String], default: [], select: false },
  avatar:            { type: String, default: '' },
  // null = chưa từng đổi thủ công (lần upload đầu tiên luôn tự do) — cooldown 1 ngày giữa các lần
  // đổi avatar sau đó.
  avatarChangedAt:   { type: Date, default: null },
  cover:             { type: String, default: '' },
  // null = chưa từng đổi thủ công (lần đổi đầu tiên luôn tự do) — cooldown 1 ngày giữa các lần
  // đổi/xóa cover sau đó.
  coverChangedAt:    { type: Date, default: null },
  isOnline:          { type: Boolean, default: false },
  lastSeen:          { type: Date, default: Date.now },
  role:              { type: String, enum: ['user', 'admin'], default: 'user' }, // Quản trị toàn hệ thống (duyệt report...) — khác "chủ phòng/admin" cấp nhóm chat
  isBanned:          { type: Boolean, default: false }, // Admin khóa tài khoản — chặn login mới + request/socket connect mới bằng token cũ
  pendingDeletionAt: { type: Date, default: null }, // User tự yêu cầu xóa — set = đang chờ xóa, chặn login. Bất kỳ giá trị non-null đều chặn (không so thời điểm ở phía check-login, job purge tự lo khi tới hạn)
  isDeleted:         { type: Boolean, default: false }, // true = đã purge — tombstone vĩnh viễn, KHÔNG xóa document (Message.sender/Room.members còn tham chiếu)
  reportTrustScore:            { type: Number, default: 100, min: 10, max: 100 }, // Điểm tin cậy báo cáo (Sàn tối thiểu: 10)
  reportCooldownAt:            { type: Date, default: null },                   // Cooldown nếu bị phát hiện spam report
  dailyTrustScoreIncrease:     { type: Number, default: 0 },                    // Điểm đã cộng trong ngày (Tối đa +15/ngày)
  lastTrustScoreIncreaseDate:  { type: String, default: '' },                   // Ngày cộng điểm gần nhất (YYYY-MM-DD)
  // Ẩn/hiện từng trường thông tin cá nhân (friends.service.js getProfile()) — chỉ 2 mức: 'friends'/'private'. Người lạ luôn không xem được.
  privacySettings: {
    bio:            { type: String, enum: ['friends', 'private'], default: 'friends' },
    activityStatus: { type: String, enum: ['friends', 'private'], default: 'friends' },
    joinDate:       { type: String, enum: ['friends', 'private'], default: 'friends' },
    gender:         { type: String, enum: ['friends', 'private'], default: 'friends' },
    dateOfBirth:    { type: String, enum: ['friends', 'private'], default: 'friends' },
    email:          { type: String, enum: ['friends', 'private'], default: 'friends' },
    phone:          { type: String, enum: ['friends', 'private'], default: 'friends' },
    readReceipts:   { type: String, enum: ['friends', 'private'], default: 'friends' },
  },
  devices: [{
    deviceId:     { type: String, required: true },
    // Key identity dùng trong encrypted envelope. Device cũ tự tương thích vì service đặt bằng deviceId.
    e2eeKeyId:    { type: String, required: true },
    publicKey:    { type: String, required: true },
    deviceName:   { type: String, default: 'Unknown Device' },
    // Hash (SHA-256) của token thiết bị opaque hiện hành — null nghĩa là chưa có/đã bị thu hồi
    // (logout/revoke/đổi mật khẩu). Không lưu token thô. Xem server/src/utils/auth/deviceToken.js.
    tokenHash:    { type: String, default: null, index: true },
    isRevoked:    { type: Boolean, default: false },
    revokedAt:    { type: Date, default: null },
    registeredAt: { type: Date, default: Date.now },
    lastActiveAt: { type: Date, default: Date.now },
  }],
}, { timestamps: true });

userSchema.pre('save', async function() {
  // Migration lazy cho device tạo trước e2eeKeyId; envelope lịch sử vốn đã dùng deviceId.
  this.devices.forEach(device => { if (!device.e2eeKeyId) device.e2eeKeyId = device.deviceId; });
  // 1. Đổi mật khẩu ➔ thu hồi toàn bộ token thiết bị đang có (đăng xuất mọi nơi ngay lập tức) —
  // opaque token không tự hết hạn theo passwordChangedAt như JWT trước đây, phải chủ động xóa hash.
  if (this.isModified('password')) {
    this.passwordChangedAt = new Date();
    this.devices.forEach(d => { d.tokenHash = null; });
    if (!this.password.startsWith('$2a$') && !this.password.startsWith('$2b$')) {
      this.password = await bcrypt.hash(this.password, 12);
    }
  }

  // 2. Mã hóa PII email & tạo Blind Index (để login/tìm trùng vẫn tra cứu được)
  if (this.isModified('email') && this.email) {
    const rawEmail = decryptPII(this.email);
    if (rawEmail) {
      this.emailHash = hashBlindIndex(rawEmail);
      this.email = encryptPII(rawEmail);
    }
  }

  // 3. Mã hóa PII số điện thoại & tạo Blind Index
  if (this.isModified('phone') && this.phone) {
    const rawPhone = decryptPII(this.phone);
    if (rawPhone) {
      this.phoneHash = hashBlindIndex(rawPhone);
      this.phone = encryptPII(rawPhone);
    } else {
      this.phoneHash = '';
    }
  }

  // 4. Mã hóa PII ngày sinh
  if (this.isModified('dateOfBirth') && this.dateOfBirth) {
    const rawDob = decryptPII(this.dateOfBirth);
    if (rawDob) {
      this.dateOfBirth = encryptPII(rawDob);
    }
  }
});

userSchema.methods.comparePassword = async function(pw) {
  return bcrypt.compare(pw, this.password);
};

userSchema.methods.toJSON = function() {
  const obj = this.toObject();
  delete obj.password;
  delete obj.phoneHash;
  delete obj.emailHash;
  delete obj.totpSecret;
  delete obj.totpPendingSecret;
  delete obj.totpPendingExpiresAt;
  delete obj.totpLastUsedStep;
  delete obj.totpRecoveryCodes;
  if (obj.devices) {
    obj.devices = obj.devices.map(({ tokenHash, ...rest }) => rest);
  }
  if (obj.email) {
    obj.email = decryptPII(obj.email);
  }
  if (obj.phone) {
    obj.phone = decryptPII(obj.phone);
  }
  if (obj.dateOfBirth) {
    obj.dateOfBirth = decryptPII(obj.dateOfBirth);
  }
  return obj;
};

module.exports = mongoose.model('User', userSchema);
