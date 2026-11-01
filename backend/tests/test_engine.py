from __future__ import annotations

import lzma
import struct

from fastapi.testclient import TestClient
import numpy as np
import polars as pl

from app.data.dukascopy import parse_bi5_candles_1m
from app.data.importer import import_uploaded_file
from app.data.store import delete_dataset, enrich_et_columns
from app.data.synthetic import generate_calibrated_nas100_dataset
from app.engine.simulator import run_simulation
from app.main import app
from app.models import ExecutionConfig
from app.strategies.builtin import BUILTIN_STRATEGIES


def test_dukascopy_bi5_parser_auto_verifies_ohlc() -> None:
    # Pack two 24-byte Dukascopy records in (sec, open, close, low, high, vol) layout
    rec1 = struct.pack(">IIIIIf", 60, 20100_000, 20115_500, 20095_250, 20120_750, 145.5)
    rec2 = struct.pack(">IIIIIf", 120, 20115_500, 20105_000, 20101_000, 20118_000, 98.0)
    compressed = lzma.compress(rec1 + rec2)

    day_epoch = 1730073600  # 2024-10-28 00:00:00 UTC
    arr = parse_bi5_candles_1m(compressed, day_epoch, point_divisor=1000.0)
    assert arr.shape == (2, 6)
    assert arr[0, 0] == day_epoch + 60
    assert np.isclose(arr[0, 1], 20100.0)
    assert np.isclose(arr[0, 2], 20120.75)  # High
    assert np.isclose(arr[0, 3], 20095.25)  # Low
    assert np.isclose(arr[0, 4], 20115.50)  # Close
    assert np.all(arr[:, 2] >= np.maximum(arr[:, 1], arr[:, 4]))
    assert np.all(arr[:, 3] <= np.minimum(arr[:, 1], arr[:, 4]))


def test_pessimistic_sl_vs_bar_path_and_friction_math() -> None:
    # Construct deterministic 5m bars during NY Open (14:30 UTC on 2025-05-05 = 10:30 EDT)
    base_ts = 1746455400  # 2025-05-05 14:30 UTC (10:30 ET)
    df = enrich_et_columns(
        pl.DataFrame(
            {
                "ts": [base_ts + i * 300 for i in range(6)],
                "open": [20000.0, 20000.0, 20000.0, 20010.0, 20010.0, 20010.0],
                "high": [20005.0, 20005.0, 20060.0, 20015.0, 20015.0, 20015.0],
                "low":  [19995.0, 19995.0, 19960.0, 20005.0, 20005.0, 20005.0],
                "close":[20002.0, 20002.0, 20055.0, 20012.0, 20012.0, 20012.0],
                "volume": [1000.0] * 6,
                "spread": [0.5] * 6,
            }
        )
    )
    # Signal Long at bar 1 -> fills at open of bar 2 (20000.0).
    # Bar 2 spans High=20060, Low=19960 -> BOTH SL (20 pts) and TP (40 pts) touched!
    sig = np.array([0, 1, 0, 0, 0, 0], dtype=np.int64)

    cfg_pess = ExecutionConfig(
        intrabar_mode="pessimistic_sl_first",
        sl_mode="fixed_pts",
        sl_pts=20.0,
        tp_mode="fixed_pts",
        tp_pts=40.0,
        spread_pts=1.0,
        use_dataset_spread=False,
        slippage_pts=0.5,
        commission_per_side=1.0,
        point_value=2.0,
        contracts=2.0,
        use_session_filter=False,
        flatten_et="",
    )
    res_pess = run_simulation(df, sig, None, None, cfg_pess)
    assert len(res_pess["trades"]) == 1
    t = res_pess["trades"][0]
    assert t.exit_reason == "SL"
    assert t.net_pnl < 0
    assert t.friction_cost > 0


def test_csv_importer_and_all_builtin_strategies_and_api() -> None:
    # Generate 1-year benchmark dataset first for fast comprehensive testing
    meta = generate_calibrated_nas100_dataset(years=1, end_date="2026-10-30", seed=7, include_1m=True)
    assert meta.bars_5m > 10_000
    assert meta.has_1m_subbars is True

    client = TestClient(app)
    boot = client.get("/api/bootstrap")
    assert boot.status_code == 200
    bdata = boot.json()
    assert len(bdata["strategies"]) >= 5

    # Run every built-in scalping strategy via POST /api/backtest with 1m sub-bar resolution
    for sid in BUILTIN_STRATEGIES:
        resp = client.post(
            "/api/backtest",
            json={
                "dataset_id": meta.id,
                "strategy_id": sid,
                "strategy_params": {},
                "execution": {"intrabar_mode": "subbar_1m"},
            },
        )
        assert resp.status_code == 200, f"Strategy {sid} failed: {resp.text}"
        payload = resp.json()
        assert payload["used_1m_subbars"] is True
        assert payload["bars_tested"] == meta.bars_5m
        assert "kpis" in payload

    # Test CSV upload endpoint (1m bars -> auto-resampled to 5m + 1m sub-bars)
    csv_lines = ["timestamp,open,high,low,close,volume"]
    for i in range(60):
        csv_lines.append(f"{1746455400 + i * 60},{20000 + i},{20005 + i},{19998 + i},{20002 + i},250")
    imported = import_uploaded_file("\n".join(csv_lines).encode(), "sample_nq_1m.csv", symbol="NQ")
    assert imported.has_1m_subbars is True
    assert imported.bars_5m == 12

    delete_dataset(meta.id)
    delete_dataset(imported.id)
