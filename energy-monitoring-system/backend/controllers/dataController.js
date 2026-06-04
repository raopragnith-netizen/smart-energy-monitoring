const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const { supabase } = require('../utils/supabase');

const ML_SERVICE_URL = process.env.ML_SERVICE_URL || 'http://127.0.0.1:5000';

exports.uploadData = async (req, res) => {
    try {
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

        // 1. Process CSV by uploading directly to ML service
        console.log('[backend] Processing CSV via upload:', filePath);
        const processResponse = await axios.post(`${ML_SERVICE_URL}/process-csv`, formData, {
            headers: formData.getHeaders(),
            maxContentLength: Infinity,
            maxBodyLength: Infinity
        });
        
        // Clean up uploaded file from backend (if not sample)
        if (!req.body.isSample && filePath) {
            try { fs.unlinkSync(filePath); } catch (e) {}
        }

        if (!processResponse.data.success) {
            throw new Error(processResponse.data.message || 'CSV processing failed');
        }

        // 2. Trigger full pipeline (train, predict, anomalies) asynchronously in background
        console.log('[backend] Triggering full ML pipeline in background...');
        axios.post(`${ML_SERVICE_URL}/full-pipeline`, {}).catch(err => {
            console.error('[backend] Background full pipeline failed:', err.message);
        });

        res.status(200).json({ 
            success: true, 
            message: 'Data uploaded successfully! ML training and analytics are running in the background.', 
            data: processResponse.data
        });
    } catch (error) {
        console.error('[backend] Upload error:', error.message);
        // Ensure cleanup of uploaded file in case of error
        if (req.file && req.file.path) {
            try { fs.unlinkSync(path.resolve(req.file.path)); } catch (e) {}
        }
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
        // Try direct query from Supabase first
        const { data, error } = await supabase
            .from('predictions')
            .select('*')
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

        // Fallback to ML service
        const response = await axios.get(`${ML_SERVICE_URL}/predict`);
        const predictions = response.data.predictions || [];
        res.status(200).json({ success: true, predictions });
    } catch (error) {
        console.warn('[backend] Database query failed or returned no predictions, using ML Service:', error.message);
        try {
            const response = await axios.get(`${ML_SERVICE_URL}/predict`);
            const predictions = response.data.predictions || [];
            res.status(200).json({ success: true, predictions });
        } catch (mlErr) {
            res.status(500).json({ success: false, message: 'Error getting predictions.', error: mlErr.message });
        }
    }
};

exports.getAnomalies = async (req, res) => {
    try {
        // Try direct query from Supabase first
        const { data, error } = await supabase
            .from('anomalies')
            .select('*')
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

        // Fallback to ML service
        const response = await axios.get(`${ML_SERVICE_URL}/detect-anomalies`);
        const anomalies = response.data.anomalies || [];
        res.status(200).json({ success: true, anomalies });
    } catch (error) {
        console.warn('[backend] Database query failed or returned no anomalies, using ML Service:', error.message);
        try {
            const response = await axios.get(`${ML_SERVICE_URL}/detect-anomalies`);
            const anomalies = response.data.anomalies || [];
            res.status(200).json({ success: true, anomalies });
        } catch (mlErr) {
            res.status(500).json({ success: false, message: 'Error getting anomalies.', error: mlErr.message });
        }
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
        // Try direct query from Supabase first
        const { data, error } = await supabase
            .from('predictions')
            .select('*')
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

        const response = await axios.get(`${ML_SERVICE_URL}/predict-week`);
        res.status(200).json(response.data);
    } catch (error) {
        console.warn('[backend] Weekly predictions DB fetch failed, using ML Service:', error.message);
        try {
            const response = await axios.get(`${ML_SERVICE_URL}/predict-week`);
            res.status(200).json(response.data);
        } catch (mlErr) {
            res.status(500).json({ success: false, message: 'Error getting weekly predictions.', error: mlErr.message });
        }
    }
};

// Monthly projection (projected monthly consumption)
exports.getMonthlyProjection = async (req, res) => {
    try {
        // Compute monthly projection directly from DB to bypass cold starts
        const now = new Date();
        const year = now.getFullYear();
        const month = now.getMonth();
        
        const monthStart = new Date(year, month, 1).toISOString();
        
        const { data: monthData, error: monthErr } = await supabase
            .from('energy_data')
            .select('*')
            .gte('date', monthStart)
            .order('date', { ascending: true });
            
        if (monthErr) throw monthErr;
        
        const { data: recentData, error: recentErr } = await supabase
            .from('energy_data')
            .select('*')
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
        
        const response = await axios.get(`${ML_SERVICE_URL}/monthly-projection`);
        res.status(200).json(response.data);
    } catch (error) {
        console.warn('[backend] Monthly projection calculation failed, using ML Service:', error.message);
        try {
            const response = await axios.get(`${ML_SERVICE_URL}/monthly-projection`);
            res.status(200).json(response.data);
        } catch (mlErr) {
            res.status(500).json({ success: false, message: 'Error getting monthly projection.', error: mlErr.message });
        }
    }
};
