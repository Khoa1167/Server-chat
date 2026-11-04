const express = require('express');
const router = express.Router();
const { protect, requireDeviceSession } = require('../middleware/auth');
const aiController = require('../controllers/ai.controller');

router.get('/settings', protect, requireDeviceSession, aiController.getSettings);
router.put('/settings', protect, requireDeviceSession, aiController.updateSettings);
router.get('/capabilities', protect, requireDeviceSession, aiController.getCapabilities);
router.get('/permissions', protect, requireDeviceSession, aiController.getPermissions);
router.put('/permissions', protect, requireDeviceSession, aiController.updatePermissions);
router.post('/actions/authorize', protect, requireDeviceSession, aiController.authorizeAction);
router.post('/transcribe', protect, requireDeviceSession, express.raw({ type: 'audio/wav', limit: '1mb' }), aiController.transcribe);
router.post('/chat', protect, requireDeviceSession, aiController.chat);
router.get('/conversations', protect, requireDeviceSession, aiController.listConversations);
router.post('/conversations', protect, requireDeviceSession, aiController.createConversation);
router.delete('/conversations', protect, requireDeviceSession, aiController.deleteAllHistory);
router.get('/conversations/:id/messages', protect, requireDeviceSession, aiController.listMessages);
router.post('/conversations/:id/messages', protect, requireDeviceSession, aiController.saveMessage);
router.delete('/conversations/:id', protect, requireDeviceSession, aiController.deleteConversation);

module.exports = router;
