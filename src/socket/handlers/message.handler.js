const Message = require('../../models/Message');
const SenderKeyDistribution = require('../../models/SenderKeyDistribution');
const mongoose = require('mongoose');
const Room = require('../../models/Room');
const Friendship = require('../../models/Friendship');
const User = require('../../models/User');
const roomsListCache = require('../../utils/roomsListCache');
const { hasRoomPermission, ROOM_PERMISSIONS, rotateSenderKeyEpochAfterMessage } = require('../../services/rooms.service');
const { checkRateWindow } = require('../../utils/rateLimiter');
const userFields = require('../../utils/publicUserFields');
const sendSocketError = require('../../utils/sendSocketError');
const logger = require('../../config/logger');
const { claimAttachment, releaseAttachmentClaim, deleteAttachmentForMessage } = require('../../services/attachments.service');
const { queueRoomEvent, pullMailbox, acknowledgeMailbox } = require('../../services/deviceMailbox.service');
const { isBlocked } = require('../../services/blocks.service');

// Tin nhắn tự hủy chỉ nhận đúng 4 mốc cho phép — giá trị lạ coi như không đặt TTL, không lỗi.
const DISAPPEARING_TTL_OPTIONS = [60, 3600, 86400, 604800]; // 1 phút / 1 giờ / 24 giờ / 7 ngày

// Chỉ cho thu hồi tin nhắn trong vòng 24h kể từ lúc gửi — giống chính sách phổ biến của các app
// chat khác, tránh việc thu hồi tin đã cũ làm mất ngữ cảnh cuộc trò chuyện cho người khác.
const RECALL_WINDOW_MS = 24 * 60 * 60 * 1000;

// Rate limit: tối đa 8 tin nhắn/5s per userId, cộng dồn mọi socket/tab.
const NS_MESSAGE_SEND = 'message-send';
const roomSendQueues = new Map();

// ponytail: tuần tự hóa gửi tin theo phòng trong một Socket.IO process để epoch không vượt mốc;
// dùng lease phân tán nếu sau này chạy nhiều process server.
async function acquireRoomSendLock(roomId) {
  const key = String(roomId);
  const previous = roomSendQueues.get(key) || Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  roomSendQueues.set(key, current);
  await previous.catch(() => {});
  return () => {
    release();
    if (roomSendQueues.get(key) === current) roomSendQueues.delete(key);
  };
}

async function assertCurrentSenderKey(room, senderId, currentDeviceId, { scheme, senderDeviceId, epoch }) {
  if (scheme !== 'sender-key' || senderDeviceId !== currentDeviceId || !Number.isSafeInteger(epoch) || epoch < 0 || epoch !== room.senderKeyEpoch) {
    throw new Error('Tin nhắn phải dùng Sender Key của epoch hiện tại');
  }
  const distribution = await SenderKeyDistribution.exists({ room: room._id, epoch, senderDeviceId, senderUser: senderId });
  if (!distribution) throw new Error('Sender Key chưa được phân phối cho thiết bị này');
}

module.exports = function registerMessageHandlers(io, socket) {
  const userId = socket.user._id;

  socket.on('mailbox:pull', async (payload = {}, callback) => {
    try {
      if (typeof payload === 'function') { callback = payload; payload = {}; }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) payload = {};
      const page = await pullMailbox(socket, payload);
      if (callback) callback({ success: true, ...page });
    } catch (err) {
      sendSocketError(socket, err);
      if (callback) callback({ success: false });
    }
  });

  socket.on('mailbox:ack', async ({ id }) => {
    try { await acknowledgeMailbox(socket, id); } catch (err) { logger.error({ err, deviceId: socket.data.deviceId }, 'Lỗi mailbox acknowledgement'); }
  });

  socket.on('message:send', async ({ roomId, content, iv, tag, encryptedKeys, type, replyTo, fileName, attachmentId, forwardedFrom, scheme, senderDeviceId, epoch, ttlSeconds }) => {
    try {
      const uIdStr = userId.toString();
      const msgLimit = await checkRateWindow(NS_MESSAGE_SEND, uIdStr, { maxCount: 8, windowMs: 5000 });

      if (msgLimit.limited) {
        const retryAfter = Math.ceil(msgLimit.retryAfterMs / 1000);
        return socket.emit('error', {
          message: `Bạn đang gửi tin nhắn quá nhanh. Vui lòng thử lại sau ${retryAfter} giây.`,
          code: 'RATE_LIMITED',
          retryAfter
        });
      }

      const releaseRoomSendLock = await acquireRoomSendLock(roomId);
      try {
      const room = await Room.findOne({ _id: roomId, members: userId });
      if (!room) return socket.emit('error', { message: 'Không có quyền' });
      if (room.isDM) {
        const partnerId = room.members.find(id => id.toString() !== uIdStr);
        const allowed = partnerId && !await isBlocked(userId, partnerId) && await Friendship.exists({
          status: 'accepted',
          $or: [
            { sender: userId, receiver: partnerId },
            { sender: partnerId, receiver: userId },
          ],
        });
        if (!allowed) return socket.emit('error', { message: 'Không thể gửi tin nhắn trong đoạn chat này', code: 'DM_NOT_ALLOWED' });
      }
      await assertCurrentSenderKey(room, userId, socket.data.deviceId, { scheme, senderDeviceId, epoch });
      if (type === 'poll' && !hasRoomPermission(room, userId, ROOM_PERMISSIONS.CREATE_POLLS)) {
        return socket.emit('error', { message: 'Bạn không có quyền tạo khảo sát trong phòng này' });
      }



      if (forwardedFrom) {
        const originalMsg = await Message.findById(forwardedFrom).select('isDeleted').lean();
        if (!originalMsg) {
          const isValidId = mongoose.Types.ObjectId.isValid(forwardedFrom);
          const createdAt = isValidId ? new mongoose.Types.ObjectId(forwardedFrom).getTimestamp() : null;
          const isExpiredByRetention = createdAt && (Date.now() - createdAt.getTime() > Message.SERVER_RETENTION_MS);
          if (!isExpiredByRetention) {
            return socket.emit('error', { message: 'Không thể chuyển tiếp tin nhắn đã bị thu hồi' });
          }
        } else if (originalMsg.isDeleted) {
          return socket.emit('error', { message: 'Không thể chuyển tiếp tin nhắn đã bị thu hồi' });
        }
      }

      // Tin nhắn tự hủy: người gửi tự chọn lúc gửi, khóa cứng ngay tại đây — không route/người
      // khác nào sau này đổi lại được (xem ghi chú expires trong Message.js)
      const validTtl = DISAPPEARING_TTL_OPTIONS.includes(ttlSeconds) ? ttlSeconds : null;
      const isAttachment = ['image', 'audio', 'file'].includes(type);
      if (isAttachment !== Boolean(attachmentId)) {
        return socket.emit('error', { message: 'Attachment không hợp lệ' });
      }

      // Zero-Knowledge Relay: Lưu trực tiếp bản mã từ Client
      const messageId = new mongoose.Types.ObjectId();
      let attachment;
      try {
        attachment = await claimAttachment(attachmentId, roomId, userId, messageId);
        const msg = await Message.create({
          _id: messageId,
          content: content || '',
          iv: iv || null,
          tag: tag || null,
          encryptedKeys: {},
          scheme: 'sender-key',
          senderDeviceId,
          epoch,
          sender: userId,
          room: roomId,
          type: type || 'text',
          attachment: attachment?._id || null,
          replyTo: replyTo || null,
          // Tên file nằm trong payload E2EE; không đưa metadata đó vào MongoDB mới.
          fileName: attachment ? null : (fileName || null),
          forwardedFrom: forwardedFrom || null,
          expiresAt: validTtl ? new Date(Date.now() + validTtl * 1000) : null,
        });

        await msg.populate('sender', userFields.BASIC);
        if (replyTo) {
          await msg.populate({
            path: 'replyTo',
            select: 'sender content type fileName isDeleted iv tag encryptedKeys',
            populate: { path: 'sender', select: userFields.BASIC }
          });
        }
        if (forwardedFrom) {
          await msg.populate({
            path: 'forwardedFrom',
            select: 'sender content iv tag encryptedKeys',
            populate: { path: 'sender', select: userFields.MINIMAL }
          });
        }
        await Room.findByIdAndUpdate(roomId, { lastMessage: msg._id });

        const clientMsg = msg.toObject({ flattenMaps: true });
        await queueRoomEvent(io, room.members, socket.data.deviceId, 'message:new', clientMsg);
        io.to(roomId).emit('message:new', clientMsg);
        await rotateSenderKeyEpochAfterMessage(room, epoch, io);
      } catch (err) {
        await releaseAttachmentClaim(attachmentId, messageId).catch(() => {});
        throw err;
      }
      } finally {
        releaseRoomSendLock();
      }
    } catch (err) {
      sendSocketError(socket, err);
    }
  });

  socket.on('typing:start', async ({ roomId }) => {
    try {
      const room = await Room.findOne({ _id: roomId, members: userId }).select('_id');
      if (!room) return;
      socket.to(roomId).emit('typing:start', {
        userId, username: socket.user.nickname || socket.user.username, roomId,
      });
    } catch (err) {
      // roomId client gửi lên không phải ObjectId hợp lệ (Mongoose CastError) hay lỗi DB khác —
      // chỉ log, không sendSocketError: chỉ báo gõ phím, không đáng làm phiền người dùng bằng toast.
      logger.error({ err, userId, roomId }, 'Lỗi typing:start');
    }
  });

  socket.on('typing:stop', async ({ roomId }) => {
    try {
      const room = await Room.findOne({ _id: roomId, members: userId }).select('_id');
      if (!room) return;
      socket.to(roomId).emit('typing:stop', { userId, roomId });
    } catch (err) {
      logger.error({ err, userId, roomId }, 'Lỗi typing:stop');
    }
  });

  // Client tự báo sau khi giải mã xong — nguồn cho unread + "Đã xem" DM.
  socket.on('room:read', async ({ roomId }) => {
    try {
      const room = await Room.findOne({ _id: roomId, members: userId });
      if (!room) return;

      const uidStr = userId.toString();
      const readAt = new Date();
      room.lastReadAt.set(uidStr, readAt);
      await room.save();

      // Echo lại cho chính người đọc — không lộ gì mới với chính họ, dùng để Sidebar biết đã giải mã xong.
      socket.emit('room:read', { roomId, userId: uidStr, readAt });

      // Đọc lại từ DB thay vì tin socket.user (cache lúc connect, đổi setting giữa chừng không cập nhật).
      const reader = await User.findById(userId).select('privacySettings.readReceipts');
      if (reader?.privacySettings?.readReceipts !== 'private') {
        socket.to(roomId).emit('room:read', { roomId, userId: uidStr, readAt });
      }
    } catch (err) {
      logger.error({ err, userId, roomId }, 'Lỗi room:read');
    }
  });

  socket.on('message:react', async ({ messageId, emoji }) => {
    try {
      const msg = await Message.findById(messageId);
      if (!msg) return;
      const room = await Room.findOne({ _id: msg.room, members: userId }).select('_id members');
      if (!room) return socket.emit('error', { message: 'Không có quyền' });

      // Mỗi người chỉ giữ tối đa 1 emoji/tin nhắn — gỡ khỏi nhóm emoji cũ (nếu có) trước khi
      // xử lý. Bấm lại đúng emoji đang giữ = bỏ react; bấm emoji khác = chuyển sang emoji đó.
      const prevIdx = msg.reactions.findIndex(r => r.users.some(u => u.toString() === userId.toString()));
      const hadSameEmoji = prevIdx > -1 && msg.reactions[prevIdx].emoji === emoji;
      if (prevIdx > -1) {
        msg.reactions[prevIdx].users = msg.reactions[prevIdx].users.filter(u => u.toString() !== userId.toString());
        if (msg.reactions[prevIdx].users.length === 0) msg.reactions.splice(prevIdx, 1);
      }

      if (!hadSameEmoji) {
        const idx = msg.reactions.findIndex(r => r.emoji === emoji);
        if (idx > -1) msg.reactions[idx].users.push(userId);
        else msg.reactions.push({ emoji, users: [userId] });
      }

      await msg.save();
      await msg.populate('reactions.users', userFields.MINIMAL);
      const payload = {
        messageId, reactions: msg.reactions,
        roomId: msg.room.toString(),
      };
      await queueRoomEvent(io, room.members, socket.data.deviceId, 'message:reacted', payload);
      io.to(msg.room.toString()).emit('message:reacted', payload);
    } catch (err) {
      sendSocketError(socket, err);
    }
  });

  socket.on('room:pin_message', async ({ messageId }, callback) => {
    try {
      const msg = await Message.findById(messageId).select('room isDeleted');
      if (!msg || msg.isDeleted) throw new Error('Không thể ghim tin nhắn đã bị thu hồi');

      const room = await Room.findOne({ _id: msg.room, members: userId });
      if (!room) throw new Error('Không có quyền');
      if (!hasRoomPermission(room, userId, ROOM_PERMISSIONS.PIN_MESSAGES)) {
        throw new Error('Bạn không có quyền ghim tin nhắn trong phòng này');
      }

      room.pinnedMessage = msg._id;
      await room.save();
      const payload = {
        roomId: room._id.toString(),
        pinnedMessageId: msg._id.toString(),
      };
      await queueRoomEvent(io, room.members, socket.data.deviceId, 'room:pinned_message', payload);
      io.to(room._id.toString()).emit('room:pinned_message', payload);
      if (callback) callback({ success: true });
    } catch (err) {
      if (callback) callback({ success: false, message: err.message || 'Không thể ghim tin nhắn' });
      else sendSocketError(socket, err);
    }
  });

  socket.on('room:unpin_message', async ({ roomId }, callback) => {
    try {
      const room = await Room.findOne({ _id: roomId, members: userId });
      if (!room) throw new Error('Không có quyền');
      if (!hasRoomPermission(room, userId, ROOM_PERMISSIONS.PIN_MESSAGES)) {
        throw new Error('Bạn không có quyền bỏ ghim tin nhắn trong phòng này');
      }

      room.pinnedMessage = null;
      await room.save();
      const payload = {
        roomId: room._id.toString(),
        pinnedMessageId: null,
      };
      await queueRoomEvent(io, room.members, socket.data.deviceId, 'room:pinned_message', payload);
      io.to(room._id.toString()).emit('room:pinned_message', payload);
      if (callback) callback({ success: true });
    } catch (err) {
      if (callback) callback({ success: false, message: err.message || 'Không thể bỏ ghim tin nhắn' });
      else sendSocketError(socket, err);
    }
  });

  socket.on('poll:vote', async ({ messageId, content, iv, tag, encryptedKeys, scheme, senderDeviceId, epoch }, callback) => {
    try {
      const msg = await Message.findOne({ _id: messageId, type: 'poll', isDeleted: false });
      if (!msg) throw new Error('Không tìm thấy khảo sát');
      const room = await Room.findOne({ _id: msg.room, members: userId }).select('_id members senderKeyEpoch');
      if (!room) throw new Error('Không có quyền');
      await assertCurrentSenderKey(room, userId, socket.data.deviceId, { scheme, senderDeviceId, epoch });
      if (!content || !iv || !tag) {
        throw new Error('Phiếu bầu phải được mã hóa E2EE');
      }

      msg.pollVotes.set(userId.toString(), {
        content,
        iv,
        tag,
        encryptedKeys: {},
        scheme: 'sender-key',
        senderDeviceId,
        epoch,
      });
      await msg.save();
      const payload = {
        messageId: msg._id.toString(),
        pollVotes: Object.fromEntries(msg.pollVotes),
        roomId: msg.room.toString(),
      };
      await queueRoomEvent(io, room.members, socket.data.deviceId, 'poll:voted', payload);
      io.to(msg.room.toString()).emit('poll:voted', payload);
      if (callback) callback({ success: true });
    } catch (err) {
      if (callback) callback({ success: false, message: err.message || 'Không thể bỏ phiếu' });
      else sendSocketError(socket, err);
    }
  });

  socket.on('message:edit', async ({ messageId, content, iv, tag, encryptedKeys, scheme, senderDeviceId, epoch }) => {
    try {
      const msg = await Message.findOne({ _id: messageId, sender: userId });
      if (!msg) return socket.emit('error', { message: 'Không có quyền chỉnh sửa tin nhắn này' });
      const room = await Room.findOne({ _id: msg.room, members: userId }).select('_id members senderKeyEpoch');
      if (!room) {
        return socket.emit('error', { message: 'Không còn quyền truy cập phòng này' });
      }
      if (msg.isDeleted) return socket.emit('error', { message: 'Không thể chỉnh sửa tin nhắn đã bị thu hồi' });
      if (msg.type !== 'text') return socket.emit('error', { message: 'Chỉ có thể chỉnh sửa tin nhắn văn bản' });

      await assertCurrentSenderKey(room, userId, socket.data.deviceId, { scheme, senderDeviceId, epoch });
      if (!content || !iv || !tag) {
        return socket.emit('error', { message: 'Payload chỉnh sửa tin nhắn phải có nội dung được mã hóa E2EE.' });
      }

      msg.content = content;
      msg.iv = iv;
      msg.tag = tag;
      msg.encryptedKeys = {};
      msg.scheme = 'sender-key';
      msg.senderDeviceId = senderDeviceId;
      msg.epoch = epoch;
      msg.isEdited = true;
      await msg.save();

      const payload = {
        messageId,
        roomId: msg.room.toString(),
        content,
        iv,
        tag,
        encryptedKeys: msg.encryptedKeys,
        scheme: msg.scheme,
        senderDeviceId: msg.senderDeviceId,
        epoch: msg.epoch,
        isEdited: true
      };
      await queueRoomEvent(io, room.members, socket.data.deviceId, 'message:edited', payload);
      io.to(msg.room.toString()).emit('message:edited', payload);
    } catch (err) {
      sendSocketError(socket, err);
    }
  });

  socket.on('message:delete', async ({ messageId }, callback) => {
    try {
      const msg = await Message.findOne({ _id: messageId, sender: userId });
      if (!msg) {
        socket.emit('error', { message: 'Không có quyền' });
        if (callback) callback({ success: false, message: 'Không có quyền' });
        return;
      }
      if (!await Room.exists({ _id: msg.room, members: userId })) {
        const message = 'Không còn quyền truy cập phòng này';
        socket.emit('error', { message });
        if (callback) callback({ success: false, message });
        return;
      }

      if (Date.now() - new Date(msg.createdAt).getTime() > RECALL_WINDOW_MS) {
        if (callback) callback({ success: false, message: 'Chỉ có thể thu hồi tin nhắn trong vòng 24 giờ sau khi gửi' });
        return;
      }

      msg.isDeleted = true;
      msg.content = 'Tin nhắn đã bị thu hồi';
      msg.iv = null;
      msg.tag = null;
      msg.fileName = null;
      await deleteAttachmentForMessage(msg._id);
      msg.attachment = null;
      await msg.save();
      const deletedPayload = { messageId, roomId: msg.room.toString() };
      const memberRoom = await Room.findById(msg.room).select('members lastMessage pinnedMessage');
      await queueRoomEvent(io, memberRoom.members, socket.data.deviceId, 'message:deleted', deletedPayload);
      io.to(msg.room.toString()).emit('message:deleted', deletedPayload);

      // msg.save() không đụng Room nên Room model hooks không tự invalidate roomsListCache — tự invalidate nếu tin vừa thu hồi là lastMessage.
      const room = memberRoom;
      if (room?.pinnedMessage?.toString() === messageId) {
        room.pinnedMessage = null;
        await room.save();
        const pinnedPayload = { roomId: msg.room.toString(), pinnedMessageId: null };
        await queueRoomEvent(io, room.members, socket.data.deviceId, 'room:pinned_message', pinnedPayload);
        io.to(msg.room.toString()).emit('room:pinned_message', pinnedPayload);
      }
      if (room?.lastMessage?.toString() === messageId) {
        room.members.forEach(id => roomsListCache.invalidate(id).catch(() => {}));
      }

      if (callback) callback({ success: true });
    } catch (err) {
      sendSocketError(socket, err);
      if (callback) callback({ success: false, message: 'Lỗi hệ thống khi thu hồi tin nhắn' });
    }
  });
};
