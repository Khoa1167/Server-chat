const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const PostMedia = require('../models/PostMedia');
const AppError = require('../utils/AppError');
const logger = require('../config/logger');
const { matchesSignature } = require('../validators/posts.validator');
const MIME = { 'image/jpeg': 'image', 'image/png': 'image', 'image/webp': 'image', 'video/mp4': 'video', 'video/webm': 'video' };
function storage() {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME } = process.env;
  if (![R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME].every(Boolean)) throw new AppError('Lưu trữ media chưa được cấu hình', 503);
  return { bucket: R2_BUCKET_NAME, client: new S3Client({ region: 'auto', requestChecksumCalculation: 'WHEN_REQUIRED', endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY } }) };
}
async function reserve(owner, body) {
  const type = Object.hasOwn(MIME, body?.mime) ? MIME[body.mime] : null;
  if (!type || !Number.isSafeInteger(body.size) || body.size < 12 || body.size > (type === 'image' ? 10 : 100) * 1024 * 1024) throw new AppError('Hỗ trợ JPG, PNG, WebP tối đa 10 MB; MP4, WebM tối đa 100 MB', 400);
  if (await PostMedia.countDocuments({ owner, post: null, status: { $ne: 'deleting' } }) >= 30) throw new AppError('Có quá nhiều media chưa đăng. Hãy xóa hoặc dùng các media đang có', 429);
  const { client, bucket } = storage();
  const objectKey = `posts/${owner}/${crypto.randomUUID()}`;
  const media = await PostMedia.create({ owner, objectKey, type, mime: body.mime, size: body.size });
  try {
    const uploadUrl = await getSignedUrl(client, new PutObjectCommand({ Bucket: bucket, Key: objectKey, ContentType: body.mime, ContentLength: body.size, IfNoneMatch: '*' }), { expiresIn: 300 });
    return { id: media.id, uploadUrl, mime: media.mime, type, size: media.size };
  } catch (err) {
    await PostMedia.deleteOne({ _id: media._id });
    throw err;
  }
}
async function complete(owner, id) {
  const media = await PostMedia.findOne({ _id: id, owner, post: null, status: { $ne: 'deleting' } }).select('+objectKey');
  if (!media) throw new AppError('Không tìm thấy media chờ upload', 404);
  if (media.status === 'ready') return { id: media.id, type: media.type, mime: media.mime, size: media.size };
  const { client, bucket } = storage();
  let object;
  try { object = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: media.objectKey })); }
  catch { throw new AppError('Upload chưa hoàn tất, hãy thử lại', 409); }
  if (object.ContentLength !== media.size || object.ContentType !== media.mime) throw new AppError('Thông tin media không khớp', 400);
  const sample = await client.send(new GetObjectCommand({ Bucket: bucket, Key: media.objectKey, Range: 'bytes=0-31' }));
  const bytes = Buffer.from(await sample.Body.transformToByteArray());
  if (!matchesSignature(media.mime, bytes)) throw new AppError('Định dạng thực của media không hợp lệ', 400);
  const ready = await PostMedia.updateOne({ _id: id, owner, post: null, status: 'pending' }, { status: 'ready' });
  if (!ready.matchedCount) throw new AppError('Upload đã bị hủy', 409);
  return { id: media.id, type: media.type, mime: media.mime, size: media.size };
}
async function destroy(media) {
  const { client, bucket } = storage();
  const locked = await PostMedia.findOneAndUpdate({ _id: media._id, status: media.status, post: media.post }, { status: 'deleting' });
  if (!locked) return;
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: media.objectKey }));
  // Keep the tombstone until the signed PUT expires so a late upload is deleted again.
  if (media.uploadExpiresAt > new Date()) return;
  await PostMedia.deleteOne({ _id: media._id, status: 'deleting' });
}
async function discard(owner, id) {
  const media = await PostMedia.findOneAndUpdate({ _id: id, owner, post: null }, { status: 'deleting' }, { new: true }).select('+objectKey');
  if (media) await destroy(media);
}
async function cleanup() {
  const rows = await PostMedia.find({ $or: [{ status: 'deleting' }, { post: null, createdAt: { $lt: new Date(Date.now() - 24 * 3600000) } }] }).select('+objectKey').limit(100);
  for (const row of rows) {
    try { await destroy(row); }
    catch { logger.warn('Không thể xóa một media bài viết; sẽ thử lại'); }
  }
}
async function stream(media, req, res) {
  const { client, bucket } = storage();
  const range = req.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2]) || match.slice(1).some(value => value && !Number.isSafeInteger(Number(value))) || (!match[1] && Number(match[2]) === 0) || (match[1] && match[2] && Number(match[2]) < Number(match[1]))) {
      throw new AppError('Khoảng tải không hợp lệ', 416);
    }
  }
  let object;
  try { object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: media.objectKey, ...(range ? { Range: range } : {}) })); }
  catch (err) {
    if (err.$metadata?.httpStatusCode === 416) throw new AppError('Khoảng tải không hợp lệ', 416);
    if (err.$metadata?.httpStatusCode === 404) throw new AppError('Media không còn tồn tại', 404);
    throw err;
  }
  res.status(range ? 206 : 200);
  res.set({ 'Content-Type': media.mime, 'Content-Length': String(object.ContentLength), 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store', 'Content-Disposition': 'inline', 'X-Content-Type-Options': 'nosniff' });
  if (object.ContentRange) res.set('Content-Range', object.ContentRange);
  try { await pipeline(object.Body, res); }
  catch (err) { if (!req.destroyed && !res.destroyed) throw err; }
}
module.exports = { reserve, complete, discard, destroy, cleanup, stream };
