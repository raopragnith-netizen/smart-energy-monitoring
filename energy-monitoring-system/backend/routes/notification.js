const express = require('express');
const router = express.Router();
const notificationController = require('../controllers/notificationController');
const authMiddleware = require('../middleware/authMiddleware');

// POST /api/notifications/test-email — send a test email
router.post('/test-email', authMiddleware, notificationController.sendTestEmail);

// GET /api/notifications/check — manually trigger notification checks
router.get('/check', authMiddleware, notificationController.triggerCheck);

// GET /api/notifications/history — get notification history
router.get('/history', authMiddleware, notificationController.getHistory);

// PUT /api/notifications/mark-read — mark notifications as read
router.put('/mark-read', authMiddleware, notificationController.markRead);

module.exports = router;
