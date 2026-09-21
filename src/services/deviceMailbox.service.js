const DeviceMailbox = require('../models/DeviceMailbox');
const User = require('../models/User');

async function recipientDeviceIds(memberIds, excludedDeviceId) {
  const users = await User.find({ _id: { $in: memberIds } }).select('devices');
  return users.flatMap(user => user.devices)
    .filter(device => !device.isRevoked && device.tokenHash && device.deviceId !== excludedDeviceId)
    .map(device => device.deviceId);
}

async function queueRoomEvent(io, memberIds, excludedDeviceId, event, payload) {
  const deviceIds = await recipientDeviceIds(memberIds, excludedDeviceId);
  if (!deviceIds.length) return;
  const entries = await DeviceMailbox.insertMany(deviceIds.map(recipientDeviceId => ({ recipientDeviceId, event, payload })));
  const entryByDevice = new Map(entries.map(entry => [entry.recipientDeviceId, entry._id.toString()]));
  const sockets = await io.fetchSockets();
  sockets.filter(socket => deviceIds.includes(socket.data.deviceId)).forEach(socket => {
    socket.emit('mailbox:event', { id: entryByDevice.get(socket.data.deviceId), event, payload });
  });
}

function mailboxPageLimit(limit) {
  const value = Number(limit);
  return Number.isInteger(value) && value > 0 ? Math.min(value, 100) : 100;
}

async function pullMailbox(socket, { cursor, limit } = {}) {
  const query = { recipientDeviceId: socket.data.deviceId, expiresAt: { $gt: new Date() } };
  if (cursor) {
    if (typeof cursor !== 'object' || typeof cursor.id !== 'string' || !/^[a-f\d]{24}$/i.test(cursor.id)) {
      throw new Error('Mailbox cursor không hợp lệ');
    }
    const createdAt = new Date(cursor.createdAt);
    if (Number.isNaN(createdAt.getTime())) throw new Error('Mailbox cursor không hợp lệ');
    query.$or = [
      { createdAt: { $gt: createdAt } },
      { createdAt, _id: { $gt: cursor.id } },
    ];
  }
  const pageSize = mailboxPageLimit(limit);
  const records = await DeviceMailbox.find(query).sort({ createdAt: 1, _id: 1 }).limit(pageSize + 1).lean();
  const entries = records.slice(0, pageSize);
  const last = entries.at(-1);
  return {
    entries: entries.map(entry => ({ id: entry._id.toString(), event: entry.event, payload: entry.payload })),
    hasMore: records.length > pageSize,
    nextCursor: records.length > pageSize && last ? { createdAt: last.createdAt.toISOString(), id: last._id.toString() } : null,
  };
}

async function acknowledgeMailbox(socket, id) {
  if (typeof id !== 'string' || !id) return;
  await DeviceMailbox.deleteOne({ _id: id, recipientDeviceId: socket.data.deviceId });
}

module.exports = { queueRoomEvent, pullMailbox, acknowledgeMailbox };
