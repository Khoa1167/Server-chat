const Block = require('../models/Block');

const isBlocked = (firstId, secondId) => Block.exists({
  $or: [
    { blocker: firstId, blocked: secondId },
    { blocker: secondId, blocked: firstId },
  ],
});

module.exports = { isBlocked };
