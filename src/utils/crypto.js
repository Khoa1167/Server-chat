const crypto = require('crypto');
const logger = require('../config/logger');
const { parseKeyRing } = require('./keyRing');

// Xoay vòng ENCRYPTION_KEY theo kid (xem keyRing.js) — đổi key không mất khả năng đọc dữ liệu cũ.
const toMasterKey = (hexKey) => {
  try {
    const key = Buffer.from(hexKey, 'hex');
    if (key.length !== 32) throw new Error();
    return key;
  } catch {
    return crypto.scryptSync(hexKey, 'master_salt', 32);
  }
};

const buildKeyRing = () => {
  if (process.env.ENCRYPTION_KEYS) {
    const raw = parseKeyRing(process.env.ENCRYPTION_KEYS);
    const currentKid = process.env.ENCRYPTION_KEY_CURRENT_KID;
    if (!currentKid || !raw.has(currentKid)) {
      throw new Error('ENCRYPTION_KEY_CURRENT_KID không khớp bất kỳ kid nào trong ENCRYPTION_KEYS.');
    }
    const keyRing = new Map([...raw].map(([kid, hexKey]) => [kid, toMasterKey(hexKey)]));
    return { keyRing, currentKid };
  }

  // Tương thích ngược: chưa cấu hình keyring mới thì dùng ENCRYPTION_KEY cũ làm keyring 1 phần tử.
  // Thiếu key phải crash lúc khởi động, không fallback hard-code.
  if (process.env.ENCRYPTION_KEY) {
    return { keyRing: new Map([['k1', toMasterKey(process.env.ENCRYPTION_KEY)]]), currentKid: 'k1' };
  }

  throw new Error(
    'Thiếu ENCRYPTION_KEYS (mới) hoặc ENCRYPTION_KEY (cũ) trong .env — bắt buộc để mã hóa PII/report. ' +
    'Tạo key ngẫu nhiên bằng: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
  );
};

const { keyRing: MASTER_KEY_RING, currentKid: CURRENT_KID } = buildKeyRing();

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 12 bytes cho AES-GCM

// Key Derivation Isolation: 3 key riêng cho 3 mục đích bảo mật, derive theo từng kid trong keyring.
const deriveSubKeys = (masterKey) => ({
  pii:        crypto.scryptSync(masterKey, 'pii_account_salt_2026', 32),
  report:     crypto.scryptSync(masterKey, 'report_content_salt_2026', 32),
  blindIndex: crypto.scryptSync(masterKey, 'blind_index_salt_2026', 32),
  mfa:        crypto.scryptSync(masterKey, 'mfa_secret_salt_2026', 32),
});

const SUB_KEY_RING = new Map([...MASTER_KEY_RING].map(([kid, master]) => [kid, deriveSubKeys(master)]));
const CURRENT = SUB_KEY_RING.get(CURRENT_KID);

const encryptWith = (purpose, text) => {
  if (!text) return '';
  const strVal = String(text).trim();
  if (!strVal) return '';
  // Idempotent: không mã hóa lại giá trị đã mã hóa (nhận diện cả định dạng mới có kid lẫn cũ).
  if (isEncrypted(strVal)) return strVal;
  try {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, CURRENT[purpose], iv);
    let encrypted = cipher.update(strVal, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const tag = cipher.getAuthTag().toString('hex');
    return `${CURRENT_KID}:${iv.toString('hex')}:${tag}:${encrypted}`;
  } catch (err) {
    logger.error({ err }, `[Crypto] Encrypt ${purpose} error`);
    return strVal;
  }
};

const decryptOnce = (purpose, subKeys, ivHex, tagHex, ciphertextHex) => {
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, subKeys[purpose], iv);
  decipher.setAuthTag(tag);
  let decrypted = decipher.update(ciphertextHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
};

const decryptWith = (purpose, encryptedText) => {
  if (!encryptedText || typeof encryptedText !== 'string') return encryptedText || '';
  if (!encryptedText.includes(':')) return encryptedText;

  const parts = encryptedText.split(':');

  try {
    // Định dạng mới kid:iv:tag:ciphertext — tra thẳng đúng key trong ring.
    if (parts.length === 4 && parts[1].length === IV_LENGTH * 2 && parts[2].length === 32) {
      const [kid, ivHex, tagHex, ciphertextHex] = parts;
      const subKeys = SUB_KEY_RING.get(kid);
      if (!subKeys) {
        logger.error({ kid }, `[Crypto] Decrypt ${purpose} error: kid không còn trong ENCRYPTION_KEYS`);
        return encryptedText;
      }
      return decryptOnce(purpose, subKeys, ivHex, tagHex, ciphertextHex);
    }

    // Định dạng cũ iv:tag:ciphertext (trước rotation) — không biết key nào, thử lần lượt trong keyring.
    if (parts.length === 3 && parts[0].length === IV_LENGTH * 2 && parts[1].length === 32) {
      const [ivHex, tagHex, ciphertextHex] = parts;
      for (const subKeys of SUB_KEY_RING.values()) {
        try {
          return decryptOnce(purpose, subKeys, ivHex, tagHex, ciphertextHex);
        } catch {
          // thử key kế tiếp
        }
      }
    }
  } catch (err) {
    logger.error({ err }, `[Crypto] Decrypt ${purpose} error`);
  }
  return encryptedText;
};

const isEncrypted = (strVal) => {
  if (!strVal.includes(':')) return false;
  const parts = strVal.split(':');
  if (parts.length === 4 && parts[1].length === IV_LENGTH * 2 && parts[2].length === 32) return true;
  if (parts.length === 3 && parts[0].length === IV_LENGTH * 2 && parts[1].length === 32) return true;
  return false;
};

/** Mã hóa dữ liệu PII (Số điện thoại, Ngày sinh...) */
const encryptPII = (text) => encryptWith('pii', text);
/** Giải mã dữ liệu PII */
const decryptPII = (encryptedText) => decryptWith('pii', encryptedText);

/** Mã hóa nội dung giải mã của Report bằng key riêng biệt */
const encryptReportContent = (text) => encryptWith('report', text);
/** Giải mã nội dung Report */
const decryptReportContent = (encryptedText) => decryptWith('report', encryptedText);

const encryptMfaSecret = (text) => {
  const encrypted = encryptWith('mfa', text);
  if (!isEncrypted(encrypted)) throw new Error('Không thể mã hóa TOTP secret');
  return encrypted;
};
const decryptMfaSecret = (encryptedText) => decryptWith('mfa', encryptedText);

const hashMfaValue = (text) =>
  crypto.createHmac('sha256', CURRENT.mfa).update(String(text)).digest('hex');

const hashMfaValueAllKeys = (text) =>
  [...SUB_KEY_RING.values()].map(subKeys =>
    crypto.createHmac('sha256', subKeys.mfa).update(String(text)).digest('hex')
  );

/** Blind Index (HMAC-SHA256) bằng key hiện tại — dùng khi GHI (tạo/cập nhật record) */
const hashBlindIndex = (text) => {
  if (!text) return '';
  const normalized = String(text).trim().toLowerCase();
  return crypto.createHmac('sha256', CURRENT.blindIndex).update(normalized).digest('hex');
};

// Blind Index tính bằng TẤT CẢ key trong ring — dùng khi tra cứu để vẫn khớp record cũ chưa
// re-encrypt. Query nên dùng { $in: hashBlindIndexAllKeys(x) }.
const hashBlindIndexAllKeys = (text) => {
  if (!text) return [];
  const normalized = String(text).trim().toLowerCase();
  return [...SUB_KEY_RING.values()].map(subKeys =>
    crypto.createHmac('sha256', subKeys.blindIndex).update(normalized).digest('hex')
  );
};

module.exports = {
  encryptPII,
  decryptPII,
  encryptReportContent,
  decryptReportContent,
  encryptMfaSecret,
  decryptMfaSecret,
  hashMfaValue,
  hashMfaValueAllKeys,
  hashBlindIndex,
  hashBlindIndexAllKeys,
};
