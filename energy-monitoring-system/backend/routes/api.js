const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const uploadsDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadsDir)) { fs.mkdirSync(uploadsDir, { recursive: true }); }
const dataController = require('../controllers/dataController');
const ActivityLog = require('../../database/models/ActivityLog');
const BillRecord = require('../../database/models/BillRecord');
const axios = require('axios');

const ML_SERVICE_URL = process.env.ML_SERVICE_URL || 'http://127.0.0.1:5000';

// Multer Setup for CSV Upload
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, path.join(__dirname, '..', 'uploads'));
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + '-' + file.originalname);
    }
});
const upload = multer({ storage: storage });

// Multer setup for bill uploads (images + PDFs)
const billStorage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, path.join(__dirname, '..', 'uploads'));
    },
    filename: function (req, file, cb) {
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, 'bill_' + Date.now() + ext);
    }
});
const billUpload = multer({
    storage: billStorage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
    fileFilter: function (req, file, cb) {
        const allowed = ['.jpg', '.jpeg', '.png', '.pdf', '.bmp', '.webp'];
        const ext = path.extname(file.originalname).toLowerCase();
        if (allowed.includes(ext)) {
            cb(null, true);
        } else {
            cb(new Error(`Unsupported file type: ${ext}. Accepted: JPG, PNG, PDF`));
        }
    }
});

router.post('/upload-data', upload.single('dataset'), dataController.uploadData);
router.get('/train-model', dataController.trainModel);
router.get('/predict', dataController.getPredictions);
router.get('/anomaly-detection', dataController.getAnomalies);
router.get('/recommendations', dataController.getRecommendations);

// Internal routes for frontend charts
router.get('/historical-data', dataController.getHistoricalData);

// Enhancement routes
router.get('/realtime-status', dataController.getRealtimeStatus);
router.get('/enhanced-historical', dataController.getEnhancedHistorical);

// Advanced prediction routes
router.get('/predict-week', dataController.getWeeklyPredictions);
router.get('/monthly-projection', dataController.getMonthlyProjection);

// ===== Bill Upload & OCR Processing =====

router.post('/upload-bill', billUpload.single('bill'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'No bill file uploaded.' });
        }

        const filePath = path.resolve(req.file.path);

        // Forward to ML service as multipart
        const FormData = require('form-data');
        const fs = require('fs');
        const formData = new FormData();
        formData.append('bill', fs.createReadStream(filePath), {
            filename: req.file.originalname,
            contentType: req.file.mimetype
        });

        const response = await axios.post(`${ML_SERVICE_URL}/ocr-bill`, formData, {
            headers: formData.getHeaders(),
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
            timeout: 120000 // 2 min timeout for OCR
        });

        // Clean up uploaded file from backend
        try { fs.unlinkSync(filePath); } catch (e) {}

        if (response.data.success) {
            res.json(response.data);
        } else {
            res.status(400).json(response.data);
        }
    } catch (error) {
        console.error('Bill upload error:', error.message);
        const msg = error.response?.data?.message || error.message || 'Failed to process bill';
        res.status(500).json({ success: false, message: msg });
    }
});

router.post('/confirm-bill', async (req, res) => {
    try {
        const response = await axios.post(`${ML_SERVICE_URL}/confirm-bill`, req.body, {
            timeout: 120000 // 2 min timeout
        });
        if (response.data.success) {
            res.json(response.data);
        } else {
            res.status(400).json(response.data);
        }
    } catch (error) {
        console.error('Bill confirmation error:', error.message);
        const msg = error.response?.data?.message || error.message || 'Failed to confirm bill';
        res.status(500).json({ success: false, message: msg });
    }
});

router.get('/bill-history', async (req, res) => {
    try {
        const records = await BillRecord.find().sort({ createdAt: -1 }).limit(50);
        res.json({ success: true, records });
    } catch (error) {
        // Fallback: try ML service directly
        try {
            const response = await axios.get(`${ML_SERVICE_URL}/bill-history`);
            res.json(response.data);
        } catch (e) {
            res.status(500).json({ success: false, message: error.message });
        }
    }
});

// Activity log endpoint
router.get('/activity-log', async (req, res) => {
    try {
        const userId = req.query.userId;
        const query = userId ? { userId } : {};
        const logs = await ActivityLog.find(query).sort({ timestamp: -1 }).limit(30);
        res.json({ success: true, data: logs });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// Full ML Pipeline — retrain + predict + anomalies in one call
router.post('/full-pipeline', async (req, res) => {
    try {
        const response = await axios.post(`${ML_SERVICE_URL}/full-pipeline`, {}, {
            timeout: 120000 // 2 min for training
        });
        res.json(response.data);
    } catch (error) {
        console.error('Full pipeline error:', error.message);
        const msg = error.response?.data?.message || error.message;
        res.status(500).json({ success: false, message: msg });
    }
});

module.exports = router;
