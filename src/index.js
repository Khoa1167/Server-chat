require('dotenv').config();
const express = require('express');
const http = require('http');
const mongoose = require('mongoose');
const { Server } = require('socket.io');
const cors = require('cors');
const connectDB = require('./config/db');
const setupSocket = require('./socket');
const sanitizeMongo = require('./middleware/sanitize');
const { parseCookies, issueCsrfCookie, verifyCsrf } = require('./middleware/csrf');
const redisClient = require('./config/redis');
const { initWorkers, closeWorkers } = require('./config/mediasoup');
const logger = require('./config/logger');
const pinoHttp = require('pino-http');
const sendServerError = require('./utils/sendServerError');
const { cleanupExpiredTransfers } = require('./services/deviceLink.service');
const { cleanupExpiredAttachments } = require('./services/attachments.service');
const { purgeExpiredAccountDeletions } = require('./services/accountDeletion.service');

const app = express();
const server = http.createServer(app);
app.disable('x-powered-by');

// req.ip đọc đúng IP thật sau reverse proxy — chỉ bật khi thật sự có đúng số hop proxy (TRUST_PROXY_HOPS), bật sai sẽ cho giả mạo IP qua X-Forwarded-For.
const trustProxyHops = parseInt(process.env.TRUST_PROXY_HOPS || '0', 10);
if (trustProxyHops > 0) {
  app.set('trust proxy', trustProxyHops);
}

const clientOrigins = process.env.CLIENT_URL
  ? process.env.CLIENT_URL.split(',').map(url => url.trim())
  : [];

const io = new Server(server, {
  cors: { origin: clientOrigins, methods: ['GET', 'POST'], credentials: true },
});

app.set('socketio', io);

connectDB();
initWorkers().catch(err => {
  logger.fatal({ err }, 'Không thể khởi tạo mediasoup Worker — gọi nhóm sẽ không hoạt động');
  process.exit(1);
});

// Middleware
app.use(cors({ origin: clientOrigins, credentials: true }));
// Log có cấu trúc mỗi request (req.id để trace xuyên suốt 1 request qua nhiều dòng log) — bỏ qua
// '/health' để không rác log mỗi lần Docker healthcheck gọi (mỗi vài giây).
app.use(pinoHttp({
  logger,
  autoLogging: { ignore: (req) => req.url === '/health' },
}));
app.use(express.json());
app.use(sanitizeMongo);
app.use(parseCookies);
app.use(issueCsrfCookie);
app.use(verifyCsrf);

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

// API routes không được cache (dữ liệu động, có thể chứa thông tin nhạy cảm)
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// Routes — chỉ đăng ký 1 lần, trước server.listen()
app.use('/api/auth', require('./routes/auth.routes'));
app.use('/api/users', require('./routes/users.routes'));
app.use('/api/rooms', require('./routes/rooms.routes'));
app.use('/api/friends', require('./routes/friends.routes'));
app.use('/api/reports', require('./routes/report.routes'));
app.use('/api/security', require('./routes/security.routes'));
app.use('/api/admin', require('./routes/admin.routes'));
app.use('/api/notifications', require('./routes/notifications.routes'));

app.get('/', (req, res) => {
  res.json({ message: '🚀 Chat server đang chạy!' });
});

// Health/readiness check cho Docker healthcheck, load balancer... — kiểm tra thật sự kết nối
// được Mongo (nguồn dữ liệu bắt buộc) chứ không chỉ "process còn sống" như route '/' ở trên.
app.get('/health', (req, res) => {
  const mongoConnected = mongoose.connection.readyState === 1; // 1 = connected
  res.status(mongoConnected ? 200 : 503).json({
    status: mongoConnected ? 'ok' : 'unavailable',
    mongo: mongoConnected ? 'connected' : 'disconnected',
    redis: redisClient ? redisClient.status : 'disabled',
  });
});

// Global error handler — bắt lỗi Express 5 forward qua next(err), đi qua sendServerError thay vì default handler. Phải đăng ký sau mọi route.
app.use((err, req, res, next) => {
  sendServerError(res, err);
});

setupSocket(io);

cleanupExpiredTransfers().catch(err => logger.error({ err }, 'Không thể dọn archive liên kết thiết bị'));
cleanupExpiredAttachments().catch(err => logger.error({ err }, 'Không thể dọn attachment hết hạn'));
const deviceLinkCleanupTimer = setInterval(() => {
  cleanupExpiredTransfers().catch(err => logger.error({ err }, 'Không thể dọn archive liên kết thiết bị'));
  cleanupExpiredAttachments().catch(err => logger.error({ err }, 'Không thể dọn attachment hết hạn'));
  purgeExpiredAccountDeletions(io).catch(err => logger.error({ err }, 'Không thể purge tài khoản hết hạn xóa'));
}, 60 * 1000);
deviceLinkCleanupTimer.unref();

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  logger.info(`🚀 Server chạy tại http://localhost:${PORT}`);
});

// Graceful shutdown — đóng HTTP server + Mongo/Redis sạch trước khi thoát, tránh request dở bị cắt ngang.
const shutdown = async (signal, exitCode = 0) => {
  logger.info(`${signal} nhận được, đang tắt server...`);
  server.close(() => logger.info('HTTP server đã đóng'));
  await closeWorkers();
  logger.info('Đã đóng mediasoup Worker');
  await mongoose.connection.close();
  logger.info('Đã đóng kết nối MongoDB');
  if (redisClient) {
    await redisClient.quit();
    logger.info('Đã đóng kết nối Redis');
  }
  process.exit(exitCode);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Lỗi không ai catch — process không còn tin cậy được nữa, log rồi thoát sạch qua shutdown(); Docker lo khởi động lại.
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception — server sẽ tắt');
  shutdown('uncaughtException', 1);
});
process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'Unhandled promise rejection — server sẽ tắt');
  shutdown('unhandledRejection', 1);
});
