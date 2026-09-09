const crypto = require('crypto');
const Report = require('../models/Report');
const Message = require('../models/Message');
const Room = require('../models/Room');
const User = require('../models/User');
const { encryptReportContent, decryptReportContent } = require('../utils/crypto');
const userFields = require('../utils/publicUserFields');
const AppError = require('../utils/AppError');

async function submitReport({ reporterId, messageId, decryptedContent, ciphertextHash, reason }) {
  const user = await User.findById(reporterId);

  // 1. Cooldown Check (Shadow Throttling)
  if (user.reportCooldownAt && new Date() < new Date(user.reportCooldownAt)) {
    return { message: 'Cảm ơn bạn đã gửi báo cáo. Hệ thống sẽ xem xét xử lý.' };
  }

  // 2. Rate Limiting Check (Shadow Throttle nếu > 5 reports/giờ)
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const recentReportCount = await Report.countDocuments({
    reporter: reporterId,
    createdAt: { $gte: oneHourAgo }
  });

  if (recentReportCount >= 5) {
    if (recentReportCount >= 10) {
      await User.findByIdAndUpdate(reporterId, {
        reportCooldownAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
      });
    }
    return { message: 'Cảm ơn bạn đã gửi báo cáo. Hệ thống sẽ xem xét xử lý.' };
  }

  // 3. Deduplication Check & Flexible Update Policy
  const existingReport = await Report.findOne({ reporter: reporterId, messageId });
  if (existingReport) {
    const tenMinutes = 10 * 60 * 1000;
    const isRecent = (Date.now() - new Date(existingReport.createdAt).getTime()) < tenMinutes;

    // Cho phép cập nhật lý do báo cáo trong vòng 10 phút nếu chưa review
    if (existingReport.status === 'pending' && isRecent) {
      existingReport.reason = reason;
      if (decryptedContent) {
        existingReport.decryptedContent = encryptReportContent(decryptedContent);
      }
      await existingReport.save();
      return { message: 'Đã cập nhật lý do báo cáo của bạn.', reportId: existingReport._id };
    }

    return { message: 'Bạn đã báo cáo tin nhắn này trước đó.' };
  }

  // 4. Verification & Authorization Check
  const message = await Message.findById(messageId);
  if (!message) {
    throw new AppError('Không tìm thấy tin nhắn cần báo cáo', 404);
  }

  const room = await Room.findOne({ _id: message.room, members: reporterId });
  if (!room) {
    throw new AppError('Bạn không có quyền báo cáo tin nhắn trong cuộc trò chuyện này', 403);
  }

  // 5. Integrity Check: SHA-256 đối chiếu ciphertext gốc
  let integrityMismatch = false;
  if (ciphertextHash && message.content) {
    const serverCiphertextHash = crypto.createHash('sha256').update(message.content).digest('hex');
    if (serverCiphertextHash !== ciphertextHash) {
      integrityMismatch = true;
    }
  }

  // 6. Mã hóa decryptedContent bằng REPORT_ENCRYPTION_KEY riêng biệt at-rest
  const encryptedDecryptedContent = decryptedContent ? encryptReportContent(decryptedContent) : '';

  const report = await Report.create({
    reporter: reporterId,
    reportedUser: message.sender,
    messageId: message._id,
    roomId: room._id,
    decryptedContent: encryptedDecryptedContent,
    ciphertextHash: ciphertextHash || '',
    reason,
    integrityMismatch,
  });

  // 7. Weighted Anti-Brigading Check: Trọng số dựa trên Trust Score người báo cáo
  const recentReports = await Report.find({
    reportedUser: message.sender,
    createdAt: { $gte: oneHourAgo }
  }).populate('reporter', 'reportTrustScore');

  let weightedScoreSum = 0;
  const countedReporters = new Set();

  for (const r of recentReports) {
    const rId = r.reporter._id.toString();
    if (!countedReporters.has(rId)) {
      countedReporters.add(rId);
      const trustScore = r.reporter.reportTrustScore || 100;
      // Trọng số theo trust score: >=50: 1.0, >=30: 0.5, <30: 0.2
      let weight = 1.0;
      if (trustScore < 30) weight = 0.2;
      else if (trustScore < 50) weight = 0.5;

      weightedScoreSum += weight;
    }
  }

  if (weightedScoreSum >= 10) {
    await Report.updateMany(
      { reportedUser: message.sender, createdAt: { $gte: oneHourAgo } },
      { suspectedBrigading: true }
    );
  }

  return { message: 'Cảm ơn bạn đã gửi báo cáo. Đội ngũ quản trị sẽ xem xét xử lý.', reportId: report._id };
}

async function listReports() {
  const reports = await Report.find({})
    .populate('reporter', `${userFields.BASIC} reportTrustScore`)
    .populate('reportedUser', userFields.BASIC)
    .sort({ createdAt: -1 })
    .limit(50);

  // decryptedContent lưu at-rest mã hóa riêng bằng REPORT_ENCRYPTION_KEY — phải giải mã lại
  // ở đây thì admin mới đọc được, nếu không API trả thẳng ciphertext vô nghĩa
  return reports.map(r => {
    const obj = r.toObject();
    obj.decryptedContent = decryptReportContent(obj.decryptedContent);
    return obj;
  });
}

async function resolveReport(reportId, status) {
  const report = await Report.findById(reportId);
  if (!report) {
    throw new AppError('Không tìm thấy báo cáo', 404);
  }

  report.status = status;
  const now = new Date();

  if (status === 'dismissed') {
    // 1. TTL Auto-delete sau 30 ngày nếu bác bỏ (tránh lưu rác)
    report.expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    // 2. Trừ Trust Score của reporter (Sàn tối thiểu = 10, không khóa vĩnh viễn)
    const reporterUser = await User.findById(report.reporter);
    if (reporterUser) {
      const newScore = Math.max(10, (reporterUser.reportTrustScore || 100) - 10);
      reporterUser.reportTrustScore = newScore;
      await reporterUser.save();
    }
  } else if (status === 'reviewed') {
    // 1. TTL Auto-delete sau 90 ngày cho reviewed (không giữ nội dung nhạy cảm vô hạn)
    report.expiresAt = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);

    // 2. Cộng Trust Score có cap (Tối đa +15/ngày) để tránh gaming từ alt-accounts
    const reporterUser = await User.findById(report.reporter);
    if (reporterUser) {
      const todayStr = now.toISOString().split('T')[0];
      let currentDailyIncrease = reporterUser.dailyTrustScoreIncrease || 0;

      if (reporterUser.lastTrustScoreIncreaseDate !== todayStr) {
        currentDailyIncrease = 0;
        reporterUser.lastTrustScoreIncreaseDate = todayStr;
      }

      if (currentDailyIncrease < 15) {
        const increaseAmount = Math.min(5, 15 - currentDailyIncrease);
        reporterUser.reportTrustScore = Math.min(100, (reporterUser.reportTrustScore || 100) + increaseAmount);
        reporterUser.dailyTrustScoreIncrease = currentDailyIncrease + increaseAmount;
        await reporterUser.save();
      }
    }
  }

  await report.save();
  return report;
}

module.exports = { submitReport, listReports, resolveReport };
