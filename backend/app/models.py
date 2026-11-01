from __future__ import annotations

from typing import Any, Literal
from pydantic import BaseModel, Field


class DatasetMeta(BaseModel):
    id: str
    name: str
    symbol: str
    source: str
    timeframe: str = "5m"
    has_1m_subbars: bool = False
    has_bid_ask: bool = False
    bars_5m: int
    bars_1m: int = 0
    start_utc: str
    end_utc: str
    years_span: float
    file_size_mb: float


class DukascopyDownloadRequest(BaseModel):
    start_date: str = Field(default="2019-01-01", description="YYYY-MM-DD")
    end_date: str = Field(default="2026-10-30", description="YYYY-MM-DD")
    include_ask_spread: bool = Field(
        default=True,
        description="Also fetch ASK 1m candles to capture exact historical Bid-Ask spread",
    )
    dataset_name: str | None = None


class AlpacaDownloadRequest(BaseModel):
    symbol: str = Field(default="QQQ")
    start_date: str = Field(default="2018-01-01")
    end_date: str = Field(default="2026-10-30")
    api_key: str
    api_secret: str
    feed: Literal["iex", "sip"] = "iex"
    fetch_1m: bool = True


class SyntheticGenerateRequest(BaseModel):
    years: int = Field(default=8, ge=1, le=15)
    end_date: str = Field(default="2026-10-30")
    seed: int = 42
    include_1m: bool = True


class DownloadJobStatus(BaseModel):
    job_id: str
    provider: str
    status: Literal["running", "completed", "failed", "cancelled"]
    progress_pct: float
    message: str
    days_done: int = 0
    days_total: int = 0
    dataset_id: str | None = None
    error: str | None = None


class ParamSpec(BaseModel):
    name: str
    label: str
    type: Literal["int", "float", "bool", "select"]
    default: Any
    min: float | None = None
    max: float | None = None
    step: float | None = None
    options: list[str] | None = None
    description: str = ""


class StrategyInfo(BaseModel):
    id: str
    name: str
    category: str
    description: str
    is_custom: bool = False
    params: list[ParamSpec]
    recommended_session: str = "NY_OPEN_KILLZONE"
    code: str | None = None


class ExecutionConfig(BaseModel):
    instrument: str = "MNQ"
    initial_capital: float = 50_000.0
    point_value: float = 2.0
    tick_size: float = 0.25
    contracts: float = 5.0
    sizing_mode: Literal["fixed_contracts", "risk_pct", "fixed_dollar_risk"] = "fixed_contracts"
    risk_per_trade_pct: float = 0.5
    risk_per_trade_usd: float = 250.0

    # Scalping friction
    use_dataset_spread: bool = True
    spread_pts: float = 0.25
    slippage_pts: float = 0.25
    commission_per_side: float = 0.62

    # Intrabar fill resolution
    intrabar_mode: Literal["subbar_1m", "pessimistic_sl_first", "bar_path_heuristic"] = "subbar_1m"

    # Stop Loss & Take Profit overrides / defaults
    sl_mode: Literal["strategy_or_atr", "fixed_pts", "atr_mult"] = "strategy_or_atr"
    sl_pts: float = 25.0
    sl_atr_mult: float = 1.5
    tp_mode: Literal["rr_multiple", "fixed_pts", "atr_mult", "strategy_target"] = "rr_multiple"
    tp_rr: float = 2.0
    tp_pts: float = 50.0
    tp_atr_mult: float = 3.0

    # Scalping trade management
    partial_tp_enabled: bool = False
    partial_tp_rr: float = 1.0
    partial_tp_pct: float = 0.5
    move_sl_to_be_on_partial: bool = True

    breakeven_enabled: bool = True
    breakeven_trigger_rr: float = 1.0
    breakeven_offset_pts: float = 1.0

    trailing_stop_enabled: bool = False
    trailing_activation_rr: float = 1.5
    trailing_distance_pts: float = 15.0

    max_bars_in_trade: int = 18  # 18 * 5m = 90 mins max hold (0 = unlimited)
    allow_long: bool = True
    allow_short: bool = True
    reverse_on_opposite_signal: bool = False
    cooldown_bars: int = 1

    # NY Session & Prop-firm daily guardrails
    use_session_filter: bool = True
    entry_start_et: str = "09:30"
    entry_end_et: str = "11:30"
    flatten_et: str = "15:55"
    max_trades_per_day: int = 3
    daily_max_loss_usd: float = 0.0  # 0 = disabled
    daily_profit_target_usd: float = 0.0  # 0 = disabled


class BacktestRequest(BaseModel):
    dataset_id: str
    strategy_id: str
    strategy_params: dict[str, Any] = Field(default_factory=dict)
    execution: ExecutionConfig = Field(default_factory=ExecutionConfig)
    start_date: str | None = None
    end_date: str | None = None


class TradeRecord(BaseModel):
    id: int
    direction: Literal["LONG", "SHORT"]
    entry_bar_idx: int
    exit_bar_idx: int
    entry_ts: int  # unix seconds UTC
    exit_ts: int   # unix seconds UTC
    entry_et: str
    exit_et: str
    entry_price: float
    exit_price: float
    initial_sl: float
    initial_tp: float
    contracts: float
    gross_pts: float
    net_pts: float
    gross_pnl: float
    friction_cost: float
    net_pnl: float
    r_multiple: float
    mae_pts: float
    mfe_pts: float
    bars_held: int
    hold_minutes: int
    exit_reason: str
    partial_taken: bool


class OptimizationAxis(BaseModel):
    target: Literal["strategy", "execution"]
    name: str
    values: list[float]


class OptimizeRequest(BaseModel):
    dataset_id: str
    strategy_id: str
    strategy_params: dict[str, Any] = Field(default_factory=dict)
    execution: ExecutionConfig = Field(default_factory=ExecutionConfig)
    start_date: str | None = None
    end_date: str | None = None
    split_date: str | None = Field(
        default=None,
        description="Optional YYYY-MM-DD walk-forward split date (In-Sample <= split_date < Out-of-Sample)",
    )
    axis_x: OptimizationAxis
    axis_y: OptimizationAxis
    ranking_metric: Literal["net_pnl", "profit_factor", "sharpe", "expectancy_r", "calmar"] = "profit_factor"


class CustomStrategySaveRequest(BaseModel):
    strategy_id: str = Field(description="Slug identifier, e.g. my_orb_scalp")
    code: str


class UniversalSuiteSettings(BaseModel):
    # Master toggles
    show_fvg: bool = True
    show_ma: bool = True
    show_vwap: bool = True
    show_aem: bool = True
    show_mtf: bool = True

    # 1. Fair Value Gap [LuxAlgo]
    fvg_tf: str = "240"  # "Chart", "3", "5", "15", "60", "240", "D"
    fvg_threshold_pct: float = 0.0
    fvg_auto: bool = False
    fvg_unmitigated_levels: int = 0
    fvg_mitigation_levels: bool = False
    fvg_extend: int = 20
    fvg_auto_extend: bool = True
    fvg_dynamic: bool = False

    # 2. MA Cross
    ma_short_len: int = 9
    ma_long_len: int = 21

    # 3. VWAP & Bands
    vwap_anchor: Literal["Session", "Week", "Month", "Quarter", "Year"] = "Session"
    vwap_calc_mode: Literal["Standard Deviation", "Percentage"] = "Standard Deviation"
    vwap_show_band_1: bool = True
    vwap_mult_1: float = 1.0
    vwap_show_band_2: bool = False
    vwap_mult_2: float = 2.0
    vwap_show_band_3: bool = False
    vwap_mult_3: float = 3.0

    # 4. 0DTE Anchored Expected Move
    aem_round_to: int = 5
    aem_iv_mult: float = 1.0


class ReplayFrameRequest(BaseModel):
    dataset_id: str
    mode: Literal["init", "at_ts", "step", "jump_date", "random_ny_open", "next_ny_open"] = "init"
    sim_ts: int | None = None
    step_bars: int = 1  # number of base (1m) bars to advance when mode == "step"
    jump_date_et: str | None = None  # YYYY-MM-DD in America/New_York
    jump_time_et: str = "09:25"      # HH:MM in America/New_York
    timeframes: list[str] = Field(default_factory=lambda: ["3m"])
    limit: int = Field(default=380, ge=80, le=1500)
    suite_settings: UniversalSuiteSettings = Field(default_factory=UniversalSuiteSettings)

