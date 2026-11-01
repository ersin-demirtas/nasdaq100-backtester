from __future__ import annotations

import asyncio
from datetime import datetime
from typing import Callable

import httpx
import polars as pl

from app.data.store import enrich_et_columns, resample_1m_to_5m, save_dataset
from app.models import DatasetMeta

ALPACA_DATA_URL = "https://data.alpaca.markets/v2/stocks/bars"


async def download_alpaca_bars(
    symbol: str,
    start_date: str,
    end_date: str,
    api_key: str,
    api_secret: str,
    feed: str = "iex",
    fetch_1m: bool = True,
    progress_cb: Callable[[int, int, str], None] | None = None,
    cancel_event: asyncio.Event | None = None,
) -> DatasetMeta:
    """
    Download historical 1m or 5m bars for QQQ / TQQQ from Alpaca Market Data API v2.
    Works with Alpaca's free Market Data keys.
    """
    sym = symbol.strip().upper()
    tf = "1Min" if fetch_1m else "5Min"
    headers = {
        "APCA-API-KEY-ID": api_key.strip(),
        "APCA-API-SECRET-KEY": api_secret.strip(),
    }

    ts_list: list[int] = []
    opens: list[float] = []
    highs: list[float] = []
    lows: list[float] = []
    closes: list[float] = []
    vols: list[float] = []

    page_token: str | None = None
    page_num = 0

    async with httpx.AsyncClient(headers=headers, timeout=30.0) as client:
        while True:
            if cancel_event and cancel_event.is_set():
                raise RuntimeError("Download cancelled by user.")

            params: dict[str, str | int] = {
                "symbols": sym,
                "timeframe": tf,
                "start": f"{start_date[:10]}T00:00:00Z",
                "end": f"{end_date[:10]}T23:59:59Z",
                "limit": 10000,
                "adjustment": "split",
                "feed": feed,
                "sort": "asc",
            }
            if page_token:
                params["page_token"] = page_token

            resp = await client.get(ALPACA_DATA_URL, params=params)
            if resp.status_code == 429:
                await asyncio.sleep(2.0)
                continue
            if resp.status_code != 200:
                raise RuntimeError(f"Alpaca API error ({resp.status_code}): {resp.text[:300]}")

            payload = resp.json()
            bars = payload.get("bars", {}).get(sym, [])
            for b in bars:
                dt = datetime.fromisoformat(b["t"].replace("Z", "+00:00"))
                ts_list.append(int(dt.timestamp()))
                opens.append(float(b["o"]))
                highs.append(float(b["h"]))
                lows.append(float(b["l"]))
                closes.append(float(b["c"]))
                vols.append(float(b["v"]))

            page_num += 1
            if progress_cb and ts_list:
                last_dt = datetime.utcfromtimestamp(ts_list[-1]).strftime("%Y-%m-%d")
                progress_cb(page_num, max(page_num + 2, 10), f"Fetched {len(ts_list):,} {tf} bars (up to {last_dt})...")

            page_token = payload.get("next_page_token")
            if not page_token:
                break

    if not ts_list:
        raise RuntimeError(f"No bars returned by Alpaca for {sym} ({start_date} -> {end_date}).")

    df_raw = pl.DataFrame(
        {
            "ts": ts_list,
            "open": opens,
            "high": highs,
            "low": lows,
            "close": closes,
            "volume": vols,
            "spread": [0.01] * len(ts_list),
        }
    )

    if fetch_1m:
        df_5m = resample_1m_to_5m(df_raw)
        df_1m: pl.DataFrame | None = df_raw
    else:
        df_5m = enrich_et_columns(df_raw)
        df_1m = None

    dataset_id = f"alpaca_{sym.lower()}_{start_date[:4]}_{end_date[:4]}"
    return save_dataset(
        dataset_id=dataset_id,
        name=f"{sym} (Alpaca {feed.upper()}, {start_date[:10]} → {end_date[:10]})",
        symbol=sym,
        source=f"Alpaca {feed.upper()}",
        df_5m=df_5m,
        df_1m=df_1m,
        has_bid_ask=False,
    )
