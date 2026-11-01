from __future__ import annotations

import asyncio
from datetime import date, datetime, timedelta, timezone
import lzma
from pathlib import Path
from typing import Callable

import httpx
import numpy as np
import polars as pl

from app.config import DUKASCOPY_CACHE_DIR
from app.data.store import resample_1m_to_5m, save_dataset
from app.models import DatasetMeta

DUKASCOPY_BASE = "https://datafeed.dukascopy.com/datafeed"
SYMBOL = "USATECHIDXUSD"
POINT_DIVISOR = 1000.0


def parse_bi5_candles_1m(raw_compressed: bytes, day_epoch_utc: int, point_divisor: float = POINT_DIVISOR) -> np.ndarray:
    """
    Decode a Dukascopy `*_candles_min_1.bi5` LZMA file into an `(N, 6)` float64 array:
    columns = `[ts, open, high, low, close, volume]`.

    Automatically detects & enforces OHLC ordering (`O, C, L, H` vs `O, H, L, C`)
    so High >= max(O, C) and Low <= min(O, C) is mathematically guaranteed.
    """
    if not raw_compressed:
        return np.empty((0, 6), dtype=np.float64)

    try:
        decompressed = lzma.decompress(raw_compressed)
    except Exception:
        return np.empty((0, 6), dtype=np.float64)

    n_records = len(decompressed) // 24
    if n_records == 0:
        return np.empty((0, 6), dtype=np.float64)

    buf = decompressed[: n_records * 24]
    dt = np.dtype(
        [
            ("sec", ">u4"),
            ("p1", ">u4"),
            ("p2", ">u4"),
            ("p3", ">u4"),
            ("p4", ">u4"),
            ("vol", ">f4"),
        ]
    )
    arr = np.frombuffer(buf, dtype=dt)

    p1 = arr["p1"].astype(np.float64) / point_divisor
    p2 = arr["p2"].astype(np.float64) / point_divisor
    p3 = arr["p3"].astype(np.float64) / point_divisor
    p4 = arr["p4"].astype(np.float64) / point_divisor

    p_max = np.maximum(np.maximum(p1, p2), np.maximum(p3, p4))
    p_min = np.minimum(np.minimum(p1, p2), np.minimum(p3, p4))

    # Dukascopy standard candle layout is (sec, open, close, low, high, vol):
    # Verify whether p4 is High & p3 is Low, vs p2 is High & p3 is Low (O, H, L, C)
    oclh_violations = int(np.sum((p4 < p_max - 1e-9) | (p3 > p_min + 1e-9)))
    ohlc_violations = int(np.sum((p2 < p_max - 1e-9) | (p3 > p_min + 1e-9)))

    open_p = p1
    high_p = p_max
    low_p = p_min
    if oclh_violations <= ohlc_violations:
        close_p = p2
    else:
        close_p = p4

    ts = day_epoch_utc + arr["sec"].astype(np.int64)
    out = np.column_stack(
        [
            ts.astype(np.float64),
            open_p,
            high_p,
            low_p,
            close_p,
            arr["vol"].astype(np.float64),
        ]
    )
    # Filter any corrupt zero-price rows
    valid = (out[:, 1] > 0) & (out[:, 4] > 0)
    return out[valid]


async def _fetch_day_file(
    client: httpx.AsyncClient,
    sem: asyncio.Semaphore,
    d: date,
    side: str = "BID",
) -> bytes:
    month_zero = d.month - 1  # Dukascopy uses 00..11!
    cache_file: Path = (
        DUKASCOPY_CACHE_DIR
        / SYMBOL
        / f"{d.year:04d}"
        / f"{month_zero:02d}"
        / f"{d.day:02d}"
        / f"{side}_candles_min_1.bi5"
    )
    if cache_file.exists():
        return cache_file.read_bytes()

    url = f"{DUKASCOPY_BASE}/{SYMBOL}/{d.year:04d}/{month_zero:02d}/{d.day:02d}/{side}_candles_min_1.bi5"
    async with sem:
        for attempt in range(3):
            try:
                resp = await client.get(url)
                if resp.status_code == 200:
                    data = resp.content
                    cache_file.parent.mkdir(parents=True, exist_ok=True)
                    cache_file.write_bytes(data)
                    return data
                if resp.status_code == 404:
                    cache_file.parent.mkdir(parents=True, exist_ok=True)
                    cache_file.write_bytes(b"")
                    return b""
            except Exception:
                if attempt == 2:
                    return b""
                await asyncio.sleep(0.4 * (attempt + 1))
    return b""


async def download_dukascopy_nas100(
    start_date: str,
    end_date: str,
    include_ask_spread: bool = True,
    dataset_name: str | None = None,
    progress_cb: Callable[[int, int, str], None] | None = None,
    cancel_event: asyncio.Event | None = None,
) -> DatasetMeta:
    """
    Download 1-minute historical Nasdaq-100 (`USATECHIDXUSD`) Bid (and optional Ask) candles
    from Dukascopy's free historical datafeed, compute exact Bid-Ask spread, and save both
    1m and 5m Parquet datasets.
    """
    d_start = date.fromisoformat(start_date[:10])
    d_end = date.fromisoformat(end_date[:10])
    today = datetime.now(timezone.utc).date()
    if d_end >= today:
        d_end = today - timedelta(days=1)

    if d_start > d_end:
        raise ValueError(f"start_date ({d_start}) must be <= end_date ({d_end})")

    # Skip Saturdays (Nasdaq CFD closed all Saturday UTC; Sunday opens ~22:00 UTC)
    days: list[date] = []
    cur = d_start
    while cur <= d_end:
        if cur.weekday() != 5:  # 5 = Saturday
            days.append(cur)
        cur += timedelta(days=1)

    total_days = len(days)
    if total_days == 0:
        raise ValueError("No trading days in requested date range.")

    headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Accept-Encoding": "identity",
    }
    sem = asyncio.Semaphore(20)

    bid_chunks: list[np.ndarray] = []
    ask_chunks: list[np.ndarray] = []

    batch_size = 60
    days_done = 0

    async with httpx.AsyncClient(headers=headers, timeout=25.0, follow_redirects=True) as client:
        for b_start in range(0, total_days, batch_size):
            if cancel_event and cancel_event.is_set():
                raise RuntimeError("Download cancelled by user.")

            batch_days = days[b_start : b_start + batch_size]
            bid_tasks = [_fetch_day_file(client, sem, d, "BID") for d in batch_days]
            bid_raw_list = await asyncio.gather(*bid_tasks)

            ask_raw_list: list[bytes] = []
            if include_ask_spread:
                ask_tasks = [_fetch_day_file(client, sem, d, "ASK") for d in batch_days]
                ask_raw_list = await asyncio.gather(*ask_tasks)

            for i, d in enumerate(batch_days):
                day_epoch = int(datetime(d.year, d.month, d.day, tzinfo=timezone.utc).timestamp())
                bid_arr = parse_bi5_candles_1m(bid_raw_list[i], day_epoch)
                if bid_arr.shape[0] > 0:
                    bid_chunks.append(bid_arr)
                if include_ask_spread and i < len(ask_raw_list):
                    ask_arr = parse_bi5_candles_1m(ask_raw_list[i], day_epoch)
                    if ask_arr.shape[0] > 0:
                        ask_chunks.append(ask_arr)

            days_done += len(batch_days)
            if progress_cb:
                progress_cb(
                    days_done,
                    total_days,
                    f"Fetched {days_done:,}/{total_days:,} trading days ({batch_days[-1].isoformat()})",
                )

    if not bid_chunks:
        raise RuntimeError(
            "No historical candles returned from Dukascopy for the selected range. "
            "Check your internet connection or date range (Dukascopy USATECHIDXUSD starts ~2013)."
        )

    all_bid = np.vstack(bid_chunks)
    df_bid = pl.DataFrame(
        {
            "ts": all_bid[:, 0].astype(np.int64),
            "open": all_bid[:, 1],
            "high": all_bid[:, 2],
            "low": all_bid[:, 3],
            "close": all_bid[:, 4],
            "volume": all_bid[:, 5],
        }
    ).sort("ts").unique(subset=["ts"], keep="last").sort("ts")

    has_bid_ask = False
    if include_ask_spread and ask_chunks:
        all_ask = np.vstack(ask_chunks)
        df_ask = (
            pl.DataFrame(
                {
                    "ts": all_ask[:, 0].astype(np.int64),
                    "ask_open": all_ask[:, 1],
                    "ask_close": all_ask[:, 4],
                }
            )
            .sort("ts")
            .unique(subset=["ts"], keep="last")
        )
        # Convert mid price for clean symmetric charting + exact Bid-Ask spread column
        df_1m = (
            df_bid.join(df_ask, on="ts", how="left")
            .with_columns(
                (pl.col("ask_close") - pl.col("close"))
                .clip(lower_bound=0.05, upper_bound=15.0)
                .fill_null(0.8)
                .alias("spread")
            )
            .with_columns(
                [
                    (pl.col("open") + pl.col("spread") * 0.5).alias("open"),
                    (pl.col("high") + pl.col("spread") * 0.5).alias("high"),
                    (pl.col("low") + pl.col("spread") * 0.5).alias("low"),
                    (pl.col("close") + pl.col("spread") * 0.5).alias("close"),
                ]
            )
            .drop(["ask_open", "ask_close"])
        )
        has_bid_ask = True
    else:
        df_1m = df_bid.with_columns(pl.lit(0.8).alias("spread"))

    if progress_cb:
        progress_cb(total_days, total_days, "Resampling 1m -> 5m & writing ZSTD Parquet files...")

    df_5m = resample_1m_to_5m(df_1m)
    dataset_id = f"dukascopy_nas100_{d_start.year}_{d_end.year}"
    label = dataset_name or f"NAS100 (Dukascopy Real 1m+5m, {d_start.isoformat()} → {d_end.isoformat()})"

    return save_dataset(
        dataset_id=dataset_id,
        name=label,
        symbol="NAS100",
        source="Dukascopy Historical Feed",
        df_5m=df_5m,
        df_1m=df_1m,
        has_bid_ask=has_bid_ask,
    )
