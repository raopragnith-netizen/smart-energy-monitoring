"""
predict.py — Energy consumption prediction module (Supabase Version).

Provides single-day and 7-day iterative forecasting using a trained LSTM model.
Falls back to Linear Regression when LSTM is unavailable.
Predictions are saved to Supabase for downstream use (dashboard, notifications).
"""

import pandas as pd
import numpy as np
import pickle
import os
from datetime import timedelta
from anomaly_detection import check_user_id_support


_cached_lstm = {}
_cached_scaler = {}
_cached_lr = {}

def load_lstm(user_id=None, force_reload=False):
    """Safely load and cache the LSTM model and scaler for a specific user."""
    global _cached_lstm, _cached_scaler
    user_key = user_id or "default"
    if force_reload or user_key not in _cached_lstm:
        try:
            from tensorflow.keras.models import load_model
            user_suffix = f"_{user_id}" if user_id else ""
            model_path = f'models/lstm_model{user_suffix}.keras'
            scaler_path = f'models/scaler{user_suffix}.pkl'
            
            if not os.path.exists(model_path) or not os.path.exists(scaler_path):
                _cached_lstm[user_key] = None
                _cached_scaler[user_key] = None
                print(f"[predict] No custom LSTM model found for user {user_key}.")
            else:
                _cached_lstm[user_key] = load_model(model_path)
                with open(scaler_path, 'rb') as f:
                    _cached_scaler[user_key] = pickle.load(f)
                print(f"[predict] LSTM model and scaler loaded successfully for user {user_key}.")
        except Exception as e:
            print(f"[predict] Could not load LSTM for user {user_key}: {e}")
            _cached_lstm[user_key], _cached_scaler[user_key] = None, None
    return _cached_lstm.get(user_key), _cached_scaler.get(user_key)


def load_lr(user_id=None, force_reload=False):
    """Safely load and cache the Linear Regression model for a specific user."""
    global _cached_lr
    user_key = user_id or "default"
    if force_reload or user_key not in _cached_lr:
        try:
            user_suffix = f"_{user_id}" if user_id else ""
            model_path = f'models/lr_model{user_suffix}.pkl'
            if not os.path.exists(model_path):
                _cached_lr[user_key] = None
                print(f"[predict] No custom LR model found for user {user_key}.")
            else:
                with open(model_path, 'rb') as f:
                    _cached_lr[user_key] = pickle.load(f)
                print(f"[predict] LR model loaded successfully for user {user_key}.")
        except Exception as e:
            print(f"[predict] Could not load LR model for user {user_key}: {e}")
            _cached_lr[user_key] = None
    return _cached_lr.get(user_key)


def _fallback_prediction(db, user_id=None, days=1):
    """Generate a simple moving-average fallback prediction."""
    has_user_id_energy = check_user_id_support(db, 'energy_data')
    query = db.table('energy_data').select('*')
    if user_id and has_user_id_energy:
        query = query.eq('user_id', user_id)
    res = query.order('date', desc=True).limit(14).execute()
    data = res.data or []
    if not data:
        return []

    avg = sum(float(d['units']) for d in data) / len(data)
    last_date = pd.to_datetime(data[0]['date'])

    predictions = []
    day_names = ['Monday', 'Tuesday', 'Wednesday', 'Thursday',
                 'Friday', 'Saturday', 'Sunday']

    for i in range(days):
        target_date = last_date + timedelta(days=i + 1)
        # Add slight variation based on day position
        import random
        variation = random.uniform(0.95, 1.05)
        pred_units = round(max(0.1, avg * variation), 2)

        has_user_id_pred = check_user_id_support(db, 'predictions')
        pred_doc = {
            "target_date": target_date.isoformat(),
            "predicted_units": float(pred_units),
            "day_name": day_names[target_date.weekday()],
            "model_used": "MovingAverage",
            "prediction_type": "weekly" if days > 1 else "single"
        }
        if user_id and has_user_id_pred:
            pred_doc["user_id"] = user_id
        db.table('predictions').insert(pred_doc).execute()

        predictions.append({
            "targetDate": target_date.strftime("%Y-%m-%d"),
            "predicted_units": pred_units,
            "dayName": day_names[target_date.weekday()],
            "modelUsed": "MovingAverage"
        })

    return predictions


def generate_predictions(db, user_id=None):
    """Generate a single next-day prediction.

    Tries LSTM first, falls back to moving average if unavailable.
    """
    model, scaler = load_lstm(user_id=user_id)

    has_user_id_energy = check_user_id_support(db, 'energy_data')
    query = db.table('energy_data').select('*')
    if user_id and has_user_id_energy:
        query = query.eq('user_id', user_id)
    res = query.order('date', desc=False).execute()
    
    data = res.data or []
    if len(data) < 7:
        if len(data) > 0:
            return _fallback_prediction(db, user_id=user_id, days=1)
        return []

    df = pd.DataFrame(data)
    df['units'] = df['units'].astype(float)
    df['date'] = pd.to_datetime(df['date'])

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

            has_user_id_pred = check_user_id_support(db, 'predictions')
            pred_doc = {
                "target_date": next_date.isoformat(),
                "predicted_units": float(pred_units),
                "model_used": "LSTM",
                "prediction_type": "single"
            }
            if user_id and has_user_id_pred:
                pred_doc["user_id"] = user_id
            db.table('predictions').insert(pred_doc).execute()

            return [{
                "targetDate": next_date.strftime("%Y-%m-%d"),
                "predicted_units": pred_units,
                "modelUsed": "LSTM"
            }]
        except Exception as e:
            print(f"[predict] LSTM prediction failed for user {user_id}, using fallback: {e}")

    # Fallback
    return _fallback_prediction(db, user_id=user_id, days=1)


def generate_weekly_predictions(db, user_id=None):
    """Generate 7-day iterative predictions using the trained LSTM model.

    Uses a rolling-window approach. Falls back to moving average
    if LSTM is unavailable.
    """
    model, scaler = load_lstm(user_id=user_id)

    has_user_id_energy = check_user_id_support(db, 'energy_data')
    query = db.table('energy_data').select('*')
    if user_id and has_user_id_energy:
        query = query.eq('user_id', user_id)
    res = query.order('date', desc=False).execute()
    
    data = res.data or []
    if len(data) < 7:
        if len(data) > 0:
            return _fallback_prediction(db, user_id=user_id, days=7)
        return []

    df = pd.DataFrame(data)
    df['units'] = df['units'].astype(float)
    df['date'] = pd.to_datetime(df['date'])

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

                has_user_id_pred = check_user_id_support(db, 'predictions')
                pred_doc = {
                    "target_date": target_date.isoformat(),
                    "predicted_units": float(pred_units),
                    "day_name": day_name,
                    "model_used": "LSTM",
                    "prediction_type": "weekly"
                }
                if user_id and has_user_id_pred:
                    pred_doc["user_id"] = user_id
                db.table('predictions').insert(pred_doc).execute()

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
            print(f"[predict] Weekly LSTM failed for user {user_id}, using fallback: {e}")

    # Fallback
    return _fallback_prediction(db, user_id=user_id, days=7)
