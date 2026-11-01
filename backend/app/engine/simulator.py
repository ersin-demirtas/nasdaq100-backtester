from __future__ import annotations

import time
from typing import Any

import numpy as np
from numba import njit
import polars as pl

from app.engine.indicators import atr as calc_atr
from app.models import ExecutionConfig, TradeRecord

EXIT_REASON_NAMES = {
    1: "TP",
    2: "SL",
    3: "BE",
    4: "TRAIL",
    5: "TIME_STOP",
    6: "SESSION_FLATTEN",
    7: "SIGNAL_FLIP",
    8: "DATA_END",
}


def parse_hhmm_to_min(hhmm: str) -> int:
    s = (hhmm or "").strip()
    if not s or ":" not in s:
        return -1
    parts = s.split(":")
    return int(parts[0]) * 60 + int(parts[1])


@njit(cache=True)
def _run_scalp_loop_njit(
    ts: np.ndarray,
    open_p: np.ndarray,
    high_p: np.ndarray,
    low_p: np.ndarray,
    close_p: np.ndarray,
    spread_arr: np.ndarray,
    et_day_id: np.ndarray,
    et_minute: np.ndarray,
    atr_arr: np.ndarray,
    signal: np.ndarray,
    strat_sl: np.ndarray,
    strat_tp: np.ndarray,
    has_subbars: bool,
    sub_start: np.ndarray,
    sub_count: np.ndarray,
    m1_high: np.ndarray,
    m1_low: np.ndarray,
    m1_close: np.ndarray,
    # Config scalars
    initial_capital: float,
    point_value: float,
    tick_size: float,
    cfg_contracts: float,
    sizing_mode_id: int,  # 0=fixed, 1=risk_pct, 2=fixed_usd
    risk_pct: float,
    risk_usd_fixed: float,
    use_dataset_spread: bool,
    cfg_spread_pts: float,
    slippage_pts: float,
    commission_per_side: float,
    intrabar_mode_id: int,  # 0=subbar_1m, 1=pessimistic_sl_first, 2=bar_path_heuristic
    sl_mode_id: int,        # 0=strategy_or_atr, 1=fixed_pts, 2=atr_mult
    sl_pts: float,
    sl_atr_mult: float,
    tp_mode_id: int,        # 0=rr_multiple, 1=fixed_pts, 2=atr_mult, 3=strategy_target
    tp_rr: float,
    tp_pts: float,
    tp_atr_mult: float,
    partial_tp_enabled: bool,
    partial_tp_rr: float,
    partial_tp_pct: float,
    move_sl_to_be_on_partial: bool,
    breakeven_enabled: bool,
    breakeven_trigger_rr: float,
    breakeven_offset_pts: float,
    trailing_enabled: bool,
    trailing_activation_rr: float,
    trailing_distance_pts: float,
    max_bars_in_trade: int,
    allow_long: bool,
    allow_short: bool,
    reverse_on_opposite: bool,
    cooldown_bars: int,
    use_session_filter: bool,
    entry_start_min: int,
    entry_end_min: int,
    flatten_min: int,
    max_trades_per_day: int,
    daily_max_loss_usd: float,
    daily_profit_target_usd: float,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, int]:
    """
    Numba-compiled Nasdaq-100 5m scalping simulator.
    Returns `(trades_matrix, net_equity_curve, gross_equity_curve, trade_count)`.

    `trades_matrix` has shape `(max_possible_trades, 18)` float64:
      0: dir (+1 / -1)
      1: entry_bar_idx
      2: exit_bar_idx
      3: entry_ts
      4: exit_ts
      5: entry_price
      6: exit_price
      7: initial_sl
      8: initial_tp
      9: initial_contracts
     10: gross_pts
     11: net_pts
     12: gross_pnl
     13: friction_cost
     14: net_pnl
     15: r_multiple
     16: mae_pts
     17: mfe_pts
     18: exit_reason_code
     19: partial_taken (0 or 1)
    """
    n = len(close_p)
    max_cap = max(64, n // 2 + 8)
    trades = np.empty((max_cap, 20), dtype=np.float64)
    net_eq = np.empty(n, dtype=np.float64)
    gross_eq = np.empty(n, dtype=np.float64)

    equity = initial_capital
    gross_equity = initial_capital
    t_idx = 0

    in_pos = False
    pos_dir = 0  # +1 long, -1 short
    entry_bar = 0
    entry_mid = 0.0
    entry_fill = 0.0
    initial_sl = 0.0
    cur_sl = 0.0
    sl_reason = 2  # 2=SL, 3=BE, 4=TRAIL
    cur_tp = 0.0
    sl_dist = 1.0
    init_qty = 0.0
    rem_qty = 0.0

    realized_gross_pnl = 0.0
    realized_net_pnl = 0.0
    realized_friction = 0.0
    partial_done = False
    be_done = False
    mae_pts = 0.0
    mfe_pts = 0.0

    cur_day = -1
    trades_today = 0
    daily_pnl = 0.0
    day_halted = False
    cooldown_until = 0

    for i in range(n):
        day = et_day_id[i]
        minute = et_minute[i]
        eff_sp = spread_arr[i] if (use_dataset_spread and spread_arr[i] > cfg_spread_pts) else cfg_spread_pts

        # New ET trading day reset
        if day != cur_day:
            # If overnight position remained open when flatten_min >= 0, close at open[i]
            if in_pos and flatten_min >= 0:
                mid_ex = open_p[i]
                if pos_dir == 1:
                    ex_fill = mid_ex - 0.5 * eff_sp - slippage_pts
                    leg_gross_pts = mid_ex - entry_mid
                    leg_net_pts = ex_fill - entry_fill
                else:
                    ex_fill = mid_ex + 0.5 * eff_sp + slippage_pts
                    leg_gross_pts = entry_mid - mid_ex
                    leg_net_pts = entry_fill - ex_fill

                leg_gross = leg_gross_pts * point_value * rem_qty
                comm = commission_per_side * 2.0 * rem_qty
                leg_net = leg_net_pts * point_value * rem_qty - comm
                leg_fric = leg_gross - leg_net

                tot_gross = realized_gross_pnl + leg_gross
                tot_net = realized_net_pnl + leg_net
                tot_fric = realized_friction + leg_fric
                init_risk_usd = max(1e-9, sl_dist * point_value * init_qty)

                if t_idx < max_cap:
                    trades[t_idx, 0] = pos_dir
                    trades[t_idx, 1] = entry_bar
                    trades[t_idx, 2] = i
                    trades[t_idx, 3] = ts[entry_bar]
                    trades[t_idx, 4] = ts[i]
                    trades[t_idx, 5] = entry_fill
                    trades[t_idx, 6] = ex_fill
                    trades[t_idx, 7] = initial_sl
                    trades[t_idx, 8] = cur_tp
                    trades[t_idx, 9] = init_qty
                    trades[t_idx, 10] = tot_gross / (point_value * init_qty)
                    trades[t_idx, 11] = tot_net / (point_value * init_qty)
                    trades[t_idx, 12] = tot_gross
                    trades[t_idx, 13] = tot_fric
                    trades[t_idx, 14] = tot_net
                    trades[t_idx, 15] = tot_net / init_risk_usd
                    trades[t_idx, 16] = mae_pts
                    trades[t_idx, 17] = mfe_pts
                    trades[t_idx, 18] = 6  # SESSION_FLATTEN
                    trades[t_idx, 19] = 1.0 if partial_done else 0.0
                    t_idx += 1

                equity += tot_net
                gross_equity += tot_gross
                in_pos = False
                cooldown_until = i + cooldown_bars

            cur_day = day
            trades_today = 0
            daily_pnl = 0.0
            day_halted = False

        # Check signal from close of previous bar (i - 1) to execute at open[i]
        if i > 0:
            prev_sig = signal[i - 1]
            # Handle opposite signal reversal/exit at open[i] if already in position
            if in_pos and reverse_on_opposite and prev_sig == -pos_dir:
                mid_ex = open_p[i]
                if pos_dir == 1:
                    ex_fill = mid_ex - 0.5 * eff_sp - slippage_pts
                    leg_gross_pts = mid_ex - entry_mid
                    leg_net_pts = ex_fill - entry_fill
                else:
                    ex_fill = mid_ex + 0.5 * eff_sp + slippage_pts
                    leg_gross_pts = entry_mid - mid_ex
                    leg_net_pts = entry_fill - ex_fill

                leg_gross = leg_gross_pts * point_value * rem_qty
                comm = commission_per_side * 2.0 * rem_qty
                leg_net = leg_net_pts * point_value * rem_qty - comm
                leg_fric = leg_gross - leg_net

                tot_gross = realized_gross_pnl + leg_gross
                tot_net = realized_net_pnl + leg_net
                tot_fric = realized_friction + leg_fric
                init_risk_usd = max(1e-9, sl_dist * point_value * init_qty)

                if t_idx < max_cap:
                    trades[t_idx, 0] = pos_dir
                    trades[t_idx, 1] = entry_bar
                    trades[t_idx, 2] = i
                    trades[t_idx, 3] = ts[entry_bar]
                    trades[t_idx, 4] = ts[i]
                    trades[t_idx, 5] = entry_fill
                    trades[t_idx, 6] = ex_fill
                    trades[t_idx, 7] = initial_sl
                    trades[t_idx, 8] = cur_tp
                    trades[t_idx, 9] = init_qty
                    trades[t_idx, 10] = tot_gross / (point_value * init_qty)
                    trades[t_idx, 11] = tot_net / (point_value * init_qty)
                    trades[t_idx, 12] = tot_gross
                    trades[t_idx, 13] = tot_fric
                    trades[t_idx, 14] = tot_net
                    trades[t_idx, 15] = tot_net / init_risk_usd
                    trades[t_idx, 16] = mae_pts
                    trades[t_idx, 17] = mfe_pts
                    trades[t_idx, 18] = 7  # SIGNAL_FLIP
                    trades[t_idx, 19] = 1.0 if partial_done else 0.0
                    t_idx += 1

                equity += tot_net
                gross_equity += tot_gross
                daily_pnl += tot_net
                if (daily_max_loss_usd > 0.0 and daily_pnl <= -daily_max_loss_usd) or (
                    daily_profit_target_usd > 0.0 and daily_pnl >= daily_profit_target_usd
                ):
                    day_halted = True
                in_pos = False
                cooldown_until = i  # allow immediate flip if within session/limits

            # Attempt new entry at open[i]
            if (not in_pos) and prev_sig != 0 and i >= cooldown_until and (not day_halted):
                dir_ok = (prev_sig == 1 and allow_long) or (prev_sig == -1 and allow_short)
                sess_ok = True
                if use_session_filter:
                    if entry_start_min <= entry_end_min:
                        sess_ok = (minute >= entry_start_min) and (minute <= entry_end_min)
                    else:
                        sess_ok = (minute >= entry_start_min) or (minute <= entry_end_min)
                if flatten_min >= 0 and minute >= flatten_min:
                    sess_ok = False
                trades_ok = (max_trades_per_day <= 0) or (trades_today < max_trades_per_day)

                if dir_ok and sess_ok and trades_ok:
                    pos_dir = 1 if prev_sig > 0 else -1
                    entry_bar = i
                    entry_mid = open_p[i]
                    if pos_dir == 1:
                        entry_fill = entry_mid + 0.5 * eff_sp + slippage_pts
                    else:
                        entry_fill = entry_mid - 0.5 * eff_sp - slippage_pts

                    atr_val = atr_arr[i - 1]
                    if np.isnan(atr_val) or atr_val <= 0.0:
                        atr_val = max(tick_size * 10.0, entry_mid * 0.0012)

                    # Compute SL distance
                    dist = sl_pts
                    if sl_mode_id == 0:  # strategy_or_atr
                        s_sl = strat_sl[i - 1]
                        if (not np.isnan(s_sl)) and s_sl > 0.0:
                            cand = (entry_fill - s_sl) if pos_dir == 1 else (s_sl - entry_fill)
                            if cand > tick_size * 2.0:
                                dist = cand
                            else:
                                dist = atr_val * sl_atr_mult
                        else:
                            dist = atr_val * sl_atr_mult
                    elif sl_mode_id == 1:  # fixed_pts
                        dist = sl_pts
                    else:  # atr_mult
                        dist = atr_val * sl_atr_mult

                    min_sl = max(tick_size * 2.0, eff_sp + slippage_pts + tick_size)
                    sl_dist = max(min_sl, min(dist, entry_mid * 0.05))
                    initial_sl = (entry_fill - sl_dist) if pos_dir == 1 else (entry_fill + sl_dist)
                    cur_sl = initial_sl
                    sl_reason = 2  # SL

                    # Compute TP distance
                    tp_d = sl_dist * tp_rr
                    if tp_mode_id == 1:
                        tp_d = tp_pts
                    elif tp_mode_id == 2:
                        tp_d = atr_val * tp_atr_mult
                    elif tp_mode_id == 3:
                        s_tp = strat_tp[i - 1]
                        if (not np.isnan(s_tp)) and s_tp > 0.0:
                            cand_tp = (s_tp - entry_fill) if pos_dir == 1 else (entry_fill - s_tp)
                            if cand_tp > tick_size * 2.0:
                                tp_d = cand_tp
                    tp_d = max(tick_size * 2.0, tp_d)
                    cur_tp = (entry_fill + tp_d) if pos_dir == 1 else (entry_fill - tp_d)

                    # Position size
                    qty = cfg_contracts
                    if sizing_mode_id == 1:  # risk_pct
                        r_usd = max(10.0, equity * (risk_pct * 0.01))
                        qty = np.floor(r_usd / (sl_dist * point_value))
                        if qty < 1.0:
                            qty = 1.0
                    elif sizing_mode_id == 2:  # fixed_dollar_risk
                        qty = np.floor(risk_usd_fixed / (sl_dist * point_value))
                        if qty < 1.0:
                            qty = 1.0

                    init_qty = qty
                    rem_qty = qty
                    realized_gross_pnl = 0.0
                    realized_net_pnl = 0.0
                    realized_friction = 0.0
                    partial_done = False
                    be_done = False
                    mae_pts = 0.0
                    mfe_pts = 0.0
                    in_pos = True
                    trades_today += 1

        # Evaluate active position through bar `i` (using 1m sub-bars if enabled & present)
        if in_pos:
            use_1m = (intrabar_mode_id == 0) and has_subbars and (sub_count[i] > 0)
            n_steps = sub_count[i] if use_1m else 1
            s_base = sub_start[i] if use_1m else 0

            exit_triggered = False
            exit_fill_price = 0.0
            exit_mid_price = 0.0
            exit_code = 0

            for step in range(n_steps):
                if use_1m:
                    idx_1m = s_base + step
                    c_high = m1_high[idx_1m]
                    c_low = m1_low[idx_1m]
                    c_close = m1_close[idx_1m]
                    c_open = open_p[i] if step == 0 else m1_close[idx_1m - 1]
                else:
                    c_open = open_p[i]
                    c_high = high_p[i]
                    c_low = low_p[i]
                    c_close = close_p[i]

                bid_open = c_open - 0.5 * eff_sp
                bid_high = c_high - 0.5 * eff_sp
                bid_low = c_low - 0.5 * eff_sp
                ask_open = c_open + 0.5 * eff_sp
                ask_high = c_high + 0.5 * eff_sp
                ask_low = c_low + 0.5 * eff_sp

                # Update MAE / MFE
                if pos_dir == 1:
                    adv = entry_fill - bid_low
                    fav = bid_high - entry_fill
                else:
                    adv = ask_high - entry_fill
                    fav = entry_fill - ask_low
                if adv > mae_pts:
                    mae_pts = adv
                if fav > mfe_pts:
                    mfe_pts = fav

                # Check SL & TP hits
                if pos_dir == 1:
                    sl_hit = bid_low <= cur_sl
                    tp_hit = bid_high >= cur_tp
                else:
                    sl_hit = ask_high >= cur_sl
                    tp_hit = ask_low <= cur_tp

                if sl_hit and tp_hit:
                    if intrabar_mode_id == 2:
                        # Bar-path heuristic: bullish bar visits Low before High
                        bullish = c_close >= c_open
                        if (pos_dir == 1 and bullish) or (pos_dir == -1 and (not bullish)):
                            tp_hit = False
                        else:
                            sl_hit = False
                    else:
                        # Pessimistic SL-first (default & 1m tie-breaker)
                        tp_hit = False

                if sl_hit:
                    exit_triggered = True
                    exit_code = sl_reason
                    if pos_dir == 1:
                        raw_stop = cur_sl if step > 0 or i > entry_bar else min(bid_open, cur_sl)
                        if i > entry_bar and step == 0 and bid_open < cur_sl:
                            raw_stop = bid_open
                        exit_fill_price = raw_stop - slippage_pts
                        exit_mid_price = exit_fill_price + 0.5 * eff_sp + slippage_pts
                    else:
                        raw_stop = cur_sl if step > 0 or i > entry_bar else max(ask_open, cur_sl)
                        if i > entry_bar and step == 0 and ask_open > cur_sl:
                            raw_stop = ask_open
                        exit_fill_price = raw_stop + slippage_pts
                        exit_mid_price = exit_fill_price - 0.5 * eff_sp - slippage_pts
                    break

                if tp_hit:
                    exit_triggered = True
                    exit_code = 1  # TP
                    if pos_dir == 1:
                        exit_fill_price = max(bid_open, cur_tp) if (i > entry_bar and step == 0) else cur_tp
                        exit_mid_price = exit_fill_price + 0.5 * eff_sp
                    else:
                        exit_fill_price = min(ask_open, cur_tp) if (i > entry_bar and step == 0) else cur_tp
                        exit_mid_price = exit_fill_price - 0.5 * eff_sp
                    break

                # Check Partial TP (TP1), Break-Even, and Trailing Stop if position survives this step
                if partial_tp_enabled and (not partial_done) and partial_tp_pct > 0.0 and partial_tp_pct < 1.0:
                    p_dist = sl_dist * partial_tp_rr
                    if pos_dir == 1:
                        p_price = entry_fill + p_dist
                        if bid_high >= p_price:
                            p_qty = np.floor(init_qty * partial_tp_pct)
                            if p_qty < 1.0:
                                p_qty = init_qty * partial_tp_pct
                            if p_qty > 0.0 and p_qty < rem_qty:
                                p_mid = p_price + 0.5 * eff_sp
                                g_leg = (p_mid - entry_mid) * point_value * p_qty
                                c_leg = commission_per_side * 2.0 * p_qty
                                n_leg = (p_price - entry_fill) * point_value * p_qty - c_leg
                                realized_gross_pnl += g_leg
                                realized_net_pnl += n_leg
                                realized_friction += g_leg - n_leg
                                rem_qty -= p_qty
                                partial_done = True
                                if move_sl_to_be_on_partial:
                                    be_lvl = entry_fill + breakeven_offset_pts
                                    if be_lvl > cur_sl:
                                        cur_sl = be_lvl
                                        sl_reason = 3
                                        be_done = True
                    else:
                        p_price = entry_fill - p_dist
                        if ask_low <= p_price:
                            p_qty = np.floor(init_qty * partial_tp_pct)
                            if p_qty < 1.0:
                                p_qty = init_qty * partial_tp_pct
                            if p_qty > 0.0 and p_qty < rem_qty:
                                p_mid = p_price - 0.5 * eff_sp
                                g_leg = (entry_mid - p_mid) * point_value * p_qty
                                c_leg = commission_per_side * 2.0 * p_qty
                                n_leg = (entry_fill - p_price) * point_value * p_qty - c_leg
                                realized_gross_pnl += g_leg
                                realized_net_pnl += n_leg
                                realized_friction += g_leg - n_leg
                                rem_qty -= p_qty
                                partial_done = True
                                if move_sl_to_be_on_partial:
                                    be_lvl = entry_fill - breakeven_offset_pts
                                    if be_lvl < cur_sl:
                                        cur_sl = be_lvl
                                        sl_reason = 3
                                        be_done = True

                # Break-even trigger
                if breakeven_enabled and (not be_done):
                    be_trig = sl_dist * breakeven_trigger_rr
                    if pos_dir == 1 and (bid_high - entry_fill) >= be_trig:
                        be_lvl = entry_fill + breakeven_offset_pts
                        if be_lvl > cur_sl:
                            cur_sl = be_lvl
                            sl_reason = 3  # BE
                        be_done = True
                    elif pos_dir == -1 and (entry_fill - ask_low) >= be_trig:
                        be_lvl = entry_fill - breakeven_offset_pts
                        if be_lvl < cur_sl:
                            cur_sl = be_lvl
                            sl_reason = 3  # BE
                        be_done = True

                # Trailing stop update
                if trailing_enabled:
                    tr_act = sl_dist * trailing_activation_rr
                    if pos_dir == 1 and (bid_high - entry_fill) >= tr_act:
                        cand_sl = bid_high - trailing_distance_pts
                        if cand_sl > cur_sl:
                            cur_sl = cand_sl
                            sl_reason = 4  # TRAIL
                    elif pos_dir == -1 and (entry_fill - ask_low) >= tr_act:
                        cand_sl = ask_low + trailing_distance_pts
                        if cand_sl < cur_sl:
                            cur_sl = cand_sl
                            sl_reason = 4  # TRAIL

            # End-of-bar checks (Session Flatten / Time Stop / Data End) if not exited intrabar
            if not exit_triggered:
                bars_held_now = i - entry_bar + 1
                if flatten_min >= 0 and minute >= flatten_min:
                    exit_triggered = True
                    exit_code = 6  # SESSION_FLATTEN
                elif max_bars_in_trade > 0 and bars_held_now >= max_bars_in_trade:
                    exit_triggered = True
                    exit_code = 5  # TIME_STOP
                elif i == n - 1:
                    exit_triggered = True
                    exit_code = 8  # DATA_END

                if exit_triggered:
                    exit_mid_price = close_p[i]
                    if pos_dir == 1:
                        exit_fill_price = exit_mid_price - 0.5 * eff_sp - slippage_pts
                    else:
                        exit_fill_price = exit_mid_price + 0.5 * eff_sp + slippage_pts

            if exit_triggered:
                if pos_dir == 1:
                    leg_gross_pts = exit_mid_price - entry_mid
                    leg_net_pts = exit_fill_price - entry_fill
                else:
                    leg_gross_pts = entry_mid - exit_mid_price
                    leg_net_pts = entry_fill - exit_fill_price

                leg_gross = leg_gross_pts * point_value * rem_qty
                comm = commission_per_side * 2.0 * rem_qty
                leg_net = leg_net_pts * point_value * rem_qty - comm
                leg_fric = leg_gross - leg_net

                tot_gross = realized_gross_pnl + leg_gross
                tot_net = realized_net_pnl + leg_net
                tot_fric = realized_friction + leg_fric
                init_risk_usd = max(1e-9, sl_dist * point_value * init_qty)

                if t_idx < max_cap:
                    trades[t_idx, 0] = pos_dir
                    trades[t_idx, 1] = entry_bar
                    trades[t_idx, 2] = i
                    trades[t_idx, 3] = ts[entry_bar]
                    trades[t_idx, 4] = ts[i]
                    trades[t_idx, 5] = entry_fill
                    trades[t_idx, 6] = exit_fill_price
                    trades[t_idx, 7] = initial_sl
                    trades[t_idx, 8] = cur_tp
                    trades[t_idx, 9] = init_qty
                    trades[t_idx, 10] = tot_gross / (point_value * init_qty)
                    trades[t_idx, 11] = tot_net / (point_value * init_qty)
                    trades[t_idx, 12] = tot_gross
                    trades[t_idx, 13] = tot_fric
                    trades[t_idx, 14] = tot_net
                    trades[t_idx, 15] = tot_net / init_risk_usd
                    trades[t_idx, 16] = mae_pts
                    trades[t_idx, 17] = mfe_pts
                    trades[t_idx, 18] = exit_code
                    trades[t_idx, 19] = 1.0 if partial_done else 0.0
                    t_idx += 1

                equity += tot_net
                gross_equity += tot_gross
                daily_pnl += tot_net
                if (daily_max_loss_usd > 0.0 and daily_pnl <= -daily_max_loss_usd) or (
                    daily_profit_target_usd > 0.0 and daily_pnl >= daily_profit_target_usd
                ):
                    day_halted = True

                in_pos = False
                cooldown_until = i + cooldown_bars + 1

        # Mark-to-market equity curve at bar close
        if in_pos:
            mtm_mid = close_p[i]
            if pos_dir == 1:
                unr_gross = (mtm_mid - entry_mid) * point_value * rem_qty
                unr_net = (mtm_mid - 0.5 * eff_sp - entry_fill) * point_value * rem_qty
            else:
                unr_gross = (entry_mid - mtm_mid) * point_value * rem_qty
                unr_net = (entry_fill - (mtm_mid + 0.5 * eff_sp)) * point_value * rem_qty
            net_eq[i] = equity + realized_net_pnl + unr_net
            gross_eq[i] = gross_equity + realized_gross_pnl + unr_gross
        else:
            net_eq[i] = equity
            gross_eq[i] = gross_equity

    return trades[:t_idx], net_eq, gross_eq, t_idx


def run_simulation(
    df_5m: pl.DataFrame,
    signal: np.ndarray,
    strat_sl: np.ndarray | None,
    strat_tp: np.ndarray | None,
    exec_cfg: ExecutionConfig,
    subbars_tuple: tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray] | None = None,
    build_trade_objects: bool = True,
) -> dict[str, Any]:
    """
    High-level wrapper around `_run_scalp_loop_njit` converting Polars DataFrame & ExecutionConfig
    into contiguous NumPy arrays and returning raw arrays + structured TradeRecords.
    """
    t0 = time.perf_counter()
    n = df_5m.height
    if n < 5:
        return {
            "trades_raw": np.empty((0, 20), dtype=np.float64),
            "trades": [],
            "net_equity": np.array([exec_cfg.initial_capital]),
            "gross_equity": np.array([exec_cfg.initial_capital]),
            "elapsed_ms": 0.0,
        }

    ts = np.ascontiguousarray(df_5m["ts"].to_numpy(), dtype=np.int64)
    open_p = np.ascontiguousarray(df_5m["open"].to_numpy(), dtype=np.float64)
    high_p = np.ascontiguousarray(df_5m["high"].to_numpy(), dtype=np.float64)
    low_p = np.ascontiguousarray(df_5m["low"].to_numpy(), dtype=np.float64)
    close_p = np.ascontiguousarray(df_5m["close"].to_numpy(), dtype=np.float64)
    spread_arr = np.ascontiguousarray(df_5m["spread"].to_numpy(), dtype=np.float64)
    et_day_id = np.ascontiguousarray(df_5m["et_day_id"].to_numpy(), dtype=np.int64)
    et_minute = np.ascontiguousarray(df_5m["et_minute"].to_numpy(), dtype=np.int64)

    atr_arr = calc_atr(high_p, low_p, close_p, 14)

    sig_arr = np.ascontiguousarray(signal, dtype=np.int64)
    sl_arr = (
        np.ascontiguousarray(strat_sl, dtype=np.float64)
        if strat_sl is not None
        else np.full(n, np.nan, dtype=np.float64)
    )
    tp_arr = (
        np.ascontiguousarray(strat_tp, dtype=np.float64)
        if strat_tp is not None
        else np.full(n, np.nan, dtype=np.float64)
    )

    if subbars_tuple is not None and exec_cfg.intrabar_mode == "subbar_1m":
        has_subbars = True
        sub_start, sub_count, m1_high, m1_low, m1_close = subbars_tuple
    else:
        has_subbars = False
        sub_start = np.empty(0, dtype=np.int64)
        sub_count = np.empty(0, dtype=np.int64)
        m1_high = np.empty(0, dtype=np.float64)
        m1_low = np.empty(0, dtype=np.float64)
        m1_close = np.empty(0, dtype=np.float64)

    sizing_map = {"fixed_contracts": 0, "risk_pct": 1, "fixed_dollar_risk": 2}
    intrabar_map = {"subbar_1m": 0, "pessimistic_sl_first": 1, "bar_path_heuristic": 2}
    sl_map = {"strategy_or_atr": 0, "fixed_pts": 1, "atr_mult": 2}
    tp_map = {"rr_multiple": 0, "fixed_pts": 1, "atr_mult": 2, "strategy_target": 3}

    entry_start_min = parse_hhmm_to_min(exec_cfg.entry_start_et)
    entry_end_min = parse_hhmm_to_min(exec_cfg.entry_end_et)
    if entry_start_min < 0:
        entry_start_min = 0
    if entry_end_min < 0:
        entry_end_min = 1439
    flatten_min = parse_hhmm_to_min(exec_cfg.flatten_et)

    trades_raw, net_eq, gross_eq, count = _run_scalp_loop_njit(
        ts=ts,
        open_p=open_p,
        high_p=high_p,
        low_p=low_p,
        close_p=close_p,
        spread_arr=spread_arr,
        et_day_id=et_day_id,
        et_minute=et_minute,
        atr_arr=atr_arr,
        signal=sig_arr,
        strat_sl=sl_arr,
        strat_tp=tp_arr,
        has_subbars=has_subbars,
        sub_start=sub_start,
        sub_count=sub_count,
        m1_high=m1_high,
        m1_low=m1_low,
        m1_close=m1_close,
        initial_capital=float(exec_cfg.initial_capital),
        point_value=float(exec_cfg.point_value),
        tick_size=float(exec_cfg.tick_size),
        cfg_contracts=float(exec_cfg.contracts),
        sizing_mode_id=sizing_map[exec_cfg.sizing_mode],
        risk_pct=float(exec_cfg.risk_per_trade_pct),
        risk_usd_fixed=float(exec_cfg.risk_per_trade_usd),
        use_dataset_spread=bool(exec_cfg.use_dataset_spread),
        cfg_spread_pts=float(exec_cfg.spread_pts),
        slippage_pts=float(exec_cfg.slippage_pts),
        commission_per_side=float(exec_cfg.commission_per_side),
        intrabar_mode_id=intrabar_map[exec_cfg.intrabar_mode],
        sl_mode_id=sl_map[exec_cfg.sl_mode],
        sl_pts=float(exec_cfg.sl_pts),
        sl_atr_mult=float(exec_cfg.sl_atr_mult),
        tp_mode_id=tp_map[exec_cfg.tp_mode],
        tp_rr=float(exec_cfg.tp_rr),
        tp_pts=float(exec_cfg.tp_pts),
        tp_atr_mult=float(exec_cfg.tp_atr_mult),
        partial_tp_enabled=bool(exec_cfg.partial_tp_enabled),
        partial_tp_rr=float(exec_cfg.partial_tp_rr),
        partial_tp_pct=float(exec_cfg.partial_tp_pct),
        move_sl_to_be_on_partial=bool(exec_cfg.move_sl_to_be_on_partial),
        breakeven_enabled=bool(exec_cfg.breakeven_enabled),
        breakeven_trigger_rr=float(exec_cfg.breakeven_trigger_rr),
        breakeven_offset_pts=float(exec_cfg.breakeven_offset_pts),
        trailing_enabled=bool(exec_cfg.trailing_stop_enabled),
        trailing_activation_rr=float(exec_cfg.trailing_activation_rr),
        trailing_distance_pts=float(exec_cfg.trailing_distance_pts),
        max_bars_in_trade=int(exec_cfg.max_bars_in_trade),
        allow_long=bool(exec_cfg.allow_long),
        allow_short=bool(exec_cfg.allow_short),
        reverse_on_opposite=bool(exec_cfg.reverse_on_opposite_signal),
        cooldown_bars=int(exec_cfg.cooldown_bars),
        use_session_filter=bool(exec_cfg.use_session_filter),
        entry_start_min=entry_start_min,
        entry_end_min=entry_end_min,
        flatten_min=flatten_min,
        max_trades_per_day=int(exec_cfg.max_trades_per_day),
        daily_max_loss_usd=float(exec_cfg.daily_max_loss_usd),
        daily_profit_target_usd=float(exec_cfg.daily_profit_target_usd),
    )

    elapsed_ms = round((time.perf_counter() - t0) * 1000.0, 2)

    trade_records: list[TradeRecord] = []
    if build_trade_objects and count > 0:
        et_strs = df_5m["et_str"].to_list()
        for k in range(count):
            row = trades_raw[k]
            eb = int(row[1])
            xb = int(row[2])
            e_ts = int(row[3])
            x_ts = int(row[4])
            hold_mins = max(5, int(round((x_ts - e_ts) / 60.0)) + 5)
            trade_records.append(
                TradeRecord(
                    id=k + 1,
                    direction="LONG" if row[0] > 0 else "SHORT",
                    entry_bar_idx=eb,
                    exit_bar_idx=xb,
                    entry_ts=e_ts,
                    exit_ts=x_ts,
                    entry_et=et_strs[eb],
                    exit_et=et_strs[xb],
                    entry_price=round(float(row[5]), 2),
                    exit_price=round(float(row[6]), 2),
                    initial_sl=round(float(row[7]), 2),
                    initial_tp=round(float(row[8]), 2),
                    contracts=round(float(row[9]), 2),
                    gross_pts=round(float(row[10]), 2),
                    net_pts=round(float(row[11]), 2),
                    gross_pnl=round(float(row[12]), 2),
                    friction_cost=round(float(row[13]), 2),
                    net_pnl=round(float(row[14]), 2),
                    r_multiple=round(float(row[15]), 2),
                    mae_pts=round(float(row[16]), 2),
                    mfe_pts=round(float(row[17]), 2),
                    bars_held=xb - eb + 1,
                    hold_minutes=hold_mins,
                    exit_reason=EXIT_REASON_NAMES.get(int(row[18]), "OTHER"),
                    partial_taken=bool(row[19] > 0.5),
                )
            )

    return {
        "trades_raw": trades_raw,
        "trades": trade_records,
        "net_equity": net_eq,
        "gross_equity": gross_eq,
        "elapsed_ms": elapsed_ms,
    }
