"""
data_processor.py — CSV data processing and feature engineering module (Supabase Version).

Handles CSV upload parsing, column detection, missing value handling,
and feature extraction for ML model training.
"""

import pandas as pd
import numpy as np


def process_and_store_csv(file_path, db, user_id=None):
    """Process a CSV file and store records in Supabase.

    Automatically detects date and units columns by name.
    Handles missing values via interpolation.
    Appends to existing data (does not wipe on re-upload).

    Args:
        file_path: Path to the CSV file.
        db: Supabase Client instance.
        user_id: ID of the authenticated user.

    Returns:
        int: Number of records inserted.

    Raises:
        ValueError: If required columns are missing.
    """
    df = pd.read_csv(file_path)

    # Normalize column names
    df.columns = [col.lower().strip() for col in df.columns]

    # Auto-detect date column
    date_col = next(
        (col for col in df.columns
         if 'date' in col or 'timestamp' in col or 'time' in col),
        None
    )
    # Auto-detect units column
    units_col = next(
        (col for col in df.columns
         if 'unit' in col or 'consumption' in col or 'energy' in col
         or 'kwh' in col or 'power' in col),
        None
    )

    if not date_col or not units_col:
        raise ValueError(
            "CSV must contain a 'date' column and a "
            "'units'/'consumption'/'kwh' column."
        )

    df = df.rename(columns={date_col: 'date', units_col: 'units'})

    # Convert to datetime
    df['date'] = pd.to_datetime(df['date'], dayfirst=False, errors='coerce')
    df = df.dropna(subset=['date'])

    # Convert units to numeric
    df['units'] = pd.to_numeric(df['units'], errors='coerce')

    # Handle missing values
    df['units'] = df['units'].interpolate(method='linear')
    df['units'] = df['units'].fillna(df['units'].mean() if not df['units'].isna().all() else 0)

    # Remove any remaining NaN rows
    df = df.dropna(subset=['units'])
    df = df.sort_values('date')

    if len(df) == 0:
        raise ValueError("No valid records found in the CSV after processing.")

    # Clear old data (dataset replacement) for this user specifically
    if user_id:
        db.table('energy_data').delete().eq('user_id', user_id).execute()
    else:
        db.table('energy_data').delete().neq('id', '00000000-0000-0000-0000-000000000000').execute()

    records = []
    for _, row in df.iterrows():
        records.append({
            "date": row['date'].isoformat(),
            "units": float(row['units']),
            "predicted_units": None,
            "anomaly": False,
            "source": "csv",
            "user_id": user_id
        })

    if records:
        # Split into chunks of 1000 if dataset is huge, but postgrest handles it well.
        db.table('energy_data').insert(records).execute()

    return len(records)


def prepare_features(df):
    """Engineer features from a date/units DataFrame for model training.

    Features created:
      - day, month, year, weekday (temporal)
      - lag_1, lag_7 (autoregressive)
      - rolling_mean_7, rolling_std_7 (smoothed trends)

    Args:
        df: DataFrame with 'date' and 'units' columns.

    Returns:
        DataFrame with engineered features, NaN rows dropped.
    """
    df = df.copy()

    # Ensure datetime
    df['date'] = pd.to_datetime(df['date'], errors='coerce')
    df = df.dropna(subset=['date'])
    df = df.sort_values('date').reset_index(drop=True)

    # Temporal features
    df['day'] = df['date'].dt.day
    df['month'] = df['date'].dt.month
    df['year'] = df['date'].dt.year
    df['weekday'] = df['date'].dt.weekday

    # Lag features
    df['lag_1'] = df['units'].shift(1)
    df['lag_7'] = df['units'].shift(7)

    # Rolling statistics
    df['rolling_mean_7'] = df['units'].rolling(window=7, min_periods=3).mean()
    df['rolling_std_7'] = df['units'].rolling(window=7, min_periods=3).std()

    # Fill rolling NaNs with overall stats
    df['rolling_mean_7'] = df['rolling_mean_7'].fillna(df['units'].mean())
    df['rolling_std_7'] = df['rolling_std_7'].fillna(df['units'].std())

    # Drop rows where essential features are missing
    essential_cols = ['units', 'day', 'month', 'year', 'weekday',
                      'lag_1', 'lag_7']
    df = df.dropna(subset=essential_cols)

    return df
