const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../../database/models/User');
const ActivityLog = require('../../database/models/ActivityLog');

const JWT_SECRET = process.env.JWT_SECRET || 'energy_monitor_secret_key_2026';
const JWT_EXPIRES_IN = '24h';

// Password validation helper
function validatePassword(password) {
    const errors = [];
    if (!password || password.length < 7) {
        errors.push('Password must be at least 7 characters long.');
    }
    if (!/[a-zA-Z]/.test(password)) {
        errors.push('Password must contain at least one alphabet character.');
    }
    if (!/[0-9]/.test(password)) {
        errors.push('Password must contain at least one numeric digit.');
    }
    if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]/.test(password)) {
        errors.push('Password must contain at least one special character.');
    }
    return errors;
}

// Sanitize input to prevent injection
function sanitize(str) {
    if (typeof str !== 'string') return '';
    return str.replace(/[<>]/g, '').trim();
}

// POST /api/auth/register
exports.register = async (req, res) => {
    try {
        const username = sanitize(req.body.username);
        const email = sanitize(req.body.email);
        const password = req.body.password;

        // Validate required fields
        if (!username || !email || !password) {
            return res.status(400).json({ success: false, message: 'All fields are required.' });
        }

        // Validate password rules
        const passwordErrors = validatePassword(password);
        if (passwordErrors.length > 0) {
            return res.status(400).json({ success: false, message: passwordErrors.join(' ') });
        }

        // Check if user already exists
        const existingUser = await User.findOne({ $or: [{ email }, { username }] });
        if (existingUser) {
            return res.status(409).json({ success: false, message: 'Username or email already exists.' });
        }

        // Hash password
        const salt = await bcrypt.genSalt(12);
        const hashedPassword = await bcrypt.hash(password, salt);

        // Create user
        const user = await User.create({
            username,
            email,
            password: hashedPassword
        });

        // Generate JWT
        const token = jwt.sign(
            { id: user._id, username: user.username, email: user.email },
            JWT_SECRET,
            { expiresIn: JWT_EXPIRES_IN }
        );

        // Log activity
        await ActivityLog.create({ userId: user._id, action: 'register', details: `New account created: ${username}` });

        res.status(201).json({
            success: true,
            message: 'Registration successful!',
            token,
            user: {
                id: user._id,
                username: user.username,
                email: user.email,
                budgetLimit: user.budgetLimit || 0,
                notificationsEnabled: user.notificationsEnabled || false,
                notificationEmail: user.notificationEmail || ''
            }
        });

    } catch (error) {
        console.error('Register error:', error);
        if (error.code === 11000) {
            return res.status(409).json({ success: false, message: 'Username or email already exists.' });
        }
        res.status(500).json({ success: false, message: 'Server error during registration.' });
    }
};

// POST /api/auth/login
exports.login = async (req, res) => {
    try {
        const identifier = sanitize(req.body.identifier); // can be email or username
        const password = req.body.password;

        // Validate required fields
        if (!identifier || !password) {
            return res.status(400).json({ success: false, message: 'Email/username and password are required.' });
        }

        // Find user by email or username
        const user = await User.findOne({
            $or: [{ email: identifier.toLowerCase() }, { username: identifier }]
        });

        if (!user) {
            return res.status(401).json({ success: false, message: 'Invalid credentials.' });
        }

        // Compare password
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(401).json({ success: false, message: 'Invalid credentials.' });
        }

        // Generate JWT
        const token = jwt.sign(
            { id: user._id, username: user.username, email: user.email },
            JWT_SECRET,
            { expiresIn: JWT_EXPIRES_IN }
        );

        // Log activity
        await ActivityLog.create({ userId: user._id, action: 'login', details: `User logged in` });

        res.status(200).json({
            success: true,
            message: 'Login successful!',
            token,
            user: {
                id: user._id,
                username: user.username,
                email: user.email,
                budgetLimit: user.budgetLimit || 0,
                notificationsEnabled: user.notificationsEnabled || false,
                notificationEmail: user.notificationEmail || ''
            }
        });

    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ success: false, message: 'Server error during login.' });
    }
};

// PUT /api/auth/update-profile
exports.updateProfile = async (req, res) => {
    try {
        const { userId, budgetLimit, notificationsEnabled, notificationEmail } = req.body;

        if (!userId) {
            return res.status(400).json({ success: false, message: 'userId is required.' });
        }

        const updateFields = {};
        const changes = [];
        if (typeof budgetLimit === 'number') { updateFields.budgetLimit = budgetLimit; changes.push(`Budget: ${budgetLimit}`); }
        if (typeof notificationsEnabled === 'boolean') { updateFields.notificationsEnabled = notificationsEnabled; changes.push(`Notifications: ${notificationsEnabled ? 'ON' : 'OFF'}`); }
        if (typeof notificationEmail === 'string') { updateFields.notificationEmail = sanitize(notificationEmail); changes.push(`Email: ${sanitize(notificationEmail)}`); }

        const user = await User.findByIdAndUpdate(userId, updateFields, { returnDocument: 'after' });

        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found.' });
        }

        // Log activity
        await ActivityLog.create({ userId, action: 'settings_update', details: changes.join(', ') });

        res.json({
            success: true,
            message: 'Profile updated successfully.',
            user: {
                id: user._id,
                username: user.username,
                email: user.email,
                budgetLimit: user.budgetLimit,
                notificationsEnabled: user.notificationsEnabled,
                notificationEmail: user.notificationEmail
            }
        });
    } catch (error) {
        console.error('Update profile error:', error);
        res.status(500).json({ success: false, message: 'Server error updating profile.' });
    }
};

// POST /api/auth/forgot-password
exports.forgotPassword = async (req, res) => {
    try {
        const email = sanitize(req.body.email);
        if (!email) {
            return res.status(400).json({ success: false, message: 'Email is required.' });
        }

        const user = await User.findOne({ email: email.toLowerCase() });

        // Always return success for security (don't reveal if email exists)
        if (!user) {
            return res.json({ success: true, message: 'If that email exists, a reset link has been sent.' });
        }

        // Generate a temporary password reset token (6-digit code)
        const crypto = require('crypto');
        const resetCode = crypto.randomInt(100000, 999999).toString();

        // Store reset code with expiry (15 minutes)
        user.resetCode = resetCode;
        user.resetCodeExpiry = new Date(Date.now() + 15 * 60 * 1000);
        await user.save();

        // Try to send email if SMTP is configured
        try {
            const nodemailer = require('nodemailer');
            const smtpUser = process.env.SMTP_USER || '';
            const smtpPass = process.env.SMTP_PASS || '';

            if (smtpUser && smtpPass && !smtpUser.includes('your-email')) {
                const transporter = nodemailer.createTransport({
                    service: 'gmail',
                    auth: { user: smtpUser, pass: smtpPass }
                });

                await transporter.sendMail({
                    from: process.env.SMTP_FROM || smtpUser,
                    to: user.email,
                    subject: 'Smart Energy AI — Password Reset Code',
                    html: `
                        <div style="font-family:'Inter',Arial,sans-serif;max-width:500px;margin:0 auto;padding:32px;background:#f8f9fb;border-radius:12px;">
                            <h2 style="color:#0f172a;margin-bottom:12px;">Password Reset</h2>
                            <p style="color:#475569;">Your password reset code is:</p>
                            <div style="background:#0f172a;color:#fff;font-size:28px;font-weight:700;letter-spacing:6px;text-align:center;padding:16px;border-radius:8px;margin:16px 0;">${resetCode}</div>
                            <p style="color:#64748b;font-size:13px;">This code expires in 15 minutes. If you didn't request this, ignore this email.</p>
                        </div>
                    `
                });
            }
        } catch (emailErr) {
            console.error('Forgot password email error:', emailErr.message);
        }

        // Log activity
        await ActivityLog.create({ userId: user._id, action: 'forgot_password', details: 'Password reset requested' });

        res.json({ success: true, message: 'If that email exists, a reset link has been sent.' });
    } catch (error) {
        console.error('Forgot password error:', error);
        res.status(500).json({ success: false, message: 'Server error processing request.' });
    }
};

// POST /api/auth/change-password
exports.changePassword = async (req, res) => {
    try {
        const { userId, currentPassword, newPassword } = req.body;

        if (!userId || !currentPassword || !newPassword) {
            return res.status(400).json({ success: false, message: 'All fields are required.' });
        }

        // Validate new password
        const passwordErrors = validatePassword(newPassword);
        if (passwordErrors.length > 0) {
            return res.status(400).json({ success: false, message: passwordErrors.join(' ') });
        }

        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found.' });
        }

        // Verify current password
        const isMatch = await bcrypt.compare(currentPassword, user.password);
        if (!isMatch) {
            return res.status(401).json({ success: false, message: 'Current password is incorrect.' });
        }

        // Hash new password
        const salt = await bcrypt.genSalt(12);
        user.password = await bcrypt.hash(newPassword, salt);
        await user.save();

        // Log activity
        await ActivityLog.create({ userId: user._id, action: 'password_change', details: 'Password changed successfully' });

        res.json({ success: true, message: 'Password changed successfully.' });
    } catch (error) {
        console.error('Change password error:', error);
        res.status(500).json({ success: false, message: 'Server error changing password.' });
    }
};

