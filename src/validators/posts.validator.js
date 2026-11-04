const AppError = require('../utils/AppError');
const AUDIENCES = ['public', 'friends', 'private'];
const REACTIONS = ['like', 'love', 'care', 'haha', 'wow', 'sad', 'angry'];
function id(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{24}$/i.test(value)) throw new AppError('ID không hợp lệ', 400);
  return value;
}
function text(value, max, required = false) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new AppError('Nội dung không hợp lệ hoặc quá dài', 400);
  return value.trim();
}
function clientId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(value)) throw new AppError('Mã thao tác không hợp lệ', 400);
  return value;
}
function post(body, editing = false) {
  if (!body || !AUDIENCES.includes(body.audience) || !Array.isArray(body.media) || body.media.length > 10) throw new AppError('Bài viết không hợp lệ', 400);
  const media = body.media.map(id);
  if (new Set(media).size !== media.length) throw new AppError('Media bị trùng', 400);
  const content = text(body.content, 10000);
  const original = body.original ? id(body.original) : null;
  if (!content && !media.length && !original) throw new AppError('Bài viết chưa có nội dung', 400);
  if (original && media.length) throw new AppError('Bài chia sẻ không gắn thêm media', 400);
  if (editing && (!Number.isSafeInteger(body.version) || body.version < 0)) throw new AppError('Thiếu phiên bản bài viết', 400);
  return { content, audience: body.audience, media, original, clientId: clientId(body.clientId), ...(editing ? { version: body.version } : {}) };
}
function page(query) {
  return { cursor: query.cursor ? id(query.cursor) : null, limit: 20 };
}
function matchesSignature(mime, bytes) {
  if (mime === 'image/jpeg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (mime === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mime === 'image/webp') return bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (mime === 'video/mp4') return bytes.toString('ascii', 4, 8) === 'ftyp';
  if (mime === 'video/webm') return bytes.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]));
  return false;
}
module.exports = { id, text, clientId, post, page, matchesSignature, AUDIENCES, REACTIONS };
