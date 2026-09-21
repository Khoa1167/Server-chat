const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;
const PART_SIZE = 8 * 1024 * 1024;
const MAX_PARTS = MAX_ARCHIVE_BYTES / PART_SIZE;
const UPLOAD_LEASE_MS = 10 * 60 * 1000;
const READY_LEASE_MS = 3 * 60 * 60 * 1000;

const leaseUntil = (now, deadline, duration = UPLOAD_LEASE_MS) =>
  new Date(Math.min(now.getTime() + duration, new Date(deadline).getTime()));

const expiresAfter = (usableUntil) => new Date(usableUntil.getTime() + 2 * 60 * 1000);

const validatedParts = (parts, finalPartNumber) => {
  if (!Number.isInteger(finalPartNumber) || finalPartNumber < 1 || finalPartNumber > MAX_PARTS
    || !Array.isArray(parts) || parts.length !== finalPartNumber) return null;

  let total = 0;
  const completeParts = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    const partNumber = index + 1;
    if (part?.PartNumber !== partNumber || !part.ETag || !Number.isSafeInteger(part.Size)) return null;
    const isFinal = partNumber === finalPartNumber;
    if ((!isFinal && part.Size !== PART_SIZE) || (isFinal && (part.Size < 1 || part.Size > PART_SIZE))) return null;
    total += part.Size;
    if (total > MAX_ARCHIVE_BYTES) return null;
    completeParts.push({ PartNumber: part.PartNumber, ETag: part.ETag });
  }
  return completeParts;
};

module.exports = {
  MAX_ARCHIVE_BYTES, PART_SIZE, MAX_PARTS, UPLOAD_LEASE_MS, READY_LEASE_MS,
  leaseUntil, expiresAfter, validatedParts,
};
