const mongoose = require('mongoose');

const billRecordSchema = new mongoose.Schema({
    userId: {
        type: String,
        default: 'default'
    },
    // Extracted fields
    consumerNumber: {
        type: String,
        default: null
    },
    billingMonth: {
        type: String,
        default: null
    },
    totalUnits: {
        type: Number,
        default: null
    },
    billAmount: {
        type: Number,
        default: null
    },
    previousReading: {
        type: Number,
        default: null
    },
    currentReading: {
        type: Number,
        default: null
    },
    electricityBoard: {
        type: String,
        default: 'Unknown'
    },
    // Metadata
    originalFileName: {
        type: String,
        required: true
    },
    fileType: {
        type: String,
        enum: ['image', 'pdf'],
        required: true
    },
    extractionConfidence: {
        type: String,
        enum: ['high', 'medium', 'low'],
        default: 'medium'
    },
    rawTextLength: {
        type: Number,
        default: 0
    },
    // Processing status
    status: {
        type: String,
        enum: ['success', 'partial', 'failed'],
        default: 'success'
    },
    errorMessage: {
        type: String,
        default: null
    },
    // Auto-generated daily records count
    generatedRecords: {
        type: Number,
        default: 0
    }
}, {
    timestamps: true
});

// Index for efficient queries
billRecordSchema.index({ userId: 1, createdAt: -1 });
billRecordSchema.index({ consumerNumber: 1 });

module.exports = mongoose.model('BillRecord', billRecordSchema);
