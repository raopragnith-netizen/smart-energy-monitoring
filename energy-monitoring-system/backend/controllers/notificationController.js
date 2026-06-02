const nodemailer = require('nodemailer');
const User = require('../../database/models/User');
const NotificationLog = require('../../database/models/NotificationLog');
const EnergyData = require('../../database/models/EnergyData');
const Anomaly = require('../../database/models/Anomaly');

// Create reusable transporter
function createTransporter() {
    return nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: process.env.SMTP_USER || '',
            pass: process.env.SMTP_PASS || ''
        }
    });
}

// Check if SMTP is properly configured
function isSmtpConfigured() {
    const user = process.env.SMTP_USER || '';
    const pass = process.env.SMTP_PASS || '';
    return user && pass && !user.includes('your-email') && !pass.includes('your-app-password');
}

// Human-like email templates
function buildEmailBody(type, data) {
    const header = `
        <div style="font-family:'Inter',Arial,sans-serif;max-width:600px;margin:0 auto;background:#161b22;color:#c9d1d9;border-radius:12px;overflow:hidden;border:1px solid #30363d;">
            <div style="background:linear-gradient(135deg,#238636,#2ea043);padding:24px;text-align:center;">
                <h1 style="color:#fff;margin:0;font-size:24px;">⚡ Smart Energy AI Alert</h1>
            </div>
            <div style="padding:24px;">
    `;
    const footer = `
                <hr style="border:none;border-top:1px solid #30363d;margin:24px 0;">
                <p style="color:#8b949e;font-size:13px;text-align:center;">This is an automated notification from your Smart Energy AI dashboard.</p>
            </div>
        </div>
    `;

    let body = '';

    if (type === 'spike') {
        body = `
            <h2 style="color:#f85149;margin-bottom:12px;">📈 Unusual Consumption Detected</h2>
            <p>Your power consumption is <strong>higher than usual</strong> today.</p>
            <p>Current usage: <strong>${data.currentUsage?.toFixed(2) || 'N/A'} units</strong></p>
            <p>7-day average: <strong>${data.average?.toFixed(2) || 'N/A'} units</strong></p>
            <p style="color:#f0883e;">That's <strong>${data.percentAbove?.toFixed(0) || 'N/A'}%</strong> above your normal usage.</p>
        `;
    } else if (type === 'budget' || type === 'budget_warning') {
        body = `
            <h2 style="color:#f0883e;margin-bottom:12px;">💰 Budget Threshold Warning</h2>
            <p>Your projected monthly usage is approaching your set budget limit.</p>
            <p>Projected: <strong>${data.projected?.toFixed(2) || 'N/A'} units</strong></p>
            <p>Budget limit: <strong>${data.budgetLimit?.toFixed(2) || 'N/A'} units</strong></p>
            <p>Limiting AC usage to 2 hours and shifting laundry to off-peak hours may help reduce your bill.</p>
        `;
    } else if (type === 'anomaly') {
        body = `
            <h2 style="color:#f85149;margin-bottom:12px;">⚠️ Anomaly Detected</h2>
            <p>Our system detected <strong>${data.anomalyCount || 0} abnormal pattern(s)</strong> in your recent energy consumption.</p>
            <p>This could indicate a faulty appliance, a power surge, or unusual activity.</p>
            <p style="color:#58a6ff;">Check your dashboard for detailed insights.</p>
        `;
    } else if (type === 'test') {
        body = `
            <h2 style="color:#3fb950;margin-bottom:12px;">✅ Test Notification</h2>
            <p>Your email notifications are configured correctly!</p>
            <p>You'll receive alerts for unusual consumption spikes, budget warnings, and anomaly detections.</p>
        `;
    }

    // Add recommendations if available
    if (data.recommendations && data.recommendations.length > 0) {
        body += `
            <div style="background:rgba(88,166,255,0.08);border-left:3px solid #58a6ff;padding:16px;border-radius:4px;margin-top:16px;">
                <h3 style="color:#58a6ff;margin:0 0 8px 0;font-size:15px;">💡 Recommendations</h3>
                <ul style="margin:0;padding-left:20px;">
                    ${data.recommendations.map(r => `<li style="margin-bottom:6px;">${r}</li>`).join('')}
                </ul>
            </div>
        `;
    }

    return header + body + footer;
}

// Send an alert — ALWAYS stores in-app, optionally sends email
async function sendAlert(userId, type, messageText, extraData = {}) {
    try {
        const user = await User.findById(userId);
        if (!user) return { sent: false, reason: 'User not found' };

        // Check if we already sent this type of alert today (prevent spam)
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const existingLog = await NotificationLog.findOne({
            userId,
            type,
            sentAt: { $gte: today }
        });
        if (existingLog && type !== 'test') {
            return { sent: false, reason: 'Already notified today for this type' };
        }

        // ALWAYS store as in-app notification
        const logEntry = await NotificationLog.create({
            userId,
            type,
            message: messageText,
            inApp: true,
            read: false,
            emailSentTo: null
        });

        // Try sending email if notifications are enabled and SMTP is configured
        let emailSent = false;
        if (user.notificationsEnabled && isSmtpConfigured()) {
            const toEmail = user.notificationEmail || user.email;
            if (toEmail) {
                try {
                    const transporter = createTransporter();
                    const htmlBody = buildEmailBody(type, { ...extraData, message: messageText });

                    const subjectMap = {
                        spike: '📈 Smart Energy AI: Unusual consumption detected',
                        budget: '💰 Smart Energy AI: Budget threshold warning',
                        budget_warning: '⚠️ Smart Energy AI: Budget at 80%',
                        anomaly: '⚠️ Smart Energy AI: Anomaly detected in usage',
                        test: '✅ Smart Energy AI: Test notification'
                    };

                    await transporter.sendMail({
                        from: process.env.SMTP_FROM || process.env.SMTP_USER,
                        to: toEmail,
                        subject: subjectMap[type] || 'Smart Energy AI Notification',
                        html: htmlBody
                    });

                    // Update log with email info
                    logEntry.emailSentTo = toEmail;
                    await logEntry.save();
                    emailSent = true;
                } catch (emailErr) {
                    console.error('Email send error (in-app notification still stored):', emailErr.message);
                }
            }
        }

        return { sent: true, inApp: true, emailSent, id: logEntry._id };
    } catch (err) {
        console.error('sendAlert error:', err.message);
        return { sent: false, reason: err.message };
    }
}

// Check all users and send notifications if triggers are met
async function checkAndNotify() {
    try {
        const users = await User.find();
        const results = [];

        for (const user of users) {
            // Get recent energy data
            const recentData = await EnergyData.find().sort({ date: -1 }).limit(30);
            if (recentData.length < 7) continue;

            const last7 = recentData.slice(0, 7);
            const avg7 = last7.reduce((sum, d) => sum + d.units, 0) / last7.length;
            const latest = recentData[0];

            // 1. Spike detection: current > 1.5x average
            if (latest && latest.units > avg7 * 1.5) {
                const result = await sendAlert(user._id, 'spike', `Unusual spike: ${latest.units.toFixed(2)} units (avg: ${avg7.toFixed(2)})`, {
                    currentUsage: latest.units,
                    average: avg7,
                    percentAbove: ((latest.units - avg7) / avg7) * 100,
                    recommendations: [
                        'Reduce AC usage by 1 hour during peak afternoon hours',
                        'Shift washing machine usage to off-peak hours (10pm-6am)',
                        'Unplug idle electronics and chargers'
                    ]
                });
                results.push({ user: user.username, type: 'spike', ...result });
            }

            // 2. Budget threshold: projected monthly > budget
            if (user.budgetLimit > 0) {
                const daysInMonth = 30;
                const avgDaily = last7.reduce((sum, d) => sum + d.units, 0) / 7;
                const projected = avgDaily * daysInMonth;

                // Alert at 100%
                if (projected > user.budgetLimit) {
                    const result = await sendAlert(user._id, 'budget', `⚠ Budget exceeded! Projected: ${projected.toFixed(1)} units (Limit: ${user.budgetLimit} units)`, {
                        projected,
                        budgetLimit: user.budgetLimit,
                        recommendations: [
                            `Your daily average is ${avgDaily.toFixed(1)} units — try reducing to ${(user.budgetLimit / daysInMonth).toFixed(1)} units/day`,
                            'Set appliance timers to avoid idle power consumption',
                            'Consider energy-efficient settings on high-consumption devices'
                        ]
                    });
                    results.push({ user: user.username, type: 'budget', ...result });
                }
                // Warning at 80%
                else if (projected > user.budgetLimit * 0.8) {
                    const result = await sendAlert(user._id, 'budget_warning', `Budget warning: Projected ${projected.toFixed(1)} units is at ${((projected / user.budgetLimit) * 100).toFixed(0)}% of your limit`, {
                        projected,
                        budgetLimit: user.budgetLimit,
                        recommendations: [
                            `You're at ${((projected / user.budgetLimit) * 100).toFixed(0)}% of budget — reduce usage to stay on track`,
                            'Shift heavy appliance usage to off-peak hours'
                        ]
                    });
                    results.push({ user: user.username, type: 'budget_warning', ...result });
                }
            }

            // 3. Anomaly detection trigger
            const recentAnomalies = await Anomaly.find().sort({ createdAt: -1 }).limit(5);
            if (recentAnomalies.length > 0) {
                const result = await sendAlert(user._id, 'anomaly', `${recentAnomalies.length} anomalies detected in recent energy usage`, {
                    anomalyCount: recentAnomalies.length,
                    recommendations: [
                        'Check for faulty appliances or power surges',
                        'Review the anomaly chart on your dashboard for details',
                        'Consider scheduling an electrical inspection if anomalies persist'
                    ]
                });
                results.push({ user: user.username, type: 'anomaly', ...result });
            }
        }

        return results;
    } catch (err) {
        console.error('checkAndNotify error:', err);
        return [];
    }
}

// Controller handlers for routes

// Send test notification
exports.sendTestEmail = async (req, res) => {
    try {
        const userId = req.body.userId;
        if (!userId) return res.status(400).json({ success: false, message: 'userId is required' });

        const result = await sendAlert(userId, 'test', 'This is a test notification from Smart Energy AI.', {
            recommendations: ['Your notifications are working correctly!']
        });

        if (result.sent) {
            const msg = result.emailSent ? `Test email sent and in-app notification stored` : `In-app notification stored (email not configured)`;
            res.json({ success: true, message: msg });
        } else {
            res.json({ success: false, message: result.reason });
        }
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

// Manual trigger check
exports.triggerCheck = async (req, res) => {
    try {
        const results = await checkAndNotify();
        res.json({ success: true, results });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

// Get notification history (filtered by userId)
exports.getHistory = async (req, res) => {
    try {
        const userId = req.query.userId;
        const query = userId ? { userId } : {};
        const logs = await NotificationLog.find(query).sort({ sentAt: -1 }).limit(50);
        const unreadCount = userId ? await NotificationLog.countDocuments({ userId, read: false }) : 0;
        res.json({ success: true, data: logs, unreadCount });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

// Mark notifications as read
exports.markRead = async (req, res) => {
    try {
        const { userId, notificationId } = req.body;
        if (notificationId) {
            await NotificationLog.findByIdAndUpdate(notificationId, { read: true });
        } else if (userId) {
            await NotificationLog.updateMany({ userId, read: false }, { read: true });
        }
        res.json({ success: true, message: 'Notifications marked as read' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

exports.checkAndNotify = checkAndNotify;
