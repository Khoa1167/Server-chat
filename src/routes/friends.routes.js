const router = require('express').Router();
const { protect } = require('../middleware/auth');
const friendsController = require('../controllers/friends.controller');

// GET /api/friends — lấy danh sách bạn bè
router.get('/', protect, friendsController.listFriends);

// GET /api/friends/requests — lấy lời mời kết bạn đang chờ
router.get('/requests', protect, friendsController.listPendingRequests);

// GET /api/friends/search?q=keyword — tìm kiếm user
router.get('/search', protect, friendsController.searchUsers);

router.get('/blocked', protect, friendsController.listBlocked);
router.get('/blocked/ids', protect, friendsController.listBlockedIds);
router.post('/block/:userId', protect, friendsController.blockUser);
router.delete('/block/:userId', protect, friendsController.unblockUser);

// POST /api/friends/request/:userId — gửi lời mời kết bạn
router.post('/request/:userId', protect, friendsController.sendFriendRequest);

// PUT /api/friends/accept/:friendshipId — chấp nhận lời mời
router.put('/accept/:friendshipId', protect, friendsController.acceptFriendRequest);

// PUT /api/friends/reject/:friendshipId — từ chối lời mời
router.put('/reject/:friendshipId', protect, friendsController.rejectFriendRequest);

// DELETE /api/friends/unfriend/:userId — hủy kết bạn với user
router.delete('/unfriend/:userId', protect, friendsController.unfriend);

// DELETE /api/friends/cancel/:userId — hủy lời mời kết bạn đã gửi
router.delete('/cancel/:userId', protect, friendsController.cancelRequest);

// GET /api/friends/dm/:userId — lấy phòng DM với user
router.get('/dm/:userId', protect, friendsController.getDmRoom);

// GET /api/friends/profile/:userId — lấy thông tin profile của user khác
router.get('/profile/:userId', protect, friendsController.getProfile);

// PUT /api/friends/alias/:userId — đặt biệt danh riêng cho bạn bè
router.put('/alias/:userId', protect, friendsController.setAlias);

module.exports = router;
