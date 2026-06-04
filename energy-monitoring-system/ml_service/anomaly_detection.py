"""
anomaly_detection.py — Enhanced anomaly detection module (Supabase Version).

Uses Isolation Forest with rolling window statistics to detect unusual
consumption patterns. Adds severity classification (critical/warning/mild)
and deviation metrics for better dashboard visualization.
"""

import pandas as pd
from sklearn.ensemble import IsolationForest
import numpy as np

def check_user_id_support(db, table_name):
    try:
        db.table(table_name).select('user_id').limit(1).execute()
        return True
    except Exception as e:
        if "does not exist" in str(e) or "42703" in str(e):
            return False
        return True



def detect_abnormalities(db, user_id=None):
    """Detect anomalies in energy consumption data using Isolation Forest.

    Enhances basic detection with:
    - Rolling 7-day mean/std for contextual expected values
    - Severity classification based on deviation from rolling average
    - Deviation percentage for UI visualization

    Args:
        db: Supabase Client instance.
        user_id: ID of the authenticated user.

    Returns:
        list: Anomaly dicts with date, units, expected_units, severity,
              deviation_pct, and rolling stats.
    """
    has_user_id_energy = check_user_id_support(db, 'energy_data')
    query = db.table('energy_data').select('*')
    if user_id and has_user_id_energy:
        query = query.eq('user_id', user_id)
    res = query.order('date', desc=False).execute()
    
    data = res.data or []
    if not data or len(data) < 7:
        return []

    df = pd.DataFrame(data)
    df['units'] = df['units'].astype(float)
    df['date'] = pd.to_datetime(df['date'])

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
    anomalies = df[
        (df['anomaly_score'] == -1) & 
        ((abs(df['units'] - df['rolling_mean_7']) > 2.5 * df['rolling_std_7']) | 
         (abs(df['units'] / df['rolling_mean_7'] - 1) > 0.5))
    ].copy()

    # Clear previous anomaly records and flags for this user specifically
    has_user_id_anom = check_user_id_support(db, 'anomalies')
    has_user_id_energy = check_user_id_support(db, 'energy_data')
    if user_id and has_user_id_anom:
        db.table('anomalies').delete().eq('user_id', user_id).execute()
    else:
        db.table('anomalies').delete().neq('id', '00000000-0000-0000-0000-000000000000').execute()

    if user_id and has_user_id_energy:
        db.table('energy_data').update({'anomaly': False, 'anomaly_severity': None}).eq('user_id', user_id).execute()
    else:
        db.table('energy_data').update({'anomaly': False, 'anomaly_severity': None}).neq('id', '00000000-0000-0000-0000-000000000000').execute()

    anomaly_records = []
    
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

        has_user_id_anom = check_user_id_support(db, 'anomalies')
        rec = {
            "date": row['date'].isoformat(),
            "units": float(row['units']),
            "expected_units": float(expected),
            "deviation_pct": float(round(deviation_pct, 1)),
            "severity": severity,
            "rolling_mean": float(round(row['rolling_mean_7'], 2)),
            "rolling_std": float(round(row['rolling_std_7'], 2)),
            "raw_score": float(round(row['anomaly_raw_score'], 4))
        }
        if user_id and has_user_id_anom:
            rec["user_id"] = user_id
        anomaly_records.append(rec)

        # Flag in original data (which is already scoped by user_id)
        db.table('energy_data').update({
            'anomaly': True,
            'anomaly_severity': severity
        }).eq('id', row['id']).execute()

    if anomaly_records:
        db.table('anomalies').insert(anomaly_records).execute()

    # Return formatted list (dates as strings)
    result = []
    for r in anomaly_records:
        date_str = r['date']
        if 'T' in date_str:
            date_str = date_str.split('T')[0]
            
        result.append({
            "date": date_str,
            "units": r["units"],
            "expected_units": r["expected_units"],
            "deviation_pct": r["deviation_pct"],
            "severity": r["severity"],
            "rolling_mean": r["rolling_mean"],
            "rolling_std": r["rolling_std"]
        })

    return result
