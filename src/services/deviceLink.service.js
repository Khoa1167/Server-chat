const crypto = require('crypto');
const mongoose = require('mongoose');
const {
  AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand,
  DeleteObjectCommand, GetObjectCommand, ListPartsCommand, S3Client, UploadPartCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const DeviceLinkTransfer = require('../models/DeviceLinkTransfer');
const User = require('../models/User');
const AppError = require('../utils/AppError');
const logger = require('../config/logger');
const {
  PART_SIZE, MAX_PARTS, READY_LEASE_MS,
  expiresAfter, leaseUntil, validatedParts,
} = require('./deviceLinkArchive');

const URL_SECONDS = 5 * 60;
const PART_URL_SECONDS = 60;
const ARCHIVE_WINDOW_MS = 3 * 60 * 60 * 1000;

function r2() {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME } = process.env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME) {
    throw new AppError('R2 chưa được cấu hình trên server', 503);
  }
  return {
    bucket: R2_BUCKET_NAME,
    client: new S3Client({
      region: 'auto', endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
    }),
  };
}

function validEcdhKey(key) {
  return key && typeof key === 'object' && key.kty === 'EC' && key.crv === 'P-256'
    && typeof key.x === 'string' && key.x.length <= 100 && typeof key.y === 'string' && key.y.length <= 100;
}

function createManualCode() {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
}

function manualCodeHash(value) {
  const code = typeof value === 'string' ? value.trim() : '';
  return /^\d{6}$/.test(code) ? crypto.createHash('sha256').update(code).digest('hex') : null;
}

async function transferFor(id, userId) {
  if (!mongoose.isObjectIdOrHexString(id)) throw new AppError('Phiên liên kết không hợp lệ', 400);
  const transfer = await DeviceLinkTransfer.findOne({ _id: id, owner: userId });
  if (!transfer || transfer.usableUntil <= new Date()) throw new AppError('Phiên liên kết đã hết hạn', 404);
  return transfer;
}

function requireTarget(transfer, deviceId) {
  if (transfer.targetDeviceId !== deviceId) throw new AppError('Thiết bị không được phép nhận lịch sử này', 403);
}

function requireSource(transfer, deviceId) {
  if (transfer.sourceDeviceId !== deviceId) throw new AppError('Thiết bị không được phép gửi lịch sử này', 403);
}

async function requireActiveDifferentDevices(userId, sourceDeviceId, targetDeviceId) {
  if (!sourceDeviceId || sourceDeviceId === targetDeviceId) throw new AppError('Không thể liên kết thiết bị', 400);
  const user = await User.findById(userId).select('devices');
  const active = deviceId => user?.devices.some(device => device.deviceId === deviceId && !device.isRevoked && device.tokenHash);
  if (!active(sourceDeviceId) || !active(targetDeviceId)) throw new AppError('Không thể liên kết thiết bị', 400);
}

async function notifyDevice(io, deviceId, event, payload) {
  if (!io) return;
  const sockets = await io.fetchSockets();
  sockets.filter(socket => socket.data.deviceId === deviceId).forEach(socket => socket.emit(event, payload));
}

async function createTransfer(user, deviceId, targetPublicKey) {
  if (!validEcdhKey(targetPublicKey)) throw new AppError('Khóa liên kết tạm thời không hợp lệ', 400);
  let code;
  let hash;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    code = createManualCode();
    hash = manualCodeHash(code);
    if (!await DeviceLinkTransfer.exists({ owner: user._id, manualCodeHash: hash, status: 'waiting', usableUntil: { $gt: new Date() } })) break;
    code = null;
  }
  if (!code) throw new AppError('Không thể tạo mã liên kết, vui lòng thử lại', 503);
  const transfer = await DeviceLinkTransfer.create({
    owner: user._id, targetDeviceId: deviceId, targetPublicKey, manualCodeHash: hash,
  });
  return { sessionId: transfer._id.toString(), manualCode: code, expiresAt: transfer.usableUntil };
}

async function approveWaitingTransfer(transfer, user, sourceDeviceId, io) {
  await requireActiveDifferentDevices(user._id, sourceDeviceId, transfer.targetDeviceId);
  const now = new Date();
  const archiveDeadline = new Date(now.getTime() + ARCHIVE_WINDOW_MS);
  const usableUntil = leaseUntil(now, archiveDeadline);
  const approved = await DeviceLinkTransfer.findOneAndUpdate(
    { _id: transfer._id, owner: user._id, status: 'waiting', usableUntil: { $gt: new Date() } },
    { $set: { sourceDeviceId, status: 'approved', archiveDeadline, usableUntil, expiresAt: expiresAfter(usableUntil) } },
    { new: true },
  );
  if (!approved) throw new AppError('Phiên liên kết này không còn chờ xác nhận', 409);
  await notifyDevice(io, approved.targetDeviceId, 'device_link:approved', { sessionId: approved._id.toString() });
  return { sessionId: approved._id.toString(), targetPublicKey: approved.targetPublicKey };
}

async function approveTransfer(id, user, sourceDeviceId, io) {
  return approveWaitingTransfer(await transferFor(id, user._id), user, sourceDeviceId, io);
}

async function approveTransferByCode(code, user, sourceDeviceId, io) {
  const hash = manualCodeHash(code);
  const transfer = hash && await DeviceLinkTransfer.findOne({
    owner: user._id, manualCodeHash: hash, status: 'waiting', usableUntil: { $gt: new Date() },
  });
  if (!transfer) throw new AppError('Không thể liên kết thiết bị', 400);
  try {
    return await approveWaitingTransfer(transfer, user, sourceDeviceId, io);
  } catch {
    throw new AppError('Không thể liên kết thiết bị', 400);
  }
}

async function abortMultipart(transfer) {
  if (!transfer?.uploadId || !transfer?.objectKey) return;
  const { bucket, client } = r2();
  await client.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: transfer.objectKey, UploadId: transfer.uploadId }));
}

async function deleteArchiveObject(objectKey) {
  if (!objectKey) return;
  const { bucket, client } = r2();
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey }));
}

async function listParts(transfer) {
  const { bucket, client } = r2();
  const result = await client.send(new ListPartsCommand({
    Bucket: bucket, Key: transfer.objectKey, UploadId: transfer.uploadId, MaxParts: MAX_PARTS,
  }));
  if (result.IsTruncated) throw new AppError('Archive có quá nhiều phần', 400);
  return { bucket, client, parts: result.Parts || [] };
}

async function reserveArchiveUpload(id, user, deviceId, { sourcePublicKey }) {
  const transfer = await transferFor(id, user._id);
  requireSource(transfer, deviceId);
  if (!['approved', 'uploading'].includes(transfer.status) || !transfer.archiveDeadline || transfer.archiveDeadline <= new Date()) {
    throw new AppError('Phiên liên kết chưa sẵn sàng để gửi lịch sử', 409);
  }
  if (!validEcdhKey(sourcePublicKey)) {
    throw new AppError('Archive mã hóa không hợp lệ', 400);
  }
  if (transfer.status === 'uploading') {
    try {
      await abortMultipart(transfer);
    } catch (err) {
      logger.error({ err, sessionId: transfer._id.toString() }, 'Không thể hủy archive multipart cũ');
      throw new AppError('Không thể tạo lại archive, vui lòng thử lại', 503);
    }
  }
  const { bucket, client } = r2();
  const objectKey = `device-transfers/${transfer._id}/${crypto.randomUUID()}`;
  const upload = await client.send(new CreateMultipartUploadCommand({
    Bucket: bucket, Key: objectKey, ContentType: 'application/octet-stream',
  }));
  if (!upload.UploadId) throw new AppError('Không thể tạo archive', 503);
  const usableUntil = leaseUntil(new Date(), transfer.archiveDeadline);
  transfer.sourcePublicKey = sourcePublicKey;
  transfer.objectKey = objectKey;
  transfer.uploadId = upload.UploadId;
  transfer.lastVerifiedPart = 0;
  transfer.finalPartNumber = null;
  transfer.usableUntil = usableUntil;
  transfer.expiresAt = expiresAfter(usableUntil);
  transfer.status = 'uploading';
  await transfer.save();
  return {};
}

async function getArchivePartUploadUrl(id, user, deviceId, { partNumber, contentLength, isFinal }) {
  const transfer = await transferFor(id, user._id);
  requireSource(transfer, deviceId);
  if (transfer.status !== 'uploading' || !transfer.uploadId || !transfer.archiveDeadline || transfer.archiveDeadline <= new Date()) {
    throw new AppError('Phiên liên kết chưa sẵn sàng để gửi archive', 409);
  }
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > MAX_PARTS
    || !Number.isSafeInteger(contentLength) || typeof isFinal !== 'boolean'
    || partNumber !== transfer.lastVerifiedPart + 1
    || (transfer.finalPartNumber !== null && transfer.finalPartNumber !== partNumber)
    || (!isFinal && contentLength !== PART_SIZE)
    || (isFinal && (contentLength < 1 || contentLength > PART_SIZE))) {
    throw new AppError('Phần archive không hợp lệ', 400);
  }

  let verifiedPart = transfer.lastVerifiedPart;
  if (partNumber > 1) {
    const { parts } = await listParts(transfer);
    const previous = parts.find(part => part.PartNumber === partNumber - 1);
    if (!previous || previous.Size !== PART_SIZE) throw new AppError('Phần archive trước chưa hoàn tất', 409);
    verifiedPart = partNumber - 1;
  }

  const now = new Date();
  const usableUntil = leaseUntil(now, transfer.archiveDeadline);
  const filter = {
    _id: transfer._id, owner: user._id, status: 'uploading', uploadId: transfer.uploadId,
    lastVerifiedPart: transfer.lastVerifiedPart,
    ...(isFinal ? { $or: [{ finalPartNumber: null }, { finalPartNumber: partNumber }] } : { finalPartNumber: null }),
  };
  const updated = await DeviceLinkTransfer.findOneAndUpdate(filter, {
    $set: {
      lastVerifiedPart: verifiedPart,
      ...(isFinal ? { finalPartNumber: partNumber } : {}),
      usableUntil,
      expiresAt: expiresAfter(usableUntil),
    },
  }, { new: true });
  if (!updated) throw new AppError('Phần archive đã thay đổi, vui lòng thử lại', 409);

  const { bucket, client } = r2();
  const uploadUrl = await getSignedUrl(client, new UploadPartCommand({
    Bucket: bucket, Key: updated.objectKey, UploadId: updated.uploadId, PartNumber: partNumber,
    ContentLength: contentLength, ContentType: 'application/octet-stream',
  }), { expiresIn: PART_URL_SECONDS });
  return { uploadUrl };
}

async function completeArchiveUpload(id, user, deviceId, io) {
  const transfer = await transferFor(id, user._id);
  requireSource(transfer, deviceId);
  if (transfer.status !== 'uploading' || !transfer.uploadId || !transfer.finalPartNumber) throw new AppError('Archive chưa được gửi', 409);
  try {
    const { bucket, client, parts } = await listParts(transfer);
    const completeParts = validatedParts(parts, transfer.finalPartNumber);
    if (!completeParts) throw new Error('Các phần archive không hợp lệ');
    await client.send(new CompleteMultipartUploadCommand({
      Bucket: bucket, Key: transfer.objectKey, UploadId: transfer.uploadId,
      MultipartUpload: { Parts: completeParts },
    }));
  } catch {
    try {
      await abortMultipart(transfer);
    } catch (err) {
      logger.error({ err, sessionId: transfer._id.toString() }, 'Không thể hủy archive multipart lỗi');
      throw new AppError('Không thể dọn archive lỗi, vui lòng thử lại', 503);
    }
    transfer.status = 'approved';
    transfer.objectKey = null;
    transfer.uploadId = null;
    transfer.lastVerifiedPart = 0;
    transfer.finalPartNumber = null;
    await transfer.save();
    throw new AppError('Upload archive không hợp lệ hoặc chưa hoàn tất', 400);
  }
  const usableUntil = new Date(Date.now() + READY_LEASE_MS);
  transfer.status = 'ready';
  transfer.uploadId = null;
  transfer.usableUntil = usableUntil;
  transfer.expiresAt = expiresAfter(usableUntil);
  try {
    await transfer.save();
  } catch (err) {
    await deleteArchiveObject(transfer.objectKey).catch(cleanupError => logger.error(
      { err: cleanupError, sessionId: transfer._id.toString() }, 'Không thể dọn archive sau lỗi lưu trạng thái',
    ));
    throw err;
  }
  await notifyDevice(io, transfer.targetDeviceId, 'device_link:archive_ready', { sessionId: transfer._id.toString() });
}

async function getArchiveDownload(id, user, deviceId) {
  const transfer = await transferFor(id, user._id);
  requireTarget(transfer, deviceId);
  if (transfer.status !== 'ready') throw new AppError('Archive chưa sẵn sàng', 409);
  const { bucket, client } = r2();
  const downloadUrl = await getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: transfer.objectKey }), { expiresIn: URL_SECONDS });
  return { downloadUrl, sourcePublicKey: transfer.sourcePublicKey };
}

async function acknowledgeArchive(id, user, deviceId) {
  const transfer = await transferFor(id, user._id);
  requireTarget(transfer, deviceId);
  const objectKey = transfer.objectKey;
  if (objectKey) {
    try {
        await deleteArchiveObject(objectKey);
    } catch (err) {
      logger.error({ err, sessionId: id }, 'Không thể xóa archive liên kết thiết bị');
      throw new AppError('Không thể xóa archive đã nhập, vui lòng thử lại', 503);
    }
  }
  await transfer.deleteOne();
}

async function cleanupExpiredTransfers() {
  const expired = await DeviceLinkTransfer.find({ usableUntil: { $lte: new Date() } }).select('objectKey uploadId').limit(100);
  for (const transfer of expired) {
    try {
      if (transfer.uploadId && transfer.objectKey) {
        try {
          await abortMultipart(transfer);
        } catch (err) {
          if (err?.name !== 'NoSuchUpload') throw err;
          await deleteArchiveObject(transfer.objectKey);
        }
      } else if (transfer.objectKey) await deleteArchiveObject(transfer.objectKey);
    } catch (err) {
      logger.error({ err, sessionId: transfer._id.toString() }, 'Không thể dọn archive liên kết đã hết hạn');
      continue;
    }
    await transfer.deleteOne();
  }
}

module.exports = { createTransfer, approveTransfer, approveTransferByCode, reserveArchiveUpload, getArchivePartUploadUrl, completeArchiveUpload, getArchiveDownload, acknowledgeArchive, cleanupExpiredTransfers };
