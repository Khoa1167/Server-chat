const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_ARCHIVE_BYTES, MAX_PARTS, PART_SIZE, expiresAfter, leaseUntil, validatedParts,
} = require('../src/services/deviceLinkArchive');

test('validates contiguous multipart parts and rejects malformed archives', () => {
  const valid = validatedParts([
    { PartNumber: 1, ETag: 'one', Size: PART_SIZE },
    { PartNumber: 2, ETag: 'two', Size: 12 },
  ], 2);
  assert.deepEqual(valid, [{ PartNumber: 1, ETag: 'one' }, { PartNumber: 2, ETag: 'two' }]);
  assert.equal(validatedParts([{ PartNumber: 2, ETag: 'two', Size: 12 }], 1), null);
  assert.equal(validatedParts([{ PartNumber: 1, ETag: 'one', Size: PART_SIZE - 1 }, { PartNumber: 2, ETag: 'two', Size: 12 }], 2), null);
  assert.equal(validatedParts([], MAX_PARTS + 1), null);
  assert.equal(MAX_PARTS * PART_SIZE, MAX_ARCHIVE_BYTES);
});

test('caps transfer leases and gives cleanup time after expiry', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');
  const deadline = new Date('2026-01-01T00:05:00.000Z');
  const usableUntil = leaseUntil(now, deadline);
  assert.equal(usableUntil.getTime(), deadline.getTime());
  assert.equal(expiresAfter(usableUntil).getTime(), deadline.getTime() + 2 * 60 * 1000);
});
