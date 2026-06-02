"""
predict.py — Energy consumption prediction module.

Provides single-day and 7-day iterative forecasting using a trained LSTM model.
Falls back to Linear Regression when LSTM is unavailable.
Predictions are saved to MongoDB for downstream use (dashboard, notifications).
"""

import pandas as pd
import numpy as np
import pickle
import os
from datetime import timedelta


_cached_lstm = None
_cached_scaler = None
_cached_lr = None

def load_lstm(force_reload=False):
    """Safely load and cache the LSTM model and scaler."""
    global _cached_lstm, _cached_scaler
    if force_reload or _cached_lstm is None:
        try:
            from tensorflow.keras.models import load_model
            _cached_lstm = load_model('models/lstm_model.keras')
            with open('models/scaler.pkl', 'rb') as f:
                _cached_scaler = pickle.load(f)
            print("[predict] LSTM model and scaler loaded successfully.")
        except Exception as e:
            print(f"[predict] Could not load LSTM: {e}")
            _cached_lstm, _cached_scaler = None, None
    return _cached_lstm, _cached_scaler


def load_lr(force_reload=False):
    """Safely load and cache the Linear Regression model."""
    global _cached_lr
    if force_reload or _cached_lr is None:
        try:
            with open('models/lr_model.pkl', 'rb') as f:
                _cached_lr = pickle.load(f)
            print("[predict] LR model loaded successfully.")
        except Exception as e:
            print(f"[predict] Could not load LR model: {e}")
            _cached_lr = None
    return _cached_lr


def _fallback_prediction(db, days=1):
    """Generate a simple moving-average fallback prediction."""
    cursor = db.energydatas.find().sort('date', -1).limit(14)
    data = list(cursor)
    if not data:
        return []

    avg = sum(d['units'] for d in data) / len(data)
    last_date = data[0]['date']

    predictions = []
    day_names = ['Monday', 'Tuesday', 'Wednesday', 'Thursday',
                 'Friday', 'Saturday', 'Sunday']

    for i in range(days):
        target_date = last_date + timedelta(days=i + 1)
        # Add slight variation based on day position
        import random
        variation = random.uniform(0.95, 1.05)
        pred_units = round(max(0.1, avg * variation), 2)

        pred_doc = {
            "targetDate": target_date,
            "predicted_units": pred_units,
            "dayName": day_names[target_date.weekday()],
            "modelUsed": "MovingAverage",
            "predictionType": "weekly" if days > 1 else "single"
        }
        db.predictions.insert_one(pred_doc)

        predictions.append({
            "targetDate": target_date.strftime("%Y-%m-%d"),
            "predicted_units": pred_units,
            "dayName": day_names[target_date.weekday()],
            "modelUsed": "MovingAverage"
        })

    return predictions


def generate_predictions(db):
    """Generate a single next-day prediction.

    Tries LSTM first, falls back to moving average if unavailable.
    """
    model, scaler = load_lstm()

    cursor = db.energydatas.find().sort('date', 1)
    data = list(cursor)
    if len(data) < 7:
        if len(data) > 0:
            return _fallback_prediction(db, days=1)
        return []

    df = pd.DataFrame(data)

    # LSTM prediction
    if model is not None and scaler is not None:
        try:
            last_7_days = df['units'].values[-7:].astype(float)
            scaled_last_7 = scaler.transform(last_7_days.reshape(-1, 1))

            X_pred = np.array([scaled_last_7])
            pred_scaled = model.predict(X_pred, verbose=0)
            pred_units = float(scaler.inverse_transform(pred_scaled)[0][0])
            pred_units = max(0.1, round(pred_units, 2))

            last_date = df['date'].iloc[-1]
            next_date = last_date + timedelta(days=1)

            pred_doc = {
                "targetDate": next_date,
                "predicted_units": pred_units,
                "modelUsed": "LSTM"
            }
            db.predictions.insert_one(pred_doc)

            return [{
                "targetDate": next_date.strftime("%Y-%m-%d"),
                "predicted_units": pred_units,
                "modelUsed": "LSTM"
            }]
        except Exception as e:
            print(f"[predict] LSTM prediction failed, using fallback: {e}")

    # Fallback
    return _fallback_prediction(db, days=1)


def generate_weekly_predictions(db):
    """Generate 7-day iterative predictions using the trained LSTM model.

    Uses a rolling-window approach. Falls back to moving average
    if LSTM is unavailable.
    """
    model, scaler = load_lstm()

    cursor = db.energydatas.find().sort('date', 1)
    data = list(cursor)
    if len(data) < 7:
        if len(data) > 0:
            return _fallback_prediction(db, days=7)
        return []

    df = pd.DataFrame(data)

    # LSTM rolling prediction
    if model is not None and scaler is not None:
        try:
            last_7_days = df['units'].values[-7:].astype(float).copy()
            last_date = df['date'].iloc[-1]

            day_names = ['Monday', 'Tuesday', 'Wednesday', 'Thursday',
                         'Friday', 'Saturday', 'Sunday']

            predictions = []
            window = last_7_days.copy()

            for i in range(7):
                scaled_window = scaler.transform(window.reshape(-1, 1))
                X_pred = np.array([scaled_window])

                pred_scaled = model.predict(X_pred, verbose=0)
                pred_units = float(
                    scaler.inverse_transform(pred_scaled)[0][0]
                )
                pred_units = max(0.1, round(pred_units, 2))

                target_date = last_date + timedelta(days=i + 1)
                day_name = day_names[target_date.weekday()]

                pred_doc = {
                    "targetDate": target_date,
                    "predicted_units": pred_units,
                    "dayName": day_name,
                    "modelUsed": "LSTM",
                    "predictionType": "weekly"
                }
                db.predictions.insert_one(pred_doc)

                predictions.append({
                    "targetDate": target_date.strftime("%Y-%m-%d"),
                    "predicted_units": pred_units,
                    "dayName": day_name,
                    "modelUsed": "LSTM"
                })

                # Slide the window
                window = np.append(window[1:], pred_units)

            return predictions
        except Exception as e:
            print(f"[predict] Weekly LSTM failed, using fallback: {e}")

    # Fallback
    return _fallback_prediction(db, days=7)
