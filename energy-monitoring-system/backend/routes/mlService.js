const express = require('express');
const router = express.Router();
const mlServiceController = require('../controllers/mlServiceController');

// GET /api/ml-service/status — check if ML service is running
router.get('/status', mlServiceController.getStatus);

// POST /api/ml-service/start — start the ML service
router.post('/start', mlServiceController.startService);

// POST /api/ml-service/stop — stop the ML service
router.post('/stop', mlServiceController.stopService);

module.exports = router;
