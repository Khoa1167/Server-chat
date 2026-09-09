const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const phoneRegex = /^\+?[0-9]{7,15}$/;
// username: chỉ chữ cái/số ASCII — tránh giả mạo bằng ký tự nhìn giống (homoglyph) hay ký tự vô hình.
const usernameRegex = /^[a-zA-Z0-9]{3,16}$/;
// nickname: chỉ chặn nhóm ký tự Control/Format/Private-Use/Surrogate (\p{C}) — nhóm dùng để giả mạo/vô hình.
const nicknameRegex = /^(?!.*\p{C})[\s\S]{2,20}$/u;

const normalizeEmail = (value) => typeof value === 'string' ? value.toLowerCase().trim() : '';
const normalizePhone = (value) => typeof value === 'string' ? value.trim().replace(/[()\s\-]/g, '') : '';
const isValidEmail = (value) => emailRegex.test(value);
const isValidPhone = (value) => phoneRegex.test(value);
const isValidUsername = (value) => typeof value === 'string' && usernameRegex.test(value);
const isValidPassword = (value) => typeof value === 'string' && value.length >= 8 && value.length <= 30;
// NFC: gộp các cách biểu diễn Unicode khác nhau của cùng 1 ký tự có dấu về đúng 1 dạng, để chuỗi
// nhìn giống hệt nhau thì so trùng lặp cũng khớp nhau (khác byte nhưng cùng hiển thị sẽ không lách được).
const normalizeNickname = (value) => typeof value === 'string' ? value.trim().normalize('NFC') : '';
const isValidNickname = (value) => nicknameRegex.test(value);

module.exports = {
  normalizeEmail,
  normalizePhone,
  isValidEmail,
  isValidPhone,
  isValidUsername,
  isValidPassword,
  normalizeNickname,
  isValidNickname,
};
