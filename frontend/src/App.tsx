import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BarChart3,
  CandlestickChart,
  ChevronDown,
  Code2,
  Database,
  ListOrdered,
  Play,
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

type TabId = 'replay' | 'analytics' | 'chart' | 'trades' | 'optimizer' | 'studio';

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

  const [activeTab, setActiveTab] = useState<TabId>('replay');
  const [lastBacktestTab, setLastBacktestTab] = useState<Exclude<TabId, 'replay'>>('analytics');
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

  const selectSubTab = (tab: Exclude<TabId, 'replay'>) => {
    setLastBacktestTab(tab);
    setActiveTab(tab);
  };

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
    selectSubTab('chart');
  };

  if (booting) {
    return (
      <div className="min-h-screen bg-[#0b0e14] flex flex-col items-center justify-center text-[#9598a1] gap-3">
        <Zap className="w-7 h-7 text-[#2962FF] animate-pulse" />
        <div className="text-sm">Loading NAS100 Market Data & Simulation Engine...</div>
      </div>
    );
  }

  const isReplay = activeTab === 'replay';

  return (
    <div className="min-h-screen bg-[#0b0e14] text-[#d1d4dc] flex flex-col">
      {/* Unified Minimal Top Bar (Hick's Law: 2 Primary Modes + Data Selector) */}
      <header className="h-12 bg-[#131722] border-b border-[#222631] px-4 flex items-center justify-between gap-3 sticky top-0 z-30 shrink-0">
        {/* Brand */}
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-md bg-[#2962FF] flex items-center justify-center">
            <Zap className="w-4 h-4 text-white fill-current" />
          </div>
          <span className="font-semibold tracking-tight text-white text-sm">NAS100 Lab</span>
        </div>

        {/* Center 2-Mode Switcher */}
        <div className="flex items-center bg-[#0b0e14] p-0.5 rounded-lg border border-[#222631] text-xs font-medium">
          <button
            onClick={() => setActiveTab('replay')}
            className={`px-3.5 py-1.5 rounded-md flex items-center gap-1.5 transition cursor-pointer ${
              isReplay ? 'bg-[#2962FF] text-white shadow-xs' : 'text-[#9598a1] hover:text-white'
            }`}
          >
            <Play className="w-3.5 h-3.5" />
            Replay Trading
          </button>
          <button
            onClick={() => setActiveTab(lastBacktestTab)}
            className={`px-3.5 py-1.5 rounded-md flex items-center gap-1.5 transition cursor-pointer ${
              !isReplay ? 'bg-[#2962FF] text-white shadow-xs' : 'text-[#9598a1] hover:text-white'
            }`}
          >
            <BarChart3 className="w-3.5 h-3.5" />
            Strategy Backtester
          </button>
        </div>

        {/* Right: Dataset Picker & Data Hub */}
        <div className="flex items-center gap-2 text-xs">
          <select
            value={datasetId}
            onChange={(e) => setDatasetId(e.target.value)}
            className="bg-[#0b0e14] border border-[#222631] hover:border-[#363a45] rounded-md px-2.5 py-1.5 text-[#d1d4dc] max-w-[230px] truncate outline-none cursor-pointer"
            title="Active Historical Dataset"
          >
            {datasets.map((ds) => (
              <option key={ds.id} value={ds.id} className="bg-[#131722]">
                {ds.name}
              </option>
            ))}
          </select>

          <button
            onClick={() => setDataHubOpen(true)}
            className="px-3 py-1.5 rounded-md bg-[#1e222d] hover:bg-[#2a2e39] border border-[#2a2e39] text-white font-medium flex items-center gap-1.5 transition cursor-pointer"
          >
            <Database className="w-3.5 h-3.5 text-[#5b8cff]" />
            <span>Data Hub</span>
          </button>
        </div>
      </header>

      {/* Workspace Body */}
      {isReplay ? (
        <main className="flex-1 p-2 overflow-hidden">
          {datasetId && <ReplaySimulator datasetId={datasetId} instruments={instruments} />}
        </main>
      ) : (
        <div className="flex-1 flex flex-col lg:flex-row overflow-hidden">
          {/* Progressive-Disclosure Strategy Configuration Sidebar */}
          <aside className="w-full lg:w-80 shrink-0 bg-[#131722] border-b lg:border-b-0 lg:border-r border-[#222631] overflow-y-auto p-3.5 space-y-3 text-xs max-h-[calc(100vh-48px)]">
            {/* Core Setup (Always Visible) */}
            <div className="space-y-3">
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-[11px] font-medium text-[#9598a1]">Strategy</label>
                  {activeStrategy && (
                    <span className="text-[10px] text-[#787b86]">{activeStrategy.category}</span>
                  )}
                </div>
                <select
                  value={strategyId}
                  onChange={(e) => handleSelectStrategy(e.target.value)}
                  className="w-full bg-[#0b0e14] border border-[#2a2e39] rounded-md px-2.5 py-1.5 text-white font-medium outline-none"
                >
                  {strategies.map((s) => (
                    <option key={s.id} value={s.id} className="bg-[#131722]">
                      {s.is_custom ? `★ ${s.name}` : s.name}
                    </option>
                  ))}
                </select>
                {activeStrategy && (
                  <p className="text-[11px] text-[#787b86] leading-relaxed mt-1.5">{activeStrategy.description}</p>
                )}
              </div>

              {/* Instrument Selector */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-[11px] font-medium text-[#9598a1]">Instrument</label>
                  <span className="text-[10px] font-mono text-[#787b86]">${execution.point_value}/pt</span>
                </div>
                <div className="grid grid-cols-4 gap-1 bg-[#0b0e14] p-0.5 rounded-md border border-[#222631] font-mono text-[11px]">
                  {Object.keys(instruments).map((k) => (
                    <button
                      key={k}
                      onClick={() => applyInstrumentPreset(k)}
                      className={`py-1 rounded transition cursor-pointer ${
                        execution.instrument === k
                          ? 'bg-[#1e222d] text-white font-semibold'
                          : 'text-[#787b86] hover:text-[#d1d4dc]'
                      }`}
                    >
                      {k === 'NAS100_CFD' ? 'CFD' : k}
                    </button>
                  ))}
                </div>
              </div>

              {/* Capital & Position Size */}
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[11px] text-[#9598a1] block mb-1">Initial Capital ($)</label>
                  <input
                    type="number"
                    value={execution.initial_capital}
                    onChange={(e) => setExecution((p) => ({ ...p, initial_capital: Number(e.target.value) }))}
                    className="w-full bg-[#0b0e14] border border-[#2a2e39] rounded-md px-2.5 py-1.5 font-mono text-white"
                  />
                </div>
                <div>
                  <label className="text-[11px] text-[#9598a1] block mb-1">Contracts / Qty</label>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={execution.contracts}
                    onChange={(e) =>
                      setExecution((p) => ({
                        ...p,
                        sizing_mode: 'fixed_contracts',
                        contracts: Math.max(1, Number(e.target.value)),
                      }))
                    }
                    className="w-full bg-[#0b0e14] border border-[#2a2e39] rounded-md px-2.5 py-1.5 font-mono text-white"
                  />
                </div>
              </div>

              {/* Stop Loss & Take Profit */}
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[11px] text-[#9598a1] block mb-1">Stop Loss Mode</label>
                  <select
                    value={execution.sl_mode}
                    onChange={(e) => setExecution((p) => ({ ...p, sl_mode: e.target.value as ExecutionConfig['sl_mode'] }))}
                    className="w-full bg-[#0b0e14] border border-[#2a2e39] rounded-md px-2 py-1.5 text-white"
                  >
                    <option value="strategy_or_atr">Strategy / ATR</option>
                    <option value="atr_mult">ATR Multiple</option>
                    <option value="fixed_pts">Fixed Points</option>
                  </select>
                </div>
                <div>
                  <label className="text-[11px] text-[#9598a1] block mb-1">
                    {execution.sl_mode === 'fixed_pts' ? 'Stop (Pts)' : 'ATR Mult'}
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
                    className="w-full bg-[#0b0e14] border border-[#2a2e39] rounded-md px-2.5 py-1.5 font-mono text-[#f23645]"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[11px] text-[#9598a1] block mb-1">Take Profit Mode</label>
                  <select
                    value={execution.tp_mode}
                    onChange={(e) => setExecution((p) => ({ ...p, tp_mode: e.target.value as ExecutionConfig['tp_mode'] }))}
                    className="w-full bg-[#0b0e14] border border-[#2a2e39] rounded-md px-2 py-1.5 text-white"
                  >
                    <option value="rr_multiple">Reward : Risk</option>
                    <option value="fixed_pts">Fixed Points</option>
                    <option value="atr_mult">ATR Multiple</option>
                  </select>
                </div>
                <div>
                  <label className="text-[11px] text-[#9598a1] block mb-1">
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
                    className="w-full bg-[#0b0e14] border border-[#2a2e39] rounded-md px-2.5 py-1.5 font-mono text-[#089981]"
                  />
                </div>
              </div>

              {/* Primary CTA (Fitts's Law) */}
              <button
                onClick={() => executeBacktest()}
                disabled={running}
                className="w-full py-2.5 rounded-lg bg-[#2962FF] hover:bg-blue-500 disabled:opacity-50 text-white font-semibold flex items-center justify-center gap-2 transition cursor-pointer shadow-sm"
              >
                <Play className="w-3.5 h-3.5 fill-current" />
                {running ? 'Running Simulation...' : 'Run Backtest'}
              </button>
            </div>

            {/* Collapsible Accordion 1: Strategy Parameters */}
            {activeStrategy && activeStrategy.params.length > 0 && (
              <details className="group border-t border-[#222631] pt-2.5">
                <summary className="flex items-center justify-between cursor-pointer list-none font-medium text-white py-1">
                  <span>Strategy Inputs</span>
                  <span className="flex items-center gap-1 text-[11px] text-[#787b86]">
                    {activeStrategy.params.length} params
                    <ChevronDown className="w-3.5 h-3.5 transition group-open:rotate-180" />
                  </span>
                </summary>
                <div className="space-y-2 pt-2.5">
                  {activeStrategy.params.map((p) => {
                    const val = strategyParams[p.name] ?? p.default;
                    if (p.type === 'bool') {
                      return (
                        <label key={p.name} className="flex items-center justify-between text-[#d1d4dc] cursor-pointer py-0.5">
                          <span>{p.label}</span>
                          <input
                            type="checkbox"
                            checked={Boolean(val)}
                            onChange={(e) => setStrategyParams((prev) => ({ ...prev, [p.name]: e.target.checked }))}
                            className="accent-[#2962FF]"
                          />
                        </label>
                      );
                    }
                    return (
                      <div key={p.name} className="flex items-center justify-between gap-2">
                        <label className="text-[#9598a1]">{p.label}</label>
                        <input
                          type="number"
                          min={p.min}
                          max={p.max}
                          step={p.step ?? (p.type === 'int' ? 1 : 0.1)}
                          value={Number(val)}
                          onChange={(e) =>
                            setStrategyParams((prev) => ({
                              ...prev,
                              [p.name]:
                                p.type === 'int'
                                  ? parseInt(e.target.value || '0', 10)
                                  : parseFloat(e.target.value || '0'),
                            }))
                          }
                          className="w-24 bg-[#0b0e14] border border-[#2a2e39] rounded px-2 py-1 text-right font-mono text-white"
                        />
                      </div>
                    );
                  })}
                </div>
              </details>
            )}

            {/* Collapsible Accordion 2: Session & Daily Limits */}
            <details className="group border-t border-[#222631] pt-2.5">
              <summary className="flex items-center justify-between cursor-pointer list-none font-medium text-white py-1">
                <span>Session & Daily Rules</span>
                <span className="flex items-center gap-1 text-[11px] font-mono text-[#787b86]">
                  {execution.use_session_filter ? `${execution.entry_start_et}–${execution.entry_end_et}` : '24h'}
                  <ChevronDown className="w-3.5 h-3.5 transition group-open:rotate-180" />
                </span>
              </summary>
              <div className="space-y-2.5 pt-2.5">
                <select
                  onChange={(e) => applySessionPreset(e.target.value)}
                  defaultValue="NY_OPEN_KILLZONE"
                  className="w-full bg-[#0b0e14] border border-[#2a2e39] rounded px-2 py-1.5 text-[#d1d4dc]"
                >
                  {Object.values(sessions).map((s) => (
                    <option key={s.id} value={s.id} className="bg-[#131722]">
                      {s.name}
                    </option>
                  ))}
                </select>

                <div className="grid grid-cols-3 gap-1.5 font-mono">
                  <div>
                    <label className="text-[10px] text-[#787b86] block mb-0.5">Start ET</label>
                    <input
                      value={execution.entry_start_et}
                      onChange={(e) => setExecution((p) => ({ ...p, entry_start_et: e.target.value }))}
                      className="w-full bg-[#0b0e14] border border-[#2a2e39] rounded px-2 py-1 text-white"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-[#787b86] block mb-0.5">End ET</label>
                    <input
                      value={execution.entry_end_et}
                      onChange={(e) => setExecution((p) => ({ ...p, entry_end_et: e.target.value }))}
                      className="w-full bg-[#0b0e14] border border-[#2a2e39] rounded px-2 py-1 text-white"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-[#787b86] block mb-0.5">Flatten ET</label>
                    <input
                      value={execution.flatten_et}
                      onChange={(e) => setExecution((p) => ({ ...p, flatten_et: e.target.value }))}
                      placeholder="15:55"
                      className="w-full bg-[#0b0e14] border border-[#2a2e39] rounded px-2 py-1 text-white"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-1.5 font-mono">
                  <div>
                    <label className="text-[10px] text-[#787b86] block mb-0.5">Max Tr/Day</label>
                    <input
                      type="number"
                      min={0}
                      value={execution.max_trades_per_day}
                      onChange={(e) => setExecution((p) => ({ ...p, max_trades_per_day: Number(e.target.value) }))}
                      className="w-full bg-[#0b0e14] border border-[#2a2e39] rounded px-2 py-1 text-white"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-[#787b86] block mb-0.5">Max Loss $</label>
                    <input
                      type="number"
                      min={0}
                      step={100}
                      value={execution.daily_max_loss_usd}
                      onChange={(e) => setExecution((p) => ({ ...p, daily_max_loss_usd: Number(e.target.value) }))}
                      className="w-full bg-[#0b0e14] border border-[#2a2e39] rounded px-2 py-1 text-white"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-[#787b86] block mb-0.5">Goal $</label>
                    <input
                      type="number"
                      min={0}
                      step={100}
                      value={execution.daily_profit_target_usd}
                      onChange={(e) => setExecution((p) => ({ ...p, daily_profit_target_usd: Number(e.target.value) }))}
                      className="w-full bg-[#0b0e14] border border-[#2a2e39] rounded px-2 py-1 text-white"
                    />
                  </div>
                </div>
              </div>
            </details>

            {/* Collapsible Accordion 3: Trade Management & Friction */}
            <details className="group border-t border-[#222631] pt-2.5">
              <summary className="flex items-center justify-between cursor-pointer list-none font-medium text-white py-1">
                <span>Friction & Exit Rules</span>
                <span className="flex items-center gap-1 text-[11px] font-mono text-[#787b86]">
                  {activeDataset?.has_1m_subbars && execution.intrabar_mode === 'subbar_1m' ? '1m Exact' : '5m'}
                  <ChevronDown className="w-3.5 h-3.5 transition group-open:rotate-180" />
                </span>
              </summary>
              <div className="space-y-2.5 pt-2.5">
                <div>
                  <label className="text-[11px] text-[#9598a1] block mb-1">Intrabar Fill Precision</label>
                  <select
                    value={execution.intrabar_mode}
                    onChange={(e) =>
                      setExecution((p) => ({ ...p, intrabar_mode: e.target.value as ExecutionConfig['intrabar_mode'] }))
                    }
                    className="w-full bg-[#0b0e14] border border-[#2a2e39] rounded px-2 py-1.5 text-white"
                  >
                    <option value="subbar_1m">1m Sub-Bar Exact</option>
                    <option value="pessimistic_sl_first">5m Pessimistic (SL First)</option>
                    <option value="bar_path_heuristic">5m OHLC Path Heuristic</option>
                  </select>
                </div>

                <div className="grid grid-cols-3 gap-1.5 font-mono">
                  <div>
                    <label className="text-[10px] text-[#787b86] block mb-0.5">Spread (pt)</label>
                    <input
                      type="number"
                      step={0.1}
                      value={execution.spread_pts}
                      onChange={(e) => setExecution((p) => ({ ...p, spread_pts: Number(e.target.value) }))}
                      className="w-full bg-[#0b0e14] border border-[#2a2e39] rounded px-2 py-1 text-white"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-[#787b86] block mb-0.5">Slip (pt)</label>
                    <input
                      type="number"
                      step={0.1}
                      value={execution.slippage_pts}
                      onChange={(e) => setExecution((p) => ({ ...p, slippage_pts: Number(e.target.value) }))}
                      className="w-full bg-[#0b0e14] border border-[#2a2e39] rounded px-2 py-1 text-white"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-[#787b86] block mb-0.5">Comm ($)</label>
                    <input
                      type="number"
                      step={0.1}
                      value={execution.commission_per_side}
                      onChange={(e) => setExecution((p) => ({ ...p, commission_per_side: Number(e.target.value) }))}
                      className="w-full bg-[#0b0e14] border border-[#2a2e39] rounded px-2 py-1 text-white"
                    />
                  </div>
                </div>

                <div className="space-y-1.5 pt-1">
                  <div className="flex items-center justify-between">
                    <label className="flex items-center gap-2 text-[#d1d4dc] cursor-pointer">
                      <input
                        type="checkbox"
                        checked={execution.breakeven_enabled}
                        onChange={(e) => setExecution((p) => ({ ...p, breakeven_enabled: e.target.checked }))}
                        className="accent-[#2962FF]"
                      />
                      Break-Even at +RR
                    </label>
                    <input
                      type="number"
                      step={0.25}
                      disabled={!execution.breakeven_enabled}
                      value={execution.breakeven_trigger_rr}
                      onChange={(e) => setExecution((p) => ({ ...p, breakeven_trigger_rr: Number(e.target.value) }))}
                      className="w-18 bg-[#0b0e14] border border-[#2a2e39] rounded px-2 py-0.5 text-right font-mono text-white disabled:opacity-40"
                    />
                  </div>

                  <div className="flex items-center justify-between">
                    <label className="flex items-center gap-2 text-[#d1d4dc] cursor-pointer">
                      <input
                        type="checkbox"
                        checked={execution.partial_tp_enabled}
                        onChange={(e) => setExecution((p) => ({ ...p, partial_tp_enabled: e.target.checked }))}
                        className="accent-[#2962FF]"
                      />
                      50% Partial at +RR
                    </label>
                    <input
                      type="number"
                      step={0.25}
                      disabled={!execution.partial_tp_enabled}
                      value={execution.partial_tp_rr}
                      onChange={(e) => setExecution((p) => ({ ...p, partial_tp_rr: Number(e.target.value) }))}
                      className="w-18 bg-[#0b0e14] border border-[#2a2e39] rounded px-2 py-0.5 text-right font-mono text-white disabled:opacity-40"
                    />
                  </div>

                  <div className="flex items-center justify-between">
                    <span className="text-[#9598a1]">Max Hold (5m Bars)</span>
                    <input
                      type="number"
                      min={0}
                      value={execution.max_bars_in_trade}
                      onChange={(e) => setExecution((p) => ({ ...p, max_bars_in_trade: Number(e.target.value) }))}
                      className="w-18 bg-[#0b0e14] border border-[#2a2e39] rounded px-2 py-0.5 text-right font-mono text-white"
                    />
                  </div>
                </div>
              </div>
            </details>
          </aside>

          {/* Backtester Main Content */}
          <main className="flex-1 flex flex-col overflow-hidden p-3.5 gap-3 max-h-[calc(100vh-48px)]">
            {/* Clean Secondary Sub-Navigation */}
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#222631] pb-2.5 shrink-0">
              <div className="flex flex-wrap gap-1 text-xs">
                {(
                  [
                    { id: 'analytics', label: 'Overview', icon: BarChart3 },
                    { id: 'chart', label: 'Signals Chart', icon: CandlestickChart },
                    {
                      id: 'trades',
                      label: `Trades (${result?.kpis.total_trades.toLocaleString() ?? 0})`,
                      icon: ListOrdered,
                    },
                    { id: 'optimizer', label: 'Optimizer', icon: Sparkles },
                    { id: 'studio', label: 'Python Studio', icon: Code2 },
                  ] as const
                ).map((t) => {
                  const Icon = t.icon;
                  const active = activeTab === t.id;
                  return (
                    <button
                      key={t.id}
                      onClick={() => selectSubTab(t.id)}
                      className={`px-3 py-1.5 rounded-md font-medium flex items-center gap-1.5 transition cursor-pointer ${
                        active
                          ? 'bg-[#1e222d] text-white'
                          : 'text-[#787b86] hover:text-[#d1d4dc] hover:bg-[#131722]'
                      }`}
                    >
                      <Icon className="w-3.5 h-3.5" />
                      {t.label}
                    </button>
                  );
                })}
              </div>

              <div className="hidden xl:flex items-center gap-2 text-[11px] font-mono text-[#787b86]">
                <div className="flex items-center gap-1.5 bg-[#131722] border border-[#222631] rounded-md px-2.5 py-1">
                  <span>Date Filter:</span>
                  <input
                    type="date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    className="bg-transparent text-[#d1d4dc] outline-none"
                  />
                  <span>→</span>
                  <input
                    type="date"
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                    className="bg-transparent text-[#d1d4dc] outline-none"
                  />
                </div>
                {result && (
                  <span>
                    {result.bars_tested.toLocaleString()} bars · {result.engine_ms}ms
                  </span>
                )}
              </div>
            </div>

            {error && (
              <div className="p-3 rounded-lg bg-[#f23645]/10 border border-[#f23645]/30 text-[#f23645] text-xs font-mono shrink-0">
                {error}
              </div>
            )}

            <div className="flex-1 overflow-y-auto pr-1">
              {activeTab === 'analytics' && result && <PerformanceDashboard result={result} />}

              {activeTab === 'chart' && (
                <div className="h-[calc(100vh-125px)] min-h-[500px]">
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
                    selectSubTab('analytics');
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
      )}

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
