const test = require('node:test');
const assert = require('node:assert/strict');
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.JWT_SECRET ||= 'posts-test-placeholder';
const mongoose = require('mongoose');
const access = require('../src/services/postAccess.service');
const service = require('../src/services/posts.service');
const v = require('../src/validators/posts.validator');
const Post = require('../src/models/Post');
const PostMedia = require('../src/models/PostMedia');
const PostComment = require('../src/models/PostComment');
const PostReaction = require('../src/models/PostReaction');
const PostUserState = require('../src/models/PostUserState');
const PostReport = require('../src/models/PostReport');
const Notification = require('../src/models/Notification');
const U = '100000000000000000000001', A = '100000000000000000000002', P = '200000000000000000000001', C = '300000000000000000000001', M = '400000000000000000000001';
const ctx = { user: U, friends: new Set([A]), blocked: new Set() };
const post = (changes = {}) => ({ _id: P, author: { _id: A, nickname: 'Test' }, content: 'hello', audience: 'friends', status: 'active', media: [], __v: 0, ...changes });
const query = value => ({ populate() { return this; }, select() { return this; }, sort() { return this; }, limit() { return this; }, lean: async () => value, then: resolve => Promise.resolve(value).then(resolve) });
function decorationMocks(t, result) {
  t.mock.method(access, 'context', async () => ctx);
  t.mock.method(access, 'requirePost', async () => result);
  for (const model of [Post, PostMedia, PostUserState, PostReaction]) t.mock.method(model, 'find', () => query([]));
  for (const model of [Post, PostComment, PostReaction]) t.mock.method(model, 'aggregate', async () => []);
}

test('creating a post activates it only after every media claim, and retry does not create a duplicate', async t => {
  const result = post({ author: { _id: U }, clientId: 'create-12345', status: 'active' });
  decorationMocks(t, result);
  t.mock.method(Post, 'findOne', async () => null);
  const create = t.mock.method(Post, 'create', async body => ({ ...result, ...body, _id: P }));
  const writes = [];
  t.mock.method(PostMedia, 'findOneAndUpdate', async filter => { writes.push('claim'); return { _id: filter._id }; });
  t.mock.method(Post, 'findOneAndUpdate', async () => { writes.push('activate'); return result; });
  const body = { content: 'hello', audience: 'friends', media: [M], clientId: 'create-12345' };
  assert.equal((await service.create(U, body))._id, P);
  assert.deepEqual(writes, ['claim', 'activate']);
  t.mock.method(Post, 'findOne', async () => result);
  assert.equal((await service.create(U, body))._id, P);
  assert.equal(create.mock.calls.length, 1);
});

test('invalid media rolls back a publishing post so the user can correct and retry', async t => {
  t.mock.method(access, 'context', async () => ctx);
  t.mock.method(Post, 'findOne', async () => null);
  t.mock.method(Post, 'create', async () => ({ _id: P, media: [M] }));
  t.mock.method(PostMedia, 'findOneAndUpdate', async () => null);
  const remove = t.mock.method(Post, 'deleteOne', async () => ({}));
  const release = t.mock.method(PostMedia, 'updateMany', async () => ({}));
  await assert.rejects(service.create(U, { content: '', audience: 'friends', media: [M], clientId: 'invalid-123' }), { statusCode: 400 });
  assert.deepEqual(remove.mock.calls[0].arguments[0], { _id: P, status: 'publishing' });
  assert.deepEqual(release.mock.calls[0].arguments, [{ post: P, status: 'ready' }, { post: null }]);
});

test('retry after a committed edit returns it despite the old version', async t => {
  const result = post({ author: { _id: U }, __v: 1, lastEditId: 'edit-12345' });
  decorationMocks(t, result);
  t.mock.method(Post, 'findOne', async () => result);
  assert.equal((await service.edit(U, P, { content: 'hello', audience: 'friends', media: [], version: 0, clientId: 'edit-12345' })).version, 1);
});

test('post access checks audience, blocks in either direction, inactive authors and deleted posts', () => {
  assert.equal(access.visible(post(), ctx), true);
  assert.equal(access.visible(post({ audience: 'private' }), ctx), false);
  assert.equal(access.visible(post({ audience: 'public' }), { ...ctx, friends: new Set() }), true);
  assert.equal(access.visible(post(), { ...ctx, friends: new Set() }), false);
  assert.equal(access.visible(post({ audience: 'public' }), { ...ctx, blocked: new Set([A]) }), false);
  assert.equal(access.visible(post({ author: { _id: A, isDeleted: true } }), ctx), false);
  assert.equal(access.visible(post({ author: { _id: A, isBanned: true } }), ctx), false);
  assert.equal(access.visible(post({ author: { _id: A, pendingDeletionAt: new Date() } }), ctx), false);
  assert.equal(access.visible(post({ status: 'deleted' }), ctx), false);
  assert.equal(access.visible(post({ audience: 'private', author: { _id: U } }), ctx), true);
});

test('post validator rejects query objects, invalid audiences, empty posts, duplicate media and oversized content', () => {
  const body = { content: ' test ', audience: 'friends', media: [], clientId: 'test-12345678' };
  assert.equal(v.post(body).content, 'test');
  for (const change of [{ content: '' }, { audience: 'everyone' }, { media: [M, M] }, { content: 'x'.repeat(10001) }, { original: { $ne: null } }, { clientId: '../unsafe' }]) assert.throws(() => v.post({ ...body, ...change }), { statusCode: 400 });
  assert.throws(() => v.post({ ...body, version: '0' }, true), { statusCode: 400 });
  assert.throws(() => v.id({ $ne: null }), { statusCode: 400 });
});

test('media signatures are verified against actual bytes instead of MIME alone', () => {
  assert.equal(v.matchesSignature('image/png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), true);
  assert.equal(v.matchesSignature('image/jpeg', Buffer.from([255, 216, 255, 224])), true);
  assert.equal(v.matchesSignature('video/mp4', Buffer.from('0000ftypisom')), true);
  assert.equal(v.matchesSignature('image/webp', Buffer.from('RIFF0000WEBP')), true);
  for (const mime of ['image/png', 'video/mp4', 'image/jpeg', 'image/svg+xml']) assert.equal(v.matchesSignature(mime, Buffer.from('<script>alert(1)</script>')), false);
});

test('a public share never authorizes an inaccessible original', async t => {
  t.mock.method(Post, 'findById', id => query(id === P ? post({ audience: 'public', original: C }) : post({ _id: C, audience: 'private' })));
  await assert.rejects(access.requirePost(P, ctx), { statusCode: 404 });
  const wrapper = await access.requirePost(P, ctx, { allowUnavailableOriginal: true });
  assert.equal(wrapper._id, P);
});

test('direct media access rechecks post audience and current media membership', async t => {
  t.mock.method(access, 'context', async () => ctx);
  t.mock.method(PostMedia, 'findOne', () => query({ _id: M, post: P, owner: A }));
  t.mock.method(access, 'requirePost', async () => post());
  await assert.rejects(service.getMedia(U, M), { statusCode: 404 });
  t.mock.method(access, 'requirePost', async () => post({ media: [M] }));
  assert.equal((await service.getMedia(U, M))._id, M);
  t.mock.method(access, 'requirePost', async () => { throw Object.assign(new Error('private'), { statusCode: 404 }); });
  await assert.rejects(service.getMedia(U, M), { statusCode: 404 });
});

test('resolve batch does not return private, blocked or deleted posts', async t => {
  t.mock.method(access, 'context', async () => ctx);
  t.mock.method(Post, 'find', () => query([post({ audience: 'private' }), post({ _id: C, status: 'deleted' })]));
  assert.deepEqual(await service.resolve(U, { ids: `${P},${C}` }), []);
});

test('editing another author or a stale version cannot claim media or mutate a post', async t => {
  const body = { content: 'edit', audience: 'public', media: [M], version: 0, clientId: 'edit-12345' };
  const claim = t.mock.method(PostMedia, 'findOneAndUpdate', async () => { throw new Error('must not claim'); });
  t.mock.method(Post, 'findOne', async () => null);
  await assert.rejects(service.edit(U, P, body), { statusCode: 404 });
  t.mock.method(Post, 'findOne', async () => post({ author: U, __v: 1 }));
  await assert.rejects(service.edit(U, P, body), { statusCode: 409 });
  assert.equal(claim.mock.calls.length, 0);
});

test('duplicate comment clientId returns the original comment instead of adding another', async t => {
  t.mock.method(access, 'context', async () => ctx);
  t.mock.method(access, 'requirePost', async () => post());
  const create = t.mock.method(PostComment, 'create', async () => { throw Object.assign(new Error('duplicate'), { code: 11000 }); });
  const comment = { _id: C, post: P, author: { _id: U }, content: 'once', deleted: false, createdAt: new Date() };
  t.mock.method(PostComment, 'findOne', () => query(comment));
  t.mock.method(PostComment, 'aggregate', async () => []);
  t.mock.method(PostReaction, 'aggregate', async () => []);
  t.mock.method(PostReaction, 'find', () => query([]));
  assert.equal((await service.addComment(U, P, { content: 'once', clientId: 'once-12345' })).content, 'once');
  assert.equal(create.mock.calls.length, 1);
});

test('comment deletion by a reader is constrained to their own author id', async t => {
  t.mock.method(access, 'context', async () => ctx);
  t.mock.method(access, 'requirePost', async () => post());
  const write = t.mock.method(PostComment, 'findOneAndUpdate', async () => null);
  await assert.rejects(service.deleteComment(U, P, C), { statusCode: 404 });
  assert.deepEqual(write.mock.calls[0].arguments[0], { _id: C, post: P, author: U });
});

test('invalid reactions and client-supplied state fields are rejected', async t => {
  t.mock.method(access, 'context', async () => ctx);
  t.mock.method(access, 'requirePost', async () => post());
  await assert.rejects(service.react(U, P, null, 'admin'), { statusCode: 400 });
  await assert.rejects(service.setState(U, P, { saved: 'true' }), { statusCode: 400 });
  await assert.rejects(service.setState(U, P, { saved: true, user: A }), { statusCode: 400 });
});

test('moderation media only resolves objects belonging to the reported post', async t => {
  t.mock.method(PostReport, 'findById', () => query({ post: P }));
  const find = t.mock.method(PostMedia, 'findOne', () => query(null));
  await assert.rejects(service.getReportMedia(C, M), { statusCode: 404 });
  assert.deepEqual(find.mock.calls[0].arguments[0], { _id: M, post: P, status: 'ready' });
});

test('account purge removes social interactions and schedules all owned media for deletion', async t => {
  const calls = [];
  for (const [model, method] of [[Post, 'updateMany'], [PostComment, 'updateMany'], [PostReaction, 'deleteMany'], [PostUserState, 'deleteMany'], [PostReport, 'deleteMany'], [PostMedia, 'updateMany']]) t.mock.method(model, method, async (...args) => { calls.push([model.modelName, ...args]); });
  await service.purgeUser(U);
  assert.equal(calls.length, 6);
  assert.deepEqual(calls.find(c => c[0] === 'PostMedia').slice(1), [{ owner: U }, { status: 'deleting' }]);
  assert.equal(calls.find(c => c[0] === 'Post')[2].status, 'deleted');
});

test('new API routes preserve authentication and administrator guard', async t => {
  const auth = require('../src/middleware/auth');
  t.mock.method(auth, 'protect', (req, res, next) => { if (!req.headers['x-test-user']) return res.sendStatus(401); req.user = { _id: U }; next(); });
  t.mock.method(auth, 'requireAdmin', (req, res, next) => req.headers['x-test-admin'] === 'yes' ? next() : res.sendStatus(403));
  t.mock.method(service, 'listReports', async () => ({ items: [], nextCursor: null }));
  t.mock.method(service, 'create', async () => ({ _id: P }));
  const express = require('express');
  const csrf = require('../src/middleware/csrf');
  const app = express();
  app.use(express.json(), csrf.parseCookies, csrf.issueCsrfCookie, csrf.verifyCsrf);
  app.use('/api/posts', require('../src/routes/posts.routes'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}/api/posts`;
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(`${url}/reports`, { headers: { 'x-test-user': 'yes' } })).status, 403);
  assert.equal((await fetch(`${url}/reports`, { headers: { 'x-test-user': 'yes', 'x-test-admin': 'yes' } })).status, 200);
  assert.equal((await fetch(`${url}/invalid`, { headers: { 'x-test-user': 'yes' } })).status, 400);
  assert.equal((await fetch(`${url}/resolve?ids=invalid`, { headers: { 'x-test-user': 'yes' } })).status, 400);
  assert.equal((await fetch(url, { method: 'POST', headers: { 'x-test-user': 'yes' } })).status, 403);
  assert.equal((await fetch(url, { method: 'POST', headers: { 'x-test-user': 'yes', 'x-csrf-token': 'qa-csrf', cookie: 'csrf_token=qa-csrf', 'content-type': 'application/json' }, body: '{}' })).status, 200);
  assert.ok(mongoose.models.Post);
  assert.ok(Notification.schema.path('post'));
});
