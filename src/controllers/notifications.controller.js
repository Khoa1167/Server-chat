const notificationsService = require('../services/notifications.service');
const handleError = require('../utils/handleError');

exports.list = async (req, res) => {
  try {
    const notifications = await notificationsService.listNotifications(req.user._id);
    res.json(notifications);
  } catch (err) {
    handleError(res, err);
  }
};

exports.markAllRead = async (req, res) => {
  try {
    await notificationsService.markAllRead(req.user._id);
    res.json({ message: 'Đã đánh dấu đã đọc' });
  } catch (err) {
    handleError(res, err);
  }
};
