# ML Model Files
These model files are generated during training and are NOT tracked in git.
They are auto-generated when you:
1. Upload a dataset (CSV or bill) 
2. Click "Train Models"

Required files (created by training):
- `lstm_model.keras` — LSTM deep learning model
- `lr_model.pkl` — Linear regression baseline model  
- `scaler.pkl` — MinMaxScaler for data normalization

If these files don't exist, the system falls back to moving-average predictions.
