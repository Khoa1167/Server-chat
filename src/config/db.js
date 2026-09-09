const mongoose = require('mongoose');
const logger = require('./logger');

const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGO_URI, {
      family: 4,
    });
    logger.info(`MongoDB connected: ${conn.connection.host}`);

    // Không có listener 'error' thì lỗi runtime sau khi connect (network drop...) sẽ throw mặc định.
    conn.connection.on('error', (err) => logger.error({ err }, '[MongoDB] Lỗi runtime'));
  } catch (error) {
    logger.error({ err: error }, 'MongoDB error');
    process.exit(1);
  }
};

module.exports = connectDB;