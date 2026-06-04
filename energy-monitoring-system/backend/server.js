require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { supabase } = require('./utils/supabase');
const apiRoutes = require('./routes/api');
const authRoutes = require('./routes/auth');
const notificationRoutes = require('./routes/notification');
const mlServiceRoutes = require('./routes/mlService');
const { checkAndNotify } = require('./controllers/notificationController');
const axios = require('axios');
const ML_SERVICE_URL = process.env.ML_SERVICE_URL || 'http://127.0.0.1:5000';
console.log(`ML Service URL loaded: ${ML_SERVICE_URL}`);

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) { fs.mkdirSync(uploadsDir, { recursive: true }); }

const app = express();
const PORT = process.env.PORT || 3000;

// Check Supabase connection on startup
async function checkSupabaseConnection() {
    try {
        const { data, error } = await supabase.from('users').select('id').limit(1);
        if (error && error.code !== 'PGRST116') {
            console.error('[Supabase] Connection verification failed:', error.message);
        } else {
            console.log('[Supabase] Connection verified successfully.');
        }
    } catch (err) {
        console.error('[Supabase] Connection error:', err.message);
    }
}
checkSupabaseConnection();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static frontend files
app.use(express.static(path.join(__dirname, '..', 'frontend'), {
    maxAge: 0,
    etag: false
}));

// Routes
app.use('/api', apiRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/ml-service', mlServiceRoutes);

// Health check endpoint for startup automation
app.get('/health', async (req, res) => {
    let mlStatus = { status: 'Offline', models: {}, ocr: 'Unknown' };
    try {
        const mlRes = await axios.get(ML_SERVICE_URL + '/health', { timeout: 3000 });
        if (mlRes.data) {
            mlStatus = {
                status: 'Running',
                models: mlRes.data.models || {},
                ocr: mlRes.data.ocr_engine || 'Unknown'
            };
        }
    } catch (err) {
        // ML service offline
    }

    const ocrActive = mlStatus.ocr === 'ready' ? 'Active' : 'Inactive';
    const modelsLoaded = (mlStatus.models.lstm && mlStatus.models.linear_regression && mlStatus.models.scaler) ? 'Loaded' : 'Not Loaded';
    const predictionEngine = modelsLoaded === 'Loaded' ? 'Ready' : 'Offline';

    const responseText = [
        `Backend: Running`,
        `OCR: ${ocrActive}`,
        `Models: ${modelsLoaded}`,
        `Prediction Engine: ${predictionEngine}`
    ].join('\n');

    res.type('text/plain').send(responseText);
});

// Comprehensive status endpoint — checks all services
app.get('/status', async (req, res) => {
    // Check database connection
    let dbStatus = 'Disconnected';
    try {
        const { error } = await supabase.from('users').select('id').limit(1);
        if (!error || error.code === 'PGRST116') {
            dbStatus = 'Connected';
        }
    } catch {
        dbStatus = 'Disconnected';
    }

    // Check ML service
    let mlStatus = { status: 'Offline', models: {}, ocr: 'Unknown', dataRecords: 0 };
    try {
        const mlRes = await axios.get(ML_SERVICE_URL + '/health', { timeout: 5000 });
        if (mlRes.data) {
            mlStatus = {
                status: 'Running',
                models: mlRes.data.models || {},
                ocr: mlRes.data.ocr_engine || 'Unknown',
                dataRecords: mlRes.data.data_records || 0,
                version: mlRes.data.version || 'Unknown'
            };
        }
    } catch {
        mlStatus.status = 'Offline';
    }

    const allModelsLoaded = mlStatus.models.lstm && mlStatus.models.linear_regression && mlStatus.models.scaler;

    res.json({
        platform: 'Smart Energy AI',
        version: '2.0',
        services: {
            backend: { status: 'Running', uptime: Math.floor(process.uptime()) + 's' },
            database: { status: dbStatus },
            mlService: { status: mlStatus.status, version: mlStatus.version },
            ocr: { status: mlStatus.ocr === 'ready' ? 'Active' : (mlStatus.status === 'Running' ? 'Available' : 'Unavailable') },
            models: {
                status: allModelsLoaded ? 'Loaded' : 'Partial',
                lstm: mlStatus.models.lstm || false,
                linearRegression: mlStatus.models.linear_regression || false,
                scaler: mlStatus.models.scaler || false
            },
            predictions: { status: allModelsLoaded ? 'Ready' : 'Limited (fallback mode)' }
        },
        dataRecords: mlStatus.dataRecords,
        timestamp: new Date().toISOString()
    });
});

// Default route — serve login page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'frontend', 'login.html'));
});

// ===== ML Service Integration =====
// ML_SERVICE_URL is declared at the top of the file

// Check if running in serverless (Vercel) or standalone (Render/local) mode
const IS_SERVERLESS = process.env.VERCEL === '1' || process.env.AWS_LAMBDA_FUNCTION_NAME;
const IS_RENDER = process.env.RENDER === 'true';
const SHOULD_SPAWN_ML = !IS_SERVERLESS && !IS_RENDER && (!process.env.ML_SERVICE_URL || process.env.ML_SERVICE_URL.includes('127.0.0.1') || process.env.ML_SERVICE_URL.includes('localhost'));

async function isMLServiceRunning() {
    try {
        await axios.get(ML_SERVICE_URL + '/health', { timeout: 3000 });
        return true;
    } catch {
        return false;
    }
}

// ===== Standalone mode: spawn ML Service & watchdog =====
let mlProcess = null;
let mlStarting = false;

const { spawn } = require('child_process');
const ML_SERVICE_DIR = path.resolve(__dirname, '..', 'ml_service');
const PYTHON_PATH = process.env.PYTHON_PATH || (process.platform === 'win32' 
    ? path.join(ML_SERVICE_DIR, 'venv', 'Scripts', 'python.exe')
    : path.join(ML_SERVICE_DIR, 'venv', 'bin', 'python'));
const ML_WATCHDOG_INTERVAL = 30000;

function startMLServiceProcess() {
    if (mlStarting) return;
    mlStarting = true;
    
    // Kill existing process if it is still referenced to avoid orphans
    if (mlProcess) {
        console.log('[ML Watchdog] Terminating previous ML Service process...');
        try {
            mlProcess.kill();
        } catch (e) {
            console.error('[ML Watchdog] Failed to kill previous process:', e.message);
        }
        mlProcess = null;
    }

    console.log('[ML Watchdog] Starting ML Service...');
    try {
        mlProcess = spawn(PYTHON_PATH, ['app.py'], {
            cwd: ML_SERVICE_DIR,
            detached: false,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe']
        });
        mlProcess.stdout.on('data', (data) => {
            const msg = data.toString().trim();
            if (msg) console.log(`[ML Service] ${msg}`);
        });
        mlProcess.stderr.on('data', (data) => {
            const msg = data.toString().trim();
            if (msg && !msg.includes('tensorflow') && !msg.includes('oneDNN')) {
                console.log(`[ML Service] ${msg}`);
            }
        });
        mlProcess.on('error', (err) => {
            console.error('[ML Watchdog] Failed to start ML Service:', err.message);
            mlProcess = null;
            mlStarting = false;
        });
        mlProcess.on('exit', (code) => {
            console.log(`[ML Watchdog] ML Service exited with code ${code}`);
            mlProcess = null;
            mlStarting = false;
        });
        // Give ML Service 60 seconds to fully load models & PaddleOCR on CPU
        setTimeout(() => { mlStarting = false; }, 60000);
    } catch (err) {
        console.error('[ML Watchdog] Error spawning ML Service:', err.message);
        mlProcess = null;
        mlStarting = false;
    }
}

async function mlWatchdog() {
    const running = await isMLServiceRunning();
    if (!running && !mlStarting) {
        console.log('[ML Watchdog] ML Service is down — restarting...');
        startMLServiceProcess();
    }
}

// Graceful shutdown
if (SHOULD_SPAWN_ML) {
    process.on('SIGTERM', () => {
        console.log('SIGTERM received. Shutting down gracefully...');
        if (mlProcess) { try { mlProcess.kill(); } catch(e) {} }
        process.exit(0);
    });
    process.on('SIGINT', () => {
        console.log('SIGINT received. Shutting down...');
        if (mlProcess) { try { mlProcess.kill(); } catch(e) {} }
        process.exit(0);
    });
}

// Start server in standalone mode (not serverless)
if (!IS_SERVERLESS) {
    app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);

        // Auto-start ML Service if running standalone and configured to do so
        if (SHOULD_SPAWN_ML) {
            setTimeout(async () => {
                const alreadyRunning = await isMLServiceRunning();
                if (alreadyRunning) {
                    console.log('[ML Watchdog] ML Service is already running');
                } else {
                    startMLServiceProcess();
                }
            }, 1000);

            // ML watchdog
            setInterval(mlWatchdog, ML_WATCHDOG_INTERVAL);
        }

        // Periodic notification check
        setInterval(() => {
            checkAndNotify().then(results => {
                if (results.length > 0) {
                    console.log(`[NotificationService] Processed ${results.length} notifications`);
                }
            }).catch(err => console.error('[NotificationService] Error:', err.message));
        }, 10 * 60 * 1000);
    });
}

// Export for Vercel serverless AND for mlServiceController
module.exports = app;
module.exports.getMLProcess = () => mlProcess;
module.exports.setMLProcess = (p) => { mlProcess = p; };

