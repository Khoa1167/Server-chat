// Ẩn isOnline/lastSeen theo privacySettings.activityStatus của chính chủ — dùng chung cho mọi nơi
// trả user kèm trạng thái hoạt động. 2 mức: 'private' (không ai thấy) / 'friends' (bạn bè thấy).
const Friendship = require('../models/Friendship');

// Set userId đang là bạn bè accepted với viewerId — tính 1 lần, tái dùng khi mask hàng loạt.
async function getFriendIdSet(viewerId) {
  const viewerStr = viewerId.toString();
  const friendships = await Friendship.find({
    $or: [{ sender: viewerId }, { receiver: viewerId }],
    status: 'accepted',
  }).select('sender receiver');

  const ids = new Set();
  friendships.forEach(f => {
    ids.add(f.sender.toString() === viewerStr ? f.receiver.toString() : f.sender.toString());
  });
  return ids;
}

// member cần có sẵn 'privacySettings.activityStatus' (xem WITH_STATUS) mới đọc được — thiếu thì coi 'friends'.
function maskMemberPresence(member, viewerId, friendIdSet) {
  const obj = member.toObject ? member.toObject() : { ...member };
  const memberId = obj._id.toString();
  const isSelf = memberId === viewerId.toString();
  const isFriend = isSelf || friendIdSet.has(memberId);
  const level = obj.privacySettings?.activityStatus || 'friends';
  const visible = level === 'private' ? isSelf : isFriend;

  if (!visible) {
    obj.isOnline = null;
    obj.lastSeen = null;
  }
  delete obj.privacySettings;
  return obj;
}

// Mốc đối phương đọc gần nhất trong phòng DM (null nếu không đủ điều kiện hiện — private/không phải bạn bè).
function getDmPartnerReadAt(obj, viewerId, friendIdSet) {
  if (!obj.isDM || !Array.isArray(obj.members)) return null;
  const viewerStr = viewerId.toString();
  const partner = (obj.members || []).find(m => (m.toObject ? m.toObject() : m)._id.toString() !== viewerStr);
  if (!partner) return null;
  const partnerIdStr = partner._id.toString();
  const level = partner.privacySettings?.readReceipts || 'friends';
  if (level === 'private' || !friendIdSet.has(partnerIdStr)) return null;
  return obj.lastReadAt?.[partnerIdStr] || null;
}

// Áp maskMemberPresence cho toàn bộ room.members theo góc nhìn viewerId.
function maskRoomMembersPresence(room, viewerId, friendIdSet) {
  const obj = room.toObject ? room.toObject({ flattenMaps: true }) : { ...room };
  obj.partnerReadAt = getDmPartnerReadAt(obj, viewerId, friendIdSet);
  obj.members = (obj.members || []).map(m => maskMemberPresence(m, viewerId, friendIdSet));
  // Chỉ dùng nội bộ lọc lịch sử tin nhắn/tính read-receipt — không lộ ra payload client.
  delete obj.memberJoinedAt;
  delete obj.lastReadAt;
  return obj;
}

// Payload dùng chung cho cả 2 người trong DM (không cá nhân hóa) — DM chỉ giữa bạn bè nên chỉ
// 'private' mới ẩn.
function maskDmMemberPresence(member) {
  const obj = member.toObject ? member.toObject() : { ...member };
  if (obj.privacySettings?.activityStatus === 'private') {
    obj.isOnline = null;
    obj.lastSeen = null;
  }
  delete obj.privacySettings;
  return obj;
}

module.exports = { getFriendIdSet, maskMemberPresence, maskRoomMembersPresence, maskDmMemberPresence };
