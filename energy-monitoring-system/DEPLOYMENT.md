# Smart Energy AI — Deployment Guide (Supabase Version)

This guide covers deploying the Smart Energy AI platform to the cloud for public access using **Supabase** (PostgreSQL) for database management and **Render** / **Vercel** for hosting.

---

## Architecture Overview

```
Internet Users
      │
      ▼
┌─────────────────────┐
│    Vercel Hosting   │ ◄── Static Frontend Files
│  (Serverless Proxy) │     Proxies requests to avoid CORS
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│  Render Web Service  │ ◄── energyai-backend (Node.js)
│  (Express API Host) │     Handles user authentication and metadata
└──────────┬──────────┘
           │ (Multipart / HTTP calls)
           ├───────────────────────────────┐
           ▼                               ▼
┌─────────────────────┐         ┌─────────────────────┐
│  Render Web Service  │         │   Supabase Cloud    │
│  energyai-ml (Flask)│         │     PostgreSQL      │
│  Predictions / OCR  │         │  Persistent Storage │
└──────────┬──────────┘         └──────────▲──────────┘
           │                               │
           └───────────────────────────────┘
```

---

## Step 1: Supabase Database Setup

1. Go to [supabase.com](https://supabase.com) and sign up for a free account.
2. Click **New Project** and select/create an organization.
3. Configure your project:
   - **Name**: `Smart Energy AI`
   - **Database Password**: Generate a secure password (save it!)
   - **Region**: Choose a region close to your Render deployment (e.g., Singapore or Mumbai for Asia, Oregon or N. Virginia for USA).
4. Wait a couple of minutes for your database to provision.
5. **Run the SQL Schema**:
   - Go to the **SQL Editor** from the left navigation bar (the `>_` icon).
   - Click **New query**.
   - Copy the entire contents of [schema.sql](file:///c:/Users/PRAGNITH/OneDrive/Desktop/rtrp/energy-monitoring-system/schema.sql) and paste it into the editor.
   - Click **Run** at the bottom right. This initializes all the required tables (`users`, `energy_data`, `predictions`, `anomalies`, `bill_records`, etc.) and performance indexes.
6. **Retrieve API Credentials**:
   - Go to **Project Settings** (the gear icon at the bottom of the sidebar) → **API**.
   - Copy your **Project URL** (under Project API keys). This is your `SUPABASE_URL`.
   - Copy your **anon public API Key**. This is your `SUPABASE_KEY`.

---

## Step 2: Deploy Python ML Service to Render

1. Go to [render.com](https://render.com) and sign up (free).
2. Click **New** → **Web Service**.
3. Connect your GitHub repository.
4. Configure the service:
   - **Name**: `energyai-ml`
   - **Root Directory**: `ml_service`
   - **Runtime**: Python 3
   - **Build Command**: `pip install -r requirements.txt`
   - **Start Command**: `gunicorn app:app --bind 0.0.0.0:$PORT --timeout 120 --workers 1`
   - **Plan**: Free
5. Add the following **Environment Variables**:
   
   | Key | Value | Description |
   |-----|-------|-------------|
   | `SUPABASE_URL` | Your Supabase project URL | Copy from Step 1 |
   | `SUPABASE_KEY` | Your Supabase anon public key | Copy from Step 1 |
   | `PORT` | `5000` | Port for Flask web server |
   | `PYTHON_ENV` | `production` | Run environment mode |

6. Click **Create Web Service**.
7. Wait for the build to complete (takes 5-10 minutes due to TensorFlow installation). Note down the service URL once it is live (e.g., `https://energyai-ml.onrender.com`).

> [!TIP]
> **Memory Allocation Optimization**:
> Render free-tier has a 512MB RAM limit. Our codebase has been optimized with PaddlePaddle `auto_growth` memory strategies and lazy-loading of PaddleOCR to boot cleanly within the free tier.

---

## Step 3: Deploy Express Backend to Render

1. Click **New** → **Web Service** again in Render.
2. Connect the same GitHub repository.
3. Configure the service:
   - **Name**: `energyai-backend`
   - **Root Directory**: `backend`
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Plan**: Free
4. Add the following **Environment Variables**:

   | Key | Value | Description |
   |-----|-------|-------------|
   | `SUPABASE_URL` | Your Supabase project URL | Copy from Step 1 |
   | `SUPABASE_KEY` | Your Supabase anon public key | Copy from Step 1 |
   | `ML_SERVICE_URL` | ML Service URL from Step 2 | e.g. `https://energyai-ml.onrender.com` |
   | `JWT_SECRET` | A secure random 64-character string | Generate at [randomkeygen.com](https://randomkeygen.com/) |
   | `PORT` | `3000` | Port for Express server |
   | `NODE_ENV` | `production` | Run environment mode |

5. Click **Create Web Service**.
6. Wait for the build to complete. Note down the backend service URL once it is live (e.g., `https://energyai-backend.onrender.com`).

---

## Step 4: Deploy Frontend to Vercel

1. Go to [vercel.com](https://vercel.com) and sign up for a free account.
2. Click **Add New** → **Project**.
3. Import your GitHub repository.
4. Configure the project:
   - **Framework Preset**: Other (automatically reads `vercel.json`).
   - **Root Directory**: Leave empty (repo root) — Vercel reads `vercel.json` automatically.
5. Add the following **Environment Variable**:

   | Key | Value | Description |
   |-----|-------|-------------|
   | `BACKEND_URL` | URL of your Express backend on Render | e.g., `https://energyai-backend.onrender.com` |

6. Click **Deploy**.
7. Once completed, Vercel will generate your live production URL (e.g., `https://energy-ai.vercel.app`). The serverless API proxy (`api/proxy.js`) automatically routes all your requests dynamically to the Render backend.

---

## Step 5: Verify Deployment

### Health Checks
You can run these curl commands to verify service statuses:
```bash
# Backend health check (via Vercel proxy)
curl https://energy-ai.vercel.app/health

# Backend health check (direct)
curl https://energyai-backend.onrender.com/health

# ML service health check (direct)
curl https://energyai-ml.onrender.com/health
```

### Full System Check
1. Open your live Vercel URL in your browser.
2. Register a new account (success confirms Supabase `users` table write access).
3. Upload an electricity bill image or PDF in the **Bill History** section (verifies PaddleOCR extraction).
4. Upload a CSV dataset (verifies container-agnostic CSV uploading and background LSTM model training).
5. Verify that predictions, anomaly charts, and monthly projections load instantly on your dashboard.

---

## Troubleshooting

### Dashboard shows "Limited (fallback mode)" or ML Service Offline
- Verify that `ML_SERVICE_URL` in the `energyai-backend` env vars matches the `energyai-ml` URL exactly.
- Make sure `SUPABASE_URL` and `SUPABASE_KEY` are configured properly in the Render dashboard for the ML service.
- Render free-tier services spin down after 15 minutes of inactivity. The first request after a cold sleep may take 50 seconds to respond while the containers wake up.

### Database Query/Insert Errors
- Confirm you ran the contents of [schema.sql](file:///c:/Users/PRAGNITH/OneDrive/Desktop/rtrp/energy-monitoring-system/schema.sql) in your Supabase SQL Editor.
- If you see `row-level security policy` errors, verify that Row-Level Security (RLS) is either disabled for your tables (`users`, `energy_data`, etc.) or that you have created policies allowing anonymous/authenticated reads and inserts.

---

## Environment Variables Reference

| Variable | Service | Required | Description |
|----------|---------|----------|-------------|
| `SUPABASE_URL` | Both | Yes | Supabase project URL |
| `SUPABASE_KEY` | Both | Yes | Supabase anon public key |
| `ML_SERVICE_URL` | Backend | Yes | URL of the Python ML web service |
| `JWT_SECRET` | Backend | Yes | Signing key for JSON Web Tokens |
| `PORT` | Both | Yes | Port number |
| `NODE_ENV` | Backend | No | Set to `production` for Express |
| `PYTHON_ENV` | ML Service | No | Set to `production` for Flask |
