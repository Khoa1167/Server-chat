const { cloudinary } = require('../config/cloudinary');
const { Readable } = require('stream');

// resource_type 'raw' vì đây luôn là ciphertext E2EE — Cloudinary không decode/transform được, bất kể loại đính kèm.
function uploadToCloudinary(fileBuffer, folder) {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      { folder, resource_type: 'raw' },
      (error, result) => {
        if (error) return reject(error);
        resolve(result);
      }
    );
    const readable = new Readable();
    readable._read = () => {};
    readable.push(fileBuffer);
    readable.push(null);
    readable.pipe(uploadStream);
  });
}

module.exports = { uploadToCloudinary };
