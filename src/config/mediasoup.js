// Worker pool mediasoup (SFU) — mỗi Worker là 1 tiến trình OS riêng xử lý media, không đụng
// Node event loop. Số Worker mặc định bằng số CPU core (tối thiểu 1), có thể ép qua env.
const os = require('os');
const mediasoup = require('mediasoup');
const logger = require('./logger');

const NUM_WORKERS = Number(process.env.MEDIASOUP_NUM_WORKERS) || Math.max(1, os.cpus().length);
const RTC_MIN_PORT = Number(process.env.MEDIASOUP_MIN_PORT) || 40000;
const RTC_MAX_PORT = Number(process.env.MEDIASOUP_MAX_PORT) || 49999;

// Chưa dùng simulcast/SVC — Opus cho audio, VP8 cho video là đủ, giữ codec set tối thiểu.
const MEDIA_CODECS = [
  { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000, parameters: { 'x-google-start-bitrate': 1000 } },
];

let workers = [];
let nextWorkerIndex = 0;

async function initWorkers() {
  if (workers.length > 0) return;
  for (let i = 0; i < NUM_WORKERS; i++) {
    const worker = await mediasoup.createWorker({ rtcMinPort: RTC_MIN_PORT, rtcMaxPort: RTC_MAX_PORT });
    // Worker chết (crash native process) là sự kiện không phục hồi được trong tiến trình này —
    // thoát sạch qua cơ chế shutdown chung của index.js, để Docker/PM2 khởi động lại.
    worker.on('died', (err) => {
      logger.fatal({ err, pid: worker.pid }, 'mediasoup Worker chết đột ngột — server sẽ tắt');
      process.exit(1);
    });
    workers.push(worker);
  }
  logger.info(`Đã khởi tạo ${workers.length} mediasoup Worker (port range ${RTC_MIN_PORT}-${RTC_MAX_PORT})`);
}

// Round-robin — mỗi phòng gọi mới gán Worker kế tiếp, trải đều tải giữa các tiến trình.
function getNextWorker() {
  if (workers.length === 0) throw new Error('mediasoup Worker chưa được khởi tạo');
  const worker = workers[nextWorkerIndex];
  nextWorkerIndex = (nextWorkerIndex + 1) % workers.length;
  return worker;
}

async function closeWorkers() {
  await Promise.all(workers.map(w => w.close()));
  workers = [];
}

module.exports = { initWorkers, getNextWorker, closeWorkers, MEDIA_CODECS };
