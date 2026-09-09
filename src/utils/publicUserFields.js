// Tập field "an toàn public" của User dùng trong .populate()/.select() — sửa 1 nơi, khỏi lệch.
const MINIMAL = 'username nickname';
const BASIC = 'username nickname avatar';
// privacySettings.activityStatus đi kèm để presenceVisibility.js mask — nơi dùng WITH_STATUS phải
// tự mask trước khi trả client (xem maskMemberPresence()).
const WITH_STATUS = `${BASIC} isOnline privacySettings.activityStatus privacySettings.readReceipts`;
const WITH_STATUS_LASTSEEN = `${WITH_STATUS} lastSeen`;

module.exports = { MINIMAL, BASIC, WITH_STATUS, WITH_STATUS_LASTSEEN };
