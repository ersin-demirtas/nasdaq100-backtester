"""
Custom Nasdaq-100 5m Scalping Strategy Plugin
---------------------------------------------
Edit this file directly in your IDE or inside the Web UI's Python Strategy Studio!
"""
import numpy as np
from app.engine.indicators import atr, ema, rsi, session_vwap

STRATEGY_META = {
    "name": "EMA 8/21 + Session VWAP Momentum Scalp",
    "category": "Custom Python",
    "description": "Fast/Slow EMA crossover filtered by 09:30 ET Session VWAP and RSI momentum.",
    "recommended_session": "NY_OPEN_KILLZONE",
    "params": [
        {"name": "fast_len", "label": "Fast EMA", "type": "int", "default": 8, "min": 3, "max": 30, "step": 1},
        {"name": "slow_len", "label": "Slow EMA", "type": "int", "default": 21, "min": 10, "max": 100, "step": 1},
        {"name": "rsi_filter", "label": "RSI Threshold", "type": "float", "default": 54.0, "min": 50.0, "max": 70.0, "step": 1.0},
    ],
}


def generate_signals(df, params, include_overlays=True):
    fast_len = int(params.get("fast_len", 8))
    slow_len = int(params.get("slow_len", 21))
    rsi_thresh = float(params.get("rsi_filter", 54.0))

    high = df["high"].to_numpy()
    low = df["low"].to_numpy()
    close = df["close"].to_numpy()
    vol = df["volume"].to_numpy()
    day_id = df["et_day_id"].to_numpy()
    et_min = df["et_minute"].to_numpy()

    f_ema = ema(close, fast_len)
    s_ema = ema(close, slow_len)
    vwap, _ = session_vwap(high, low, close, vol, day_id, et_min, 570)
    rsi_vals = rsi(close, 14)
    atr_vals = atr(high, low, close, 14)

    n = len(close)
    signal = np.zeros(n, dtype=np.int64)
    stop_price = np.full(n, np.nan, dtype=np.float64)

    cross_up = (
        (f_ema[1:] > s_ema[1:])
        & (f_ema[:-1] <= s_ema[:-1])
        & (close[1:] > vwap[1:])
        & (rsi_vals[1:] >= rsi_thresh)
    )
    cross_dn = (
        (f_ema[1:] < s_ema[1:])
        & (f_ema[:-1] >= s_ema[:-1])
        & (close[1:] < vwap[1:])
        & (rsi_vals[1:] <= (100.0 - rsi_thresh))
    )

    signal[1:][cross_up] = 1
    signal[1:][cross_dn] = -1

    stop_price[1:][cross_up] = low[1:][cross_up] - 0.5 * atr_vals[1:][cross_up]
    stop_price[1:][cross_dn] = high[1:][cross_dn] + 0.5 * atr_vals[1:][cross_dn]

    overlays = {}
    if include_overlays:
        overlays = {
            f"EMA {fast_len}": {"values": f_ema, "color": "#38bdf8", "style": "solid"},
            f"EMA {slow_len}": {"values": s_ema, "color": "#a855f7", "style": "solid"},
            "Session VWAP": {"values": vwap, "color": "#f59e0b", "style": "dashed"},
        }
    return {
        "signal": signal,
        "stop_price": stop_price,
        "target_price": None,
        "overlays": overlays,
    }
