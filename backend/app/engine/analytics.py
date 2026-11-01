from __future__ import annotations

from typing import Any

import numpy as np
import polars as pl

from app.engine.simulator import EXIT_REASON_NAMES

DOW_LABELS = {1: "Mon", 2: "Tue", 3: "Wed", 4: "Thu", 5: "Fri", 6: "Sat", 7: "Sun"}


def compute_fast_summary(trades_raw: np.ndarray, net_eq: np.ndarray, initial_capital: float) -> dict[str, float]:
    """Lightweight KPI summary used inside tight 2D parameter optimization loops."""
    n_trades = trades_raw.shape[0]
    if n_trades == 0:
        return {
            "total_trades": 0,
            "net_pnl": 0.0,
            "net_return_pct": 0.0,
            "profit_factor": 0.0,
            "win_rate_pct": 0.0,
            "expectancy_r": 0.0,
            "max_drawdown_pct": 0.0,
            "sharpe": 0.0,
            "calmar": 0.0,
        }

    net_pnls = trades_raw[:, 14]
    r_mults = trades_raw[:, 15]
    wins = net_pnls[net_pnls > 0.0]
    losses = net_pnls[net_pnls < 0.0]

    sum_wins = float(np.sum(wins)) if len(wins) else 0.0
    sum_losses = float(np.abs(np.sum(losses))) if len(losses) else 0.0
    pf = (sum_wins / sum_losses) if sum_losses > 1e-9 else (99.0 if sum_wins > 0 else 0.0)

    total_net = float(np.sum(net_pnls))
    win_rate = 100.0 * len(wins) / n_trades
    exp_r = float(np.mean(r_mults))

    peaks = np.maximum.accumulate(np.maximum(net_eq, initial_capital))
    dd_pct_arr = (peaks - net_eq) / np.maximum(peaks, 1.0) * 100.0
    max_dd_pct = float(np.max(dd_pct_arr)) if len(dd_pct_arr) else 0.0

    # Trade-level annualized Sharpe approximation (~252 trading days)
    std_pnl = float(np.std(net_pnls))
    sharpe = float((np.mean(net_pnls) / std_pnl) * np.sqrt(min(n_trades, 500))) if std_pnl > 1e-9 else 0.0
    ret_pct = 100.0 * total_net / max(initial_capital, 1.0)
    calmar = (ret_pct / max_dd_pct) if max_dd_pct > 0.05 else (ret_pct if ret_pct > 0 else 0.0)

    return {
        "total_trades": int(n_trades),
        "net_pnl": round(total_net, 2),
        "net_return_pct": round(ret_pct, 2),
        "profit_factor": round(min(pf, 99.99), 2),
        "win_rate_pct": round(win_rate, 1),
        "expectancy_r": round(exp_r, 3),
        "max_drawdown_pct": round(max_dd_pct, 2),
        "sharpe": round(sharpe, 2),
        "calmar": round(calmar, 2),
    }


def compute_full_analytics(
    df_5m: pl.DataFrame,
    trades_raw: np.ndarray,
    net_eq: np.ndarray,
    gross_eq: np.ndarray,
    initial_capital: float,
) -> dict[str, Any]:
    """Compute institutional scalping diagnostics across 5–10 years of 5-minute bars."""
    n_bars = df_5m.height
    n_trades = trades_raw.shape[0]
    ts_arr = df_5m["ts"].to_numpy()
    et_day_arr = df_5m["et_day_id"].to_numpy()
    et_min_arr = df_5m["et_minute"].to_numpy()
    et_dow_arr = df_5m["et_dow"].to_numpy()
    et_year_arr = df_5m["et_year"].to_numpy()
    et_month_arr = df_5m["et_month"].to_numpy()

    peaks = np.maximum.accumulate(np.maximum(net_eq, initial_capital))
    dd_usd_arr = peaks - net_eq
    dd_pct_arr = (dd_usd_arr / np.maximum(peaks, 1.0)) * 100.0
    max_dd_usd = float(np.max(dd_usd_arr)) if len(dd_usd_arr) else 0.0
    max_dd_pct = float(np.max(dd_pct_arr)) if len(dd_pct_arr) else 0.0

    # Downsample equity & drawdown curve to <= 850 points (preserving exact peaks/troughs + start/end)
    max_pts = 850
    if n_bars <= max_pts:
        idxs = np.arange(n_bars)
    else:
        idxs = np.unique(np.linspace(0, n_bars - 1, max_pts, dtype=np.int64))
    equity_curve = [
        {
            "time": int(ts_arr[idx]),
            "net_equity": round(float(net_eq[idx]), 2),
            "gross_equity": round(float(gross_eq[idx]), 2),
            "drawdown_pct": round(-float(dd_pct_arr[idx]), 2),
            "drawdown_usd": round(-float(dd_usd_arr[idx]), 2),
        }
        for idx in idxs
    ]

    if n_trades == 0:
        return {
            "kpis": {
                "total_trades": 0,
                "net_pnl": 0.0,
                "net_return_pct": 0.0,
                "gross_pnl": 0.0,
                "total_friction_cost": 0.0,
                "profit_factor": 0.0,
                "win_rate_pct": 0.0,
                "expectancy_usd": 0.0,
                "expectancy_r": 0.0,
                "avg_win_usd": 0.0,
                "avg_loss_usd": 0.0,
                "payoff_ratio": 0.0,
                "max_drawdown_usd": 0.0,
                "max_drawdown_pct": 0.0,
                "sharpe_ratio": 0.0,
                "sortino_ratio": 0.0,
                "calmar_ratio": 0.0,
                "avg_hold_minutes": 0.0,
                "max_consec_wins": 0,
                "max_consec_losses": 0,
                "long_trades": 0,
                "short_trades": 0,
                "long_win_rate_pct": 0.0,
                "short_win_rate_pct": 0.0,
                "long_net_pnl": 0.0,
                "short_net_pnl": 0.0,
            },
            "equity_curve": equity_curve,
            "time_of_day": [],
            "day_of_week": [],
            "monthly_matrix": [],
            "exit_reasons": [],
            "r_distribution": [],
            "mae_mfe_scatter": [],
        }

    dirs = trades_raw[:, 0]
    entry_bars = trades_raw[:, 1].astype(np.int64)
    exit_bars = trades_raw[:, 2].astype(np.int64)
    gross_pnls = trades_raw[:, 12]
    frictions = trades_raw[:, 13]
    net_pnls = trades_raw[:, 14]
    r_mults = trades_raw[:, 15]
    maes = trades_raw[:, 16]
    mfes = trades_raw[:, 17]
    exit_codes = trades_raw[:, 18].astype(np.int64)

    wins_mask = net_pnls > 0.0
    losses_mask = net_pnls < 0.0
    wins = net_pnls[wins_mask]
    losses = net_pnls[losses_mask]

    sum_wins = float(np.sum(wins)) if len(wins) else 0.0
    sum_losses = float(np.abs(np.sum(losses))) if len(losses) else 0.0
    pf = (sum_wins / sum_losses) if sum_losses > 1e-9 else (99.99 if sum_wins > 0 else 0.0)

    avg_win = float(np.mean(wins)) if len(wins) else 0.0
    avg_loss = float(np.mean(losses)) if len(losses) else 0.0
    payoff = (avg_win / abs(avg_loss)) if abs(avg_loss) > 1e-9 else 0.0

    # Daily returns from end-of-day equity for genuine annualized Sharpe & Sortino
    df_daily_eq = (
        pl.DataFrame({"day": et_day_arr, "eq": net_eq})
        .group_by("day", maintain_order=True)
        .agg(pl.col("eq").last().alias("eod_eq"))
    )
    eod_vals = df_daily_eq["eod_eq"].to_numpy()
    prev_vals = np.empty_like(eod_vals)
    prev_vals[0] = initial_capital
    prev_vals[1:] = eod_vals[:-1]
    daily_rets = (eod_vals - prev_vals) / np.maximum(prev_vals, 1.0)

    mean_d = float(np.mean(daily_rets))
    std_d = float(np.std(daily_rets))
    downside = daily_rets[daily_rets < 0.0]
    down_std = float(np.sqrt(np.mean(downside * downside))) if len(downside) > 0 else 0.0

    sharpe = (mean_d / std_d) * np.sqrt(252.0) if std_d > 1e-12 else 0.0
    sortino = (mean_d / down_std) * np.sqrt(252.0) if down_std > 1e-12 else 0.0

    years_span = max((ts_arr[-1] - ts_arr[0]) / (365.25 * 86400.0), 1.0 / 12.0)
    total_net = float(np.sum(net_pnls))
    net_ret_pct = 100.0 * total_net / max(initial_capital, 1.0)
    ann_ret_pct = net_ret_pct / years_span
    calmar = (ann_ret_pct / max_dd_pct) if max_dd_pct > 0.05 else 0.0

    # Consecutive streaks
    max_cw = 0
    max_cl = 0
    cw = 0
    cl = 0
    for pnl in net_pnls:
        if pnl > 0:
            cw += 1
            cl = 0
            if cw > max_cw:
                max_cw = cw
        elif pnl < 0:
            cl += 1
            cw = 0
            if cl > max_cl:
                max_cl = cl

    hold_mins_arr = np.maximum(5.0, (trades_raw[:, 4] - trades_raw[:, 3]) / 60.0 + 5.0)

    long_mask = dirs > 0
    short_mask = dirs < 0
    n_long = int(np.sum(long_mask))
    n_short = int(np.sum(short_mask))
    long_wr = 100.0 * float(np.sum(net_pnls[long_mask] > 0)) / n_long if n_long else 0.0
    short_wr = 100.0 * float(np.sum(net_pnls[short_mask] > 0)) / n_short if n_short else 0.0

    kpis = {
        "total_trades": int(n_trades),
        "net_pnl": round(total_net, 2),
        "net_return_pct": round(net_ret_pct, 2),
        "gross_pnl": round(float(np.sum(gross_pnls)), 2),
        "total_friction_cost": round(float(np.sum(frictions)), 2),
        "profit_factor": round(min(pf, 99.99), 2),
        "win_rate_pct": round(100.0 * len(wins) / n_trades, 2),
        "expectancy_usd": round(float(np.mean(net_pnls)), 2),
        "expectancy_r": round(float(np.mean(r_mults)), 3),
        "avg_win_usd": round(avg_win, 2),
        "avg_loss_usd": round(avg_loss, 2),
        "payoff_ratio": round(payoff, 2),
        "max_drawdown_usd": round(max_dd_usd, 2),
        "max_drawdown_pct": round(max_dd_pct, 2),
        "sharpe_ratio": round(float(sharpe), 2),
        "sortino_ratio": round(float(sortino), 2),
        "calmar_ratio": round(float(calmar), 2),
        "avg_hold_minutes": round(float(np.mean(hold_mins_arr)), 1),
        "max_consec_wins": int(max_cw),
        "max_consec_losses": int(max_cl),
        "long_trades": n_long,
        "short_trades": n_short,
        "long_win_rate_pct": round(long_wr, 1),
        "short_win_rate_pct": round(short_wr, 1),
        "long_net_pnl": round(float(np.sum(net_pnls[long_mask])), 2),
        "short_net_pnl": round(float(np.sum(net_pnls[short_mask])), 2),
    }

    # 1. Time-of-Day (ET 30-min bucket) analysis
    entry_et_mins = et_min_arr[entry_bars]
    buckets_30m = (entry_et_mins // 30) * 30
    tod_list: list[dict[str, Any]] = []
    for b in sorted(set(buckets_30m.tolist())):
        mask = buckets_30m == b
        cnt = int(np.sum(mask))
        sub_pnl = net_pnls[mask]
        hh = b // 60
        mm = b % 60
        tod_list.append(
            {
                "slot": f"{hh:02d}:{mm:02d}",
                "trades": cnt,
                "net_pnl": round(float(np.sum(sub_pnl)), 2),
                "win_rate_pct": round(100.0 * float(np.sum(sub_pnl > 0)) / cnt, 1),
                "avg_r": round(float(np.mean(r_mults[mask])), 2),
            }
        )

    # 2. Day-of-Week analysis
    entry_dows = et_dow_arr[entry_bars]
    dow_list: list[dict[str, Any]] = []
    for d_num in range(1, 6):
        mask = entry_dows == d_num
        cnt = int(np.sum(mask))
        sub_pnl = net_pnls[mask] if cnt > 0 else np.empty(0)
        dow_list.append(
            {
                "day": DOW_LABELS[d_num],
                "trades": cnt,
                "net_pnl": round(float(np.sum(sub_pnl)), 2) if cnt else 0.0,
                "win_rate_pct": round(100.0 * float(np.sum(sub_pnl > 0)) / cnt, 1) if cnt else 0.0,
            }
        )

    # 3. Year x Month PnL & % matrix
    exit_years = et_year_arr[exit_bars]
    exit_months = et_month_arr[exit_bars]
    years_unique = sorted(set(et_year_arr.tolist()))
    monthly_matrix: list[dict[str, Any]] = []
    for yr in years_unique:
        row_dict: dict[str, Any] = {"year": int(yr), "months": {}, "year_total_usd": 0.0, "year_total_pct": 0.0}
        yr_sum = 0.0
        for mo in range(1, 13):
            m_mask = (exit_years == yr) & (exit_months == mo)
            if np.any(m_mask):
                val = float(np.sum(net_pnls[m_mask]))
                yr_sum += val
                row_dict["months"][str(mo)] = {
                    "usd": round(val, 2),
                    "pct": round(100.0 * val / max(initial_capital, 1.0), 2),
                    "trades": int(np.sum(m_mask)),
                }
            else:
                row_dict["months"][str(mo)] = None
        row_dict["year_total_usd"] = round(yr_sum, 2)
        row_dict["year_total_pct"] = round(100.0 * yr_sum / max(initial_capital, 1.0), 2)
        monthly_matrix.append(row_dict)

    # 4. Exit Reason breakdown
    exit_reasons: list[dict[str, Any]] = []
    for code, name in EXIT_REASON_NAMES.items():
        mask = exit_codes == code
        cnt = int(np.sum(mask))
        if cnt > 0:
            exit_reasons.append(
                {
                    "reason": name,
                    "trades": cnt,
                    "pct_of_trades": round(100.0 * cnt / n_trades, 1),
                    "net_pnl": round(float(np.sum(net_pnls[mask])), 2),
                    "avg_r": round(float(np.mean(r_mults[mask])), 2),
                }
            )
    exit_reasons.sort(key=lambda x: x["trades"], reverse=True)

    # 5. R-Multiple histogram
    bins = [-999.0, -2.0, -1.5, -1.0, -0.5, 0.0, 0.5, 1.0, 1.5, 2.0, 3.0, 999.0]
    labels = ["<-2R", "-2..-1.5R", "-1.5..-1R", "-1..-0.5R", "-0.5..0R", "0..0.5R", "0.5..1R", "1..1.5R", "1.5..2R", "2..3R", ">3R"]
    counts, _ = np.histogram(r_mults, bins=bins)
    r_dist = [{"bucket": lbl, "count": int(c)} for lbl, c in zip(labels, counts)]

    # 6. MAE vs MFE scatter (sampled up to 600 points for crisp UI rendering)
    scatter_step = max(1, n_trades // 600)
    mae_mfe_scatter = [
        {
            "id": int(idx + 1),
            "mae_pts": round(float(maes[idx]), 2),
            "mfe_pts": round(float(mfes[idx]), 2),
            "net_pnl": round(float(net_pnls[idx]), 2),
            "r_multiple": round(float(r_mults[idx]), 2),
            "win": bool(net_pnls[idx] > 0),
        }
        for idx in range(0, n_trades, scatter_step)
    ]

    return {
        "kpis": kpis,
        "equity_curve": equity_curve,
        "time_of_day": tod_list,
        "day_of_week": dow_list,
        "monthly_matrix": monthly_matrix,
        "exit_reasons": exit_reasons,
        "r_distribution": r_dist,
        "mae_mfe_scatter": mae_mfe_scatter,
    }
