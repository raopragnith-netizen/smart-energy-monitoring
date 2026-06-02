const express = require('express');
const router = express.Router();
const notificationController = require('../controllers/notificationController');

// POST /api/notifications/test-email — send a test email
router.post('/test-email', notificationController.sendTestEmail);

// GET /api/notifications/check — manually trigger notification checks
router.get('/check', notificationController.triggerCheck);

// GET /api/notifications/history — get notification history
router.get('/history', notificationController.getHistory);

// PUT /api/notifications/mark-read — mark notifications as read
router.put('/mark-read', notificationController.markRead);

module.exports = router;
