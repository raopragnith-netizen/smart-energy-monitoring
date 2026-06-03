"""
train_model.py — Model training pipeline for energy consumption prediction (Supabase Version).

Trains both a Linear Regression baseline and an LSTM deep learning model
on historical energy consumption data. Saves trained models and scalers
for downstream prediction use.
"""

import pandas as pd
import numpy as np
from sklearn.linear_model import LinearRegression
from sklearn.metrics import mean_squared_error, mean_absolute_error
from sklearn.preprocessing import MinMaxScaler
import pickle
import os

from data_processor import prepare_features
from lstm_model import build_lstm_model


def train_all_models(db):
    """Train all ML models on historical energy data.

    Pipeline:
    1. Fetch and validate data from Supabase
    2. Train Linear Regression with engineered features (lag, weekday, etc.)
    3. Train LSTM with 7-day lookback window on scaled data
    4. Save models, scalers, and return training metrics

    Args:
        db: Supabase Client instance.

    Returns:
        dict: Training metrics (MSE, MAE, R² for each model).

    Raises:
        ValueError: If insufficient data for training.
    """
    metrics = {}

    # Fetch data
    res = db.table('energy_data').select('*').order('date', desc=False).execute()
    data = res.data or []
    if not data:
        raise ValueError("No data found to train models.")

    df = pd.DataFrame(data)
    df['units'] = df['units'].astype(float)
    df = prepare_features(df)

    if len(df) < 10:
        raise ValueError(
            f"Not enough data to train models after feature engineering. "
            f"Current rows: {len(df)}. (Need at least 10 valid historical records)."
        )

    # Ensure required columns for training
    required_cols = ['day', 'month', 'year', 'weekday', 'lag_1', 'lag_7', 'units']
    for col in required_cols:
        if col not in df.columns:
            raise KeyError(f"Missing required training column: {col}")

    # ==== 1. Linear Regression Model ====
    feature_cols = ['day', 'month', 'year', 'weekday', 'lag_1', 'lag_7']
    X_lr = df[feature_cols]
    y_lr = df['units']

    # Use last 20% as validation set for realistic metrics
    split_idx = int(len(X_lr) * 0.8)
    if split_idx > 10 and len(X_lr) - split_idx > 3:
        X_train, X_val = X_lr.iloc[:split_idx], X_lr.iloc[split_idx:]
        y_train, y_val = y_lr.iloc[:split_idx], y_lr.iloc[split_idx:]
        lr_model = LinearRegression()
        lr_model.fit(X_train, y_train)
        lr_preds = lr_model.predict(X_val)
        lr_mse = mean_squared_error(y_val, lr_preds)
        lr_mae = mean_absolute_error(y_val, lr_preds)
        lr_r2 = lr_model.score(X_val, y_val)
        # Refit on full data for deployment
        lr_model.fit(X_lr, y_lr)
    else:
        lr_model = LinearRegression()
        lr_model.fit(X_lr, y_lr)
        lr_preds = lr_model.predict(X_lr)
        lr_mse = mean_squared_error(y_lr, lr_preds)
        lr_mae = mean_absolute_error(y_lr, lr_preds)
        lr_r2 = lr_model.score(X_lr, y_lr)

    metrics['LinearRegression_MSE'] = float(round(lr_mse, 4))
    metrics['LinearRegression_MAE'] = float(round(lr_mae, 4))
    metrics['LinearRegression_R2'] = float(round(lr_r2, 4))

    os.makedirs('models', exist_ok=True)
    with open('models/lr_model.pkl', 'wb') as f:
        pickle.dump(lr_model, f)

    # ==== 2. LSTM Model ====
    scaler = MinMaxScaler()
    scaled_units = scaler.fit_transform(df[['units']])

    with open('models/scaler.pkl', 'wb') as f:
        pickle.dump(scaler, f)

    X_lstm, y_lstm = [], []
    lookback = 7
    for i in range(len(scaled_units) - lookback):
        X_lstm.append(scaled_units[i:i + lookback])
        y_lstm.append(scaled_units[i + lookback])

    X_lstm, y_lstm = np.array(X_lstm), np.array(y_lstm)

    if len(X_lstm) > 0:
        lstm = build_lstm_model((lookback, 1))

        # Train with early stopping for better generalization
        from tensorflow.keras.callbacks import EarlyStopping

        early_stop = EarlyStopping(
            monitor='loss',
            patience=5,
            restore_best_weights=True,
            min_delta=0.0001
        )

        # Use more epochs with early stopping (will stop when converged)
        epochs = min(50, max(15, len(X_lstm) // 2))
        batch_size = min(16, max(4, len(X_lstm) // 10))

        history = lstm.fit(
            X_lstm, y_lstm,
            epochs=epochs,
            batch_size=batch_size,
            verbose=0,
            callbacks=[early_stop]
        )

        lstm.save('models/lstm_model.keras')

        lstm_preds = lstm.predict(X_lstm, verbose=0)
        lstm_mse = mean_squared_error(y_lstm, lstm_preds)
        lstm_mae = mean_absolute_error(y_lstm, lstm_preds)

        metrics['LSTM_MSE'] = float(round(lstm_mse, 6))
        metrics['LSTM_MAE'] = float(round(lstm_mae, 6))
        metrics['LSTM_Epochs_Trained'] = len(history.history['loss'])
        metrics['LSTM_Final_Loss'] = float(round(history.history['loss'][-1], 6))
    else:
        metrics['LSTM_Status'] = "Insufficient temporal data for LSTM"

    metrics['total_records'] = len(df)
    metrics['training_date'] = pd.Timestamp.now().isoformat()

    # Reload models into cache after training
    try:
        from predict import load_lstm, load_lr
        load_lstm(force_reload=True)
        load_lr(force_reload=True)
        print("[train_model] ML models reloaded successfully in cache after training.")
    except Exception as re_err:
        print(f"[train_model] Failed to reload ML models: {re_err}")

    return metrics
