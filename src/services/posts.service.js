const mongoose = require('mongoose');
const Post = require('../models/Post');
const PostComment = require('../models/PostComment');
const PostReaction = require('../models/PostReaction');
const PostMedia = require('../models/PostMedia');
const PostUserState = require('../models/PostUserState');
const PostReport = require('../models/PostReport');
const User = require('../models/User');
const Notification = require('../models/Notification');
const access = require('./postAccess.service');
const mediaService = require('./postMedia.service');
const { createNotification } = require('./notifications.service');
const v = require('../validators/posts.validator');
const AppError = require('../utils/AppError');
const logger = require('../config/logger');
const oid = value => new mongoose.Types.ObjectId(String(value));
const publicUser = user => user ? { _id: user._id, username: user.username, nickname: user.nickname, avatar: user.avatar } : null;
const changed = io => io?.emit('posts:changed');

async function notify(io, recipient, actor, type, post, comment = null) {
  if (access.same(recipient, actor)) return;
  try {
    await access.requirePost(String(post), await access.context(recipient));
    await createNotification(io, { user: recipient, fromUser: actor, type, post, comment });
  } catch (err) {
    if (!(err instanceof AppError)) logger.warn('Không thể tạo thông báo bài viết');
  }
}

async function decorate(posts, ctx, includeOriginal = true) {
  if (!posts.length) return [];
  const ids = posts.map(p => p._id);
  const [media, states, reactions, mine, comments, shares, originals] = await Promise.all([
    PostMedia.find({ post: { $in: ids }, status: 'ready' }).select('post type mime size').lean(),
    PostUserState.find({ user: ctx.user, post: { $in: ids } }).lean(),
    PostReaction.aggregate([{ $match: { post: { $in: ids }, comment: null } }, { $group: { _id: { post: '$post', kind: '$kind' }, count: { $sum: 1 } } }]),
    PostReaction.find({ post: { $in: ids }, comment: null, user: ctx.user }).lean(),
    PostComment.aggregate([{ $match: { post: { $in: ids }, deleted: false, author: { $nin: [...ctx.blocked].map(oid) } } }, { $group: { _id: '$post', count: { $sum: 1 } } }]),
    Post.aggregate([{ $match: { original: { $in: ids }, status: 'active' } }, { $group: { _id: '$original', count: { $sum: 1 } } }]),
    includeOriginal ? Post.find({ _id: { $in: posts.map(p => p.original).filter(Boolean) } }).populate('author', access.AUTHOR_FIELDS).lean() : [],
  ]);
  const availableOriginals = await decorate(originals.filter(p => access.visible(p, ctx)), ctx, false);
  const originalMap = new Map(availableOriginals.map(p => [String(p._id), p]));
  return posts.map(p => {
    const key = String(p._id);
    const state = states.find(s => String(s.post) === key);
    return { _id: p._id, author: publicUser(p.author), content: p.content, audience: p.audience, createdAt: p.createdAt, editedAt: p.editedAt, version: p.__v,
      media: p.media.map(id => media.find(m => access.same(m._id, id))).filter(Boolean).map(m => ({ _id: m._id, type: m.type, mime: m.mime, size: m.size })),
      originalId: p.original, original: p.original ? originalMap.get(String(p.original)) || null : null,
      saved: state?.saved || false, hidden: state?.hidden || false,
      reaction: mine.find(r => String(r.post) === key)?.kind || null,
      reactions: Object.fromEntries(reactions.filter(r => String(r._id.post) === key).map(r => [r._id.kind, r.count])),
      commentCount: comments.find(c => String(c._id) === key)?.count || 0,
      shareCount: shares.find(s => String(s._id) === key)?.count || 0,
    };
  });
}

async function get(user, id) {
  const ctx = await access.context(user);
  const post = await access.requirePost(id, ctx, { allowUnavailableOriginal: true });
  return (await decorate([post], ctx))[0];
}

async function resolve(user, query) {
  if (typeof query.ids !== 'string') throw new AppError('Thiếu danh sách bài viết', 400);
  const ids = query.ids.split(',').map(v.id);
  if (ids.length > 100) throw new AppError('Tối đa 100 bài mỗi lần', 400);
  const ctx = await access.context(user);
  const filters = [{ _id: { $in: ids } }];
  if (query.view === 'feed') filters.push({ author: { $in: [ctx.user, ...ctx.friends] } });
  if (query.view === 'public') filters.push({ audience: 'public' });
  if (query.author) filters.push({ author: v.id(query.author) });
  if (query.q) filters.push({ $text: { $search: v.text(query.q, 200, true) } });
  const rows = await Post.find({ $and: filters }).populate('author', access.AUTHOR_FIELDS).lean();
  const byId = new Map(rows.filter(row => access.visible(row, ctx)).map(row => [String(row._id), row]));
  return decorate(ids.map(id => byId.get(id)).filter(Boolean), ctx);
}

async function list(user, query) {
  const ctx = await access.context(user);
  const { cursor, limit } = v.page(query);
  const view = query.view || 'feed';
  if (!['feed', 'public', 'saved', 'hidden', 'author'].includes(view)) throw new AppError('Bộ lọc không hợp lệ', 400);
  const conditions = [access.visibilityFilter(ctx)];
  if (view === 'feed') conditions.push({ author: { $in: [ctx.user, ...ctx.friends] } });
  if (view === 'public') conditions.push({ audience: 'public' });
  if (view === 'author') conditions.push({ author: v.id(query.author) });
  const states = await PostUserState.find({ user, ...(view === 'saved' ? { saved: true } : { hidden: true }) }).select('post').lean();
  if (view === 'saved' || view === 'hidden') conditions.push({ _id: { $in: states.map(s => s.post) } });
  else conditions.push({ _id: { $nin: states.map(s => s.post) } });
  if (query.q) conditions.push({ $text: { $search: v.text(query.q, 200, true) } });
  let last = cursor, items = [], exhausted = false;
  for (let batch = 0; batch < 5 && items.length <= limit; batch++) {
    const rows = await Post.find({ $and: [...conditions, ...(last ? [{ _id: { $lt: last } }] : [])] }).sort({ _id: -1 }).limit(limit + 1).populate('author', access.AUTHOR_FIELDS).lean();
    if (!rows.length) { exhausted = true; break; }
    for (const row of rows) {
      if (access.visible(row, ctx)) items.push(row);
      if (items.length > limit) break;
      last = String(row._id);
    }
    if (rows.length < limit + 1) { exhausted = true; break; }
  }
  const hasMore = items.length > limit || !exhausted;
  items = items.slice(0, limit);
  return { items: await decorate(items, ctx), nextCursor: hasMore ? String(items.at(-1)?._id || last) : null };
}

async function claimMedia(user, postId, ids) {
  for (const id of ids) {
    const row = await PostMedia.findOneAndUpdate({ _id: id, owner: user, status: 'ready', $or: [{ post: null }, { post: postId }] }, { post: postId }, { new: true });
    if (!row) throw new AppError('Media chưa hoàn tất hoặc không thuộc bài viết này', 400);
  }
}

async function create(user, body, io) {
  const input = v.post(body);
  const ctx = await access.context(user);
  if (input.original) {
    const original = await access.requirePost(input.original, ctx);
    if (original.original) input.original = String(original.original);
  }
  let post = await Post.findOne({ author: user, clientId: input.clientId });
  if (post?.status === 'deleted') throw new AppError('Thao tác này đã bị xóa', 409);
  if (post?.status === 'active') return get(user, String(post._id));
  if (!post) {
    try { post = await Post.create({ ...input, author: user, media: input.media, status: 'publishing' }); }
    catch (err) {
      if (err.code !== 11000) throw err;
      post = await Post.findOne({ author: user, clientId: input.clientId });
      if (post?.status === 'active') return get(user, String(post._id));
      if (!post || post.status !== 'publishing') throw new AppError('Thao tác đã kết thúc', 409);
    }
  }
  try { await claimMedia(user, post._id, post.media.map(String)); }
  catch (err) {
    if (err instanceof AppError) {
      await Post.deleteOne({ _id: post._id, status: 'publishing' });
      await PostMedia.updateMany({ post: post._id, status: 'ready' }, { post: null });
    }
    throw err;
  }
  const activated = await Post.findOneAndUpdate({ _id: post._id, status: 'publishing' }, { status: 'active' });
  changed(io);
  if (activated?.original) {
    const original = await Post.findById(activated.original).select('author');
    if (original) await notify(io, original.author, user, 'post_shared', post._id);
  }
  return get(user, String(post._id));
}

async function edit(user, id, body, io) {
  const input = v.post(body, true);
  const post = await Post.findOne({ _id: id, author: user, status: 'active' });
  if (!post) throw new AppError('Không có quyền sửa bài viết', 404);
  if (post.lastEditId === input.clientId) return get(user, id);
  if (String(post.original || '') !== String(input.original || '')) throw new AppError('Không thể đổi bài viết gốc', 400);
  if (post.original) await access.requirePost(String(post.original), await access.context(user));
  if (post.__v !== input.version) throw new AppError('Bài đã thay đổi trên thiết bị khác. Hãy tải lại', 409);
  const added = input.media.filter(id => !post.media.some(m => access.same(m, id)));
  const lease = new Date(Date.now() + 60000);
  const locked = await Post.findOneAndUpdate({ _id: id, author: user, status: 'active', __v: input.version, editLease: null }, { editLease: lease });
  if (!locked) throw new AppError('Bài đang được chỉnh sửa. Hãy thử lại sau', 409);
  try {
    await claimMedia(user, id, input.media);
    const updated = await Post.findOneAndUpdate({ _id: id, author: user, status: 'active', __v: input.version, editLease: lease }, { $set: { content: input.content, audience: input.audience, media: input.media, editedAt: new Date(), lastEditId: input.clientId }, $inc: { __v: 1 } });
    if (!updated) throw new AppError('Bài đã thay đổi. Hãy tải lại', 409);
    await PostMedia.updateMany({ _id: { $in: post.media.filter(m => !input.media.includes(String(m))) }, post: id }, { status: 'deleting' });
    await Post.updateOne({ _id: id, editLease: lease }, { editLease: null });
  } catch (err) {
    const current = await Post.findById(id).select('media');
    const unused = added.filter(id => !current?.media.some(m => access.same(m, id)));
    await PostMedia.updateMany({ _id: { $in: unused }, post: id, status: 'ready' }, { post: null });
    await Post.updateOne({ _id: id, editLease: lease }, { editLease: null });
    throw err;
  }
  changed(io);
  return get(user, id);
}

async function remove(user, id, io, moderator = false) {
  const filter = { _id: id, ...(moderator ? {} : { author: user }), status: { $ne: 'deleted' } };
  const post = await Post.findOneAndUpdate(filter, { status: 'deleted', content: '', editedAt: new Date() });
  if (!post) return;
  await PostMedia.updateMany({ post: id }, { status: 'deleting' });
  await Notification.deleteMany({ post: id });
  changed(io);
}

async function commentSummary(rows, user) {
  if (!rows.length) return [];
  const ids = rows.map(r => r._id);
  const [reactions, mine, replies] = await Promise.all([
    PostReaction.aggregate([{ $match: { comment: { $in: ids } } }, { $group: { _id: { comment: '$comment', kind: '$kind' }, count: { $sum: 1 } } }]),
    PostReaction.find({ comment: { $in: ids }, user }).lean(),
    PostComment.aggregate([{ $match: { parent: { $in: ids } } }, { $group: { _id: '$parent', count: { $sum: 1 } } }]),
  ]);
  return rows.map(row => ({ _id: row._id, post: row.post, parent: row.parent, content: row.deleted ? '' : row.content, deleted: row.deleted, author: publicUser(row.author), createdAt: row.createdAt, editedAt: row.editedAt,
    reaction: mine.find(r => access.same(r.comment, row._id))?.kind || null,
    reactions: row.deleted ? {} : Object.fromEntries(reactions.filter(r => access.same(r._id.comment, row._id)).map(r => [r._id.kind, r.count])),
    replyCount: replies.find(r => access.same(r._id, row._id))?.count || 0,
  }));
}

async function requireComment(postId, commentId, ctx, allowDeleted = false) {
  const comment = await PostComment.findOne({ _id: commentId, post: postId }).populate('author', access.AUTHOR_FIELDS).lean();
  if (!comment || (!allowDeleted && comment.deleted) || !comment.author || ctx.blocked.has(String(comment.author._id)) || comment.author.isDeleted || comment.author.isBanned || comment.author.pendingDeletionAt) throw new AppError('Bình luận không còn khả dụng', 404);
  return comment;
}

async function listComments(user, postId, query) {
  const ctx = await access.context(user);
  await access.requirePost(postId, ctx);
  const { cursor, limit } = v.page(query);
  const parent = query.parent ? v.id(query.parent) : null;
  if (parent) await requireComment(postId, parent, ctx, true);
  const rows = await PostComment.find({ post: postId, parent, author: { $nin: [...ctx.blocked] }, ...(cursor ? { _id: { $lt: cursor } } : {}) }).sort({ _id: -1 }).limit(limit + 1).populate('author', access.AUTHOR_FIELDS).lean();
  const items = rows.slice(0, limit).filter(r => r.author && !r.author.isDeleted && !r.author.isBanned && !r.author.pendingDeletionAt);
  return { items: await commentSummary(items, user), nextCursor: rows.length > limit ? String(rows[limit - 1]._id) : null };
}

async function getComment(user, postId, commentId) {
  const ctx = await access.context(user);
  await access.requirePost(postId, ctx);
  return (await commentSummary([await requireComment(postId, commentId, ctx, true)], user))[0];
}

async function addComment(user, postId, body, io) {
  const ctx = await access.context(user);
  const post = await access.requirePost(postId, ctx);
  const content = v.text(body.content, 3000, true), clientId = v.clientId(body.clientId);
  const parent = body.parent ? await requireComment(postId, v.id(body.parent), ctx, true) : null;
  if (parent?.parent) throw new AppError('Hãy trả lời trong luồng bình luận gốc', 400);
  let row;
  try { row = await PostComment.create({ post: postId, author: user, content, clientId, parent: parent?._id || null }); }
  catch (err) {
    if (err.code !== 11000) throw err;
    row = await PostComment.findOne({ author: user, clientId, post: postId });
    if (!row) throw new AppError('Mã bình luận đã được sử dụng', 409);
    return getComment(user, postId, String(row._id));
  }
  changed(io);
  await notify(io, post.author._id, user, 'post_commented', postId, row._id);
  if (parent && !access.same(parent.author, post.author)) await notify(io, parent.author._id, user, 'post_replied', postId, row._id);
  return getComment(user, postId, String(row._id));
}

async function editComment(user, postId, commentId, body, io) {
  await access.requirePost(postId, await access.context(user));
  const content = v.text(body.content, 3000, true);
  const row = await PostComment.findOneAndUpdate({ _id: commentId, post: postId, author: user, deleted: false }, { content, editedAt: new Date() });
  if (!row) throw new AppError('Không có quyền sửa bình luận', 404);
  changed(io);
  return getComment(user, postId, commentId);
}

async function deleteComment(user, postId, commentId, io, moderator = false) {
  const post = moderator ? null : await access.requirePost(postId, await access.context(user), { allowUnavailableOriginal: true });
  const row = await PostComment.findOneAndUpdate({ _id: commentId, post: postId, ...(moderator || access.same(post.author, user) ? {} : { author: user }) }, { content: '', deleted: true });
  if (!row) throw new AppError('Không có quyền xóa bình luận', 404);
  await PostReaction.deleteMany({ post: postId, comment: commentId });
  await Notification.deleteMany({ post: postId, comment: commentId });
  changed(io);
}

async function react(user, postId, commentId, kind, io) {
  if (kind !== null && !v.REACTIONS.includes(kind)) throw new AppError('Cảm xúc không hợp lệ', 400);
  const ctx = await access.context(user);
  const post = await access.requirePost(postId, ctx);
  const comment = commentId ? await requireComment(postId, commentId, ctx) : null;
  const filter = { post: postId, comment: commentId || null, user };
  if (kind === null) await PostReaction.deleteOne(filter);
  else {
    let previous;
    try { previous = await PostReaction.findOneAndUpdate(filter, { kind }, { upsert: true }); }
    catch (err) { if (err.code !== 11000) throw err; await PostReaction.updateOne(filter, { kind }); previous = true; }
    if (!previous) await notify(io, comment?.author._id || post.author._id, user, 'post_reacted', postId, commentId);
  }
  changed(io);
  return commentId ? getComment(user, postId, commentId) : get(user, postId);
}

async function listReactions(user, postId, query) {
  const ctx = await access.context(user);
  await access.requirePost(postId, ctx);
  const comment = query.comment ? v.id(query.comment) : null;
  if (comment) await requireComment(postId, comment, ctx);
  const { cursor, limit } = v.page(query);
  if (query.kind && !v.REACTIONS.includes(query.kind)) throw new AppError('Cảm xúc không hợp lệ', 400);
  const rows = await PostReaction.find({ post: postId, comment, user: { $nin: [...ctx.blocked] }, ...(query.kind ? { kind: query.kind } : {}), ...(cursor ? { _id: { $lt: cursor } } : {}) }).sort({ _id: -1 }).limit(limit + 1).populate('user', access.AUTHOR_FIELDS).lean();
  return { items: rows.slice(0, limit).filter(r => r.user && !r.user.isDeleted && !r.user.isBanned).map(r => ({ _id: r._id, user: publicUser(r.user), kind: r.kind })), nextCursor: rows.length > limit ? String(rows[limit - 1]._id) : null };
}

async function setState(user, postId, body, io) {
  await access.requirePost(postId, await access.context(user), { allowUnavailableOriginal: true });
  if (!body || !['saved', 'hidden'].some(k => Object.hasOwn(body, k)) || Object.keys(body).some(k => !['saved', 'hidden'].includes(k) || typeof body[k] !== 'boolean')) throw new AppError('Trạng thái không hợp lệ', 400);
  let result;
  try { result = await PostUserState.findOneAndUpdate({ user, post: postId }, { $set: body }, { upsert: true, new: true }); }
  catch (err) { if (err.code !== 11000) throw err; result = await PostUserState.findOneAndUpdate({ user, post: postId }, { $set: body }, { new: true }); }
  changed(io);
  return { saved: result.saved, hidden: result.hidden };
}

async function report(user, postId, body) {
  const ctx = await access.context(user);
  await access.requirePost(postId, ctx);
  if (!['spam', 'scam', 'harassment', 'abuse', 'other'].includes(body.reason)) throw new AppError('Lý do không hợp lệ', 400);
  const comment = body.comment ? v.id(body.comment) : null;
  if (comment) await requireComment(postId, comment, ctx);
  try { await PostReport.create({ reporter: user, post: postId, comment, reason: body.reason }); }
  catch (err) { if (err.code !== 11000) throw err; }
  return { message: 'Đã gửi báo cáo' };
}

async function listReports(query) {
  const { cursor, limit } = v.page(query);
  if (query.status && !['pending', 'removed', 'dismissed'].includes(query.status)) throw new AppError('Trạng thái báo cáo không hợp lệ', 400);
  const rows = await PostReport.find({ ...(query.status ? { status: query.status } : {}), ...(cursor ? { _id: { $lt: cursor } } : {}) }).sort({ _id: -1 }).limit(limit + 1).populate('reporter', 'username nickname avatar').populate('post', 'author content audience status media').populate('comment', 'author content deleted').lean();
  const media = await PostMedia.find({ post: { $in: rows.map(r => r.post?._id).filter(Boolean) }, status: 'ready' }).select('post type mime').lean();
  return { items: rows.slice(0, limit).map(row => ({ ...row, media: media.filter(m => access.same(m.post, row.post?._id)) })), nextCursor: rows.length > limit ? String(rows[limit - 1]._id) : null };
}

async function getReportMedia(reportId, mediaId) {
  const report = await PostReport.findById(reportId).select('post');
  if (!report) throw new AppError('Không tìm thấy báo cáo', 404);
  const media = await PostMedia.findOne({ _id: mediaId, post: report.post, status: 'ready' }).select('+objectKey');
  if (!media) throw new AppError('Media đã bị gỡ', 404);
  return media;
}

async function resolveReport(admin, id, body, io) {
  if (!['removed', 'dismissed'].includes(body.status)) throw new AppError('Hướng xử lý không hợp lệ', 400);
  const report = await PostReport.findById(id);
  if (!report) throw new AppError('Không tìm thấy báo cáo', 404);
  if (report.status !== 'pending') return { status: report.status };
  if (body.status === 'removed') {
    if (report.comment) await deleteComment(admin, String(report.post), String(report.comment), io, true);
    else await remove(admin, String(report.post), io, true);
  }
  await PostReport.updateMany({ post: report.post, comment: report.comment, status: 'pending' }, { status: body.status, resolvedBy: admin });
  return { status: body.status };
}

async function getMedia(user, id) {
  const media = await PostMedia.findOne({ _id: id, status: 'ready' }).select('+objectKey');
  if (!media) throw new AppError('Không tìm thấy media', 404);
  if (!media.post && access.same(media.owner, user)) return media;
  if (!media.post) throw new AppError('Không có quyền xem media', 404);
  const post = await access.requirePost(String(media.post), await access.context(user));
  if (!post.media.some(m => access.same(m, id))) throw new AppError('Media không còn thuộc bài viết', 404);
  return media;
}

async function purgeUser(user, io) {
  await Post.updateMany({ author: user }, { status: 'deleted', content: '' });
  await PostComment.updateMany({ author: user }, { content: '', deleted: true });
  await PostReaction.deleteMany({ user });
  await PostUserState.deleteMany({ user });
  await PostReport.deleteMany({ reporter: user });
  await PostMedia.updateMany({ owner: user }, { status: 'deleting' });
  changed(io);
}
async function cleanup() {
  const interrupted = await Post.find({ editLease: { $lt: new Date(), $ne: null } }).select('_id media editLease').limit(100);
  for (const post of interrupted) {
    await PostMedia.updateMany({ post: post._id, _id: { $nin: post.media }, status: 'ready' }, { post: null });
    await Post.updateOne({ _id: post._id, editLease: post.editLease }, { editLease: null });
  }
  await Post.updateMany({ status: 'publishing', createdAt: { $lt: new Date(Date.now() - 24 * 3600000) } }, { status: 'deleted' });
  const deleted = await Post.find({ status: 'deleted', cleanedAt: null }).select('_id').limit(100);
  for (const row of deleted) {
    await PostMedia.updateMany({ post: row._id }, { status: 'deleting' });
    await Promise.all([PostComment.deleteMany({ post: row._id }), PostReaction.deleteMany({ post: row._id }), PostUserState.deleteMany({ post: row._id }), Notification.deleteMany({ post: row._id })]);
    await Post.updateOne({ _id: row._id }, { cleanedAt: new Date(), media: [] });
  }
  await mediaService.cleanup();
}
async function profile(user, author) {
  const ctx = await access.context(user);
  if (ctx.blocked.has(author)) throw new AppError('Không thể xem hồ sơ này', 404);
  const row = await User.findOne({ _id: author, isDeleted: { $ne: true }, isBanned: { $ne: true }, pendingDeletionAt: null }).select('username nickname avatar cover').lean();
  if (!row) throw new AppError('Không tìm thấy người dùng', 404);
  return row;
}
module.exports = { get, resolve, list, create, edit, remove, listComments, getComment, addComment, editComment, deleteComment, react, listReactions, setState, report, listReports, resolveReport, getMedia, getReportMedia, purgeUser, cleanup, profile };
