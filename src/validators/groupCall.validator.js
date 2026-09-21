// Validate input tại boundary cho các event gọi nhóm (mediasoup) — không cần hiểu sâu cấu trúc
// SDP/DTLS/RTP, chỉ chặn shape sai và payload quá khổ trước khi đưa vào mediasoup (chính mediasoup
// sẽ tự từ chối payload sai định dạng chi tiết hơn, đây là lớp chặn abuse/DoS ở boundary).
const MAX_PAYLOAD_JSON_LENGTH = 32 * 1024; // rtpCapabilities/rtpParameters thật sự chỉ vài KB

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

const isBoundedObject = (value) => {
  if (!isPlainObject(value)) return false;
  try {
    return JSON.stringify(value).length <= MAX_PAYLOAD_JSON_LENGTH;
  } catch {
    return false;
  }
};

const isNonEmptyString = (value, maxLength = 256) =>
  typeof value === 'string' && value.length > 0 && value.length <= maxLength;

const isValidMediaKind = (value) => value === 'audio' || value === 'video';

module.exports = {
  isBoundedObject,
  isNonEmptyString,
  isValidMediaKind,
};
