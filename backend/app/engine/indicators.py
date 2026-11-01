from __future__ import annotations

import numpy as np
from numba import njit


@njit(cache=True)
def ema(arr: np.ndarray, period: int) -> np.ndarray:
    n = len(arr)
    out = np.full(n, np.nan, dtype=np.float64)
    if n == 0 or period <= 0:
        return out
    if period == 1:
        return arr.astype(np.float64)
    alpha = 2.0 / (period + 1.0)
    # Seed with first valid value or simple mean of first `period` bars
    start = min(period, n)
    acc = 0.0
    for i in range(start):
        acc += arr[i]
    out[start - 1] = acc / start
    for i in range(start, n):
        out[i] = alpha * arr[i] + (1.0 - alpha) * out[i - 1]
    return out


@njit(cache=True)
def sma(arr: np.ndarray, period: int) -> np.ndarray:
    n = len(arr)
    out = np.full(n, np.nan, dtype=np.float64)
    if n < period or period <= 0:
        return out
    running = 0.0
    for i in range(period):
        running += arr[i]
    out[period - 1] = running / period
    for i in range(period, n):
        running += arr[i] - arr[i - period]
        out[i] = running / period
    return out


@njit(cache=True)
def atr(high: np.ndarray, low: np.ndarray, close: np.ndarray, period: int = 14) -> np.ndarray:
    n = len(close)
    out = np.full(n, np.nan, dtype=np.float64)
    if n == 0 or period <= 0:
        return out
    tr = np.empty(n, dtype=np.float64)
    tr[0] = high[0] - low[0]
    for i in range(1, n):
        hl = high[i] - low[i]
        hc = abs(high[i] - close[i - 1])
        lc = abs(low[i] - close[i - 1])
        tr[i] = max(hl, max(hc, lc))

    if n < period:
        return out
    acc = 0.0
    for i in range(period):
        acc += tr[i]
    out[period - 1] = acc / period
    inv_p = 1.0 / period
    for i in range(period, n):
        out[i] = (out[i - 1] * (period - 1) + tr[i]) * inv_p
    return out


@njit(cache=True)
def rsi(close: np.ndarray, period: int = 14) -> np.ndarray:
    n = len(close)
    out = np.full(n, 50.0, dtype=np.float64)
    if n <= period or period <= 0:
        return out

    avg_gain = 0.0
    avg_loss = 0.0
    for i in range(1, period + 1):
        chg = close[i] - close[i - 1]
        if chg > 0:
            avg_gain += chg
        else:
            avg_loss -= chg
    avg_gain /= period
    avg_loss /= period

    if avg_loss == 0.0:
        out[period] = 100.0
    else:
        rs = avg_gain / avg_loss
        out[period] = 100.0 - (100.0 / (1.0 + rs))

    inv_p = 1.0 / period
    for i in range(period + 1, n):
        chg = close[i] - close[i - 1]
        gain = chg if chg > 0.0 else 0.0
        loss = -chg if chg < 0.0 else 0.0
        avg_gain = (avg_gain * (period - 1) + gain) * inv_p
        avg_loss = (avg_loss * (period - 1) + loss) * inv_p
        if avg_loss <= 1e-12:
            out[i] = 100.0
        else:
            rs = avg_gain / avg_loss
            out[i] = 100.0 - (100.0 / (1.0 + rs))
    return out


@njit(cache=True)
def session_vwap(
    high: np.ndarray,
    low: np.ndarray,
    close: np.ndarray,
    volume: np.ndarray,
    et_day_id: np.ndarray,
    et_minute: np.ndarray,
    anchor_minute: int = 570,
) -> tuple[np.ndarray, np.ndarray]:
    """
    Intraday Session VWAP + 1-sigma volume-weighted standard deviation.
    Resets on every new `et_day_id` AND re-anchors at `anchor_minute` (default 570 = 09:30 ET Cash Open).
    """
    n = len(close)
    vwap_arr = np.empty(n, dtype=np.float64)
    std_arr = np.empty(n, dtype=np.float64)

    cum_pv = 0.0
    cum_p2v = 0.0
    cum_v = 0.0
    prev_day = -1
    anchored_today = False

    for i in range(n):
        day = et_day_id[i]
        minute = et_minute[i]
        if day != prev_day:
            cum_pv = 0.0
            cum_p2v = 0.0
            cum_v = 0.0
            prev_day = day
            anchored_today = minute >= anchor_minute
        elif (not anchored_today) and minute >= anchor_minute:
            # Re-anchor right at 09:30 ET Cash Open!
            cum_pv = 0.0
            cum_p2v = 0.0
            cum_v = 0.0
            anchored_today = True

        tp = (high[i] + low[i] + close[i]) / 3.0
        v = volume[i] if volume[i] > 0.0 else 1.0
        cum_pv += tp * v
        cum_p2v += tp * tp * v
        cum_v += v

        mean = cum_pv / cum_v
        var = max(0.0, (cum_p2v / cum_v) - mean * mean)
        vwap_arr[i] = mean
        std_arr[i] = np.sqrt(var)

    return vwap_arr, std_arr


@njit(cache=True)
def opening_range(
    high: np.ndarray,
    low: np.ndarray,
    et_day_id: np.ndarray,
    et_minute: np.ndarray,
    start_min: int = 570,
    duration_mins: int = 15,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    Compute exact intraday Opening Range High & Low (`start_min` <= `et_minute` < `start_min + duration_mins`).
    `ready[i]` becomes True on bars strictly AFTER the opening range window closes (`et_minute >= end_min`).
    """
    n = len(high)
    orb_h = np.full(n, np.nan, dtype=np.float64)
    orb_l = np.full(n, np.nan, dtype=np.float64)
    ready = np.zeros(n, dtype=np.bool_)

    end_min = start_min + duration_mins
    cur_day = -1
    cur_h = -1e18
    cur_l = 1e18
    has_bars = False

    for i in range(n):
        d = et_day_id[i]
        m = et_minute[i]
        if d != cur_day:
            cur_day = d
            cur_h = -1e18
            cur_l = 1e18
            has_bars = False

        if start_min <= m < end_min:
            if high[i] > cur_h:
                cur_h = high[i]
            if low[i] < cur_l:
                cur_l = low[i]
            has_bars = True
            orb_h[i] = cur_h
            orb_l[i] = cur_l
        elif m >= end_min and has_bars:
            orb_h[i] = cur_h
            orb_l[i] = cur_l
            ready[i] = True

    return orb_h, orb_l, ready


@njit(cache=True)
def premarket_high_low(
    high: np.ndarray,
    low: np.ndarray,
    et_day_id: np.ndarray,
    et_minute: np.ndarray,
    pm_start_min: int = 180,
    pm_end_min: int = 570,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    Track London + NY Pre-Market High & Low (`03:00 ET` .. `09:30 ET` by default)
    for NY Open Liquidity Sweep & Reclaim scalping strategies.
    """
    return opening_range(high, low, et_day_id, et_minute, pm_start_min, pm_end_min - pm_start_min)


def bollinger_bands(close: np.ndarray, period: int = 20, mult: float = 2.0) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    mid = sma(close, period)
    n = len(close)
    std = np.full(n, np.nan, dtype=np.float64)
    if n >= period and period > 1:
        # Fast rolling variance via cumulative sums of squares (shifted by mean for numerical stability)
        mean_global = float(np.nanmean(close))
        shifted = close - mean_global
        cs1 = np.concatenate(([0.0], np.cumsum(shifted)))
        cs2 = np.concatenate(([0.0], np.cumsum(shifted * shifted)))
        s1 = cs1[period:] - cs1[:-period]
        s2 = cs2[period:] - cs2[:-period]
        var = np.maximum(0.0, (s2 / period) - (s1 / period) ** 2)
        std[period - 1 :] = np.sqrt(var)
    upper = mid + mult * std
    lower = mid - mult * std
    return mid, upper, lower


def keltner_channels(
    high: np.ndarray,
    low: np.ndarray,
    close: np.ndarray,
    ema_period: int = 20,
    atr_period: int = 14,
    mult: float = 1.5,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    mid = ema(close, ema_period)
    atr_vals = atr(high, low, close, atr_period)
    return mid, mid + mult * atr_vals, mid - mult * atr_vals


@njit(cache=True)
def adx(high: np.ndarray, low: np.ndarray, close: np.ndarray, period: int = 14) -> np.ndarray:
    n = len(close)
    out = np.full(n, 20.0, dtype=np.float64)
    if n <= period * 2 or period <= 0:
        return out

    tr = np.zeros(n, dtype=np.float64)
    pdm = np.zeros(n, dtype=np.float64)
    ndm = np.zeros(n, dtype=np.float64)

    for i in range(1, n):
        up = high[i] - high[i - 1]
        dn = low[i - 1] - low[i]
        if up > dn and up > 0.0:
            pdm[i] = up
        if dn > up and dn > 0.0:
            ndm[i] = dn
        hl = high[i] - low[i]
        hc = abs(high[i] - close[i - 1])
        lc = abs(low[i] - close[i - 1])
        tr[i] = max(hl, max(hc, lc))

    sm_tr = 0.0
    sm_pdm = 0.0
    sm_ndm = 0.0
    for i in range(1, period + 1):
        sm_tr += tr[i]
        sm_pdm += pdm[i]
        sm_ndm += ndm[i]

    dx_arr = np.zeros(n, dtype=np.float64)
    for i in range(period, n):
        if i > period:
            sm_tr = sm_tr - (sm_tr / period) + tr[i]
            sm_pdm = sm_pdm - (sm_pdm / period) + pdm[i]
            sm_ndm = sm_ndm - (sm_ndm / period) + ndm[i]
        if sm_tr > 1e-12:
            pdi = 100.0 * sm_pdm / sm_tr
            ndi = 100.0 * sm_ndm / sm_tr
            denom = pdi + ndi
            dx_arr[i] = 100.0 * abs(pdi - ndi) / denom if denom > 1e-12 else 0.0

    acc_dx = 0.0
    for i in range(period, period * 2):
        acc_dx += dx_arr[i]
    out[period * 2 - 1] = acc_dx / period
    inv_p = 1.0 / period
    for i in range(period * 2, n):
        out[i] = (out[i - 1] * (period - 1) + dx_arr[i]) * inv_p
    return out
