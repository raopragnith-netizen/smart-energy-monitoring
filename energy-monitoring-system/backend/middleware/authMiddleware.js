const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'energy_monitor_secret_key_2026';

/**
 * JWT Authentication Middleware.
 * Extracts token from Authorization header, verifies it,
 * and attaches decoded user payload to req.user.
 * Returns 401 if token is missing or invalid.
 */
function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ 
            success: false, 
            message: 'Authentication required. Please log in.' 
        });
    }

    const token = authHeader.split(' ')[1];
    
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = {
            id: decoded.id,
            username: decoded.username,
            email: decoded.email
        };
        next();
    } catch (err) {
        return res.status(401).json({ 
            success: false, 
            message: 'Invalid or expired token. Please log in again.' 
        });
    }
}

module.exports = authMiddleware;
