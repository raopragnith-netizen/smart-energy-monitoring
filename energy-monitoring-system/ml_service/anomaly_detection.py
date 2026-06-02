"""
anomaly_detection.py — Enhanced anomaly detection module.

Uses Isolation Forest with rolling window statistics to detect unusual
consumption patterns. Adds severity classification (critical/warning/mild)
and deviation metrics for better dashboard visualization.
"""

import pandas as pd
from sklearn.ensemble import IsolationForest
import numpy as np


def detect_abnormalities(db):
    """Detect anomalies in energy consumption data using Isolation Forest.

    Enhances basic detection with:
    - Rolling 7-day mean/std for contextual expected values
    - Severity classification based on deviation from rolling average
    - Deviation percentage for UI visualization

    Args:
        db: PyMongo database instance.

    Returns:
        list: Anomaly dicts with date, units, expected_units, severity,
              deviation_pct, and rolling stats.
    """
    cursor = db.energydatas.find().sort('date', 1)
    data = list(cursor)
    if not data or len(data) < 7:
        return []

    df = pd.DataFrame(data)

    # Compute rolling statistics for contextual baselines
    df['rolling_mean_7'] = df['units'].rolling(window=7, min_periods=3).mean()
    df['rolling_std_7'] = df['units'].rolling(window=7, min_periods=3).std()
    df['rolling_mean_7'] = df['rolling_mean_7'].fillna(df['units'].mean())
    df['rolling_std_7'] = df['rolling_std_7'].fillna(df['units'].std())

    # Build multi-feature matrix for Isolation Forest
    feature_cols = ['units']
    # Add ratio to rolling mean as a feature (helps detect contextual anomalies)
    df['ratio_to_mean'] = df['units'] / df['rolling_mean_7'].replace(0, 1)
    feature_cols.append('ratio_to_mean')

    # Use Isolation Forest with 'auto' contamination for dynamic behavior
    # This prevents the "always 5%" issue.
    iso_forest = IsolationForest(
        contamination='auto',
        n_estimators=150,
        max_features=1.0,
        random_state=42
    )
    features = df[feature_cols].fillna(0)
    df['anomaly_score'] = iso_forest.fit_predict(features)
    df['anomaly_raw_score'] = iso_forest.decision_function(features)

    # Filter anomalies (score == -1) 
    # AND add a statistical filter: must be > 2.5 std devs or > 50% from rolling mean
    # to avoid flagging tiny variations as anomalies.
    anomalies = df[
        (df['anomaly_score'] == -1) & 
        ((abs(df['units'] - df['rolling_mean_7']) > 2.5 * df['rolling_std_7']) | 
         (abs(df['units'] / df['rolling_mean_7'] - 1) > 0.5))
    ].copy()

    # Clear previous anomaly records and flags
    db.anomalies.delete_many({})
    db.energydatas.update_many({}, {'$set': {'anomaly': False}})

    anomaly_records = []
    overall_mean = df['units'].mean()
    overall_std = df['units'].std()

    for _, row in anomalies.iterrows():
        expected = row['rolling_mean_7']
        deviation = row['units'] - expected
        deviation_pct = (deviation / expected * 100) if expected > 0 else 0

        # Classify severity
        if abs(deviation) > 2 * row['rolling_std_7']:
            severity = 'critical'
        elif abs(deviation) > 1.5 * row['rolling_std_7']:
            severity = 'warning'
        else:
            severity = 'mild'

        rec = {
            "date": row['date'],
            "units": float(row['units']),
            "expected_units": float(expected),
            "deviation_pct": float(round(deviation_pct, 1)),
            "severity": severity,
            "rolling_mean": float(round(row['rolling_mean_7'], 2)),
            "rolling_std": float(round(row['rolling_std_7'], 2)),
            "raw_score": float(round(row['anomaly_raw_score'], 4))
        }
        anomaly_records.append(rec)

        # Flag in original data
        db.energydatas.update_one(
            {'_id': row['_id']},
            {'$set': {'anomaly': True, 'anomaly_severity': severity}}
        )

    if anomaly_records:
        db.anomalies.insert_many(anomaly_records)

    # Return formatted list (dates as strings)
    result = []
    for r in anomaly_records:
        r.pop('_id', None)
        result.append({
            "date": r["date"].strftime("%Y-%m-%d"),
            "units": r["units"],
            "expected_units": r["expected_units"],
            "deviation_pct": r["deviation_pct"],
            "severity": r["severity"],
            "rolling_mean": r["rolling_mean"],
            "rolling_std": r["rolling_std"]
        })

    return result
