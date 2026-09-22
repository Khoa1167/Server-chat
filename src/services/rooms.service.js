const crypto = require('crypto');
const Room = require('../models/Room');
const { shouldRotateSenderKeyEpoch } = require('../utils/senderKeyRotation');
const User = require('../models/User');
const Friendship = require('../models/Friendship');
const Message = require('../models/Message');
const { isBlocked } = require('./blocks.service');
const SenderKeyDistribution = require('../models/SenderKeyDistribution');
const userFields = require('../utils/publicUserFields');
const AppError = require('../utils/AppError');
const { deleteCloudinaryImage } = require('../config/cloudinary');
const { getFriendIdSet, maskRoomMembersPresence } = require('../utils/presenceVisibility');
const { CHAT_BACKGROUND_KEYS } = require('../utils/chatBackgrounds');
const roomsListCache = require('../utils/roomsListCache');
const { createNotification } = require('./notifications.service');
const { deleteAttachmentsForRoom } = require('./attachments.service');
const sfu = require('./sfu.service');

const MAX_ROOM_MEMBERS = 50;
function assertRoomNotFull(room, adding = 1) {
  if (room.members.length + adding > MAX_ROOM_MEMBERS) {
    throw new AppError(`Phòng đã đạt giới hạn tối đa ${MAX_ROOM_MEMBERS} thành viên`, 400);
  }
}

// Gửi payload đã mask presence riêng theo góc nhìn từng người nhận, không dùng io.to().emit() chung.
// buildPayload(maskedRoom) => payload cụ thể gửi cho socket đó (mặc định gửi thẳng maskedRoom).
async function emitRoomToMembersPersonalized(io, room, event, buildPayload) {
  if (!io) return;
  const socketsInRoom = await io.in(room._id.toString()).fetchSockets();
  const friendIdSetCache = new Map();
  for (const s of socketsInRoom) {
    if (!s.data.user) continue;
    const viewerId = s.data.user._id.toString();
    let friendIdSet = friendIdSetCache.get(viewerId);
    if (!friendIdSet) {
      friendIdSet = await getFriendIdSet(viewerId);
      friendIdSetCache.set(viewerId, friendIdSet);
    }
    const maskedRoom = maskRoomMembersPresence(room, viewerId, friendIdSet);
    s.emit(event, buildPayload ? buildPayload(maskedRoom, viewerId) : maskedRoom);
  }
}

// Kiểm tra user có phải thành viên phòng không (dùng chung cho nhiều route bên dưới)
async function requireMembership(userId, roomId) {
  const room = await Room.findById(roomId);
  if (!room) throw new AppError('Phòng không tồn tại', 404);
  if (!room.members.some(m => m.toString() === userId.toString())) {
    throw new AppError('Không có quyền truy cập phòng này', 403);
  }
  return room;
}

// Chủ phòng hoặc quản trị viên — dùng chung cho các hành động moderator.
function isOwnerOrAdmin(room, userId) {
  const id = userId.toString();
  return room.createdBy.toString() === id || room.admins.some(a => a.toString() === id);
}

const ROOM_PERMISSIONS = Object.freeze({
  PIN_MESSAGES: 'pin_messages',
  CREATE_POLLS: 'create_polls',
});
const GRANTABLE_PERMISSIONS = Object.values(ROOM_PERMISSIONS);

// Quyền lẻ chỉ áp dụng phòng nhóm: host và admin có quyền ghim/tạo khảo sát, thành viên dùng grant trực tiếp.
// DM không có khái niệm host/admin — chỉ ghim tin nhắn hợp lý cho cả 2 phía (không có polls trong DM).
function hasRoomPermission(room, userId, key) {
  if (room.isDM) return key === ROOM_PERMISSIONS.PIN_MESSAGES;
  if (room.createdBy.toString() === userId.toString()) return true;
  if (room.admins.some(a => a.toString() === userId.toString())) return GRANTABLE_PERMISSIONS.includes(key);
  const granted = room.grantedPermissions?.get(userId.toString());
  return Array.isArray(granted) && (granted.includes(key)
    || (key === ROOM_PERMISSIONS.PIN_MESSAGES && granted.includes('pin')));
}

// room.memberJoinedAt là Mongoose Map trên document thật (vd getRoomMessages dùng Room.findById
// không .lean()) nhưng lại là plain object dưới .lean() (vd listMyRooms) — đọc đúng cả 2 dạng.
function getMemberJoinedAt(room, userId) {
  const map = room?.memberJoinedAt;
  if (!map) return null;
  const key = userId.toString();
  return (map instanceof Map ? map.get(key) : map[key]) || null;
}

// Cùng dạng dual Map/plain-object như getMemberJoinedAt — mốc chính user này đọc phòng gần nhất.
function getLastReadAt(room, userId) {
  const map = room?.lastReadAt;
  if (!map) return null;
  const key = userId.toString();
  return (map instanceof Map ? map.get(key) : map[key]) || null;
}

// Tin ghim quá hạn TTL (Message.serverExpiresAt, Message.js) bị MongoDB tự xóa ở tầng driver —
// không đi qua Mongoose middleware nên không nơi nào bắt được để tự dọn Room.pinnedMessage. Tự dò
// và dọn ngay mỗi lần trả danh sách phòng, thay vì thêm cron/change stream cho một trường hợp hiếm.
async function healOrphanedPinnedMessages(rooms) {
  const pinnedIds = rooms.filter(r => r.pinnedMessage).map(r => r.pinnedMessage.toString());
  if (!pinnedIds.length) return;

  // pre(/^find/) của Message tự loại tin đã hết hạn — còn lại đúng là những tin ghim vẫn hợp lệ.
  const alive = await Message.find({ _id: { $in: pinnedIds } }).select('_id').lean();
  const aliveIdSet = new Set(alive.map(m => m._id.toString()));

  const orphanedRooms = rooms.filter(r => r.pinnedMessage && !aliveIdSet.has(r.pinnedMessage.toString()));
  if (!orphanedRooms.length) return;

  // findByIdAndUpdate (không phải updateMany) để tận dụng hook invalidateMembersCache có sẵn (Room.js).
  await Promise.all(orphanedRooms.map(r => Room.findByIdAndUpdate(r._id, { pinnedMessage: null })));
  orphanedRooms.forEach(r => { r.pinnedMessage = null; });
}

// ─── Room CRUD ──────────────────────────────────────────────────────────────

async function listMyRooms(userId) {
  // Cache query thô (roomsListCache.js) — mask presence dưới đây luôn chạy live, không nằm trong cache.
  let rooms = await roomsListCache.get(userId);
  if (!rooms) {
    // .lean(): bỏ hydrate Document để giảm CPU/RAM; an toàn với encryptedKeys (Mongoose Map) vì lean trả thẳng plain object.
    rooms = await Room.find({ members: userId })
      .select('-inviteCode -inviteCodeExpiresAt -pendingRequests -pendingInvites')
      .populate('members', userFields.WITH_STATUS)
      .populate({
        path: 'lastMessage',
        populate: { path: 'sender', select: userFields.BASIC }
      })
      .sort({ updatedAt: -1 })
      .lean();
    await roomsListCache.set(userId, rooms);
  }

  await healOrphanedPinnedMessages(rooms);

  const friendIdSet = await getFriendIdSet(userId);
  const maskedRooms = rooms.map(roomDoc => {
    const masked = maskRoomMembersPresence(roomDoc, userId, friendIdSet);
    // Thành viên mới không thấy preview tin nhắn gửi trước lúc join (khớp ranh giới getRoomMessages()).
    const joinedAt = getMemberJoinedAt(roomDoc, userId);
    if (joinedAt && masked.lastMessage && new Date(masked.lastMessage.createdAt) < joinedAt) {
      masked.lastMessage = null;
    }

    // Chưa đọc: có tin cuối, không phải tự mình gửi, và gửi sau mốc mình đọc gần nhất.
    const isOwnLastMsg = masked.lastMessage?.sender?._id?.toString() === userId.toString();
    const lastReadAt = getLastReadAt(roomDoc, userId);
    const hasUnread = !!masked.lastMessage && !isOwnLastMsg
      && (!lastReadAt || new Date(masked.lastMessage.createdAt) > lastReadAt);

    masked.unreadCount = 0;
    // Cutoff chỉ tính khi thật sự có khả năng có tin chưa đọc — tránh query đếm thừa cho phòng đã đọc.
    masked._countCutoff = hasUnread ? (lastReadAt || joinedAt || new Date(0)) : null;
    return masked;
  });

  // Đếm chính xác số tin chưa đọc bằng 1 aggregation duy nhất cho toàn bộ phòng cần đếm
  // (không N+1 query). Chỉ dựa vào metadata (room/sender/createdAt) — không đọc content mã hóa.
  const roomsNeedingCount = maskedRooms.filter(r => r._countCutoff);
  if (roomsNeedingCount.length) {
    const counts = await Message.aggregate([
      {
        $match: {
          sender: { $ne: userId },
          isDeleted: false,
          serverExpiresAt: { $gt: new Date() },
          $and: [
            { $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] },
            { $or: roomsNeedingCount.map(r => ({ room: r._id, createdAt: { $gt: r._countCutoff } })) },
          ],
        },
      },
      { $group: { _id: '$room', count: { $sum: 1 } } },
    ]);
    const countMap = new Map(counts.map(c => [c._id.toString(), c.count]));
    roomsNeedingCount.forEach(r => { r.unreadCount = countMap.get(r._id.toString()) || 0; });
  }
  maskedRooms.forEach(r => { delete r._countCutoff; });
  return maskedRooms;
}

async function createRoom({ name, description, isPrivate, joinPolicy, members }, creatorId, io) {
  if (1 + (members || []).length > MAX_ROOM_MEMBERS) {
    throw new AppError(`Phòng đã đạt giới hạn tối đa ${MAX_ROOM_MEMBERS} thành viên`, 400);
  }

  for (const memberId of members || []) {
    if (await isBlocked(creatorId, memberId)) {
      throw new AppError('Không thể thêm người này vào nhóm', 403);
    }
  }

  const room = await Room.create({
    name,
    description,
    isPrivate: isPrivate || false,
    joinPolicy: joinPolicy === 'approval' ? 'approval' : 'open',
    members: [creatorId, ...(members || [])],
    admins: [creatorId],
    createdBy: creatorId,
  });
  await room.populate('members', userFields.WITH_STATUS);

  if (io) {
    const allSockets = await io.fetchSockets();
    const memberIds = room.members.map(m => m._id.toString());
    const friendIdSetCache = new Map();
    for (const s of allSockets) {
      if (!s.data.user || !memberIds.includes(s.data.user._id.toString())) continue;
      s.join(room._id.toString());
      const viewerId = s.data.user._id.toString();
      let friendIdSet = friendIdSetCache.get(viewerId);
      if (!friendIdSet) {
        friendIdSet = await getFriendIdSet(viewerId);
        friendIdSetCache.set(viewerId, friendIdSet);
      }
      s.emit('room:added', maskRoomMembersPresence(room, viewerId, friendIdSet));
    }
  }

  // Chủ phòng thêm thẳng lúc tạo (không qua duyệt/mời) — vẫn là "được thêm vào nhóm" từ góc nhìn của họ.
  await Promise.all(
    (members || []).map(memberId => createNotification(io, { user: memberId, type: 'group_added', fromUser: creatorId, room: room._id }))
  );

  return room;
}

async function listPublicRooms(viewerId) {
  // .lean() — xem giải thích ở listMyRooms() phía trên.
  const rooms = await Room.find({ isPrivate: false })
    .select('-inviteCode -inviteCodeExpiresAt -pendingRequests -pendingInvites')
    .populate('members', userFields.WITH_STATUS)
    .populate({
      path: 'lastMessage',
      populate: { path: 'sender', select: userFields.BASIC }
    })
    .sort({ updatedAt: -1 })
    .lean();

  const friendIdSet = await getFriendIdSet(viewerId);
  return rooms.map(roomDoc => maskRoomMembersPresence(roomDoc, viewerId, friendIdSet));
}

async function getRoomMessages(roomId, userId, { before, limit = 30 }) {
  // Kiểm tra xem user có phải thành viên phòng không (Sửa lỗi IDOR)
  const room = await Room.findById(roomId);
  if (!room) throw new AppError('Phòng không tồn tại', 404);
  if (!room.members.some(memberId => memberId.toString() === userId.toString())) {
    throw new AppError('Không có quyền truy cập tin nhắn của phòng này', 403);
  }
  // lastReadAt KHÔNG đánh dấu ở đây — client tự báo qua socket 'room:read' sau khi giải mã xong.

  const query = {
    room: roomId,
    isDeleted: false,
    // Loại tin đã tự hủy nhưng MongoDB TTL (quét nền ~60s/lần) chưa kịp xóa vật lý
    $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
  };
  // Cursor-based (createdAt), không skip — skip vẫn duyệt qua N document đã bỏ, chậm dần khi phân trang sâu.
  const createdAtFilter = {};
  if (before) createdAtFilter.$lt = new Date(before);
  // Thành viên mới (từ khi có memberJoinedAt) chỉ thấy tin nhắn từ lúc join trở đi — không set
  // (thành viên cũ trước khi có tính năng này) thì bỏ qua, giữ nguyên xem được toàn bộ lịch sử.
  const joinedAt = getMemberJoinedAt(room, userId);
  if (joinedAt) createdAtFilter.$gte = joinedAt;
  if (Object.keys(createdAtFilter).length) query.createdAt = createdAtFilter;

  // .lean() — xem giải thích ở listMyRooms() phía trên; không cần .toObject({flattenMaps:true}) nữa.
  const messages = await Message.find(query)
    .populate('sender', userFields.BASIC) // Sửa lỗi hiển thị Nickname
    .populate({ path: 'replyTo', select: 'sender content type fileName isDeleted iv tag', populate: { path: 'sender', select: userFields.BASIC } })
    .populate({ path: 'forwardedFrom', select: 'sender content iv tag', populate: { path: 'sender', select: userFields.MINIMAL } })
    .populate('reactions.users', userFields.MINIMAL)
    .sort({ createdAt: -1 })
    .limit(Number(limit))
    .lean();

  return messages.reverse();
}

// ─── Join phòng công khai / qua link mời ────────────────────────────────────

// Thêm userDoc vào members ngay (joinPolicy 'open') hoặc vào hàng chờ duyệt. alwaysPending=true ép
// vào hàng chờ bất kể joinPolicy (dùng cho link/QR mời). Idempotent nếu đã là thành viên.
async function addMemberOrRequest(room, userDoc, io, alwaysPending = false) {
  const uidStr = userDoc._id.toString();
  if (room.members.some(m => m.toString() === uidStr)) {
    return { status: 'joined' };
  }

  if (room.joinPolicy === 'approval' || alwaysPending) {
    if (!room.pendingRequests.some(p => p.toString() === uidStr)) {
      room.pendingRequests.push(userDoc._id);
      await room.save();

      if (io) {
        const adminIds = new Set([room.createdBy.toString(), ...room.admins.map(a => a.toString())]);
        const allSockets = await io.fetchSockets();
        allSockets
          .filter(s => s.data.user && adminIds.has(s.data.user._id.toString()))
          .forEach(s => s.emit('room:join_requested', {
            roomId: room._id.toString(),
            requester: { _id: uidStr, username: userDoc.username, nickname: userDoc.nickname, avatar: userDoc.avatar },
          }));
      }
    }
    return { status: 'pending' };
  }

  assertRoomNotFull(room);
  room.members.push(userDoc._id);
  room.memberJoinedAt.set(uidStr, new Date());
  room.pendingRequests = room.pendingRequests.filter(p => p.toString() !== uidStr);
  await room.save();
  await rotateSenderKeyForMembershipChange(room, io);

  // Epoch mới bảo đảm thành viên vừa vào không có Sender Key của lịch sử cũ.
  if (io) {
    // Populate trước khi emit để lấy đúng activityStatus thật của người mới, tránh hardcode isOnline:true.
    await room.populate('members', userFields.WITH_STATUS);

    await emitRoomToMembersPersonalized(io, room, 'room:member_joined', (maskedRoom) => ({
      roomId: room._id.toString(),
      member: maskedRoom.members.find(m => m._id.toString() === uidStr),
    }));

    // Người mới chưa join socket room nên emit trên không tới — cần join + emit riêng ở đây.
    const allSockets = await io.fetchSockets();
    const newMemberFriendIdSet = await getFriendIdSet(uidStr);
    allSockets.forEach(s => {
      if (s.data.user && s.data.user._id.toString() === uidStr) {
        s.join(room._id.toString());
        s.emit('room:added', maskRoomMembersPresence(room, uidStr, newMemberFriendIdSet));
      }
    });
  }
  return { status: 'joined' };
}

async function joinPublicRoom(roomId, userDoc, io) {
  const room = await Room.findById(roomId);
  if (!room) throw new AppError('Phòng không tồn tại', 404);

  // Bảo mật: Ngăn chặn IDOR (Chỉ cho phép tự động tham gia các phòng công khai)
  if (room.isPrivate || room.isDM) {
    throw new AppError('Không thể tham gia trực tiếp phòng chat riêng tư hoặc cuộc trò chuyện cá nhân', 403);
  }

  const { status } = await addMemberOrRequest(room, userDoc, io);
  if (status === 'pending') return { status: 'pending' };

  await room.populate('members', userFields.WITH_STATUS);
  return maskRoomMembersPresence(room, userDoc._id, await getFriendIdSet(userDoc._id));
}

// Link mời hết hạn chỉ chặn NGƯỜI MỚI (chưa từng là thành viên) — thành viên cũ mở lại link cũ
// (dù đã hết hạn) vẫn xem/tham gia lại được bình thường, không bị khóa khỏi phòng của chính mình.
function isInviteExpiredForNewJoin(room, userId) {
  const alreadyMember = room.members.some(m => m.toString() === userId.toString());
  if (alreadyMember) return false;
  return room.inviteCodeExpiresAt && room.inviteCodeExpiresAt.getTime() < Date.now();
}

async function previewInvite(inviteCode, userId) {
  const room = await Room.findOne({ inviteCode });
  if (!room || room.isDM) throw new AppError('Link mời không hợp lệ', 404);
  if (isInviteExpiredForNewJoin(room, userId)) {
    throw new AppError('Link mời đã hết hạn (sau 7 ngày) — hãy xin chủ phòng link mới', 410);
  }

  const base = {
    _id: room._id,
    name: room.name,
    avatar: room.avatar,
    isPrivate: room.isPrivate,
    memberCount: room.members.length,
    isMember: room.members.some(m => m.toString() === userId.toString()),
  };

  // Phòng private: chỉ lộ số lượng thành viên qua link, không lộ ngày tạo/danh sách ai đang ở
  // trong — tránh dò thông tin phòng riêng tư trước khi thực sự được duyệt vào. Phòng công khai
  // thì ai cũng xem/join thử được nên không cần giấu.
  if (room.isPrivate) return base;

  await room.populate('members', userFields.BASIC);
  return { ...base, createdAt: room.createdAt, members: room.members };
}

// Phòng riêng tư không tìm kiếm được nên link là cửa duy nhất — LUÔN ép vào hàng chờ duyệt bất
// kể joinPolicy. Phòng công khai vẫn tôn trọng joinPolicy chủ phòng đã chọn (giống joinPublicRoom).
async function joinViaInvite(inviteCode, userDoc, io) {
  const room = await Room.findOne({ inviteCode });
  if (!room || room.isDM) throw new AppError('Link mời không hợp lệ', 404);
  if (isInviteExpiredForNewJoin(room, userDoc._id)) {
    throw new AppError('Link mời đã hết hạn (sau 7 ngày) — hãy xin chủ phòng link mới', 410);
  }

  const { status } = await addMemberOrRequest(room, userDoc, io, room.isPrivate);
  if (status === 'pending') return { status: 'pending' };

  await room.populate('members', userFields.WITH_STATUS);
  return maskRoomMembersPresence(room, userDoc._id, await getFriendIdSet(userDoc._id));
}

async function getInviteCode(roomId, userId) {
  const room = await requireMembership(userId, roomId);
  if (room.isDM) throw new AppError('Không áp dụng cho cuộc trò chuyện riêng tư', 400);
  if (room.createdBy.toString() !== userId.toString()) {
    throw new AppError('Chỉ chủ phòng mới có thể lấy link mời', 403);
  }
  return { inviteCode: room.inviteCode, inviteCodeExpiresAt: room.inviteCodeExpiresAt };
}

async function rotateInviteCode(roomId, userId) {
  const room = await requireMembership(userId, roomId);
  if (room.isDM) throw new AppError('Không áp dụng cho cuộc trò chuyện riêng tư', 400);
  if (room.createdBy.toString() !== userId.toString()) {
    throw new AppError('Chỉ chủ phòng mới có thể tạo lại link mời', 403);
  }

  room.inviteCode = crypto.randomBytes(6).toString('hex');
  room.inviteCodeExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await room.save();
  return { inviteCode: room.inviteCode, inviteCodeExpiresAt: room.inviteCodeExpiresAt };
}

async function updateRoomSettings(roomId, userId, { name, isPrivate, joinPolicy }, io) {
  const room = await requireMembership(userId, roomId);
  if (room.isDM) throw new AppError('Không áp dụng cho cuộc trò chuyện riêng tư', 400);
  if (room.createdBy.toString() !== userId.toString()) {
    throw new AppError('Chỉ chủ phòng mới có thể đổi cài đặt phòng', 403);
  }

  if (name !== undefined) {
    if (!name.trim()) throw new AppError('Tên phòng không được để trống', 400);
    room.name = name.trim();
  }
  if (isPrivate !== undefined) {
    room.isPrivate = !!isPrivate;
  }
  if (joinPolicy !== undefined) {
    room.joinPolicy = joinPolicy === 'approval' ? 'approval' : 'open';
  }
  await room.save();

  if (io) {
    io.to(room._id.toString()).emit('room:settings_updated', {
      roomId: room._id.toString(),
      name: room.name,
      avatar: room.avatar,
      isPrivate: room.isPrivate,
      joinPolicy: room.joinPolicy,
    });
  }

  return { name: room.name, isPrivate: room.isPrivate, joinPolicy: room.joinPolicy };
}

async function updateRoomAvatar(roomId, userId, file, io) {
  if (!file) throw new AppError('Không có file ảnh', 400);

  const room = await requireMembership(userId, roomId);
  if (room.isDM) throw new AppError('Không áp dụng cho cuộc trò chuyện riêng tư', 400);
  if (room.createdBy.toString() !== userId.toString()) {
    throw new AppError('Chỉ chủ phòng mới có thể đổi avatar phòng', 403);
  }

  const oldAvatar = room.avatar;
  room.avatar = file.path; // Cloudinary trả về URL trong path
  await room.save();

  if (oldAvatar && oldAvatar !== room.avatar) {
    deleteCloudinaryImage(oldAvatar);
  }

  if (io) {
    io.to(room._id.toString()).emit('room:settings_updated', {
      roomId: room._id.toString(),
      name: room.name,
      avatar: room.avatar,
      isPrivate: room.isPrivate,
      joinPolicy: room.joinPolicy,
    });
  }

  return { avatar: room.avatar };
}

// Đổi nền khung chat — áp dụng cho cả DM lẫn nhóm, bất kỳ thành viên nào cũng đổi được (không giới
// hạn chủ phòng như tên/avatar) vì đây thuần cosmetic, không ảnh hưởng quyền hạn hay dữ liệu phòng.
async function updateChatBackground(roomId, userId, chatBackground, io) {
  const room = await requireMembership(userId, roomId);
  if (!CHAT_BACKGROUND_KEYS.includes(chatBackground)) {
    throw new AppError('Nền không hợp lệ', 400);
  }

  const oldImage = room.chatBackgroundImage;
  room.chatBackground = chatBackground;
  room.chatBackgroundImage = '';
  await room.save();

  if (oldImage) deleteCloudinaryImage(oldImage);

  if (io) {
    io.to(room._id.toString()).emit('room:background_updated', {
      roomId: room._id.toString(),
      chatBackground: room.chatBackground,
      chatBackgroundImage: room.chatBackgroundImage,
      chatMessageColor: room.chatMessageColor,
    });
  }

  return { chatBackground: room.chatBackground, chatBackgroundImage: room.chatBackgroundImage };
}

async function updateChatBackgroundImage(roomId, userId, file, io) {
  if (!file) throw new AppError('Không có file ảnh', 400);

  const room = await requireMembership(userId, roomId);
  const oldImage = room.chatBackgroundImage;
  room.chatBackground = 'default';
  room.chatBackgroundImage = file.path;
  await room.save();

  if (oldImage && oldImage !== room.chatBackgroundImage) deleteCloudinaryImage(oldImage);

  if (io) {
    io.to(room._id.toString()).emit('room:background_updated', {
      roomId: room._id.toString(),
      chatBackground: room.chatBackground,
      chatBackgroundImage: room.chatBackgroundImage,
      chatMessageColor: room.chatMessageColor,
    });
  }

  return { chatBackground: room.chatBackground, chatBackgroundImage: room.chatBackgroundImage };
}

async function updateChatMessageColor(roomId, userId, chatMessageColor, io) {
  const room = await requireMembership(userId, roomId);
  if (chatMessageColor !== 'default' && !/^#[0-9a-f]{6}$/i.test(chatMessageColor || '')) {
    throw new AppError('Màu chữ không hợp lệ', 400);
  }

  room.chatMessageColor = chatMessageColor;
  await room.save();

  if (io) {
    io.to(room._id.toString()).emit('room:background_updated', {
      roomId: room._id.toString(),
      chatBackground: room.chatBackground,
      chatBackgroundImage: room.chatBackgroundImage,
      chatMessageColor: room.chatMessageColor,
    });
  }

  return { chatMessageColor: room.chatMessageColor };
}

// ─── Yêu cầu tham gia đang chờ duyệt ────────────────────────────────────────

async function listJoinRequests(roomId, userId) {
  const room = await requireMembership(userId, roomId);
  if (!isOwnerOrAdmin(room, userId)) {
    throw new AppError('Chỉ quản trị viên nhóm mới xem được yêu cầu tham gia', 403);
  }

  await room.populate('pendingRequests', userFields.BASIC);
  return room.pendingRequests;
}

async function approveJoinRequest(roomId, adminUserId, targetUserId, io) {
  const room = await requireMembership(adminUserId, roomId);
  if (!isOwnerOrAdmin(room, adminUserId)) {
    throw new AppError('Chỉ quản trị viên nhóm mới có thể duyệt yêu cầu tham gia', 403);
  }
  if (!room.pendingRequests.some(p => p.toString() === targetUserId)) {
    throw new AppError('Không tìm thấy yêu cầu tham gia này', 404);
  }

  const requester = await User.findById(targetUserId).select(userFields.BASIC);
  if (!requester) throw new AppError('Người dùng không tồn tại', 404);

  if (await isBlocked(adminUserId, targetUserId)) {
    throw new AppError('Không thể duyệt yêu cầu tham gia của người này', 403);
  }

  assertRoomNotFull(room);
  room.pendingRequests = room.pendingRequests.filter(p => p.toString() !== targetUserId);
  room.members.push(requester._id);
  room.memberJoinedAt.set(targetUserId, new Date());
  await room.save();
  await rotateSenderKeyForMembershipChange(room, io);
  await room.populate('members', userFields.WITH_STATUS);

  if (io) {
    const requesterIdStr = requester._id.toString();

    await emitRoomToMembersPersonalized(io, room, 'room:member_joined', (maskedRoom) => ({
      roomId: room._id.toString(),
      member: maskedRoom.members.find(m => m._id.toString() === requesterIdStr),
    }));

    // Người vừa được duyệt chưa join socket room nên không nhận được sự kiện trên, báo riêng.
    const allSockets = await io.fetchSockets();
    const requesterFriendIdSet = await getFriendIdSet(requesterIdStr);
    allSockets.forEach(s => {
      if (s.data.user && s.data.user._id.toString() === requesterIdStr) {
        s.join(room._id.toString());
        s.emit('room:added', maskRoomMembersPresence(room, requesterIdStr, requesterFriendIdSet));
      }
    });

    await createNotification(io, { user: requesterIdStr, type: 'group_added', fromUser: adminUserId, room: room._id });
  }
}

async function rejectJoinRequest(roomId, adminUserId, targetUserId, io) {
  const room = await requireMembership(adminUserId, roomId);
  if (!isOwnerOrAdmin(room, adminUserId)) {
    throw new AppError('Chỉ quản trị viên nhóm mới có thể từ chối yêu cầu tham gia', 403);
  }

  room.pendingRequests = room.pendingRequests.filter(p => p.toString() !== targetUserId);
  await room.save();

  if (io) {
    const allSockets = await io.fetchSockets();
    allSockets
      .filter(s => s.data.user && s.data.user._id.toString() === targetUserId)
      .forEach(s => s.emit('room:join_rejected', { roomId: room._id.toString() }));
  }
}

// ─── Thêm thành viên trực tiếp (đích danh, cần người được mời tự xác nhận) ──

async function inviteFriend(roomId, inviter, targetId, io) {
  const room = await requireMembership(inviter._id, roomId);
  if (room.isDM) throw new AppError('Không thể thêm thành viên vào phòng DM', 400);

  if (room.createdBy.toString() !== inviter._id.toString()) {
    throw new AppError('Chỉ chủ phòng mới có thể thêm thành viên', 403);
  }

  assertRoomNotFull(room);

  if (room.members.some(m => m.toString() === targetId)) {
    throw new AppError('Người này đã là thành viên', 400);
  }
  if (room.pendingInvites.some(p => p.toString() === targetId)) {
    throw new AppError('Đã gửi lời mời cho người này rồi', 400);
  }

  if (await isBlocked(inviter._id, targetId)) {
    throw new AppError('Không thể mời người này vào nhóm', 403);
  }

  const isFriend = await Friendship.findOne({
    $or: [
      { sender: inviter._id, receiver: targetId },
      { sender: targetId, receiver: inviter._id },
    ],
    status: 'accepted',
  });
  if (!isFriend) {
    throw new AppError('Chỉ có thể thêm bạn bè vào nhóm', 400);
  }

  const target = await User.findById(targetId).select(userFields.BASIC);
  if (!target) throw new AppError('Người dùng không tồn tại', 404);

  room.pendingInvites.push(targetId);
  await room.save();

  if (io) {
    const allSockets = await io.fetchSockets();
    allSockets
      .filter(s => s.data.user && s.data.user._id.toString() === targetId)
      .forEach(s => s.emit('room:invite_received', {
        roomId: room._id.toString(),
        roomName: room.name,
        invitedBy: { _id: inviter._id, nickname: inviter.nickname, username: inviter.username },
      }));
  }
}

async function listMyPendingInvites(userId) {
  return Room.find({ pendingInvites: userId }).select('name isPrivate');
}

async function acceptInvite(roomId, user, io) {
  const room = await Room.findById(roomId);
  if (!room) throw new AppError('Phòng không tồn tại', 404);
  if (!room.pendingInvites.some(p => p.toString() === user._id.toString())) {
    throw new AppError('Không tìm thấy lời mời này', 404);
  }

  assertRoomNotFull(room);
  room.pendingInvites = room.pendingInvites.filter(p => p.toString() !== user._id.toString());
  room.members.push(user._id);
  room.memberJoinedAt.set(user._id.toString(), new Date());
  await room.save();
  await rotateSenderKeyForMembershipChange(room, io);
  await room.populate('members', userFields.WITH_STATUS);

  const userIdStr = user._id.toString();
  const friendIdSet = await getFriendIdSet(userIdStr);

  if (io) {
    await emitRoomToMembersPersonalized(io, room, 'room:member_joined', (maskedRoom) => ({
      roomId: room._id.toString(),
      member: maskedRoom.members.find(m => m._id.toString() === userIdStr),
    }));

    const allSockets = await io.fetchSockets();
    allSockets
      .filter(s => s.data.user && s.data.user._id.toString() === userIdStr)
      .forEach(s => { s.join(room._id.toString()); s.emit('room:added', maskRoomMembersPresence(room, userIdStr, friendIdSet)); });
  }

  return maskRoomMembersPresence(room, userIdStr, friendIdSet);
}

async function declineInvite(roomId, userId) {
  const room = await Room.findById(roomId);
  if (!room) throw new AppError('Phòng không tồn tại', 404);

  room.pendingInvites = room.pendingInvites.filter(p => p.toString() !== userId.toString());
  await room.save();
}

// ─── Sender Key (mã hóa nhóm) ───────────────────────────────────────────────

async function distributeSenderKey(roomId, user, { epoch, senderDeviceId, encryptedKeys }, io) {
  const room = await requireMembership(user._id, roomId);

  if (epoch === undefined || !senderDeviceId || !encryptedKeys || typeof encryptedKeys !== 'object') {
    throw new AppError('Thiếu epoch, senderDeviceId hoặc encryptedKeys', 400);
  }

  // Chặn giả mạo senderDeviceId của thiết bị người khác (unique index room+epoch+senderDeviceId
  // sẽ cho phép ghi đè distribution hợp lệ nếu không chặn ở đây)
  const ownsDevice = user.devices.some(d => d.deviceId === senderDeviceId && !d.isRevoked);
  if (!ownsDevice) {
    throw new AppError('senderDeviceId không thuộc về thiết bị đang hoạt động của bạn', 403);
  }

  const doc = await SenderKeyDistribution.findOneAndUpdate(
    { room: room._id, epoch, senderDeviceId },
    { room: room._id, epoch, senderDeviceId, senderUser: user._id, encryptedKeys },
    { upsert: true, new: true }
  );

  if (io) {
    io.to(room._id.toString()).emit('sender_key:new', doc.toObject({ flattenMaps: true }));
  }

  return doc.toObject({ flattenMaps: true });
}

async function getSenderKeyDoc(roomId, userId, { epoch, senderDeviceId }) {
  const room = await requireMembership(userId, roomId);

  if (epoch === undefined || !senderDeviceId) {
    throw new AppError('Thiếu epoch hoặc senderDeviceId', 400);
  }

  const doc = await SenderKeyDistribution.findOne({ room: room._id, epoch, senderDeviceId });
  if (!doc) throw new AppError('Chưa có Sender Key cho epoch này', 404);

  return doc.toObject({ flattenMaps: true });
}

// Tăng senderKeyEpoch của phòng + báo cho cả phòng biết — dùng chung bởi rotate-key thủ công
// và rời/kick thành viên (loại người khỏi nhóm cũng phải buộc tạo Sender Key mới không có họ).
async function bumpSenderKeyEpoch(room, io) {
  const updated = await Room.findByIdAndUpdate(room._id, {
    $inc: { senderKeyEpoch: 1 },
    $set: { senderKeyEpochMessageCount: 0, senderKeyEpochStartedAt: new Date() },
  }, { new: true });
  if (io) {
    io.to(room._id.toString()).emit('sender_key:rotated', { roomId: room._id.toString(), epoch: updated.senderKeyEpoch });
  }
  return updated.senderKeyEpoch;
}

async function rotateSenderKeyForMembershipChange(room, io) {
  const epoch = await bumpSenderKeyEpoch(room, io);
  room.senderKeyEpoch = epoch;
  room.senderKeyEpochMessageCount = 0;
  room.senderKeyEpochStartedAt = new Date();
}

// Chỉ gọi sau khi Message đã được lưu: epoch cũ chứa đúng 100 tin, rồi client nhận event để
// mã hóa tin kế tiếp bằng epoch mới. Mốc 14 ngày cũng lazy, tức tin đầu tiên sau mốc sẽ kích hoạt xoay.
async function rotateSenderKeyEpochAfterMessage(room, epoch, io) {
  const counted = await Room.findOneAndUpdate(
    { _id: room._id, senderKeyEpoch: epoch },
    { $inc: { senderKeyEpochMessageCount: 1 } },
    { new: true }
  );
  if (!counted || !shouldRotateSenderKeyEpoch({
    messageCount: counted.senderKeyEpochMessageCount,
    startedAt: counted.senderKeyEpochStartedAt,
  })) return false;

  const updated = await Room.findOneAndUpdate(
    { _id: room._id, senderKeyEpoch: epoch },
    {
      $inc: { senderKeyEpoch: 1 },
      $set: { senderKeyEpochMessageCount: 0, senderKeyEpochStartedAt: new Date() },
    },
    { new: true }
  );
  if (!updated) return false;

  if (io) {
    io.to(room._id.toString()).emit('sender_key:rotated', { roomId: room._id.toString(), epoch: updated.senderKeyEpoch });
  }
  return true;
}

async function rotateSenderKey(roomId, userId, io) {
  const room = await requireMembership(userId, roomId);
  const epoch = await bumpSenderKeyEpoch(room, io);
  return { roomId: room._id, epoch };
}

// Đổi khóa hoặc thiết bị của một người phải tạo epoch DM mới để thiết bị cũ/đã thu hồi không
// giải mã các tin nhắn gửi sau đó. Nhóm giữ nguyên luồng xoay khóa hiện có.
async function rotateDmSenderKeyEpochsForUser(userId, io) {
  const rooms = await Room.find({ isDM: true, members: userId }).select('_id members');
  const memberIds = new Set();
  await Promise.all(rooms.map(async room => {
    const updated = await Room.findByIdAndUpdate(room._id, {
      $inc: { senderKeyEpoch: 1 },
      $set: { senderKeyEpochMessageCount: 0, senderKeyEpochStartedAt: new Date() },
    }, { new: true }).select('senderKeyEpoch members');
    (updated?.members || room.members || []).forEach(memberId => memberIds.add(memberId.toString()));
    if (io) io.to(room._id.toString()).emit('sender_key:rotated', { roomId: room._id.toString(), epoch: updated.senderKeyEpoch });
  }));
  await Promise.all([...memberIds].map(memberId => roomsListCache.invalidate(memberId)));
}

// ─── Thành viên / quản trị viên / chủ phòng ─────────────────────────────────

// Phát admins/createdBy mới cho cả phòng — dùng bởi mọi thao tác đổi vai trò (rời/kick kèm kế vị
// chủ phòng, phong/gỡ admin, chuyển quyền chủ phòng) để mọi client cập nhật badge realtime.
function broadcastRoomUpdated(room, io) {
  if (!io) return;
  io.to(room._id.toString()).emit('room:updated', {
    roomId: room._id.toString(),
    admins: room.admins.map(a => a.toString()),
    createdBy: room.createdBy.toString(),
  });
}

function broadcastPermissionsUpdated(room, targetUserId, io) {
  if (!io) return;
  io.to(room._id.toString()).emit('room:permissions_updated', {
    roomId: room._id.toString(),
    userId: targetUserId,
    permissions: room.grantedPermissions.get(targetUserId) || [],
  });
}

// Dọn Message/SenderKeyDistribution của 1 phòng trước khi xóa hẳn Room, tránh mồ côi vĩnh viễn trong DB.
async function deleteRoomData(roomId) {
  await Promise.all([
    Message.deleteMany({ room: roomId }),
    SenderKeyDistribution.deleteMany({ room: roomId }),
    deleteAttachmentsForRoom(roomId),
  ]);
}

async function removeMemberFromRoom(room, userId, io, preferredNewOwnerId, kickedBy) {
  // Room model hooks invalidate cache theo doc.members SAU khi save — người vừa rời/bị kick đã bị
  // loại khỏi mảng đó nên không tự invalidate được, phải gọi riêng ở đây.
  roomsListCache.invalidate(userId).catch(() => {});

  const uidStr = userId.toString();
  const remainingMembers = room.members.filter(m => m.toString() !== uidStr);

  if (remainingMembers.length === 0) {
    await deleteRoomData(room._id);
    await Room.findByIdAndDelete(room._id);
    // Rời khỏi cuộc gọi nhóm đang tham gia (nếu có) trước khi báo Sidebar — người này không còn là
    // thành viên phòng, quyền vào call chỉ check ở lúc join nên phải chủ động ngắt ở đây.
    sfu.forceLeaveRoomForUser(room._id.toString(), uidStr);
    // Báo cho chính người vừa rời (thành viên cuối cùng) — Sidebar chỉ gỡ phòng qua sự kiện này.
    if (io) {
      const allSockets = await io.fetchSockets();
      allSockets
        .filter(s => s.data.user && s.data.user._id.toString() === uidStr)
        .forEach(s => {
          s.emit('room:removed', { roomId: room._id.toString(), reason: 'left' });
          s.leave(room._id.toString());
        });
    }
    return { deleted: true };
  }

  room.members = remainingMembers;
  room.admins = room.admins.filter(a => a.toString() !== uidStr);
  room.grantedPermissions.delete(uidStr);

  if (room.createdBy.toString() === uidStr) {
    const newOwner = preferredNewOwnerId || room.admins[0] || remainingMembers[0];
    room.createdBy = newOwner;
    if (!room.admins.some(a => a.toString() === newOwner.toString())) {
      room.admins.push(newOwner);
    }
  } else if (room.admins.length === 0) {
    // Không nên xảy ra (chủ phòng luôn nằm trong admins) — phòng hờ dữ liệu lệch
    room.admins = [room.createdBy];
  }

  await room.save();

  // Rời khỏi cuộc gọi nhóm đang tham gia (nếu có) — cùng lý do với nhánh phòng bị xóa ở trên.
  // sfu.service không có io nên báo call:group-peer-left ở đây để người còn lại gỡ đúng tile.
  const forcedFromCall = sfu.forceLeaveRoomForUser(room._id.toString(), uidStr);
  if (io && forcedFromCall.length > 0) {
    io.to(room._id.toString()).emit('call:group-peer-left', { userId: uidStr });
    if (sfu.getParticipantCount(room._id.toString()) === 0) {
      io.to(room._id.toString()).emit('call:group-ended', { roomId: room._id.toString() });
    }
  }

  if (io) {
    io.to(room._id.toString()).emit('room:member_left', { roomId: room._id.toString(), userId: uidStr });
    broadcastRoomUpdated(room, io);

    const allSockets = await io.fetchSockets();
    allSockets
      .filter(s => s.data.user && s.data.user._id.toString() === uidStr)
      .forEach(s => {
        s.emit('room:removed', { roomId: room._id.toString(), reason: kickedBy ? 'kicked' : 'left' });
        s.leave(room._id.toString());
      });

    if (kickedBy) {
      await createNotification(io, { user: uidStr, type: 'group_kicked', fromUser: kickedBy, room: room._id });
    }
  }

  await bumpSenderKeyEpoch(room, io);
  return { deleted: false };
}

async function leaveRoom(roomId, userId, newOwnerId, io) {
  const room = await requireMembership(userId, roomId);
  if (room.isDM) {
    throw new AppError('Không thể rời cuộc trò chuyện riêng tư — hãy dùng hủy kết bạn.', 400);
  }

  // Chủ phòng có thể tự chọn người kế nhiệm trước khi rời — bỏ trống thì tự động gán như cũ
  if (newOwnerId) {
    const isOwner = room.createdBy.toString() === userId.toString();
    if (!isOwner) {
      throw new AppError('Chỉ chủ phòng mới có thể chỉ định người kế nhiệm', 403);
    }
    if (newOwnerId === userId.toString()) {
      throw new AppError('Không thể chuyển quyền cho chính mình', 400);
    }
    if (!room.members.some(m => m.toString() === newOwnerId)) {
      throw new AppError('Người được chọn phải là thành viên trong nhóm', 400);
    }
  }

  await removeMemberFromRoom(room, userId, io, newOwnerId);
}

// Hủy phòng — khác "rời nhóm"/"kick": chủ phòng chủ động xóa hẳn phòng dù vẫn còn thành viên khác,
// không cần đợi từng người tự rời. Không hoàn tác được (client bắt buộc xác nhận trước khi gọi).
async function deleteRoom(roomId, userId, io) {
  const room = await requireMembership(userId, roomId);
  if (room.isDM) {
    throw new AppError('Không thể hủy cuộc trò chuyện riêng tư — hãy dùng hủy kết bạn.', 400);
  }
  if (room.createdBy.toString() !== userId.toString()) {
    throw new AppError('Chỉ chủ phòng mới có thể hủy phòng', 403);
  }

  const roomIdStr = room._id.toString();
  const memberIds = room.members.map(m => m.toString());

  await deleteRoomData(room._id);
  await Room.findByIdAndDelete(room._id);

  // Phòng bị hủy — mọi người đang trong cuộc gọi nhóm (nếu có) đều phải rời, không chỉ chủ phòng.
  memberIds.forEach(memberId => sfu.forceLeaveRoomForUser(roomIdStr, memberId));

  if (io) {
    io.to(roomIdStr).emit('room:removed', { roomId: roomIdStr, reason: 'deleted' });
    const allSockets = await io.fetchSockets();
    allSockets
      .filter(s => s.data.user && memberIds.includes(s.data.user._id.toString()))
      .forEach(s => s.leave(roomIdStr));
  }
}

async function kickMember(roomId, actingUserId, targetUserId, io) {
  const room = await requireMembership(actingUserId, roomId);
  if (room.isDM) {
    throw new AppError('Không áp dụng cho cuộc trò chuyện riêng tư', 400);
  }
  const isOwner = room.createdBy.toString() === actingUserId.toString();
  const isAdmin = room.admins.some(a => a.toString() === actingUserId.toString());
  if (!isOwner && !isAdmin) {
    throw new AppError('Chỉ quản trị viên nhóm mới có thể xóa thành viên', 403);
  }
  if (targetUserId === actingUserId.toString()) {
    throw new AppError('Dùng chức năng "Rời nhóm" để tự rời khỏi nhóm', 400);
  }
  if (targetUserId === room.createdBy.toString()) {
    throw new AppError('Không thể xóa chủ phòng', 403);
  }
  if (!room.members.some(m => m.toString() === targetUserId)) {
    throw new AppError('Người này không phải thành viên phòng', 404);
  }
  const targetIsAdmin = room.admins.some(a => a.toString() === targetUserId);
  if (targetIsAdmin && !isOwner) {
    throw new AppError('Chỉ chủ phòng mới có thể xóa quản trị viên khác', 403);
  }

  await removeMemberFromRoom(room, targetUserId, io, undefined, actingUserId);
}

async function promoteAdmin(roomId, userId, targetUserId, io) {
  const room = await requireMembership(userId, roomId);
  if (room.isDM) throw new AppError('Không áp dụng cho cuộc trò chuyện riêng tư', 400);
  if (room.createdBy.toString() !== userId.toString()) {
    throw new AppError('Chỉ chủ phòng mới có thể phong quản trị viên', 403);
  }
  if (!room.members.some(m => m.toString() === targetUserId)) {
    throw new AppError('Người này không phải thành viên phòng', 404);
  }
  if (!room.admins.some(a => a.toString() === targetUserId)) {
    room.admins.push(targetUserId);
    await room.save();
    broadcastRoomUpdated(room, io);
  }
}

async function demoteAdmin(roomId, userId, targetUserId, io) {
  const room = await requireMembership(userId, roomId);
  if (room.isDM) throw new AppError('Không áp dụng cho cuộc trò chuyện riêng tư', 400);
  if (room.createdBy.toString() !== userId.toString()) {
    throw new AppError('Chỉ chủ phòng mới có thể gỡ quyền quản trị viên', 403);
  }
  if (targetUserId === room.createdBy.toString()) {
    throw new AppError('Không thể gỡ quyền của chính chủ phòng — hãy chuyển quyền chủ phòng nếu muốn đổi', 400);
  }
  room.admins = room.admins.filter(a => a.toString() !== targetUserId);
  await room.save();
  broadcastRoomUpdated(room, io);
}

async function transferOwnership(roomId, userId, targetUserId, io) {
  const room = await requireMembership(userId, roomId);
  if (room.isDM) throw new AppError('Không áp dụng cho cuộc trò chuyện riêng tư', 400);
  if (room.createdBy.toString() !== userId.toString()) {
    throw new AppError('Bạn không còn là chủ phòng', 403);
  }
  if (!room.members.some(m => m.toString() === targetUserId)) {
    throw new AppError('Người này không phải thành viên phòng', 404);
  }

  room.createdBy = targetUserId;
  if (!room.admins.some(a => a.toString() === targetUserId)) {
    room.admins.push(targetUserId);
  }
  await room.save();
  broadcastRoomUpdated(room, io);
}

async function grantPermission(roomId, granterId, targetUserId, key, io) {
  const room = await requireMembership(granterId, roomId);
  if (room.isDM) throw new AppError('Không áp dụng cho cuộc trò chuyện riêng tư', 400);
  if (room.createdBy.toString() !== granterId.toString()) {
    throw new AppError('Chỉ chủ phòng mới có thể cấp quyền', 403);
  }
  if (!GRANTABLE_PERMISSIONS.includes(key)) {
    throw new AppError('Quyền không hợp lệ', 400);
  }
  if (!room.members.some(m => m.toString() === targetUserId)) {
    throw new AppError('Người này không phải thành viên phòng', 404);
  }
  if (isOwnerOrAdmin(room, targetUserId)) {
    throw new AppError('Không cấp quyền lẻ cho chủ phòng hoặc quản trị viên', 400);
  }
  const targetKey = targetUserId.toString();
  const current = room.grantedPermissions.get(targetKey) || [];
  if (!current.includes(key)) {
    room.grantedPermissions.set(targetKey, [...current, key]);
    await room.save();
  }
  broadcastPermissionsUpdated(room, targetKey, io);
}

async function revokePermission(roomId, granterId, targetUserId, key, io) {
  const room = await requireMembership(granterId, roomId);
  if (room.isDM) throw new AppError('Không áp dụng cho cuộc trò chuyện riêng tư', 400);
  if (room.createdBy.toString() !== granterId.toString()) {
    throw new AppError('Chỉ chủ phòng mới có thể thu hồi quyền', 403);
  }
  if (!GRANTABLE_PERMISSIONS.includes(key)) {
    throw new AppError('Quyền không hợp lệ', 400);
  }
  if (!room.members.some(m => m.toString() === targetUserId)) {
    throw new AppError('Người này không phải thành viên phòng', 404);
  }
  const targetKey = targetUserId.toString();
  const current = room.grantedPermissions.get(targetKey) || [];
  if (current.includes(key)) {
    const retained = current.filter(k => k !== key && !(key === ROOM_PERMISSIONS.PIN_MESSAGES && k === 'pin'));
    if (retained.length) room.grantedPermissions.set(targetKey, retained);
    else room.grantedPermissions.delete(targetKey);
    await room.save();
  }
  broadcastPermissionsUpdated(room, targetKey, io);
}

module.exports = {
  listMyRooms,
  createRoom,
  listPublicRooms,
  getRoomMessages,
  joinPublicRoom,
  previewInvite,
  joinViaInvite,
  getInviteCode,
  rotateInviteCode,
  updateRoomSettings,
  updateRoomAvatar,
  updateChatBackground,
  updateChatBackgroundImage,
  updateChatMessageColor,
  listJoinRequests,
  approveJoinRequest,
  rejectJoinRequest,
  inviteFriend,
  listMyPendingInvites,
  acceptInvite,
  declineInvite,
  distributeSenderKey,
  getSenderKeyDoc,
  rotateSenderKey,
  rotateSenderKeyEpochAfterMessage,
  rotateDmSenderKeyEpochsForUser,
  leaveRoom,
  deleteRoom,
  kickMember,
  promoteAdmin,
  demoteAdmin,
  transferOwnership,
  grantPermission,
  revokePermission,
  hasRoomPermission,
  ROOM_PERMISSIONS,
};
