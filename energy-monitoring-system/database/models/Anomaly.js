const mongoose = require('mongoose');

const anomalySchema = new mongoose.Schema({
    date: {
        type: Date,
        required: true
    },
    units: {
        type: Number,
        required: true
    },
    expected_units: {
        type: Number
    },
    score: {
        type: Number
    }
}, { timestamps: true });

module.exports = mongoose.model('Anomaly', anomalySchema);
