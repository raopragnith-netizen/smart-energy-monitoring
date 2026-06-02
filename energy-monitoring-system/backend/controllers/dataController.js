const axios = require('axios');
const fs = require('fs');
const path = require('path');
const EnergyData = require('../../database/models/EnergyData');
const Recommendation = require('../../database/models/Recommendation');
const Anomaly = require('../../database/models/Anomaly');
const Prediction = require('../../database/models/Prediction');

const ML_SERVICE_URL = process.env.ML_SERVICE_URL || 'http://127.0.0.1:5000';

exports.uploadData = async (req, res) => {
    try {
        let filePath;
        if (req.body.isSample) {
            filePath = path.resolve(__dirname, '..', '..', 'mock_dataset.csv');
            if (!fs.existsSync(filePath)) {
                return res.status(404).json({ success: false, message: 'Sample dataset not found.' });
            }
        } else {
            if (!req.file) {
                return res.status(400).json({ success: false, message: 'No file uploaded.' });
            }
            filePath = path.resolve(req.file.path);
        }

        // 1. Process CSV
        console.log('[backend] Processing CSV:', filePath);
        const processResponse = await axios.post(`${ML_SERVICE_URL}/process-csv`, { file_path: filePath });
        
        if (!processResponse.data.success) {
            throw new Error(processResponse.data.message || 'CSV processing failed');
        }

        // 2. Trigger full pipeline (train, predict, anomalies)
        console.log('[backend] Triggering full ML pipeline...');
        const pipelineResponse = await axios.post(`${ML_SERVICE_URL}/full-pipeline`, {});

        res.status(200).json({ 
            success: true, 
            message: 'Data uploaded and analytics refreshed successfully!', 
            data: processResponse.data,
            pipeline: pipelineResponse.data
        });
    } catch (error) {
        console.error('[backend] Upload error:', error.message);
        res.status(500).json({ success: false, message: 'Error uploading and analyzing data.', error: error.message });
    }
};

exports.trainModel = async (req, res) => {
    try {
        const response = await axios.get(`${ML_SERVICE_URL}/train`);
        res.status(200).json({ success: true, message: 'Model trained successfully.', data: response.data });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Error training model.', error: error.message });
    }
};

exports.getPredictions = async (req, res) => {
    try {
        const response = await axios.get(`${ML_SERVICE_URL}/predict`);
        const predictions = response.data.predictions || [];
        res.status(200).json({ success: true, predictions });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Error getting predictions.', error: error.message });
    }
};

exports.getAnomalies = async (req, res) => {
    try {
        const response = await axios.get(`${ML_SERVICE_URL}/detect-anomalies`);
        const anomalies = response.data.anomalies || [];
        res.status(200).json({ success: true, anomalies });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Error getting anomalies.', error: error.message });
    }
};

exports.getRecommendations = async (req, res) => {
    try {
        // Try enhanced recommendations from ML service first
        let suggestions = [];
        try {
            const response = await axios.get(`${ML_SERVICE_URL}/smart-recommendations`);
            if (response.data.success && response.data.recommendations) {
                suggestions = response.data.recommendations;
            }
        } catch (mlErr) {
            // Fallback: generate recommendations purely from database (no ML service needed)
            try {
                const recentData = await EnergyData.find().sort({ date: -1 }).limit(30);
                const latestPred = await Prediction.findOne().sort({ createdAt: -1 });
                const predicted_units = latestPred ? latestPred.predicted_units : 0;
                const threshold = 15;

                if (recentData.length > 0) {
                    const avg = recentData.reduce((sum, d) => sum + d.units, 0) / recentData.length;
                    const latest = recentData[0].units;

                    if (latest > avg * 1.3) {
                        suggestions.push({ message: `Your latest usage (${latest.toFixed(1)} units) is ${(((latest - avg) / avg) * 100).toFixed(0)}% above your average. Consider reducing heavy appliance use.`, type: 'Trend', priority: 'high' });
                    }
                }

                if (predicted_units > threshold) {
                    suggestions.push({ message: 'Reduce AC usage by 1 hour during peak afternoon hours (2pm-5pm).', type: 'Household', priority: 'high' });
                    suggestions.push({ message: 'Shift washing machine and dryer usage to off-peak hours (10pm-6am).', type: 'Household', priority: 'medium' });
                    suggestions.push({ message: 'Unplug idle electronics — standby power accounts for 5-10% of total usage.', type: 'Household', priority: 'low' });
                } else {
                    suggestions.push({ message: 'Energy usage is within optimal limits. Great job! 🎉', type: 'Household', priority: 'info' });
                    suggestions.push({ message: 'Shift laundry and dishwasher cycles to off-peak hours (10pm–6am) to reduce peak demand.', type: 'Household', priority: 'medium' });
                    suggestions.push({ message: 'Consider setting a budget limit in Settings to get proactive alerts.', type: 'Household', priority: 'info' });
                }
            } catch (dbErr) {
                // Final fallback: generic tips
                suggestions.push({ message: 'Energy usage is within optimal limits. Great job! 🎉', type: 'Household', priority: 'info' });
                suggestions.push({ message: 'Shift heavy appliance usage to off-peak hours (10pm–6am) for savings.', type: 'Household', priority: 'medium' });
            }
        }

        res.status(200).json({ success: true, data: suggestions });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Error getting recommendations.', error: error.message });
    }
};

exports.getHistoricalData = async (req, res) => {
    try {
        const data = await EnergyData.find().sort({ date: -1 }).limit(100);
        res.status(200).json({ success: true, data: data.reverse() });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Error fetching historical data.' });
    }
};

// ===== NEW ENDPOINTS =====

// Real-time status for dashboard polling
exports.getRealtimeStatus = async (req, res) => {
    try {
        const latestData = await EnergyData.find().sort({ date: -1 }).limit(7);
        const latestPrediction = await Prediction.findOne().sort({ createdAt: -1 });
        const anomalyCount = await Anomaly.countDocuments();
        const allData = await EnergyData.find().sort({ date: -1 }).limit(30);

        const currentUsage = latestData.length > 0 ? latestData[0].units : 0;
        const dailyAvg = latestData.length > 0
            ? latestData.reduce((sum, d) => sum + d.units, 0) / latestData.length
            : 0;
        const weeklyTotal = latestData.reduce((sum, d) => sum + d.units, 0);
        const predicted = latestPrediction ? latestPrediction.predicted_units : 0;

        // Calculate hourly trend (mock: use recent data points as proxy)
        const last24 = allData.slice(0, Math.min(24, allData.length)).reverse();
        const hourlyTrend = last24.map(d => ({
            date: d.date,
            units: d.units,
            anomaly: d.anomaly || false
        }));

        res.json({
            success: true,
            status: {
                currentUsage: parseFloat(currentUsage.toFixed(2)),
                predictedUsage: parseFloat(predicted.toFixed(2)),
                dailyAvg: parseFloat(dailyAvg.toFixed(2)),
                weeklyTotal: parseFloat(weeklyTotal.toFixed(2)),
                anomalyCount,
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
        const historicalData = await EnergyData.find().sort({ date: -1 }).limit(200);
        // Reverse to restore chronological order (ascending)
        historicalData.reverse();

        const predictions = await Prediction.find().sort({ targetDate: 1 });
        const anomalies = await Anomaly.find().sort({ date: 1 });

        // Build prediction map for quick lookup
        const predMap = {};
        predictions.forEach(p => {
            const key = new Date(p.targetDate).toISOString().split('T')[0];
            predMap[key] = p.predicted_units;
        });

        // Build anomaly set for quick lookup
        const anomalySet = new Set();
        anomalies.forEach(a => {
            anomalySet.add(new Date(a.date).toISOString().split('T')[0]);
        });

        const enhanced = historicalData.map(d => {
            const dateKey = new Date(d.date).toISOString().split('T')[0];
            return {
                date: d.date,
                units: d.units,
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
        const response = await axios.get(`${ML_SERVICE_URL}/predict-week`);
        res.status(200).json(response.data);
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Error getting weekly predictions.', error: error.message });
    }
};

// Monthly projection (projected monthly consumption)
exports.getMonthlyProjection = async (req, res) => {
    try {
        const response = await axios.get(`${ML_SERVICE_URL}/monthly-projection`);
        res.status(200).json(response.data);
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Error getting monthly projection.', error: error.message });
    }
};
