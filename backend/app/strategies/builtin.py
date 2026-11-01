from __future__ import annotations

import inspect
from typing import Any

import numpy as np
from numba import njit
import polars as pl

from app.engine.indicators import (
    atr,
    ema,
    keltner_channels,
    opening_range,
    premarket_high_low,
    rsi,
    session_vwap,
)
from app.models import ParamSpec


@njit(cache=True)
def _orb_signal_kernel(
    open_p: np.ndarray,
    high_p: np.ndarray,
    low_p: np.ndarray,
    close_p: np.ndarray,
    et_day_id: np.ndarray,
    orb_h: np.ndarray,
    orb_l: np.ndarray,
    orb_ready: np.ndarray,
    vwap_arr: np.ndarray,
    atr_arr: np.ndarray,
    require_vwap_align: bool,
    min_buffer_pts: float,
    max_orb_atr_mult: float,
    use_midpoint_sl: bool,
    one_breakout_per_side: bool,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    n = len(close_p)
    sig = np.zeros(n, dtype=np.int64)
    sl_out = np.full(n, np.nan, dtype=np.float64)
    tp_out = np.full(n, np.nan, dtype=np.float64)

    cur_day = -1
    long_taken = False
    short_taken = False

    for i in range(1, n):
        d = et_day_id[i]
        if d != cur_day:
            cur_day = d
            long_taken = False
            short_taken = False

        if not orb_ready[i]:
            continue

        oh = orb_h[i]
        ol = orb_l[i]
        width = oh - ol
        a = atr_arr[i]
        if np.isnan(oh) or np.isnan(ol) or width <= 0.5:
            continue
        if (not np.isnan(a)) and a > 0.0 and width > max_orb_atr_mult * a:
            continue

        mid = 0.5 * (oh + ol)
        # Fresh close breakout above ORB High
        if close_p[i] > oh + min_buffer_pts and close_p[i - 1] <= oh + min_buffer_pts:
            if (not one_breakout_per_side) or (not long_taken):
                if (not require_vwap_align) or (close_p[i] >= vwap_arr[i]):
                    sig[i] = 1
                    sl_out[i] = mid if use_midpoint_sl else ol
                    long_taken = True
        # Fresh close breakdown below ORB Low
        elif close_p[i] < ol - min_buffer_pts and close_p[i - 1] >= ol - min_buffer_pts:
            if (not one_breakout_per_side) or (not short_taken):
                if (not require_vwap_align) or (close_p[i] <= vwap_arr[i]):
                    sig[i] = -1
                    sl_out[i] = mid if use_midpoint_sl else oh
                    short_taken = True

    return sig, sl_out, tp_out


def strat_ny_orb_vwap(df: pl.DataFrame, params: dict[str, Any], include_overlays: bool = True) -> dict[str, Any]:
    """NY Opening Range Breakout (ORB) + Session VWAP Alignment Scalp."""
    orb_mins = int(params.get("orb_minutes", 15))
    require_vwap = bool(params.get("require_vwap_align", True))
    min_buf = float(params.get("min_buffer_pts", 1.0))
    max_orb_atr = float(params.get("max_orb_atr_mult", 4.5))
    use_mid_sl = bool(params.get("use_midpoint_sl", True))
    once_per_side = bool(params.get("one_breakout_per_side", True))

    open_p = df["open"].to_numpy()
    high_p = df["high"].to_numpy()
    low_p = df["low"].to_numpy()
    close_p = df["close"].to_numpy()
    vol = df["volume"].to_numpy()
    day_id = df["et_day_id"].to_numpy()
    et_min = df["et_minute"].to_numpy()

    orb_h, orb_l, orb_ready = opening_range(high_p, low_p, day_id, et_min, 570, orb_mins)
    vwap_arr, _ = session_vwap(high_p, low_p, close_p, vol, day_id, et_min, 570)
    atr_arr = atr(high_p, low_p, close_p, 14)

    sig, sl_out, tp_out = _orb_signal_kernel(
        open_p,
        high_p,
        low_p,
        close_p,
        day_id,
        orb_h,
        orb_l,
        orb_ready,
        vwap_arr,
        atr_arr,
        require_vwap,
        min_buf,
        max_orb_atr,
        use_mid_sl,
        once_per_side,
    )

    overlays = {}
    if include_overlays:
        overlays = {
            "Session VWAP": {"values": vwap_arr, "color": "#f59e0b", "style": "solid"},
            "ORB High": {"values": orb_h, "color": "#22c55e", "style": "dashed"},
            "ORB Low": {"values": orb_l, "color": "#ef4444", "style": "dashed"},
        }
    return {"signal": sig, "stop_price": sl_out, "target_price": tp_out, "overlays": overlays}


@njit(cache=True)
def _vwap_pullback_kernel(
    open_p: np.ndarray,
    high_p: np.ndarray,
    low_p: np.ndarray,
    close_p: np.ndarray,
    fast_ema: np.ndarray,
    slow_ema: np.ndarray,
    vwap_arr: np.ndarray,
    rsi_arr: np.ndarray,
    atr_arr: np.ndarray,
    pullback_atr_tol: float,
    rsi_min_bull: float,
    rsi_max_bear: float,
    sl_swing_lookback: int,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    n = len(close_p)
    sig = np.zeros(n, dtype=np.int64)
    sl_out = np.full(n, np.nan, dtype=np.float64)
    tp_out = np.full(n, np.nan, dtype=np.float64)

    lb = max(2, sl_swing_lookback)
    for i in range(lb + 2, n):
        f = fast_ema[i]
        s = slow_ema[i]
        v = vwap_arr[i]
        a = atr_arr[i]
        if np.isnan(f) or np.isnan(s) or np.isnan(a) or a <= 0.0:
            continue

        tol = pullback_atr_tol * a
        # Bullish trend continuation pullback into fast EMA / VWAP support
        if f > s and close_p[i] > v and close_p[i] > open_p[i] and rsi_arr[i] >= rsi_min_bull:
            touched_zone = (low_p[i] <= f + tol) or (low_p[i - 1] <= fast_ema[i - 1] + tol)
            held_support = low_p[i] >= s - tol
            if touched_zone and held_support and close_p[i] > f:
                swing_low = low_p[i]
                for k in range(1, lb):
                    if low_p[i - k] < swing_low:
                        swing_low = low_p[i - k]
                sig[i] = 1
                sl_out[i] = swing_low - 0.25 * a

        # Bearish trend continuation pullback into fast EMA / VWAP resistance
        elif f < s and close_p[i] < v and close_p[i] < open_p[i] and rsi_arr[i] <= rsi_max_bear:
            touched_zone = (high_p[i] >= f - tol) or (high_p[i - 1] >= fast_ema[i - 1] - tol)
            held_resist = high_p[i] <= s + tol
            if touched_zone and held_resist and close_p[i] < f:
                swing_high = high_p[i]
                for k in range(1, lb):
                    if high_p[i - k] > swing_high:
                        swing_high = high_p[i - k]
                sig[i] = -1
                sl_out[i] = swing_high + 0.25 * a

    return sig, sl_out, tp_out


def strat_vwap_ema_pullback(df: pl.DataFrame, params: dict[str, Any], include_overlays: bool = True) -> dict[str, Any]:
    """Session VWAP + Fast/Slow EMA Trend Pullback Scalp."""
    fast_len = int(params.get("fast_ema", 9))
    slow_len = int(params.get("slow_ema", 21))
    pb_tol = float(params.get("pullback_atr_tol", 0.25))
    rsi_len = int(params.get("rsi_period", 14))
    rsi_bull = float(params.get("rsi_min_bull", 52.0))
    rsi_bear = float(params.get("rsi_max_bear", 48.0))
    swing_lb = int(params.get("sl_swing_lookback", 4))

    open_p = df["open"].to_numpy()
    high_p = df["high"].to_numpy()
    low_p = df["low"].to_numpy()
    close_p = df["close"].to_numpy()
    vol = df["volume"].to_numpy()
    day_id = df["et_day_id"].to_numpy()
    et_min = df["et_minute"].to_numpy()

    f_ema = ema(close_p, fast_len)
    s_ema = ema(close_p, slow_len)
    vwap_arr, _ = session_vwap(high_p, low_p, close_p, vol, day_id, et_min, 570)
    rsi_arr = rsi(close_p, rsi_len)
    atr_arr = atr(high_p, low_p, close_p, 14)

    sig, sl_out, tp_out = _vwap_pullback_kernel(
        open_p, high_p, low_p, close_p, f_ema, s_ema, vwap_arr, rsi_arr, atr_arr, pb_tol, rsi_bull, rsi_bear, swing_lb
    )

    overlays = {}
    if include_overlays:
        overlays = {
            "Session VWAP": {"values": vwap_arr, "color": "#f59e0b", "style": "solid"},
            f"EMA {fast_len}": {"values": f_ema, "color": "#38bdf8", "style": "solid"},
            f"EMA {slow_len}": {"values": s_ema, "color": "#a855f7", "style": "solid"},
        }
    return {"signal": sig, "stop_price": sl_out, "target_price": tp_out, "overlays": overlays}


@njit(cache=True)
def _ict_fvg_kernel(
    open_p: np.ndarray,
    high_p: np.ndarray,
    low_p: np.ndarray,
    close_p: np.ndarray,
    trend_ema: np.ndarray,
    atr_arr: np.ndarray,
    min_gap_atr: float,
    displacement_body_atr: float,
    expiry_bars: int,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    3-candle ICT Fair Value Gap (FVG) impulse + retracement entry:
    - Bullish FVG formed at bar `k` when `low[k] - high[k-2] >= min_gap_atr * ATR` and middle bar `k-1` has strong bullish body.
    - Enters Long when a subsequent bar within `expiry_bars` dips into `[high[k-2], low[k]]` and closes above `high[k-2]`.
    """
    n = len(close_p)
    sig = np.zeros(n, dtype=np.int64)
    sl_out = np.full(n, np.nan, dtype=np.float64)
    tp_out = np.full(n, np.nan, dtype=np.float64)

    active_dir = 0
    fvg_top = 0.0
    fvg_bot = 0.0
    fvg_sl = 0.0
    fvg_expire_idx = -1

    for i in range(3, n):
        a = atr_arr[i]
        t_ema = trend_ema[i]
        if np.isnan(a) or a <= 0.0 or np.isnan(t_ema):
            continue

        # Check if an active unfilled FVG gets tapped & respected on bar `i`
        if active_dir == 1:
            if i > fvg_expire_idx or close_p[i] < fvg_bot:
                active_dir = 0
            elif low_p[i] <= fvg_top and close_p[i] >= fvg_bot and close_p[i] > open_p[i]:
                if close_p[i] > t_ema:
                    sig[i] = 1
                    sl_out[i] = fvg_sl
                    active_dir = 0
                    continue
        elif active_dir == -1:
            if i > fvg_expire_idx or close_p[i] > fvg_top:
                active_dir = 0
            elif high_p[i] >= fvg_bot and close_p[i] <= fvg_top and close_p[i] < open_p[i]:
                if close_p[i] < t_ema:
                    sig[i] = -1
                    sl_out[i] = fvg_sl
                    active_dir = 0
                    continue

        # Detect fresh 3-bar FVG completed on bar `i` (candles i-2, i-1, i)
        mid_body = close_p[i - 1] - open_p[i - 1]
        bull_gap = low_p[i] - high_p[i - 2]
        bear_gap = low_p[i - 2] - high_p[i]

        if bull_gap >= min_gap_atr * a and mid_body >= displacement_body_atr * a:
            active_dir = 1
            fvg_top = low_p[i]
            fvg_bot = high_p[i - 2]
            fvg_sl = min(low_p[i - 2], low_p[i - 1]) - 0.2 * a
            fvg_expire_idx = i + expiry_bars
        elif bear_gap >= min_gap_atr * a and (-mid_body) >= displacement_body_atr * a:
            active_dir = -1
            fvg_top = low_p[i - 2]
            fvg_bot = high_p[i]
            fvg_sl = max(high_p[i - 2], high_p[i - 1]) + 0.2 * a
            fvg_expire_idx = i + expiry_bars

    return sig, sl_out, tp_out


def strat_ict_fvg_scalp(df: pl.DataFrame, params: dict[str, Any], include_overlays: bool = True) -> dict[str, Any]:
    """ICT Fair Value Gap (FVG) Displacement & Retracement Scalp (NY Open / Silver Bullet)."""
    ema_len = int(params.get("trend_ema", 50))
    min_gap = float(params.get("min_gap_atr", 0.25))
    disp_body = float(params.get("displacement_body_atr", 0.85))
    expiry = int(params.get("fvg_expiry_bars", 8))

    open_p = df["open"].to_numpy()
    high_p = df["high"].to_numpy()
    low_p = df["low"].to_numpy()
    close_p = df["close"].to_numpy()
    vol = df["volume"].to_numpy()
    day_id = df["et_day_id"].to_numpy()
    et_min = df["et_minute"].to_numpy()

    t_ema = ema(close_p, ema_len)
    atr_arr = atr(high_p, low_p, close_p, 14)
    vwap_arr, _ = session_vwap(high_p, low_p, close_p, vol, day_id, et_min, 570)

    sig, sl_out, tp_out = _ict_fvg_kernel(open_p, high_p, low_p, close_p, t_ema, atr_arr, min_gap, disp_body, expiry)

    overlays = {}
    if include_overlays:
        overlays = {
            f"Trend EMA {ema_len}": {"values": t_ema, "color": "#38bdf8", "style": "solid"},
            "Session VWAP": {"values": vwap_arr, "color": "#f59e0b", "style": "dashed"},
        }
    return {"signal": sig, "stop_price": sl_out, "target_price": tp_out, "overlays": overlays}


@njit(cache=True)
def _sweep_reclaim_kernel(
    open_p: np.ndarray,
    high_p: np.ndarray,
    low_p: np.ndarray,
    close_p: np.ndarray,
    et_day_id: np.ndarray,
    pm_h: np.ndarray,
    pm_l: np.ndarray,
    pm_ready: np.ndarray,
    atr_arr: np.ndarray,
    min_sweep_pts: float,
    max_sweep_atr: float,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    n = len(close_p)
    sig = np.zeros(n, dtype=np.int64)
    sl_out = np.full(n, np.nan, dtype=np.float64)
    tp_out = np.full(n, np.nan, dtype=np.float64)

    cur_day = -1
    high_swept_done = False
    low_swept_done = False

    for i in range(1, n):
        d = et_day_id[i]
        if d != cur_day:
            cur_day = d
            high_swept_done = False
            low_swept_done = False

        if not pm_ready[i]:
            continue
        ph = pm_h[i]
        pl_lvl = pm_l[i]
        a = atr_arr[i]
        if np.isnan(ph) or np.isnan(pl_lvl) or np.isnan(a) or a <= 0.0:
            continue

        mid_target = 0.5 * (ph + pl_lvl)

        # Bearish sweep of Pre-Market High & reclaim back inside range
        if (not high_swept_done) and high_p[i] >= ph + min_sweep_pts:
            overshoot = high_p[i] - ph
            if overshoot <= max_sweep_atr * a and close_p[i] < ph and close_p[i] < open_p[i]:
                sig[i] = -1
                sl_out[i] = high_p[i] + 0.25 * a
                tp_out[i] = mid_target
                high_swept_done = True

        # Bullish sweep of Pre-Market Low & reclaim back inside range
        elif (not low_swept_done) and low_p[i] <= pl_lvl - min_sweep_pts:
            overshoot = pl_lvl - low_p[i]
            if overshoot <= max_sweep_atr * a and close_p[i] > pl_lvl and close_p[i] > open_p[i]:
                sig[i] = 1
                sl_out[i] = low_p[i] - 0.25 * a
                tp_out[i] = mid_target
                low_swept_done = True

    return sig, sl_out, tp_out


def strat_liquidity_sweep_reclaim(
    df: pl.DataFrame, params: dict[str, Any], include_overlays: bool = True
) -> dict[str, Any]:
    """London / Pre-Market High-Low Liquidity Sweep & Reclaim Scalp."""
    min_sweep = float(params.get("min_sweep_pts", 2.0))
    max_sweep_atr = float(params.get("max_sweep_atr", 1.8))

    open_p = df["open"].to_numpy()
    high_p = df["high"].to_numpy()
    low_p = df["low"].to_numpy()
    close_p = df["close"].to_numpy()
    day_id = df["et_day_id"].to_numpy()
    et_min = df["et_minute"].to_numpy()

    pm_h, pm_l, pm_ready = premarket_high_low(high_p, low_p, day_id, et_min, 180, 570)
    atr_arr = atr(high_p, low_p, close_p, 14)

    sig, sl_out, tp_out = _sweep_reclaim_kernel(
        open_p, high_p, low_p, close_p, day_id, pm_h, pm_l, pm_ready, atr_arr, min_sweep, max_sweep_atr
    )

    overlays = {}
    if include_overlays:
        overlays = {
            "Pre-Market High": {"values": pm_h, "color": "#22c55e", "style": "dashed"},
            "Pre-Market Low": {"values": pm_l, "color": "#ef4444", "style": "dashed"},
        }
    return {"signal": sig, "stop_price": sl_out, "target_price": tp_out, "overlays": overlays}


@njit(cache=True)
def _keltner_fade_kernel(
    open_p: np.ndarray,
    high_p: np.ndarray,
    low_p: np.ndarray,
    close_p: np.ndarray,
    kc_mid: np.ndarray,
    kc_up: np.ndarray,
    kc_dn: np.ndarray,
    rsi_arr: np.ndarray,
    atr_arr: np.ndarray,
    rsi_oversold: float,
    rsi_overbought: float,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    n = len(close_p)
    sig = np.zeros(n, dtype=np.int64)
    sl_out = np.full(n, np.nan, dtype=np.float64)
    tp_out = np.full(n, np.nan, dtype=np.float64)

    for i in range(2, n):
        a = atr_arr[i]
        if np.isnan(kc_up[i]) or np.isnan(a) or a <= 0.0:
            continue

        # Oversold pierce below lower Keltner band + bullish reversal bar
        if low_p[i] < kc_dn[i] and rsi_arr[i] <= rsi_oversold and close_p[i] > open_p[i]:
            sig[i] = 1
            sl_out[i] = low_p[i] - 0.4 * a
            tp_out[i] = kc_mid[i]

        # Overbought pierce above upper Keltner band + bearish reversal bar
        elif high_p[i] > kc_up[i] and rsi_arr[i] >= rsi_overbought and close_p[i] < open_p[i]:
            sig[i] = -1
            sl_out[i] = high_p[i] + 0.4 * a
            tp_out[i] = kc_mid[i]

    return sig, sl_out, tp_out


def strat_keltner_vwap_fade(df: pl.DataFrame, params: dict[str, Any], include_overlays: bool = True) -> dict[str, Any]:
    """Keltner Channel + RSI Exhaustion Mean-Reversion Scalp."""
    ema_len = int(params.get("kc_ema_period", 20))
    kc_mult = float(params.get("kc_atr_mult", 2.2))
    rsi_len = int(params.get("rsi_period", 14))
    rsi_os = float(params.get("rsi_oversold", 30.0))
    rsi_ob = float(params.get("rsi_overbought", 70.0))

    open_p = df["open"].to_numpy()
    high_p = df["high"].to_numpy()
    low_p = df["low"].to_numpy()
    close_p = df["close"].to_numpy()

    kc_mid, kc_up, kc_dn = keltner_channels(high_p, low_p, close_p, ema_len, 14, kc_mult)
    rsi_arr = rsi(close_p, rsi_len)
    atr_arr = atr(high_p, low_p, close_p, 14)

    sig, sl_out, tp_out = _keltner_fade_kernel(
        open_p, high_p, low_p, close_p, kc_mid, kc_up, kc_dn, rsi_arr, atr_arr, rsi_os, rsi_ob
    )

    overlays = {}
    if include_overlays:
        overlays = {
            f"KC Basis ({ema_len})": {"values": kc_mid, "color": "#38bdf8", "style": "solid"},
            "KC Upper": {"values": kc_up, "color": "#f43f5e", "style": "dashed"},
            "KC Lower": {"values": kc_dn, "color": "#10b981", "style": "dashed"},
        }
    return {"signal": sig, "stop_price": sl_out, "target_price": tp_out, "overlays": overlays}


BUILTIN_STRATEGIES: dict[str, dict[str, Any]] = {
    "ny_orb_vwap": {
        "id": "ny_orb_vwap",
        "name": "NY Opening Range Breakout (ORB + VWAP)",
        "category": "Breakout Scalp",
        "description": (
            "Captures the 09:30 ET Nasdaq-100 Cash Open Opening Range and triggers a scalp on a clean 5m close "
            "outside the ORB aligned with Session VWAP. Places dynamic Stop-Loss at ORB midpoint or opposite boundary."
        ),
        "recommended_session": "NY_OPEN_KILLZONE",
        "fn": strat_ny_orb_vwap,
        "code": inspect.getsource(strat_ny_orb_vwap),
        "params": [
            ParamSpec(
                name="orb_minutes",
                label="ORB Window (Minutes)",
                type="int",
                default=15,
                min=5,
                max=60,
                step=5,
                description="Opening range duration after 09:30 ET (5, 10, 15, or 30m).",
            ),
            ParamSpec(
                name="min_buffer_pts",
                label="Breakout Buffer (Pts)",
                type="float",
                default=1.0,
                min=0.0,
                max=15.0,
                step=0.5,
                description="Minimum points beyond ORB High/Low required on 5m close.",
            ),
            ParamSpec(
                name="max_orb_atr_mult",
                label="Max ORB Width (ATR Mult)",
                type="float",
                default=4.5,
                min=1.5,
                max=10.0,
                step=0.5,
                description="Skip blown-out opening ranges wider than X * ATR(14).",
            ),
            ParamSpec(
                name="require_vwap_align",
                label="Require Session VWAP Alignment",
                type="bool",
                default=True,
                description="Only buy above 9:30 Session VWAP and short below Session VWAP.",
            ),
            ParamSpec(
                name="use_midpoint_sl",
                label="Stop at ORB Midpoint",
                type="bool",
                default=True,
                description="Place structural stop at ORB 50% midpoint instead of full opposite side.",
            ),
            ParamSpec(
                name="one_breakout_per_side",
                label="Max 1 Attempt Per Side/Day",
                type="bool",
                default=True,
                description="Prevent repeated chop re-entries on the same ORB level.",
            ),
        ],
    },
    "vwap_ema_pullback": {
        "id": "vwap_ema_pullback",
        "name": "Session VWAP + 9/21 EMA Pullback Scalp",
        "category": "Trend Continuation",
        "description": (
            "Enters with institutional intraday orderflow when price pulls back into the fast EMA / Session VWAP "
            "support/resistance pocket and prints a rejection continuation bar confirmed by RSI."
        ),
        "recommended_session": "NY_AM_SESSION",
        "fn": strat_vwap_ema_pullback,
        "code": inspect.getsource(strat_vwap_ema_pullback),
        "params": [
            ParamSpec(name="fast_ema", label="Fast EMA Period", type="int", default=9, min=5, max=30, step=1),
            ParamSpec(name="slow_ema", label="Slow EMA Period", type="int", default=21, min=12, max=80, step=1),
            ParamSpec(
                name="pullback_atr_tol",
                label="Pullback Zone Tolerance (ATR)",
                type="float",
                default=0.25,
                min=0.0,
                max=1.0,
                step=0.05,
            ),
            ParamSpec(name="rsi_period", label="RSI Period", type="int", default=14, min=5, max=30, step=1),
            ParamSpec(name="rsi_min_bull", label="Min Bull RSI", type="float", default=52.0, min=40.0, max=70.0, step=1.0),
            ParamSpec(name="rsi_max_bear", label="Max Bear RSI", type="float", default=48.0, min=30.0, max=60.0, step=1.0),
            ParamSpec(name="sl_swing_lookback", label="Swing Stop Lookback Bars", type="int", default=4, min=2, max=12, step=1),
        ],
    },
    "ict_fvg_scalp": {
        "id": "ict_fvg_scalp",
        "name": "ICT Fair Value Gap (FVG) Displacement Scalp",
        "category": "SMC / Price Action",
        "description": (
            "Detects 3-candle institutional displacement creating an imbalanced Fair Value Gap (FVG) aligned with "
            "trend EMA, entering on a subsequent 5m retracement tap into the FVG during NY Killzone / Silver Bullet."
        ),
        "recommended_session": "NY_SILVER_BULLET",
        "fn": strat_ict_fvg_scalp,
        "code": inspect.getsource(strat_ict_fvg_scalp),
        "params": [
            ParamSpec(name="trend_ema", label="Trend Filter EMA", type="int", default=50, min=10, max=200, step=5),
            ParamSpec(
                name="min_gap_atr",
                label="Min FVG Width (ATR Mult)",
                type="float",
                default=0.25,
                min=0.05,
                max=1.5,
                step=0.05,
            ),
            ParamSpec(
                name="displacement_body_atr",
                label="Impulse Body Min (ATR Mult)",
                type="float",
                default=0.85,
                min=0.3,
                max=2.5,
                step=0.05,
            ),
            ParamSpec(
                name="fvg_expiry_bars",
                label="FVG Retracement Window (Bars)",
                type="int",
                default=8,
                min=2,
                max=24,
                step=1,
            ),
        ],
    },
    "liquidity_sweep_reclaim": {
        "id": "liquidity_sweep_reclaim",
        "name": "Pre-Market High/Low Liquidity Sweep & Reclaim",
        "category": "Stop-Hunt Reversal",
        "description": (
            "Tracks London & NY Pre-Market (03:00–09:30 ET) High and Low liquidity pools. Enters when NY Open "
            "sweeps stops beyond the boundary and closes sharply back inside range, placing SL right beyond the sweep wick."
        ),
        "recommended_session": "NY_OPEN_KILLZONE",
        "fn": strat_liquidity_sweep_reclaim,
        "code": inspect.getsource(strat_liquidity_sweep_reclaim),
        "params": [
            ParamSpec(
                name="min_sweep_pts",
                label="Min Sweep Beyond Level (Pts)",
                type="float",
                default=2.0,
                min=0.25,
                max=20.0,
                step=0.5,
            ),
            ParamSpec(
                name="max_sweep_atr",
                label="Max Sweep Overshoot (ATR)",
                type="float",
                default=1.8,
                min=0.5,
                max=5.0,
                step=0.1,
            ),
        ],
    },
    "keltner_vwap_fade": {
        "id": "keltner_vwap_fade",
        "name": "Keltner + RSI Exhaustion Mean-Reversion",
        "category": "Mean Reversion Scalp",
        "description": (
            "Fades overextended 5m volatility spikes outside outer Keltner ATR bands when RSI reaches exhaustion "
            "and prints an immediate reversal bar back toward the EMA/VWAP mean."
        ),
        "recommended_session": "NY_RTH",
        "fn": strat_keltner_vwap_fade,
        "code": inspect.getsource(strat_keltner_vwap_fade),
        "params": [
            ParamSpec(name="kc_ema_period", label="Keltner EMA Period", type="int", default=20, min=8, max=60, step=2),
            ParamSpec(
                name="kc_atr_mult",
                label="Keltner Band Width (ATR Mult)",
                type="float",
                default=2.2,
                min=1.2,
                max=4.0,
                step=0.1,
            ),
            ParamSpec(name="rsi_period", label="RSI Period", type="int", default=14, min=4, max=28, step=1),
            ParamSpec(name="rsi_oversold", label="RSI Oversold Level", type="float", default=30.0, min=10.0, max=45.0, step=2.0),
            ParamSpec(name="rsi_overbought", label="RSI Overbought Level", type="float", default=70.0, min=55.0, max=90.0, step=2.0),
        ],
    },
}
