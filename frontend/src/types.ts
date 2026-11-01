export interface DatasetMeta {
  id: string;
  name: string;
  symbol: string;
  source: string;
  timeframe: string;
  has_1m_subbars: boolean;
  has_bid_ask: boolean;
  bars_5m: number;
  bars_1m: number;
  start_utc: string;
  end_utc: string;
  years_span: number;
  file_size_mb: number;
}

export interface InstrumentPreset {
  id: string;
  name: string;
  point_value: number;
  tick_size: number;
  default_contracts: number;
  default_spread_pts: number;
  default_slippage_pts: number;
  default_commission_per_side: number;
  currency: string;
  description: string;
}

export interface SessionPreset {
  id: string;
  name: string;
  entry_start_et: string;
  entry_end_et: string;
  flatten_et: string;
}

export interface ParamSpec {
  name: string;
  label: string;
  type: 'int' | 'float' | 'bool' | 'select';
  default: number | boolean | string;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  description?: string;
}

export interface StrategyInfo {
  id: string;
  name: string;
  category: string;
  description: string;
  is_custom: boolean;
  params: ParamSpec[];
  recommended_session: string;
  code?: string;
}

export interface ExecutionConfig {
  instrument: string;
  initial_capital: number;
  point_value: number;
  tick_size: number;
  contracts: number;
  sizing_mode: 'fixed_contracts' | 'risk_pct' | 'fixed_dollar_risk';
  risk_per_trade_pct: number;
  risk_per_trade_usd: number;

  use_dataset_spread: boolean;
  spread_pts: number;
  slippage_pts: number;
  commission_per_side: number;

  intrabar_mode: 'subbar_1m' | 'pessimistic_sl_first' | 'bar_path_heuristic';

  sl_mode: 'strategy_or_atr' | 'fixed_pts' | 'atr_mult';
  sl_pts: number;
  sl_atr_mult: number;
  tp_mode: 'rr_multiple' | 'fixed_pts' | 'atr_mult' | 'strategy_target';
  tp_rr: number;
  tp_pts: number;
  tp_atr_mult: number;

  partial_tp_enabled: boolean;
  partial_tp_rr: number;
  partial_tp_pct: number;
  move_sl_to_be_on_partial: boolean;

  breakeven_enabled: boolean;
  breakeven_trigger_rr: number;
  breakeven_offset_pts: number;

  trailing_stop_enabled: boolean;
  trailing_activation_rr: number;
  trailing_distance_pts: number;

  max_bars_in_trade: number;
  allow_long: boolean;
  allow_short: boolean;
  reverse_on_opposite_signal: boolean;
  cooldown_bars: number;

  use_session_filter: boolean;
  entry_start_et: string;
  entry_end_et: string;
  flatten_et: string;
  max_trades_per_day: number;
  daily_max_loss_usd: number;
  daily_profit_target_usd: number;
}

export interface TradeRecord {
  id: number;
  direction: 'LONG' | 'SHORT';
  entry_bar_idx: number;
  exit_bar_idx: number;
  entry_ts: number;
  exit_ts: number;
  entry_et: string;
  exit_et: string;
  entry_price: number;
  exit_price: number;
  initial_sl: number;
  initial_tp: number;
  contracts: number;
  gross_pts: number;
  net_pts: number;
  gross_pnl: number;
  friction_cost: number;
  net_pnl: number;
  r_multiple: number;
  mae_pts: number;
  mfe_pts: number;
  bars_held: number;
  hold_minutes: number;
  exit_reason: string;
  partial_taken: boolean;
}

export interface BacktestKPIs {
  total_trades: number;
  net_pnl: number;
  net_return_pct: number;
  gross_pnl: number;
  total_friction_cost: number;
  profit_factor: number;
  win_rate_pct: number;
  expectancy_usd: number;
  expectancy_r: number;
  avg_win_usd: number;
  avg_loss_usd: number;
  payoff_ratio: number;
  max_drawdown_usd: number;
  max_drawdown_pct: number;
  sharpe_ratio: number;
  sortino_ratio: number;
  calmar_ratio: number;
  avg_hold_minutes: number;
  max_consec_wins: number;
  max_consec_losses: number;
  long_trades: number;
  short_trades: number;
  long_win_rate_pct: number;
  short_win_rate_pct: number;
  long_net_pnl: number;
  short_net_pnl: number;
}

export interface EquityPoint {
  time: number;
  net_equity: number;
  gross_equity: number;
  drawdown_pct: number;
  drawdown_usd: number;
}

export interface BacktestResult {
  dataset_id: string;
  strategy_id: string;
  bars_tested: number;
  used_1m_subbars: boolean;
  engine_ms: number;
  total_ms: number;
  kpis: BacktestKPIs;
  equity_curve: EquityPoint[];
  time_of_day: Array<{ slot: string; trades: number; net_pnl: number; win_rate_pct: number; avg_r: number }>;
  day_of_week: Array<{ day: string; trades: number; net_pnl: number; win_rate_pct: number }>;
  monthly_matrix: Array<{
    year: number;
    months: Record<string, { usd: number; pct: number; trades: number } | null>;
    year_total_usd: number;
    year_total_pct: number;
  }>;
  exit_reasons: Array<{ reason: string; trades: number; pct_of_trades: number; net_pnl: number; avg_r: number }>;
  r_distribution: Array<{ bucket: string; count: number }>;
  mae_mfe_scatter: Array<{
    id: number;
    mae_pts: number;
    mfe_pts: number;
    net_pnl: number;
    r_multiple: number;
    win: boolean;
  }>;
  trades: TradeRecord[];
}

export interface CandleBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  spread: number;
  et: string;
}

export interface OverlayLine {
  name: string;
  color: string;
  style: string;
  data: Array<{ time: number; value: number }>;
}

export interface CandleWindowResponse {
  candles: CandleBar[];
  overlays: OverlayLine[];
  total_bars: number;
  window_start_idx: number;
  window_end_idx: number;
  has_more_left: boolean;
  has_more_right: boolean;
}

export interface DownloadJobStatus {
  job_id: string;
  provider: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  progress_pct: number;
  message: string;
  days_done: number;
  days_total: number;
  dataset_id?: string | null;
  error?: string | null;
}

export interface FastCellSummary {
  total_trades: number;
  net_pnl: number;
  net_return_pct: number;
  profit_factor: number;
  win_rate_pct: number;
  expectancy_r: number;
  max_drawdown_pct: number;
  sharpe: number;
  calmar: number;
}

export interface OptimizeCell {
  x: number;
  y: number;
  full: FastCellSummary;
  in_sample?: FastCellSummary;
  out_of_sample?: FastCellSummary;
}

export interface OptimizeResult {
  axis_x: { target: 'strategy' | 'execution'; name: string; values: number[] };
  axis_y: { target: 'strategy' | 'execution'; name: string; values: number[] };
  ranking_metric: string;
  split_date?: string | null;
  total_combinations: number;
  elapsed_ms: number;
  cells: OptimizeCell[];
  top_combinations: OptimizeCell[];
}

export interface BootstrapResponse {
  datasets: DatasetMeta[];
  strategies: StrategyInfo[];
  instrument_presets: Record<string, InstrumentPreset>;
  session_presets: Record<string, SessionPreset>;
  custom_strategy_template: string;
}

export interface UniversalSuiteSettings {
  show_fvg: boolean;
  show_ma: boolean;
  show_vwap: boolean;
  show_aem: boolean;
  show_mtf: boolean;

  fvg_tf: string;
  fvg_threshold_pct: number;
  fvg_auto: boolean;
  fvg_unmitigated_levels: number;
  fvg_mitigation_levels: boolean;
  fvg_extend: number;
  fvg_auto_extend: boolean;
  fvg_dynamic: boolean;

  ma_short_len: number;
  ma_long_len: number;

  vwap_anchor: 'Session' | 'Week' | 'Month' | 'Quarter' | 'Year';
  vwap_calc_mode: 'Standard Deviation' | 'Percentage';
  vwap_show_band_1: boolean;
  vwap_mult_1: number;
  vwap_show_band_2: boolean;
  vwap_mult_2: number;
  vwap_show_band_3: boolean;
  vwap_mult_3: number;

  aem_round_to: number;
  aem_iv_mult: number;
}

export interface FvgBox {
  start_ts: number;
  end_ts: number;
  max: number;
  min: number;
  is_bull: boolean;
  tf: string;
}

export interface FvgLine {
  start_ts: number;
  end_ts: number;
  price: number;
  is_bull: boolean;
}

export interface NullablePoint {
  time: number;
  value: number | null;
}

export interface ValuePoint {
  time: number;
  value: number;
}

export interface MtfRightCandle {
  label: string;
  offset: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface SuitePayload {
  fvg?: {
    boxes: FvgBox[];
    mitigation_lines: FvgLine[];
    unmitigated_lines: FvgLine[];
    dynamic?: {
      bull_max: NullablePoint[];
      bull_min: NullablePoint[];
      bear_max: NullablePoint[];
      bear_min: NullablePoint[];
    } | null;
  };
  ma?: {
    short_len: number;
    long_len: number;
    short_ma: ValuePoint[];
    long_ma: ValuePoint[];
    crosses: Array<{ time: number; price: number }>;
  };
  vwap?: {
    vwap: ValuePoint[];
    u1?: ValuePoint[];
    l1?: ValuePoint[];
    u2?: ValuePoint[];
    l2?: ValuePoint[];
    u3?: ValuePoint[];
    l3?: ValuePoint[];
  };
  aem?: {
    center: NullablePoint[];
    em_high: NullablePoint[];
    em_low: NullablePoint[];
    run_high: NullablePoint[];
    run_low: NullablePoint[];
  };
  mtf_candles?: MtfRightCandle[];
}

export interface ReplayPanePayload {
  tf: string;
  candles: CandleBar[];
  suite: SuitePayload;
}

export interface SteppedSubBar {
  ts: number;
  et: string;
  open: number;
  high: number;
  low: number;
  close: number;
  spread: number;
}

export interface ReplayFrameResponse {
  dataset_id: string;
  base_tf: string;
  sim_ts: number;
  sim_et: string;
  bar_index: number;
  total_bars: number;
  has_next: boolean;
  mid: number;
  bid: number;
  ask: number;
  spread: number;
  stepped_bars: SteppedSubBar[];
  panes: Record<string, ReplayPanePayload>;
  elapsed_ms: number;
}

export interface SimPosition {
  id: number;
  direction: 'LONG' | 'SHORT';
  entryTs: number;
  entryEt: string;
  entryPrice: number;
  contracts: number;
  initialContracts: number;
  slPrice: number | null;
  tpPrice: number | null;
  initialSlDist: number;
  realizedPnl: number;
  commissionPaid: number;
}

export interface SimPendingOrder {
  id: number;
  direction: 'LONG' | 'SHORT';
  orderType: 'LIMIT' | 'STOP';
  triggerPrice: number;
  contracts: number;
  slPts: number;
  tpPts: number;
  createdEt: string;
}

export interface SimClosedTrade {
  id: number;
  direction: 'LONG' | 'SHORT';
  entryTs: number;
  exitTs: number;
  entryEt: string;
  exitEt: string;
  entryPrice: number;
  exitPrice: number;
  contracts: number;
  netPts: number;
  netPnl: number;
  rMultiple: number;
  exitReason: string;
}

