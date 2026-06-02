const mongoose = require('mongoose');

// Cache connection for serverless (Vercel) environments
let cached = global._mongooseCache;
if (!cached) {
    cached = global._mongooseCache = { conn: null, promise: null };
}

const connectDB = async () => {
    // If already connected, reuse
    if (cached.conn && mongoose.connection.readyState === 1) {
        return cached.conn;
    }

    const uri = process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/energy_monitoring';

    try {
        if (!cached.promise) {
            cached.promise = mongoose.connect(uri, {
                bufferCommands: false,
            });
        }
        cached.conn = await cached.promise;
        console.log(`MongoDB Connected: ${mongoose.connection.host}`);
        return cached.conn;
    } catch (error) {
        cached.promise = null;
        console.error(`MongoDB Error: ${error.message}`);
        // Don't exit in serverless — just log the error
        if (!process.env.VERCEL) {
            process.exit(1);
        }
        throw error;
    }
};

module.exports = { connectDB, mongoose };
