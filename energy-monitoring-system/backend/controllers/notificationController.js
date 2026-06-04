const nodemailer = require('nodemailer');
const { supabase } = require('../utils/supabase');

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
        const { data: user, error: userErr } = await supabase
            .from('users')
            .select('*')
            .eq('id', userId)
            .maybeSingle();

        if (userErr) throw userErr;
        if (!user) return { sent: false, reason: 'User not found' };

        // Check if we already sent this type of alert today (prevent spam)
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const { data: existingLog, error: logErr } = await supabase
            .from('notification_logs')
            .select('id')
            .eq('user_id', userId)
            .eq('type', type)
            .gte('sent_at', today.toISOString())
            .maybeSingle();

        if (logErr) throw logErr;

        if (existingLog && type !== 'test') {
            return { sent: false, reason: 'Already notified today for this type' };
        }

        // ALWAYS store as in-app notification
        const { data: logEntry, error: insertErr } = await supabase
            .from('notification_logs')
            .insert({
                user_id: userId,
                type,
                message: messageText,
                in_app: true,
                read: false,
                email_sent_to: null
            })
            .select()
            .single();

        if (insertErr) throw insertErr;

        // Try sending email if notifications are enabled and SMTP is configured
        let emailSent = false;
        if (user.notifications_enabled && isSmtpConfigured()) {
            const toEmail = user.notification_email || user.email;
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
                    const { error: updateErr } = await supabase
                        .from('notification_logs')
                        .update({ email_sent_to: toEmail })
                        .eq('id', logEntry.id);
                    
                    if (updateErr) throw updateErr;
                    emailSent = true;
                } catch (emailErr) {
                    console.error('Email send error (in-app notification still stored):', emailErr.message);
                }
            }
        }

        return { sent: true, inApp: true, emailSent, id: logEntry.id };
    } catch (err) {
        console.error('sendAlert error:', err.message);
        return { sent: false, reason: err.message };
    }
}

// Check all users and send notifications if triggers are met
async function checkAndNotify() {
    try {
        const { data: users, error: userErr } = await supabase.from('users').select('*');
        if (userErr) throw userErr;
        if (!users || users.length === 0) return [];

        const results = [];

        for (const user of users) {
            // Get recent energy data
            const { data: recentData, error: dataErr } = await supabase
                .from('energy_data')
                .select('*')
                .eq('user_id', user.id)
                .order('date', { ascending: false })
                .limit(30);

            if (dataErr) throw dataErr;
            if (!recentData || recentData.length < 7) continue;

            const last7 = recentData.slice(0, 7);
            const avg7 = last7.reduce((sum, d) => sum + parseFloat(d.units), 0) / last7.length;
            const latest = recentData[0];

            // 1. Spike detection: current > 1.5x average
            if (latest && parseFloat(latest.units) > avg7 * 1.5) {
                const result = await sendAlert(user.id, 'spike', `Unusual spike: ${parseFloat(latest.units).toFixed(2)} units (avg: ${avg7.toFixed(2)})`, {
                    currentUsage: parseFloat(latest.units),
                    average: avg7,
                    percentAbove: ((parseFloat(latest.units) - avg7) / avg7) * 100,
                    recommendations: [
                        'Reduce AC usage by 1 hour during peak afternoon hours',
                        'Shift washing machine usage to off-peak hours (10pm-6am)',
                        'Unplug idle electronics and chargers'
                    ]
                });
                results.push({ user: user.username, type: 'spike', ...result });
            }

            // 2. Budget threshold: projected monthly > budget
            const budgetLimit = parseFloat(user.budget_limit || 0);
            if (budgetLimit > 0) {
                const daysInMonth = 30;
                const avgDaily = last7.reduce((sum, d) => sum + parseFloat(d.units), 0) / 7;
                const projected = avgDaily * daysInMonth;

                // Alert at 100%
                if (projected > budgetLimit) {
                    const result = await sendAlert(user.id, 'budget', `⚠ Budget exceeded! Projected: ${projected.toFixed(1)} units (Limit: ${budgetLimit} units)`, {
                        projected,
                        budgetLimit,
                        recommendations: [
                            `Your daily average is ${avgDaily.toFixed(1)} units — try reducing to ${(budgetLimit / daysInMonth).toFixed(1)} units/day`,
                            'Set appliance timers to avoid idle power consumption',
                            'Consider energy-efficient settings on high-consumption devices'
                        ]
                    });
                    results.push({ user: user.username, type: 'budget', ...result });
                }
                // Warning at 80%
                else if (projected > budgetLimit * 0.8) {
                    const result = await sendAlert(user.id, 'budget_warning', `Budget warning: Projected ${projected.toFixed(1)} units is at ${((projected / budgetLimit) * 100).toFixed(0)}% of your limit`, {
                        projected,
                        budgetLimit,
                        recommendations: [
                            `You're at ${((projected / budgetLimit) * 100).toFixed(0)}% of budget — reduce usage to stay on track`,
                            'Shift heavy appliance usage to off-peak hours'
                        ]
                    });
                    results.push({ user: user.username, type: 'budget_warning', ...result });
                }
            }

            // 3. Anomaly detection trigger
            const { data: recentAnomalies, error: anomErr } = await supabase
                .from('anomalies')
                .select('*')
                .eq('user_id', user.id)
                .order('created_at', { ascending: false })
                .limit(5);

            if (anomErr) throw anomErr;

            if (recentAnomalies && recentAnomalies.length > 0) {
                const result = await sendAlert(user.id, 'anomaly', `${recentAnomalies.length} anomalies detected in recent energy usage`, {
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
        const userId = req.user.id;

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
        const userId = req.user.id;
        let query = supabase.from('notification_logs').select('*').eq('user_id', userId).order('sent_at', { ascending: false }).limit(50);
        
        const { data: logs, error: logsErr } = await query;
        if (logsErr) throw logsErr;

        let unreadCount = 0;
        const { count, error: countErr } = await supabase
            .from('notification_logs')
            .select('*', { count: 'exact', head: true })
            .eq('user_id', userId)
            .eq('read', false);
        if (countErr) throw countErr;
        unreadCount = count || 0;

        const mappedLogs = (logs || []).map(l => ({
            id: l.id,
            userId: l.user_id,
            type: l.type,
            message: l.message,
            emailSentTo: l.email_sent_to,
            read: l.read,
            inApp: l.in_app,
            sentAt: l.sent_at,
            createdAt: l.created_at,
            updatedAt: l.updated_at
        }));

        res.json({ success: true, data: mappedLogs, unreadCount });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

// Mark notifications as read
exports.markRead = async (req, res) => {
    try {
        const userId = req.user.id;
        const { notificationId } = req.body;
        if (notificationId) {
            const { error } = await supabase
                .from('notification_logs')
                .update({ read: true })
                .eq('id', notificationId)
                .eq('user_id', userId);
            if (error) throw error;
        } else {
            const { error } = await supabase
                .from('notification_logs')
                .update({ read: true })
                .eq('user_id', userId)
                .eq('read', false);
            if (error) throw error;
        }
        res.json({ success: true, message: 'Notifications marked as read' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

exports.checkAndNotify = checkAndNotify;
