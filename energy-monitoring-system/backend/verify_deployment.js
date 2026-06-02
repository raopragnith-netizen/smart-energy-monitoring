require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');

console.log('=== Smart Energy AI Automatic Deployment Validation ===');

async function runValidation() {
    const summary = {
        timestamp: new Date().toISOString(),
        status: 'PASS',
        results: {
            GitHub: 'FAIL',
            Vercel: 'FAIL',
            Render: 'FAIL',
            OCR: 'FAIL',
            Models: 'FAIL',
            Predictions: 'FAIL',
            Dashboard: 'FAIL',
            APIs: 'FAIL'
        },
        details: {}
    };

    // 1. GitHub
    try {
        const hasGit = fs.existsSync(path.join(__dirname, '..', '..', '.git'));
        summary.results.GitHub = hasGit ? 'PASS' : 'FAIL';
        summary.details.GitHub = hasGit ? 'Git repository detected at root' : 'No .git directory found';
    } catch (err) {
        summary.details.GitHub = err.message;
    }

    // 2. Vercel
    try {
        const vercelPath = path.join(__dirname, '..', 'vercel.json');
        const hasVercel = fs.existsSync(vercelPath);
        if (hasVercel) {
            const content = JSON.parse(fs.readFileSync(vercelPath, 'utf8'));
            if (content.routes && content.routes.length > 0) {
                summary.results.Vercel = 'PASS';
                summary.details.Vercel = 'vercel.json present and routes configured';
            } else {
                summary.details.Vercel = 'vercel.json present but no routes configured';
            }
        } else {
            summary.details.Vercel = 'vercel.json not found';
        }
    } catch (err) {
        summary.details.Vercel = `Error reading vercel.json: ${err.message}`;
    }

    // 3. Render
    try {
        const renderPath = path.join(__dirname, '..', 'render.yaml');
        const hasRender = fs.existsSync(renderPath);
        if (hasRender) {
            summary.results.Render = 'PASS';
            summary.details.Render = 'render.yaml present';
        } else {
            summary.details.Render = 'render.yaml not found';
        }
    } catch (err) {
        summary.details.Render = err.message;
    }

    // 4. APIs & Status (requires server running)
    let healthData = null;
    try {
        const res = await axios.get('http://127.0.0.1:3000/status', { timeout: 3000 });
        if (res.status === 200 && res.data.platform === 'Smart Energy AI') {
            summary.results.APIs = 'PASS';
            summary.details.APIs = 'Backend API status endpoint responded with 200 OK';
            healthData = res.data;
        } else {
            summary.details.APIs = `Unexpected response: ${res.status}`;
        }
    } catch (err) {
        summary.details.APIs = `Failed to connect to backend: ${err.message}`;
    }

    // 5. OCR & Models & Predictions
    if (healthData && healthData.services) {
        // OCR
        const ocrStatus = healthData.services.ocr?.status;
        summary.results.OCR = ocrStatus === 'Active' || ocrStatus === 'Available' ? 'PASS' : 'FAIL';
        summary.details.OCR = `OCR service status: ${ocrStatus || 'Unknown'}`;

        // Models
        const modelsStatus = healthData.services.models?.status;
        summary.results.Models = modelsStatus === 'Loaded' ? 'PASS' : 'FAIL';
        summary.details.Models = `Models status: ${modelsStatus || 'Unknown'} (LSTM: ${healthData.services.models?.lstm}, LR: ${healthData.services.models?.linearRegression})`;

        // Predictions
        const predStatus = healthData.services.predictions?.status;
        summary.results.Predictions = predStatus === 'Ready' ? 'PASS' : 'FAIL';
        summary.details.Predictions = `Prediction status: ${predStatus || 'Unknown'}`;
    } else {
        summary.details.OCR = 'Skipped (backend unreachable)';
        summary.details.Models = 'Skipped (backend unreachable)';
        summary.details.Predictions = 'Skipped (backend unreachable)';
    }

    // 6. Dashboard
    try {
        const indexHtml = path.join(__dirname, '..', 'frontend', 'index.html');
        const appJs = path.join(__dirname, '..', 'frontend', 'app.js');
        const styleCss = path.join(__dirname, '..', 'frontend', 'style.css');
        
        const filesExist = fs.existsSync(indexHtml) && fs.existsSync(appJs) && fs.existsSync(styleCss);
        summary.results.Dashboard = filesExist ? 'PASS' : 'FAIL';
        summary.details.Dashboard = filesExist ? 'All static assets present in frontend/' : 'Missing critical static assets in frontend/';
    } catch (err) {
        summary.details.Dashboard = err.message;
    }

    // Overall Status
    const values = Object.values(summary.results);
    if (values.includes('FAIL')) {
        summary.status = 'FAIL';
    }

    const reportPath = path.join(__dirname, '..', 'reports', 'deployment_health_report.json');
    const reportsDir = path.dirname(reportPath);
    if (!fs.existsSync(reportsDir)) {
        fs.mkdirSync(reportsDir, { recursive: true });
    }
    fs.writeFileSync(reportPath, JSON.stringify(summary, null, 2));
    
    console.log('\n--- Results ---');
    for (const [key, val] of Object.entries(summary.results)) {
        console.log(`${key}: ${val}`);
    }
    console.log(`\nOverall Status: ${summary.status}`);
    console.log(`Deployment summary saved to ${reportPath}`);
}

runValidation();
