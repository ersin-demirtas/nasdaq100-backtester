from __future__ import annotations

from pathlib import Path
from typing import Any

# Project root: .../nasdaq100-backtester
PROJECT_ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = PROJECT_ROOT / "data"
DATASETS_DIR = DATA_DIR / "datasets"
CACHE_DIR = DATA_DIR / "cache"
DUKASCOPY_CACHE_DIR = CACHE_DIR / "dukascopy"
CUSTOM_STRATEGIES_DIR = PROJECT_ROOT / "strategies" / "custom"

for _d in (DATASETS_DIR, DUKASCOPY_CACHE_DIR, CUSTOM_STRATEGIES_DIR):
    _d.mkdir(parents=True, exist_ok=True)


INSTRUMENT_PRESETS: dict[str, dict[str, Any]] = {
    "MNQ": {
        "id": "MNQ",
        "name": "MNQ — Micro E-mini Nasdaq-100 Futures",
        "point_value": 2.0,
        "tick_size": 0.25,
        "default_contracts": 5.0,
        "default_spread_pts": 0.25,
        "default_slippage_pts": 0.25,
        "default_commission_per_side": 0.62,  # ~$1.24 round turn per MNQ contract
        "currency": "USD",
        "description": "CME Micro E-mini ($2/pt, 0.25 tick). Ideal for scaling in/out & prop-firm scalping.",
    },
    "NQ": {
        "id": "NQ",
        "name": "NQ — E-mini Nasdaq-100 Futures",
        "point_value": 20.0,
        "tick_size": 0.25,
        "default_contracts": 1.0,
        "default_spread_pts": 0.25,
        "default_slippage_pts": 0.25,
        "default_commission_per_side": 2.10,  # ~$4.20 round turn per NQ contract
        "currency": "USD",
        "description": "CME E-mini ($20/pt, 0.25 tick). Institutional futures benchmark.",
    },
    "NAS100_CFD": {
        "id": "NAS100_CFD",
        "name": "NAS100 / USATECH — Index CFD",
        "point_value": 1.0,
        "tick_size": 0.10,
        "default_contracts": 10.0,
        "default_spread_pts": 1.00,
        "default_slippage_pts": 0.20,
        "default_commission_per_side": 0.0,  # Spread-baked CFD pricing
        "currency": "USD",
        "description": "CFD / Prop Firm NAS100 ($1/pt per contract, ~0.8–1.4 pt spread, zero commission).",
    },
    "QQQ": {
        "id": "QQQ",
        "name": "QQQ — Invesco Nasdaq-100 ETF",
        "point_value": 1.0,
        "tick_size": 0.01,
        "default_contracts": 100.0,
        "default_spread_pts": 0.01,
        "default_slippage_pts": 0.01,
        "default_commission_per_side": 0.0,
        "currency": "USD",
        "description": "Invesco QQQ ETF shares ($1/pt per share, $0.01 tick, zero commission).",
    },
}


SESSION_PRESETS: dict[str, dict[str, Any]] = {
    "NY_OPEN_KILLZONE": {
        "id": "NY_OPEN_KILLZONE",
        "name": "NY Open Killzone (09:30–11:00 ET)",
        "entry_start_et": "09:30",
        "entry_end_et": "11:00",
        "flatten_et": "11:30",
    },
    "NY_SILVER_BULLET": {
        "id": "NY_SILVER_BULLET",
        "name": "ICT AM Silver Bullet (10:00–11:00 ET)",
        "entry_start_et": "10:00",
        "entry_end_et": "11:00",
        "flatten_et": "11:45",
    },
    "NY_AM_SESSION": {
        "id": "NY_AM_SESSION",
        "name": "NY Morning Session (09:30–12:00 ET)",
        "entry_start_et": "09:30",
        "entry_end_et": "12:00",
        "flatten_et": "12:30",
    },
    "NY_RTH": {
        "id": "NY_RTH",
        "name": "US Regular Trading Hours (09:30–15:45 ET)",
        "entry_start_et": "09:30",
        "entry_end_et": "15:45",
        "flatten_et": "15:55",
    },
    "NY_PM_POWER": {
        "id": "NY_PM_POWER",
        "name": "NY PM / Power Hour (13:30–15:45 ET)",
        "entry_start_et": "13:30",
        "entry_end_et": "15:45",
        "flatten_et": "15:55",
    },
    "LONDON_NY_OVERLAP": {
        "id": "LONDON_NY_OVERLAP",
        "name": "London + NY AM (03:00–11:30 ET)",
        "entry_start_et": "03:00",
        "entry_end_et": "11:30",
        "flatten_et": "15:55",
    },
    "ALL_HOURS": {
        "id": "ALL_HOURS",
        "name": "All Globex / 23h Session (No Entry Window Filter)",
        "entry_start_et": "00:00",
        "entry_end_et": "23:55",
        "flatten_et": "",
    },
}
