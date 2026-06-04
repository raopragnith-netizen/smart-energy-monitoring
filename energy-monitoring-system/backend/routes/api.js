const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const uploadsDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadsDir)) { fs.mkdirSync(uploadsDir, { recursive: true }); }
const dataController = require('../controllers/dataController');
const authMiddleware = require('../middleware/authMiddleware');
const { supabase } = require('../utils/supabase');
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

router.post('/upload-data', authMiddleware, upload.single('dataset'), dataController.uploadData);
router.get('/train-model', authMiddleware, dataController.trainModel);
router.get('/predict', authMiddleware, dataController.getPredictions);
router.get('/anomaly-detection', authMiddleware, dataController.getAnomalies);
router.get('/recommendations', authMiddleware, dataController.getRecommendations);
router.get('/user-data-status', authMiddleware, dataController.getUserDataStatus);

// Internal routes for frontend charts
router.get('/historical-data', authMiddleware, dataController.getHistoricalData);

// Enhancement routes
router.get('/realtime-status', authMiddleware, dataController.getRealtimeStatus);
router.get('/enhanced-historical', authMiddleware, dataController.getEnhancedHistorical);

// Advanced prediction routes
router.get('/predict-week', authMiddleware, dataController.getWeeklyPredictions);
router.get('/monthly-projection', authMiddleware, dataController.getMonthlyProjection);

// ===== Bill Upload & OCR Processing =====

router.post('/upload-bill', authMiddleware, billUpload.single('bill'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'No bill file uploaded.' });
        }

        const filePath = path.resolve(req.file.path);
        const ext = path.extname(req.file.originalname).toLowerCase();
        const userId = req.user.id;
        
        // 1. Save initial processing record to Supabase
        const { data, error } = await supabase
            .from('bill_records')
            .insert({
                user_id: userId,
                original_file_name: req.file.originalname,
                file_type: ext === '.pdf' ? 'pdf' : 'image',
                status: 'processing'
            })
            .select('id')
            .single();

        if (error) throw error;
        const billId = data.id;

        // 2. Respond immediately to frontend with the billId
        res.status(202).json({ success: true, message: 'Bill uploaded. Processing in background.', billId });

        // 3. Process in background
        (async () => {
            try {
                // Forward to ML service as multipart
                const FormData = require('form-data');
                const fs = require('fs');
                const formData = new FormData();
                formData.append('bill', fs.createReadStream(filePath), {
                    filename: req.file.originalname,
                    contentType: req.file.mimetype
                });
                formData.append('user_id', userId);

                console.log(`[backend] Sending bill ${billId} to ML Service for OCR...`);
                const response = await axios.post(`${ML_SERVICE_URL}/ocr-bill`, formData, {
                    headers: formData.getHeaders(),
                    maxContentLength: Infinity,
                    maxBodyLength: Infinity,
                    timeout: 120000 // 2 min timeout for OCR
                });

                // Clean up uploaded file from backend
                try { fs.unlinkSync(filePath); } catch (e) {}

                if (response.data.success) {
                    const extData = response.data.extracted;
                    const cleanVal = (field) => {
                        if (field === null || field === undefined) return null;
                        return typeof field === 'object' ? (field.value ?? null) : field;
                    };
                    
                    // Update database record with success and extracted values
                    await supabase
                        .from('bill_records')
                        .update({
                            status: 'success',
                            consumer_number: cleanVal(extData.consumerNumber),
                            billing_month: cleanVal(extData.billingMonth),
                            total_units: cleanVal(extData.totalUnits) !== null ? parseFloat(cleanVal(extData.totalUnits)) : null,
                            bill_amount: cleanVal(extData.billAmount) !== null ? parseFloat(cleanVal(extData.billAmount)) : null,
                            previous_reading: cleanVal(extData.previousReading) !== null ? parseFloat(cleanVal(extData.previousReading)) : null,
                            current_reading: cleanVal(extData.currentReading) !== null ? parseFloat(cleanVal(extData.currentReading)) : null,
                            electricity_board: extData.electricityBoard || 'Unknown',
                            extraction_confidence: extData.confidence || 'medium',
                            raw_text_length: parseInt(extData.rawTextLength || 0)
                        })
                        .eq('id', billId);
                    console.log(`[backend] Bill ${billId} processed successfully.`);
                } else {
                    throw new Error(response.data.message || 'OCR extraction returned unsuccessful');
                }
            } catch (err) {
                console.error(`[backend] Background OCR failed for bill ${billId}:`, err.message);
                try { fs.unlinkSync(filePath); } catch (e) {}
                await supabase
                    .from('bill_records')
                    .update({
                        status: 'failed',
                        error_message: err.message
                    })
                    .eq('id', billId);
            }
        })();

    } catch (error) {
        console.error('Bill upload error:', error.message);
        res.status(500).json({ success: false, message: error.message || 'Failed to process bill' });
    }
});

router.get('/bill-status/:id', authMiddleware, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('bill_records')
            .select('*')
            .eq('id', req.params.id)
            .eq('user_id', req.user.id)
            .single();

        if (error) throw error;
        if (!data) return res.status(404).json({ success: false, message: 'Bill record not found or access denied' });

        if (data.status === 'success') {
            res.json({
                success: true,
                status: 'success',
                extracted: {
                    consumerNumber: data.consumer_number,
                    billingMonth: data.billing_month,
                    totalUnits: data.total_units,
                    billAmount: data.bill_amount,
                    previousReading: data.previous_reading,
                    currentReading: data.current_reading,
                    electricityBoard: data.electricity_board,
                    confidence: data.extraction_confidence,
                    rawTextLength: data.raw_text_length,
                    originalFileName: data.original_file_name,
                    fileType: data.file_type
                }
            });
        } else if (data.status === 'failed') {
            res.json({
                success: false,
                status: 'failed',
                message: data.error_message || 'OCR processing failed'
            });
        } else {
            res.json({
                success: true,
                status: 'processing',
                message: 'OCR is still processing in background'
            });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

router.post('/confirm-bill', authMiddleware, async (req, res) => {
    try {
        const response = await axios.post(`${ML_SERVICE_URL}/confirm-bill`, {
            ...req.body,
            user_id: req.user.id
        }, {
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

router.get('/bill-history', authMiddleware, async (req, res) => {
    try {
        const { data: records, error } = await supabase
            .from('bill_records')
            .select('*')
            .eq('user_id', req.user.id)
            .order('created_at', { ascending: false })
            .limit(50);
        if (error) throw error;
        
        const mappedRecords = (records || []).map(r => ({
            id: r.id,
            userId: r.user_id,
            consumerNumber: r.consumer_number,
            billingMonth: r.billing_month,
            totalUnits: r.total_units,
            billAmount: r.bill_amount,
            previousReading: r.previous_reading,
            currentReading: r.current_reading,
            electricityBoard: r.electricity_board,
            originalFileName: r.original_file_name,
            fileType: r.file_type,
            extractionConfidence: r.extraction_confidence,
            rawTextLength: r.raw_text_length,
            status: r.status,
            errorMessage: r.error_message,
            generatedRecords: r.generated_records,
            createdAt: r.created_at,
            updatedAt: r.updated_at
        }));
        res.json({ success: true, records: mappedRecords });
    } catch (error) {
        // Fallback: try ML service directly
        try {
            const response = await axios.get(`${ML_SERVICE_URL}/bill-history?user_id=${req.user.id}`);
            res.json(response.data);
        } catch (e) {
            res.status(500).json({ success: false, message: error.message });
        }
    }
});

// Activity log endpoint
router.get('/activity-log', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        let query = supabase
            .from('activity_logs')
            .select('*')
            .eq('user_id', userId)
            .order('timestamp', { ascending: false })
            .limit(30);
        
        const { data: logs, error } = await query;
        if (error) throw error;
        
        const mappedLogs = (logs || []).map(l => ({
            id: l.id,
            userId: l.user_id,
            action: l.action,
            details: l.details,
            timestamp: l.timestamp,
            createdAt: l.created_at,
            updatedAt: l.updated_at
        }));
        res.json({ success: true, data: mappedLogs });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// Full ML Pipeline — retrain + predict + anomalies in one call
router.post('/full-pipeline', authMiddleware, async (req, res) => {
    try {
        const response = await axios.post(`${ML_SERVICE_URL}/full-pipeline`, {
            user_id: req.user.id
        }, {
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
