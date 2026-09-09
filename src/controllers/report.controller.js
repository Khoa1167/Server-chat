const reportService = require('../services/report.service');
const handleError = require('../utils/handleError');
const AppError = require('../utils/AppError');
const { checkRateWindow } = require('../utils/rateLimiter');

// Chặn request-flooding thô — khác shadow-throttle nghiệp vụ trong reportService.submitReport.
const NS_REPORT_SEND = 'report-send';

exports.submitReport = async (req, res) => {
  try {
    const { messageId, decryptedContent, ciphertextHash, reason } = req.body;

    if (!messageId || !reason) {
      return res.status(400).json({ message: 'Vui lòng cung cấp đầy đủ thông tin báo cáo' });
    }

    const reporterId = req.user._id;

    const rateLimit = await checkRateWindow(NS_REPORT_SEND, reporterId.toString(), { maxCount: 20, windowMs: 60000 });
    if (rateLimit.limited) {
      return res.status(429).json({ message: 'Bạn đang gửi báo cáo quá nhanh, vui lòng thử lại sau.' });
    }

    const result = await reportService.submitReport({ reporterId, messageId, decryptedContent, ciphertextHash, reason });
    res.json(result);
  } catch (err) {
    if (err instanceof AppError) {
      return res.status(err.statusCode).json({ message: err.message });
    }
    // Không dùng sendServerError/handleError ở đây — cố ý giấu chi tiết lỗi kể cả ở dev, vì
    // payload liên quan report có thể chứa nội dung nhạy cảm (decryptedContent).
    req.log.error({ err }, 'Create report error');
    res.status(500).json({ message: 'Lỗi hệ thống khi gửi báo cáo' });
  }
};

exports.listReports = async (req, res) => {
  try {
    const reports = await reportService.listReports();
    res.json(reports);
  } catch (err) {
    handleError(res, err);
  }
};

exports.resolveReport = async (req, res) => {
  try {
    const { status } = req.body;
    if (!['reviewed', 'dismissed'].includes(status)) {
      return res.status(400).json({ message: 'Trạng thái không hợp lệ' });
    }

    const report = await reportService.resolveReport(req.params.id, status);
    res.json({ message: 'Đã cập nhật trạng thái báo cáo', report });
  } catch (err) {
    handleError(res, err);
  }
};
