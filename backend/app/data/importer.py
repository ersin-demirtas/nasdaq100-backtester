from __future__ import annotations

from io import BytesIO
import re

import numpy as np
import polars as pl

from app.data.store import enrich_et_columns, resample_1m_to_5m, save_dataset
from app.models import DatasetMeta


def import_uploaded_file(
    raw_bytes: bytes,
    filename: str,
    symbol: str = "NAS100",
    dataset_name: str | None = None,
    source_tz: str = "UTC",
) -> DatasetMeta:
    """
    Universal CSV / TSV / Parquet historical bar importer.
    Auto-detects timestamp & OHLCV columns from TradingView, NinjaTrader, Sierra Chart,
    FirstRateData, HistData, MetaTrader (MT4/MT5), or Databento exports.
    Automatically detects 1m vs 5m cadence and resamples 1m -> 5m while keeping 1m sub-bars!
    """
    lower_name = filename.lower()
    if lower_name.endswith(".parquet"):
        df = pl.read_parquet(BytesIO(raw_bytes))
    else:
        # Detect delimiter (; for HistData/MT4, \t for MT5, , for standard CSV)
        sample = raw_bytes[:2048].decode("utf-8", errors="ignore")
        first_line = sample.splitlines()[0] if sample.splitlines() else ""
        sep = ","
        if first_line.count(";") > first_line.count(","):
            sep = ";"
        elif first_line.count("\t") > first_line.count(","):
            sep = "\t"
        df = pl.read_csv(BytesIO(raw_bytes), separator=sep, infer_schema_length=5000, ignore_errors=True)

    # Normalize column names
    col_map: dict[str, str] = {}
    for c in df.columns:
        clean = c.strip().strip("<>").lower()
        col_map[c] = clean
    df = df.rename(col_map)
    cols = set(df.columns)

    # Combine separate date + time columns if present (MT4/MT5/SierraChart)
    if "date" in cols and "time" in cols and "timestamp" not in cols and "datetime" not in cols:
        df = df.with_columns(
            (pl.col("date").cast(pl.Utf8).str.strip_chars() + " " + pl.col("time").cast(pl.Utf8).str.strip_chars()).alias("datetime")
        )
        cols.add("datetime")

    ts_col = None
    for candidate in ("ts", "timestamp", "time", "datetime", "date", "ts_event", "unix"):
        if candidate in cols:
            ts_col = candidate
            break
    if ts_col is None:
        raise ValueError(f"Could not find a timestamp column in {list(df.columns)}")

    def _find_col(candidates: tuple[str, ...], required: bool = True) -> str | None:
        for cand in candidates:
            if cand in cols:
                return cand
        if required:
            raise ValueError(f"Missing required column ({candidates[0]}) in {list(df.columns)}")
        return None

    o_col = _find_col(("open", "o", "bid_open"))
    h_col = _find_col(("high", "h", "bid_high"))
    l_col = _find_col(("low", "l", "bid_low"))
    c_col = _find_col(("close", "c", "last", "bid_close"))
    v_col = _find_col(("volume", "vol", "v", "tickvol"), required=False)
    sp_col = _find_col(("spread",), required=False)

    # Parse timestamp column into Unix epoch seconds (UTC)
    dtype = df[ts_col].dtype
    if dtype.is_integer() or dtype.is_float():
        vals = df[ts_col].cast(pl.Float64).to_numpy()
        med = float(np.nanmedian(vals))
        if med > 1e16:  # nanoseconds
            ts_sec = (vals / 1e9).astype(np.int64)
        elif med > 1e13:  # microseconds
            ts_sec = (vals / 1e6).astype(np.int64)
        elif med > 1e11:  # milliseconds
            ts_sec = (vals / 1e3).astype(np.int64)
        else:
            ts_sec = vals.astype(np.int64)
        df = df.with_columns(pl.Series("ts", ts_sec))
    elif dtype == pl.Datetime:
        dt_expr = pl.col(ts_col)
        if dtype.time_zone is None:
            dt_expr = dt_expr.dt.replace_time_zone(source_tz)
        df = df.with_columns(dt_expr.dt.convert_time_zone("UTC").dt.epoch("s").alias("ts"))
    else:
        # String datetime parsing
        s_col = pl.col(ts_col).cast(pl.Utf8).str.strip_chars()
        parsed = s_col.str.to_datetime(strict=False)
        if parsed.dtype.time_zone is None:
            parsed = parsed.dt.replace_time_zone(source_tz)
        df = df.with_columns(parsed.dt.convert_time_zone("UTC").dt.epoch("s").alias("ts"))

    select_exprs = [
        pl.col("ts").cast(pl.Int64),
        pl.col(o_col).cast(pl.Float64).alias("open"),  # type: ignore[arg-type]
        pl.col(h_col).cast(pl.Float64).alias("high"),  # type: ignore[arg-type]
        pl.col(l_col).cast(pl.Float64).alias("low"),   # type: ignore[arg-type]
        pl.col(c_col).cast(pl.Float64).alias("close"), # type: ignore[arg-type]
        pl.col(v_col).cast(pl.Float64).fill_null(0.0).alias("volume") if v_col else pl.lit(0.0).alias("volume"),
        pl.col(sp_col).cast(pl.Float64).fill_null(0.0).alias("spread") if sp_col else pl.lit(0.0).alias("spread"),
    ]
    df_clean = df.select(select_exprs).drop_nulls(subset=["ts", "open", "high", "low", "close"]).sort("ts")
    if df_clean.height < 10:
        raise ValueError("Imported file contained fewer than 10 valid OHLC rows.")

    diffs = np.diff(df_clean["ts"].to_numpy())
    positive_diffs = diffs[diffs > 0]
    median_step = float(np.median(positive_diffs)) if len(positive_diffs) > 0 else 300.0

    slug_base = re.sub(r"[^a-z0-9]+", "_", filename.rsplit(".", 1)[0].lower()).strip("_")[:32]
    dataset_id = f"import_{slug_base}"
    label = dataset_name or f"{symbol.upper()} ({filename})"

    if median_step <= 90.0:
        # Input is 1-minute (or sub-minute) data -> resample to 5m AND keep 1m sub-bars!
        df_5m = resample_1m_to_5m(df_clean)
        return save_dataset(
            dataset_id=dataset_id,
            name=label,
            symbol=symbol.upper(),
            source="Local File Import (1m+5m)",
            df_5m=df_5m,
            df_1m=df_clean,
            has_bid_ask=sp_col is not None,
        )
    else:
        df_5m = enrich_et_columns(df_clean)
        return save_dataset(
            dataset_id=dataset_id,
            name=label,
            symbol=symbol.upper(),
            source="Local File Import (5m)",
            df_5m=df_5m,
            df_1m=None,
            has_bid_ask=sp_col is not None,
        )
