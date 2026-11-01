from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from datetime import datetime
import json
import random
import time
import uuid
from pathlib import Path
from typing import Any, AsyncIterator
from zoneinfo import ZoneInfo

import numpy as np
import polars as pl
from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.config import INSTRUMENT_PRESETS, PROJECT_ROOT, SESSION_PRESETS
from app.data.alpaca import download_alpaca_bars
from app.data.dukascopy import download_dukascopy_nas100
from app.data.importer import import_uploaded_file
from app.data.store import (
    build_subbar_1m_lookup,
    delete_dataset,
    list_datasets,
    load_dataset_df,
    query_candles_window,
)
from app.data.synthetic import generate_calibrated_nas100_dataset
from app.engine.analytics import compute_full_analytics
from app.engine.optimizer import run_grid_optimization
from app.engine.simulator import run_simulation
from app.engine.universal_suite import (
    build_replay_pane_payload,
    compute_mtf_right_candles,
    resample_bars_upto,
)
from app.models import (
    AlpacaDownloadRequest,
    BacktestRequest,
    CustomStrategySaveRequest,
    DownloadJobStatus,
    DukascopyDownloadRequest,
    OptimizeRequest,
    ReplayFrameRequest,
    SyntheticGenerateRequest,
)
from app.strategies.registry import (
    CUSTOM_STRATEGY_TEMPLATE,
    compute_strategy_signals,
    delete_custom_strategy,
    list_all_strategies,
    save_custom_strategy,
)

@asynccontextmanager
async def _lifespan(_: FastAPI) -> AsyncIterator[None]:
    if not list_datasets():
        generate_calibrated_nas100_dataset(years=8, end_date="2026-10-30", seed=42, include_1m=True)
    yield


app = FastAPI(
    title="Nasdaq-100 5m Scalping Backtester",
    version="1.0.0",
    lifespan=_lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Background download job tracker
_JOBS: dict[str, DownloadJobStatus] = {}
_JOB_CANCEL_EVENTS: dict[str, asyncio.Event] = {}


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/bootstrap")
def bootstrap() -> dict[str, Any]:
    datasets = list_datasets()
    if not datasets:
        meta = generate_calibrated_nas100_dataset(years=8, end_date="2026-10-30", seed=42, include_1m=True)
        datasets = [meta]
    return {
        "datasets": [d.model_dump() for d in datasets],
        "strategies": [s.model_dump() for s in list_all_strategies()],
        "instrument_presets": INSTRUMENT_PRESETS,
        "session_presets": SESSION_PRESETS,
        "custom_strategy_template": CUSTOM_STRATEGY_TEMPLATE,
    }


@app.get("/api/datasets")
def get_datasets() -> list[dict[str, Any]]:
    return [d.model_dump() for d in list_datasets()]


@app.delete("/api/datasets/{dataset_id}")
def remove_dataset(dataset_id: str) -> dict[str, Any]:
    ok = delete_dataset(dataset_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Dataset not found.")
    return {"deleted": dataset_id, "datasets": [d.model_dump() for d in list_datasets()]}


@app.post("/api/datasets/synthetic")
def create_synthetic_dataset(req: SyntheticGenerateRequest) -> dict[str, Any]:
    meta = generate_calibrated_nas100_dataset(
        years=req.years,
        end_date=req.end_date,
        seed=req.seed,
        include_1m=req.include_1m,
    )
    return {"dataset": meta.model_dump(), "datasets": [d.model_dump() for d in list_datasets()]}


@app.post("/api/datasets/upload")
async def upload_dataset_file(
    file: UploadFile = File(...),
    symbol: str = Form("NAS100"),
    dataset_name: str = Form(""),
    source_tz: str = Form("UTC"),
) -> dict[str, Any]:
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")
    try:
        meta = import_uploaded_file(
            raw_bytes=raw,
            filename=file.filename or "imported_bars.csv",
            symbol=symbol,
            dataset_name=dataset_name.strip() or None,
            source_tz=source_tz,
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"dataset": meta.model_dump(), "datasets": [d.model_dump() for d in list_datasets()]}


@app.post("/api/datasets/dukascopy")
async def start_dukascopy_download(req: DukascopyDownloadRequest) -> dict[str, Any]:
    job_id = str(uuid.uuid4())[:8]
    cancel_ev = asyncio.Event()
    job = DownloadJobStatus(
        job_id=job_id,
        provider="Dukascopy NAS100 (USATECHIDXUSD)",
        status="running",
        progress_pct=1.0,
        message=f"Starting free Dukascopy 1m+5m download ({req.start_date} → {req.end_date})...",
    )
    _JOBS[job_id] = job
    _JOB_CANCEL_EVENTS[job_id] = cancel_ev

    def _on_progress(done: int, total: int, msg: str) -> None:
        j = _JOBS.get(job_id)
        if j:
            j.days_done = done
            j.days_total = total
            j.progress_pct = round(min(99.0, 100.0 * done / max(total, 1)), 1)
            j.message = msg

    async def _runner() -> None:
        try:
            meta = await download_dukascopy_nas100(
                start_date=req.start_date,
                end_date=req.end_date,
                include_ask_spread=req.include_ask_spread,
                dataset_name=req.dataset_name,
                progress_cb=_on_progress,
                cancel_event=cancel_ev,
            )
            j = _JOBS[job_id]
            j.status = "completed"
            j.progress_pct = 100.0
            j.dataset_id = meta.id
            j.message = f"Ready: {meta.bars_5m:,} 5m bars ({meta.bars_1m:,} 1m bars) saved."
        except Exception as exc:
            j = _JOBS[job_id]
            j.status = "cancelled" if cancel_ev.is_set() else "failed"
            j.error = str(exc)
            j.message = str(exc)

    asyncio.create_task(_runner())
    return job.model_dump()


@app.post("/api/datasets/alpaca")
async def start_alpaca_download(req: AlpacaDownloadRequest) -> dict[str, Any]:
    if not req.api_key.strip() or not req.api_secret.strip():
        raise HTTPException(status_code=400, detail="Alpaca API Key and Secret are required.")

    job_id = str(uuid.uuid4())[:8]
    cancel_ev = asyncio.Event()
    job = DownloadJobStatus(
        job_id=job_id,
        provider=f"Alpaca ({req.symbol.upper()})",
        status="running",
        progress_pct=2.0,
        message=f"Connecting to Alpaca Market Data v2 for {req.symbol.upper()}...",
    )
    _JOBS[job_id] = job
    _JOB_CANCEL_EVENTS[job_id] = cancel_ev

    def _on_progress(done: int, total: int, msg: str) -> None:
        j = _JOBS.get(job_id)
        if j:
            j.days_done = done
            j.days_total = total
            j.progress_pct = round(min(95.0, 100.0 * done / max(total, 1)), 1)
            j.message = msg

    async def _runner() -> None:
        try:
            meta = await download_alpaca_bars(
                symbol=req.symbol,
                start_date=req.start_date,
                end_date=req.end_date,
                api_key=req.api_key,
                api_secret=req.api_secret,
                feed=req.feed,
                fetch_1m=req.fetch_1m,
                progress_cb=_on_progress,
                cancel_event=cancel_ev,
            )
            j = _JOBS[job_id]
            j.status = "completed"
            j.progress_pct = 100.0
            j.dataset_id = meta.id
            j.message = f"Ready: {meta.bars_5m:,} 5m bars saved."
        except Exception as exc:
            j = _JOBS[job_id]
            j.status = "cancelled" if cancel_ev.is_set() else "failed"
            j.error = str(exc)
            j.message = str(exc)

    asyncio.create_task(_runner())
    return job.model_dump()


@app.get("/api/jobs")
def list_jobs() -> list[dict[str, Any]]:
    return [j.model_dump() for j in reversed(list(_JOBS.values()))]


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str) -> dict[str, Any]:
    if job_id not in _JOBS:
        raise HTTPException(status_code=404, detail="Job not found.")
    return _JOBS[job_id].model_dump()


@app.post("/api/jobs/{job_id}/cancel")
def cancel_job(job_id: str) -> dict[str, Any]:
    if job_id in _JOB_CANCEL_EVENTS:
        _JOB_CANCEL_EVENTS[job_id].set()
    if job_id not in _JOBS:
        raise HTTPException(status_code=404, detail="Job not found.")
    return _JOBS[job_id].model_dump()


@app.get("/api/candles")
def get_candles(
    dataset_id: str = Query(...),
    center_ts: int | None = Query(None),
    end_ts: int | None = Query(None),
    limit: int = Query(1500, ge=100, le=5000),
    strategy_id: str | None = Query(None),
    strategy_params_json: str | None = Query(None),
) -> dict[str, Any]:
    try:
        win = query_candles_window(dataset_id, center_ts=center_ts, end_ts=end_ts, limit=limit)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    overlays_payload: list[dict[str, Any]] = []
    if strategy_id and win["candles"]:
        try:
            df_full = load_dataset_df(dataset_id, "5m")
            s_idx = max(0, win["window_start_idx"] - 250)  # warmup buffer for EMAs/VWAP
            e_idx = win["window_end_idx"]
            df_slice = df_full.slice(s_idx, e_idx - s_idx)
            s_params = json.loads(strategy_params_json) if strategy_params_json else {}
            sig_out = compute_strategy_signals(strategy_id, df_slice, s_params, include_overlays=True)

            trim = win["window_start_idx"] - s_idx
            ts_win = df_slice["ts"].to_numpy()[trim:]
            for ov_name, ov_meta in sig_out["overlays"].items():
                vals = np.asarray(ov_meta["values"], dtype=np.float64)[trim:]
                pts = [
                    {"time": int(t), "value": round(float(v), 2)}
                    for t, v in zip(ts_win, vals)
                    if not np.isnan(v)
                ]
                overlays_payload.append(
                    {
                        "name": ov_name,
                        "color": ov_meta.get("color", "#38bdf8"),
                        "style": ov_meta.get("style", "solid"),
                        "data": pts,
                    }
                )
        except Exception:
            pass

    win["overlays"] = overlays_payload
    return win


@app.post("/api/backtest")
def execute_backtest(req: BacktestRequest) -> dict[str, Any]:
    t0 = time.perf_counter()
    try:
        df_5m = load_dataset_df(req.dataset_id, "5m", req.start_date, req.end_date)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    if df_5m.height < 20:
        raise HTTPException(status_code=400, detail="Dataset / date range contains fewer than 20 5-minute bars.")

    try:
        sig_out = compute_strategy_signals(req.strategy_id, df_5m, req.strategy_params, include_overlays=False)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Strategy error: {exc}") from exc

    subbars_tuple = None
    used_1m_subbars = False
    if req.execution.intrabar_mode == "subbar_1m":
        try:
            df_1m = load_dataset_df(req.dataset_id, "1m", req.start_date, req.end_date)
            subbars_tuple = build_subbar_1m_lookup(df_5m, df_1m)
            used_1m_subbars = True
        except FileNotFoundError:
            subbars_tuple = None

    sim = run_simulation(
        df_5m=df_5m,
        signal=sig_out["signal"],
        strat_sl=sig_out["stop_price"],
        strat_tp=sig_out["target_price"],
        exec_cfg=req.execution,
        subbars_tuple=subbars_tuple,
        build_trade_objects=True,
    )

    analytics = compute_full_analytics(
        df_5m=df_5m,
        trades_raw=sim["trades_raw"],
        net_eq=sim["net_equity"],
        gross_eq=sim["gross_equity"],
        initial_capital=req.execution.initial_capital,
    )

    total_ms = round((time.perf_counter() - t0) * 1000.0, 1)
    trades_list = [t.model_dump() for t in sim["trades"]]

    return {
        "dataset_id": req.dataset_id,
        "strategy_id": req.strategy_id,
        "bars_tested": df_5m.height,
        "used_1m_subbars": used_1m_subbars,
        "engine_ms": sim["elapsed_ms"],
        "total_ms": total_ms,
        **analytics,
        "trades": trades_list,
    }


@app.post("/api/optimize")
def execute_optimization(req: OptimizeRequest) -> dict[str, Any]:
    try:
        return run_grid_optimization(req)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/strategies")
def get_strategies() -> list[dict[str, Any]]:
    return [s.model_dump() for s in list_all_strategies()]


@app.post("/api/strategies/custom")
def create_or_update_custom_strategy(req: CustomStrategySaveRequest) -> dict[str, Any]:
    try:
        saved = save_custom_strategy(req.strategy_id, req.code)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {
        "strategy": saved.model_dump(),
        "strategies": [s.model_dump() for s in list_all_strategies()],
    }


@app.delete("/api/strategies/custom/{strategy_id}")
def remove_custom_strategy(strategy_id: str) -> dict[str, Any]:
    ok = delete_custom_strategy(strategy_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Custom strategy not found.")
    return {"deleted": strategy_id, "strategies": [s.model_dump() for s in list_all_strategies()]}


_REPLAY_INDEX_CACHE: dict[tuple[str, int], dict[str, Any]] = {}


def _get_replay_base(dataset_id: str) -> dict[str, Any]:
    """Load & enrich 1m (preferred) or 5m base DataFrame + precomputed NY Open bar indices for instant jumps."""
    try:
        df_base = load_dataset_df(dataset_id, "1m")
        base_tf = "1m"
    except FileNotFoundError:
        try:
            df_base = load_dataset_df(dataset_id, "5m")
            base_tf = "5m"
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    cache_key = (dataset_id, df_base.height)
    if cache_key in _REPLAY_INDEX_CACHE:
        return _REPLAY_INDEX_CACHE[cache_key]

    if "et_day_id" not in df_base.columns or "et_minute" not in df_base.columns or "et_str" not in df_base.columns:
        dt_et = (
            pl.from_epoch(pl.col("ts"), time_unit="s")
            .dt.replace_time_zone("UTC")
            .dt.convert_time_zone("America/New_York")
        )
        df_base = (
            df_base.with_columns(dt_et.alias("_dt_et"))
            .with_columns(
                [
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

    if "volume" not in df_base.columns:
        df_base = df_base.with_columns(pl.lit(1.0).alias("volume"))
    if "spread" not in df_base.columns:
        df_base = df_base.with_columns(pl.lit(0.5).alias("spread"))

    ts_arr = df_base["ts"].to_numpy()
    # Precompute index of ~09:20 ET (minute >= 560) for each trading day for instant NY Open jumps
    df_idx = (
        df_base.select(["et_day_id", "et_minute"])
        .with_row_index("idx")
        .filter((pl.col("et_minute") >= 560) & (pl.col("et_minute") <= 600))
        .group_by("et_day_id", maintain_order=True)
        .agg(pl.col("idx").first().alias("open_idx"))
    )
    ny_open_indices = df_idx["open_idx"].to_numpy().astype(np.int64)
    ny_open_ts = ts_arr[ny_open_indices] if len(ny_open_indices) > 0 else np.empty(0, dtype=np.int64)

    if len(_REPLAY_INDEX_CACHE) >= 4:
        _REPLAY_INDEX_CACHE.pop(next(iter(_REPLAY_INDEX_CACHE)), None)

    entry = {
        "df_base": df_base,
        "base_tf": base_tf,
        "ts_arr": ts_arr,
        "ny_open_indices": ny_open_indices,
        "ny_open_ts": ny_open_ts,
    }
    _REPLAY_INDEX_CACHE[cache_key] = entry
    return entry


@app.post("/api/replay/frame")
def get_replay_frame(req: ReplayFrameRequest) -> dict[str, Any]:
    t0 = time.perf_counter()
    ctx = _get_replay_base(req.dataset_id)
    df_base: pl.DataFrame = ctx["df_base"]
    ts_arr: np.ndarray = ctx["ts_arr"]
    ny_open_indices: np.ndarray = ctx["ny_open_indices"]
    ny_open_ts: np.ndarray = ctx["ny_open_ts"]

    n_total = len(ts_arr)
    if n_total < 30:
        raise HTTPException(status_code=400, detail="Dataset has insufficient bars for simulation replay.")

    prev_idx: int | None = None
    if req.sim_ts is not None:
        pos = int(np.searchsorted(ts_arr, req.sim_ts, side="right")) - 1
        prev_idx = max(0, min(n_total - 1, pos))

    # Determine target bar index `target_idx` in `df_base`
    if req.mode == "init":
        if len(ny_open_indices) > 20:
            target_idx = int(ny_open_indices[-15])
        else:
            target_idx = max(20, int(n_total * 0.85))
    elif req.mode == "random_ny_open":
        if len(ny_open_indices) > 35:
            pick = random.randint(30, max(30, len(ny_open_indices) - 3))
            target_idx = int(ny_open_indices[pick])
        else:
            target_idx = random.randint(min(100, n_total // 4), max(101, n_total - 50))
    elif req.mode == "next_ny_open":
        cur_t = int(ts_arr[prev_idx]) if prev_idx is not None else int(ts_arr[0])
        nxt = int(np.searchsorted(ny_open_ts, cur_t + 3600, side="left"))
        if nxt < len(ny_open_indices):
            target_idx = int(ny_open_indices[nxt])
        else:
            target_idx = min(n_total - 1, (prev_idx or 0) + 60)
    elif req.mode == "jump_date" and req.jump_date_et:
        try:
            hh, mm = (req.jump_time_et or "09:25").split(":")[:2]
            y, mo, dy = [int(x) for x in req.jump_date_et[:10].split("-")]
            dt_et = datetime(y, mo, dy, int(hh), int(mm), tzinfo=ZoneInfo("America/New_York"))
            j_ts = int(dt_et.timestamp())
            pos = int(np.searchsorted(ts_arr, j_ts, side="left"))
            target_idx = max(20, min(n_total - 1, pos))
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"Invalid jump date/time: {exc}") from exc
    elif req.mode == "step" and prev_idx is not None:
        target_idx = max(10, min(n_total - 1, prev_idx + max(1, req.step_bars)))
    elif prev_idx is not None:
        target_idx = prev_idx
    else:
        target_idx = max(20, n_total - 500)

    sim_ts = int(ts_arr[target_idx])

    # Extract exact chronological stepped sub-bars if `mode == "step"` (for 1m-accurate SL/TP/Limit fills!)
    stepped_bars: list[dict[str, float | int | str]] = []
    if req.mode == "step" and prev_idx is not None and target_idx > prev_idx:
        df_step = df_base.slice(prev_idx + 1, target_idx - prev_idx)
        stepped_bars = [
            {
                "ts": int(t),
                "et": et_s,
                "open": round(float(o), 2),
                "high": round(float(h), 2),
                "low": round(float(l), 2),
                "close": round(float(c), 2),
                "spread": round(float(sp), 2),
            }
            for t, et_s, o, h, l, c, sp in zip(
                df_step["ts"].to_list(),
                df_step["et_str"].to_list(),
                df_step["open"].to_list(),
                df_step["high"].to_list(),
                df_step["low"].to_list(),
                df_step["close"].to_list(),
                df_step["spread"].to_list(),
            )
        ]

    # Slice causal lookback window strictly `<= target_idx` (ZERO future lookahead!)
    tfs = req.timeframes or ["3m"]
    needs_long_lookback = any(tf in ("240m", "4h", "240", "1D", "D") for tf in tfs)
    lookback_rows = 240_000 if needs_long_lookback else 110_000
    lb_start = max(0, target_idx + 1 - lookback_rows)
    df_causal = df_base.slice(lb_start, target_idx + 1 - lb_start)

    settings_dict = req.suite_settings.model_dump()
    df_daily_cached = resample_bars_upto(df_causal, "1D") if settings_dict.get("show_aem", True) else None
    mtf_right_cached = compute_mtf_right_candles(df_causal) if settings_dict.get("show_mtf", True) else None

    panes: dict[str, Any] = {}
    for tf in tfs:
        panes[tf] = build_replay_pane_payload(
            df_base=df_causal,
            chart_tf=tf,
            sim_ts=sim_ts,
            limit=req.limit,
            settings=settings_dict,
            df_daily_cached=df_daily_cached,
            mtf_right_candles_cached=mtf_right_cached,
        )

    cur_row = df_base.row(target_idx, named=True)
    mid_price = round(float(cur_row["close"]), 2)
    cur_spread = round(max(0.25, float(cur_row["spread"])), 2)
    bid_price = round(mid_price - 0.5 * cur_spread, 2)
    ask_price = round(mid_price + 0.5 * cur_spread, 2)

    return {
        "dataset_id": req.dataset_id,
        "base_tf": ctx["base_tf"],
        "sim_ts": sim_ts,
        "sim_et": cur_row["et_str"],
        "bar_index": target_idx,
        "total_bars": n_total,
        "has_next": target_idx < n_total - 1,
        "mid": mid_price,
        "bid": bid_price,
        "ask": ask_price,
        "spread": cur_spread,
        "stepped_bars": stepped_bars,
        "panes": panes,
        "elapsed_ms": round((time.perf_counter() - t0) * 1000.0, 1),
    }


# Serve production React build automatically if present
_FRONTEND_DIST = PROJECT_ROOT / "frontend" / "dist"
if _FRONTEND_DIST.exists():
    app.mount("/", StaticFiles(directory=str(_FRONTEND_DIST), html=True), name="frontend")
