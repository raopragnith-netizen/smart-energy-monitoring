const mongoose = require('mongoose');

const notificationLogSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    type: {
        type: String,
        enum: ['spike', 'budget', 'anomaly', 'test', 'info', 'budget_warning'],
        required: true
    },
    message: {
        type: String,
        required: true
    },
    emailSentTo: {
        type: String
    },
    read: {
        type: Boolean,
        default: false
    },
    inApp: {
        type: Boolean,
        default: true
    },
    sentAt: {
        type: Date,
        default: Date.now
    }
}, { timestamps: true });

module.exports = mongoose.model('NotificationLog', notificationLogSchema);
