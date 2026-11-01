from __future__ import annotations

from datetime import datetime, timezone
import time
from typing import Any

import polars as pl

from app.data.store import build_subbar_1m_lookup, load_dataset_df
from app.engine.analytics import compute_fast_summary
from app.engine.simulator import run_simulation
from app.models import OptimizeRequest
from app.strategies.registry import compute_strategy_signals


def run_grid_optimization(req: OptimizeRequest) -> dict[str, Any]:
    """
    2D Parameter Grid Sweep across 5–10 years of 5-minute data,
    with optional Walk-Forward Train/Test (`split_date`) Out-of-Sample validation!
    """
    t0 = time.perf_counter()
    df_5m = load_dataset_df(req.dataset_id, "5m", req.start_date, req.end_date)
    if df_5m.height < 20:
        raise ValueError("Selected date range has fewer than 20 bars.")

    subbars_full = None
    df_1m: pl.DataFrame | None = None
    if req.execution.intrabar_mode == "subbar_1m":
        try:
            df_1m = load_dataset_df(req.dataset_id, "1m", req.start_date, req.end_date)
            subbars_full = build_subbar_1m_lookup(df_5m, df_1m)
        except FileNotFoundError:
            subbars_full = None

    split_ts: int | None = None
    df_train: pl.DataFrame | None = None
    df_test: pl.DataFrame | None = None
    sub_train = None
    sub_test = None
    if req.split_date:
        split_ts = int(
            datetime.strptime(req.split_date[:10], "%Y-%m-%d")
            .replace(hour=23, minute=59, second=59, tzinfo=timezone.utc)
            .timestamp()
        )
        df_train = df_5m.filter(pl.col("ts") <= split_ts)
        df_test = df_5m.filter(pl.col("ts") > split_ts)
        if df_1m is not None:
            if df_train.height > 0:
                sub_train = build_subbar_1m_lookup(df_train, df_1m)
            if df_test.height > 0:
                sub_test = build_subbar_1m_lookup(df_test, df_1m)

    x_vals = req.axis_x.values[:15]  # cap 15x15 = 225 combos max per interactive sweep
    y_vals = req.axis_y.values[:15]

    # Cache strategy signals by strategy param signature so execution-only sweeps don't recompute indicators!
    sig_cache: dict[tuple[tuple[str, Any], ...], tuple[Any, Any, Any]] = {}

    def _get_signals(df_target: pl.DataFrame, s_params: dict[str, Any], tag: str) -> tuple[Any, Any, Any]:
        key = ((tag, df_target.height),) + tuple(sorted(s_params.items()))
        if key not in sig_cache:
            res = compute_strategy_signals(req.strategy_id, df_target, s_params, include_overlays=False)
            sig_cache[key] = (res["signal"], res["stop_price"], res["target_price"])
        return sig_cache[key]

    cells: list[dict[str, Any]] = []
    for yv in y_vals:
        for xv in x_vals:
            s_params = dict(req.strategy_params)
            exec_dict = req.execution.model_dump()

            for axis, val in ((req.axis_x, xv), (req.axis_y, yv)):
                # Preserve integer type if value is whole and parameter originally int
                clean_val: Any = int(round(val)) if abs(val - round(val)) < 1e-9 else float(val)
                if axis.target == "strategy":
                    s_params[axis.name] = clean_val
                else:
                    exec_dict[axis.name] = val if isinstance(exec_dict.get(axis.name), float) else clean_val

            exec_cfg = req.execution.__class__(**exec_dict)

            sig, sl_p, tp_p = _get_signals(df_5m, s_params, "full")
            sim_full = run_simulation(df_5m, sig, sl_p, tp_p, exec_cfg, subbars_full, build_trade_objects=False)
            summary_full = compute_fast_summary(
                sim_full["trades_raw"], sim_full["net_equity"], exec_cfg.initial_capital
            )

            cell: dict[str, Any] = {
                "x": xv,
                "y": yv,
                "full": summary_full,
            }

            if df_train is not None and df_test is not None and df_train.height > 10 and df_test.height > 10:
                sig_tr, sl_tr, tp_tr = _get_signals(df_train, s_params, "train")
                sim_tr = run_simulation(df_train, sig_tr, sl_tr, tp_tr, exec_cfg, sub_train, build_trade_objects=False)
                cell["in_sample"] = compute_fast_summary(
                    sim_tr["trades_raw"], sim_tr["net_equity"], exec_cfg.initial_capital
                )

                sig_te, sl_te, tp_te = _get_signals(df_test, s_params, "test")
                sim_te = run_simulation(df_test, sig_te, sl_te, tp_te, exec_cfg, sub_test, build_trade_objects=False)
                cell["out_of_sample"] = compute_fast_summary(
                    sim_te["trades_raw"], sim_te["net_equity"], exec_cfg.initial_capital
                )

            cells.append(cell)

    metric = req.ranking_metric
    ranked = sorted(
        cells,
        key=lambda c: c.get("in_sample", c["full"]).get(metric if metric != "expectancy_r" else "expectancy_r", 0.0),
        reverse=True,
    )

    elapsed_ms = round((time.perf_counter() - t0) * 1000.0, 1)
    return {
        "axis_x": req.axis_x.model_dump(),
        "axis_y": req.axis_y.model_dump(),
        "ranking_metric": metric,
        "split_date": req.split_date,
        "total_combinations": len(cells),
        "elapsed_ms": elapsed_ms,
        "cells": cells,
        "top_combinations": ranked[:10],
    }
