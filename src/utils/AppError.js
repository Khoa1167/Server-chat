// Lỗi nghiệp vụ dự kiến (409 email trùng, 404 không tìm thấy...) — Service throw để Controller
// dịch thành đúng status code, phân biệt với lỗi hệ thống không lường trước (đi qua sendServerError).
class AppError extends Error {
  // extra: field bổ sung ngoài message (vd {field: 'username'}) để controller trả nguyên vào JSON —
  // 1 số route (đăng ký, đổi email...) cần báo đúng field nào bị lỗi cho client highlight.
  constructor(message, statusCode, extra) {
    super(message);
    this.statusCode = statusCode;
    this.extra = extra;
  }
}

module.exports = AppError;
