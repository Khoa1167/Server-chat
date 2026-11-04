const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable, Writable } = require('node:stream');
const { S3Client } = require('@aws-sdk/client-s3');
const PostMedia = require('../src/models/PostMedia');
const media = require('../src/services/postMedia.service');
const OWNER = '100000000000000000000001', ID = '400000000000000000000001';
const row = changes => ({ _id: ID, id: ID, owner: OWNER, post: null, status: 'pending', size: 32, type: 'image', mime: 'image/png', objectKey: 'posts/qa-only', uploadExpiresAt: new Date(0), ...changes });
const query = value => ({ select() { return this; }, limit() { return this; }, then: resolve => Promise.resolve(value).then(resolve) });
function config(t) {
  for (const name of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME']) {
    const previous = process.env[name]; process.env[name] = 'qa-placeholder';
    t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
  }
}

test('signed uploads bind the create-only header without signing an empty-body checksum', async t => {
  config(t);
  t.mock.method(PostMedia, 'countDocuments', async () => 0);
  t.mock.method(PostMedia, 'create', async body => row({ ...body, id: ID }));
  const result = await media.reserve(OWNER, { mime: 'image/png', size: 32 });
  const url = new URL(result.uploadUrl);
  assert.ok(url.searchParams.get('X-Amz-SignedHeaders').includes('if-none-match'));
  assert.equal(url.searchParams.has('x-amz-checksum-crc32'), false);
});

test('upload completion verifies actual object size and signature before making media available', async t => {
  config(t);
  t.mock.method(PostMedia, 'findOne', () => query(row()));
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const send = t.mock.method(S3Client.prototype, 'send', async command => command.constructor.name === 'HeadObjectCommand' ? { ContentLength: 32, ContentType: 'image/png' } : { Body: { transformToByteArray: async () => signature } });
  const update = t.mock.method(PostMedia, 'updateOne', async () => ({ matchedCount: 1 }));
  assert.equal((await media.complete(OWNER, ID)).id, ID);
  assert.equal(send.mock.calls.length, 2);
  assert.equal(send.mock.calls[1].arguments[0].input.Range, 'bytes=0-31');
  assert.deepEqual(update.mock.calls[0].arguments[0], { _id: ID, owner: OWNER, post: null, status: 'pending' });
});

test('wrong size or spoofed MIME never marks an upload ready', async t => {
  config(t);
  t.mock.method(PostMedia, 'findOne', () => query(row()));
  const update = t.mock.method(PostMedia, 'updateOne', async () => { throw new Error('must not publish'); });
  t.mock.method(S3Client.prototype, 'send', async () => ({ ContentLength: 31, ContentType: 'image/png' }));
  await assert.rejects(media.complete(OWNER, ID), { statusCode: 400 });
  t.mock.method(S3Client.prototype, 'send', async command => command.constructor.name === 'HeadObjectCommand' ? { ContentLength: 32, ContentType: 'image/png' } : { Body: { transformToByteArray: async () => Buffer.from('<html>not a png</html>') } });
  await assert.rejects(media.complete(OWNER, ID), { statusCode: 400 });
  assert.equal(update.mock.calls.length, 0);
});

test('another owner cannot complete an upload and completed uploads are idempotent', async t => {
  t.mock.method(PostMedia, 'findOne', () => query(null));
  await assert.rejects(media.complete(OWNER, ID), { statusCode: 404 });
  t.mock.method(PostMedia, 'findOne', () => query(row({ status: 'ready' })));
  const send = t.mock.method(S3Client.prototype, 'send', async () => { throw new Error('no network'); });
  assert.equal((await media.complete(OWNER, ID)).id, ID);
  assert.equal(send.mock.calls.length, 0);
});

test('deleting an upload keeps its cleanup record until the signed upload URL expires', async t => {
  config(t);
  const send = t.mock.method(S3Client.prototype, 'send', async () => ({}));
  const remove = t.mock.method(PostMedia, 'deleteOne', async () => ({}));
  t.mock.method(PostMedia, 'findOneAndUpdate', async () => row());
  await media.destroy(row({ uploadExpiresAt: new Date(Date.now() + 60000) }));
  assert.equal(send.mock.calls.length, 1);
  assert.equal(remove.mock.calls.length, 0);
  await media.destroy(row({ status: 'deleting' }));
  assert.equal(remove.mock.calls.length, 1);
});

test('cleanup does not delete media attached after its cleanup query', async t => {
  config(t);
  t.mock.method(PostMedia, 'findOneAndUpdate', async () => null);
  const send = t.mock.method(S3Client.prototype, 'send', async () => { throw new Error('must not delete'); });
  await media.destroy(row());
  assert.equal(send.mock.calls.length, 0);
});

test('protected video streaming forwards byte ranges and disables caching', async t => {
  config(t);
  const send = t.mock.method(S3Client.prototype, 'send', async () => ({ ContentLength: 3, ContentRange: 'bytes 1-3/8', Body: Readable.from([Buffer.from('abc')]) }));
  const chunks = [], headers = {};
  const res = new Writable({ write(chunk, _encoding, callback) { chunks.push(chunk); callback(); } });
  res.status = value => { res.statusCode = value; return res; };
  res.set = (name, value) => { if (typeof name === 'object') Object.assign(headers, name); else headers[name] = value; };
  await media.stream(row({ mime: 'video/mp4' }), { headers: { range: 'bytes=1-3' } }, res);
  assert.equal(res.statusCode, 206);
  assert.equal(headers['Content-Range'], 'bytes 1-3/8');
  assert.equal(headers['Cache-Control'], 'private, no-store');
  assert.equal(send.mock.calls[0].arguments[0].input.Range, 'bytes=1-3');
  assert.equal(Buffer.concat(chunks).toString(), 'abc');
  await assert.rejects(media.stream(row(), { headers: { range: 'bytes=0-1,4-5' } }, res), { statusCode: 416 });
  await assert.rejects(media.stream(row(), { headers: { range: 'bytes=9-2' } }, res), { statusCode: 416 });
  await assert.rejects(media.stream(row(), { headers: { range: 'bytes=-0' } }, res), { statusCode: 416 });
});

test('video suffix ranges used for trailing metadata are forwarded', async t => {
  config(t);
  const send = t.mock.method(S3Client.prototype, 'send', async () => ({ ContentLength: 3, ContentRange: 'bytes 5-7/8', Body: Readable.from([Buffer.from('end')]) }));
  const res = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  res.status = () => res;
  res.set = () => {};
  await media.stream(row({ mime: 'video/mp4' }), { headers: { range: 'bytes=-3' } }, res);
  assert.equal(send.mock.calls[0].arguments[0].input.Range, 'bytes=-3');
});
