/**
 * Smart Energy AI Vercel API Proxy Serverless Function
 * 
 * Proxies incoming API calls on Vercel dynamically to the Render backend
 * specified in the BACKEND_URL environment variable.
 */

// Native fetch is available in Vercel Node.js 18+ runtime
export default async function handler(req, res) {
    // CORS Support
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader(
        'Access-Control-Allow-Headers',
        'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization'
    );

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    // Get path parameter passed from vercel.json routing
    const path = req.query.path || '';
    const backendUrl = process.env.BACKEND_URL || 'https://energy-monitoring-backend-e6hm.onrender.com';
    
    // If the frontend is requesting the backend URL config, return it directly
    if (path === 'config') {
        res.status(200).json({ 
            success: true, 
            backendUrl: backendUrl
        });
        return;
    }
    
    // Construct final destination URL
    const urlObj = new URL(req.url, 'http://localhost');
    const targetPath = (path === 'health' || path === 'status') ? `/${path}` : `/api/${path}`;
    const targetUrl = new URL(targetPath, backendUrl);
    
    // Forward query parameters
    urlObj.searchParams.forEach((value, key) => {
        if (key !== 'path') {
            targetUrl.searchParams.append(key, value);
        }
    });

    // Reconstruct headers to avoid host/connection conflicts
    const headers = {};
    Object.keys(req.headers).forEach(key => {
        if (!['host', 'connection'].includes(key.toLowerCase())) {
            headers[key] = req.headers[key];
        }
    });

    const fetchOptions = {
        method: req.method,
        headers,
    };

    // Forward the request stream if a request body is present
    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
        fetchOptions.body = req;
        fetchOptions.duplex = 'half';
    }

    try {
        console.log(`[Proxy] Routing ${req.method} request to: ${targetUrl.toString()}`);
        const response = await fetch(targetUrl.toString(), fetchOptions);
        const responseData = await response.arrayBuffer();

        // Forward headers back to client
        response.headers.forEach((value, key) => {
            if (!['content-encoding', 'transfer-encoding', 'connection'].includes(key.toLowerCase())) {
                res.setHeader(key, value);
            }
        });

        res.status(response.status).send(Buffer.from(responseData));
    } catch (error) {
        console.error('[Proxy Error] Connection failed:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Smart Energy AI Gateway Proxy Connection Error', 
            error: error.message 
        });
    }
}

// Disable body parsing so req is passed as raw readable stream (critical for file upload/OCR)
export const config = {
    api: {
        bodyParser: false,
    },
};
