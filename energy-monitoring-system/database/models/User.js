const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    username: {
        type: String,
        required: [true, 'Username is required'],
        unique: true,
        trim: true,
        minlength: [3, 'Username must be at least 3 characters']
    },
    email: {
        type: String,
        required: [true, 'Email is required'],
        unique: true,
        trim: true,
        lowercase: true,
        match: [/^\S+@\S+\.\S+$/, 'Please provide a valid email address']
    },
    password: {
        type: String,
        required: [true, 'Password is required'],
        minlength: [7, 'Password must be at least 7 characters']
    },
    // Enhancement fields — safe defaults for existing users
    budgetLimit: {
        type: Number,
        default: 0  // 0 = no limit
    },
    notificationsEnabled: {
        type: Boolean,
        default: false
    },
    notificationEmail: {
        type: String,
        default: ''  // falls back to main email if empty
    },
    resetCode: {
        type: String,
        default: null
    },
    resetCodeExpiry: {
        type: Date,
        default: null
    }
}, {
    timestamps: true
});

module.exports = mongoose.model('User', userSchema);
