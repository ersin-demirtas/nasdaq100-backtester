import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ColorType,
  CrosshairMode,
  LineStyle,
  createChart,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type SeriesMarker,
  type Time,
} from 'lightweight-charts';
import { ChevronLeft, ChevronRight, Crosshair, History, Layers } from 'lucide-react';
import { api } from '../api';
import type { CandleWindowResponse, TradeRecord } from '../types';

interface Props {
  datasetId: string;
  strategyId: string;
  strategyParams: Record<string, unknown>;
  trades: TradeRecord[];
  selectedTrade: TradeRecord | null;
  onSelectTrade: (trade: TradeRecord | null) => void;
}

const etFullFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const etTickFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export const CandlestickTerminal: React.FC<Props> = ({
  datasetId,
  strategyId,
  strategyParams,
  trades,
  selectedTrade,
  onSelectTrade,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const overlaySeriesRefs = useRef<ISeriesApi<'Line'>[]>([]);
  const priceLinesRef = useRef<IPriceLine[]>([]);

  const [windowData, setWindowData] = useState<CandleWindowResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [showOverlays, setShowOverlays] = useState(true);
  const [hoverInfo, setHoverInfo] = useState<{
    et: string;
    open: number;
    high: number;
    low: number;
    close: number;
    spread: number;
  } | null>(null);

  const selectedTradeIndex = useMemo(() => {
    if (!selectedTrade) return -1;
    return trades.findIndex((t) => t.id === selectedTrade.id);
  }, [trades, selectedTrade]);

  // Fetch 5m candle window (centered on selected trade if present, else most recent bars)
  const loadWindow = async (opts?: { centerTs?: number; endTs?: number }) => {
    if (!datasetId) return;
    setLoading(true);
    try {
      const res = await api.fetchCandles({
        dataset_id: datasetId,
        center_ts: opts?.centerTs,
        end_ts: opts?.endTs,
        limit: 1600,
        strategy_id: strategyId,
        strategy_params: strategyParams,
      });
      setWindowData(res);
    } catch (err) {
      console.error('Failed loading candles:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (selectedTrade) {
      loadWindow({ centerTs: selectedTrade.entry_ts });
    } else {
      loadWindow();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datasetId, strategyId, JSON.stringify(strategyParams), selectedTrade?.id]);

  // Initialize TradingView Lightweight Chart once
  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: '#080d19' },
        textColor: '#94a3b8',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: '#131d31' },
        horzLines: { color: '#131d31' },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: '#38bdf8', width: 1, style: LineStyle.Dashed, labelBackgroundColor: '#0284c7' },
        horzLine: { color: '#38bdf8', width: 1, style: LineStyle.Dashed, labelBackgroundColor: '#0284c7' },
      },
      rightPriceScale: {
        borderColor: '#1e293b',
        scaleMargins: { top: 0.08, bottom: 0.18 },
      },
      localization: {
        timeFormatter: (t: number) => `${etFullFmt.format(new Date(t * 1000))} ET`,
      },
      timeScale: {
        borderColor: '#1e293b',
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: (t: number) => etTickFmt.format(new Date(t * 1000)),
      },
    });

    const candleSeries = chart.addCandlestickSeries({
      upColor: '#10b981',
      downColor: '#f43f5e',
      borderUpColor: '#10b981',
      borderDownColor: '#f43f5e',
      wickUpColor: '#10b981',
      wickDownColor: '#f43f5e',
    });

    const volSeries = chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: '',
    });
    volSeries.priceScale().applyOptions({
      scaleMargins: { top: 0.85, bottom: 0 },
    });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volSeriesRef.current = volSeries;

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        chart.applyOptions({ width, height });
      }
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
    };
  }, []);

  // Populate candles, overlays, trade markers, and selected trade SL/TP lines
  useEffect(() => {
    const chart = chartRef.current;
    const candleSeries = candleSeriesRef.current;
    const volSeries = volSeriesRef.current;
    if (!chart || !candleSeries || !volSeries || !windowData) return;

    const candles = windowData.candles;
    candleSeries.setData(
      candles.map((c) => ({
        time: c.time as Time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      }))
    );

    volSeries.setData(
      candles.map((c) => ({
        time: c.time as Time,
        value: c.volume,
        color: c.close >= c.open ? 'rgba(16, 185, 129, 0.25)' : 'rgba(244, 63, 94, 0.25)',
      }))
    );

    const candleByTs = new Map(candles.map((c) => [c.time, c]));
    const subHandler = (param: { time?: Time }) => {
      if (!param.time) {
        setHoverInfo(null);
        return;
      }
      const bar = candleByTs.get(Number(param.time));
      if (bar) {
        setHoverInfo({
          et: bar.et,
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
          spread: bar.spread,
        });
      }
    };
    chart.subscribeCrosshairMove(subHandler);

    // Clear old overlay series
    for (const s of overlaySeriesRefs.current) {
      try {
        chart.removeSeries(s);
      } catch {
        // ignore removed
      }
    }
    overlaySeriesRefs.current = [];

    if (showOverlays && windowData.overlays) {
      for (const ov of windowData.overlays) {
        const ls = chart.addLineSeries({
          color: ov.color,
          lineWidth: 2,
          lineStyle: ov.style === 'dashed' ? LineStyle.Dashed : LineStyle.Solid,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        });
        ls.setData(ov.data.map((p) => ({ time: p.time as Time, value: p.value })));
        overlaySeriesRefs.current.push(ls);
      }
    }

    // Filter trades inside visible candle range and set markers
    if (candles.length > 0) {
      const minT = candles[0].time;
      const maxT = candles[candles.length - 1].time;
      const markers: SeriesMarker<Time>[] = [];

      for (const tr of trades) {
        if (tr.entry_ts >= minT && tr.entry_ts <= maxT) {
          const isSelected = selectedTrade?.id === tr.id;
          markers.push({
            time: tr.entry_ts as Time,
            position: tr.direction === 'LONG' ? 'belowBar' : 'aboveBar',
            color: tr.direction === 'LONG' ? '#22c55e' : '#f43f5e',
            shape: tr.direction === 'LONG' ? 'arrowUp' : 'arrowDown',
            text: `${isSelected ? '★ ' : ''}#${tr.id} ${tr.direction}`,
          });
        }
        if (tr.exit_ts >= minT && tr.exit_ts <= maxT) {
          markers.push({
            time: tr.exit_ts as Time,
            position: tr.direction === 'LONG' ? 'aboveBar' : 'belowBar',
            color: tr.net_pnl >= 0 ? '#38bdf8' : '#fb923c',
            shape: 'circle',
            text: `${tr.exit_reason} (${tr.net_pnl >= 0 ? '+' : ''}$${tr.net_pnl.toFixed(0)})`,
          });
        }
      }
      markers.sort((a, b) => Number(a.time) - Number(b.time));
      candleSeries.setMarkers(markers);
    } else {
      candleSeries.setMarkers([]);
    }

    // Clear previous SL/TP price lines
    for (const pline of priceLinesRef.current) {
      candleSeries.removePriceLine(pline);
    }
    priceLinesRef.current = [];

    if (selectedTrade && candles.length > 0) {
      const entryLine = candleSeries.createPriceLine({
        price: selectedTrade.entry_price,
        color: '#38bdf8',
        lineWidth: 2,
        lineStyle: LineStyle.Solid,
        axisLabelVisible: true,
        title: `ENTRY #${selectedTrade.id} (${selectedTrade.direction})`,
      });
      const slLine = candleSeries.createPriceLine({
        price: selectedTrade.initial_sl,
        color: '#f43f5e',
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: 'INITIAL SL',
      });
      const tpLine = candleSeries.createPriceLine({
        price: selectedTrade.initial_tp,
        color: '#10b981',
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: 'TARGET TP',
      });
      priceLinesRef.current = [entryLine, slLine, tpLine];

      // Focus viewport tightly around the selected trade (~90 bars context)
      const fromTs = (selectedTrade.entry_ts - 45 * 300) as Time;
      const toTs = (Math.max(selectedTrade.exit_ts, selectedTrade.entry_ts) + 45 * 300) as Time;
      chart.timeScale().setVisibleRange({ from: fromTs, to: toTs });
    } else {
      chart.timeScale().fitContent();
    }

    return () => {
      chart.unsubscribeCrosshairMove(subHandler);
    };
  }, [windowData, trades, selectedTrade, showOverlays]);

  const jumpTrade = (delta: number) => {
    if (trades.length === 0) return;
    if (selectedTradeIndex === -1) {
      onSelectTrade(trades[trades.length - 1]);
      return;
    }
    const nextIdx = Math.max(0, Math.min(trades.length - 1, selectedTradeIndex + delta));
    onSelectTrade(trades[nextIdx]);
  };

  return (
    <div className="flex flex-col h-full bg-[#080d19] rounded-xl border border-slate-800/80 overflow-hidden">
      {/* Chart Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2 bg-slate-900/80 border-b border-slate-800 text-xs">
        <div className="flex items-center gap-3">
          <span className="font-semibold text-cyan-400 flex items-center gap-1.5">
            <Crosshair className="w-3.5 h-3.5" /> 5m Execution Chart (ET Timezone)
          </span>
          {windowData?.overlays && windowData.overlays.length > 0 && (
            <div className="hidden md:flex items-center gap-2.5 pl-2 border-l border-slate-800">
              {windowData.overlays.map((ov) => (
                <span key={ov.name} className="flex items-center gap-1 text-slate-300">
                  <span className="w-2.5 h-0.5 inline-block" style={{ backgroundColor: ov.color }} />
                  {ov.name}
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          {windowData?.has_more_left && windowData.candles.length > 0 && (
            <button
              onClick={() => loadWindow({ endTs: windowData.candles[0].time + 200 * 300 })}
              className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 flex items-center gap-1 transition"
              title="Scroll further back in 5–10 year history"
            >
              <History className="w-3.5 h-3.5" /> Earlier Bars
            </button>
          )}

          <button
            onClick={() => setShowOverlays((v) => !v)}
            className={`px-2.5 py-1 rounded flex items-center gap-1 border transition ${
              showOverlays
                ? 'bg-cyan-500/15 border-cyan-500/40 text-cyan-300'
                : 'bg-slate-800 border-slate-700 text-slate-400'
            }`}
          >
            <Layers className="w-3.5 h-3.5" /> Overlays
          </button>

          {trades.length > 0 && (
            <div className="flex items-center gap-1 bg-slate-950/90 border border-slate-800 rounded-md p-0.5">
              <button
                onClick={() => jumpTrade(-1)}
                disabled={selectedTradeIndex === 0}
                className="px-2 py-0.5 rounded hover:bg-slate-800 disabled:opacity-40 text-slate-200 flex items-center gap-0.5"
              >
                <ChevronLeft className="w-3.5 h-3.5" /> Prev Scalp
              </button>
              <span className="px-2 font-mono text-[11px] text-slate-400">
                {selectedTrade ? `#${selectedTrade.id} / ${trades.length}` : `${trades.length} trades`}
              </span>
              <button
                onClick={() => jumpTrade(1)}
                disabled={selectedTradeIndex === trades.length - 1}
                className="px-2 py-0.5 rounded hover:bg-slate-800 disabled:opacity-40 text-slate-200 flex items-center gap-0.5"
              >
                Next Scalp <ChevronRight className="w-3.5 h-3.5" />
              </button>
              {selectedTrade && (
                <button
                  onClick={() => onSelectTrade(null)}
                  className="px-1.5 py-0.5 text-[11px] text-slate-400 hover:text-white"
                  title="Reset to latest bars"
                >
                  ✕
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Live OHLC + Spread Crosshair Bar & Selected Scalp HUD */}
      <div className="relative flex-1 min-h-[460px]">
        <div className="absolute top-2.5 left-3 z-10 pointer-events-none flex flex-col gap-2">
          {hoverInfo && (
            <div className="bg-slate-950/85 backdrop-blur px-2.5 py-1 rounded border border-slate-800/90 font-mono text-[11px] flex items-center gap-3 text-slate-300">
              <span className="text-cyan-400">{hoverInfo.et} ET</span>
              <span>O {hoverInfo.open.toFixed(2)}</span>
              <span className="text-emerald-400">H {hoverInfo.high.toFixed(2)}</span>
              <span className="text-rose-400">L {hoverInfo.low.toFixed(2)}</span>
              <span className="text-white font-semibold">C {hoverInfo.close.toFixed(2)}</span>
              <span className="text-amber-400">Spd {hoverInfo.spread.toFixed(2)}pt</span>
            </div>
          )}

          {selectedTrade && (
            <div className="bg-slate-900/92 backdrop-blur px-3 py-2 rounded-lg border border-slate-700/80 shadow-xl text-xs max-w-md">
              <div className="flex items-center justify-between gap-4 mb-1">
                <span className="font-bold text-white flex items-center gap-1.5">
                  <span
                    className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${
                      selectedTrade.direction === 'LONG'
                        ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                        : 'bg-rose-500/20 text-rose-300 border border-rose-500/40'
                    }`}
                  >
                    {selectedTrade.direction} #{selectedTrade.id}
                  </span>
                  <span className="text-slate-400 font-mono text-[11px]">{selectedTrade.entry_et} ET</span>
                </span>
                <span
                  className={`font-mono font-bold text-sm ${
                    selectedTrade.net_pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'
                  }`}
                >
                  {selectedTrade.net_pnl >= 0 ? '+' : ''}${selectedTrade.net_pnl.toFixed(2)} (
                  {selectedTrade.r_multiple >= 0 ? '+' : ''}
                  {selectedTrade.r_multiple.toFixed(2)}R)
                </span>
              </div>
              <div className="grid grid-cols-4 gap-2 font-mono text-[11px] text-slate-300 pt-1 border-t border-slate-800">
                <div>
                  <span className="text-slate-500 block">Entry → Exit</span>
                  {selectedTrade.entry_price} → {selectedTrade.exit_price}
                </div>
                <div>
                  <span className="text-slate-500 block">Exit Reason</span>
                  <span className="text-cyan-300">{selectedTrade.exit_reason}</span> ({selectedTrade.hold_minutes}m)
                </div>
                <div>
                  <span className="text-slate-500 block">MAE / MFE</span>
                  -{selectedTrade.mae_pts} / +{selectedTrade.mfe_pts}pt
                </div>
                <div>
                  <span className="text-slate-500 block">Friction</span>
                  <span className="text-amber-400">-${selectedTrade.friction_cost.toFixed(2)}</span>
                </div>
              </div>
            </div>
          )}
        </div>

        {loading && (
          <div className="absolute top-2.5 right-4 z-10 px-2.5 py-1 rounded bg-cyan-500/20 border border-cyan-500/40 text-cyan-300 text-xs font-mono">
            Loading 5m bars...
          </div>
        )}

        <div ref={containerRef} className="w-full h-full" />
      </div>
    </div>
  );
};
