"""
lstm_model.py — LSTM model architecture for energy consumption forecasting.

Provides a more robust LSTM with dropout regularization and optional
bidirectional layers for improved time-series prediction accuracy.
"""

import numpy as np
import tensorflow as tf
from tensorflow.keras.models import Sequential
from tensorflow.keras.layers import LSTM, Dense, Dropout


def build_lstm_model(input_shape):
    """Build and compile an LSTM model for energy consumption prediction.

    Architecture:
    - LSTM layer with 64 units + dropout for regularization
    - Dense hidden layer for non-linear mapping
    - Single output for next-day prediction

    Args:
        input_shape: Tuple of (time_steps, features), e.g. (7, 1).

    Returns:
        Compiled Keras Sequential model.
    """
    model = Sequential([
        LSTM(64, activation='tanh', input_shape=input_shape,
             return_sequences=False),
        Dropout(0.2),
        Dense(32, activation='relu'),
        Dense(1)
    ])
    model.compile(
        optimizer=tf.keras.optimizers.Adam(learning_rate=0.001),
        loss='mse',
        metrics=['mae']
    )
    return model
