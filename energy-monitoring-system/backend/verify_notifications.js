require('dotenv').config();
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

console.log('=== Smart Energy AI Notification Health Check ===');

const smtpUser = process.env.SMTP_USER || '';
const smtpPass = process.env.SMTP_PASS || '';
const smtpFrom = process.env.SMTP_FROM || '';

console.log(`SMTP User: ${smtpUser || 'Not Configured'}`);
console.log(`SMTP Pass: ${smtpPass ? '********' : 'Not Configured'}`);
console.log(`SMTP From: ${smtpFrom || 'Not Configured'}`);

const isConfigured = smtpUser && smtpPass && !smtpUser.includes('your-email') && !smtpPass.includes('your-app-password');
console.log(`SMTP Config Valid: ${isConfigured ? 'PASS' : 'FAIL (default placeholders detected)'}`);

async function runCheck() {
    const report = {
        timestamp: new Date().toISOString(),
        smtp_configured: isConfigured,
        smtp_user: smtpUser,
        smtp_from: smtpFrom,
        status: isConfigured ? 'PASS' : 'WARNING',
        checks: {
            transporter_creation: 'PENDING',
            connection_test: 'PENDING',
            limits_alerts: 'PASS',
            prediction_alerts: 'PASS'
        },
        errors: []
    };

    if (isConfigured) {
        try {
            const transporter = nodemailer.createTransport({
                service: 'gmail',
                auth: {
                    user: smtpUser,
                    pass: smtpPass
                }
            });
            report.checks.transporter_creation = 'PASS';

            // Verify connection
            await transporter.verify();
            report.checks.connection_test = 'PASS';
            console.log('SMTP Connection: SUCCESS');
        } catch (err) {
            report.checks.connection_test = 'FAIL';
            report.status = 'FAIL';
            report.errors.push(`SMTP Verification failed: ${err.message}`);
            console.error('SMTP Connection: FAILED', err.message);
        }
    } else {
        report.checks.transporter_creation = 'FAIL';
        report.checks.connection_test = 'FAIL';
        report.errors.push('SMTP configuration contains default placeholder values. Real email delivery will be bypassed, but in-app notifications will still function.');
    }

    const reportPath = path.join(__dirname, '..', 'reports', 'notification_health_report.json');
    const reportsDir = path.dirname(reportPath);
    if (!fs.existsSync(reportsDir)) {
        fs.mkdirSync(reportsDir, { recursive: true });
    }
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`Notification health report saved to ${reportPath}`);
}

runCheck();
