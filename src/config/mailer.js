// Gửi email qua HTTP API Brevo thay vì SMTP — nhiều PaaS chặn outbound port SMTP, HTTPS thì không.
const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';

const sendBrevoEmail = async ({ to, subject, html, senderName = 'Chat App' }) => {
  const res = await fetch(BREVO_API_URL, {
    method: 'POST',
    headers: {
      'api-key': process.env.BREVO_API_KEY,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      sender: { name: senderName, email: process.env.SMTP_FROM },
      to: [{ email: to }],
      subject,
      htmlContent: html,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Brevo API trả lỗi ${res.status}: ${body}`);
  }
};

const sendOTPEmail = async (toEmail, otp) => {
  await sendBrevoEmail({
    to: toEmail,
    subject: 'Mã xác thực OTP - Chat App',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; border: 1px solid #e0e0e0; border-radius: 12px;">
        <h2 style="color: #5b5bd6; margin-bottom: 8px;">Chat App</h2>
        <p style="color: #444; margin-bottom: 24px;">Xin chào! Đây là mã OTP để xác thực tài khoản của bạn:</p>
        <div style="background: #f5f5ff; border: 2px dashed #5b5bd6; border-radius: 8px; padding: 20px; text-align: center; margin-bottom: 24px;">
          <span style="font-size: 36px; font-weight: bold; letter-spacing: 8px; color: #5b5bd6;">
            ${otp}
          </span>
        </div>
        <p style="color: #666; font-size: 14px;">Mã có hiệu lực trong <strong>5 phút</strong></p>
        <p style="color: #666; font-size: 14px;">Không chia sẻ mã này với bất kỳ ai</p>
        <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 24px 0;">
        <p style="color: #aaa; font-size: 12px;">Nếu bạn không yêu cầu đăng ký, hãy bỏ qua email này.</p>
      </div>
    `,
  });
};

const sendResetPasswordOTPEmail = async (toEmail, otp) => {
  await sendBrevoEmail({
    to: toEmail,
    subject: 'Khôi phục mật khẩu - Chat App',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; border: 1px solid #e0e0e0; border-radius: 12px;">
        <h2 style="color: #e53e3e; margin-bottom: 8px;">Chat App</h2>
        <h3 style="color: #2d3748; margin-top: 0;">Yêu cầu lấy lại mật khẩu</h3>
        <p style="color: #444; margin-bottom: 24px;">Chúng tôi nhận được yêu cầu đặt lại mật khẩu cho tài khoản liên kết với email này. Đây là mã OTP xác nhận của bạn:</p>
        <div style="background: #fff5f5; border: 2px dashed #e53e3e; border-radius: 8px; padding: 20px; text-align: center; margin-bottom: 24px;">
          <span style="font-size: 36px; font-weight: bold; letter-spacing: 8px; color: #e53e3e;">
            ${otp}
          </span>
        </div>
        <p style="color: #666; font-size: 14px;">Mã có hiệu lực trong <strong>5 phút</strong></p>
        <p style="color: #666; font-size: 14px;">Nếu bạn không gửi yêu cầu này, vui lòng bỏ qua email và mật khẩu của bạn sẽ giữ nguyên.</p>
        <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 24px 0;">
        <p style="color: #aaa; font-size: 12px;">Email này được gửi tự động từ Chat App.</p>
      </div>
    `,
  });
};

const sendEmailChangeOTPEmail = async (newEmail, otp) => {
  await sendBrevoEmail({
    to: newEmail,
    subject: 'Mã xác thực địa chỉ Email mới - Chat App',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; border: 1px solid #e0e0e0; border-radius: 12px;">
        <h2 style="color: #3182ce; margin-bottom: 8px;">Chat App</h2>
        <h3 style="color: #2d3748; margin-top: 0;">Xác thực địa chỉ Email mới</h3>
        <p style="color: #444; margin-bottom: 16px;">Bạn vừa yêu cầu liên kết địa chỉ email này với tài khoản Chat App. Đây là mã OTP xác nhận:</p>
        <div style="background: #ebf8ff; border: 2px dashed #3182ce; border-radius: 8px; padding: 20px; text-align: center; margin-bottom: 24px;">
          <span style="font-size: 36px; font-weight: bold; letter-spacing: 8px; color: #3182ce;">
            ${otp}
          </span>
        </div>
        <p style="color: #666; font-size: 14px;">Mã có hiệu lực trong <strong>5 phút</strong></p>
        <p style="color: #666; font-size: 14px;">Không chia sẻ mã này với bất kỳ ai để đảm bảo an toàn tài khoản.</p>
        <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 24px 0;">
        <p style="color: #aaa; font-size: 12px;">Nếu bạn không thực hiện yêu cầu này, vui lòng bỏ qua email này.</p>
      </div>
    `,
  });
};

const sendEmailChangeNoticeEmail = async (oldEmail, newEmail) => {
  await sendBrevoEmail({
    to: oldEmail,
    senderName: 'Chat App Security',
    subject: 'Cảnh báo bảo mật: Yêu cầu thay đổi địa chỉ Email - Chat App',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; border: 1px solid #e0e0e0; border-radius: 12px;">
        <h2 style="color: #dd6b20; margin-bottom: 8px;">Chat App Security</h2>
        <h3 style="color: #2d3748; margin-top: 0;">Cảnh báo thay đổi Email tài khoản</h3>
        <p style="color: #444; margin-bottom: 16px;">Tài khoản của bạn vừa khởi tạo yêu cầu thay đổi địa chỉ email liên kết từ <strong>${oldEmail}</strong> sang <strong>${newEmail}</strong>.</p>
        <p style="color: #e53e3e; font-size: 14px; font-weight: bold;">Nếu bạn không phải là người thực hiện hành động này, ai đó có thể đang cố đổi email của bạn. Vui lòng đổi mật khẩu ngay lập tức!</p>
        <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 24px 0;">
        <p style="color: #aaa; font-size: 12px;">Email thông báo bảo mật tự động từ Chat App.</p>
      </div>
    `,
  });
};

const sendAccountDeletionScheduledEmail = async (toEmail) => {
  await sendBrevoEmail({
    to: toEmail,
    senderName: 'Chat App Security',
    subject: 'Tài khoản của bạn đã được lên lịch xóa - Chat App',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; border: 1px solid #e0e0e0; border-radius: 12px;">
        <h2 style="color: #dd6b20; margin-bottom: 8px;">Chat App Security</h2>
        <h3 style="color: #2d3748; margin-top: 0;">Yêu cầu xóa tài khoản</h3>
        <p style="color: #444; margin-bottom: 16px;">Tài khoản của bạn vừa được yêu cầu xóa. Dữ liệu sẽ được giữ trong <strong>14 ngày</strong> trước khi bị xóa vĩnh viễn.</p>
        <p style="color: #444; margin-bottom: 16px;">Nếu đây không phải là bạn, hoặc bạn đổi ý, hãy dùng chức năng <strong>"Khôi phục tài khoản"</strong> ở trang đăng nhập trong thời hạn trên.</p>
        <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 24px 0;">
        <p style="color: #aaa; font-size: 12px;">Email thông báo bảo mật tự động từ Chat App.</p>
      </div>
    `,
  });
};

const sendAccountRecoveryOTPEmail = async (toEmail, otp) => {
  await sendBrevoEmail({
    to: toEmail,
    subject: 'Mã khôi phục tài khoản - Chat App',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; border: 1px solid #e0e0e0; border-radius: 12px;">
        <h2 style="color: #38a169; margin-bottom: 8px;">Chat App</h2>
        <h3 style="color: #2d3748; margin-top: 0;">Khôi phục tài khoản</h3>
        <p style="color: #444; margin-bottom: 24px;">Đây là mã OTP để khôi phục tài khoản đang chờ xóa của bạn:</p>
        <div style="background: #f0fff4; border: 2px dashed #38a169; border-radius: 8px; padding: 20px; text-align: center; margin-bottom: 24px;">
          <span style="font-size: 36px; font-weight: bold; letter-spacing: 8px; color: #38a169;">
            ${otp}
          </span>
        </div>
        <p style="color: #666; font-size: 14px;">Mã có hiệu lực trong <strong>10 phút</strong></p>
        <p style="color: #666; font-size: 14px;">Không chia sẻ mã này với bất kỳ ai</p>
        <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 24px 0;">
        <p style="color: #aaa; font-size: 12px;">Nếu bạn không yêu cầu khôi phục, hãy bỏ qua email này.</p>
      </div>
    `,
  });
};

module.exports = {
  sendOTPEmail,
  sendResetPasswordOTPEmail,
  sendEmailChangeOTPEmail,
  sendEmailChangeNoticeEmail,
  sendAccountDeletionScheduledEmail,
  sendAccountRecoveryOTPEmail,
};
