const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const { supabase, tableHasUserId } = require('../utils/supabase');

/**
 * Helper to build a PostgREST query on a table that is conditionally user-scoped.
 */
function queryTable(tableName, userId, selectOptions = null) {
    let base = supabase.from(tableName);
    let query = selectOptions ? base.select('*', selectOptions) : base.select('*');
    if (tableHasUserId[tableName]) {
        query = query.eq('user_id', userId);
    }
    return query;
}

const ML_SERVICE_URL = process.env.ML_SERVICE_URL || 'http://127.0.0.1:5000';
console.log(`ML Service URL loaded: ${ML_SERVICE_URL}`);

async function checkMLServiceHealth() {
    try {
        await axios.get(`${ML_SERVICE_URL}/health`, { timeout: 10000 });
        return true;
    } catch (err) {
        console.error("ML Service unavailable");
        return false;
    }
}

exports.uploadData = async (req, res) => {
    try {
        const userId = req.user.id;

        // Pre-flight health check
        const isHealthy = await checkMLServiceHealth();
        if (!isHealthy) {
            if (req.file && req.file.path) {
                try { fs.unlinkSync(path.resolve(req.file.path)); } catch (e) {}
            }
            return res.status(503).json({
                success: false,
                message: "ML Service is currently unavailable. Please try again later."
            });
        }

        let filePath;
        const formData = new FormData();

        if (req.body.isSample) {
            filePath = path.resolve(__dirname, '..', '..', 'mock_dataset.csv');
            if (!fs.existsSync(filePath)) {
                return res.status(404).json({ success: false, message: 'Sample dataset not found.' });
            }
            formData.append('dataset', fs.createReadStream(filePath), {
                filename: 'mock_dataset.csv',
                contentType: 'text/csv'
            });
        } else {
            if (!req.file) {
                return res.status(400).json({ success: false, message: 'No file uploaded.' });
            }
            filePath = path.resolve(req.file.path);
            formData.append('dataset', fs.createReadStream(filePath), {
                filename: req.file.originalname,
                contentType: req.file.mimetype || 'text/csv'
            });
        }

        // Pass user_id to ML service so data is stored per-user
        formData.append('user_id', userId);

        console.log(`[backend] Processing CSV via upload for user ${userId}:`, filePath);
        console.log("Prediction request sent");
        let processResponse;
        try {
            processResponse = await axios.post(`${ML_SERVICE_URL}/process-csv`, formData, {
                headers: formData.getHeaders(),
                maxContentLength: Infinity,
                maxBodyLength: Infinity
            });
            console.log("Prediction response received");
        } catch (postErr) {
            console.error("ML Service unavailable");
            throw postErr;
        }
        
        // Clean up uploaded file from backend (if not sample)
        if (!req.body.isSample && filePath) {
            try { fs.unlinkSync(filePath); } catch (e) {}
        }

        if (!processResponse.data.success) {
            throw new Error(processResponse.data.message || 'CSV processing failed');
        }

        // Trigger full pipeline in background with user_id
        console.log(`[backend] Triggering full ML pipeline in background for user ${userId}...`);
        console.log("Prediction request sent");
        axios.post(`${ML_SERVICE_URL}/full-pipeline`, { user_id: userId }).then(() => {
            console.log("Prediction response received");
        }).catch(err => {
            console.error("ML Service unavailable");
            console.error('[backend] Background full pipeline failed:', err.message);
        });

        res.status(200).json({ 
            success: true, 
            message: 'Data uploaded successfully! ML training and analytics are running in the background.', 
            data: processResponse.data
        });
    } catch (error) {
        console.error('[backend] Upload error:', error.message);
        if (req.file && req.file.path) {
            try { fs.unlinkSync(path.resolve(req.file.path)); } catch (e) {}
        }
        res.status(500).json({ success: false, message: 'Error uploading and analyzing data.', error: error.message });
    }
};

exports.trainModel = async (req, res) => {
    try {
        const userId = req.user.id;

        // Pre-flight health check
        const isHealthy = await checkMLServiceHealth();
        if (!isHealthy) {
            return res.status(503).json({
                success: false,
                message: "ML Service is currently unavailable. Please try again later."
            });
        }

        console.log("Prediction request sent");
        const response = await axios.get(`${ML_SERVICE_URL}/train?user_id=${userId}`);
        console.log("Prediction response received");
        res.status(200).json({ success: true, message: 'Model trained successfully.', data: response.data });
    } catch (error) {
        console.error("ML Service unavailable");
        console.error(error);
        res.status(500).json({ success: false, message: 'Error training model.', error: error.message });
    }
};

exports.getPredictions = async (req, res) => {
    try {
        const userId = req.user.id;
        const { data, error } = await queryTable('predictions', userId)
            .eq('prediction_type', 'single')
            .order('target_date', { ascending: false })
            .limit(1);

        if (error) throw error;

        if (data && data.length > 0) {
            const pred = data[0];
            const predictions = [{
                targetDate: new Date(pred.target_date).toISOString().split('T')[0],
                predicted_units: parseFloat(pred.predicted_units),
                modelUsed: pred.model_used
            }];
            return res.status(200).json({ success: true, predictions });
        }

        // No predictions exist for this user
        res.status(200).json({ success: true, predictions: [] });
    } catch (error) {
        console.warn('[backend] Prediction query failed:', error.message);
        res.status(200).json({ success: true, predictions: [] });
    }
};

exports.getAnomalies = async (req, res) => {
    try {
        const userId = req.user.id;
        const { data, error } = await queryTable('anomalies', userId)
            .order('date', { ascending: false });

        if (error) throw error;

        if (data && data.length > 0) {
            const anomalies = data.map(a => ({
                date: new Date(a.date).toISOString().split('T')[0],
                units: parseFloat(a.units),
                expected_units: parseFloat(a.expected_units),
                deviation_pct: parseFloat(a.deviation_pct),
                severity: a.severity,
                rolling_mean: parseFloat(a.rolling_mean),
                rolling_std: parseFloat(a.rolling_std)
            }));
            return res.status(200).json({ success: true, anomalies });
        }

        // No anomalies for this user
        res.status(200).json({ success: true, anomalies: [] });
    } catch (error) {
        console.warn('[backend] Anomaly query failed:', error.message);
        res.status(200).json({ success: true, anomalies: [] });
    }
};

exports.getRecommendations = async (req, res) => {
    try {
        const userId = req.user.id;

        // Check if user has any data first
        const { count, error: countErr } = await queryTable('energy_data', userId, { count: 'exact', head: true });
        
        if (countErr || !count || count === 0) {
            // No data — return empty recommendations
            return res.status(200).json({ success: true, data: [] });
        }

        // Pre-flight health check
        const isHealthy = await checkMLServiceHealth();
        if (!isHealthy) {
            return res.status(503).json({
                success: false,
                message: "ML Service is currently unavailable. Please try again later."
            });
        }

        console.log("Prediction request sent");
        let suggestions = [];
        try {
            const response = await axios.get(`${ML_SERVICE_URL}/smart-recommendations?user_id=${userId}`);
            console.log("Prediction response received");
            if (response.data.success && response.data.recommendations) {
                suggestions = response.data.recommendations;
            }
            res.status(200).json({ success: true, data: suggestions });
        } catch (mlErr) {
            console.error("ML Service unavailable");
            res.status(503).json({
                success: false,
                message: "ML Service is currently unavailable. Please try again later."
            });
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Error getting recommendations.', error: error.message });
    }
};

exports.getHistoricalData = async (req, res) => {
    try {
        const userId = req.user.id;
        const { data, error } = await queryTable('energy_data', userId)
            .order('date', { ascending: false })
            .limit(100);

        if (error) throw error;
        
        const mappedData = (data || []).reverse().map(d => ({
            id: d.id,
            date: d.date,
            units: parseFloat(d.units),
            predicted_units: d.predicted_units ? parseFloat(d.predicted_units) : null,
            anomaly: d.anomaly,
            source: d.source,
            createdAt: d.created_at,
            updatedAt: d.updated_at
        }));

        res.status(200).json({ success: true, data: mappedData });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Error fetching historical data.' });
    }
};

// Real-time status for dashboard polling
exports.getRealtimeStatus = async (req, res) => {
    try {
        const userId = req.user.id;

        // Check if user has ANY data
        const { count: dataCount, error: countErr } = await queryTable('energy_data', userId, { count: 'exact', head: true });

        if (countErr) throw countErr;

        if (!dataCount || dataCount === 0) {
            return res.json({
                success: true,
                hasData: false,
                status: {
                    currentUsage: null,
                    predictedUsage: null,
                    dailyAvg: null,
                    weeklyTotal: null,
                    anomalyCount: 0,
                    hourlyTrend: [],
                    lastUpdated: new Date().toISOString()
                }
            });
        }

        const { data: latestData, error: dataErr } = await queryTable('energy_data', userId)
            .order('date', { ascending: false })
            .limit(7);
        if (dataErr) throw dataErr;

        const { data: latestPrediction, error: predErr } = await queryTable('predictions', userId)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();
        if (predErr) throw predErr;

        const { count: anomalyCount, error: anomErr } = await queryTable('anomalies', userId, { count: 'exact', head: true });
        if (anomErr) throw anomErr;

        const { data: allData, error: allErr } = await queryTable('energy_data', userId)
            .order('date', { ascending: false })
            .limit(30);
        if (allErr) throw allErr;

        const currentUsage = latestData && latestData.length > 0 ? parseFloat(latestData[0].units) : 0;
        const dailyAvg = latestData && latestData.length > 0
            ? latestData.reduce((sum, d) => sum + parseFloat(d.units), 0) / latestData.length
            : 0;
        const weeklyTotal = latestData ? latestData.reduce((sum, d) => sum + parseFloat(d.units), 0) : 0;
        const predicted = latestPrediction ? parseFloat(latestPrediction.predicted_units) : 0;

        const last24 = (allData || []).slice(0, Math.min(24, allData.length)).reverse();
        const hourlyTrend = last24.map(d => ({
            date: d.date,
            units: parseFloat(d.units),
            anomaly: d.anomaly || false
        }));

        res.json({
            success: true,
            hasData: true,
            status: {
                currentUsage: parseFloat(currentUsage.toFixed(2)),
                predictedUsage: parseFloat(predicted.toFixed(2)),
                dailyAvg: parseFloat(dailyAvg.toFixed(2)),
                weeklyTotal: parseFloat(weeklyTotal.toFixed(2)),
                anomalyCount: anomalyCount || 0,
                hourlyTrend,
                lastUpdated: new Date().toISOString()
            }
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Error getting realtime status.' });
    }
};

// Enhanced historical data with anomaly flags and predictions overlaid
exports.getEnhancedHistorical = async (req, res) => {
    try {
        const userId = req.user.id;

        const { data: historicalData, error: histErr } = await queryTable('energy_data', userId)
            .order('date', { ascending: false })
            .limit(200);
        if (histErr) throw histErr;

        const sortedHistory = (historicalData || []).reverse();

        const { data: predictions, error: predErr } = await queryTable('predictions', userId)
            .order('target_date', { ascending: true });
        if (predErr) throw predErr;

        const { data: anomalies, error: anomErr } = await queryTable('anomalies', userId)
            .order('date', { ascending: true });
        if (anomErr) throw anomErr;

        const predMap = {};
        (predictions || []).forEach(p => {
            const key = new Date(p.target_date).toISOString().split('T')[0];
            predMap[key] = parseFloat(p.predicted_units);
        });

        const anomalySet = new Set();
        (anomalies || []).forEach(a => {
            anomalySet.add(new Date(a.date).toISOString().split('T')[0]);
        });

        const enhanced = sortedHistory.map(d => {
            const dateKey = new Date(d.date).toISOString().split('T')[0];
            return {
                date: d.date,
                units: parseFloat(d.units),
                predicted_units: predMap[dateKey] || null,
                isAnomaly: d.anomaly || anomalySet.has(dateKey)
            };
        });

        res.json({ success: true, data: enhanced });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Error fetching enhanced historical data.' });
    }
};

// Weekly predictions (7-day forecast)
exports.getWeeklyPredictions = async (req, res) => {
    try {
        const userId = req.user.id;

        const { data, error } = await queryTable('predictions', userId)
            .eq('prediction_type', 'weekly')
            .order('target_date', { ascending: true })
            .limit(7);

        if (error) throw error;

        if (data && data.length > 0) {
            const predictions = data.map(p => ({
                targetDate: new Date(p.target_date).toISOString().split('T')[0],
                predicted_units: parseFloat(p.predicted_units),
                dayName: p.day_name,
                modelUsed: p.model_used
            }));
            const weeklyTotal = predictions.reduce((sum, p) => sum + p.predicted_units, 0);
            return res.status(200).json({
                success: true,
                predictions,
                weeklyTotal: parseFloat(weeklyTotal.toFixed(2))
            });
        }

        // No weekly predictions for this user
        res.status(200).json({ success: true, predictions: [], weeklyTotal: 0 });
    } catch (error) {
        console.warn('[backend] Weekly predictions query failed:', error.message);
        res.status(200).json({ success: true, predictions: [], weeklyTotal: 0 });
    }
};

// Monthly projection
exports.getMonthlyProjection = async (req, res) => {
    try {
        const userId = req.user.id;
        const now = new Date();
        const year = now.getFullYear();
        const month = now.getMonth();
        
        const monthStart = new Date(year, month, 1).toISOString();
        
        const { data: monthData, error: monthErr } = await queryTable('energy_data', userId)
            .gte('date', monthStart)
            .order('date', { ascending: true });
            
        if (monthErr) throw monthErr;
        
        const { data: recentData, error: recentErr } = await queryTable('energy_data', userId)
            .order('date', { ascending: false })
            .limit(7);
            
        if (recentErr) throw recentErr;
        
        if (recentData && recentData.length > 0) {
            const dailyAvg = recentData.reduce((sum, d) => sum + parseFloat(d.units), 0) / recentData.length;
            const daysInMonth = new Date(year, month + 1, 0).getDate();
            const daysElapsed = now.getDate();
            const daysRemaining = daysInMonth - daysElapsed;
            const actualSoFar = monthData ? monthData.reduce((sum, d) => sum + parseFloat(d.units), 0) : 0;
            const projected = actualSoFar + (dailyAvg * daysRemaining);
            
            return res.status(200).json({
                success: true,
                projected: parseFloat(projected.toFixed(2)),
                daysElapsed,
                daysRemaining,
                daysInMonth,
                actualSoFar: parseFloat(actualSoFar.toFixed(2)),
                dailyAvg: parseFloat(dailyAvg.toFixed(2))
            });
        }
        
        // No data for this user
        res.status(200).json({
            success: true,
            projected: 0,
            daysElapsed: 0,
            daysRemaining: 0,
            daysInMonth: 0,
            actualSoFar: 0,
            dailyAvg: 0
        });
    } catch (error) {
        console.warn('[backend] Monthly projection failed:', error.message);
        res.status(200).json({
            success: true,
            projected: 0,
            daysElapsed: 0,
            daysRemaining: 0,
            daysInMonth: 0,
            actualSoFar: 0,
            dailyAvg: 0
        });
    }
};

// User data status endpoint — used by frontend to determine empty-state rendering
exports.getUserDataStatus = async (req, res) => {
    try {
        const userId = req.user.id;

        const { count: dataCount, error: dataErr } = await queryTable('energy_data', userId, { count: 'exact', head: true });

        if (dataErr) throw dataErr;

        let datasetStatus = 'not_uploaded';
        if (dataCount > 0) {
            datasetStatus = 'ready';
        }

        // Check if there's a bill currently processing
        const { data: pendingBills, error: billErr } = await queryTable('bill_records', userId)
            .eq('status', 'processing')
            .limit(1);

        if (!billErr && pendingBills && pendingBills.length > 0) {
            datasetStatus = 'processing';
        }

        res.json({
            success: true,
            hasData: dataCount > 0,
            datasetStatus,
            recordCount: dataCount || 0
        });
    } catch (error) {
        console.error('[backend] User data status error:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
};
