const Post = require('../models/Post');
const Block = require('../models/Block');
const Friendship = require('../models/Friendship');
const AppError = require('../utils/AppError');
const AUTHOR_FIELDS = 'username nickname avatar isDeleted isBanned pendingDeletionAt';
const same = (a, b) => String(a?._id || a) === String(b?._id || b);
async function context(user) {
  const [relations, blocks] = await Promise.all([
    Friendship.find({ status: 'accepted', $or: [{ sender: user }, { receiver: user }] }).select('sender receiver').lean(),
    Block.find({ $or: [{ blocker: user }, { blocked: user }] }).select('blocker blocked').lean(),
  ]);
  const blocked = new Set(blocks.map(b => String(same(b.blocker, user) ? b.blocked : b.blocker)));
  const friends = new Set(relations.map(f => String(same(f.sender, user) ? f.receiver : f.sender)).filter(id => !blocked.has(id)));
  return { user: String(user), friends, blocked };
}
function visible(post, ctx) {
  const author = post?.author;
  if (!post || post.status !== 'active' || !author || author.isDeleted || author.isBanned || author.pendingDeletionAt || ctx.blocked.has(String(author._id || author))) return false;
  return same(author, ctx.user) || post.audience === 'public' || (post.audience === 'friends' && ctx.friends.has(String(author._id || author)));
}
function visibilityFilter(ctx) {
  return { status: 'active', author: { $nin: [...ctx.blocked] }, $or: [{ author: ctx.user }, { audience: 'public' }, { audience: 'friends', author: { $in: [...ctx.friends] } }] };
}
async function requirePost(id, ctx, { allowUnavailableOriginal = false } = {}) {
  const post = await Post.findById(id).populate('author', AUTHOR_FIELDS).lean();
  if (!visible(post, ctx)) throw new AppError('Bài viết không tồn tại hoặc bạn không có quyền xem', 404);
  if (post.original && !allowUnavailableOriginal) {
    const original = await Post.findById(post.original).populate('author', AUTHOR_FIELDS).lean();
    if (!visible(original, ctx)) throw new AppError('Bài viết gốc không còn khả dụng', 404);
  }
  return post;
}
module.exports = { context, visible, visibilityFilter, requirePost, same, AUTHOR_FIELDS };
