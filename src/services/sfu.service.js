// Quản lý Router/Transport/Producer/Consumer mediasoup theo roomId — tách khỏi socket handler để
// test độc lập (mock mediasoup.createWorker) không cần khởi động toàn bộ Socket.IO.
// RAM Map, sống trong 1 process — single-instance, giống io.fetchSockets()/rateLimiter.js
// memory fallback hiện tại.
// Require nguyên module (không destructure) — giữ mockable qua t.mock.method trong test, giống
// cách Friendship.exists/Block.exists được mock ở callHandler.test.js.
const mediasoupConfig = require('../config/mediasoup');

const MAX_PARTICIPANTS_PER_ROOM = 20;

// roomId(string) -> { router, creating: Promise|null, peers: Map<socketId, Peer> }
// Peer = { userId, transports: Map<transportId, Transport>, producers: Map<producerId, Producer>,
//          consumers: Map<consumerId, Consumer> }
const rooms = new Map();

class RoomFullError extends Error {
  constructor() { super('Phòng gọi đã đủ 20 người'); this.code = 'ROOM_FULL'; }
}
class RoomNotFoundError extends Error {
  constructor() { super('Không tìm thấy cuộc gọi trong phòng này'); this.code = 'ROOM_NOT_FOUND'; }
}
class PeerNotFoundError extends Error {
  constructor() { super('Không tìm thấy phiên trong cuộc gọi'); this.code = 'PEER_NOT_FOUND'; }
}
class ScreenShareBusyError extends Error {
  constructor() { super('Đã có người khác đang chia sẻ màn hình'); this.code = 'SCREEN_SHARE_BUSY'; }
}

// Race-safe: 2 request tạo Router cho cùng roomId gần như đồng thời (worker.createRouter là async)
// phải cùng chờ 1 Promise duy nhất, không được tạo 2 Router cho 1 phòng — đúng ràng buộc
// "1 phòng chỉ 1 cuộc gọi cùng lúc". Ghi entry vào Map NGAY (đồng bộ) trước khi await, để request
// thứ 2 đến trong lúc đang tạo thấy entry có sẵn thay vì tự tạo thêm.
function getOrCreateRoom(roomId) {
  let room = rooms.get(roomId);
  if (room) return room;

  room = { router: null, creating: null, peers: new Map(), screenSharingBy: null };
  rooms.set(roomId, room);
  room.creating = (async () => {
    const worker = mediasoupConfig.getNextWorker();
    room.router = await worker.createRouter({ mediaCodecs: mediasoupConfig.MEDIA_CODECS });
    return room.router;
  })();
  return room;
}

async function ensureRouter(roomId) {
  const room = getOrCreateRoom(roomId);
  if (!room.router) await room.creating;
  return room;
}

function getRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) throw new RoomNotFoundError();
  return room;
}

function getPeer(room, socketId) {
  const peer = room.peers.get(socketId);
  if (!peer) throw new PeerNotFoundError();
  return peer;
}

// Tham gia cuộc gọi nhóm của 1 phòng — tạo Router nếu chưa có (thành viên đầu tiên), reject nếu
// đã đủ MAX_PARTICIPANTS_PER_ROOM. Trả về rtpCapabilities để client khởi tạo mediasoup-client Device.
async function joinRoom(roomId, socketId, userId, username) {
  const room = await ensureRouter(roomId);
  if (room.peers.size >= MAX_PARTICIPANTS_PER_ROOM && !room.peers.has(socketId)) {
    throw new RoomFullError();
  }
  if (!room.peers.has(socketId)) {
    room.peers.set(socketId, {
      userId,
      username,
      transports: new Map(),
      producers: new Map(),
      consumers: new Map(),
    });
  }
  return { rtpCapabilities: room.router.rtpCapabilities };
}

async function createWebRtcTransport(roomId, socketId, { listenIp, announcedIp } = {}) {
  const room = getRoom(roomId);
  const peer = getPeer(room, socketId);

  const transport = await room.router.createWebRtcTransport({
    listenIps: [{ ip: listenIp || '0.0.0.0', announcedIp: announcedIp || undefined }],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    initialAvailableOutgoingBitrate: 1000000,
  });
  peer.transports.set(transport.id, transport);

  transport.on('dtlsstatechange', (state) => {
    if (state === 'closed' || state === 'failed') transport.close();
  });

  return {
    id: transport.id,
    iceParameters: transport.iceParameters,
    iceCandidates: transport.iceCandidates,
    dtlsParameters: transport.dtlsParameters,
  };
}

async function connectTransport(roomId, socketId, transportId, dtlsParameters) {
  const room = getRoom(roomId);
  const peer = getPeer(room, socketId);
  const transport = peer.transports.get(transportId);
  if (!transport) throw new PeerNotFoundError();
  await transport.connect({ dtlsParameters });
}

async function produce(roomId, socketId, transportId, kind, rtpParameters) {
  const room = getRoom(roomId);
  const peer = getPeer(room, socketId);
  const transport = peer.transports.get(transportId);
  if (!transport) throw new PeerNotFoundError();

  const producer = await transport.produce({ kind, rtpParameters });
  peer.producers.set(producer.id, producer);
  return producer.id;
}

// canConsume phải check trước — client không hỗ trợ codec của producer thì consumer tạo ra sẽ chết.
async function consume(roomId, socketId, transportId, producerId, rtpCapabilities) {
  const room = getRoom(roomId);
  const peer = getPeer(room, socketId);
  const transport = peer.transports.get(transportId);
  if (!transport) throw new PeerNotFoundError();
  if (!room.router.canConsume({ producerId, rtpCapabilities })) {
    throw new Error('Thiết bị không hỗ trợ codec của luồng media này');
  }

  const consumer = await transport.consume({
    producerId,
    rtpCapabilities,
    paused: true, // client resume sau khi gắn track vào thẻ <video>/<audio> để tránh mất frame đầu
  });
  peer.consumers.set(consumer.id, consumer);

  return {
    id: consumer.id,
    producerId,
    kind: consumer.kind,
    rtpParameters: consumer.rtpParameters,
  };
}

async function resumeConsumer(roomId, socketId, consumerId) {
  const room = getRoom(roomId);
  const peer = getPeer(room, socketId);
  const consumer = peer.consumers.get(consumerId);
  if (!consumer) throw new PeerNotFoundError();
  await consumer.resume();
}

// Danh sách producer đang có của các peer khác — client mới join dùng để tự consume các track sẵn có.
function listOtherProducers(roomId, socketId) {
  const room = getRoom(roomId);
  const result = [];
  for (const [peerSocketId, peer] of room.peers) {
    if (peerSocketId === socketId) continue;
    for (const producer of peer.producers.values()) {
      result.push({ producerId: producer.id, kind: producer.kind, userId: peer.userId, username: peer.username });
    }
  }
  return result;
}

// Dọn toàn bộ transport/producer/consumer của 1 participant khi rời/disconnect. Đóng Router và xóa
// phòng khỏi Map khi participant cuối cùng rời — đúng vòng đời "1 phòng 1 cuộc gọi tại 1 thời điểm".
function leaveRoom(roomId, socketId) {
  const room = rooms.get(roomId);
  if (!room) return;
  const peer = room.peers.get(socketId);
  if (!peer) return;

  peer.consumers.forEach(c => c.close());
  peer.producers.forEach(p => p.close());
  peer.transports.forEach(t => t.close());
  room.peers.delete(socketId);
  if (room.screenSharingBy === socketId) room.screenSharingBy = null;

  if (room.peers.size === 0) {
    room.router?.close();
    rooms.delete(roomId);
  }
}

function getParticipantCount(roomId) {
  return rooms.get(roomId)?.peers.size || 0;
}

// Bị kick/rời phòng hoặc phòng bị xóa trong lúc đang gọi nhóm — quyền vào call chỉ được check ở
// lúc call:group-join, nếu không chủ động ngắt ở đây thì user mất quyền thành viên vẫn tiếp tục
// nghe/xem media cho tới khi tự thoát. Trả về danh sách socketId đã bị ngắt để tầng gọi (rooms.service)
// báo lại đúng socket đó rời khỏi UI cuộc gọi.
function forceLeaveRoomForUser(roomId, userId) {
  const room = rooms.get(roomId);
  if (!room) return [];
  const uidStr = userId.toString();
  const affectedSocketIds = [];
  for (const [socketId, peer] of room.peers) {
    if (peer.userId === uidStr) affectedSocketIds.push(socketId);
  }
  affectedSocketIds.forEach(socketId => leaveRoom(roomId, socketId));
  return affectedSocketIds;
}

// Lock 1 người share màn hình/phòng tại 1 thời điểm — quyết định sản phẩm, không phải giới hạn kỹ
// thuật. Giữ đơn giản bằng 1 field thay vì hàng đợi/booking phức tạp.
function startScreenShare(roomId, socketId) {
  const room = getRoom(roomId);
  getPeer(room, socketId);
  if (room.screenSharingBy && room.screenSharingBy !== socketId) throw new ScreenShareBusyError();
  room.screenSharingBy = socketId;
}

function stopScreenShare(roomId, socketId) {
  const room = rooms.get(roomId);
  if (room?.screenSharingBy === socketId) room.screenSharingBy = null;
}

module.exports = {
  MAX_PARTICIPANTS_PER_ROOM,
  RoomFullError,
  RoomNotFoundError,
  PeerNotFoundError,
  ScreenShareBusyError,
  joinRoom,
  createWebRtcTransport,
  connectTransport,
  produce,
  consume,
  resumeConsumer,
  listOtherProducers,
  leaveRoom,
  getParticipantCount,
  forceLeaveRoomForUser,
  startScreenShare,
  stopScreenShare,
  _rooms: rooms, // dùng cho test — reset/kiểm tra state trực tiếp
};
