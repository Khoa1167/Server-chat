const roomsService = require('../services/rooms.service');
const uploadService = require('../services/upload.service');
const handleError = require('../utils/handleError');
const { checkRateWindow } = require('../utils/rateLimiter');

const NS_ROOM_INVITE = 'room-invite';
const NS_ROOM_UPLOAD = 'room-upload';
const NS_ROOM_CREATE = 'room-create';

exports.listMyRooms = async (req, res) => {
  try {
    res.json(await roomsService.listMyRooms(req.user._id));
  } catch (err) {
    handleError(res, err);
  }
};

exports.createRoom = async (req, res) => {
  try {
    const { limited } = await checkRateWindow(NS_ROOM_CREATE, req.user._id.toString(), { maxCount: 10, windowMs: 10 * 60 * 1000 });
    if (limited) return res.status(429).json({ message: 'Thao tác quá nhanh, thử lại sau' });

    const { name, description, isPrivate, joinPolicy, members } = req.body;
    const io = req.app.get('socketio');
    const room = await roomsService.createRoom({ name, description, isPrivate, joinPolicy, members }, req.user._id, io);
    res.status(201).json(room);
  } catch (err) {
    handleError(res, err);
  }
};

exports.listPublicRooms = async (req, res) => {
  try {
    res.json(await roomsService.listPublicRooms(req.user._id));
  } catch (err) {
    handleError(res, err);
  }
};

exports.getRoomMessages = async (req, res) => {
  try {
    const { before, limit } = req.query;
    const messages = await roomsService.getRoomMessages(req.params.id, req.user._id, { before, limit: limit || 30 });
    res.json(messages);
  } catch (err) {
    handleError(res, err);
  }
};

exports.joinPublicRoom = async (req, res) => {
  try {
    const io = req.app.get('socketio');
    res.json(await roomsService.joinPublicRoom(req.params.id, req.user, io));
  } catch (err) {
    handleError(res, err);
  }
};

exports.previewInvite = async (req, res) => {
  try {
    const { limited } = await checkRateWindow(NS_ROOM_INVITE, req.user._id.toString(), { maxCount: 20, windowMs: 5 * 60 * 1000 });
    if (limited) return res.status(429).json({ message: 'Thao tác quá nhanh, thử lại sau' });

    res.json(await roomsService.previewInvite(req.params.inviteCode, req.user._id));
  } catch (err) {
    handleError(res, err);
  }
};

exports.joinViaInvite = async (req, res) => {
  try {
    const { limited } = await checkRateWindow(NS_ROOM_INVITE, req.user._id.toString(), { maxCount: 20, windowMs: 5 * 60 * 1000 });
    if (limited) return res.status(429).json({ message: 'Thao tác quá nhanh, thử lại sau' });

    const io = req.app.get('socketio');
    res.json(await roomsService.joinViaInvite(req.params.inviteCode, req.user, io));
  } catch (err) {
    handleError(res, err);
  }
};

exports.getInviteCode = async (req, res) => {
  try {
    res.json(await roomsService.getInviteCode(req.params.id, req.user._id));
  } catch (err) {
    handleError(res, err);
  }
};

exports.rotateInviteCode = async (req, res) => {
  try {
    res.json(await roomsService.rotateInviteCode(req.params.id, req.user._id));
  } catch (err) {
    handleError(res, err);
  }
};

exports.updateRoomSettings = async (req, res) => {
  try {
    const io = req.app.get('socketio');
    const { name, isPrivate, joinPolicy } = req.body;
    res.json(await roomsService.updateRoomSettings(req.params.id, req.user._id, { name, isPrivate, joinPolicy }, io));
  } catch (err) {
    handleError(res, err);
  }
};

exports.updateRoomAvatar = async (req, res) => {
  try {
    const io = req.app.get('socketio');
    res.json(await roomsService.updateRoomAvatar(req.params.id, req.user._id, req.file, io));
  } catch (err) {
    handleError(res, err);
  }
};

exports.updateChatBackground = async (req, res) => {
  try {
    const io = req.app.get('socketio');
    res.json(await roomsService.updateChatBackground(req.params.id, req.user._id, req.body.chatBackground, io));
  } catch (err) {
    handleError(res, err);
  }
};

exports.updateChatBackgroundImage = async (req, res) => {
  try {
    const io = req.app.get('socketio');
    res.json(await roomsService.updateChatBackgroundImage(req.params.id, req.user._id, req.file, io));
  } catch (err) {
    handleError(res, err);
  }
};

exports.updateChatMessageColor = async (req, res) => {
  try {
    const io = req.app.get('socketio');
    res.json(await roomsService.updateChatMessageColor(req.params.id, req.user._id, req.body.chatMessageColor, io));
  } catch (err) {
    handleError(res, err);
  }
};

exports.listJoinRequests = async (req, res) => {
  try {
    res.json(await roomsService.listJoinRequests(req.params.id, req.user._id));
  } catch (err) {
    handleError(res, err);
  }
};

exports.approveJoinRequest = async (req, res) => {
  try {
    const io = req.app.get('socketio');
    await roomsService.approveJoinRequest(req.params.id, req.user._id, req.params.userId, io);
    res.json({ message: 'Đã duyệt yêu cầu tham gia' });
  } catch (err) {
    handleError(res, err);
  }
};

exports.rejectJoinRequest = async (req, res) => {
  try {
    const io = req.app.get('socketio');
    await roomsService.rejectJoinRequest(req.params.id, req.user._id, req.params.userId, io);
    res.json({ message: 'Đã từ chối yêu cầu tham gia' });
  } catch (err) {
    handleError(res, err);
  }
};

exports.inviteFriend = async (req, res) => {
  try {
    const io = req.app.get('socketio');
    await roomsService.inviteFriend(req.params.id, req.user, req.params.userId, io);
    res.status(201).json({ message: 'Đã gửi lời mời' });
  } catch (err) {
    handleError(res, err);
  }
};

exports.listMyPendingInvites = async (req, res) => {
  try {
    res.json(await roomsService.listMyPendingInvites(req.user._id));
  } catch (err) {
    handleError(res, err);
  }
};

exports.acceptInvite = async (req, res) => {
  try {
    const io = req.app.get('socketio');
    const room = await roomsService.acceptInvite(req.params.id, req.user, io);
    res.json({ message: 'Đã tham gia nhóm', room });
  } catch (err) {
    handleError(res, err);
  }
};

exports.declineInvite = async (req, res) => {
  try {
    await roomsService.declineInvite(req.params.id, req.user._id);
    res.json({ message: 'Đã từ chối lời mời' });
  } catch (err) {
    handleError(res, err);
  }
};

exports.distributeSenderKey = async (req, res) => {
  try {
    const io = req.app.get('socketio');
    const { epoch, senderDeviceId, encryptedKeys } = req.body;
    const doc = await roomsService.distributeSenderKey(req.params.id, req.user, { epoch, senderDeviceId, encryptedKeys }, io);
    res.status(201).json(doc);
  } catch (err) {
    handleError(res, err);
  }
};

exports.getSenderKeyDoc = async (req, res) => {
  try {
    const { epoch, senderDeviceId } = req.query;
    res.json(await roomsService.getSenderKeyDoc(req.params.id, req.user._id, { epoch, senderDeviceId }));
  } catch (err) {
    handleError(res, err);
  }
};

exports.rotateSenderKey = async (req, res) => {
  try {
    const io = req.app.get('socketio');
    res.json(await roomsService.rotateSenderKey(req.params.id, req.user._id, io));
  } catch (err) {
    handleError(res, err);
  }
};

exports.leaveRoom = async (req, res) => {
  try {
    const io = req.app.get('socketio');
    await roomsService.leaveRoom(req.params.id, req.user._id, req.body.newOwnerId, io);
    res.json({ message: 'Đã rời khỏi nhóm' });
  } catch (err) {
    handleError(res, err);
  }
};

exports.deleteRoom = async (req, res) => {
  try {
    const io = req.app.get('socketio');
    await roomsService.deleteRoom(req.params.id, req.user._id, io);
    res.json({ message: 'Đã hủy phòng' });
  } catch (err) {
    handleError(res, err);
  }
};

exports.kickMember = async (req, res) => {
  try {
    const io = req.app.get('socketio');
    await roomsService.kickMember(req.params.id, req.user._id, req.params.userId, io);
    res.json({ message: 'Đã xóa thành viên khỏi nhóm' });
  } catch (err) {
    handleError(res, err);
  }
};

exports.promoteAdmin = async (req, res) => {
  try {
    const io = req.app.get('socketio');
    await roomsService.promoteAdmin(req.params.id, req.user._id, req.params.userId, io);
    res.json({ message: 'Đã phong quản trị viên' });
  } catch (err) {
    handleError(res, err);
  }
};

exports.demoteAdmin = async (req, res) => {
  try {
    const io = req.app.get('socketio');
    await roomsService.demoteAdmin(req.params.id, req.user._id, req.params.userId, io);
    res.json({ message: 'Đã gỡ quyền quản trị viên' });
  } catch (err) {
    handleError(res, err);
  }
};

exports.transferOwnership = async (req, res) => {
  try {
    const io = req.app.get('socketio');
    await roomsService.transferOwnership(req.params.id, req.user._id, req.params.userId, io);
    res.json({ message: 'Đã chuyển quyền chủ phòng' });
  } catch (err) {
    handleError(res, err);
  }
};

exports.grantPermission = async (req, res) => {
  try {
    const io = req.app.get('socketio');
    await roomsService.grantPermission(req.params.id, req.user._id, req.params.userId, req.body.permission, io);
    res.json({ message: 'Đã cấp quyền' });
  } catch (err) {
    handleError(res, err);
  }
};

exports.revokePermission = async (req, res) => {
  try {
    const io = req.app.get('socketio');
    await roomsService.revokePermission(req.params.id, req.user._id, req.params.userId, req.body.permission, io);
    res.json({ message: 'Đã thu hồi quyền' });
  } catch (err) {
    handleError(res, err);
  }
};

exports.uploadAudio = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'Không tìm thấy tệp âm thanh' });
    const { limited } = await checkRateWindow(NS_ROOM_UPLOAD, req.user._id.toString(), { maxCount: 30, windowMs: 5 * 60 * 1000 });
    if (limited) return res.status(429).json({ message: 'Thao tác quá nhanh, thử lại sau' });

    const result = await uploadService.uploadToCloudinary(req.file.buffer, 'chat-app/audios');
    res.json({ url: result.secure_url });
  } catch (err) {
    handleError(res, err);
  }
};

exports.uploadImage = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'Không tìm thấy tệp hình ảnh' });
    const { limited } = await checkRateWindow(NS_ROOM_UPLOAD, req.user._id.toString(), { maxCount: 30, windowMs: 5 * 60 * 1000 });
    if (limited) return res.status(429).json({ message: 'Thao tác quá nhanh, thử lại sau' });

    const result = await uploadService.uploadToCloudinary(req.file.buffer, 'chat-app/images');
    res.json({ url: result.secure_url });
  } catch (err) {
    handleError(res, err);
  }
};

exports.uploadFile = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'Không tìm thấy tệp tin' });
    const { limited } = await checkRateWindow(NS_ROOM_UPLOAD, req.user._id.toString(), { maxCount: 30, windowMs: 5 * 60 * 1000 });
    if (limited) return res.status(429).json({ message: 'Thao tác quá nhanh, thử lại sau' });

    const result = await uploadService.uploadToCloudinary(req.file.buffer, 'chat-app/files');
    res.json({ url: result.secure_url });
  } catch (err) {
    handleError(res, err);
  }
};
