const adminService = require('../services/admin.service');
const handleError = require('../utils/handleError');

exports.listUsers = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const result = await adminService.listUsers({ q: req.query.q, page });
    res.json(result);
  } catch (err) {
    handleError(res, err);
  }
};

exports.banUser = async (req, res) => {
  try {
    const target = await adminService.banUser(req.params.id, req.user._id.toString());
    res.json({ message: 'Đã khóa tài khoản', user: target });
  } catch (err) {
    handleError(res, err);
  }
};

exports.unbanUser = async (req, res) => {
  try {
    const target = await adminService.unbanUser(req.params.id);
    res.json({ message: 'Đã mở khóa tài khoản', user: target });
  } catch (err) {
    handleError(res, err);
  }
};
