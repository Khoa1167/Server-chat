// Parse "kid1:value1,kid2:value2" thành Map<kid, value> — dùng cho xoay vòng khóa theo kid
// (ENCRYPTION_KEYS trong crypto.js, cần giữ khóa cũ để đọc dữ liệu mã hóa lâu dài).
const parseKeyRing = (raw) => {
  const map = new Map();
  raw.split(',').map(s => s.trim()).filter(Boolean).forEach(pair => {
    const idx = pair.indexOf(':');
    if (idx === -1) return;
    map.set(pair.slice(0, idx), pair.slice(idx + 1));
  });
  return map;
};

module.exports = { parseKeyRing };
