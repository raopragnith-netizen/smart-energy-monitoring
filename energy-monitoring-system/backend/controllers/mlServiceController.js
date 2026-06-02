const { spawn } = require('child_process');
const path = require('path');
const axios = require('axios');

const ML_SERVICE_URL = process.env.ML_SERVICE_URL || 'http://127.0.0.1:5000';
const ML_SERVICE_DIR = path.resolve(__dirname, '..', '..', 'ml_service');
const PYTHON_PATH = process.env.PYTHON_PATH || (process.platform === 'win32' 
    ? path.join(ML_SERVICE_DIR, 'venv', 'Scripts', 'python.exe')
    : path.join(ML_SERVICE_DIR, 'venv', 'bin', 'python'));

let mlProcess = null;

// Check ML service health
exports.getStatus = async (req, res) => {
    try {
        // Simple ping to see if service responds
        await axios.get(ML_SERVICE_URL + '/health', { timeout: 2000 });
        res.json({ success: true, status: 'online' });
    } catch {
        res.json({ success: true, status: 'offline' });
    }
};

// Start ML service
exports.startService = async (req, res) => {
    // Check if already running
    try {
        await axios.get(ML_SERVICE_URL + '/latest-prediction', { timeout: 3000 });
        return res.json({ success: true, message: 'ML Service is already running.', status: 'running' });
    } catch (err) {
        // Not running, proceed
    }

    const IS_RENDER = process.env.RENDER === 'true';
    const IS_EXTERNAL_ML = ML_SERVICE_URL && !ML_SERVICE_URL.includes('127.0.0.1') && !ML_SERVICE_URL.includes('localhost');

    if (IS_RENDER || IS_EXTERNAL_ML) {
        return res.status(400).json({
            success: false,
            message: 'ML Service is configured externally and cannot be spawned locally.',
            status: 'offline'
        });
    }

    try {
        mlProcess = spawn(PYTHON_PATH, ['app.py'], {
            cwd: ML_SERVICE_DIR,
            detached: true,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe']
        });

        mlProcess.unref();

        // Capture output for debugging
        mlProcess.stdout.on('data', (data) => {
            console.log(`[ML Service] ${data.toString().trim()}`);
        });

        mlProcess.stderr.on('data', (data) => {
            const msg = data.toString().trim();
            // Flask outputs normal info to stderr
            if (msg) console.log(`[ML Service] ${msg}`);
        });

        mlProcess.on('error', (err) => {
            console.error('[ML Service] Failed to start:', err.message);
            mlProcess = null;
        });

        mlProcess.on('exit', (code) => {
            console.log(`[ML Service] Exited with code ${code}`);
            mlProcess = null;
        });

        // Wait for it to come up
        let attempts = 0;
        const maxAttempts = 10;
        while (attempts < maxAttempts) {
            await new Promise(r => setTimeout(r, 1000));
            try {
                await axios.get(ML_SERVICE_URL + '/latest-prediction', { timeout: 2000 });
                return res.json({ success: true, message: 'ML Service started successfully!', status: 'running' });
            } catch {
                attempts++;
            }
        }

        res.json({ success: true, message: 'ML Service starting... it may take a few more seconds.', status: 'starting' });
    } catch (err) {
        res.status(500).json({ success: false, message: `Failed to start ML Service: ${err.message}`, status: 'error' });
    }
};

// Stop ML service
exports.stopService = async (req, res) => {
    const IS_RENDER = process.env.RENDER === 'true';
    const IS_EXTERNAL_ML = ML_SERVICE_URL && !ML_SERVICE_URL.includes('127.0.0.1') && !ML_SERVICE_URL.includes('localhost');

    if (IS_RENDER || IS_EXTERNAL_ML) {
        return res.status(400).json({
            success: false,
            message: 'ML Service is configured externally and cannot be stopped locally.'
        });
    }

    try {
        if (mlProcess) {
            mlProcess.kill();
            mlProcess = null;
        }

        // Also try to kill any Python process on port 5000
        const { execSync } = require('child_process');
        if (process.platform === 'win32') {
            try {
                const result = execSync('netstat -ano | findstr :5000 | findstr LISTENING', { encoding: 'utf-8' });
                const lines = result.trim().split('\n');
                for (const line of lines) {
                    const parts = line.trim().split(/\s+/);
                    const pid = parts[parts.length - 1];
                    if (pid && pid !== '0') {
                        try { execSync(`taskkill /PID ${pid} /F`, { encoding: 'utf-8' }); } catch {}
                    }
                }
            } catch {
                // No process found on port 5000
            }
        } else {
            try { execSync('kill $(lsof -t -i:5000) 2>/dev/null || true'); } catch {}
        }

        res.json({ success: true, message: 'ML Service stopped.', status: 'stopped' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};
