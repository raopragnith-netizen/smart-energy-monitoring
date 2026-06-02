# ⚡ Smart Energy AI — Intelligent Electricity Consumption Prediction Platform

AI-powered electricity consumption monitoring and prediction platform with OCR bill processing, LSTM deep learning models, and real-time anomaly detection.

## 🏗 Architecture

```
┌──────────────────────────────────┐
│  Frontend (HTML/CSS/JS)          │
│  • Dashboard with live charts    │
│  • Bill upload + OCR results     │
│  • Dark mode support             │
└───────────┬──────────────────────┘
            │ REST API
            ▼
┌──────────────────────────────────┐
│  Node.js Backend (Express)       │
│  • Authentication (JWT)          │
│  • API proxy to ML service       │
│  • MongoDB integration           │
│  • Notification engine           │
└───────────┬──────────────────────┘
            │
            ▼
┌──────────────────────────────────┐
│  Python ML Service (Flask)       │
│  • EasyOCR + OpenCV pipeline     │
│  • LSTM + Linear Regression      │
│  • Anomaly detection             │
│  • Smart recommendations         │
└──────────────────────────────────┘
```

## ✨ Features

- **OCR Bill Processing** — Upload electricity bills (JPG, PNG, PDF) for automatic data extraction using EasyOCR with OpenCV preprocessing
- **ML Predictions** — LSTM deep learning + Linear Regression models for consumption forecasting
- **Anomaly Detection** — Z-score + IQR based detection with severity classification
- **Dashboard Analytics** — Real-time charts, weekly/monthly projections, trend analysis
- **Smart Recommendations** — AI-generated energy saving tips based on usage patterns
- **Dark Mode** — Full theme support with Chart.js color synchronization

## 🚀 Quick Start

### Prerequisites
- Node.js 18+
- Python 3.10+
- MongoDB (local or Atlas)

### Setup

```bash
# Clone the repository
git clone <your-repo-url>
cd energy-ai

# Install backend dependencies
cd backend && npm install && cd ..

# Set up Python virtual environment
cd ml_service
python -m venv venv
# Windows
venv\Scripts\activate
# Linux/Mac
source venv/bin/activate

pip install -r requirements.txt
cd ..

# Configure environment
cp .env.example backend/.env
# Edit backend/.env with your MongoDB URI and JWT secret
```

### Run

```bash
# Start the application (auto-starts ML service)
cd backend && node server.js
```

Open http://localhost:3000 in your browser.

## 📡 API Endpoints

### Health & Status
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Basic health check |
| `/status` | GET | Full platform status (all services) |

### Data & Predictions
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/upload-data` | POST | Upload CSV dataset |
| `/api/upload-bill` | POST | Upload electricity bill for OCR |
| `/api/train-model` | GET | Train ML models |
| `/api/predict` | GET | Get predictions |
| `/api/predict-week` | GET | 7-day predictions |
| `/api/monthly-projection` | GET | Monthly usage projection |
| `/api/realtime-status` | GET | Live dashboard data |
| `/api/enhanced-historical` | GET | Historical data with anomalies |
| `/api/anomaly-detection` | GET | Run anomaly detection |
| `/api/recommendations` | GET | Smart recommendations |

### Authentication
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/auth/register` | POST | Register new user |
| `/api/auth/login` | POST | Login |

## 🔍 OCR Pipeline

The OCR system uses a multi-stage preprocessing pipeline:

1. **Image Upscaling** — Small images scaled to 1200px minimum
2. **Grayscale Conversion** — Convert to single channel
3. **CLAHE Enhancement** — Adaptive histogram equalization (OpenCV)
4. **Bilateral Filtering** — Edge-preserving noise removal
5. **Adaptive Thresholding** — Gaussian-weighted local binarization
6. **Deskew Correction** — Automatic rotation via Hough line detection
7. **Multi-Pass OCR** — Runs on original + PIL-preprocessed + OpenCV-preprocessed images

**Supported Electricity Boards**: APSPDCL, APEPDCL, TSSPDCL, TSNPDCL, BESCOM, TANGEDCO, MSEDCL, BSES, TATA POWER, UPPCL, WBSEDCL, KSEB, and generic formats.

## 🌐 Deployment

### Vercel (Frontend + API)
The project includes `vercel.json` for automatic deployment. Set these environment variables in Vercel:
- `MONGODB_URI` — MongoDB Atlas connection string
- `JWT_SECRET` — Secret key for JWT tokens
- `ML_SERVICE_URL` — URL of the ML service (deployed on Render)

### Render (Full Stack)
Use the included `render.yaml` blueprint for one-click deployment. See [DEPLOYMENT.md](DEPLOYMENT.md) for step-by-step guide.

## 📁 Project Structure

```
energy-ai/
├── backend/
│   ├── server.js              # Express server (Vercel-compatible)
│   ├── controllers/           # Route handlers
│   ├── routes/                # API route definitions
│   └── package.json
├── frontend/
│   ├── index.html             # Main dashboard
│   ├── login.html             # Authentication page
│   ├── app.js                 # Dashboard logic (~2000 lines)
│   └── style.css              # Design system
├── ml_service/
│   ├── app.py                 # Flask ML API
│   ├── bill_processor.py      # OCR pipeline
│   ├── predict.py             # Prediction engine
│   ├── train_model.py         # Model training
│   ├── lstm_model.py          # LSTM architecture
│   ├── anomaly_detection.py   # Anomaly detection
│   └── requirements.txt
├── database/
│   ├── mongo_connection.js    # MongoDB connection (serverless-safe)
│   └── models/                # Mongoose schemas
├── vercel.json                # Vercel deployment config
├── render.yaml                # Render deployment blueprint
└── .env.example               # Environment variables template
```

## 📜 License

ISC
