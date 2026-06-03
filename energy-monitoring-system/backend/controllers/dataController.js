const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { supabase } = require('../utils/supabase');

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
                const { data: recentData } = await supabase
                    .from('energy_data')
                    .select('*')
                    .order('date', { ascending: false })
                    .limit(30);

                const { data: latestPred } = await supabase
                    .from('predictions')
                    .select('*')
                    .order('created_at', { ascending: false })
                    .limit(1)
                    .maybeSingle();

                const predicted_units = latestPred ? parseFloat(latestPred.predicted_units) : 0;
                const threshold = 15;

                if (recentData && recentData.length > 0) {
                    const avg = recentData.reduce((sum, d) => sum + parseFloat(d.units), 0) / recentData.length;
                    const latest = parseFloat(recentData[0].units);

                    if (latest > avg * 1.3) {
                        suggestions.push({ 
                            message: `Your latest usage (${latest.toFixed(1)} units) is ${(((latest - avg) / avg) * 100).toFixed(0)}% above your average. Consider reducing heavy appliance use.`, 
                            type: 'Trend', 
                            priority: 'high' 
                        });
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
        const { data, error } = await supabase
            .from('energy_data')
            .select('*')
            .order('date', { ascending: false })
            .limit(100);

        if (error) throw error;
        
        // Reverse to restore chronological order (ascending) and map structure
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
        const { data: latestData, error: dataErr } = await supabase
            .from('energy_data')
            .select('*')
            .order('date', { ascending: false })
            .limit(7);
        if (dataErr) throw dataErr;

        const { data: latestPrediction, error: predErr } = await supabase
            .from('predictions')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();
        if (predErr) throw predErr;

        const { count: anomalyCount, error: anomErr } = await supabase
            .from('anomalies')
            .select('*', { count: 'exact', head: true });
        if (anomErr) throw anomErr;

        const { data: allData, error: allErr } = await supabase
            .from('energy_data')
            .select('*')
            .order('date', { ascending: false })
            .limit(30);
        if (allErr) throw allErr;

        const currentUsage = latestData && latestData.length > 0 ? parseFloat(latestData[0].units) : 0;
        const dailyAvg = latestData && latestData.length > 0
            ? latestData.reduce((sum, d) => sum + parseFloat(d.units), 0) / latestData.length
            : 0;
        const weeklyTotal = latestData ? latestData.reduce((sum, d) => sum + parseFloat(d.units), 0) : 0;
        const predicted = latestPrediction ? parseFloat(latestPrediction.predicted_units) : 0;

        // Calculate hourly trend (use recent data points as proxy)
        const last24 = (allData || []).slice(0, Math.min(24, allData.length)).reverse();
        const hourlyTrend = last24.map(d => ({
            date: d.date,
            units: parseFloat(d.units),
            anomaly: d.anomaly || false
        }));

        res.json({
            success: true,
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
        const { data: historicalData, error: histErr } = await supabase
            .from('energy_data')
            .select('*')
            .order('date', { ascending: false })
            .limit(200);
        if (histErr) throw histErr;

        // Reverse to restore chronological order (ascending)
        const sortedHistory = (historicalData || []).reverse();

        const { data: predictions, error: predErr } = await supabase
            .from('predictions')
            .select('*')
            .order('target_date', { ascending: true });
        if (predErr) throw predErr;

        const { data: anomalies, error: anomErr } = await supabase
            .from('anomalies')
            .select('*')
            .order('date', { ascending: true });
        if (anomErr) throw anomErr;

        // Build prediction map for quick lookup
        const predMap = {};
        (predictions || []).forEach(p => {
            const key = new Date(p.target_date).toISOString().split('T')[0];
            predMap[key] = parseFloat(p.predicted_units);
        });

        // Build anomaly set for quick lookup
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
