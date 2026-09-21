const router = require('express').Router();
const { protect } = require('../middleware/auth');
const { uploadRoomAvatar, uploadChatBackground } = require('../config/cloudinary');
const roomsController = require('../controllers/rooms.controller');

// GET /api/rooms — lấy danh sách phòng của user
router.get('/', protect, roomsController.listMyRooms);

// POST /api/rooms — tạo phòng mới
router.post('/', protect, roomsController.createRoom);

// GET /api/rooms/all — lấy tất cả phòng public để tham gia
router.get('/all', protect, roomsController.listPublicRooms);

// GET /api/rooms/:id/messages — lấy tin nhắn của phòng
router.get('/:id/messages', protect, roomsController.getRoomMessages);

// GET /api/rooms/:id/devices — lấy public keys của thành viên hiện tại do server xác định
router.get('/:id/devices', protect, roomsController.getRoomDevices);

// POST /api/rooms/:id/join — tham gia phòng (chỉ phòng công khai — tìm qua /all)
router.post('/:id/join', protect, roomsController.joinPublicRoom);

// GET /api/rooms/invite/:inviteCode — xem trước thông tin phòng qua link/QR mời, chưa cần là thành viên
router.get('/invite/:inviteCode', protect, roomsController.previewInvite);

// POST /api/rooms/invite/:inviteCode — tham gia qua link/QR mời (áp dụng cả phòng riêng tư)
router.post('/invite/:inviteCode', protect, roomsController.joinViaInvite);

// GET /api/rooms/:id/invite-code — lấy link/QR mời hiện hành (mọi thành viên, không lộ qua GET /rooms hay /all)
router.get('/:id/invite-code', protect, roomsController.getInviteCode);

// PUT /api/rooms/:id/rotate-invite — vô hiệu hóa link/QR mời cũ, sinh link mới + gia hạn 7 ngày (chỉ chủ phòng)
router.put('/:id/rotate-invite', protect, roomsController.rotateInviteCode);

// PUT /api/rooms/:id/settings — đổi tên phòng / công khai-riêng tư / cần duyệt hay không (chỉ chủ phòng)
router.put('/:id/settings', protect, roomsController.updateRoomSettings);

// POST /api/rooms/:id/avatar — đổi avatar phòng nhóm (chỉ chủ phòng) — ảnh thường qua Cloudinary,
// không phải nội dung tin nhắn nên không nằm trong vùng E2EE (giống avatar/cover cá nhân)
router.post('/:id/avatar', protect, uploadRoomAvatar.single('avatar'), roomsController.updateRoomAvatar);

// PUT /api/rooms/:id/chat-background — đổi nền khung chat (DM lẫn nhóm, bất kỳ thành viên nào)
router.put('/:id/chat-background', protect, roomsController.updateChatBackground);

// POST /api/rooms/:id/chat-background/image — ảnh nền dùng chung cho toàn phòng.
router.post('/:id/chat-background/image', protect, uploadChatBackground.single('image'), roomsController.updateChatBackgroundImage);

// Attachment E2EE: server chỉ cấp URL R2 tạm thời sau khi kiểm tra thành viên phòng.
router.post('/:id/attachments', protect, roomsController.createAttachmentUpload);
router.post('/:id/attachments/:attachmentId/complete', protect, roomsController.completeAttachmentUpload);
router.get('/:id/attachments/:attachmentId/download-url', protect, roomsController.getAttachmentDownloadUrl);

router.put('/:id/chat-message-color', protect, roomsController.updateChatMessageColor);

// GET /api/rooms/:id/join-requests — danh sách yêu cầu tham gia đang chờ duyệt (chỉ admin/chủ phòng)
router.get('/:id/join-requests', protect, roomsController.listJoinRequests);

// PUT /api/rooms/:id/join-requests/:userId — duyệt yêu cầu tham gia (chỉ admin/chủ phòng)
router.put('/:id/join-requests/:userId', protect, roomsController.approveJoinRequest);

// DELETE /api/rooms/:id/join-requests/:userId — từ chối yêu cầu tham gia (chỉ admin/chủ phòng)
router.delete('/:id/join-requests/:userId', protect, roomsController.rejectJoinRequest);

// ─── Thêm thành viên trực tiếp (đích danh, cần người được mời tự xác nhận) ──

// POST /api/rooms/:id/invites/:userId — admin/chủ phòng thêm thẳng 1 người bạn vào nhóm
router.post('/:id/invites/:userId', protect, roomsController.inviteFriend);

// GET /api/rooms/invites/mine — danh sách lời mời vào nhóm đang chờ mình xác nhận
router.get('/invites/mine', protect, roomsController.listMyPendingInvites);

// PUT /api/rooms/:id/invites/accept — tự chấp nhận lời mời vào nhóm
router.put('/:id/invites/accept', protect, roomsController.acceptInvite);

// DELETE /api/rooms/:id/invites/decline — tự từ chối lời mời vào nhóm
router.delete('/:id/invites/decline', protect, roomsController.declineInvite);

// ─── Sender Key (mã hóa nhóm) ───────────────────────────────────────────────

// POST /api/rooms/:id/sender-key — phân phối/cập nhật Sender Key của 1 thiết bị gửi cho cả phòng
router.post('/:id/sender-key', protect, roomsController.distributeSenderKey);

// GET /api/rooms/:id/sender-key — khôi phục Sender Key khi client cache-miss (vd vừa mở phòng)
router.get('/:id/sender-key', protect, roomsController.getSenderKeyDoc);

// PUT /api/rooms/:id/rotate-key — tăng epoch Sender Key của phòng (buộc mọi thiết bị gửi lại phân phối khóa mới)
router.put('/:id/rotate-key', protect, roomsController.rotateSenderKey);

// POST /api/rooms/:id/leave — tự rời phòng nhóm
router.post('/:id/leave', protect, roomsController.leaveRoom);

// DELETE /api/rooms/:id — hủy phòng (chỉ chủ phòng, xóa hẳn dù còn thành viên khác)
router.delete('/:id', protect, roomsController.deleteRoom);

// DELETE /api/rooms/:id/members/:userId — kick thành viên (chỉ admin)
router.delete('/:id/members/:userId', protect, roomsController.kickMember);

// PUT /api/rooms/:id/admins/:userId — phong quản trị viên phụ (chỉ chủ phòng)
router.put('/:id/admins/:userId', protect, roomsController.promoteAdmin);

// DELETE /api/rooms/:id/admins/:userId — gỡ quyền quản trị viên phụ (chỉ chủ phòng)
router.delete('/:id/admins/:userId', protect, roomsController.demoteAdmin);

// PUT /api/rooms/:id/owner/:userId — chuyển quyền chủ phòng (chỉ chủ phòng hiện tại)
router.put('/:id/owner/:userId', protect, roomsController.transferOwnership);

// PUT/DELETE /api/rooms/:id/permissions/:userId — host cấp/thu hồi quyền lẻ cho thành viên thường
// (vd pin_messages/create_polls — body { permission }).
router.put('/:id/permissions/:userId', protect, roomsController.grantPermission);
router.delete('/:id/permissions/:userId', protect, roomsController.revokePermission);

module.exports = router;
