const sendSocketError = require('../../utils/sendSocketError');

module.exports = function registerFriendHandlers(io, socket) {
  socket.on('friend:request', async ({ receiverId, friendship }) => {
    try {
      const receiverSockets = await io.fetchSockets();
      const receiverSocket = receiverSockets.find(
        s => s.data.user?._id.toString() === receiverId
      );

      if (receiverSocket) {
        // Forward toàn bộ friendship object để client dùng được _id
        receiverSocket.emit('friend:request_received', friendship);
      }
    } catch (err) {
      sendSocketError(socket, err);
    }
  });

  // Đã bỏ handler 'friend:accepted' — client tự gửi senderId/dmRoomId không xác thực được, join room bất kỳ. Logic chuyển vào PUT /api/friends/accept/:friendshipId.
};
