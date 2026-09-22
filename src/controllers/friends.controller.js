const mongoose = require('mongoose');
const friendsService = require('../services/friends.service');
const handleError = require('../utils/handleError');
const { checkRateWindow } = require('../utils/rateLimiter');

const NS_FRIEND_REQUEST = 'friend-request';
const NS_BLOCK = 'user-block';

exports.listFriends = async (req, res) => {
  try {
    const friends = await friendsService.listFriends(req.user._id);
    res.json(friends);
  } catch (err) {
    handleError(res, err);
  }
};

exports.listPendingRequests = async (req, res) => {
  try {
    const requests = await friendsService.listPendingRequests(req.user._id);
    res.json(requests);
  } catch (err) {
    handleError(res, err);
  }
};

exports.searchUsers = async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.trim().length < 2) {
      return res.status(400).json({ message: 'Nhập ít nhất 2 ký tự' });
    }

    const results = await friendsService.searchUsers(req.user._id, q);
    res.json(results);
  } catch (err) {
    handleError(res, err);
  }
};

exports.sendFriendRequest = async (req, res) => {
  try {
    const receiverId = req.params.userId;
    if (!mongoose.Types.ObjectId.isValid(receiverId)) {
      return res.status(400).json({ message: 'ID người dùng không hợp lệ' });
    }

    const { limited } = await checkRateWindow(NS_FRIEND_REQUEST, req.user._id.toString(), { maxCount: 20, windowMs: 5 * 60 * 1000 });
    if (limited) return res.status(429).json({ message: 'Thao tác quá nhanh, thử lại sau' });

    const io = req.app.get('socketio');
    const { friendship, isNew } = await friendsService.sendFriendRequest(req.user._id, receiverId, io);
    res.status(isNew ? 201 : 200).json(friendship);
  } catch (err) {
    handleError(res, err);
  }
};

exports.acceptFriendRequest = async (req, res) => {
  try {
    const io = req.app.get('socketio');
    const result = await friendsService.acceptFriendRequest(req.params.friendshipId, req.user._id, io);
    res.json(result);
  } catch (err) {
    handleError(res, err);
  }
};

exports.rejectFriendRequest = async (req, res) => {
  try {
    const io = req.app.get('socketio');
    await friendsService.rejectFriendRequest(req.params.friendshipId, req.user._id, io);
    res.json({ message: 'Đã từ chối lời mời kết bạn' });
  } catch (err) {
    handleError(res, err);
  }
};

exports.unfriend = async (req, res) => {
  try {
    const io = req.app.get('socketio');
    await friendsService.unfriend(req.user._id, req.params.userId, io);
    res.json({ message: 'Đã hủy kết bạn thành công' });
  } catch (err) {
    handleError(res, err);
  }
};

exports.cancelRequest = async (req, res) => {
  try {
    const io = req.app.get('socketio');
    await friendsService.cancelRequest(req.user._id, req.params.userId, io);
    res.json({ message: 'Đã hủy lời mời kết bạn' });
  } catch (err) {
    handleError(res, err);
  }
};

exports.getDmRoom = async (req, res) => {
  try {
    const io = req.app.get('socketio');
    const dmRoom = await friendsService.getDmRoom(req.user._id, req.params.userId, io);
    res.json(dmRoom);
  } catch (err) {
    handleError(res, err);
  }
};

exports.getProfile = async (req, res) => {
  try {
    const targetId = req.params.userId;
    if (!mongoose.Types.ObjectId.isValid(targetId)) {
      return res.status(400).json({ message: 'ID người dùng không hợp lệ' });
    }

    const profile = await friendsService.getProfile(req.user._id, targetId);
    res.json(profile);
  } catch (err) {
    handleError(res, err);
  }
};

exports.setAlias = async (req, res) => {
  try {
    const customAlias = await friendsService.setAlias(req.user._id, req.params.userId, req.body.alias);
    res.json({ message: 'Cập nhật biệt danh thành công', customAlias });
  } catch (err) {
    handleError(res, err);
  }
};

exports.listBlocked = async (req, res) => {
  try {
    const page = Number(req.query.page || 1);
    if (!Number.isSafeInteger(page) || page < 1 || page > 1000) return res.status(400).json({ message: 'Trang không hợp lệ' });
    res.json(await friendsService.listBlocked(req.user._id, page));
  } catch (err) {
    handleError(res, err);
  }
};

exports.listBlockedIds = async (req, res) => {
  try {
    res.json({ ids: await friendsService.listBlockedIds(req.user._id) });
  } catch (err) {
    handleError(res, err);
  }
};

exports.blockUser = async (req, res) => {
  try {
    const targetId = req.params.userId;
    if (!mongoose.Types.ObjectId.isValid(targetId)) return res.status(400).json({ message: 'ID người dùng không hợp lệ' });
    const { limited } = await checkRateWindow(NS_BLOCK, req.user._id.toString(), { maxCount: 20, windowMs: 5 * 60 * 1000 });
    if (limited) return res.status(429).json({ message: 'Thao tác quá nhanh, thử lại sau' });
    await friendsService.blockUser(req.user._id, targetId, req.app.get('socketio'));
    res.json({ message: 'Đã chặn người dùng' });
  } catch (err) {
    handleError(res, err);
  }
};

exports.unblockUser = async (req, res) => {
  try {
    const targetId = req.params.userId;
    if (!mongoose.Types.ObjectId.isValid(targetId)) return res.status(400).json({ message: 'ID người dùng không hợp lệ' });
    const { limited } = await checkRateWindow(NS_BLOCK, req.user._id.toString(), { maxCount: 20, windowMs: 5 * 60 * 1000 });
    if (limited) return res.status(429).json({ message: 'Thao tác quá nhanh, thử lại sau' });
    await friendsService.unblockUser(req.user._id, targetId);
    res.json({ message: 'Đã bỏ chặn người dùng' });
  } catch (err) {
    handleError(res, err);
  }
};
