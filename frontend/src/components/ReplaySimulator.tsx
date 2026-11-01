import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Crosshair,
  Dices,
  FastForward,
  Grid2x2,
  Columns2,
  Maximize2,
  Pause,
  Play,
  RotateCcw,
  Sliders,
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

  return (
    <div className="flex flex-col h-[calc(100vh-120px)] min-h-[600px] gap-2.5">
      {/* Top Replay & Multi-Timeframe Command Bar */}
      <div className="bg-[#131722] border border-slate-800 rounded-xl px-3 py-2 flex flex-wrap items-center justify-between gap-2 text-xs shrink-0">
        {/* Left: Timeframe Buttons & Layout Switcher */}
        <div className="flex flex-wrap items-center gap-2">
          {layoutMode === 'single' && (
            <div className="flex items-center bg-slate-950 border border-slate-800 rounded-lg p-0.5 font-mono">
              {SINGLE_TFS.map((t) => (
                <button
                  key={t.code}
                  onClick={() => setActiveTf(t.code)}
                  className={`px-2.5 py-1 rounded-md transition cursor-pointer ${
                    activeTf === t.code
                      ? 'bg-[#2962FF] text-white font-bold'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          )}

          <div className="flex items-center bg-slate-950 border border-slate-800 rounded-lg p-0.5">
            <button
              onClick={() => setLayoutMode('single')}
              className={`px-2 py-1 rounded flex items-center gap-1 cursor-pointer ${
                layoutMode === 'single' ? 'bg-slate-800 text-cyan-300 font-semibold' : 'text-slate-400 hover:text-white'
              }`}
              title="Single Chart View"
            >
              <Maximize2 className="w-3.5 h-3.5" /> Single
            </button>
            <button
              onClick={() => setLayoutMode('split')}
              className={`px-2 py-1 rounded flex items-center gap-1 cursor-pointer ${
                layoutMode === 'split' ? 'bg-slate-800 text-cyan-300 font-semibold' : 'text-slate-400 hover:text-white'
              }`}
              title="2-Chart Split: 3m + 15m"
            >
              <Columns2 className="w-3.5 h-3.5" /> 3m + 15m
            </button>
            <button
              onClick={() => setLayoutMode('quad')}
              className={`px-2 py-1 rounded flex items-center gap-1 cursor-pointer ${
                layoutMode === 'quad' ? 'bg-slate-800 text-cyan-300 font-semibold' : 'text-slate-400 hover:text-white'
              }`}
              title="4-Chart Multi-Timeframe Grid: 3m · 15m · 1H · 4H"
            >
              <Grid2x2 className="w-3.5 h-3.5" /> Quad (3m·15m·1H·4H)
            </button>
          </div>

          <button
            onClick={() => setSuiteModalOpen(true)}
            className="px-2.5 py-1.5 rounded-lg bg-[#2962FF]/15 hover:bg-[#2962FF]/25 border border-[#2962FF]/40 text-cyan-200 font-medium flex items-center gap-1.5 cursor-pointer"
          >
            <Sliders className="w-3.5 h-3.5 text-[#2962FF]" /> Universal Suite
          </button>
        </div>

        {/* Center: Replay Transport Controls */}
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            onClick={() => {
              setPlaying(false);
              loadReplay('random_ny_open', { resetZoom: true });
            }}
            className="px-2.5 py-1.5 rounded-lg bg-purple-500/15 hover:bg-purple-500/25 border border-purple-500/40 text-purple-200 font-medium flex items-center gap-1 cursor-pointer"
            title="Teleport to a random historical NY Morning (09:20 ET) across 5–10 years"
          >
            <Dices className="w-3.5 h-3.5" /> Random NY Morning
          </button>

          <button
            onClick={() => {
              setPlaying(false);
              loadReplay('next_ny_open', { resetZoom: true });
            }}
            className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 flex items-center gap-1 cursor-pointer"
            title="Skip overnight session straight to next trading day 09:20 ET"
          >
            <FastForward className="w-3.5 h-3.5 text-amber-400" /> Next NY Open
          </button>

          <div className="flex items-center gap-1 bg-slate-950 border border-slate-800 rounded-lg px-2 py-1 font-mono">
            <input
              type="date"
              value={jumpDate}
              onChange={(e) => setJumpDate(e.target.value)}
              className="bg-transparent text-slate-200 outline-none text-[11px]"
            />
            <input
              type="time"
              value={jumpTime}
              onChange={(e) => setJumpTime(e.target.value)}
              className="bg-transparent text-cyan-300 outline-none text-[11px] w-16"
            />
            <button
              onClick={() => {
                setPlaying(false);
                loadReplay('jump_date', { resetZoom: true });
              }}
              className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-cyan-300 text-[11px] cursor-pointer"
            >
              Go
            </button>
          </div>

          <div className="flex items-center gap-1 bg-slate-950 border border-slate-800 rounded-lg p-0.5">
            <button
              onClick={() => setPlaying((p) => !p)}
              className={`px-3 py-1 rounded-md font-bold flex items-center gap-1 cursor-pointer ${
                playing ? 'bg-amber-500 text-slate-950' : 'bg-[#089981] hover:bg-emerald-500 text-white'
              }`}
              title="Spacebar to Play / Pause"
            >
              {playing ? <Pause className="w-3.5 h-3.5 fill-current" /> : <Play className="w-3.5 h-3.5 fill-current" />}
              {playing ? 'Pause' : 'Play'}
            </button>

            <button
              onClick={() => {
                setPlaying(false);
                loadReplay('step', { stepBars: 1 });
              }}
              className="px-2 py-1 rounded hover:bg-slate-800 text-slate-200 font-mono flex items-center gap-0.5 cursor-pointer"
              title="Right Arrow (→): Advance +1 minute"
            >
              <StepForward className="w-3.5 h-3.5" /> +1m
            </button>
            <button
              onClick={() => {
                setPlaying(false);
                loadReplay('step', { stepBars: 3 });
              }}
              className="px-2 py-1 rounded hover:bg-slate-800 text-slate-200 font-mono cursor-pointer"
              title="Shift + Right Arrow: Advance +3 minutes"
            >
              +3m
            </button>
            <button
              onClick={() => {
                setPlaying(false);
                loadReplay('step', { stepBars: 5 });
              }}
              className="px-2 py-1 rounded hover:bg-slate-800 text-slate-200 font-mono cursor-pointer"
            >
              +5m
            </button>
            <button
              onClick={() => {
                setPlaying(false);
                loadReplay('step', { stepBars: 15 });
              }}
              className="px-2 py-1 rounded hover:bg-slate-800 text-slate-200 font-mono cursor-pointer"
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
              className="bg-slate-900 border border-slate-700 rounded px-1.5 py-1 font-mono text-[11px] text-cyan-300"
              title="Play speed"
            >
              <option value="800_1">1x (1m/tick)</option>
              <option value="350_1">3x (1m/tick)</option>
              <option value="160_1">6x (1m/tick)</option>
              <option value="300_3">Fast (3m/tick)</option>
              <option value="250_5">Turbo (5m/tick)</option>
            </select>
          </div>
        </div>
      </div>

      {/* Main Split: Left Chart(s) + Right Paper-Trading Execution Dock */}
      <div className="flex-1 flex flex-col lg:flex-row gap-2.5 min-h-0">
        {/* Chart Area */}
        <div className="flex-1 min-h-0 relative">
          {toast && (
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-30 px-3.5 py-1.5 rounded-full bg-slate-900/95 border border-cyan-500/50 text-cyan-200 text-xs font-mono shadow-xl">
              {toast}
            </div>
          )}
          {loading && (
            <div className="absolute top-3 right-20 z-30 px-2.5 py-1 rounded bg-[#2962FF]/20 border border-[#2962FF]/50 text-cyan-200 text-xs font-mono">
              Syncing Replay...
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

        {/* Right Paper-Trading Order Execution Dock */}
        <div className="w-full lg:w-80 shrink-0 bg-[#131722] border border-slate-800 rounded-xl p-3 flex flex-col gap-3 overflow-y-auto text-xs">
          {/* Sim Clock & Live Quote Tape */}
          <div className="bg-slate-950/90 border border-slate-800 rounded-lg p-2.5 space-y-1.5 font-mono">
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-cyan-400 font-bold">{frame?.sim_et ?? '—'} ET</span>
              <span className="text-slate-400">Spd {frame?.spread.toFixed(2)}pt</span>
            </div>
            <div className="grid grid-cols-2 gap-2 pt-1 border-t border-slate-800/80">
              <div className="bg-[#f23645]/10 border border-[#f23645]/30 rounded px-2 py-1 text-center">
                <div className="text-[10px] text-rose-300">SELL BID</div>
                <div className="text-sm font-bold text-[#f23645]">{frame?.bid.toFixed(2) ?? '—'}</div>
              </div>
              <div className="bg-[#089981]/10 border border-[#089981]/30 rounded px-2 py-1 text-center">
                <div className="text-[10px] text-emerald-300">BUY ASK</div>
                <div className="text-sm font-bold text-[#089981]">{frame?.ask.toFixed(2) ?? '—'}</div>
              </div>
            </div>
          </div>

          {/* Account Balance & Session KPIs */}
          <div className="bg-slate-900/70 border border-slate-800 rounded-lg p-2.5 space-y-1.5 font-mono">
            <div className="flex items-center justify-between">
              <span className="text-slate-400 text-[11px]">Account Equity</span>
              <button
                onClick={() => {
                  setBalance(50000);
                  setClosedTrades([]);
                  setPosition(null);
                  setPendingOrders([]);
                  showNotice('Reset simulation account to $50,000');
                }}
                className="text-[10px] text-slate-400 hover:text-white flex items-center gap-0.5 cursor-pointer"
                title="Reset balance & session history"
              >
                <RotateCcw className="w-2.5 h-2.5" /> Reset
              </button>
            </div>
            <div className="flex items-baseline justify-between">
              <span className="text-base font-bold text-white">
                ${(balance + unrStats.usd).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
              <span className={`text-xs font-bold ${sessionStats.net >= 0 ? 'text-[#089981]' : 'text-[#f23645]'}`}>
                {sessionStats.net >= 0 ? '+' : ''}${sessionStats.net.toFixed(2)}
              </span>
            </div>
            <div className="flex items-center justify-between text-[10px] text-slate-400 pt-1 border-t border-slate-800/70">
              <span>{closedTrades.length} Trades</span>
              <span>WR {sessionStats.wr}%</span>
              <span>PF {sessionStats.pf}</span>
            </div>
          </div>

          {/* Instrument & Order Entry Ticket */}
          <div className="bg-slate-900/70 border border-slate-800 rounded-lg p-2.5 space-y-2.5">
            <div className="grid grid-cols-4 gap-1 font-mono text-[11px]">
              {Object.keys(instruments).map((k) => (
                <button
                  key={k}
                  onClick={() => {
                    setInstrumentKey(k);
                    setContracts(instruments[k].default_contracts);
                  }}
                  className={`py-1 rounded border cursor-pointer ${
                    instrumentKey === k
                      ? 'bg-[#2962FF]/25 border-[#2962FF] text-white font-bold'
                      : 'bg-slate-950 border-slate-800 text-slate-400'
                  }`}
                >
                  {k === 'NAS100_CFD' ? 'CFD' : k}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[10px] text-slate-400 block mb-0.5">Order Type</label>
                <select
                  value={orderType}
                  onChange={(e) => setOrderType(e.target.value as 'MARKET' | 'LIMIT' | 'STOP')}
                  className="w-full bg-slate-950 border border-slate-800 rounded px-2 py-1 text-white"
                >
                  <option value="MARKET">Market</option>
                  <option value="LIMIT">Limit</option>
                  <option value="STOP">Stop</option>
                </select>
              </div>
              <div>
                <label className="text-[10px] text-slate-400 block mb-0.5">
                  Qty (${inst.point_value}/pt)
                </label>
                <input
                  type="number"
                  min={1}
                  value={contracts}
                  onChange={(e) => setContracts(Math.max(1, Number(e.target.value)))}
                  className="w-full bg-slate-950 border border-slate-800 rounded px-2 py-1 font-mono text-white text-right"
                />
              </div>
            </div>

            {orderType !== 'MARKET' && (
              <div>
                <div className="flex items-center justify-between text-[10px] text-slate-400 mb-0.5">
                  <span>{orderType} Trigger Price</span>
                  <button
                    onClick={() => setPickMode(pickMode === 'TRIGGER' ? null : 'TRIGGER')}
                    className="text-amber-300 hover:underline flex items-center gap-0.5 cursor-pointer"
                  >
                    <Crosshair className="w-3 h-3" /> Pick on Chart
                  </button>
                </div>
                <input
                  type="number"
                  step={inst.tick_size}
                  value={triggerPrice}
                  onChange={(e) => setTriggerPrice(Number(e.target.value))}
                  className="w-full bg-slate-950 border border-amber-500/40 rounded px-2 py-1 font-mono text-amber-300"
                />
              </div>
            )}

            {/* Bracket SL & TP */}
            <div className="space-y-1.5 pt-1 border-t border-slate-800/80">
              <div className="flex items-center justify-between gap-1.5">
                <label className="flex items-center gap-1.5 text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={useBracketSl}
                    onChange={(e) => setUseBracketSl(e.target.checked)}
                    className="accent-[#f23645]"
                  />
                  SL (Pts)
                </label>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setPickMode(pickMode === 'SL' ? null : 'SL')}
                    className="px-1.5 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-[10px] text-rose-300 cursor-pointer"
                    title="Click price on chart"
                  >
                    Pick
                  </button>
                  <input
                    type="number"
                    step={2.5}
                    disabled={!useBracketSl}
                    value={slPts}
                    onChange={(e) => setSlPts(Math.max(1, Number(e.target.value)))}
                    className="w-20 bg-slate-950 border border-slate-800 rounded px-2 py-0.5 text-right font-mono text-rose-300 disabled:opacity-40"
                  />
                </div>
              </div>

              <div className="flex items-center justify-between gap-1.5">
                <label className="flex items-center gap-1.5 text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={useBracketTp}
                    onChange={(e) => setUseBracketTp(e.target.checked)}
                    className="accent-[#089981]"
                  />
                  TP (Pts)
                </label>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setPickMode(pickMode === 'TP' ? null : 'TP')}
                    className="px-1.5 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-[10px] text-emerald-300 cursor-pointer"
                    title="Click price on chart"
                  >
                    Pick
                  </button>
                  <input
                    type="number"
                    step={2.5}
                    disabled={!useBracketTp}
                    value={tpPts}
                    onChange={(e) => setTpPts(Math.max(1, Number(e.target.value)))}
                    className="w-20 bg-slate-950 border border-slate-800 rounded px-2 py-0.5 text-right font-mono text-emerald-300 disabled:opacity-40"
                  />
                </div>
              </div>

              <div className="flex items-center justify-between text-[10px] font-mono text-slate-400 pt-0.5">
                <span>Risk: -${previewRiskUsd.toFixed(0)}</span>
                <span>
                  RR: {previewRiskUsd > 0 && previewRewardUsd > 0 ? (previewRewardUsd / previewRiskUsd).toFixed(2) : '—'}
                </span>
                <span>Goal: +${previewRewardUsd.toFixed(0)}</span>
              </div>
            </div>

            {/* Buy / Sell Action Buttons */}
            <div className="grid grid-cols-2 gap-2 pt-1">
              <button
                onClick={() => submitOrder('LONG')}
                className="py-2.5 rounded-lg bg-[#089981] hover:bg-emerald-500 text-white font-bold shadow-lg shadow-emerald-950/50 transition cursor-pointer"
                title="Shortcut: B"
              >
                BUY {orderType === 'MARKET' ? 'MKT' : orderType} (B)
              </button>
              <button
                onClick={() => submitOrder('SHORT')}
                className="py-2.5 rounded-lg bg-[#f23645] hover:bg-rose-500 text-white font-bold shadow-lg shadow-rose-950/50 transition cursor-pointer"
                title="Shortcut: S"
              >
                SELL {orderType === 'MARKET' ? 'MKT' : orderType} (S)
              </button>
            </div>
          </div>

          {/* Live Open Position Manager */}
          {position && (
            <div className="bg-slate-950 border border-[#2962FF]/60 rounded-lg p-2.5 space-y-2 font-mono">
              <div className="flex items-center justify-between">
                <span
                  className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                    position.direction === 'LONG'
                      ? 'bg-[#089981]/20 text-[#089981]'
                      : 'bg-[#f23645]/20 text-[#f23645]'
                  }`}
                >
                  {position.direction} x{position.contracts} @ {position.entryPrice}
                </span>
                <span className={`font-bold text-sm ${unrStats.usd >= 0 ? 'text-[#089981]' : 'text-[#f23645]'}`}>
                  {unrStats.usd >= 0 ? '+' : ''}${unrStats.usd.toFixed(2)} ({unrStats.pts >= 0 ? '+' : ''}
                  {unrStats.pts}pt)
                </span>
              </div>

              <div className="grid grid-cols-2 gap-1.5 text-[11px]">
                <div>
                  <div className="flex justify-between text-[10px] text-slate-400">
                    <span>Live SL</span>
                    <button onClick={() => setPickMode('SL')} className="text-rose-300 cursor-pointer">
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
                    className="w-full bg-slate-900 border border-slate-700 rounded px-1.5 py-0.5 text-rose-300"
                  />
                </div>
                <div>
                  <div className="flex justify-between text-[10px] text-slate-400">
                    <span>Live TP</span>
                    <button onClick={() => setPickMode('TP')} className="text-emerald-300 cursor-pointer">
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
                    className="w-full bg-slate-900 border border-slate-700 rounded px-1.5 py-0.5 text-emerald-300"
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-1 pt-1 text-[10px] font-sans font-semibold">
                <button
                  onClick={moveSlToBreakeven}
                  className="py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-cyan-300 cursor-pointer"
                >
                  SL → BE
                </button>
                <button
                  onClick={closeHalfPosition}
                  disabled={position.contracts <= 1}
                  className="py-1.5 rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-amber-300 cursor-pointer"
                >
                  Close 50%
                </button>
                <button
                  onClick={() => flattenPosition('FLATTEN')}
                  className="py-1.5 rounded bg-rose-600/80 hover:bg-rose-500 text-white cursor-pointer"
                  title="Shortcut: F"
                >
                  Flatten (F)
                </button>
              </div>
            </div>
          )}

          {/* Pending Orders */}
          {pendingOrders.length > 0 && (
            <div className="bg-slate-900/60 border border-slate-800 rounded-lg p-2 space-y-1 font-mono text-[11px]">
              <div className="text-[10px] text-slate-400 uppercase">Working Orders ({pendingOrders.length})</div>
              {pendingOrders.map((ord) => (
                <div key={ord.id} className="flex items-center justify-between bg-slate-950 px-2 py-1 rounded">
                  <span className="text-amber-300">
                    {ord.direction} {ord.orderType} x{ord.contracts} @ {ord.triggerPrice}
                  </span>
                  <button
                    onClick={() => setPendingOrders((prev) => prev.filter((o) => o.id !== ord.id))}
                    className="text-slate-400 hover:text-rose-400 cursor-pointer"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Session Closed Trades Log */}
          <div className="flex-1 min-h-[120px] flex flex-col bg-slate-900/50 border border-slate-800 rounded-lg p-2 overflow-hidden">
            <div className="text-[10px] text-slate-400 uppercase font-semibold mb-1.5">
              Session Executions ({closedTrades.length})
            </div>
            <div className="flex-1 overflow-y-auto space-y-1 font-mono text-[11px]">
              {closedTrades.length === 0 ? (
                <div className="text-slate-500 text-center py-4 text-[11px] font-sans">
                  Press <kbd className="px-1 bg-slate-800 rounded">Play</kbd> or{' '}
                  <kbd className="px-1 bg-slate-800 rounded">→</kbd> to step candles, then trade with{' '}
                  <kbd className="px-1 bg-slate-800 rounded">B</kbd> / <kbd className="px-1 bg-slate-800 rounded">S</kbd>
                </div>
              ) : (
                closedTrades.map((t) => (
                  <div
                    key={t.id}
                    className="flex items-center justify-between bg-slate-950/80 px-2 py-1 rounded border border-slate-800/70"
                  >
                    <div>
                      <span className={t.direction === 'LONG' ? 'text-[#089981] font-bold' : 'text-[#f23645] font-bold'}>
                        {t.direction[0]}
                      </span>{' '}
                      <span className="text-slate-300">
                        {t.entryPrice}→{t.exitPrice}
                      </span>
                      <span className="text-slate-500 block text-[9px]">{t.exitEt} · {t.exitReason}</span>
                    </div>
                    <div className={`text-right font-bold ${t.netPnl >= 0 ? 'text-[#089981]' : 'text-[#f23645]'}`}>
                      {t.netPnl >= 0 ? '+' : ''}${t.netPnl.toFixed(0)}
                      <span className="block text-[9px] font-normal">
                        {t.rMultiple >= 0 ? '+' : ''}
                        {t.rMultiple}R
                      </span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
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
