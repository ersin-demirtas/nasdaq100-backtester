from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
import polars as pl

from app.config import DATASETS_DIR
from app.models import DatasetMeta

# In-memory cache of loaded Polars DataFrames keyed by (dataset_id, timeframe, mtime)
_DF_CACHE: dict[tuple[str, str, float], pl.DataFrame] = {}


def enrich_et_columns(df: pl.DataFrame) -> pl.DataFrame:
    """
    Given a DataFrame with `ts` (Unix epoch seconds, Int64, UTC),
    attach fast integer columns in America/New_York (handling EST/EDT transitions):
      - dt_utc: Datetime[ms, UTC]
      - dt_et: Datetime[ms, America/New_York]
      - et_year: Int16
      - et_month: Int8
      - et_day_id: Int32 (YYYYMMDD in ET, used for daily trade/loss resets & ORB/VWAP)
      - et_minute: Int16 (minutes since 00:00 ET, e.g. 570 = 09:30 ET, 960 = 16:00 ET)
      - et_dow: Int8 (1=Mon .. 7=Sun)
    """
    df = df.sort("ts").unique(subset=["ts"], keep="last").sort("ts")

    dt_utc = pl.from_epoch(pl.col("ts"), time_unit="s").dt.replace_time_zone("UTC")
    dt_et = dt_utc.dt.convert_time_zone("America/New_York")

    if "spread" not in df.columns:
        df = df.with_columns(pl.lit(0.0).cast(pl.Float64).alias("spread"))
    if "volume" not in df.columns:
        df = df.with_columns(pl.lit(0.0).cast(pl.Float64).alias("volume"))

    df = df.with_columns(
        [
            pl.col("ts").cast(pl.Int64),
            pl.col("open").cast(pl.Float64),
            pl.col("high").cast(pl.Float64),
            pl.col("low").cast(pl.Float64),
            pl.col("close").cast(pl.Float64),
            pl.col("volume").cast(pl.Float64),
            pl.col("spread").cast(pl.Float64),
            dt_et.alias("_dt_et"),
        ]
    ).with_columns(
        [
            pl.col("_dt_et").dt.year().cast(pl.Int16).alias("et_year"),
            pl.col("_dt_et").dt.month().cast(pl.Int8).alias("et_month"),
            (
                pl.col("_dt_et").dt.year().cast(pl.Int32) * 10000
                + pl.col("_dt_et").dt.month().cast(pl.Int32) * 100
                + pl.col("_dt_et").dt.day().cast(pl.Int32)
            ).alias("et_day_id"),
            (
                pl.col("_dt_et").dt.hour().cast(pl.Int16) * 60
                + pl.col("_dt_et").dt.minute().cast(pl.Int16)
            ).alias("et_minute"),
            pl.col("_dt_et").dt.weekday().cast(pl.Int8).alias("et_dow"),
            pl.col("_dt_et").dt.strftime("%Y-%m-%d %H:%M").alias("et_str"),
        ]
    ).drop("_dt_et")

    return df


def resample_1m_to_5m(df_1m: pl.DataFrame) -> pl.DataFrame:
    """Aggregate 1-minute UTC bars cleanly into 5-minute UTC bars (bucket aligned to 300s)."""
    df_sorted = df_1m.sort("ts")
    agg_exprs = [
        pl.col("open").first().alias("open"),
        pl.col("high").max().alias("high"),
        pl.col("low").min().alias("low"),
        pl.col("close").last().alias("close"),
        pl.col("volume").sum().alias("volume"),
    ]
    if "spread" in df_sorted.columns:
        agg_exprs.append(pl.col("spread").median().alias("spread"))
    else:
        agg_exprs.append(pl.lit(0.0).alias("spread"))

    df_5m = (
        df_sorted.with_columns(((pl.col("ts") // 300) * 300).alias("ts_5m"))
        .group_by("ts_5m", maintain_order=True)
        .agg(agg_exprs)
        .rename({"ts_5m": "ts"})
        .sort("ts")
    )
    return enrich_et_columns(df_5m)


def save_dataset(
    dataset_id: str,
    name: str,
    symbol: str,
    source: str,
    df_5m: pl.DataFrame,
    df_1m: pl.DataFrame | None = None,
    has_bid_ask: bool = False,
) -> DatasetMeta:
    """Persist 5m (and optional 1m) Parquet files + JSON metadata."""
    df_5m_enriched = enrich_et_columns(df_5m)
    path_5m = DATASETS_DIR / f"{dataset_id}_5m.parquet"
    df_5m_enriched.write_parquet(path_5m, compression="zstd")

    bars_1m = 0
    has_1m = False
    path_1m = DATASETS_DIR / f"{dataset_id}_1m.parquet"
    if df_1m is not None and df_1m.height > 0:
        df_1m_clean = (
            df_1m.select(
                [
                    pl.col("ts").cast(pl.Int64),
                    pl.col("open").cast(pl.Float64),
                    pl.col("high").cast(pl.Float64),
                    pl.col("low").cast(pl.Float64),
                    pl.col("close").cast(pl.Float64),
                    (
                        pl.col("spread").cast(pl.Float64)
                        if "spread" in df_1m.columns
                        else pl.lit(0.0).cast(pl.Float64).alias("spread")
                    ),
                ]
            )
            .sort("ts")
            .unique(subset=["ts"], keep="last")
            .sort("ts")
        )
        df_1m_clean.write_parquet(path_1m, compression="zstd")
        bars_1m = df_1m_clean.height
        has_1m = True

    min_ts = int(df_5m_enriched["ts"].min())  # type: ignore[arg-type]
    max_ts = int(df_5m_enriched["ts"].max())  # type: ignore[arg-type]
    start_utc = datetime.fromtimestamp(min_ts, tz=timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    end_utc = datetime.fromtimestamp(max_ts, tz=timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    years_span = round(max((max_ts - min_ts) / (365.25 * 86400), 0.01), 2)

    size_bytes = path_5m.stat().st_size + (path_1m.stat().st_size if has_1m and path_1m.exists() else 0)
    meta = DatasetMeta(
        id=dataset_id,
        name=name,
        symbol=symbol,
        source=source,
        timeframe="5m",
        has_1m_subbars=has_1m,
        has_bid_ask=has_bid_ask,
        bars_5m=df_5m_enriched.height,
        bars_1m=bars_1m,
        start_utc=start_utc,
        end_utc=end_utc,
        years_span=years_span,
        file_size_mb=round(size_bytes / (1024 * 1024), 2),
    )

    meta_path = DATASETS_DIR / f"{dataset_id}.meta.json"
    meta_path.write_text(meta.model_dump_json(indent=2))
    return meta


def list_datasets() -> list[DatasetMeta]:
    metas: list[DatasetMeta] = []
    for meta_file in sorted(DATASETS_DIR.glob("*.meta.json")):
        try:
            data = json.loads(meta_file.read_text())
            metas.append(DatasetMeta(**data))
        except Exception:
            continue
    return metas


def delete_dataset(dataset_id: str) -> bool:
    removed = False
    for suffix in (".meta.json", "_5m.parquet", "_1m.parquet"):
        p = DATASETS_DIR / f"{dataset_id}{suffix}"
        if p.exists():
            p.unlink()
            removed = True
    keys_to_pop = [k for k in _DF_CACHE if k[0] == dataset_id]
    for k in keys_to_pop:
        _DF_CACHE.pop(k, None)
    return removed


def load_dataset_df(
    dataset_id: str,
    timeframe: str = "5m",
    start_date: str | None = None,
    end_date: str | None = None,
) -> pl.DataFrame:
    path = DATASETS_DIR / f"{dataset_id}_{timeframe}.parquet"
    if not path.exists():
        raise FileNotFoundError(f"Dataset file not found: {path.name}")

    mtime = path.stat().st_mtime
    cache_key = (dataset_id, timeframe, mtime)
    if cache_key not in _DF_CACHE:
        # Evict stale entries if cache exceeds 8 datasets
        if len(_DF_CACHE) >= 8:
            oldest_key = next(iter(_DF_CACHE))
            _DF_CACHE.pop(oldest_key, None)
        _DF_CACHE[cache_key] = pl.read_parquet(path)

    df = _DF_CACHE[cache_key]
    if start_date:
        start_ts = int(
            datetime.strptime(start_date[:10], "%Y-%m-%d")
            .replace(tzinfo=timezone.utc)
            .timestamp()
        )
        df = df.filter(pl.col("ts") >= start_ts)
    if end_date:
        end_ts = int(
            datetime.strptime(end_date[:10], "%Y-%m-%d")
            .replace(hour=23, minute=59, second=59, tzinfo=timezone.utc)
            .timestamp()
        )
        df = df.filter(pl.col("ts") <= end_ts)
    return df


def build_subbar_1m_lookup(df_5m: pl.DataFrame, df_1m: pl.DataFrame) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """
    Align 1m sub-bars to each 5m bar index using fast binary search (`np.searchsorted`).
    Returns `(idx_start, idx_count, m1_open, m1_high, m1_low, m1_close)` style arrays:
    Specifically `(sub_start, sub_count, m1_high, m1_low, m1_close)` for ultra-fast Numba intrabar lookup!
    """
    ts_5m = df_5m["ts"].to_numpy()
    ts_1m = df_1m["ts"].to_numpy()
    m1_high = df_1m["high"].to_numpy()
    m1_low = df_1m["low"].to_numpy()
    m1_close = df_1m["close"].to_numpy()

    left = np.searchsorted(ts_1m, ts_5m, side="left")
    right = np.searchsorted(ts_1m, ts_5m + 300, side="left")
    sub_start = left.astype(np.int64)
    sub_count = (right - left).astype(np.int64)
    return sub_start, sub_count, m1_high, m1_low, m1_close


def query_candles_window(
    dataset_id: str,
    center_ts: int | None = None,
    end_ts: int | None = None,
    limit: int = 1500,
) -> dict[str, Any]:
    """
    Fast windowed 5m candle fetch for TradingView Lightweight Charts.
    Supports jumping to a specific trade (`center_ts`) or scrolling back (`end_ts`).
    """
    df = load_dataset_df(dataset_id, "5m")
    n = df.height
    if n == 0:
        return {"candles": [], "total_bars": 0, "has_more_left": False, "has_more_right": False}

    ts_arr = df["ts"].to_numpy()
    limit = max(100, min(limit, 5000))

    if center_ts is not None:
        idx = int(np.searchsorted(ts_arr, center_ts))
        half = limit // 2
        start_i = max(0, idx - half)
        end_i = min(n, start_i + limit)
        start_i = max(0, end_i - limit)
    elif end_ts is not None:
        idx = int(np.searchsorted(ts_arr, end_ts, side="right"))
        end_i = min(n, idx)
        start_i = max(0, end_i - limit)
    else:
        end_i = n
        start_i = max(0, n - limit)

    sub = df.slice(start_i, end_i - start_i)
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
            sub["ts"].to_list(),
            sub["open"].to_list(),
            sub["high"].to_list(),
            sub["low"].to_list(),
            sub["close"].to_list(),
            sub["volume"].to_list(),
            sub["spread"].to_list(),
            sub["et_str"].to_list(),
        )
    ]
    return {
        "candles": candles,
        "total_bars": n,
        "window_start_idx": start_i,
        "window_end_idx": end_i,
        "has_more_left": start_i > 0,
        "has_more_right": end_i < n,
    }
