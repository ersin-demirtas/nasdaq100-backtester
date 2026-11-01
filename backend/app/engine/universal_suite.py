from __future__ import annotations

from typing import Any

import numpy as np
import polars as pl

from app.engine.indicators import sma

TF_SECONDS: dict[str, int] = {
    "1m": 60,
    "1": 60,
    "3m": 180,
    "3": 180,
    "5m": 300,
    "5": 300,
    "15m": 900,
    "15": 900,
    "1h": 3600,
    "60m": 3600,
    "60": 3600,
    "4h": 14400,
    "240m": 14400,
    "240": 14400,
    "1D": 86400,
    "D": 86400,
}


def resample_bars_upto(df_base: pl.DataFrame, tf: str) -> pl.DataFrame:
    """
    Aggregate base (`1m` or `5m`) bars (already filtered `<= sim_ts`) into target timeframe `tf`
    with zero future lookahead. Includes the currently forming bar as of `sim_ts`.
    """
    tf_norm = tf.strip()
    if tf_norm in ("1D", "D"):
        # Group by ET trading day (`et_day_id`)
        if "et_day_id" not in df_base.columns:
            dt_et = pl.from_epoch(pl.col("ts"), time_unit="s").dt.replace_time_zone("UTC").dt.convert_time_zone("America/New_York")
            df_base = df_base.with_columns(
                (
                    dt_et.dt.year().cast(pl.Int32) * 10000
                    + dt_et.dt.month().cast(pl.Int32) * 100
                    + dt_et.dt.day().cast(pl.Int32)
                ).alias("et_day_id")
            )
        out = (
            df_base.group_by("et_day_id", maintain_order=True)
            .agg(
                [
                    pl.col("ts").first().alias("ts"),
                    pl.col("open").first().alias("open"),
                    pl.col("high").max().alias("high"),
                    pl.col("low").min().alias("low"),
                    pl.col("close").last().alias("close"),
                    pl.col("volume").sum().alias("volume") if "volume" in df_base.columns else pl.lit(1.0).alias("volume"),
                    pl.col("spread").last().alias("spread") if "spread" in df_base.columns else pl.lit(0.5).alias("spread"),
                ]
            )
            .sort("ts")
        )
        return _attach_et_fields(out)

    sec = TF_SECONDS.get(tf_norm, 300)
    if sec == 60 and df_base.height > 0:
        # Check if already 1m
        out = df_base.select(
            [
                pl.col("ts").cast(pl.Int64),
                pl.col("open").cast(pl.Float64),
                pl.col("high").cast(pl.Float64),
                pl.col("low").cast(pl.Float64),
                pl.col("close").cast(pl.Float64),
                pl.col("volume").cast(pl.Float64) if "volume" in df_base.columns else pl.lit(1.0).alias("volume"),
                pl.col("spread").cast(pl.Float64) if "spread" in df_base.columns else pl.lit(0.5).alias("spread"),
            ]
        )
        return _attach_et_fields(out)

    out = (
        df_base.with_columns(((pl.col("ts") // sec) * sec).alias("bucket_ts"))
        .group_by("bucket_ts", maintain_order=True)
        .agg(
            [
                pl.col("open").first().alias("open"),
                pl.col("high").max().alias("high"),
                pl.col("low").min().alias("low"),
                pl.col("close").last().alias("close"),
                pl.col("volume").sum().alias("volume") if "volume" in df_base.columns else pl.lit(1.0).alias("volume"),
                pl.col("spread").last().alias("spread") if "spread" in df_base.columns else pl.lit(0.5).alias("spread"),
            ]
        )
        .rename({"bucket_ts": "ts"})
        .sort("ts")
    )
    return _attach_et_fields(out)


def _attach_et_fields(df: pl.DataFrame) -> pl.DataFrame:
    if df.height == 0:
        return df
    dt_et = (
        pl.from_epoch(pl.col("ts"), time_unit="s")
        .dt.replace_time_zone("UTC")
        .dt.convert_time_zone("America/New_York")
    )
    return (
        df.with_columns(dt_et.alias("_dt_et"))
        .with_columns(
            [
                pl.col("_dt_et").dt.year().cast(pl.Int32).alias("et_year"),
                pl.col("_dt_et").dt.month().cast(pl.Int32).alias("et_month"),
                pl.col("_dt_et").dt.iso_year().cast(pl.Int32).alias("et_iso_year"),
                pl.col("_dt_et").dt.week().cast(pl.Int32).alias("et_week"),
                (
                    pl.col("_dt_et").dt.year().cast(pl.Int32) * 10000
                    + pl.col("_dt_et").dt.month().cast(pl.Int32) * 100
                    + pl.col("_dt_et").dt.day().cast(pl.Int32)
                ).alias("et_day_id"),
                (
                    pl.col("_dt_et").dt.hour().cast(pl.Int32) * 60
                    + pl.col("_dt_et").dt.minute().cast(pl.Int32)
                ).alias("et_minute"),
                pl.col("_dt_et").dt.strftime("%Y-%m-%d %H:%M").alias("et_str"),
            ]
        )
        .drop("_dt_et")
    )


def _compute_vwap_and_bands(
    df_chart: pl.DataFrame,
    anchor: str = "Session",
    calc_mode: str = "Standard Deviation",
    mult_1: float = 1.0,
    mult_2: float = 2.0,
    mult_3: float = 3.0,
) -> dict[str, np.ndarray]:
    high = df_chart["high"].to_numpy()
    low = df_chart["low"].to_numpy()
    close = df_chart["close"].to_numpy()
    vol = df_chart["volume"].to_numpy()
    et_day = df_chart["et_day_id"].to_numpy()
    et_year = df_chart["et_year"].to_numpy()
    et_month = df_chart["et_month"].to_numpy()
    et_iso_y = df_chart["et_iso_year"].to_numpy()
    et_week = df_chart["et_week"].to_numpy()

    n = len(close)
    vwap = np.full(n, np.nan, dtype=np.float64)
    stdev = np.full(n, np.nan, dtype=np.float64)

    if anchor == "Week":
        period_id = et_iso_y * 100 + et_week
    elif anchor == "Month":
        period_id = et_year * 100 + et_month
    elif anchor == "Quarter":
        period_id = et_year * 10 + ((et_month - 1) // 3)
    elif anchor == "Year":
        period_id = et_year
    else:  # "Session" ("D")
        period_id = et_day

    cum_pv = 0.0
    cum_p2v = 0.0
    cum_v = 0.0
    prev_p = -999999999

    for i in range(n):
        p = int(period_id[i])
        if p != prev_p:
            cum_pv = 0.0
            cum_p2v = 0.0
            cum_v = 0.0
            prev_p = p

        hlc3 = (high[i] + low[i] + close[i]) / 3.0
        v = vol[i] if vol[i] > 0.0 else 1.0
        cum_pv += hlc3 * v
        cum_p2v += hlc3 * hlc3 * v
        cum_v += v

        mean = cum_pv / cum_v
        var = max(0.0, (cum_p2v / cum_v) - mean * mean)
        vwap[i] = mean
        stdev[i] = np.sqrt(var)

    basis = stdev if calc_mode == "Standard Deviation" else (vwap * 0.01)
    return {
        "vwap": vwap,
        "u1": vwap + basis * mult_1,
        "l1": vwap - basis * mult_1,
        "u2": vwap + basis * mult_2,
        "l2": vwap - basis * mult_2,
        "u3": vwap + basis * mult_3,
        "l3": vwap - basis * mult_3,
    }


def _compute_0dte_aem(
    df_chart: pl.DataFrame,
    df_daily: pl.DataFrame,
    round_to: int = 5,
    iv_mult: float = 1.0,
) -> dict[str, np.ndarray]:
    """
    0DTE Anchored Expected Move [SyntaxGeek] adapted for full 5–10 year historical simulation:
    - Anchors at NY Regular Session start (`09:30–09:35 ET` first bar >= 570 min ET each day).
    - Computes daily ATM straddle Expected Move from prior 14-day realized daily range/volatility
      (`sqrt(2/pi) * sigma_daily * anchor_open * iv_mult`) with zero future lookahead!
    - Emits `NaN` on the `newDay` transition bar (`plot.style_linebr`) so horizontal levels never connect diagonally across days!
    """
    n = df_chart.height
    center_arr = np.full(n, np.nan, dtype=np.float64)
    high_arr = np.full(n, np.nan, dtype=np.float64)
    low_arr = np.full(n, np.nan, dtype=np.float64)
    run_high_arr = np.full(n, np.nan, dtype=np.float64)
    run_low_arr = np.full(n, np.nan, dtype=np.float64)

    if n == 0:
        return {
            "center": center_arr,
            "em_high": high_arr,
            "em_low": low_arr,
            "run_high": run_high_arr,
            "run_low": run_low_arr,
        }

    # Build lookup of prior-14-day daily Parkinson/Close sigma keyed by `et_day_id`
    day_sigma_map: dict[int, float] = {}
    if df_daily.height >= 2:
        d_ids = df_daily["et_day_id"].to_numpy()
        d_h = df_daily["high"].to_numpy()
        d_l = df_daily["low"].to_numpy()
        d_c = df_daily["close"].to_numpy()
        pct_ranges = (d_h - d_l) / np.maximum(d_c, 1.0)
        for k in range(len(d_ids)):
            if k == 0:
                sig = float(pct_ranges[0]) * 0.75
            else:
                lb_start = max(0, k - 14)
                # Strictly prior days [lb_start : k] -> ZERO lookahead into today's range!
                sig = float(np.mean(pct_ranges[lb_start:k])) * 0.78
            day_sigma_map[int(d_ids[k])] = max(0.0045, min(sig, 0.045))

    open_p = df_chart["open"].to_numpy()
    et_day = df_chart["et_day_id"].to_numpy()
    et_min = df_chart["et_minute"].to_numpy()

    nearest = max(1, int(round_to))
    cur_day = -1
    anchored_today = False
    anchor_open = 0.0
    center_strike = 0.0
    today_em = 0.0

    for i in range(n):
        d = int(et_day[i])
        m = int(et_min[i])
        if d != cur_day:
            cur_day = d
            anchored_today = False

        if (not anchored_today) and m >= 570:
            anchored_today = True
            anchor_open = open_p[i]
            center_strike = round(anchor_open / nearest) * nearest
            sigma = day_sigma_map.get(d, 0.011)
            today_em = anchor_open * sigma * iv_mult
            # Leave center_arr[i], high_arr[i], low_arr[i] as NaN on newDay bar to force `plot.style_linebr` break!
            continue

        if anchored_today and center_strike > 0.0 and m <= 965:
            center_arr[i] = center_strike
            high_arr[i] = anchor_open + today_em
            low_arr[i] = anchor_open - today_em
            # Intraday remaining theta decay (09:30=570 -> 16:00=960 = 390 mins)
            rem_frac = max(0.04, min(1.0, (960.0 - m) / 390.0))
            run_em = today_em * np.sqrt(rem_frac)
            run_high_arr[i] = open_p[i] + run_em
            run_low_arr[i] = open_p[i] - run_em

    return {
        "center": center_arr,
        "em_high": high_arr,
        "em_low": low_arr,
        "run_high": run_high_arr,
        "run_low": run_low_arr,
    }


def _compute_luxalgo_fvg(
    df_chart: pl.DataFrame,
    df_base: pl.DataFrame,
    chart_tf: str,
    fvg_tf: str,
    sim_ts: int,
    threshold_pct: float = 0.0,
    auto_threshold: bool = False,
    unmitigated_levels: int = 0,
    mitigation_levels: bool = False,
    extend_bars: int = 20,
    auto_extend_unmitigated: bool = True,
    dynamic: bool = False,
    window_min_ts: int = 0,
) -> dict[str, Any]:
    """
    Exact port of `1. FAIR VALUE GAP [LuxAlgo]` from the user's Multi-Strategy Universal Suite:
      - Supports `fvg_tf = "Chart"` OR any HTF like `"240"` (4H), `"60"` (1H), `"15"` (15m), `"D"` (1D).
      - Detects Bullish & Bearish FVGs using `low > high[2] and close[1] > high[2]` and `high < low[2] and close[1] < low[2]`.
      - Mitigates & deletes boxes as soon as chart `close < fvg.min` (bullish) or `close > fvg.max` (bearish)!
      - Optionally records dashed mitigation lines (`mitigation_levels`) and dynamic band plots (`dynamic`).
    """
    n_chart = df_chart.height
    if n_chart < 4:
        return {"boxes": [], "mitigation_lines": [], "unmitigated_lines": [], "dynamic": None}

    c_ts = df_chart["ts"].to_numpy()
    c_high = df_chart["high"].to_numpy()
    c_low = df_chart["low"].to_numpy()
    c_close = df_chart["close"].to_numpy()

    use_chart_tf = (not fvg_tf) or fvg_tf.lower() == "chart" or TF_SECONDS.get(fvg_tf, -1) == TF_SECONDS.get(chart_tf, -2)

    # Detect candidate FVGs with exact non-lookahead activation timestamp `avail_ts`
    # Each candidate: (avail_ts, origin_ts, max_top, min_bot, is_bull)
    candidates: list[tuple[int, int, float, float, bool]] = []

    if use_chart_tf:
        rel_ranges = (c_high - c_low) / np.maximum(c_low, 1e-9)
        cum_rel = np.cumsum(rel_ranges)
        for k in range(2, n_chart):
            thresh = (cum_rel[k] / max(k, 1)) if auto_threshold else (threshold_pct / 100.0)
            if c_low[k] > c_high[k - 2] and c_close[k - 1] > c_high[k - 2]:
                if (c_low[k] - c_high[k - 2]) / max(c_high[k - 2], 1e-9) > thresh:
                    candidates.append((int(c_ts[k]), int(c_ts[k - 2]), float(c_low[k]), float(c_high[k - 2]), True))
            elif c_high[k] < c_low[k - 2] and c_close[k - 1] < c_low[k - 2]:
                if (c_low[k - 2] - c_high[k]) / max(c_high[k], 1e-9) > thresh:
                    candidates.append((int(c_ts[k]), int(c_ts[k - 2]), float(c_low[k - 2]), float(c_high[k]), False))
    else:
        df_htf = resample_bars_upto(df_base, fvg_tf)
        if df_htf.height >= 3:
            h_ts = df_htf["ts"].to_numpy()
            h_high = df_htf["high"].to_numpy()
            h_low = df_htf["low"].to_numpy()
            h_close = df_htf["close"].to_numpy()
            htf_sec = TF_SECONDS.get(fvg_tf, 14400)

            rel_ranges = (h_high - h_low) / np.maximum(h_low, 1e-9)
            cum_rel = np.cumsum(rel_ranges)

            for k in range(2, len(h_ts)):
                # Confirm HTF FVG only once the 3rd HTF bar has closed (`h_ts[k] + htf_sec - 60 <= sim_ts`)
                close_of_bar_k = int(h_ts[k]) + htf_sec - 60
                if close_of_bar_k > sim_ts:
                    continue
                thresh = (cum_rel[k] / max(k, 1)) if auto_threshold else (threshold_pct / 100.0)
                if h_low[k] > h_high[k - 2] and h_close[k - 1] > h_high[k - 2]:
                    if (h_low[k] - h_high[k - 2]) / max(h_high[k - 2], 1e-9) > thresh:
                        candidates.append((close_of_bar_k, int(h_ts[k - 2]), float(h_low[k]), float(h_high[k - 2]), True))
                elif h_high[k] < h_low[k - 2] and h_close[k - 1] < h_low[k - 2]:
                    if (h_low[k - 2] - h_high[k]) / max(h_high[k], 1e-9) > thresh:
                        candidates.append((close_of_bar_k, int(h_ts[k - 2]), float(h_low[k - 2]), float(h_high[k]), False))

    # Replay candidate activation & chart-close mitigation bar-by-bar exactly like Pine Script!
    active_records: list[dict[str, Any]] = []
    mitigated_lines: list[dict[str, Any]] = []

    dyn_bull_max = np.full(n_chart, np.nan, dtype=np.float64)
    dyn_bull_min = np.full(n_chart, np.nan, dtype=np.float64)
    dyn_bear_max = np.full(n_chart, np.nan, dtype=np.float64)
    dyn_bear_min = np.full(n_chart, np.nan, dtype=np.float64)
    cur_b_max = np.nan
    cur_b_min = np.nan
    cur_s_max = np.nan
    cur_s_min = np.nan

    cand_idx = 0
    n_cands = len(candidates)

    for i in range(n_chart):
        bar_t = int(c_ts[i])
        bar_c = float(c_close[i])

        # Activate any FVG whose `avail_ts <= bar_t`
        spawned_bull = False
        spawned_bear = False
        while cand_idx < n_cands and candidates[cand_idx][0] <= bar_t:
            avail_t, orig_t, top_v, bot_v, is_bull = candidates[cand_idx]
            cand_idx += 1
            active_records.insert(
                0,
                {
                    "avail_ts": avail_t,
                    "origin_ts": orig_t,
                    "spawn_bar_idx": i,
                    "max": top_v,
                    "min": bot_v,
                    "is_bull": is_bull,
                },
            )
            if is_bull:
                cur_b_max = top_v
                cur_b_min = bot_v
                spawned_bull = True
            else:
                cur_s_max = top_v
                cur_s_min = bot_v
                spawned_bear = True

        if dynamic:
            if not spawned_bull and not np.isnan(cur_b_max):
                cur_b_max = max(min(bar_c, cur_b_max), cur_b_min)
            if not spawned_bear and not np.isnan(cur_s_min):
                cur_s_min = min(max(bar_c, cur_s_min), cur_s_max)
            if cur_b_max > cur_b_min:
                dyn_bull_max[i] = cur_b_max
                dyn_bull_min[i] = cur_b_min
            if cur_s_max > cur_s_min:
                dyn_bear_max[i] = cur_s_max
                dyn_bear_min[i] = cur_s_min

        # Check mitigation on all active unmitigated FVGs (skipping the exact spawn bar `i` on chart-tf)
        for r_i in range(len(active_records) - 1, -1, -1):
            rec = active_records[r_i]
            if rec["spawn_bar_idx"] == i and use_chart_tf:
                continue
            if rec["is_bull"]:
                if bar_c < rec["min"]:
                    if mitigation_levels and bar_t >= window_min_ts:
                        mitigated_lines.append(
                            {
                                "start_ts": rec["origin_ts"],
                                "end_ts": bar_t,
                                "price": round(rec["min"], 2),
                                "is_bull": True,
                            }
                        )
                    active_records.pop(r_i)
            else:
                if bar_c > rec["max"]:
                    if mitigation_levels and bar_t >= window_min_ts:
                        mitigated_lines.append(
                            {
                                "start_ts": rec["origin_ts"],
                                "end_ts": bar_t,
                                "price": round(rec["max"], 2),
                                "is_bull": False,
                            }
                        )
                    active_records.pop(r_i)

    chart_step = TF_SECONDS.get(chart_tf, 300)
    last_bar_ts = int(c_ts[-1])

    boxes: list[dict[str, Any]] = []
    if not dynamic:
        for rec in active_records[:80]:  # cap to 80 clean unmitigated boxes
            start_ts = max(int(c_ts[0]), int(rec["origin_ts"]))
            if auto_extend_unmitigated:
                end_ts = last_bar_ts + max(4, min(extend_bars, 25)) * chart_step
            else:
                spawn_i = int(rec["spawn_bar_idx"])
                target_i = spawn_i + extend_bars
                if target_i < n_chart:
                    end_ts = int(c_ts[target_i])
                else:
                    end_ts = last_bar_ts + (target_i - n_chart + 1) * chart_step

            if end_ts < window_min_ts:
                continue

            boxes.append(
                {
                    "start_ts": start_ts,
                    "end_ts": end_ts,
                    "max": round(float(rec["max"]), 2),
                    "min": round(float(rec["min"]), 2),
                    "is_bull": bool(rec["is_bull"]),
                    "tf": fvg_tf,
                }
            )

    unmit_lines: list[dict[str, Any]] = []
    if unmitigated_levels > 0:
        for rec in active_records[:unmitigated_levels]:
            lvl = rec["min"] if rec["is_bull"] else rec["max"]
            unmit_lines.append(
                {
                    "start_ts": max(int(c_ts[0]), int(rec["origin_ts"])),
                    "end_ts": last_bar_ts + 10 * chart_step,
                    "price": round(float(lvl), 2),
                    "is_bull": bool(rec["is_bull"]),
                }
            )

    return {
        "boxes": boxes,
        "mitigation_lines": mitigated_lines[-60:],
        "unmitigated_lines": unmit_lines,
        "dynamic": {
            "bull_max": dyn_bull_max,
            "bull_min": dyn_bull_min,
            "bear_max": dyn_bear_max,
            "bear_min": dyn_bear_min,
        }
        if dynamic
        else None,
    }


def _serialize_line(ts_arr: np.ndarray, vals: np.ndarray) -> list[dict[str, float | int | None]]:
    out: list[dict[str, float | int | None]] = []
    for t, v in zip(ts_arr.tolist(), vals.tolist()):
        if v is None or np.isnan(v):
            out.append({"time": int(t), "value": None})
        else:
            out.append({"time": int(t), "value": round(float(v), 2)})
    return out


def build_replay_pane_payload(
    df_base: pl.DataFrame,
    chart_tf: str,
    sim_ts: int,
    limit: int,
    settings: dict[str, Any],
    df_daily_cached: pl.DataFrame | None = None,
    mtf_right_candles_cached: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """
    Build a complete chart pane payload (`candles` + all 5 `Multi-Strategy Universal Suite` layers)
    strictly up to `sim_ts` with zero lookahead.
    """
    df_tf_all = resample_bars_upto(df_base, chart_tf)
    total_tf_bars = df_tf_all.height
    if total_tf_bars == 0:
        return {"tf": chart_tf, "candles": [], "suite": {}}

    # Keep warmup buffer (`limit + 250`) for SMA/VWAP/FVG accuracy, then slice last `limit` for wire payload
    warmup_keep = min(total_tf_bars, limit + 300)
    df_calc = df_tf_all.slice(total_tf_bars - warmup_keep, warmup_keep)
    n_calc = df_calc.height
    win_start = max(0, n_calc - limit)
    df_win = df_calc.slice(win_start, n_calc - win_start)

    ts_win = df_win["ts"].to_numpy()
    win_min_ts = int(ts_win[0]) if len(ts_win) > 0 else 0

    candles = [
        {
            "time": int(t),
            "open": round(float(o), 2),
            "high": round(float(h), 2),
            "low": round(float(l), 2),
            "close": round(float(c), 2),
            "volume": round(float(v), 2),
            "spread": round(float(sp), 2),
            "et": et_s,
        }
        for t, o, h, l, c, v, sp, et_s in zip(
            df_win["ts"].to_list(),
            df_win["open"].to_list(),
            df_win["high"].to_list(),
            df_win["low"].to_list(),
            df_win["close"].to_list(),
            df_win["volume"].to_list(),
            df_win["spread"].to_list(),
            df_win["et_str"].to_list(),
        )
    ]

    suite: dict[str, Any] = {}

    # 1. Fair Value Gap [LuxAlgo]
    if settings.get("show_fvg", True):
        fvg_res = _compute_luxalgo_fvg(
            df_chart=df_calc,
            df_base=df_base,
            chart_tf=chart_tf,
            fvg_tf=str(settings.get("fvg_tf", "240")),
            sim_ts=sim_ts,
            threshold_pct=float(settings.get("fvg_threshold_pct", 0.0)),
            auto_threshold=bool(settings.get("fvg_auto", False)),
            unmitigated_levels=int(settings.get("fvg_unmitigated_levels", 0)),
            mitigation_levels=bool(settings.get("fvg_mitigation_levels", False)),
            extend_bars=int(settings.get("fvg_extend", 20)),
            auto_extend_unmitigated=bool(settings.get("fvg_auto_extend", True)),
            dynamic=bool(settings.get("fvg_dynamic", False)),
            window_min_ts=win_min_ts,
        )
        dyn_payload = None
        if fvg_res["dynamic"] is not None:
            d = fvg_res["dynamic"]
            dyn_payload = {
                "bull_max": _serialize_line(ts_win, d["bull_max"][win_start:]),
                "bull_min": _serialize_line(ts_win, d["bull_min"][win_start:]),
                "bear_max": _serialize_line(ts_win, d["bear_max"][win_start:]),
                "bear_min": _serialize_line(ts_win, d["bear_min"][win_start:]),
            }
        suite["fvg"] = {
            "boxes": fvg_res["boxes"],
            "mitigation_lines": fvg_res["mitigation_lines"],
            "unmitigated_lines": fvg_res["unmitigated_lines"],
            "dynamic": dyn_payload,
        }

    # 2. MA Cross (SMA 9 & SMA 21 + Cross markers)
    if settings.get("show_ma", True):
        short_len = max(1, int(settings.get("ma_short_len", 9)))
        long_len = max(2, int(settings.get("ma_long_len", 21)))
        c_arr = df_calc["close"].to_numpy()
        s_ma = sma(c_arr, short_len)[win_start:]
        l_ma = sma(c_arr, long_len)[win_start:]

        crosses: list[dict[str, float | int]] = []
        for idx in range(1, len(ts_win)):
            if np.isnan(s_ma[idx]) or np.isnan(l_ma[idx]) or np.isnan(s_ma[idx - 1]) or np.isnan(l_ma[idx - 1]):
                continue
            crossed_up = s_ma[idx] >= l_ma[idx] and s_ma[idx - 1] < l_ma[idx - 1]
            crossed_dn = s_ma[idx] <= l_ma[idx] and s_ma[idx - 1] > l_ma[idx - 1]
            if crossed_up or crossed_dn:
                crosses.append({"time": int(ts_win[idx]), "price": round(float(s_ma[idx]), 2)})

        suite["ma"] = {
            "short_len": short_len,
            "long_len": long_len,
            "short_ma": [p for p in _serialize_line(ts_win, s_ma) if p["value"] is not None],
            "long_ma": [p for p in _serialize_line(ts_win, l_ma) if p["value"] is not None],
            "crosses": crosses,
        }

    # 3. VWAP + Bands #1, #2, #3
    if settings.get("show_vwap", True):
        vw = _compute_vwap_and_bands(
            df_calc,
            anchor=str(settings.get("vwap_anchor", "Session")),
            calc_mode=str(settings.get("vwap_calc_mode", "Standard Deviation")),
            mult_1=float(settings.get("vwap_mult_1", 1.0)),
            mult_2=float(settings.get("vwap_mult_2", 2.0)),
            mult_3=float(settings.get("vwap_mult_3", 3.0)),
        )
        vw_out: dict[str, Any] = {
            "vwap": [p for p in _serialize_line(ts_win, vw["vwap"][win_start:]) if p["value"] is not None],
        }
        if settings.get("vwap_show_band_1", True):
            vw_out["u1"] = [p for p in _serialize_line(ts_win, vw["u1"][win_start:]) if p["value"] is not None]
            vw_out["l1"] = [p for p in _serialize_line(ts_win, vw["l1"][win_start:]) if p["value"] is not None]
        if settings.get("vwap_show_band_2", False):
            vw_out["u2"] = [p for p in _serialize_line(ts_win, vw["u2"][win_start:]) if p["value"] is not None]
            vw_out["l2"] = [p for p in _serialize_line(ts_win, vw["l2"][win_start:]) if p["value"] is not None]
        if settings.get("vwap_show_band_3", False):
            vw_out["u3"] = [p for p in _serialize_line(ts_win, vw["u3"][win_start:]) if p["value"] is not None]
            vw_out["l3"] = [p for p in _serialize_line(ts_win, vw["l3"][win_start:]) if p["value"] is not None]
        suite["vwap"] = vw_out

    # 4. 0DTE Anchored Expected Move [SyntaxGeek]
    if settings.get("show_aem", True) and chart_tf not in ("1D", "D"):
        df_daily = df_daily_cached if df_daily_cached is not None else resample_bars_upto(df_base, "1D")
        aem = _compute_0dte_aem(
            df_calc,
            df_daily,
            round_to=int(settings.get("aem_round_to", 5)),
            iv_mult=float(settings.get("aem_iv_mult", 1.0)),
        )
        suite["aem"] = {
            "center": _serialize_line(ts_win, aem["center"][win_start:]),
            "em_high": _serialize_line(ts_win, aem["em_high"][win_start:]),
            "em_low": _serialize_line(ts_win, aem["em_low"][win_start:]),
            "run_high": _serialize_line(ts_win, aem["run_high"][win_start:]),
            "run_low": _serialize_line(ts_win, aem["run_low"][win_start:]),
        }

    # 5. Multi-Timeframe Right-Side Candles (15m, 1H, 4H, 1D)
    if settings.get("show_mtf", True):
        if mtf_right_candles_cached is not None:
            suite["mtf_candles"] = mtf_right_candles_cached
        else:
            suite["mtf_candles"] = compute_mtf_right_candles(df_base)

    return {
        "tf": chart_tf,
        "candles": candles,
        "suite": suite,
    }


def compute_mtf_right_candles(df_base: pl.DataFrame) -> list[dict[str, Any]]:
    """
    Compute the live currently-forming `15m`, `1H`, `4H`, and `1D` candles as of `sim_ts`
    at right-hand offsets `+6`, `+11`, `+16`, `+21` matching Section 5 of the user's Pine Script.
    """
    if df_base.height == 0:
        return []

    # Only need recent ~2 days of base bars for 15m/1H/4H/1D current candles!
    tail_bars = min(df_base.height, 4500)
    df_recent = df_base.slice(df_base.height - tail_bars, tail_bars)

    specs = [
        ("15m", "15m", 6),
        ("60m", "1H", 11),
        ("240m", "4H", 16),
        ("1D", "1D", 21),
    ]
    out: list[dict[str, Any]] = []
    for tf_code, label, offset in specs:
        df_tf = resample_bars_upto(df_recent, tf_code)
        if df_tf.height > 0:
            row = df_tf.row(-1, named=True)
            out.append(
                {
                    "label": label,
                    "offset": offset,
                    "open": round(float(row["open"]), 2),
                    "high": round(float(row["high"]), 2),
                    "low": round(float(row["low"]), 2),
                    "close": round(float(row["close"]), 2),
                }
            )
    return out
