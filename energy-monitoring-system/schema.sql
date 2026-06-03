-- Smart Energy AI Database Schema for Supabase (PostgreSQL)
-- Copy and run these SQL statements in your Supabase SQL Editor to set up the tables.

-- Enable UUID extension if not already enabled
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. Users Table
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    budget_limit NUMERIC DEFAULT 0,
    notifications_enabled BOOLEAN DEFAULT FALSE,
    notification_email TEXT DEFAULT '',
    reset_code TEXT DEFAULT NULL,
    reset_code_expiry TIMESTAMP WITH TIME ZONE DEFAULT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 2. Energy Data Table
CREATE TABLE IF NOT EXISTS energy_data (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    date TIMESTAMP WITH TIME ZONE NOT NULL,
    units NUMERIC NOT NULL,
    predicted_units NUMERIC DEFAULT NULL,
    anomaly BOOLEAN DEFAULT FALSE,
    anomaly_severity TEXT DEFAULT NULL,
    source TEXT DEFAULT 'csv',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 3. Predictions Table
CREATE TABLE IF NOT EXISTS predictions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    target_date TIMESTAMP WITH TIME ZONE NOT NULL,
    predicted_units NUMERIC NOT NULL,
    model_used TEXT DEFAULT 'LSTM',
    day_name TEXT DEFAULT NULL,
    prediction_type TEXT DEFAULT 'single',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 4. Anomalies Table
CREATE TABLE IF NOT EXISTS anomalies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    date TIMESTAMP WITH TIME ZONE NOT NULL,
    units NUMERIC NOT NULL,
    expected_units NUMERIC DEFAULT NULL,
    deviation_pct NUMERIC DEFAULT 0,
    severity TEXT DEFAULT 'mild',
    rolling_mean NUMERIC DEFAULT 0,
    rolling_std NUMERIC DEFAULT 0,
    raw_score NUMERIC DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 5. Recommendations Table
CREATE TABLE IF NOT EXISTS recommendations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    date TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    message TEXT NOT NULL,
    type TEXT DEFAULT 'Household',
    priority TEXT DEFAULT 'medium',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 6. Bill Records Table
CREATE TABLE IF NOT EXISTS bill_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT DEFAULT 'default',
    consumer_number TEXT DEFAULT NULL,
    billing_month TEXT DEFAULT NULL,
    total_units NUMERIC DEFAULT NULL,
    bill_amount NUMERIC DEFAULT NULL,
    previous_reading NUMERIC DEFAULT NULL,
    current_reading NUMERIC DEFAULT NULL,
    electricity_board TEXT DEFAULT 'Unknown',
    original_file_name TEXT NOT NULL,
    file_type TEXT NOT NULL,
    extraction_confidence TEXT DEFAULT 'medium',
    raw_text_length INTEGER DEFAULT 0,
    status TEXT DEFAULT 'success',
    error_message TEXT DEFAULT NULL,
    generated_records INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 7. Notification Logs Table
CREATE TABLE IF NOT EXISTS notification_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    email_sent_to TEXT DEFAULT NULL,
    read BOOLEAN DEFAULT FALSE,
    in_app BOOLEAN DEFAULT TRUE,
    sent_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 8. Activity Logs Table
CREATE TABLE IF NOT EXISTS activity_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    action TEXT NOT NULL,
    details TEXT DEFAULT '',
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_energy_data_date ON energy_data(date DESC);
CREATE INDEX IF NOT EXISTS idx_predictions_target_date ON predictions(target_date ASC);
CREATE INDEX IF NOT EXISTS idx_anomalies_date ON anomalies(date DESC);
CREATE INDEX IF NOT EXISTS idx_notification_logs_user ON notification_logs(user_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_logs_user ON activity_logs(user_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_bill_records_user ON bill_records(user_id);
