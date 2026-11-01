import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  BarChart3,
  CandlestickChart,
  Code2,
  Database,
  ListOrdered,
  Play,
  ShieldAlert,
  Sliders,
  Sparkles,
  Zap,
} from 'lucide-react';
import { api } from './api';
import { CandlestickTerminal } from './components/CandlestickTerminal';
import { DataHubModal } from './components/DataHubModal';
import { OptimizerPanel } from './components/OptimizerPanel';
import { PerformanceDashboard } from './components/PerformanceDashboard';
import { ReplaySimulator } from './components/ReplaySimulator';
import { StrategyStudio } from './components/StrategyStudio';
import { TradeLogTable } from './components/TradeLogTable';
import type {
  BacktestResult,
  DatasetMeta,
  ExecutionConfig,
  InstrumentPreset,
  SessionPreset,
  StrategyInfo,
  TradeRecord,
} from './types';

const DEFAULT_EXECUTION: ExecutionConfig = {
  instrument: 'MNQ',
  initial_capital: 50000,
  point_value: 2.0,
  tick_size: 0.25,
  contracts: 5,
  sizing_mode: 'fixed_contracts',
  risk_per_trade_pct: 0.5,
  risk_per_trade_usd: 250,

  use_dataset_spread: true,
  spread_pts: 0.25,
  slippage_pts: 0.25,
  commission_per_side: 0.62,

  intrabar_mode: 'subbar_1m',

  sl_mode: 'strategy_or_atr',
  sl_pts: 25,
  sl_atr_mult: 1.5,
  tp_mode: 'rr_multiple',
  tp_rr: 2.0,
  tp_pts: 50,
  tp_atr_mult: 3.0,

  partial_tp_enabled: false,
  partial_tp_rr: 1.0,
  partial_tp_pct: 0.5,
  move_sl_to_be_on_partial: true,

  breakeven_enabled: true,
  breakeven_trigger_rr: 1.0,
  breakeven_offset_pts: 1.0,

  trailing_stop_enabled: false,
  trailing_activation_rr: 1.5,
  trailing_distance_pts: 15.0,

  max_bars_in_trade: 18,
  allow_long: true,
  allow_short: true,
  reverse_on_opposite_signal: false,
  cooldown_bars: 1,

  use_session_filter: true,
  entry_start_et: '09:30',
  entry_end_et: '11:30',
  flatten_et: '15:55',
  max_trades_per_day: 3,
  daily_max_loss_usd: 0,
  daily_profit_target_usd: 0,
};

export const App: React.FC = () => {
  const [datasets, setDatasets] = useState<DatasetMeta[]>([]);
  const [strategies, setStrategies] = useState<StrategyInfo[]>([]);
  const [instruments, setInstruments] = useState<Record<string, InstrumentPreset>>({});
  const [sessions, setSessions] = useState<Record<string, SessionPreset>>({});
  const [customTemplate, setCustomTemplate] = useState<string>('');

  const [datasetId, setDatasetId] = useState<string>('');
  const [strategyId, setStrategyId] = useState<string>('ny_orb_vwap');
  const [strategyParams, setStrategyParams] = useState<Record<string, unknown>>({});
  const [execution, setExecution] = useState<ExecutionConfig>(DEFAULT_EXECUTION);
  const [startDate, setStartDate] = useState<string>('');
  const [endDate, setEndDate] = useState<string>('');

  const [activeTab, setActiveTab] = useState<'replay' | 'analytics' | 'chart' | 'trades' | 'optimizer' | 'studio'>(
    'replay'
  );
  const [dataHubOpen, setDataHubOpen] = useState<boolean>(false);

  const [running, setRunning] = useState<boolean>(false);
  const [booting, setBooting] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [selectedTrade, setSelectedTrade] = useState<TradeRecord | null>(null);

  const activeStrategy = useMemo(
    () => strategies.find((s) => s.id === strategyId) || strategies[0],
    [strategies, strategyId]
  );

  const activeDataset = useMemo(
    () => datasets.find((d) => d.id === datasetId) || datasets[0],
    [datasets, datasetId]
  );

  const buildDefaultParams = (strat?: StrategyInfo): Record<string, unknown> => {
    if (!strat) return {};
    const out: Record<string, unknown> = {};
    for (const p of strat.params) {
      out[p.name] = p.default;
    }
    return out;
  };

  const executeBacktest = useCallback(
    async (override?: {
      dsId?: string;
      stId?: string;
      sParams?: Record<string, unknown>;
      exec?: ExecutionConfig;
    }) => {
      const targetDs = override?.dsId ?? datasetId;
      const targetSt = override?.stId ?? strategyId;
      if (!targetDs || !targetSt) return;

      setRunning(true);
      setError(null);
      try {
        const res = await api.runBacktest({
          dataset_id: targetDs,
          strategy_id: targetSt,
          strategy_params: override?.sParams ?? strategyParams,
          execution: override?.exec ?? execution,
          start_date: startDate || undefined,
          end_date: endDate || undefined,
        });
        setResult(res);
        setSelectedTrade(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setRunning(false);
      }
    },
    [datasetId, strategyId, strategyParams, execution, startDate, endDate]
  );

  useEffect(() => {
    (async () => {
      try {
        const boot = await api.bootstrap();
        setDatasets(boot.datasets);
        setStrategies(boot.strategies);
        setInstruments(boot.instrument_presets);
        setSessions(boot.session_presets);
        setCustomTemplate(boot.custom_strategy_template);

        const ds0 = boot.datasets[0]?.id || '';
        const st0 = boot.strategies[0];
        const p0 = buildDefaultParams(st0);
        setDatasetId(ds0);
        if (st0) {
          setStrategyId(st0.id);
          setStrategyParams(p0);
        }
        if (ds0 && st0) {
          await executeBacktest({ dsId: ds0, stId: st0.id, sParams: p0, exec: DEFAULT_EXECUTION });
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBooting(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSelectStrategy = (id: string) => {
    setStrategyId(id);
    const st = strategies.find((s) => s.id === id);
    const defaults = buildDefaultParams(st);
    setStrategyParams(defaults);
    if (st?.recommended_session && sessions[st.recommended_session]) {
      const sess = sessions[st.recommended_session];
      setExecution((prev) => ({
        ...prev,
        use_session_filter: st.recommended_session !== 'ALL_HOURS',
        entry_start_et: sess.entry_start_et,
        entry_end_et: sess.entry_end_et,
        flatten_et: sess.flatten_et,
      }));
    }
  };

  const applyInstrumentPreset = (instKey: string) => {
    const preset = instruments[instKey];
    if (!preset) return;
    setExecution((prev) => ({
      ...prev,
      instrument: preset.id,
      point_value: preset.point_value,
      tick_size: preset.tick_size,
      contracts: preset.default_contracts,
      spread_pts: preset.default_spread_pts,
      slippage_pts: preset.default_slippage_pts,
      commission_per_side: preset.default_commission_per_side,
    }));
  };

  const applySessionPreset = (sessKey: string) => {
    const sess = sessions[sessKey];
    if (!sess) return;
    setExecution((prev) => ({
      ...prev,
      use_session_filter: sessKey !== 'ALL_HOURS',
      entry_start_et: sess.entry_start_et,
      entry_end_et: sess.entry_end_et,
      flatten_et: sess.flatten_et,
    }));
  };

  const handleInspectTrade = (trade: TradeRecord) => {
    setSelectedTrade(trade);
    setActiveTab('chart');
  };

  if (booting) {
    return (
      <div className="min-h-screen bg-[#060911] flex flex-col items-center justify-center text-slate-300 gap-3">
        <Zap className="w-8 h-8 text-cyan-400 animate-pulse" />
        <div className="font-mono text-sm">Initializing NAS100 5m Numba Backtesting Engine & Parquet Store...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#060911] text-slate-100 flex flex-col">
      {/* Top Institutional Terminal Header */}
      <header className="bg-slate-950/90 border-b border-slate-800/90 px-4 py-2.5 flex flex-wrap items-center justify-between gap-3 sticky top-0 z-30 backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center shadow-lg shadow-cyan-900/40">
            <Zap className="w-4 h-4 text-white fill-current" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-bold tracking-tight text-white text-sm">NAS100 ScalpLab</span>
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-cyan-500/15 text-cyan-300 border border-cyan-500/30">
                5m + 1m NUMBA ENGINE
              </span>
            </div>
            <div className="text-[11px] text-slate-400">
              Local 5–10 Year Nasdaq-100 Intraday Scalping Backtester
            </div>
          </div>
        </div>

        {/* Dataset & Date Controls */}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <select
            value={datasetId}
            onChange={(e) => setDatasetId(e.target.value)}
            className="bg-slate-900 border border-slate-700/80 rounded-lg px-2.5 py-1.5 text-slate-100 max-w-xs font-medium"
          >
            {datasets.map((ds) => (
              <option key={ds.id} value={ds.id}>
                {ds.name} ({ds.bars_5m.toLocaleString()} bars)
              </option>
            ))}
          </select>

          <button
            onClick={() => setDataHubOpen(true)}
            className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-cyan-300 font-medium flex items-center gap-1.5 transition"
          >
            <Database className="w-3.5 h-3.5" /> Data Hub (5–10y)
          </button>

          {activeTab !== 'replay' && (
            <>
              <div className="hidden xl:flex items-center gap-1.5 bg-slate-900 border border-slate-800 rounded-lg px-2 py-1 font-mono text-[11px]">
                <span className="text-slate-500">Range:</span>
                <input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  className="bg-transparent text-slate-200 outline-none"
                  title="Optional filter start date"
                />
                <span className="text-slate-600">→</span>
                <input
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  className="bg-transparent text-slate-200 outline-none"
                  title="Optional filter end date"
                />
              </div>

              {result && (
                <div className="hidden md:flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-900/90 border border-slate-800 font-mono text-[11px] text-slate-300">
                  <Activity className="w-3.5 h-3.5 text-emerald-400" />
                  <span>{result.bars_tested.toLocaleString()} 5m bars</span>
                  {result.used_1m_subbars && <span className="text-emerald-400">· 1m Exact</span>}
                  <span className="text-cyan-400">· {result.engine_ms}ms</span>
                </div>
              )}

              <button
                onClick={() => executeBacktest()}
                disabled={running}
                className="px-4 py-1.5 rounded-lg bg-gradient-to-r from-emerald-500 to-cyan-500 hover:from-emerald-400 hover:to-cyan-400 disabled:opacity-50 text-slate-950 font-bold flex items-center gap-1.5 shadow-lg shadow-cyan-950/50 transition cursor-pointer"
              >
                <Play className="w-3.5 h-3.5 fill-current" />
                {running ? 'Simulating...' : 'Run Backtest'}
              </button>
            </>
          )}
        </div>
      </header>

      {/* Main Split Workspace */}
      <div className="flex-1 flex flex-col lg:flex-row overflow-hidden">
        {/* Left Scalping Configuration Sidebar (Automated Mode Only) */}
        {activeTab !== 'replay' && (
        <aside className="w-full lg:w-84 xl:w-92 shrink-0 bg-slate-950/65 border-b lg:border-b-0 lg:border-r border-slate-800/80 overflow-y-auto p-3.5 space-y-4 text-xs max-h-[calc(100vh-57px)]">
          {/* 1. Strategy Selection & Params */}
          <section className="bg-slate-900/75 border border-slate-800/90 rounded-xl p-3 space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="font-bold text-white flex items-center gap-1.5">
                <Sliders className="w-3.5 h-3.5 text-cyan-400" /> Scalping Strategy
              </span>
              {activeStrategy && (
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-800 text-cyan-300">
                  {activeStrategy.category}
                </span>
              )}
            </div>

            <select
              value={strategyId}
              onChange={(e) => handleSelectStrategy(e.target.value)}
              className="w-full bg-slate-950 border border-slate-700/80 rounded-lg px-2.5 py-1.5 text-white font-medium"
            >
              {strategies.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.is_custom ? `★ ${s.name}` : s.name}
                </option>
              ))}
            </select>

            {activeStrategy && (
              <p className="text-[11px] text-slate-400 leading-relaxed">{activeStrategy.description}</p>
            )}

            {activeStrategy && activeStrategy.params.length > 0 && (
              <div className="space-y-2 pt-2 border-t border-slate-800/80">
                {activeStrategy.params.map((p) => {
                  const val = strategyParams[p.name] ?? p.default;
                  if (p.type === 'bool') {
                    return (
                      <label key={p.name} className="flex items-center justify-between text-slate-300 cursor-pointer py-0.5">
                        <span>{p.label}</span>
                        <input
                          type="checkbox"
                          checked={Boolean(val)}
                          onChange={(e) => setStrategyParams((prev) => ({ ...prev, [p.name]: e.target.checked }))}
                          className="accent-cyan-500"
                        />
                      </label>
                    );
                  }
                  return (
                    <div key={p.name} className="flex items-center justify-between gap-2">
                      <label className="text-slate-300">{p.label}</label>
                      <input
                        type="number"
                        min={p.min}
                        max={p.max}
                        step={p.step ?? (p.type === 'int' ? 1 : 0.1)}
                        value={Number(val)}
                        onChange={(e) =>
                          setStrategyParams((prev) => ({
                            ...prev,
                            [p.name]: p.type === 'int' ? parseInt(e.target.value || '0', 10) : parseFloat(e.target.value || '0'),
                          }))
                        }
                        className="w-24 bg-slate-950 border border-slate-800 rounded px-2 py-1 text-right font-mono text-cyan-300"
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* 2. Instrument, Sizing & Scalping Friction */}
          <section className="bg-slate-900/75 border border-slate-800/90 rounded-xl p-3 space-y-2.5">
            <div className="font-bold text-white flex items-center justify-between">
              <span>Instrument & Friction</span>
              <span className="text-[10px] font-mono text-amber-300">${execution.point_value}/pt</span>
            </div>

            <div className="grid grid-cols-4 gap-1">
              {Object.keys(instruments).map((k) => (
                <button
                  key={k}
                  onClick={() => applyInstrumentPreset(k)}
                  className={`py-1 rounded font-mono text-[11px] border transition ${
                    execution.instrument === k
                      ? 'bg-cyan-500/20 border-cyan-500/50 text-cyan-300 font-bold'
                      : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-white'
                  }`}
                >
                  {k === 'NAS100_CFD' ? 'CFD' : k}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-slate-400 block mb-0.5">Initial Capital ($)</label>
                <input
                  type="number"
                  value={execution.initial_capital}
                  onChange={(e) => setExecution((p) => ({ ...p, initial_capital: Number(e.target.value) }))}
                  className="w-full bg-slate-950 border border-slate-800 rounded px-2 py-1 font-mono text-white"
                />
              </div>
              <div>
                <label className="text-slate-400 block mb-0.5">Sizing Mode</label>
                <select
                  value={execution.sizing_mode}
                  onChange={(e) =>
                    setExecution((p) => ({ ...p, sizing_mode: e.target.value as ExecutionConfig['sizing_mode'] }))
                  }
                  className="w-full bg-slate-950 border border-slate-800 rounded px-2 py-1 text-white"
                >
                  <option value="fixed_contracts">Fixed Contracts</option>
                  <option value="risk_pct">% Equity Risk</option>
                  <option value="fixed_dollar_risk">Fixed $ Risk</option>
                </select>
              </div>
            </div>

            {execution.sizing_mode === 'fixed_contracts' && (
              <div className="flex items-center justify-between">
                <span className="text-slate-300">Contracts / Lots</span>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={execution.contracts}
                  onChange={(e) => setExecution((p) => ({ ...p, contracts: Number(e.target.value) }))}
                  className="w-24 bg-slate-950 border border-slate-800 rounded px-2 py-1 text-right font-mono text-white"
                />
              </div>
            )}
            {execution.sizing_mode === 'risk_pct' && (
              <div className="flex items-center justify-between">
                <span className="text-slate-300">Risk Per Scalp (%)</span>
                <input
                  type="number"
                  step={0.1}
                  value={execution.risk_per_trade_pct}
                  onChange={(e) => setExecution((p) => ({ ...p, risk_per_trade_pct: Number(e.target.value) }))}
                  className="w-24 bg-slate-950 border border-slate-800 rounded px-2 py-1 text-right font-mono text-white"
                />
              </div>
            )}
            {execution.sizing_mode === 'fixed_dollar_risk' && (
              <div className="flex items-center justify-between">
                <span className="text-slate-300">Risk Per Scalp ($)</span>
                <input
                  type="number"
                  step={25}
                  value={execution.risk_per_trade_usd}
                  onChange={(e) => setExecution((p) => ({ ...p, risk_per_trade_usd: Number(e.target.value) }))}
                  className="w-24 bg-slate-950 border border-slate-800 rounded px-2 py-1 text-right font-mono text-white"
                />
              </div>
            )}

            <div className="pt-2 border-t border-slate-800/80 space-y-2">
              <div>
                <label className="text-slate-400 block mb-0.5">Intrabar SL/TP Fill Resolution</label>
                <select
                  value={execution.intrabar_mode}
                  onChange={(e) =>
                    setExecution((p) => ({ ...p, intrabar_mode: e.target.value as ExecutionConfig['intrabar_mode'] }))
                  }
                  className="w-full bg-slate-950 border border-slate-800 rounded px-2 py-1 text-emerald-300 font-medium"
                >
                  <option value="subbar_1m">
                    1m Sub-Bar Exact {activeDataset?.has_1m_subbars ? '(Active)' : '(Fallback SL-First)'}
                  </option>
                  <option value="pessimistic_sl_first">5m Pessimistic (SL First on Conflict)</option>
                  <option value="bar_path_heuristic">5m OHLC Path Heuristic</option>
                </select>
              </div>

              <label className="flex items-center justify-between text-slate-300 cursor-pointer">
                <span>Use Historical Bar Bid-Ask Spread</span>
                <input
                  type="checkbox"
                  checked={execution.use_dataset_spread}
                  onChange={(e) => setExecution((p) => ({ ...p, use_dataset_spread: e.target.checked }))}
                  className="accent-cyan-500"
                />
              </label>

              <div className="grid grid-cols-3 gap-1.5">
                <div>
                  <label className="text-[10px] text-slate-400 block">Min Spd (pt)</label>
                  <input
                    type="number"
                    step={0.1}
                    value={execution.spread_pts}
                    onChange={(e) => setExecution((p) => ({ ...p, spread_pts: Number(e.target.value) }))}
                    className="w-full bg-slate-950 border border-slate-800 rounded px-1.5 py-1 font-mono text-white"
                  />
                </div>
                <div>
                  <label className="text-[10px] text-slate-400 block">Slippage (pt)</label>
                  <input
                    type="number"
                    step={0.1}
                    value={execution.slippage_pts}
                    onChange={(e) => setExecution((p) => ({ ...p, slippage_pts: Number(e.target.value) }))}
                    className="w-full bg-slate-950 border border-slate-800 rounded px-1.5 py-1 font-mono text-white"
                  />
                </div>
                <div>
                  <label className="text-[10px] text-slate-400 block">Comm/Side ($)</label>
                  <input
                    type="number"
                    step={0.1}
                    value={execution.commission_per_side}
                    onChange={(e) => setExecution((p) => ({ ...p, commission_per_side: Number(e.target.value) }))}
                    className="w-full bg-slate-950 border border-slate-800 rounded px-1.5 py-1 font-mono text-white"
                  />
                </div>
              </div>
            </div>
          </section>

          {/* 3. Stop Loss, Take Profit, Break-Even & Time Stop */}
          <section className="bg-slate-900/75 border border-slate-800/90 rounded-xl p-3 space-y-2.5">
            <div className="font-bold text-white">SL / TP & Scalp Management</div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-slate-400 block mb-0.5">Stop-Loss Mode</label>
                <select
                  value={execution.sl_mode}
                  onChange={(e) => setExecution((p) => ({ ...p, sl_mode: e.target.value as ExecutionConfig['sl_mode'] }))}
                  className="w-full bg-slate-950 border border-slate-800 rounded px-2 py-1 text-white"
                >
                  <option value="strategy_or_atr">Strategy Structure / ATR</option>
                  <option value="atr_mult">ATR(14) Multiple</option>
                  <option value="fixed_pts">Fixed Points</option>
                </select>
              </div>
              <div>
                <label className="text-slate-400 block mb-0.5">
                  {execution.sl_mode === 'fixed_pts' ? 'Stop (Pts)' : 'Fallback ATR Mult'}
                </label>
                <input
                  type="number"
                  step={execution.sl_mode === 'fixed_pts' ? 2.5 : 0.25}
                  value={execution.sl_mode === 'fixed_pts' ? execution.sl_pts : execution.sl_atr_mult}
                  onChange={(e) =>
                    setExecution((p) =>
                      p.sl_mode === 'fixed_pts'
                        ? { ...p, sl_pts: Number(e.target.value) }
                        : { ...p, sl_atr_mult: Number(e.target.value) }
                    )
                  }
                  className="w-full bg-slate-950 border border-slate-800 rounded px-2 py-1 font-mono text-rose-300"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-slate-400 block mb-0.5">Take-Profit Mode</label>
                <select
                  value={execution.tp_mode}
                  onChange={(e) => setExecution((p) => ({ ...p, tp_mode: e.target.value as ExecutionConfig['tp_mode'] }))}
                  className="w-full bg-slate-950 border border-slate-800 rounded px-2 py-1 text-white"
                >
                  <option value="rr_multiple">Reward:Risk (RR)</option>
                  <option value="fixed_pts">Fixed Points</option>
                  <option value="atr_mult">ATR(14) Multiple</option>
                  <option value="strategy_target">Strategy Target</option>
                </select>
              </div>
              <div>
                <label className="text-slate-400 block mb-0.5">
                  {execution.tp_mode === 'fixed_pts' ? 'Target (Pts)' : execution.tp_mode === 'atr_mult' ? 'ATR Mult' : 'Target RR'}
                </label>
                <input
                  type="number"
                  step={0.25}
                  value={
                    execution.tp_mode === 'fixed_pts'
                      ? execution.tp_pts
                      : execution.tp_mode === 'atr_mult'
                      ? execution.tp_atr_mult
                      : execution.tp_rr
                  }
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setExecution((p) =>
                      p.tp_mode === 'fixed_pts'
                        ? { ...p, tp_pts: v }
                        : p.tp_mode === 'atr_mult'
                        ? { ...p, tp_atr_mult: v }
                        : { ...p, tp_rr: v }
                    );
                  }}
                  className="w-full bg-slate-950 border border-slate-800 rounded px-2 py-1 font-mono text-emerald-300"
                />
              </div>
            </div>

            <div className="space-y-1.5 pt-1 border-t border-slate-800/80">
              <div className="flex items-center justify-between">
                <label className="flex items-center gap-1.5 text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={execution.breakeven_enabled}
                    onChange={(e) => setExecution((p) => ({ ...p, breakeven_enabled: e.target.checked }))}
                    className="accent-cyan-500"
                  />
                  Auto Break-Even at +RR
                </label>
                <input
                  type="number"
                  step={0.25}
                  disabled={!execution.breakeven_enabled}
                  value={execution.breakeven_trigger_rr}
                  onChange={(e) => setExecution((p) => ({ ...p, breakeven_trigger_rr: Number(e.target.value) }))}
                  className="w-20 bg-slate-950 border border-slate-800 rounded px-2 py-0.5 text-right font-mono disabled:opacity-40"
                />
              </div>

              <div className="flex items-center justify-between">
                <label className="flex items-center gap-1.5 text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={execution.partial_tp_enabled}
                    onChange={(e) => setExecution((p) => ({ ...p, partial_tp_enabled: e.target.checked }))}
                    className="accent-cyan-500"
                  />
                  Scale Out 50% TP1 at +RR
                </label>
                <input
                  type="number"
                  step={0.25}
                  disabled={!execution.partial_tp_enabled}
                  value={execution.partial_tp_rr}
                  onChange={(e) => setExecution((p) => ({ ...p, partial_tp_rr: Number(e.target.value) }))}
                  className="w-20 bg-slate-950 border border-slate-800 rounded px-2 py-0.5 text-right font-mono disabled:opacity-40"
                />
              </div>

              <div className="flex items-center justify-between">
                <label className="flex items-center gap-1.5 text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={execution.trailing_stop_enabled}
                    onChange={(e) => setExecution((p) => ({ ...p, trailing_stop_enabled: e.target.checked }))}
                    className="accent-cyan-500"
                  />
                  Trailing Stop (Pts)
                </label>
                <input
                  type="number"
                  step={2}
                  disabled={!execution.trailing_stop_enabled}
                  value={execution.trailing_distance_pts}
                  onChange={(e) => setExecution((p) => ({ ...p, trailing_distance_pts: Number(e.target.value) }))}
                  className="w-20 bg-slate-950 border border-slate-800 rounded px-2 py-0.5 text-right font-mono disabled:opacity-40"
                />
              </div>

              <div className="flex items-center justify-between pt-1">
                <span className="text-slate-300" title="0 = unlimited">
                  Max Hold Bars (Time-Stop)
                </span>
                <input
                  type="number"
                  min={0}
                  value={execution.max_bars_in_trade}
                  onChange={(e) => setExecution((p) => ({ ...p, max_bars_in_trade: Number(e.target.value) }))}
                  className="w-20 bg-slate-950 border border-slate-800 rounded px-2 py-0.5 text-right font-mono text-white"
                />
              </div>
            </div>
          </section>

          {/* 4. NY Killzone & Prop-Firm Session Rules */}
          <section className="bg-slate-900/75 border border-slate-800/90 rounded-xl p-3 space-y-2.5">
            <div className="font-bold text-white flex items-center gap-1.5">
              <ShieldAlert className="w-3.5 h-3.5 text-amber-400" /> NY Session & Prop Guardrails
            </div>

            <select
              onChange={(e) => applySessionPreset(e.target.value)}
              defaultValue="NY_OPEN_KILLZONE"
              className="w-full bg-slate-950 border border-slate-800 rounded px-2 py-1.5 text-cyan-300"
            >
              {Object.values(sessions).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>

            <div className="grid grid-cols-3 gap-1.5 font-mono">
              <div>
                <label className="text-[10px] text-slate-400 block">Start (ET)</label>
                <input
                  value={execution.entry_start_et}
                  onChange={(e) => setExecution((p) => ({ ...p, entry_start_et: e.target.value }))}
                  className="w-full bg-slate-950 border border-slate-800 rounded px-1.5 py-1 text-white"
                />
              </div>
              <div>
                <label className="text-[10px] text-slate-400 block">End (ET)</label>
                <input
                  value={execution.entry_end_et}
                  onChange={(e) => setExecution((p) => ({ ...p, entry_end_et: e.target.value }))}
                  className="w-full bg-slate-950 border border-slate-800 rounded px-1.5 py-1 text-white"
                />
              </div>
              <div>
                <label className="text-[10px] text-slate-400 block">Flatten (ET)</label>
                <input
                  value={execution.flatten_et}
                  onChange={(e) => setExecution((p) => ({ ...p, flatten_et: e.target.value }))}
                  placeholder="15:55"
                  className="w-full bg-slate-950 border border-slate-800 rounded px-1.5 py-1 text-amber-300"
                />
              </div>
            </div>

            <div className="grid grid-cols-3 gap-1.5 pt-1">
              <div>
                <label className="text-[10px] text-slate-400 block">Max Tr/Day</label>
                <input
                  type="number"
                  min={0}
                  value={execution.max_trades_per_day}
                  onChange={(e) => setExecution((p) => ({ ...p, max_trades_per_day: Number(e.target.value) }))}
                  className="w-full bg-slate-950 border border-slate-800 rounded px-1.5 py-1 font-mono text-white"
                />
              </div>
              <div>
                <label className="text-[10px] text-slate-400 block">Daily Loss $</label>
                <input
                  type="number"
                  min={0}
                  step={100}
                  value={execution.daily_max_loss_usd}
                  onChange={(e) => setExecution((p) => ({ ...p, daily_max_loss_usd: Number(e.target.value) }))}
                  className="w-full bg-slate-950 border border-slate-800 rounded px-1.5 py-1 font-mono text-rose-300"
                />
              </div>
              <div>
                <label className="text-[10px] text-slate-400 block">Daily Goal $</label>
                <input
                  type="number"
                  min={0}
                  step={100}
                  value={execution.daily_profit_target_usd}
                  onChange={(e) => setExecution((p) => ({ ...p, daily_profit_target_usd: Number(e.target.value) }))}
                  className="w-full bg-slate-950 border border-slate-800 rounded px-1.5 py-1 font-mono text-emerald-300"
                />
              </div>
            </div>
          </section>
        </aside>
        )}

        {/* Right Main Content Workspace */}
        <main className="flex-1 flex flex-col overflow-hidden p-3 gap-2.5 max-h-[calc(100vh-57px)]">
          {/* Navigation Tabs */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-2 shrink-0">
            <div className="flex flex-wrap gap-1.5 text-xs">
              {[
                { id: 'replay', label: 'Live Replay Simulator (TV Suite)', icon: Play },
                { id: 'analytics', label: 'Auto Backtest Analytics', icon: BarChart3 },
                { id: 'chart', label: '5m Strategy Signals Chart', icon: CandlestickChart },
                { id: 'trades', label: `Auto Trade Log (${result?.kpis.total_trades.toLocaleString() ?? 0})`, icon: ListOrdered },
                { id: 'optimizer', label: '2D Optimizer & Walk-Forward', icon: Sparkles },
                { id: 'studio', label: 'Python Strategy Studio', icon: Code2 },
              ].map((t) => {
                const Icon = t.icon;
                const active = activeTab === t.id;
                return (
                  <button
                    key={t.id}
                    onClick={() => setActiveTab(t.id as typeof activeTab)}
                    className={`px-3 py-1.5 rounded-lg font-medium flex items-center gap-1.5 transition cursor-pointer ${
                      active
                        ? 'bg-cyan-500/15 text-cyan-300 border border-cyan-500/40'
                        : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    {t.label}
                  </button>
                );
              })}
            </div>
          </div>

          {error && (
            <div className="p-3 rounded-lg bg-rose-950/50 border border-rose-800 text-rose-300 text-xs font-mono shrink-0">
              {error}
            </div>
          )}

          {/* Tab Body */}
          <div className="flex-1 overflow-y-auto pr-1">
            {activeTab === 'replay' && datasetId && (
              <ReplaySimulator datasetId={datasetId} instruments={instruments} />
            )}

            {activeTab === 'analytics' && result && <PerformanceDashboard result={result} />}

            {activeTab === 'chart' && (
              <div className="h-[calc(100vh-145px)] min-h-[500px]">
                <CandlestickTerminal
                  datasetId={datasetId}
                  strategyId={strategyId}
                  strategyParams={strategyParams}
                  trades={result?.trades ?? []}
                  selectedTrade={selectedTrade}
                  onSelectTrade={setSelectedTrade}
                />
              </div>
            )}

            {activeTab === 'trades' && result && (
              <TradeLogTable trades={result.trades} onInspectTrade={handleInspectTrade} />
            )}

            {activeTab === 'optimizer' && activeStrategy && (
              <OptimizerPanel
                datasetId={datasetId}
                strategy={activeStrategy}
                strategyParams={strategyParams}
                execution={execution}
                startDate={startDate}
                endDate={endDate}
                onApplyCombination={(xAxis, xVal, yAxis, yVal) => {
                  const nextS = { ...strategyParams };
                  const nextE = { ...execution };
                  if (xAxis.target === 'strategy') nextS[xAxis.name] = xVal;
                  else (nextE as unknown as Record<string, unknown>)[xAxis.name] = xVal;
                  if (yAxis.target === 'strategy') nextS[yAxis.name] = yVal;
                  else (nextE as unknown as Record<string, unknown>)[yAxis.name] = yVal;
                  setStrategyParams(nextS);
                  setExecution(nextE);
                  setActiveTab('analytics');
                  executeBacktest({ sParams: nextS, exec: nextE });
                }}
              />
            )}

            {activeTab === 'studio' && (
              <StrategyStudio
                strategies={strategies}
                selectedStrategyId={strategyId}
                customTemplate={customTemplate}
                onStrategiesUpdated={(list, selectId) => {
                  setStrategies(list);
                  if (selectId) handleSelectStrategy(selectId);
                }}
              />
            )}
          </div>
        </main>
      </div>

      <DataHubModal
        open={dataHubOpen}
        onClose={() => setDataHubOpen(false)}
        datasets={datasets}
        onDatasetsChanged={(list, selectId) => {
          setDatasets(list);
          if (selectId) {
            setDatasetId(selectId);
          } else if (!list.some((d) => d.id === datasetId) && list[0]) {
            setDatasetId(list[0].id);
          }
        }}
      />
    </div>
  );
};
export default App;
