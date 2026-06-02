const mongoose = require('mongoose');

const recommendationSchema = new mongoose.Schema({
    date: {
        type: Date,
        default: Date.now
    },
    message: {
        type: String,
        required: true
    },
    type: {
        type: String, // e.g., 'Household', 'Industry'
        default: 'Household'
    }
}, { timestamps: true });

module.exports = mongoose.model('Recommendation', recommendationSchema);
