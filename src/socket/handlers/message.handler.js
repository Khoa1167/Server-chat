const Message = require('../../models/Message');
const Room = require('../../models/Room');
const User = require('../../models/User');
const roomsListCache = require('../../utils/roomsListCache');
const { hasRoomPermission, ROOM_PERMISSIONS } = require('../../services/rooms.service');
const { checkRateWindow } = require('../../utils/rateLimiter');
const userFields = require('../../utils/publicUserFields');
const sendSocketError = require('../../utils/sendSocketError');
const logger = require('../../config/logger');

// Tin nhắn tự hủy chỉ nhận đúng 4 mốc cho phép — giá trị lạ coi như không đặt TTL, không lỗi.
const DISAPPEARING_TTL_OPTIONS = [60, 3600, 86400, 604800]; // 1 phút / 1 giờ / 24 giờ / 7 ngày

// Chỉ cho thu hồi tin nhắn trong vòng 24h kể từ lúc gửi — giống chính sách phổ biến của các app
// chat khác, tránh việc thu hồi tin đã cũ làm mất ngữ cảnh cuộc trò chuyện cho người khác.
const RECALL_WINDOW_MS = 24 * 60 * 60 * 1000;

// Rate limit: tối đa 8 tin nhắn/5s per userId, cộng dồn mọi socket/tab.
const NS_MESSAGE_SEND = 'message-send';

module.exports = function registerMessageHandlers(io, socket) {
  const userId = socket.user._id;

  socket.on('message:send', async ({ roomId, content, iv, tag, encryptedKeys, type, replyTo, fileName, forwardedFrom, scheme, senderDeviceId, epoch, ttlSeconds }) => {
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

      const room = await Room.findOne({ _id: roomId, members: userId });
      if (!room) return socket.emit('error', { message: 'Không có quyền' });
      if (type === 'poll' && !hasRoomPermission(room, userId, ROOM_PERMISSIONS.CREATE_POLLS)) {
        return socket.emit('error', { message: 'Bạn không có quyền tạo khảo sát trong phòng này' });
      }



      if (forwardedFrom) {
        const originalMsg = await Message.findById(forwardedFrom);
        if (!originalMsg || originalMsg.isDeleted) {
          return socket.emit('error', { message: 'Không thể chuyển tiếp tin nhắn đã bị thu hồi' });
        }
      }

      // Tin nhắn tự hủy: người gửi tự chọn lúc gửi, khóa cứng ngay tại đây — không route/người
      // khác nào sau này đổi lại được (xem ghi chú expires trong Message.js)
      const validTtl = DISAPPEARING_TTL_OPTIONS.includes(ttlSeconds) ? ttlSeconds : null;

      // Zero-Knowledge Relay: Lưu trực tiếp bản mã từ Client
      const msg = await Message.create({
        content: content || '',
        iv: iv || null,
        tag: tag || null,
        encryptedKeys: encryptedKeys || {},
        scheme: scheme || 'rsa-per-device',
        senderDeviceId: senderDeviceId || null,
        epoch: epoch ?? null,
        sender: userId,
        room: roomId,
        type: type || 'text',
        replyTo: replyTo || null,
        fileName: fileName || null,
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

      // Zero-Knowledge Relay: Trả nguyên bản mã cho tất cả client tự giải mã
      // flattenMaps: encryptedKeys là Mongoose Map, JSON.stringify(Map) trả về "{}" nếu không flatten
      const clientMsg = msg.toObject({ flattenMaps: true });
      io.to(roomId).emit('message:new', clientMsg);
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
      const room = await Room.findOne({ _id: msg.room, members: userId }).select('_id');
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
      io.to(msg.room.toString()).emit('message:reacted', {
        messageId, reactions: msg.reactions,
      });
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
      io.to(room._id.toString()).emit('room:pinned_message', {
        roomId: room._id.toString(),
        pinnedMessageId: msg._id.toString(),
      });
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
      io.to(room._id.toString()).emit('room:pinned_message', {
        roomId: room._id.toString(),
        pinnedMessageId: null,
      });
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
      const room = await Room.findOne({ _id: msg.room, members: userId }).select('_id');
      if (!room) throw new Error('Không có quyền');

      const missingKeys = scheme !== 'sender-key' && (!encryptedKeys || Object.keys(encryptedKeys).length === 0);
      if (!content || !iv || !tag || missingKeys) {
        throw new Error('Phiếu bầu phải được mã hóa E2EE');
      }

      msg.pollVotes.set(userId.toString(), {
        content,
        iv,
        tag,
        encryptedKeys: encryptedKeys || {},
        scheme: scheme || 'rsa-per-device',
        senderDeviceId: senderDeviceId || null,
        epoch: epoch ?? null,
      });
      await msg.save();
      io.to(msg.room.toString()).emit('poll:voted', {
        messageId: msg._id.toString(),
        pollVotes: Object.fromEntries(msg.pollVotes),
      });
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
      if (!await Room.exists({ _id: msg.room, members: userId })) {
        return socket.emit('error', { message: 'Không còn quyền truy cập phòng này' });
      }
      if (msg.isDeleted) return socket.emit('error', { message: 'Không thể chỉnh sửa tin nhắn đã bị thu hồi' });
      if (msg.type !== 'text') return socket.emit('error', { message: 'Chỉ có thể chỉnh sửa tin nhắn văn bản' });

      // encryptedKeys rỗng là hợp lệ khi scheme='sender-key' (khóa đã phân phối từ trước, không kèm theo từng tin nhắn)
      const missingKeys = scheme !== 'sender-key' && (!encryptedKeys || Object.keys(encryptedKeys).length === 0);
      if (!content || !iv || !tag || missingKeys) {
        return socket.emit('error', { message: 'Payload chỉnh sửa tin nhắn phải có nội dung được mã hóa E2EE.' });
      }

      msg.content = content;
      msg.iv = iv;
      msg.tag = tag;
      msg.encryptedKeys = encryptedKeys || {};
      msg.scheme = scheme || 'rsa-per-device';
      msg.senderDeviceId = senderDeviceId || null;
      msg.epoch = epoch ?? null;
      msg.isEdited = true;
      await msg.save();

      io.to(msg.room.toString()).emit('message:edited', {
        messageId,
        content,
        iv,
        tag,
        encryptedKeys: msg.encryptedKeys,
        scheme: msg.scheme,
        senderDeviceId: msg.senderDeviceId,
        epoch: msg.epoch,
        isEdited: true
      });
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
      await msg.save();
      io.to(msg.room.toString()).emit('message:deleted', { messageId });

      // msg.save() không đụng Room nên Room model hooks không tự invalidate roomsListCache — tự invalidate nếu tin vừa thu hồi là lastMessage.
      const room = await Room.findById(msg.room).select('members lastMessage pinnedMessage');
      if (room?.pinnedMessage?.toString() === messageId) {
        room.pinnedMessage = null;
        await room.save();
        io.to(msg.room.toString()).emit('room:pinned_message', { roomId: msg.room.toString(), pinnedMessageId: null });
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
