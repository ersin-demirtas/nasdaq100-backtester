import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Calendar,
  Columns2,
  Crosshair,
  Dices,
  FastForward,
  Grid2x2,
  Maximize2,
  Pause,
  Play,
  RotateCcw,
  Settings2,
  StepForward,
  Trash2,
} from 'lucide-react';
import { api } from '../api';
import { DEFAULT_SUITE_SETTINGS, SuiteSettingsModal } from './SuiteSettingsModal';
import { UniversalSuiteChart } from './UniversalSuiteChart';
import type {
  InstrumentPreset,
  ReplayFrameResponse,
  SimClosedTrade,
  SimPendingOrder,
  SimPosition,
  SteppedSubBar,
  UniversalSuiteSettings,
} from '../types';

interface Props {
  datasetId: string;
  instruments: Record<string, InstrumentPreset>;
}

const SINGLE_TFS = [
  { code: '1m', label: '1m' },
  { code: '3m', label: '3m' },
  { code: '5m', label: '5m' },
  { code: '15m', label: '15m' },
  { code: '60m', label: '1H' },
  { code: '240m', label: '4H' },
  { code: '1D', label: '1D' },
];

const QUAD_TFS = [
  { code: '3m', label: '3m' },
  { code: '15m', label: '15m' },
  { code: '60m', label: '1H' },
  { code: '240m', label: '4H' },
];

const STORAGE_KEY_SUITE = 'nas100_universal_suite_v1';
const STORAGE_KEY_TRADES = 'nas100_sim_trades_v1';
const STORAGE_KEY_BAL = 'nas100_sim_balance_v1';

export const ReplaySimulator: React.FC<Props> = ({ datasetId, instruments }) => {
  // Layout & Timeframe state
  const [layoutMode, setLayoutMode] = useState<'single' | 'split' | 'quad'>('single');
  const [activeTf, setActiveTf] = useState<string>('3m');
  const [resetViewportKey, setResetViewportKey] = useState<number>(1);

  // Universal Suite Settings
  const [suiteSettings, setSuiteSettings] = useState<UniversalSuiteSettings>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_SUITE);
      return saved ? { ...DEFAULT_SUITE_SETTINGS, ...JSON.parse(saved) } : DEFAULT_SUITE_SETTINGS;
    } catch {
      return DEFAULT_SUITE_SETTINGS;
    }
  });
  const [suiteModalOpen, setSuiteModalOpen] = useState(false);

  // Replay Playback State
  const [frame, setFrame] = useState<ReplayFrameResponse | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speedMs, setSpeedMs] = useState<number>(450); // ms per step
  const [stepSizeBars, setStepSizeBars] = useState<number>(1); // 1 = 1m, 3 = 3m, 5 = 5m
  const [jumpDate, setJumpDate] = useState<string>('2025-05-15');
  const [jumpTime, setJumpTime] = useState<string>('09:25');
  const [jumpOpen, setJumpOpen] = useState<boolean>(false);
  const [dockTab, setDockTab] = useState<'order' | 'history'>('order');
  const [loading, setLoading] = useState<boolean>(false);
  const [toast, setToast] = useState<string | null>(null);

  // Paper Trading Account & Order Ticket State
  const [instrumentKey, setInstrumentKey] = useState<string>('MNQ');
  const inst = instruments[instrumentKey] ?? {
    id: 'MNQ',
    name: 'MNQ',
    point_value: 2.0,
    tick_size: 0.25,
    default_contracts: 5,
    default_spread_pts: 0.25,
    default_slippage_pts: 0.25,
    default_commission_per_side: 0.62,
  };

  const [balance, setBalance] = useState<number>(() => {
    const v = Number(localStorage.getItem(STORAGE_KEY_BAL));
    return Number.isFinite(v) && v > 0 ? v : 50000;
  });
  const [closedTrades, setClosedTrades] = useState<SimClosedTrade[]>(() => {
    try {
      const s = localStorage.getItem(STORAGE_KEY_TRADES);
      return s ? JSON.parse(s) : [];
    } catch {
      return [];
    }
  });

  const [contracts, setContracts] = useState<number>(5);
  const [orderType, setOrderType] = useState<'MARKET' | 'LIMIT' | 'STOP'>('MARKET');
  const [triggerPrice, setTriggerPrice] = useState<number>(0);
  const [useBracketSl, setUseBracketSl] = useState<boolean>(true);
  const [slPts, setSlPts] = useState<number>(25);
  const [useBracketTp, setUseBracketTp] = useState<boolean>(true);
  const [tpPts, setTpPts] = useState<number>(50);

  const [position, setPosition] = useState<SimPosition | null>(null);
  const [pendingOrders, setPendingOrders] = useState<SimPendingOrder[]>([]);
  const [pickMode, setPickMode] = useState<'SL' | 'TP' | 'TRIGGER' | null>(null);
  const nextIdRef = useRef<number>(100);

  // Refs for synchronous access inside interval / step callbacks
  const posRef = useRef<SimPosition | null>(position);
  posRef.current = position;
  const pendingRef = useRef<SimPendingOrder[]>(pendingOrders);
  pendingRef.current = pendingOrders;
  const frameRef = useRef<ReplayFrameResponse | null>(frame);
  frameRef.current = frame;
  const busyStepRef = useRef<boolean>(false);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY_SUITE, JSON.stringify(suiteSettings));
  }, [suiteSettings]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY_BAL, String(balance));
  }, [balance]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY_TRADES, JSON.stringify(closedTrades));
  }, [closedTrades]);

  const showNotice = (msg: string) => {
    setToast(msg);
    setTimeout(() => {
      setToast((cur) => (cur === msg ? null : cur));
    }, 3200);
  };

  const activeTimeframes = useMemo(() => {
    if (layoutMode === 'quad') return QUAD_TFS.map((t) => t.code);
    if (layoutMode === 'split') return ['3m', '15m'];
    return [activeTf];
  }, [layoutMode, activeTf]);

  const roundTick = useCallback(
    (p: number) => Number((Math.round(p / inst.tick_size) * inst.tick_size).toFixed(2)),
    [inst.tick_size]
  );

  // Evaluate pending orders & open position SL/TP across each stepped 1m sub-bar
  const processSteppedSubBars = useCallback(
    (bars: SteppedSubBar[]) => {
      if (bars.length === 0) return;

      let curPos = posRef.current ? { ...posRef.current } : null;
      let curPending = [...pendingRef.current];
      let balDelta = 0;
      const newClosed: SimClosedTrade[] = [];

      for (const b of bars) {
        const halfSp = 0.5 * Math.max(b.spread, inst.default_spread_pts);
        const bidHigh = b.high - halfSp;
        const bidLow = b.low - halfSp;
        const askHigh = b.high + halfSp;
        const askLow = b.low + halfSp;

        // 1. Check pending Limit / Stop triggers if flat
        if (!curPos && curPending.length > 0) {
          for (let i = 0; i < curPending.length; i++) {
            const ord = curPending[i];
            let filled = false;
            if (ord.direction === 'LONG') {
              if (ord.orderType === 'LIMIT' && askLow <= ord.triggerPrice) filled = true;
              if (ord.orderType === 'STOP' && askHigh >= ord.triggerPrice) filled = true;
            } else {
              if (ord.orderType === 'LIMIT' && bidHigh >= ord.triggerPrice) filled = true;
              if (ord.orderType === 'STOP' && bidLow <= ord.triggerPrice) filled = true;
            }
            if (filled) {
              const fillPrice = roundTick(ord.triggerPrice);
              const slP =
                ord.slPts > 0
                  ? roundTick(ord.direction === 'LONG' ? fillPrice - ord.slPts : fillPrice + ord.slPts)
                  : null;
              const tpP =
                ord.tpPts > 0
                  ? roundTick(ord.direction === 'LONG' ? fillPrice + ord.tpPts : fillPrice - ord.tpPts)
                  : null;
              curPos = {
                id: ++nextIdRef.current,
                direction: ord.direction,
                entryTs: b.ts,
                entryEt: b.et,
                entryPrice: fillPrice,
                contracts: ord.contracts,
                initialContracts: ord.contracts,
                slPrice: slP,
                tpPrice: tpP,
                initialSlDist: ord.slPts > 0 ? ord.slPts : 20,
                realizedPnl: 0,
                commissionPaid: inst.default_commission_per_side * ord.contracts,
              };
              curPending.splice(i, 1);
              showNotice(`Filled ${ord.direction} ${ord.orderType} x${ord.contracts} @ ${fillPrice}`);
              break;
            }
          }
        }

        // 2. Check active position SL / TP on this 1m bar
        if (curPos) {
          let slHit = false;
          let tpHit = false;
          if (curPos.direction === 'LONG') {
            if (curPos.slPrice !== null && bidLow <= curPos.slPrice) slHit = true;
            if (curPos.tpPrice !== null && bidHigh >= curPos.tpPrice) tpHit = true;
          } else {
            if (curPos.slPrice !== null && askHigh >= curPos.slPrice) slHit = true;
            if (curPos.tpPrice !== null && askLow <= curPos.tpPrice) tpHit = true;
          }

          if (slHit || tpHit) {
            // Pessimistic SL-first if both hit inside same 1m bar
            const isSl = slHit;
            const rawExit = isSl ? (curPos.slPrice as number) : (curPos.tpPrice as number);
            const slip = isSl ? inst.default_slippage_pts : 0;
            const exitFill = roundTick(
              curPos.direction === 'LONG' ? rawExit - slip : rawExit + slip
            );

            const legPts =
              curPos.direction === 'LONG' ? exitFill - curPos.entryPrice : curPos.entryPrice - exitFill;
            const exitComm = inst.default_commission_per_side * curPos.contracts;
            const legNet = legPts * inst.point_value * curPos.contracts - curPos.commissionPaid - exitComm;
            const totalTradeNet = Number((curPos.realizedPnl + legNet).toFixed(2));
            const initRisk = Math.max(1, curPos.initialSlDist * inst.point_value * curPos.initialContracts);

            balDelta += legNet;
            newClosed.unshift({
              id: curPos.id,
              direction: curPos.direction,
              entryTs: curPos.entryTs,
              exitTs: b.ts,
              entryEt: curPos.entryEt,
              exitEt: b.et,
              entryPrice: curPos.entryPrice,
              exitPrice: exitFill,
              contracts: curPos.initialContracts,
              netPts: Number(legPts.toFixed(2)),
              netPnl: totalTradeNet,
              rMultiple: Number((totalTradeNet / initRisk).toFixed(2)),
              exitReason: isSl ? 'STOP LOSS' : 'TAKE PROFIT',
            });
            showNotice(
              `${isSl ? 'Stop Hit' : 'Target Hit'}: ${totalTradeNet >= 0 ? '+' : ''}$${totalTradeNet.toFixed(2)}`
            );
            curPos = null;
          }
        }
      }

      setPosition(curPos);
      setPendingOrders(curPending);
      if (balDelta !== 0) setBalance((prev) => Number((prev + balDelta).toFixed(2)));
      if (newClosed.length > 0) setClosedTrades((prev) => [...newClosed, ...prev]);
    },
    [inst, roundTick]
  );

  // Fetch replay frame from backend
  const loadReplay = useCallback(
    async (
      mode: 'init' | 'at_ts' | 'step' | 'jump_date' | 'random_ny_open' | 'next_ny_open',
      opts?: { stepBars?: number; resetZoom?: boolean }
    ) => {
      if (!datasetId || busyStepRef.current) return;
      busyStepRef.current = true;
      if (mode !== 'step') setLoading(true);
      try {
        const res = await api.fetchReplayFrame({
          dataset_id: datasetId,
          mode,
          sim_ts: frameRef.current?.sim_ts,
          step_bars: opts?.stepBars ?? stepSizeBars,
          jump_date_et: jumpDate,
          jump_time_et: jumpTime,
          timeframes: activeTimeframes,
          limit: layoutMode === 'quad' ? 210 : layoutMode === 'split' ? 280 : 380,
          suite_settings: suiteSettings,
        });
        setFrame(res);
        if (mode === 'step' && res.stepped_bars.length > 0) {
          processSteppedSubBars(res.stepped_bars);
        }
        if (opts?.resetZoom || mode === 'init' || mode === 'random_ny_open' || mode === 'next_ny_open' || mode === 'jump_date') {
          setResetViewportKey((k) => k + 1);
          setTriggerPrice(res.mid);
        }
        if (!res.has_next) setPlaying(false);
      } catch (err) {
        console.error('Replay frame error:', err);
        setPlaying(false);
      } finally {
        busyStepRef.current = false;
        setLoading(false);
      }
    },
    [datasetId, stepSizeBars, jumpDate, jumpTime, activeTimeframes, layoutMode, suiteSettings, processSteppedSubBars]
  );

  // Initial load on dataset change
  useEffect(() => {
    setPlaying(false);
    setPosition(null);
    setPendingOrders([]);
    loadReplay('init', { resetZoom: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datasetId]);

  // Refresh panes at current `sim_ts` when layout, activeTf, or Universal Suite settings change
  useEffect(() => {
    if (!frameRef.current) return;
    loadReplay('at_ts');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutMode, activeTf, JSON.stringify(suiteSettings)]);

  // Continuous playback timer
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      loadReplay('step', { stepBars: stepSizeBars });
    }, speedMs);
    return () => clearInterval(id);
  }, [playing, speedMs, stepSizeBars, loadReplay]);

  // Order Execution Actions
  const submitOrder = useCallback(
    (dir: 'LONG' | 'SHORT') => {
      const f = frameRef.current;
      if (!f) return;

      if (orderType !== 'MARKET') {
        const trig = roundTick(triggerPrice || f.mid);
        const ord: SimPendingOrder = {
          id: ++nextIdRef.current,
          direction: dir,
          orderType,
          triggerPrice: trig,
          contracts,
          slPts: useBracketSl ? slPts : 0,
          tpPts: useBracketTp ? tpPts : 0,
          createdEt: f.sim_et,
        };
        setPendingOrders((prev) => [...prev, ord]);
        showNotice(`Placed ${dir} ${orderType} x${contracts} @ ${trig}`);
        return;
      }

      // Market execution at Ask (LONG) or Bid (SHORT) + slippage
      const rawFill = dir === 'LONG' ? f.ask + inst.default_slippage_pts : f.bid - inst.default_slippage_pts;
      const fill = roundTick(rawFill);

      // If already in opposite position, flatten first
      if (posRef.current && posRef.current.direction !== dir) {
        flattenPosition('REVERSE');
      }

      // If adding to same direction, average in; otherwise open fresh
      if (posRef.current && posRef.current.direction === dir) {
        const p = posRef.current;
        const totQty = p.contracts + contracts;
        const avgEntry = roundTick((p.entryPrice * p.contracts + fill * contracts) / totQty);
        setPosition({
          ...p,
          entryPrice: avgEntry,
          contracts: totQty,
          initialContracts: p.initialContracts + contracts,
          commissionPaid: p.commissionPaid + inst.default_commission_per_side * contracts,
        });
        showNotice(`Added ${contracts} ${dir} @ ${fill} (Avg ${avgEntry})`);
        return;
      }

      const slP = useBracketSl ? roundTick(dir === 'LONG' ? fill - slPts : fill + slPts) : null;
      const tpP = useBracketTp ? roundTick(dir === 'LONG' ? fill + tpPts : fill - tpPts) : null;

      setPosition({
        id: ++nextIdRef.current,
        direction: dir,
        entryTs: f.sim_ts,
        entryEt: f.sim_et,
        entryPrice: fill,
        contracts,
        initialContracts: contracts,
        slPrice: slP,
        tpPrice: tpP,
        initialSlDist: slPts > 0 ? slPts : 20,
        realizedPnl: 0,
        commissionPaid: inst.default_commission_per_side * contracts,
      });
      showNotice(`Entered ${dir} x${contracts} @ ${fill}`);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [orderType, triggerPrice, contracts, useBracketSl, slPts, useBracketTp, tpPts, inst, roundTick]
  );

  const flattenPosition = useCallback(
    (reason = 'MANUAL CLOSE') => {
      const f = frameRef.current;
      const p = posRef.current;
      if (!f || !p) return;

      const rawEx = p.direction === 'LONG' ? f.bid - inst.default_slippage_pts : f.ask + inst.default_slippage_pts;
      const exFill = roundTick(rawEx);
      const pts = p.direction === 'LONG' ? exFill - p.entryPrice : p.entryPrice - exFill;
      const exitComm = inst.default_commission_per_side * p.contracts;
      const legNet = pts * inst.point_value * p.contracts - p.commissionPaid - exitComm;
      const totNet = Number((p.realizedPnl + legNet).toFixed(2));
      const initRisk = Math.max(1, p.initialSlDist * inst.point_value * p.initialContracts);

      setBalance((b) => Number((b + legNet).toFixed(2)));
      setClosedTrades((prev) => [
        {
          id: p.id,
          direction: p.direction,
          entryTs: p.entryTs,
          exitTs: f.sim_ts,
          entryEt: p.entryEt,
          exitEt: f.sim_et,
          entryPrice: p.entryPrice,
          exitPrice: exFill,
          contracts: p.initialContracts,
          netPts: Number(pts.toFixed(2)),
          netPnl: totNet,
          rMultiple: Number((totNet / initRisk).toFixed(2)),
          exitReason: reason,
        },
        ...prev,
      ]);
      setPosition(null);
      showNotice(`Closed ${p.direction}: ${totNet >= 0 ? '+' : ''}$${totNet.toFixed(2)}`);
    },
    [inst, roundTick]
  );

  const closeHalfPosition = () => {
    const f = frameRef.current;
    const p = posRef.current;
    if (!f || !p || p.contracts <= 1) return;
    const closeQty = Math.max(1, Math.floor(p.contracts / 2));
    const remQty = p.contracts - closeQty;
    const exFill = roundTick(p.direction === 'LONG' ? f.bid : f.ask);
    const pts = p.direction === 'LONG' ? exFill - p.entryPrice : p.entryPrice - exFill;
    const commShare = p.commissionPaid * (closeQty / p.contracts) + inst.default_commission_per_side * closeQty;
    const legNet = Number((pts * inst.point_value * closeQty - commShare).toFixed(2));

    setBalance((b) => Number((b + legNet).toFixed(2)));
    setPosition({
      ...p,
      contracts: remQty,
      realizedPnl: p.realizedPnl + legNet,
      commissionPaid: p.commissionPaid * (remQty / p.contracts),
    });
    showNotice(`Scaled out ${closeQty} ct (${legNet >= 0 ? '+' : ''}$${legNet.toFixed(2)})`);
  };

  const moveSlToBreakeven = () => {
    if (!position) return;
    const be = roundTick(
      position.direction === 'LONG' ? position.entryPrice + inst.tick_size * 2 : position.entryPrice - inst.tick_size * 2
    );
    setPosition({ ...position, slPrice: be });
    showNotice(`Moved Stop-Loss to Break-Even (${be})`);
  };

  // Keyboard shortcuts (`Space` Play/Pause, `->` Step, `B` Buy, `S` Sell, `F` Flatten)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Escape') {
        setPickMode(null);
        setJumpOpen(false);
        return;
      }
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (e.code === 'Space') {
        e.preventDefault();
        setPlaying((p) => !p);
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        setPlaying(false);
        loadReplay('step', { stepBars: e.shiftKey ? 3 : stepSizeBars });
      } else if (e.key === 'b' || e.key === 'B') {
        submitOrder('LONG');
      } else if (e.key === 's' || e.key === 'S') {
        submitOrder('SHORT');
      } else if (e.key === 'f' || e.key === 'F') {
        flattenPosition('HOTKEY FLATTEN');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [loadReplay, stepSizeBars, submitOrder, flattenPosition]);

  // Handle interactive chart price click
  const handleChartPickPrice = (price: number) => {
    if (pickMode === 'TRIGGER') {
      setTriggerPrice(price);
    } else if (pickMode === 'SL') {
      if (position) {
        setPosition({ ...position, slPrice: price });
      } else if (frame) {
        setUseBracketSl(true);
        setSlPts(Math.max(2, Number(Math.abs(frame.mid - price).toFixed(2))));
      }
    } else if (pickMode === 'TP') {
      if (position) {
        setPosition({ ...position, tpPrice: price });
      } else if (frame) {
        setUseBracketTp(true);
        setTpPts(Math.max(2, Number(Math.abs(price - frame.mid).toFixed(2))));
      }
    }
    setPickMode(null);
  };

  // Live Unrealized & Session Stats
  const unrStats = useMemo(() => {
    if (!position || !frame) return { pts: 0, usd: 0 };
    const mark = position.direction === 'LONG' ? frame.bid : frame.ask;
    const pts = position.direction === 'LONG' ? mark - position.entryPrice : position.entryPrice - mark;
    const usd = pts * inst.point_value * position.contracts;
    return { pts: Number(pts.toFixed(2)), usd: Number(usd.toFixed(2)) };
  }, [position, frame, inst.point_value]);

  const sessionStats = useMemo(() => {
    const n = closedTrades.length;
    if (n === 0) return { net: 0, wr: 0, pf: 0 };
    const wins = closedTrades.filter((t) => t.netPnl > 0);
    const losses = closedTrades.filter((t) => t.netPnl < 0);
    const sumW = wins.reduce((a, b) => a + b.netPnl, 0);
    const sumL = Math.abs(losses.reduce((a, b) => a + b.netPnl, 0));
    return {
      net: Number(closedTrades.reduce((a, b) => a + b.netPnl, 0).toFixed(2)),
      wr: Number(((100 * wins.length) / n).toFixed(1)),
      pf: sumL > 0 ? Number((sumW / sumL).toFixed(2)) : sumW > 0 ? 99 : 0,
    };
  }, [closedTrades]);

  const previewRiskUsd = useBracketSl ? slPts * inst.point_value * contracts : 0;
  const previewRewardUsd = useBracketTp ? tpPts * inst.point_value * contracts : 0;

  const toggleLayer = (key: 'show_fvg' | 'show_ma' | 'show_vwap' | 'show_aem' | 'show_mtf') => {
    setSuiteSettings((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  return (
    <div className="flex flex-col h-[calc(100vh-66px)] min-h-[580px] gap-2">
      {/* Unified TradingView-Style Top Toolbar (Jakob's Law + Hick's Law) */}
      <div className="bg-[#131722] border border-[#222631] rounded-lg px-2.5 py-1.5 flex flex-wrap items-center justify-between gap-2 text-xs shrink-0">
        {/* Left: Timeframes · Layouts · 1-Click Indicator Toggles */}
        <div className="flex flex-wrap items-center gap-2">
          {layoutMode === 'single' && (
            <div className="flex items-center gap-0.5 font-mono text-[11px]">
              {SINGLE_TFS.map((t) => (
                <button
                  key={t.code}
                  onClick={() => setActiveTf(t.code)}
                  className={`px-2 py-1 rounded transition cursor-pointer ${
                    activeTf === t.code
                      ? 'bg-[#2962FF]/20 text-[#5b8cff] font-semibold'
                      : 'text-[#9598a1] hover:text-white hover:bg-[#1e222d]'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          )}

          {layoutMode === 'single' && <div className="h-4 w-px bg-[#2a2e39]" />}

          {/* Layout Icons */}
          <div className="flex items-center gap-0.5">
            <button
              onClick={() => setLayoutMode('single')}
              className={`px-2 py-1 rounded flex items-center gap-1 transition cursor-pointer ${
                layoutMode === 'single'
                  ? 'bg-[#1e222d] text-white font-medium'
                  : 'text-[#787b86] hover:text-white'
              }`}
              title="Single Chart"
            >
              <Maximize2 className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Single</span>
            </button>
            <button
              onClick={() => setLayoutMode('split')}
              className={`px-2 py-1 rounded flex items-center gap-1 transition cursor-pointer ${
                layoutMode === 'split'
                  ? 'bg-[#1e222d] text-white font-medium'
                  : 'text-[#787b86] hover:text-white'
              }`}
              title="Split View: 3m + 15m"
            >
              <Columns2 className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Split</span>
            </button>
            <button
              onClick={() => setLayoutMode('quad')}
              className={`px-2 py-1 rounded flex items-center gap-1 transition cursor-pointer ${
                layoutMode === 'quad'
                  ? 'bg-[#1e222d] text-white font-medium'
                  : 'text-[#787b86] hover:text-white'
              }`}
              title="4-Chart Multi-Timeframe Grid (3m · 15m · 1H · 4H)"
            >
              <Grid2x2 className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">4x Grid</span>
            </button>
          </div>

          <div className="h-4 w-px bg-[#2a2e39]" />

          {/* One-Click Indicator Layer Pills + Gear Modal */}
          <div className="flex items-center gap-1">
            {(
              [
                { key: 'show_fvg', label: 'FVG' },
                { key: 'show_ma', label: 'MA' },
                { key: 'show_vwap', label: 'VWAP' },
                { key: 'show_aem', label: '0DTE' },
                { key: 'show_mtf', label: 'MTF' },
              ] as const
            ).map((ind) => {
              const on = suiteSettings[ind.key];
              return (
                <button
                  key={ind.key}
                  onClick={() => toggleLayer(ind.key)}
                  className={`px-2 py-0.5 rounded text-[11px] font-medium border transition cursor-pointer ${
                    on
                      ? 'bg-[#1e222d] border-[#363a45] text-[#d1d4dc]'
                      : 'bg-transparent border-transparent text-[#5d606b] hover:text-[#9598a1]'
                  }`}
                  title={`Toggle ${ind.label} layer`}
                >
                  {ind.label}
                </button>
              );
            })}
            <button
              onClick={() => setSuiteModalOpen(true)}
              className="p-1 rounded text-[#9598a1] hover:text-white hover:bg-[#1e222d] transition cursor-pointer"
              title="Universal Suite Indicator Settings"
            >
              <Settings2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Right: Clean Replay Media Transport */}
        <div className="flex flex-wrap items-center gap-1.5 relative">
          <button
            onClick={() => {
              setPlaying(false);
              loadReplay('random_ny_open', { resetZoom: true });
            }}
            className="px-2.5 py-1 rounded-md bg-[#1e222d] hover:bg-[#2a2e39] text-[#d1d4dc] flex items-center gap-1.5 transition cursor-pointer"
            title="Jump to a random historical NY Morning (09:20 ET)"
          >
            <Dices className="w-3.5 h-3.5 text-[#5b8cff]" /> Random Day
          </button>

          <button
            onClick={() => {
              setPlaying(false);
              loadReplay('next_ny_open', { resetZoom: true });
            }}
            className="px-2.5 py-1 rounded-md bg-[#1e222d] hover:bg-[#2a2e39] text-[#d1d4dc] flex items-center gap-1 transition cursor-pointer"
            title="Skip straight to next trading day 09:20 ET"
          >
            <FastForward className="w-3.5 h-3.5 text-[#9598a1]" /> Next Open
          </button>

          {/* Progressive-Disclosure Date/Time Popover */}
          <div className="relative">
            <button
              onClick={() => setJumpOpen((o) => !o)}
              className="px-2.5 py-1 rounded-md bg-[#0e1117] hover:bg-[#1e222d] border border-[#222631] text-[#d1d4dc] font-mono text-[11px] flex items-center gap-1.5 tabular-nums cursor-pointer"
              title="Jump to specific historical date & time (ET)"
            >
              <Calendar className="w-3 h-3 text-[#787b86]" />
              <span>{frame?.sim_et ?? 'Select Date'} ET</span>
            </button>
            {jumpOpen && (
              <div className="absolute right-0 mt-1.5 z-40 bg-[#181c27] border border-[#2a2e39] rounded-lg p-3 shadow-2xl w-64 space-y-2.5">
                <div className="text-[11px] font-semibold text-white">Jump to Date & Time (NY ET)</div>
                <div className="grid grid-cols-2 gap-2 font-mono text-[11px]">
                  <input
                    type="date"
                    value={jumpDate}
                    onChange={(e) => setJumpDate(e.target.value)}
                    className="bg-[#0e1117] border border-[#2a2e39] rounded px-2 py-1 text-white outline-none"
                  />
                  <input
                    type="time"
                    value={jumpTime}
                    onChange={(e) => setJumpTime(e.target.value)}
                    className="bg-[#0e1117] border border-[#2a2e39] rounded px-2 py-1 text-white outline-none"
                  />
                </div>
                <div className="flex justify-end gap-1.5">
                  <button
                    onClick={() => setJumpOpen(false)}
                    className="px-2.5 py-1 rounded text-[#9598a1] hover:text-white cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => {
                      setPlaying(false);
                      setJumpOpen(false);
                      loadReplay('jump_date', { resetZoom: true });
                    }}
                    className="px-3 py-1 rounded bg-[#2962FF] hover:bg-blue-500 text-white font-medium cursor-pointer"
                  >
                    Go to Bar
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="h-4 w-px bg-[#2a2e39]" />

          {/* Play / Step Transport */}
          <div className="flex items-center gap-1 bg-[#0e1117] border border-[#222631] rounded-md p-0.5">
            <button
              onClick={() => setPlaying((p) => !p)}
              className={`px-3 py-1 rounded font-semibold flex items-center gap-1 transition cursor-pointer ${
                playing ? 'bg-amber-500 text-slate-950' : 'bg-[#2962FF] hover:bg-blue-500 text-white'
              }`}
              title="Spacebar: Play / Pause"
            >
              {playing ? <Pause className="w-3 h-3 fill-current" /> : <Play className="w-3 h-3 fill-current" />}
              {playing ? 'Pause' : 'Play'}
            </button>

            <button
              onClick={() => {
                setPlaying(false);
                loadReplay('step', { stepBars: 1 });
              }}
              className="px-2 py-1 rounded hover:bg-[#1e222d] text-[#d1d4dc] font-mono text-[11px] flex items-center gap-0.5 cursor-pointer"
              title="Right Arrow (→): Step +1 minute"
            >
              <StepForward className="w-3 h-3 text-[#9598a1]" /> +1m
            </button>
            <button
              onClick={() => {
                setPlaying(false);
                loadReplay('step', { stepBars: 5 });
              }}
              className="px-2 py-1 rounded hover:bg-[#1e222d] text-[#d1d4dc] font-mono text-[11px] cursor-pointer"
              title="Step +5 minutes"
            >
              +5m
            </button>
            <button
              onClick={() => {
                setPlaying(false);
                loadReplay('step', { stepBars: 15 });
              }}
              className="px-2 py-1 rounded hover:bg-[#1e222d] text-[#d1d4dc] font-mono text-[11px] cursor-pointer"
              title="Step +15 minutes"
            >
              +15m
            </button>

            <select
              value={`${speedMs}_${stepSizeBars}`}
              onChange={(e) => {
                const [ms, sb] = e.target.value.split('_').map(Number);
                setSpeedMs(ms);
                setStepSizeBars(sb);
              }}
              className="bg-transparent hover:bg-[#1e222d] rounded px-1.5 py-1 font-mono text-[11px] text-[#9598a1] outline-none cursor-pointer"
              title="Replay Speed"
            >
              <option value="800_1" className="bg-[#131722]">1x</option>
              <option value="350_1" className="bg-[#131722]">3x</option>
              <option value="160_1" className="bg-[#131722]">6x</option>
              <option value="300_3" className="bg-[#131722]">Fast</option>
              <option value="250_5" className="bg-[#131722]">Turbo</option>
            </select>
          </div>
        </div>
      </div>

      {/* Main Split: Left Chart(s) + Right Simplified Order Panel */}
      <div className="flex-1 flex flex-col lg:flex-row gap-2 min-h-0">
        {/* Chart Area */}
        <div className="flex-1 min-h-0 relative">
          {toast && (
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-30 px-3.5 py-1.5 rounded-full bg-[#181c27]/95 border border-[#2a2e39] text-[#d1d4dc] text-xs shadow-xl">
              {toast}
            </div>
          )}
          {loading && (
            <div className="absolute top-2.5 right-20 z-30 px-2.5 py-0.5 rounded bg-[#181c27]/90 border border-[#2a2e39] text-[#9598a1] text-[11px]">
              Syncing...
            </div>
          )}

          {layoutMode === 'single' && (
            <UniversalSuiteChart
              pane={frame?.panes[activeTf]}
              tfLabel={SINGLE_TFS.find((t) => t.code === activeTf)?.label || activeTf}
              resetViewportKey={resetViewportKey}
              position={position}
              pendingOrders={pendingOrders}
              closedTrades={closedTrades}
              pointValue={inst.point_value}
              tickSize={inst.tick_size}
              currentBid={frame?.bid ?? 0}
              currentAsk={frame?.ask ?? 0}
              pickMode={pickMode}
              onPickPrice={handleChartPickPrice}
            />
          )}

          {layoutMode === 'split' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2 w-full h-full">
              <UniversalSuiteChart
                pane={frame?.panes['3m']}
                tfLabel="3m"
                compact
                resetViewportKey={resetViewportKey}
                position={position}
                pendingOrders={pendingOrders}
                closedTrades={closedTrades}
                pointValue={inst.point_value}
                tickSize={inst.tick_size}
                currentBid={frame?.bid ?? 0}
                currentAsk={frame?.ask ?? 0}
                pickMode={pickMode}
                onPickPrice={handleChartPickPrice}
              />
              <UniversalSuiteChart
                pane={frame?.panes['15m']}
                tfLabel="15m"
                compact
                resetViewportKey={resetViewportKey}
                position={position}
                pendingOrders={pendingOrders}
                closedTrades={closedTrades}
                pointValue={inst.point_value}
                tickSize={inst.tick_size}
                currentBid={frame?.bid ?? 0}
                currentAsk={frame?.ask ?? 0}
                pickMode={pickMode}
                onPickPrice={handleChartPickPrice}
              />
            </div>
          )}

          {layoutMode === 'quad' && (
            <div className="grid grid-cols-1 md:grid-cols-2 grid-rows-2 gap-2 w-full h-full">
              {QUAD_TFS.map((q) => (
                <UniversalSuiteChart
                  key={q.code}
                  pane={frame?.panes[q.code]}
                  tfLabel={q.label}
                  compact
                  resetViewportKey={resetViewportKey}
                  position={position}
                  pendingOrders={pendingOrders}
                  closedTrades={closedTrades}
                  pointValue={inst.point_value}
                  tickSize={inst.tick_size}
                  currentBid={frame?.bid ?? 0}
                  currentAsk={frame?.ask ?? 0}
                  pickMode={pickMode}
                  onPickPrice={handleChartPickPrice}
                />
              ))}
            </div>
          )}
        </div>

        {/* Right TradingView-Style Order Panel (Fitts's Law + Progressive Disclosure) */}
        <div className="w-full lg:w-76 shrink-0 bg-[#131722] border border-[#222631] rounded-lg flex flex-col overflow-hidden text-xs">
          {/* Compact Account Summary Header */}
          <div className="px-3.5 py-2.5 border-b border-[#222631] flex items-center justify-between">
            <div>
              <div className="text-[11px] text-[#787b86]">Paper Account</div>
              <div className="text-sm font-bold text-white font-mono tabular-nums">
                ${(balance + unrStats.usd).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </div>
            </div>
            <div className="text-right">
              <button
                onClick={() => {
                  setBalance(50000);
                  setClosedTrades([]);
                  setPosition(null);
                  setPendingOrders([]);
                  showNotice('Account reset to $50,000');
                }}
                className="text-[10px] text-[#787b86] hover:text-white inline-flex items-center gap-1 cursor-pointer"
                title="Reset paper account to $50,000"
              >
                <RotateCcw className="w-2.5 h-2.5" /> Reset
              </button>
              <div
                className={`text-xs font-semibold font-mono tabular-nums ${
                  sessionStats.net + unrStats.usd >= 0 ? 'text-[#089981]' : 'text-[#f23645]'
                }`}
              >
                {sessionStats.net + unrStats.usd >= 0 ? '+' : ''}
                ${(sessionStats.net + unrStats.usd).toFixed(2)}
              </div>
            </div>
          </div>

          {/* Sub-Navigation: Trade Ticket vs Session History */}
          <div className="grid grid-cols-2 border-b border-[#222631] bg-[#0e1117]/60 text-[11px] font-medium">
            <button
              onClick={() => setDockTab('order')}
              className={`py-2 border-b-2 transition cursor-pointer ${
                dockTab === 'order'
                  ? 'border-[#2962FF] text-white'
                  : 'border-transparent text-[#787b86] hover:text-[#d1d4dc]'
              }`}
            >
              Order Ticket
            </button>
            <button
              onClick={() => setDockTab('history')}
              className={`py-2 border-b-2 transition cursor-pointer ${
                dockTab === 'history'
                  ? 'border-[#2962FF] text-white'
                  : 'border-transparent text-[#787b86] hover:text-[#d1d4dc]'
              }`}
            >
              History ({closedTrades.length})
            </button>
          </div>

          {dockTab === 'order' ? (
            <div className="p-3.5 space-y-3.5 flex-1 overflow-y-auto">
              {/* Instrument Selector */}
              <div className="grid grid-cols-4 gap-1 bg-[#0e1117] p-0.5 rounded-md border border-[#222631] font-mono text-[11px]">
                {Object.keys(instruments).map((k) => (
                  <button
                    key={k}
                    onClick={() => {
                      setInstrumentKey(k);
                      setContracts(instruments[k].default_contracts);
                    }}
                    className={`py-1 rounded transition cursor-pointer ${
                      instrumentKey === k
                        ? 'bg-[#1e222d] text-white font-semibold'
                        : 'text-[#787b86] hover:text-[#d1d4dc]'
                    }`}
                  >
                    {k === 'NAS100_CFD' ? 'CFD' : k}
                  </button>
                ))}
              </div>

              {/* Segmented Order Type */}
              <div className="grid grid-cols-3 gap-1 bg-[#0e1117] p-0.5 rounded-md border border-[#222631] text-[11px]">
                {(['MARKET', 'LIMIT', 'STOP'] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setOrderType(t)}
                    className={`py-1 rounded font-medium transition cursor-pointer ${
                      orderType === t
                        ? 'bg-[#2962FF] text-white'
                        : 'text-[#787b86] hover:text-[#d1d4dc]'
                    }`}
                  >
                    {t === 'MARKET' ? 'Market' : t === 'LIMIT' ? 'Limit' : 'Stop'}
                  </button>
                ))}
              </div>

              {/* Fitts's Law Primary Sell / Buy Quote Execution Buttons */}
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => submitOrder('SHORT')}
                  className="py-2.5 px-2 rounded-lg bg-[#f23645] hover:bg-[#ff4757] text-white transition cursor-pointer text-center shadow-sm"
                  title="Keyboard shortcut: S"
                >
                  <div className="text-[10px] uppercase tracking-wider opacity-90 font-semibold">
                    Sell {orderType === 'MARKET' ? 'Mkt' : orderType}
                  </div>
                  <div className="text-sm font-bold font-mono tabular-nums mt-0.5">
                    {frame?.bid.toFixed(2) ?? '—'}
                  </div>
                </button>

                <button
                  onClick={() => submitOrder('LONG')}
                  className="py-2.5 px-2 rounded-lg bg-[#089981] hover:bg-[#0aa88e] text-white transition cursor-pointer text-center shadow-sm"
                  title="Keyboard shortcut: B"
                >
                  <div className="text-[10px] uppercase tracking-wider opacity-90 font-semibold">
                    Buy {orderType === 'MARKET' ? 'Mkt' : orderType}
                  </div>
                  <div className="text-sm font-bold font-mono tabular-nums mt-0.5">
                    {frame?.ask.toFixed(2) ?? '—'}
                  </div>
                </button>
              </div>

              {/* Clean Order Inputs */}
              <div className="space-y-2.5 pt-1 border-t border-[#222631]">
                {orderType !== 'MARKET' && (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[#9598a1]">{orderType === 'LIMIT' ? 'Limit' : 'Stop'} Price</span>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => setPickMode(pickMode === 'TRIGGER' ? null : 'TRIGGER')}
                        className="p-1 rounded bg-[#1e222d] hover:bg-[#2a2e39] text-amber-300 cursor-pointer"
                        title="Pick price on chart"
                      >
                        <Crosshair className="w-3.5 h-3.5" />
                      </button>
                      <input
                        type="number"
                        step={inst.tick_size}
                        value={triggerPrice}
                        onChange={(e) => setTriggerPrice(Number(e.target.value))}
                        className="w-24 bg-[#0e1117] border border-[#2a2e39] rounded px-2 py-1 text-right font-mono text-white"
                      />
                    </div>
                  </div>
                )}

                <div className="flex items-center justify-between gap-2">
                  <span className="text-[#9598a1]">
                    Quantity <span className="text-[10px] text-[#5d606b]">(${inst.point_value}/pt)</span>
                  </span>
                  <input
                    type="number"
                    min={1}
                    value={contracts}
                    onChange={(e) => setContracts(Math.max(1, Number(e.target.value)))}
                    className="w-24 bg-[#0e1117] border border-[#2a2e39] rounded px-2 py-1 text-right font-mono text-white"
                  />
                </div>

                <div className="flex items-center justify-between gap-2">
                  <label className="flex items-center gap-2 text-[#d1d4dc] cursor-pointer">
                    <input
                      type="checkbox"
                      checked={useBracketSl}
                      onChange={(e) => setUseBracketSl(e.target.checked)}
                      className="accent-[#f23645]"
                    />
                    Stop Loss <span className="text-[10px] text-[#5d606b]">(pts)</span>
                  </label>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setPickMode(pickMode === 'SL' ? null : 'SL')}
                      className="p-1 rounded bg-[#1e222d] hover:bg-[#2a2e39] text-[#9598a1] hover:text-white cursor-pointer"
                      title="Click chart to set Stop Loss"
                    >
                      <Crosshair className="w-3 h-3" />
                    </button>
                    <input
                      type="number"
                      step={2.5}
                      disabled={!useBracketSl}
                      value={slPts}
                      onChange={(e) => setSlPts(Math.max(1, Number(e.target.value)))}
                      className="w-20 bg-[#0e1117] border border-[#2a2e39] rounded px-2 py-1 text-right font-mono text-[#f23645] disabled:opacity-40"
                    />
                  </div>
                </div>

                <div className="flex items-center justify-between gap-2">
                  <label className="flex items-center gap-2 text-[#d1d4dc] cursor-pointer">
                    <input
                      type="checkbox"
                      checked={useBracketTp}
                      onChange={(e) => setUseBracketTp(e.target.checked)}
                      className="accent-[#089981]"
                    />
                    Take Profit <span className="text-[10px] text-[#5d606b]">(pts)</span>
                  </label>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setPickMode(pickMode === 'TP' ? null : 'TP')}
                      className="p-1 rounded bg-[#1e222d] hover:bg-[#2a2e39] text-[#9598a1] hover:text-white cursor-pointer"
                      title="Click chart to set Take Profit"
                    >
                      <Crosshair className="w-3 h-3" />
                    </button>
                    <input
                      type="number"
                      step={2.5}
                      disabled={!useBracketTp}
                      value={tpPts}
                      onChange={(e) => setTpPts(Math.max(1, Number(e.target.value)))}
                      className="w-20 bg-[#0e1117] border border-[#2a2e39] rounded px-2 py-1 text-right font-mono text-[#089981] disabled:opacity-40"
                    />
                  </div>
                </div>

                <div className="flex items-center justify-between text-[11px] text-[#787b86] pt-1 font-mono tabular-nums">
                  <span>Risk -${previewRiskUsd.toFixed(0)}</span>
                  <span>
                    {previewRiskUsd > 0 && previewRewardUsd > 0
                      ? `1 : ${(previewRewardUsd / previewRiskUsd).toFixed(1)} RR`
                      : '—'}
                  </span>
                  <span>Target +${previewRewardUsd.toFixed(0)}</span>
                </div>
              </div>

              {/* Active Open Position Card */}
              {position && (
                <div className="bg-[#0e1117] border border-[#2a2e39] rounded-lg p-3 space-y-2.5">
                  <div className="flex items-center justify-between font-mono tabular-nums">
                    <span
                      className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                        position.direction === 'LONG'
                          ? 'bg-[#089981]/20 text-[#089981]'
                          : 'bg-[#f23645]/20 text-[#f23645]'
                      }`}
                    >
                      {position.direction} ×{position.contracts} @ {position.entryPrice}
                    </span>
                    <span className={`font-bold text-sm ${unrStats.usd >= 0 ? 'text-[#089981]' : 'text-[#f23645]'}`}>
                      {unrStats.usd >= 0 ? '+' : ''}${unrStats.usd.toFixed(2)}
                    </span>
                  </div>

                  <div className="grid grid-cols-2 gap-2 font-mono text-[11px]">
                    <div>
                      <div className="flex justify-between text-[10px] text-[#787b86] mb-0.5">
                        <span>Stop</span>
                        <button onClick={() => setPickMode('SL')} className="text-[#9598a1] hover:text-white cursor-pointer">
                          Pick
                        </button>
                      </div>
                      <input
                        type="number"
                        step={inst.tick_size}
                        value={position.slPrice ?? ''}
                        onChange={(e) =>
                          setPosition({ ...position, slPrice: e.target.value ? Number(e.target.value) : null })
                        }
                        className="w-full bg-[#131722] border border-[#2a2e39] rounded px-2 py-1 text-[#f23645]"
                      />
                    </div>
                    <div>
                      <div className="flex justify-between text-[10px] text-[#787b86] mb-0.5">
                        <span>Target</span>
                        <button onClick={() => setPickMode('TP')} className="text-[#9598a1] hover:text-white cursor-pointer">
                          Pick
                        </button>
                      </div>
                      <input
                        type="number"
                        step={inst.tick_size}
                        value={position.tpPrice ?? ''}
                        onChange={(e) =>
                          setPosition({ ...position, tpPrice: e.target.value ? Number(e.target.value) : null })
                        }
                        className="w-full bg-[#131722] border border-[#2a2e39] rounded px-2 py-1 text-[#089981]"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-1.5 text-[11px] font-medium">
                    <button
                      onClick={moveSlToBreakeven}
                      className="py-1.5 rounded bg-[#1e222d] hover:bg-[#2a2e39] text-[#d1d4dc] cursor-pointer"
                    >
                      Break-Even
                    </button>
                    <button
                      onClick={closeHalfPosition}
                      disabled={position.contracts <= 1}
                      className="py-1.5 rounded bg-[#1e222d] hover:bg-[#2a2e39] disabled:opacity-40 text-[#d1d4dc] cursor-pointer"
                    >
                      50% Out
                    </button>
                    <button
                      onClick={() => flattenPosition('FLATTEN')}
                      className="py-1.5 rounded bg-[#f23645] hover:bg-[#ff4757] text-white cursor-pointer"
                      title="Keyboard shortcut: F"
                    >
                      Flatten
                    </button>
                  </div>
                </div>
              )}

              {/* Working Pending Orders */}
              {pendingOrders.length > 0 && (
                <div className="space-y-1.5 pt-2 border-t border-[#222631]">
                  <div className="text-[10px] text-[#787b86] uppercase tracking-wider">
                    Working Orders ({pendingOrders.length})
                  </div>
                  {pendingOrders.map((ord) => (
                    <div
                      key={ord.id}
                      className="flex items-center justify-between bg-[#0e1117] border border-[#222631] px-2.5 py-1.5 rounded font-mono text-[11px]"
                    >
                      <span className="text-[#d1d4dc]">
                        {ord.direction} {ord.orderType} ×{ord.contracts} @ {ord.triggerPrice}
                      </span>
                      <button
                        onClick={() => setPendingOrders((prev) => prev.filter((o) => o.id !== ord.id))}
                        className="text-[#787b86] hover:text-[#f23645] cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Calm Keyboard Hint Footer */}
              {!position && pendingOrders.length === 0 && (
                <div className="pt-2 text-[11px] text-[#5d606b] leading-relaxed">
                  Shortcuts: <span className="text-[#9598a1] font-mono">Space</span> Play/Pause ·{' '}
                  <span className="text-[#9598a1] font-mono">→</span> +1m ·{' '}
                  <span className="text-[#9598a1] font-mono">B</span> Buy ·{' '}
                  <span className="text-[#9598a1] font-mono">S</span> Sell ·{' '}
                  <span className="text-[#9598a1] font-mono">F</span> Flatten
                </div>
              )}
            </div>
          ) : (
            /* Session Trade History Tab */
            <div className="p-3.5 flex-1 flex flex-col gap-2.5 overflow-hidden">
              <div className="grid grid-cols-3 gap-1.5 bg-[#0e1117] border border-[#222631] rounded-md p-2 text-center font-mono text-[11px]">
                <div>
                  <div className="text-[10px] text-[#787b86]">Trades</div>
                  <div className="text-white font-semibold">{closedTrades.length}</div>
                </div>
                <div>
                  <div className="text-[10px] text-[#787b86]">Win Rate</div>
                  <div className="text-white font-semibold">{sessionStats.wr}%</div>
                </div>
                <div>
                  <div className="text-[10px] text-[#787b86]">PF</div>
                  <div className="text-white font-semibold">{sessionStats.pf}</div>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto space-y-1.5 font-mono text-[11px]">
                {closedTrades.length === 0 ? (
                  <div className="text-[#5d606b] text-center py-8 font-sans">No completed trades in this session yet.</div>
                ) : (
                  closedTrades.map((t) => (
                    <div
                      key={t.id}
                      className="flex items-center justify-between bg-[#0e1117] px-2.5 py-2 rounded border border-[#222631]"
                    >
                      <div>
                        <span className={t.direction === 'LONG' ? 'text-[#089981] font-bold' : 'text-[#f23645] font-bold'}>
                          {t.direction}
                        </span>{' '}
                        <span className="text-[#d1d4dc]">
                          {t.entryPrice} → {t.exitPrice}
                        </span>
                        <span className="text-[#787b86] block text-[10px]">
                          {t.exitEt} · {t.exitReason}
                        </span>
                      </div>
                      <div className={`text-right font-semibold ${t.netPnl >= 0 ? 'text-[#089981]' : 'text-[#f23645]'}`}>
                        {t.netPnl >= 0 ? '+' : ''}${t.netPnl.toFixed(0)}
                        <span className="block text-[10px] font-normal text-[#787b86]">
                          {t.rMultiple >= 0 ? '+' : ''}
                          {t.rMultiple}R
                        </span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      <SuiteSettingsModal
        open={suiteModalOpen}
        onClose={() => setSuiteModalOpen(false)}
        settings={suiteSettings}
        onChange={setSuiteSettings}
      />
    </div>
  );
};
