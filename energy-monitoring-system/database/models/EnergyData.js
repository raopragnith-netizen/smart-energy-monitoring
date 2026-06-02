const mongoose = require('mongoose');

const energyDataSchema = new mongoose.Schema({
    date: {
        type: Date,
        required: true
    },
    units: {
        type: Number,
        required: true
    },
    predicted_units: {
        type: Number,
        default: null
    },
    anomaly: {
        type: Boolean,
        default: false
    }
}, { timestamps: true });

module.exports = mongoose.model('EnergyData', energyDataSchema);
