const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer = require('multer');
const logger = require('./logger');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const storage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: 'chat-app/avatars',
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
    transformation: [{ width: 300, height: 300, crop: 'fill', gravity: 'face' }],
  },
});

const uploadAvatar = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
});

const coverStorage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: 'chat-app/covers',
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
    transformation: [{ width: 1200, height: 400, crop: 'fill' }],
  },
});

const roomAvatarStorage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: 'chat-app/room-avatars',
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
    transformation: [{ width: 300, height: 300, crop: 'fill' }],
  },
});

const uploadRoomAvatar = multer({
  storage: roomAvatarStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
});

const chatBackgroundStorage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: 'chat-app/chat-backgrounds',
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
    transformation: [{ width: 1920, height: 1080, crop: 'limit', quality: 'auto' }],
  },
});

const uploadChatBackground = multer({
  storage: chatBackgroundStorage,
  limits: { fileSize: 25 * 1024 * 1024 },
});

const uploadCover = multer({
  storage: coverStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
});

/**
 * Trích xuất public_id từ Cloudinary URL (bao gồm cả folder)
 * URL ví dụ: https://res.cloudinary.com/cloud_name/image/upload/v1234567890/chat-app/avatars/abc123xyz.jpg
 * Public ID trả về: "chat-app/avatars/abc123xyz"
 */
const getCloudinaryPublicId = (url) => {
  if (!url || typeof url !== 'string' || !url.includes('cloudinary.com')) return null;
  try {
    const uploadIndex = url.indexOf('/upload/');
    if (uploadIndex === -1) return null;

    const pathAfterUpload = url.substring(uploadIndex + 8);
    const parts = pathAfterUpload.split('/');

    // Bỏ qua phần version v1234567890 nếu có
    if (parts[0].startsWith('v') && !isNaN(parts[0].substring(1))) {
      parts.shift();
    }

    const fullPathWithExt = parts.join('/');
    const lastDotIndex = fullPathWithExt.lastIndexOf('.');
    if (lastDotIndex !== -1) {
      return fullPathWithExt.substring(0, lastDotIndex);
    }
    return fullPathWithExt;
  } catch (err) {
    logger.error({ err }, 'Lỗi trích xuất public_id');
    return null;
  }
};

const deleteCloudinaryImage = async (url) => {
  const publicId = getCloudinaryPublicId(url);
  if (!publicId) return;

  try {
    const result = await cloudinary.uploader.destroy(publicId);
    logger.info({ publicId, result }, '[Cloudinary Cleanup] Đã xóa ảnh cũ');
  } catch (err) {
    logger.error({ err, publicId }, '[Cloudinary Cleanup] Lỗi khi xóa ảnh');
  }
};

module.exports = {
  cloudinary,
  uploadAvatar,
  uploadCover,
  uploadRoomAvatar,
  uploadChatBackground,
  getCloudinaryPublicId,
  deleteCloudinaryImage,
};
