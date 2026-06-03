"""
app.py — Flask ML Service for Smart Energy AI v2.0.

Provides endpoints for:
- CSV data processing and feature engineering
- LSTM + Linear Regression model training
- Single-day and 7-day iterative predictions
- Monthly usage projection with budget tracking
- Enhanced anomaly detection with severity classification
- Context-aware smart recommendations
- OCR-based electricity bill processing
- Service health monitoring
"""

from flask import Flask, request, jsonify
from flask_cors import CORS
from pymongo import MongoClient
from dotenv import load_dotenv
import pandas as pd
import numpy as np
import json
from datetime import datetime, timedelta

from data_processor import process_and_store_csv
from train_model import train_all_models
from predict import generate_predictions, generate_weekly_predictions
from anomaly_detection import detect_abnormalities
from bill_processor import extract_bill_data, bill_data_to_energy_records
import os
import traceback

load_dotenv()

app = Flask(__name__)
CORS(app)

# Ensure uploads directory exists
UPLOAD_DIR = os.path.join(os.path.dirname(__file__), 'uploads')
os.makedirs(UPLOAD_DIR, exist_ok=True)

MONGO_URI = os.environ.get('MONGODB_URI', os.environ.get('MONGO_URI', 'mongodb://127.0.0.1:27017/energy_monitoring'))
client = MongoClient(MONGO_URI)
db = client.get_default_database() if '/' in MONGO_URI.split('://')[-1] else client['energy_monitoring']

# Warm up / initialize models and OCR on startup
print("[startup] Initializing ML services...")
try:
    from predict import load_lstm, load_lr
    load_lstm()
    load_lr()
    print("[startup] ML models loaded successfully.")
except Exception as e:
    print(f"[startup] ML models failed to load: {e}")

try:
    from bill_processor import _get_paddleocr_reader
    print("[startup] Initializing OCR reader...")
    _get_paddleocr_reader()
    print("[startup] OCR reader initialized successfully.")
except Exception as e:
    print(f"[startup] OCR reader failed to initialize: {e}")


@app.route('/process-csv', methods=['POST'])
def process_csv():
    """Process an uploaded CSV file and store records in MongoDB."""
    data = request.json
    file_path = data.get('file_path')
    if not file_path:
        return jsonify({"success": False, "message": "No file path provided"}), 400
    
    try:
        inserted_count = process_and_store_csv(file_path, db)
        return jsonify({"success": True, "message": f"Successfully processed and stored {inserted_count} records."})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 500


@app.route('/train', methods=['GET'])
def train():
    """Train all ML models (Linear Regression + LSTM) on historical data."""
    try:
        metrics = train_all_models(db)
        return jsonify({"success": True, "message": "Models trained successfully.", "metrics": metrics})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 500


@app.route('/predict', methods=['GET'])
def predict():
    """Generate a single next-day prediction."""
    try:
        predictions = generate_predictions(db)
        return jsonify({"success": True, "predictions": predictions})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 500


@app.route('/predict-week', methods=['GET'])
def predict_week():
    """Generate 7-day iterative predictions for the upcoming week.
    
    Returns:
        JSON with predictions array (7 items), each containing:
        - targetDate, predicted_units, dayName, modelUsed
        Also includes weeklyTotal (sum of all 7 days).
    """
    try:
        predictions = generate_weekly_predictions(db)
        weekly_total = sum(p['predicted_units'] for p in predictions) if predictions else 0.0
        return jsonify({
            "success": True,
            "predictions": predictions,
            "weeklyTotal": round(weekly_total, 2)
        })
    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 500


@app.route('/monthly-projection', methods=['GET'])
def monthly_projection():
    """Calculate projected monthly consumption based on historical data.
    
    Uses the last 7 days of actual data to compute a daily average,
    then projects total monthly usage. Compares with weekly predictions
    if available for more accuracy.
    
    Returns:
        JSON with projected monthly total, days elapsed, days remaining,
        actual usage so far, and daily average.
    """
    try:
        # Get all data for the current month
        now = datetime.now()
        month_start = datetime(now.year, now.month, 1)
        
        cursor = db.energydatas.find({'date': {'$gte': month_start}}).sort('date', 1)
        month_data = list(cursor)
        
        # Get last 7 days for average calculation
        recent_cursor = db.energydatas.find().sort('date', -1).limit(7)
        recent_data = list(recent_cursor)
        
        if not recent_data:
            return jsonify({
                "success": True,
                "projected": 0,
                "daysElapsed": 0,
                "daysRemaining": 30,
                "actualSoFar": 0,
                "dailyAvg": 0
            })
        
        # Calculate daily average from recent data
        daily_avg = sum(d['units'] for d in recent_data) / len(recent_data)
        
        # Days in current month
        if now.month == 12:
            next_month = datetime(now.year + 1, 1, 1)
        else:
            next_month = datetime(now.year, now.month + 1, 1)
        days_in_month = (next_month - month_start).days
        
        days_elapsed = now.day
        days_remaining = days_in_month - days_elapsed
        
        # Actual consumption so far this month
        actual_so_far = sum(d['units'] for d in month_data)
        
        # Projected total = actual so far + (daily avg × days remaining)
        projected = actual_so_far + (daily_avg * days_remaining)
        
        return jsonify({
            "success": True,
            "projected": round(projected, 2),
            "daysElapsed": days_elapsed,
            "daysRemaining": days_remaining,
            "daysInMonth": days_in_month,
            "actualSoFar": round(actual_so_far, 2),
            "dailyAvg": round(daily_avg, 2)
        })
    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 500


@app.route('/detect-anomalies', methods=['GET'])
def anomalies():
    """Run anomaly detection using Isolation Forest."""
    try:
        anomalies_list = detect_abnormalities(db)
        return jsonify({"success": True, "anomalies": anomalies_list})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 500


@app.route('/latest-prediction', methods=['GET'])
def latest_prediction():
    """Return the most recent prediction for recommendation generation."""
    try:
        latest = db.predictions.find_one(sort=[('targetDate', -1)])
        if not latest:
            return jsonify({"success": True, "predicted_units": 0, "current_trend": "normal"})
        return jsonify({
            "success": True, 
            "predicted_units": latest.get('predicted_units', 0), 
            "current_trend": "high" if latest.get('predicted_units', 0) > 15 else "normal"
        })
    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 500


@app.route('/smart-recommendations', methods=['GET'])
def smart_recommendations():
    """Generate context-aware energy recommendations based on usage patterns."""
    try:
        # Get historical data
        cursor = db.energydatas.find().sort('date', 1)
        data = list(cursor)
        if not data:
            return jsonify({"success": True, "recommendations": []})

        df = pd.DataFrame(data)
        suggestions = []

        avg_units = df['units'].mean()
        recent_avg = df['units'].tail(7).mean() if len(df) >= 7 else avg_units

        # Get latest prediction
        latest_pred = db.predictions.find_one(sort=[('targetDate', -1)])
        predicted = latest_pred.get('predicted_units', 0) if latest_pred else 0

        # 1. Critical spike detection
        if predicted > avg_units * 1.4:
            suggestions.append({
                "message": f"Critical spike alert! Predicted usage ({predicted:.1f} kWh) is 40%+ above your average. Check for faulty appliances or cooling issues.",
                "type": "Prediction", "priority": "high"
            })
        elif predicted > avg_units * 1.15:
            suggestions.append({
                "message": f"Tomorrow's predicted usage ({predicted:.1f} kWh) is trending higher. Consider pre-cooling your home during off-peak hours.",
                "type": "Prediction", "priority": "medium"
            })

        # 2. Historical comparison logic
        if len(df) >= 21:
            recent_2_weeks = df['units'].iloc[-14:].mean()
            prev_2_weeks = df['units'].iloc[-28:-14].mean() if len(df) >= 28 else avg_units
            
            diff = (recent_2_weeks - prev_2_weeks) / (prev_2_weeks or 1) * 100
            if diff > 10:
                suggestions.append({
                    "message": f"Your usage is up {diff:.0f}% compared to the previous fortnight. Review your appliance runtime logs.",
                    "type": "Trend", "priority": "high"
                })
            elif diff < -5:
                suggestions.append({
                    "message": f"Excellent progress! Your usage has dropped by {abs(diff):.0f}% recently. Keep these energy-saving habits!",
                    "type": "Trend", "priority": "info"
                })

        # 3. Time-of-use optimization
        suggestions.append({
            "message": "Heavy load tip: Running your dishwasher and geyser before 7 AM or after 10 PM can reduce peak load strain on your local grid.",
            "type": "Household", "priority": "medium"
        })

        # 4. Specific Appliance Insights (based on usage level)
        if avg_units > 30:
            suggestions.append({
                "message": "High base load detected. Consider upgrading to inverter-based heavy appliances to reduce consumption by up to 30%.",
                "type": "Hardware", "priority": "medium"
            })
        
        # 5. Seasonal Advice (India specific)
        month = datetime.now().month
        if month in [3, 4, 5, 6]: # Summer
            suggestions.append({
                "message": "Summer efficiency: Clean your AC filters every 15 days. Dirty filters can increase power consumption by 15%.",
                "type": "Seasonal", "priority": "high"
            })
        elif month in [10, 11, 12, 1]: # Winter
            suggestions.append({
                "message": "Winter efficiency: Use solar water heaters if possible, as geysers are the largest energy consumers in winter.",
                "type": "Seasonal", "priority": "medium"
            })

        return jsonify({"success": True, "recommendations": suggestions})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 500


@app.route('/health', methods=['GET'])
def health():
    """Service health check — returns status, uptime, and model availability."""
    models_available = {
        "lstm": os.path.exists('models/lstm_model.keras'),
        "linear_regression": os.path.exists('models/lr_model.pkl'),
        "scaler": os.path.exists('models/scaler.pkl')
    }
    
    # Check if OCR engine is likely functional
    ocr_status = "uninitialized"
    try:
        from bill_processor import _paddleocr_reader
        ocr_status = "ready" if _paddleocr_reader is not None else "not_loaded"
    except:
        ocr_status = "error"

    record_count = db.energydatas.count_documents({})
    return jsonify({
        "status": "healthy",
        "service": "Smart Energy AI ML Service",
        "version": "2.0",
        "models": models_available,
        "ocr_engine": ocr_status,
        "data_records": record_count,
        "timestamp": datetime.now().isoformat()
    })


@app.route('/process-bill', methods=['POST'])
def process_bill():
    """Process an uploaded electricity bill image or PDF via OCR.
    
    After extraction, automatically:
      1. Generates daily energy records
      2. Clears old predictions and anomalies
      3. Retrains ML models on updated dataset
      4. Generates fresh predictions
      5. Runs anomaly detection
    
    This ensures every upload produces unique, data-driven analytics.
    """
    if 'bill' not in request.files:
        return jsonify({"success": False, "message": "No bill file provided"}), 400
    
    file = request.files['bill']
    if file.filename == '':
        return jsonify({"success": False, "message": "No file selected"}), 400
    
    # Validate file extension
    allowed_ext = {'.jpg', '.jpeg', '.png', '.pdf', '.bmp', '.webp'}
    ext = os.path.splitext(file.filename)[1].lower()
    if ext not in allowed_ext:
        return jsonify({
            "success": False,
            "message": f"Unsupported file format: {ext}. Accepted formats: JPG, PNG, PDF"
        }), 400
    
    # Save uploaded file
    safe_name = f"{datetime.now().strftime('%Y%m%d_%H%M%S')}_{file.filename}"
    file_path = os.path.join(UPLOAD_DIR, safe_name)
    file.save(file_path)
    
    try:
        # ---- Step 1: OCR Extraction ----
        print(f"[pipeline] Step 1: Extracting data from {file.filename}")
        bill_data = extract_bill_data(file_path)
        print(f"[pipeline] Extracted: units={bill_data.get('total_units')}, "
              f"amount={bill_data.get('bill_amount')}, "
              f"board={bill_data.get('electricity_board')}, "
              f"confidence={bill_data.get('confidence')}")
        
        # ---- Step 2: Generate daily records ----
        print("[pipeline] Step 2: Generating daily consumption records")
        energy_records = bill_data_to_energy_records(bill_data)
        
        # ---- Step 3: Store bill record ----
        bill_record = {
            "consumerNumber": bill_data.get('consumer_number'),
            "billingMonth": bill_data.get('billing_month'),
            "totalUnits": bill_data.get('total_units'),
            "billAmount": bill_data.get('bill_amount'),
            "previousReading": bill_data.get('previous_reading'),
            "currentReading": bill_data.get('current_reading'),
            "electricityBoard": bill_data.get('electricity_board', 'Unknown'),
            "originalFileName": file.filename,
            "fileType": "pdf" if ext == '.pdf' else "image",
            "extractionConfidence": bill_data.get('confidence', 'medium'),
            "rawTextLength": bill_data.get('raw_text_length', 0),
            "status": "success" if bill_data.get('total_units') else "partial",
            "generatedRecords": len(energy_records),
            "createdAt": datetime.now()
        }
        db.billrecords.insert_one(bill_record)
        
        # ---- Step 4: Insert energy records ----
        if energy_records:
            records_to_insert = []
            for rec in energy_records:
                records_to_insert.append({
                    "date": datetime.fromisoformat(rec['date']),
                    "units": float(rec['units']),
                    "predicted_units": None,
                    "anomaly": False,
                    "source": "bill_ocr"
                })
            db.energydatas.insert_many(records_to_insert)
            print(f"[pipeline] Inserted {len(records_to_insert)} energy records into DB")
        
        # ---- Step 5: Clear stale predictions and anomalies ----
        print("[pipeline] Step 5: Clearing old predictions and anomalies")
        db.predictions.delete_many({})
        db.anomalies.delete_many({})
        db.energydatas.update_many({}, {'$set': {'anomaly': False}})
        
        # ---- Step 6: Auto-retrain models ----
        train_metrics = {}
        try:
            print("[pipeline] Step 6: Retraining ML models on updated dataset")
            train_metrics = train_all_models(db)
            print(f"[pipeline] Training complete: {train_metrics.get('total_records', 0)} records, "
                  f"LR R²={train_metrics.get('LinearRegression_R2', 'N/A')}")
        except Exception as te:
            print(f"[pipeline] Training skipped: {te}")
            train_metrics = {"status": "skipped", "reason": str(te)}
        
        # ---- Step 7: Auto-generate predictions ----
        fresh_predictions = []
        try:
            print("[pipeline] Step 7: Generating fresh predictions")
            fresh_predictions = generate_predictions(db)
            print(f"[pipeline] Generated {len(fresh_predictions)} predictions")
        except Exception as pe:
            print(f"[pipeline] Prediction skipped: {pe}")
        
        # ---- Step 8: Auto-detect anomalies ----
        fresh_anomalies = []
        try:
            print("[pipeline] Step 8: Running anomaly detection")
            fresh_anomalies = detect_abnormalities(db)
            print(f"[pipeline] Detected {len(fresh_anomalies)} anomalies")
        except Exception as ae:
            print(f"[pipeline] Anomaly detection skipped: {ae}")
        
        # Build response
        response_data = {
            "success": True,
            "message": f"Bill processed! {len(energy_records)} records generated, models retrained.",
            "extracted": {
                "consumerNumber": bill_data.get('consumer_number'),
                "billingMonth": bill_data.get('billing_month'),
                "totalUnits": bill_data.get('total_units'),
                "billAmount": bill_data.get('bill_amount'),
                "previousReading": bill_data.get('previous_reading'),
                "currentReading": bill_data.get('current_reading'),
                "electricityBoard": bill_data.get('electricity_board', 'Unknown'),
                "confidence": bill_data.get('confidence', 'medium'),
            },
            "recordsGenerated": len(energy_records),
            "pipelineResults": {
                "trained": "status" not in train_metrics,
                "predictionsGenerated": len(fresh_predictions),
                "anomaliesDetected": len(fresh_anomalies),
                "datasetSize": db.energydatas.count_documents({})
            }
        }
        
        print(f"[pipeline] Complete! Dataset now has {db.energydatas.count_documents({})} records")
        return jsonify(response_data)
        
    except ValueError as ve:
        return jsonify({
            "success": False,
            "message": str(ve),
            "errorType": "validation"
        }), 400
    except Exception as e:
        traceback.print_exc()
        return jsonify({
            "success": False,
            "message": f"Failed to process bill: {str(e)}",
            "errorType": "processing"
        }), 500
    finally:
        # Clean up uploaded file
        try:
            os.remove(file_path)
        except OSError:
            pass


@app.route('/full-pipeline', methods=['POST'])
def full_pipeline():
    """Run the full ML pipeline: clear stale data → retrain → predict → detect anomalies.
    
    Called after CSV upload or when user wants to refresh all analytics.
    Returns fresh predictions, anomaly count, and training metrics.
    """
    try:
        # Clear stale predictions and anomalies
        db.predictions.delete_many({})
        db.anomalies.delete_many({})
        db.energydatas.update_many({}, {'$set': {'anomaly': False}})
        
        record_count = db.energydatas.count_documents({})
        if record_count == 0:
            return jsonify({"success": False, "message": "No data to analyze. Upload data first."}), 400
        
        print(f"[full-pipeline] Starting with {record_count} records")
        
        # Train
        metrics = {}
        try:
            metrics = train_all_models(db)
            print(f"[full-pipeline] Training complete")
        except Exception as e:
            print(f"[full-pipeline] Training error: {e}")
            metrics = {"error": str(e)}
        
        # Predict
        predictions = []
        try:
            predictions = generate_predictions(db)
            print(f"[full-pipeline] Generated {len(predictions)} predictions")
        except Exception as e:
            print(f"[full-pipeline] Prediction error: {e}")
        
        # Anomalies
        anomalies = []
        try:
            anomalies = detect_abnormalities(db)
            print(f"[full-pipeline] Detected {len(anomalies)} anomalies")
        except Exception as e:
            print(f"[full-pipeline] Anomaly error: {e}")
        
        return jsonify({
            "success": True,
            "message": f"Pipeline complete: {record_count} records analyzed.",
            "metrics": metrics,
            "predictions": predictions,
            "anomalies": len(anomalies),
            "datasetSize": record_count
        })
    except Exception as e:
        traceback.print_exc()
        return jsonify({"success": False, "message": str(e)}), 500


@app.route('/ocr-bill', methods=['POST'])
def ocr_bill():
    """Process an uploaded electricity bill image or PDF via OCR and return extracted data.
    
    Does NOT save anything to database or trigger prediction.
    """
    if 'bill' not in request.files:
        return jsonify({"success": False, "message": "No bill file provided"}), 400
    
    file = request.files['bill']
    if file.filename == '':
        return jsonify({"success": False, "message": "No file selected"}), 400
    
    # Validate file extension
    allowed_ext = {'.jpg', '.jpeg', '.png', '.pdf', '.bmp', '.webp'}
    ext = os.path.splitext(file.filename)[1].lower()
    if ext not in allowed_ext:
        return jsonify({
            "success": False,
            "message": f"Unsupported file format: {ext}. Accepted formats: JPG, PNG, PDF"
        }), 400
    
    # Save uploaded file
    safe_name = f"{datetime.now().strftime('%Y%m%d_%H%M%S')}_{file.filename}"
    file_path = os.path.join(UPLOAD_DIR, safe_name)
    file.save(file_path)
    
    try:
        print(f"[ocr] Step 1: Extracting data from {file.filename}")
        bill_data = extract_bill_data(file_path)
        
        response_data = {
            "success": True,
            "extracted": {
                "consumerNumber": bill_data.get('consumer_number'),
                "billingMonth": bill_data.get('billing_month'),
                "totalUnits": bill_data.get('total_units'),
                "billAmount": bill_data.get('bill_amount'),
                "previousReading": bill_data.get('previous_reading'),
                "currentReading": bill_data.get('current_reading'),
                "electricityBoard": bill_data.get('electricity_board', 'Unknown'),
                "confidence": bill_data.get('confidence', 'medium'),
                "confidence_score": bill_data.get('confidence_score', 50),
                "rawTextLength": bill_data.get('raw_text_length', 0),
                "originalFileName": file.filename,
                "fileType": "pdf" if ext == '.pdf' else "image"
            }
        }
        return jsonify(response_data)
    except Exception as e:
        traceback.print_exc()
        return jsonify({"success": False, "message": f"OCR failed: {str(e)}"}), 500
    finally:
        # Clean up uploaded file
        try:
            os.remove(file_path)
        except OSError:
            pass


@app.route('/confirm-bill', methods=['POST'])
def confirm_bill():
    """Receive manually confirmed or corrected bill data, save it, and run the pipeline."""
    data = request.json
    if not data:
        return jsonify({"success": False, "message": "No data provided"}), 400
    
    # Extract fields from payload
    consumer_number = data.get('consumerNumber')
    billing_month = data.get('billingMonth')
    total_units = data.get('totalUnits')
    bill_amount = data.get('billAmount')
    previous_reading = data.get('previousReading')
    current_reading = data.get('currentReading')
    electricity_board = data.get('electricityBoard', 'Unknown')
    original_file_name = data.get('originalFileName', 'manual_entry.png')
    file_type = data.get('fileType', 'image')
    confidence = data.get('extractionConfidence', 'high')
    raw_text_length = data.get('rawTextLength', 0)
    
    # Format bill_data for helper function
    bill_data = {
        'consumer_number': consumer_number,
        'billing_month': billing_month,
        'total_units': float(total_units) if total_units is not None else None,
        'bill_amount': float(bill_amount) if bill_amount is not None else None,
        'previous_reading': float(previous_reading) if previous_reading is not None else None,
        'current_reading': float(current_reading) if current_reading is not None else None,
        'electricity_board': electricity_board,
    }
    
    try:
        # ---- Step 2: Generate daily records ----
        print("[pipeline] Confirming and generating daily consumption records")
        energy_records = bill_data_to_energy_records(bill_data)
        
        # ---- Step 3: Store bill record ----
        bill_record = {
            "consumerNumber": consumer_number,
            "billingMonth": billing_month,
            "totalUnits": total_units,
            "billAmount": bill_amount,
            "previousReading": previous_reading,
            "currentReading": current_reading,
            "electricityBoard": electricity_board,
            "originalFileName": original_file_name,
            "fileType": file_type,
            "extractionConfidence": confidence,
            "rawTextLength": raw_text_length,
            "status": "success" if total_units else "partial",
            "generatedRecords": len(energy_records),
            "createdAt": datetime.now()
        }
        db.billrecords.insert_one(bill_record)
        
        # ---- Step 4: Insert energy records ----
        if energy_records:
            records_to_insert = []
            for rec in energy_records:
                records_to_insert.append({
                    "date": datetime.fromisoformat(rec['date']),
                    "units": float(rec['units']),
                    "predicted_units": None,
                    "anomaly": False,
                    "source": "bill_ocr"
                })
            db.energydatas.insert_many(records_to_insert)
            print(f"[pipeline] Inserted {len(records_to_insert)} energy records into DB")
        
        # ---- Step 5: Clear stale predictions and anomalies ----
        print("[pipeline] Step 5: Clearing old predictions and anomalies")
        db.predictions.delete_many({})
        db.anomalies.delete_many({})
        db.energydatas.update_many({}, {'$set': {'anomaly': False}})
        
        # ---- Step 6: Auto-retrain models ----
        train_metrics = {}
        try:
            print("[pipeline] Step 6: Retraining ML models on updated dataset")
            train_metrics = train_all_models(db)
            print(f"[pipeline] Training complete: {train_metrics.get('total_records', 0)} records, "
                  f"LR R²={train_metrics.get('LinearRegression_R2', 'N/A')}")
        except Exception as te:
            print(f"[pipeline] Training skipped: {te}")
            train_metrics = {"status": "skipped", "reason": str(te)}
        
        # ---- Step 7: Auto-generate predictions ----
        fresh_predictions = []
        try:
            print("[pipeline] Step 7: Generating fresh predictions")
            fresh_predictions = generate_predictions(db)
            print(f"[pipeline] Generated {len(fresh_predictions)} predictions")
        except Exception as pe:
            print(f"[pipeline] Prediction skipped: {pe}")
        
        # ---- Step 8: Auto-detect anomalies ----
        fresh_anomalies = []
        try:
            print("[pipeline] Step 8: Running anomaly detection")
            fresh_anomalies = detect_abnormalities(db)
            print(f"[pipeline] Detected {len(fresh_anomalies)} anomalies")
        except Exception as ae:
            print(f"[pipeline] Anomaly detection skipped: {ae}")
        
        response_data = {
            "success": True,
            "message": f"Bill processed! {len(energy_records)} records generated, models retrained.",
            "recordsGenerated": len(energy_records),
            "pipelineResults": {
                "trained": "status" not in train_metrics,
                "predictionsGenerated": len(fresh_predictions),
                "anomaliesDetected": len(fresh_anomalies),
                "datasetSize": db.energydatas.count_documents({})
            }
        }
        return jsonify(response_data)
    except Exception as e:
        traceback.print_exc()
        return jsonify({"success": False, "message": f"Failed to process bill confirmation: {str(e)}"}), 500


@app.route('/bill-history', methods=['GET'])
def bill_history():
    """Return stored bill records for display."""
    try:
        records = list(db.billrecords.find().sort('createdAt', -1).limit(50))
        result = []
        for r in records:
            r.pop('_id', None)
            if 'createdAt' in r and hasattr(r['createdAt'], 'isoformat'):
                r['createdAt'] = r['createdAt'].isoformat()
            result.append(r)
        return jsonify({"success": True, "records": result})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 500


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=False, use_reloader=False)

