const MAX_MESSAGES_PER_EPOCH = 100;
const MAX_EPOCH_AGE_MS = 14 * 24 * 60 * 60 * 1000;

function shouldRotateSenderKeyEpoch({ messageCount, startedAt }, now = Date.now()) {
  return messageCount >= MAX_MESSAGES_PER_EPOCH
    || now - new Date(startedAt).getTime() >= MAX_EPOCH_AGE_MS;
}

module.exports = { MAX_MESSAGES_PER_EPOCH, shouldRotateSenderKeyEpoch };
