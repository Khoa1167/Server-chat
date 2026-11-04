const service = require('../services/posts.service');
const media = require('../services/postMedia.service');
const { id } = require('../validators/posts.validator');
const handleError = require('../utils/handleError');
const AppError = require('../utils/AppError');
const logger = require('../config/logger');

const handler = action => async (req, res) => {
  try {
    for (const value of Object.values(req.params)) id(value);
    if (!['GET', 'HEAD'].includes(req.method)) req.body ||= {};
    const result = await action(req, res);
    if (!res.headersSent) res.json(result ?? { success: true });
  } catch (err) {
    if (!res.headersSent && err instanceof AppError) handleError(res, err);
    else if (!res.headersSent) {
      logger.error('Không thể hoàn tất thao tác bài viết');
      res.status(500).json({ message: 'Không thể hoàn tất thao tác. Hãy thử lại sau.' });
    }
    else res.destroy();
  }
};
const user = req => req.user._id;
const io = req => req.app.get('socketio');
exports.list = handler(req => service.list(user(req), req.query));
exports.resolve = handler(req => service.resolve(user(req), req.query));
exports.get = handler(req => service.get(user(req), req.params.id));
exports.profile = handler(req => service.profile(user(req), req.params.author));
exports.create = handler(req => service.create(user(req), req.body, io(req)));
exports.edit = handler(req => service.edit(user(req), req.params.id, req.body, io(req)));
exports.remove = handler(req => service.remove(user(req), req.params.id, io(req)));
exports.listComments = handler(req => service.listComments(user(req), req.params.id, req.query));
exports.getComment = handler(req => service.getComment(user(req), req.params.id, req.params.comment));
exports.addComment = handler(req => service.addComment(user(req), req.params.id, req.body, io(req)));
exports.editComment = handler(req => service.editComment(user(req), req.params.id, req.params.comment, req.body, io(req)));
exports.deleteComment = handler(req => service.deleteComment(user(req), req.params.id, req.params.comment, io(req)));
exports.react = handler(req => service.react(user(req), req.params.id, req.params.comment || null, req.body.kind, io(req)));
exports.listReactions = handler(req => service.listReactions(user(req), req.params.id, req.query));
exports.setState = handler(req => service.setState(user(req), req.params.id, req.body, io(req)));
exports.report = handler(req => service.report(user(req), req.params.id, req.body));
exports.listReports = handler(req => service.listReports(req.query));
exports.resolveReport = handler(req => service.resolveReport(user(req), req.params.report, req.body, io(req)));
exports.reserveMedia = handler(req => media.reserve(user(req), req.body));
exports.completeMedia = handler(req => media.complete(user(req), req.params.media));
exports.discardMedia = handler(req => media.discard(user(req), req.params.media));
exports.streamMedia = handler(async (req, res) => media.stream(await service.getMedia(user(req), req.params.media), req, res));
exports.streamReportMedia = handler(async (req, res) => media.stream(await service.getReportMedia(req.params.report, req.params.media), req, res));
