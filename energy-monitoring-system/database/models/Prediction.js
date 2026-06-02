const mongoose = require('mongoose');

const predictionSchema = new mongoose.Schema({
    targetDate: {
        type: Date,
        required: true
    },
    predicted_units: {
        type: Number,
        required: true
    },
    modelUsed: {
        type: String,
        default: 'LSTM'
    }
}, { timestamps: true });

module.exports = mongoose.model('Prediction', predictionSchema);
