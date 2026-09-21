const mongoose = require('mongoose');
const Friendship = require('../models/Friendship');
const User = require('../models/User');
const Room = require('../models/Room');
const Block = require('../models/Block');
const { isBlocked } = require('./blocks.service');
const userFields = require('../utils/publicUserFields');
const { decryptPII } = require('../utils/crypto');
const AppError = require('../utils/AppError');
const { getFriendIdSet, maskMemberPresence, maskDmMemberPresence } = require('../utils/presenceVisibility');
const { createNotification } = require('./notifications.service');

async function listFriends(userId) {
  // .lean() — không có field PII/Map ở đây nên không cần .toObject() xử lý riêng.
  const friendships = await Friendship.find({
    $or: [{ sender: userId }, { receiver: userId }],
    status: 'accepted',
  })
    .populate('sender', userFields.WITH_STATUS_LASTSEEN)
    .populate('receiver', userFields.WITH_STATUS_LASTSEEN)
    .lean();

  // sender/receiver ở đây luôn là chính mình hoặc bạn bè (định nghĩa của friendship 'accepted') —
  // vẫn cần mask vì 1 trong 2 phía có thể đã set activityStatus = 'private' (ẩn cả với bạn bè).
  const friendIdSet = await getFriendIdSet(userId);
  return friendships.map(f => ({
    ...f,
    sender: maskMemberPresence(f.sender, userId, friendIdSet),
    receiver: maskMemberPresence(f.receiver, userId, friendIdSet),
  }));
}

async function listPendingRequests(userId) {
  return Friendship.find({
    receiver: userId,
    status: 'pending',
  }).populate('sender', userFields.BASIC).lean();
}

async function searchUsers(currentUserId, q) {
  // Bảo mật: Tránh lỗi regex injection / ReDoS bằng cách escape các ký tự đặc biệt
  const escapedQuery = q.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');

  const users = await User.find({
    _id: { $ne: currentUserId },
    nickname: { $regex: escapedQuery, $options: 'i' }
  }).select('nickname avatar isOnline').limit(20).lean();

  // Đánh dấu requested:true cho những người mình đã gửi lời mời (đang chờ) — không thì sau khi
  // tải lại trang, client mất state tạm và hiện lại nút "Kết bạn" dù đã gửi lời mời rồi.
  const pendingSent = await Friendship.find({
    sender: currentUserId,
    receiver: { $in: users.map(u => u._id) },
    status: 'pending',
  }).select('receiver').lean();
  const pendingSentSet = new Set(pendingSent.map(f => f.receiver.toString()));

  // Đã là bạn bè rồi thì không hiện nút "Kết bạn" nữa — thiếu check này khiến tìm lại người đã kết
  // bạn vẫn ra nút gửi lời mời như người lạ.
  const friendIdSet = await getFriendIdSet(currentUserId);

  return users.map(u => ({
    ...u,
    requested: pendingSentSet.has(u._id.toString()),
    isFriend: friendIdSet.has(u._id.toString()),
  }));
}

async function sendFriendRequest(senderId, receiverId, io) {
  if (receiverId === senderId.toString()) {
    throw new AppError('Không thể kết bạn với chính mình', 400);
  }
  if (await isBlocked(senderId, receiverId)) {
    throw new AppError('Không thể gửi lời mời kết bạn', 403);
  }

  // Kiểm tra đã có quan hệ chưa
  const exists = await Friendship.findOne({
    $or: [
      { sender: senderId, receiver: receiverId },
      { sender: receiverId, receiver: senderId },
    ],
  });

  if (exists) {
    if (exists.status === 'accepted') throw new AppError('Đã là bạn bè', 400);
    if (exists.status === 'pending') throw new AppError('Đã gửi lời mời rồi', 400);
    if (exists.status === 'rejected') {
      // Cập nhật lại lời mời nếu trước đó bị từ chối
      exists.sender = senderId;
      exists.receiver = receiverId;
      exists.status = 'pending';
      await exists.save();
      await exists.populate('sender', userFields.BASIC);
      await exists.populate('receiver', userFields.BASIC);
      await createNotification(io, { user: receiverId, type: 'friend_request', fromUser: senderId });
      await notifyFriendRequest(io, receiverId, exists);
      return { friendship: exists, isNew: false };
    }
  }

  let friendship;
  try {
    friendship = await Friendship.create({ sender: senderId, receiver: receiverId });
  } catch (err) {
    // Race condition: 2 request gửi lời mời kết bạn cho cùng 1 cặp người gần như đồng thời —
    // check "exists" ở trên chỉ là TOCTOU, unique index combinationKey mới là lưới an toàn thật.
    if (err.code === 11000) {
      throw new AppError('Đã gửi lời mời rồi', 400);
    }
    throw err;
  }

  await friendship.populate('sender', userFields.BASIC);
  await friendship.populate('receiver', userFields.BASIC);
  await createNotification(io, { user: receiverId, type: 'friend_request', fromUser: senderId });
  await notifyFriendRequest(io, receiverId, friendship);

  return { friendship, isNew: true };
}

async function notifyFriendRequest(io, receiverId, friendship) {
  if (!io) return;
  const allSockets = await io.fetchSockets();
  allSockets
    .filter(s => s.data.user?._id.toString() === receiverId.toString())
    .forEach(s => s.emit('friend:request_received', friendship));
}

// Báo cho cả 2 phía quan hệ bạn bè (không chỉ đối phương) để mọi nơi đang mở tự đồng bộ.
async function notifyFriendshipParties(io, senderId, receiverId, event, payload) {
  if (!io) return;
  const partyIds = [senderId.toString(), receiverId.toString()];
  const allSockets = await io.fetchSockets();
  allSockets
    .filter(s => s.data.user && partyIds.includes(s.data.user._id.toString()))
    .forEach(s => s.emit(event, payload));
}

// Lấy phòng DM giữa 2 người, tự tạo nếu chưa có — dùng chung cho acceptFriendRequest và getDmRoom.
async function getOrCreateDmRoom(userId1, userId2, createdBy) {
  if (await isBlocked(userId1, userId2)) throw new AppError('Không thể mở đoạn chat này', 403);
  const existing = await Room.findOne({
    isDM: true,
    members: { $all: [userId1, userId2] },
  });
  if (existing) return { room: existing, created: false };

  const room = await Room.create({
    name: `dm_${userId1}_${userId2}`,
    isDM: true,
    isPrivate: true,
    members: [userId1, userId2],
    createdBy,
  });
  return { room, created: true };
}

async function acceptFriendRequest(friendshipId, currentUserId, io) {
  const friendship = await Friendship.findOne({
    _id: friendshipId,
    receiver: currentUserId,
    status: 'pending',
  });

  if (!friendship) throw new AppError('Không tìm thấy lời mời', 404);
  if (await isBlocked(friendship.sender, friendship.receiver)) {
    throw new AppError('Không thể chấp nhận lời mời kết bạn', 403);
  }

  friendship.status = 'accepted';
  await friendship.save();

  // Tự động tạo phòng DM giữa 2 người (tái sử dụng nếu đã từng kết bạn trước đó)
  const { room: dmRoom } = await getOrCreateDmRoom(friendship.sender, friendship.receiver, currentUserId);

  await friendship.populate('sender', userFields.WITH_STATUS);
  await friendship.populate('receiver', userFields.WITH_STATUS);

  // Phát sự kiện room:added cho cả hai người dùng đang online (Sửa lỗi Real-time DM room)
  if (io) {
    const allSockets = await io.fetchSockets();
    const memberIds = [friendship.sender._id.toString(), friendship.receiver._id.toString()];
    const populatedDmRoom = (await Room.findById(dmRoom._id).populate('members', userFields.WITH_STATUS))
      .toObject({ flattenMaps: true });
    populatedDmRoom.members = populatedDmRoom.members.map(maskDmMemberPresence);

    allSockets.forEach(s => {
      if (s.data.user && memberIds.includes(s.data.user._id.toString())) {
        s.join(dmRoom._id.toString());
        s.emit('room:added', populatedDmRoom);
        const isSenderSocket = s.data.user._id.toString() === friendship.sender._id.toString();
        // Người gửi cần receiverId/dmRoomId để tự mở chat mới; người nhận chỉ cần friendshipId để gỡ khỏi danh sách "Lời mời".
        s.emit('friend:request_accepted', isSenderSocket
          ? {
              friendshipId: friendship._id,
              receiverId: friendship.receiver._id,
              receiverNickname: friendship.receiver.nickname || friendship.receiver.username,
              dmRoomId: dmRoom._id,
            }
          : { friendshipId: friendship._id });
      }
    });
  }

  await createNotification(io, { user: friendship.sender._id, type: 'friend_accepted', fromUser: friendship.receiver._id });

  return { friendship, dmRoom };
}

async function rejectFriendRequest(friendshipId, currentUserId, io) {
  const friendship = await Friendship.findOneAndDelete({
    _id: friendshipId,
    receiver: currentUserId,
    status: 'pending',
  });

  if (!friendship) throw new AppError('Không tìm thấy lời mời', 404);

  await notifyFriendshipParties(io, friendship.sender, friendship.receiver,
    'friend:request_rejected', { friendshipId: friendship._id });

  return friendship;
}

async function unfriend(currentUserId, targetUserId, io) {
  const friendship = await Friendship.findOneAndDelete({
    $or: [
      { sender: currentUserId, receiver: targetUserId },
      { sender: targetUserId, receiver: currentUserId },
    ],
    status: 'accepted',
  });

  if (!friendship) throw new AppError('Không tìm thấy quan hệ bạn bè', 404);

  await notifyFriendshipParties(io, friendship.sender, friendship.receiver,
    'friend:unfriended', { friendshipId: friendship._id });

  return friendship;
}

async function cancelRequest(currentUserId, targetUserId, io) {
  const friendship = await Friendship.findOneAndDelete({
    sender: currentUserId,
    receiver: targetUserId,
    status: 'pending',
  });

  if (!friendship) throw new AppError('Không tìm thấy lời mời kết bạn', 404);

  await notifyFriendshipParties(io, friendship.sender, friendship.receiver,
    'friend:request_cancelled', { friendshipId: friendship._id });

  return friendship;
}

async function getDmRoom(currentUserId, targetUserId, io) {
  if (await isBlocked(currentUserId, targetUserId)) throw new AppError('Không thể mở đoạn chat này', 403);
  const friendship = await Friendship.findOne({
    $or: [
      { sender: currentUserId, receiver: targetUserId },
      { sender: targetUserId, receiver: currentUserId },
    ],
    status: 'accepted',
  });
  if (!friendship) throw new AppError('Cần kết bạn mới có thể nhắn tin', 403);

  const { room: dmRoomDoc, created } = await getOrCreateDmRoom(currentUserId, targetUserId, currentUserId);
  await dmRoomDoc.populate('members', userFields.WITH_STATUS);
  const dmRoom = dmRoomDoc.toObject({ flattenMaps: true });
  dmRoom.members = dmRoom.members.map(maskDmMemberPresence);

  // Chỉ cần báo real-time cho ĐỐI PHƯƠNG khi phòng vừa mới tạo — người gọi API này nhận thẳng
  // dmRoom qua response, không cần tự báo lại cho chính mình (giống mẫu ở acceptFriendRequest).
  if (created && io) {
    const allSockets = await io.fetchSockets();
    allSockets.forEach(s => {
      if (s.data.user && s.data.user._id.toString() === targetUserId.toString()) {
        s.join(dmRoom._id.toString());
        s.emit('room:added', dmRoom);
      }
    });
  }

  return dmRoom;
}

async function getProfile(currentId, targetId) {
  const targetUser = await User.findById(targetId).select('-password');
  if (!targetUser) throw new AppError('Không tìm thấy người dùng', 404);

  let friendshipStatus = 'none';
  let friendshipId = null;
  let customAlias = '';
  const block = currentId.toString() !== targetId.toString()
    ? await Block.findOne({ $or: [
      { blocker: currentId, blocked: targetId },
      { blocker: targetId, blocked: currentId },
    ] }).select('blocker').lean()
    : null;
  const blockedByMe = block?.blocker.toString() === currentId.toString();

  if (currentId.toString() === targetId.toString()) {
    friendshipStatus = 'self';
  } else if (!block) {
    const friendship = await Friendship.findOne({
      $or: [
        { sender: currentId, receiver: targetId },
        { sender: targetId, receiver: currentId },
      ],
    });

    if (friendship) {
      friendshipId = friendship._id;
      const isSender = friendship.sender.toString() === currentId.toString();
      customAlias = isSender ? (friendship.senderAlias || '') : (friendship.receiverAlias || '');

      if (friendship.status === 'accepted') {
        friendshipStatus = 'accepted';
      } else if (friendship.status === 'pending') {
        friendshipStatus = isSender ? 'pending_sent' : 'pending_received';
      }
    }
  }

  const currentObjId = new mongoose.Types.ObjectId(currentId);
  const targetObjId = new mongoose.Types.ObjectId(targetId);

  const friendIdSet = await getFriendIdSet(currentId);

  const mutualRoomsDocs = await Room.find({
    isDM: { $ne: true },
    $and: [
      { members: { $in: [currentObjId, currentId.toString()] } },
      { members: { $in: [targetObjId, targetId.toString()] } },
    ],
  })
    .select('name avatar members createdAt')
    .populate('members', userFields.WITH_STATUS_LASTSEEN);

  // Thành viên nhóm chung có thể là người lạ (chưa kết bạn) — mask theo góc nhìn currentId.
  const mutualRooms = mutualRoomsDocs.map(roomDoc => {
    const obj = roomDoc.toObject({ flattenMaps: true });
    obj.members = obj.members.map(m => maskMemberPresence(m, currentId, friendIdSet));
    return obj;
  });

  const isSelf = friendshipStatus === 'self';
  const isFriendOrSelf = friendshipStatus === 'accepted' || isSelf;

  // Bạn chung — giao 2 tập bạn bè, không lộ gì mới với người xem (họ đã biết những người này).
  const targetFriendIdSet = isSelf ? new Set() : await getFriendIdSet(targetId);
  const mutualFriendIds = [...friendIdSet].filter(id => targetFriendIdSet.has(id));
  const mutualFriends = mutualFriendIds.length
    ? await User.find({ _id: { $in: mutualFriendIds.slice(0, 5) } }).select(userFields.BASIC).lean()
    : [];
  // Chỉ 2 mức riêng tư: 'private' (không ai xem, kể cả bạn bè) / 'friends' (bạn bè + chính chủ). Người lạ luôn không xem được.
  const ps = targetUser.privacySettings || {};
  const visible = (level) => level === 'private' ? isSelf : isFriendOrSelf;

  return {
    user: {
      _id: targetUser._id,
      // username KHÔNG trả ra ở đây với bất kỳ ai (kể cả bạn bè) — chỉ dùng nội bộ (login/search),
      // nickname/customAlias mới là danh tính hiển thị công khai trên trang cá nhân.
      nickname: targetUser.nickname,
      avatar: targetUser.avatar,
      cover: targetUser.cover || '',
      // isOnline null = "bị ẩn", tách biệt với false ("thật sự offline") để client không hiển thị nhầm.
      isOnline: visible(ps.activityStatus) ? targetUser.isOnline : null,
      lastSeen: visible(ps.activityStatus) ? targetUser.lastSeen : null,
      createdAt: visible(ps.joinDate) ? targetUser.createdAt : null,
      bio: visible(ps.bio) ? (targetUser.bio || '') : '',
      gender: visible(ps.gender) ? (targetUser.gender || '') : '',
      // decryptPII() thủ công vì object này build tay, không qua User.toJSON() (nơi tự decrypt) như /me.
      dateOfBirth: visible(ps.dateOfBirth) ? decryptPII(targetUser.dateOfBirth) : null,
      email: visible(ps.email) ? decryptPII(targetUser.email) : null,
      phone: visible(ps.phone) ? decryptPII(targetUser.phone) : null,
    },
    friendshipStatus,
    blockedByMe,
    friendshipId,
    customAlias,
    mutualRooms,
    mutualFriendsCount: mutualFriendIds.length,
    mutualFriends,
  };
}

async function blockUser(currentId, targetId, io) {
  if (currentId.toString() === targetId.toString()) throw new AppError('Không thể chặn chính mình', 400);
  if (!await User.exists({ _id: targetId })) throw new AppError('Không tìm thấy người dùng', 404);

  await Block.updateOne({ blocker: currentId, blocked: targetId },
    { $setOnInsert: { blocker: currentId, blocked: targetId } }, { upsert: true });
  const friendship = await Friendship.findOneAndDelete({
    $or: [
      { sender: currentId, receiver: targetId },
      { sender: targetId, receiver: currentId },
    ],
  });
  if (friendship) {
    const event = friendship.status === 'accepted' ? 'friend:unfriended' : 'friend:request_cancelled';
    await notifyFriendshipParties(io, currentId, targetId, event, { friendshipId: friendship._id });
  }
}

async function unblockUser(currentId, targetId) {
  await Block.deleteOne({ blocker: currentId, blocked: targetId });
}

async function listBlocked(currentId, page) {
  const blocks = await Block.find({ blocker: currentId }).sort({ createdAt: -1, _id: -1 })
    .skip((page - 1) * 50).limit(51).populate('blocked', 'nickname avatar').lean();
  return {
    users: blocks.slice(0, 50).filter(entry => entry.blocked).map(entry => entry.blocked),
    hasMore: blocks.length > 50,
  };
}

async function setAlias(currentId, targetId, alias) {
  const friendship = await Friendship.findOne({
    $or: [
      { sender: currentId, receiver: targetId },
      { sender: targetId, receiver: currentId },
    ],
    status: 'accepted',
  });

  if (!friendship) {
    throw new AppError('Chỉ có thể đặt biệt danh cho bạn bè', 400);
  }

  const isSender = friendship.sender.toString() === currentId.toString();
  if (isSender) {
    friendship.senderAlias = (alias || '').trim();
  } else {
    friendship.receiverAlias = (alias || '').trim();
  }

  await friendship.save();

  return isSender ? friendship.senderAlias : friendship.receiverAlias;
}

module.exports = {
  listFriends,
  listPendingRequests,
  searchUsers,
  sendFriendRequest,
  acceptFriendRequest,
  rejectFriendRequest,
  unfriend,
  cancelRequest,
  getDmRoom,
  getProfile,
  setAlias,
  blockUser,
  unblockUser,
  listBlocked,
};
