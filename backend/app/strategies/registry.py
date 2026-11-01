from __future__ import annotations

import importlib.util
from pathlib import Path
import re
from typing import Any

import numpy as np
import polars as pl

from app.config import CUSTOM_STRATEGIES_DIR
from app.models import ParamSpec, StrategyInfo
from app.strategies.builtin import BUILTIN_STRATEGIES

CUSTOM_STRATEGY_TEMPLATE = '''"""
Custom Nasdaq-100 5m Scalping Strategy Plugin
---------------------------------------------
Define `STRATEGY_META` and `generate_signals(df, params, include_overlays=True)`.
Available fast indicator helpers from `app.engine.indicators`:
  ema, sma, atr, rsi, session_vwap, opening_range, premarket_high_low, bollinger_bands, keltner_channels, adx
"""
import numpy as np
from app.engine.indicators import ema, atr, rsi, session_vwap

STRATEGY_META = {
    "name": "Custom EMA + VWAP Momentum Scalp",
    "category": "Custom Python",
    "description": "Fast/Slow EMA crossover filtered by 09:30 ET Session VWAP and RSI momentum.",
    "recommended_session": "NY_OPEN_KILLZONE",
    "params": [
        {"name": "fast_len", "label": "Fast EMA", "type": "int", "default": 8, "min": 3, "max": 30, "step": 1},
        {"name": "slow_len", "label": "Slow EMA", "type": "int", "default": 21, "min": 10, "max": 100, "step": 1},
        {"name": "rsi_filter", "label": "RSI Threshold", "type": "float", "default": 55.0, "min": 50.0, "max": 70.0, "step": 1.0},
    ],
}


def generate_signals(df, params, include_overlays=True):
    fast_len = int(params.get("fast_len", 8))
    slow_len = int(params.get("slow_len", 21))
    rsi_thresh = float(params.get("rsi_filter", 55.0))

    high = df["high"].to_numpy()
    low = df["low"].to_numpy()
    close = df["close"].to_numpy()
    vol = df["volume"].to_numpy()
    day_id = df["et_day_id"].to_numpy()
    et_min = df["et_minute"].to_numpy()

    f_ema = ema(close, fast_len)
    s_ema = ema(close, slow_len)
    vwap, _ = session_vwap(high, low, close, vol, day_id, et_min, 570)
    rsi_vals = rsi(close, 14)
    atr_vals = atr(high, low, close, 14)

    n = len(close)
    signal = np.zeros(n, dtype=np.int64)
    stop_price = np.full(n, np.nan, dtype=np.float64)

    cross_up = (f_ema[1:] > s_ema[1:]) & (f_ema[:-1] <= s_ema[:-1]) & (close[1:] > vwap[1:]) & (rsi_vals[1:] >= rsi_thresh)
    cross_dn = (f_ema[1:] < s_ema[1:]) & (f_ema[:-1] >= s_ema[:-1]) & (close[1:] < vwap[1:]) & (rsi_vals[1:] <= (100.0 - rsi_thresh))

    signal[1:][cross_up] = 1
    signal[1:][cross_dn] = -1

    stop_price[1:][cross_up] = low[1:][cross_up] - 0.5 * atr_vals[1:][cross_up]
    stop_price[1:][cross_dn] = high[1:][cross_dn] + 0.5 * atr_vals[1:][cross_dn]

    overlays = {}
    if include_overlays:
        overlays = {
            f"EMA {fast_len}": {"values": f_ema, "color": "#38bdf8", "style": "solid"},
            f"EMA {slow_len}": {"values": s_ema, "color": "#a855f7", "style": "solid"},
            "Session VWAP": {"values": vwap, "color": "#f59e0b", "style": "dashed"},
        }
    return {
        "signal": signal,
        "stop_price": stop_price,
        "target_price": None,
        "overlays": overlays,
    }
'''


def _load_custom_module(file_path: Path) -> dict[str, Any]:
    spec = importlib.util.spec_from_file_location(f"custom_strat_{file_path.stem}", file_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load strategy file: {file_path.name}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    if not hasattr(mod, "generate_signals"):
        raise ValueError("Custom strategy must define `generate_signals(df, params, include_overlays=True)`.")
    meta = getattr(mod, "STRATEGY_META", {})
    raw_params = meta.get("params", [])
    params = [p if isinstance(p, ParamSpec) else ParamSpec(**p) for p in raw_params]
    sid = f"custom_{file_path.stem}"
    return {
        "id": sid,
        "name": meta.get("name", file_path.stem.replace("_", " ").title()),
        "category": meta.get("category", "Custom Python"),
        "description": meta.get("description", "User-authored Python scalping strategy."),
        "recommended_session": meta.get("recommended_session", "NY_OPEN_KILLZONE"),
        "is_custom": True,
        "fn": mod.generate_signals,
        "code": file_path.read_text(),
        "params": params,
    }


def list_all_strategies() -> list[StrategyInfo]:
    out: list[StrategyInfo] = []
    for item in BUILTIN_STRATEGIES.values():
        out.append(
            StrategyInfo(
                id=item["id"],
                name=item["name"],
                category=item["category"],
                description=item["description"],
                is_custom=False,
                params=item["params"],
                recommended_session=item["recommended_session"],
                code=item["code"],
            )
        )
    for py_file in sorted(CUSTOM_STRATEGIES_DIR.glob("*.py")):
        if py_file.name.startswith("_"):
            continue
        try:
            c = _load_custom_module(py_file)
            out.append(
                StrategyInfo(
                    id=c["id"],
                    name=c["name"],
                    category=c["category"],
                    description=c["description"],
                    is_custom=True,
                    params=c["params"],
                    recommended_session=c["recommended_session"],
                    code=c["code"],
                )
            )
        except Exception:
            continue
    return out


def get_strategy_entry(strategy_id: str) -> dict[str, Any]:
    if strategy_id in BUILTIN_STRATEGIES:
        return BUILTIN_STRATEGIES[strategy_id]
    slug = strategy_id.removeprefix("custom_")
    py_file = CUSTOM_STRATEGIES_DIR / f"{slug}.py"
    if py_file.exists():
        return _load_custom_module(py_file)
    raise KeyError(f"Unknown strategy_id: {strategy_id}")


def save_custom_strategy(strategy_id: str, code: str) -> StrategyInfo:
    slug = re.sub(r"[^a-z0-9_]+", "_", strategy_id.lower().removeprefix("custom_")).strip("_")
    if not slug:
        raise ValueError("Invalid strategy ID.")
    target_path = CUSTOM_STRATEGIES_DIR / f"{slug}.py"
    target_path.write_text(code)
    try:
        loaded = _load_custom_module(target_path)
    except Exception as exc:
        target_path.unlink(missing_ok=True)
        raise ValueError(f"Strategy validation failed: {exc}") from exc

    return StrategyInfo(
        id=loaded["id"],
        name=loaded["name"],
        category=loaded["category"],
        description=loaded["description"],
        is_custom=True,
        params=loaded["params"],
        recommended_session=loaded["recommended_session"],
        code=loaded["code"],
    )


def delete_custom_strategy(strategy_id: str) -> bool:
    slug = strategy_id.removeprefix("custom_")
    target = CUSTOM_STRATEGIES_DIR / f"{slug}.py"
    if target.exists():
        target.unlink()
        return True
    return False


def compute_strategy_signals(
    strategy_id: str,
    df_5m: pl.DataFrame,
    strategy_params: dict[str, Any],
    include_overlays: bool = True,
) -> dict[str, Any]:
    entry = get_strategy_entry(strategy_id)
    merged_params = {p.name: p.default for p in entry["params"]}
    merged_params.update(strategy_params or {})
    res = entry["fn"](df_5m, merged_params, include_overlays=include_overlays)

    n = df_5m.height
    sig = np.asarray(res["signal"], dtype=np.int64)
    if len(sig) != n:
        raise ValueError(f"Strategy signal length ({len(sig)}) must match bar count ({n}).")

    stop_p = res.get("stop_price")
    target_p = res.get("target_price")
    return {
        "signal": sig,
        "stop_price": np.asarray(stop_p, dtype=np.float64) if stop_p is not None else None,
        "target_price": np.asarray(target_p, dtype=np.float64) if target_p is not None else None,
        "overlays": res.get("overlays", {}) if include_overlays else {},
    }
