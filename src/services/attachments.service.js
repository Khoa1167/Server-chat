const crypto = require('crypto');
const {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const Attachment = require('../models/Attachment');
const Room = require('../models/Room');
const AppError = require('../utils/AppError');
const logger = require('../config/logger');

const UPLOAD_URL_SECONDS = 5 * 60;
const DOWNLOAD_URL_SECONDS = 5 * 60;
const PENDING_UPLOAD_MS = 15 * 60 * 1000;
const UPLOADED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SIZE = Object.freeze({ image: 10 * 1024 * 1024, audio: 10 * 1024 * 1024, file: 25 * 1024 * 1024 });

function getConfig() {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME } = process.env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME) {
    throw new AppError('R2 chưa được cấu hình trên server', 503);
  }
  return { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME };
}

function r2() {
  const config = getConfig();
  return {
    bucket: config.R2_BUCKET_NAME,
    client: new S3Client({
      region: 'auto',
      endpoint: `https://${config.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: config.R2_ACCESS_KEY_ID, secretAccessKey: config.R2_SECRET_ACCESS_KEY },
    }),
  };
}

async function requireMembership(roomId, userId) {
  const room = await Room.findOne({ _id: roomId, members: userId }).select('_id');
  if (!room) throw new AppError('Không có quyền truy cập phòng này', 403);
  return room;
}

function validateTypeAndSize(type, expectedSize) {
  if (!Object.hasOwn(MAX_SIZE, type)) throw new AppError('Loại attachment không hợp lệ', 400);
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 17 || expectedSize > MAX_SIZE[type]) {
    throw new AppError('Kích thước ciphertext không hợp lệ', 400);
  }
}

async function createUpload(roomId, userId, type, expectedSize) {
  validateTypeAndSize(type, expectedSize);
  await requireMembership(roomId, userId);
  const { bucket, client } = r2();
  const attachmentId = crypto.randomUUID();
  const objectKey = `rooms/${roomId}/${attachmentId}`;
  const expiresAt = new Date(Date.now() + PENDING_UPLOAD_MS);
  await Attachment.create({ attachmentId, room: roomId, owner: userId, objectKey, type, expectedSize, expiresAt, objectExpiresAt: expiresAt });

  const uploadUrl = await getSignedUrl(client, new PutObjectCommand({
    Bucket: bucket,
    Key: objectKey,
    ContentType: 'application/octet-stream',
  }), { expiresIn: UPLOAD_URL_SECONDS });

  return { attachmentId, uploadUrl, expiresAt };
}

async function completeUpload(roomId, userId, attachmentId) {
  await requireMembership(roomId, userId);
  const attachment = await Attachment.findOne({ attachmentId, room: roomId, owner: userId, status: 'pending' });
  if (!attachment) throw new AppError('Attachment chờ upload không tồn tại', 404);
  const { bucket, client } = r2();

  try {
    const object = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: attachment.objectKey }));
    if (object.ContentLength !== attachment.expectedSize) throw new Error('Kích thước object không khớp');
  } catch (err) {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: attachment.objectKey })).catch(() => {});
    await attachment.deleteOne();
    throw new AppError('Upload attachment không hợp lệ hoặc chưa hoàn tất', 400);
  }

  attachment.status = 'uploaded';
  attachment.expiresAt = null;
  attachment.objectExpiresAt = new Date(Date.now() + UPLOADED_RETENTION_MS);
  await attachment.save();
  return { attachmentId: attachment.attachmentId };
}

async function getDownloadUrl(roomId, userId, attachmentId) {
  await requireMembership(roomId, userId);
  const attachment = await Attachment.findOne({ attachmentId, room: roomId, status: 'uploaded' }).select('objectKey');
  if (!attachment) throw new AppError('Attachment không tồn tại', 404);
  const { bucket, client } = r2();
  return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: attachment.objectKey }), { expiresIn: DOWNLOAD_URL_SECONDS });
}

async function claimAttachment(attachmentId, roomId, ownerId, messageId) {
  if (!attachmentId) return null;
  const attachment = await Attachment.findOneAndUpdate(
    { attachmentId, room: roomId, owner: ownerId, status: 'uploaded', message: null },
    { $set: { message: messageId } },
    { new: true },
  );
  if (!attachment) throw new AppError('Attachment không hợp lệ hoặc đã được gửi', 400);
  return attachment;
}

async function releaseAttachmentClaim(attachmentId, messageId) {
  if (attachmentId) await Attachment.updateOne({ attachmentId, message: messageId }, { $set: { message: null } });
}

async function deleteAttachment(attachment) {
  if (!attachment) return;
  try {
    const { bucket, client } = r2();
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: attachment.objectKey }));
  } catch (err) {
    logger.error({ err, attachmentId: attachment.attachmentId }, 'Không thể xóa attachment R2');
  }
  await Attachment.deleteOne({ _id: attachment._id });
}

async function deleteAttachmentForMessage(messageId) {
  const attachment = await Attachment.findOne({ message: messageId });
  await deleteAttachment(attachment);
}

async function deleteAttachmentsForRoom(roomId) {
  const attachments = await Attachment.find({ room: roomId }).select('objectKey');
  if (!attachments.length) return;
  try {
    const { bucket, client } = r2();
    for (let index = 0; index < attachments.length; index += 1000) {
      const Objects = attachments.slice(index, index + 1000).map(({ objectKey: Key }) => ({ Key }));
      await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects, Quiet: true } }));
    }
  } catch (err) {
    logger.error({ err, roomId }, 'Không thể xóa attachment R2 của phòng');
  }
  await Attachment.deleteMany({ room: roomId });
}

async function cleanupExpiredAttachments() {
  const expired = await Attachment.find({ objectExpiresAt: { $lte: new Date() } }).select('objectKey').limit(100);
  if (!expired.length) return;
  const { bucket, client } = r2();
  for (const attachment of expired) {
    try {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: attachment.objectKey }));
      await Attachment.deleteOne({ _id: attachment._id });
    } catch (err) {
      logger.error({ err, attachmentId: attachment._id.toString() }, 'Không thể dọn attachment hết hạn');
    }
  }
}

module.exports = {
  createUpload,
  completeUpload,
  getDownloadUrl,
  claimAttachment,
  releaseAttachmentClaim,
  deleteAttachmentForMessage,
  deleteAttachmentsForRoom,
  cleanupExpiredAttachments,
};
