# Smart Energy AI — Deployment Guide

This guide covers deploying the Smart Energy AI platform to the cloud for public access.

## Architecture Overview

```
Internet Users
      │
      ▼
┌─────────────────────┐
│  Render Web Service  │ ◄── energyai-backend (Node.js)
│  Serves frontend +   │     Handles API requests
│  proxies ML calls    │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│  Render Web Service  │ ◄── energyai-ml (Python/Flask)
│  OCR, predictions,   │     ML processing
│  anomaly detection   │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│  MongoDB Atlas       │ ◄── Cloud database (free tier)
│  (512MB free)        │
└─────────────────────┘
```

---

## Step 1: MongoDB Atlas Setup

1. Go to [mongodb.com/atlas](https://www.mongodb.com/atlas) and create a free account
2. Create a new **Free Cluster** (M0 tier)
3. Choose a region close to your Render deployment (e.g., Mumbai for India)
4. Set up a database user:
   - Go to **Database Access** → **Add Database User**
   - Username: `energyai`
   - Password: Generate a secure password (save it!)
   - Role: `Read and write to any database`
5. Set up network access:
   - Go to **Network Access** → **Add IP Address**
   - Click **Allow Access from Anywhere** (0.0.0.0/0)
   - This is needed for Render's dynamic IPs
6. Get your connection string:
   - Go to **Database** → **Connect** → **Connect your application**
   - Copy the connection string, it looks like:
     ```
     mongodb+srv://energyai:<password>@cluster0.xxxxx.mongodb.net/energy_monitoring?retryWrites=true&w=majority
     ```
   - Replace `<password>` with your actual password

---

## Step 2: Deploy ML Service to Render

1. Go to [render.com](https://render.com) and sign up (free)
2. Click **New** → **Web Service**
3. Connect your GitHub repository
4. Configure:
   - **Name**: `energyai-ml`
   - **Root Directory**: `energy-monitoring-system/ml_service`
   - **Runtime**: Python 3
   - **Build Command**: `pip install -r requirements.txt`
   - **Start Command**: `gunicorn app:app --bind 0.0.0.0:$PORT --timeout 120 --workers 1`
   - **Plan**: Free
5. Add environment variables:
   | Key | Value |
   |-----|-------|
   | `MONGODB_URI` | Your MongoDB Atlas connection string |
   | `PORT` | `5000` |
   | `PYTHON_ENV` | `production` |
6. Click **Create Web Service**
7. Wait for build to complete (may take 5-10 minutes for TensorFlow)
8. Note the URL (e.g., `https://energyai-ml.onrender.com`)

> **⚠️ Note**: Render free tier has 512MB RAM. TensorFlow + PaddleOCR need ~1-2GB. If the build fails due to memory, you may need:
> - Upgrade to Render Starter ($7/mo) for 2GB RAM, OR
> - Use `tensorflow-cpu` instead of `tensorflow` in requirements.txt

---

## Step 3: Deploy Backend to Render

1. Click **New** → **Web Service** again
2. Connect the same GitHub repository
3. Configure:
   - **Name**: `energyai-backend`
   - **Root Directory**: `energy-monitoring-system/backend`
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Plan**: Free
4. Add environment variables:
   | Key | Value |
   |-----|-------|
   | `MONGODB_URI` | Same MongoDB Atlas connection string |
   | `ML_SERVICE_URL` | URL from Step 2 (e.g., `https://energyai-ml.onrender.com`) |
   | `JWT_SECRET` | A random 64-character string (generate one at [randomkeygen.com](https://randomkeygen.com/)) |
   | `PORT` | `3000` |
   | `NODE_ENV` | `production` |
5. Click **Create Web Service**
6. Wait for build to complete
7. Your app is now live at `https://energyai-backend.onrender.com`

---

## Step 4: Deploy Frontend to Vercel

1. Go to [vercel.com](https://vercel.com) and sign up for a free account.
2. Click **Add New** → **Project**.
3. Import your GitHub repository.
4. Configure the project:
   - **Framework Preset**: Other (it will automatically read `vercel.json` and static files).
   - **Root Directory**: `energy-monitoring-system`.
5. Add the environment variable:
   | Key | Value | Description |
   |-----|-------|-------------|
   | `BACKEND_URL` | `https://energyai-backend.onrender.com` | URL of your Express backend on Render |
6. Click **Deploy**.
7. Once completed, Vercel will generate your live production URL (e.g., `https://energy-ai.vercel.app`).
8. The serverless API proxy (`api/proxy.js`) automatically routes all your requests dynamically to the Render backend, preventing any CORS issues.

---

## Step 5: Verify Deployment

### Health Checks
```bash
# Backend health (via Vercel proxy)
curl https://energy-ai.vercel.app/health

# Backend health (direct)
curl https://energyai-backend.onrender.com/health

# ML service health (direct)
curl https://energyai-ml.onrender.com/health
```

### Test Flow
1. Open your live Vercel URL (e.g. `https://energy-ai.vercel.app`) in your browser.
2. Register a new account.
3. Upload an electricity bill image or PDF.
4. Verify the OCR extraction works and highlights fields requiring check-off.
5. Check dashboard for predictions and analytics.

---

## Troubleshooting

### ML Service fails to start
- Check Render logs for memory errors
- Try adding `tensorflow-cpu` instead of `tensorflow` in requirements.txt
- Ensure MONGODB_URI is correctly set

### Dashboard shows blank
- Check browser console for API errors
- Verify ML_SERVICE_URL points to the correct Render URL
- Ensure MongoDB Atlas IP whitelist includes 0.0.0.0/0

### OCR not working
- PaddleOCR needs ~1GB RAM on first load (downloads model weights)
- Check ML service logs for OOM errors
- Consider upgrading Render plan if needed

### Database connection fails
- Verify MongoDB Atlas user password (no special chars like `@` in password)
- Check Network Access allows 0.0.0.0/0
- Test connection string locally first

---

## Environment Variables Reference

| Variable | Service | Required | Description |
|----------|---------|----------|-------------|
| `MONGODB_URI` | Both | Yes | MongoDB connection string |
| `ML_SERVICE_URL` | Backend | Yes | URL of the ML service |
| `JWT_SECRET` | Backend | Yes | Secret for JWT token signing |
| `PORT` | Both | Yes | Port number |
| `NODE_ENV` | Backend | No | Set to `production` for prod |
| `SMTP_HOST` | Backend | No | Email server hostname |
| `SMTP_PORT` | Backend | No | Email server port |
| `SMTP_USER` | Backend | No | Email username |
| `SMTP_PASS` | Backend | No | Email password |
| `FROM_EMAIL` | Backend | No | Sender email address |

---

## Important Notes

1. **Render Free Tier**: Services spin down after 15 minutes of inactivity. First request after idle may take 30-60 seconds.
2. **MongoDB Atlas Free Tier**: 512MB storage, 100 connections. Sufficient for demo/presentation use.
3. **PaddleOCR Models**: Downloaded on first use. Cached in memory after first bill processing.
4. **LSTM Model**: Included in the repository (`models/` directory). No training needed on first deploy.
