from __future__ import annotations

from fastapi.testclient import TestClient
import polars as pl

from app.data.store import list_datasets
from app.engine.universal_suite import _compute_luxalgo_fvg, _attach_et_fields
from app.main import app


def test_luxalgo_fvg_detection_and_mitigation_deletion() -> None:
    # Construct 6 bars:
    # Bar 0: H=100, L=95
    # Bar 1: H=108, L=99, C=107 (> H[0]=100)
    # Bar 2: H=112, L=104 (> H[0]=100 -> Bullish FVG [100..104]!)
    # Bar 3: C=105 (still above min=100 -> unmitigated!)
    # Bar 4: C=98 (< min=100 -> MITIGATED! Box should be deleted!)
    base_ts = 1746455400
    df_unmit = _attach_et_fields(
        pl.DataFrame(
            {
                "ts": [base_ts + i * 180 for i in range(4)],
                "open": [96.0, 100.0, 107.0, 106.0],
                "high": [100.0, 108.0, 112.0, 109.0],
                "low":  [95.0, 99.0, 104.0, 102.0],
                "close":[99.0, 107.0, 110.0, 105.0],
                "volume": [100.0] * 4,
                "spread": [0.5] * 4,
            }
        )
    )
    res1 = _compute_luxalgo_fvg(
        df_chart=df_unmit,
        df_base=df_unmit,
        chart_tf="3m",
        fvg_tf="Chart",
        sim_ts=int(df_unmit["ts"][-1]),
        mitigation_levels=True,
    )
    assert len(res1["boxes"]) == 1
    assert res1["boxes"][0]["is_bull"] is True
    assert res1["boxes"][0]["min"] == 100.0
    assert res1["boxes"][0]["max"] == 104.0

    # Add mitigating bar 4 where close=98 < 100
    df_mit = _attach_et_fields(
        pl.DataFrame(
            {
                "ts": [base_ts + i * 180 for i in range(5)],
                "open": [96.0, 100.0, 107.0, 106.0, 105.0],
                "high": [100.0, 108.0, 112.0, 109.0, 105.5],
                "low":  [95.0, 99.0, 104.0, 102.0, 97.0],
                "close":[99.0, 107.0, 110.0, 105.0, 98.0],
                "volume": [100.0] * 5,
                "spread": [0.5] * 5,
            }
        )
    )
    res2 = _compute_luxalgo_fvg(
        df_chart=df_mit,
        df_base=df_mit,
        chart_tf="3m",
        fvg_tf="Chart",
        sim_ts=int(df_mit["ts"][-1]),
        mitigation_levels=True,
    )
    assert len(res2["boxes"]) == 0
    assert len(res2["mitigation_lines"]) == 1
    assert res2["mitigation_lines"][0]["price"] == 100.0


def test_replay_frame_quad_mtf_and_stepping_zero_lookahead() -> None:
    client = TestClient(app)
    boot = client.get("/api/bootstrap").json()
    ds_id = boot["datasets"][0]["id"]

    # 1. Initialize replay across all 4 user timeframes: 3m, 15m, 60m (1H), 240m (4H)
    r_init = client.post(
        "/api/replay/frame",
        json={
            "dataset_id": ds_id,
            "mode": "init",
            "timeframes": ["3m", "15m", "60m", "240m"],
            "limit": 200,
        },
    )
    assert r_init.status_code == 200, r_init.text
    frame0 = r_init.json()
    sim_ts0 = frame0["sim_ts"]

    for tf in ("3m", "15m", "60m", "240m"):
        pane = frame0["panes"][tf]
        assert len(pane["candles"]) > 20
        # Verify strict causality: no candle timestamp can exceed sim_ts0
        assert pane["candles"][-1]["time"] <= sim_ts0
        suite = pane["suite"]
        assert "fvg" in suite
        assert "ma" in suite
        assert "vwap" in suite
        assert "aem" in suite
        assert len(suite["mtf_candles"]) == 4  # 15m, 1H, 4H, 1D

    # 2. Step forward +5 base (1m) bars and verify stepped_bars path
    r_step = client.post(
        "/api/replay/frame",
        json={
            "dataset_id": ds_id,
            "mode": "step",
            "sim_ts": sim_ts0,
            "step_bars": 5,
            "timeframes": ["3m"],
            "limit": 200,
        },
    )
    assert r_step.status_code == 200
    frame1 = r_step.json()
    assert frame1["sim_ts"] > sim_ts0
    assert len(frame1["stepped_bars"]) == 5
