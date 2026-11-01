import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ColorType,
  CrosshairMode,
  LineStyle,
  createChart,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type Logical,
  type SeriesMarker,
  type Time,
} from 'lightweight-charts';
import type {
  NullablePoint,
  ReplayPanePayload,
  SimClosedTrade,
  SimPendingOrder,
  SimPosition,
  ValuePoint,
} from '../types';

interface Props {
  pane: ReplayPanePayload | undefined;
  tfLabel: string;
  compact?: boolean;
  resetViewportKey: number;
  position: SimPosition | null;
  pendingOrders: SimPendingOrder[];
  closedTrades: SimClosedTrade[];
  pointValue: number;
  tickSize: number;
  currentBid: number;
  currentAsk: number;
  pickMode: 'SL' | 'TP' | 'TRIGGER' | null;
  onPickPrice?: (price: number) => void;
}

const etFullFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  month: 'short',
  day: '2-digit',
  year: 'numeric',
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

function binarySearchLogical(times: number[], targetTs: number, stepSec: number): number {
  const n = times.length;
  if (n === 0) return 0;
  if (targetTs <= times[0]) {
    return (targetTs - times[0]) / Math.max(stepSec, 60);
  }
  const last = times[n - 1];
  if (targetTs >= last) {
    return n - 1 + (targetTs - last) / Math.max(stepSec, 60);
  }
  let lo = 0;
  let hi = n - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = times[mid];
    if (v === targetTs) return mid;
    if (v < targetTs) lo = mid + 1;
    else hi = mid - 1;
  }
  return Math.max(0, lo - 1);
}

export const UniversalSuiteChart: React.FC<Props> = ({
  pane,
  tfLabel,
  compact = false,
  resetViewportKey,
  position,
  pendingOrders,
  closedTrades,
  pointValue,
  tickSize,
  currentBid,
  currentAsk,
  pickMode,
  onPickPrice,
}) => {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const chartContainerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const priceLinesRef = useRef<IPriceLine[]>([]);

  const paneRef = useRef<ReplayPanePayload | undefined>(pane);
  paneRef.current = pane;

  const [hoverBar, setHoverBar] = useState<{
    et: string;
    open: number;
    high: number;
    low: number;
    close: number;
  } | null>(null);

  // High-DPI Canvas Renderer for Multi-Strategy Universal Suite
  const drawOverlay = useCallback(() => {
    const canvas = canvasRef.current;
    const chart = chartRef.current;
    const series = candleSeriesRef.current;
    const curPane = paneRef.current;
    if (!canvas || !chart || !series || !wrapRef.current) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = wrapRef.current.getBoundingClientRect();
    const cssW = Math.floor(rect.width);
    const cssH = Math.floor(rect.height);
    if (cssW <= 0 || cssH <= 0) return;

    if (canvas.width !== Math.floor(cssW * dpr) || canvas.height !== Math.floor(cssH * dpr)) {
      canvas.width = Math.floor(cssW * dpr);
      canvas.height = Math.floor(cssH * dpr);
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cssW, cssH);

    if (!curPane || curPane.candles.length === 0) {
      ctx.restore();
      return;
    }

    const priceScaleW = chart.priceScale('right').width();
    const timeScaleH = chart.timeScale().height();
    const plotW = Math.max(10, cssW - priceScaleW);
    const plotH = Math.max(10, cssH - timeScaleH);

    ctx.beginPath();
    ctx.rect(0, 0, plotW, plotH);
    ctx.clip();

    const candles = curPane.candles;
    const times = candles.map((c) => c.time);
    const n = candles.length;
    const stepSec = n >= 2 ? Math.max(60, times[n - 1] - times[n - 2]) : 180;
    const tsApi = chart.timeScale();

    const tsToX = (ts: number): number | null => {
      const logIdx = binarySearchLogical(times, ts, stepSec);
      const x = tsApi.logicalToCoordinate(logIdx as Logical);
      return x === null ? null : Number(x);
    };

    const pToY = (price: number): number | null => {
      const y = series.priceToCoordinate(price);
      return y === null ? null : Number(y);
    };

    const drawValueLine = (pts: ValuePoint[] | undefined, color: string, width: number, dashed = false) => {
      if (!pts || pts.length < 2) return;
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      if (dashed) ctx.setLineDash([4, 4]);
      ctx.beginPath();
      let started = false;
      for (const pt of pts) {
        const x = tsToX(pt.time);
        const y = pToY(pt.value);
        if (x === null || y === null) continue;
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
      ctx.restore();
    };

    const drawNullableSegmentedLine = (pts: NullablePoint[] | undefined, color: string, width: number) => {
      if (!pts || pts.length < 2) return;
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      let penDown = false;
      for (const pt of pts) {
        if (pt.value === null || pt.value === undefined) {
          penDown = false;
          continue;
        }
        const x = tsToX(pt.time);
        const y = pToY(pt.value);
        if (x === null || y === null) {
          penDown = false;
          continue;
        }
        if (!penDown) {
          ctx.moveTo(x, y);
          penDown = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
      ctx.restore();
    };

    const drawBandFill = (upper: ValuePoint[] | undefined, lower: ValuePoint[] | undefined, fillCss: string) => {
      if (!upper || !lower || upper.length < 2 || lower.length !== upper.length) return;
      const upCoords: Array<[number, number]> = [];
      const dnCoords: Array<[number, number]> = [];
      for (let i = 0; i < upper.length; i++) {
        const x = tsToX(upper[i].time);
        const yu = pToY(upper[i].value);
        const yl = pToY(lower[i].value);
        if (x !== null && yu !== null && yl !== null) {
          upCoords.push([x, yu]);
          dnCoords.push([x, yl]);
        }
      }
      if (upCoords.length < 2) return;
      ctx.save();
      ctx.fillStyle = fillCss;
      ctx.beginPath();
      ctx.moveTo(upCoords[0][0], upCoords[0][1]);
      for (let i = 1; i < upCoords.length; i++) ctx.lineTo(upCoords[i][0], upCoords[i][1]);
      for (let i = dnCoords.length - 1; i >= 0; i--) ctx.lineTo(dnCoords[i][0], dnCoords[i][1]);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    };

    const suite = curPane.suite;

    // --- 3. VWAP & Bands Fill + Lines ---
    if (suite.vwap) {
      drawBandFill(suite.vwap.u3, suite.vwap.l3, 'rgba(20, 184, 166, 0.06)');
      drawBandFill(suite.vwap.u2, suite.vwap.l2, 'rgba(132, 204, 22, 0.06)');
      drawBandFill(suite.vwap.u1, suite.vwap.l1, 'rgba(34, 197, 94, 0.07)');

      drawValueLine(suite.vwap.u3, '#14b8a6', 1);
      drawValueLine(suite.vwap.l3, '#14b8a6', 1);
      drawValueLine(suite.vwap.u2, '#84cc16', 1);
      drawValueLine(suite.vwap.l2, '#84cc16', 1);
      drawValueLine(suite.vwap.u1, '#22c55e', 1.1);
      drawValueLine(suite.vwap.l1, '#22c55e', 1.1);
      drawValueLine(suite.vwap.vwap, '#2962FF', 1.8);
    }

    // --- 1. Fair Value Gap [LuxAlgo] ---
    if (suite.fvg) {
      for (const box of suite.fvg.boxes) {
        const x1 = tsToX(box.start_ts);
        const x2 = tsToX(box.end_ts);
        const yTop = pToY(box.max);
        const yBot = pToY(box.min);
        if (x1 === null || x2 === null || yTop === null || yBot === null) continue;

        const left = Math.max(0, Math.min(x1, x2));
        const right = Math.min(plotW, Math.max(x1, x2));
        if (right <= 0 || left >= plotW) continue;

        const top = Math.min(yTop, yBot);
        const h = Math.max(1.5, Math.abs(yBot - yTop));
        const w = Math.max(3, right - left);

        ctx.fillStyle = box.is_bull ? 'rgba(8, 153, 129, 0.28)' : 'rgba(242, 54, 69, 0.28)';
        ctx.fillRect(left, top, w, h);

        ctx.strokeStyle = box.is_bull ? 'rgba(8, 153, 129, 0.65)' : 'rgba(242, 54, 69, 0.65)';
        ctx.lineWidth = 1;
        ctx.strokeRect(left, top, w, h);

        if (!compact && w > 48 && h >= 13) {
          ctx.fillStyle = box.is_bull ? 'rgba(167, 243, 208, 0.78)' : 'rgba(254, 205, 211, 0.78)';
          ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
          const tag = box.tf && box.tf !== 'Chart' ? `${box.tf === '240' ? '4H' : box.tf === '60' ? '1H' : box.tf + 'm'} FVG` : 'FVG';
          ctx.fillText(tag, left + 4, top + 11);
        }
      }

      // Dynamic FVG bands if enabled
      if (suite.fvg.dynamic) {
        const dyn = suite.fvg.dynamic;
        const fillNullable = (mx: NullablePoint[], mn: NullablePoint[], css: string) => {
          ctx.save();
          ctx.fillStyle = css;
          for (let i = 1; i < mx.length; i++) {
            const u0 = mx[i - 1].value;
            const l0 = mn[i - 1].value;
            const u1 = mx[i].value;
            const l1 = mn[i].value;
            if (u0 === null || l0 === null || u1 === null || l1 === null) continue;
            const x0 = tsToX(mx[i - 1].time);
            const x1 = tsToX(mx[i].time);
            const yu0 = pToY(u0);
            const yl0 = pToY(l0);
            const yu1 = pToY(u1);
            const yl1 = pToY(l1);
            if (x0 === null || x1 === null || yu0 === null || yl0 === null || yu1 === null || yl1 === null) continue;
            ctx.beginPath();
            ctx.moveTo(x0, yu0);
            ctx.lineTo(x1, yu1);
            ctx.lineTo(x1, yl1);
            ctx.lineTo(x0, yl0);
            ctx.closePath();
            ctx.fill();
          }
          ctx.restore();
        };
        fillNullable(dyn.bull_max, dyn.bull_min, 'rgba(8, 153, 129, 0.28)');
        fillNullable(dyn.bear_max, dyn.bear_min, 'rgba(242, 54, 69, 0.28)');
      }

      // Mitigation dashed lines
      for (const ml of suite.fvg.mitigation_lines) {
        const x1 = tsToX(ml.start_ts);
        const x2 = tsToX(ml.end_ts);
        const y = pToY(ml.price);
        if (x1 === null || x2 === null || y === null) continue;
        ctx.save();
        ctx.strokeStyle = ml.is_bull ? 'rgba(8, 153, 129, 0.7)' : 'rgba(242, 54, 69, 0.7)';
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x1, y);
        ctx.lineTo(x2, y);
        ctx.stroke();
        ctx.restore();
      }

      // Unmitigated level lines
      for (const ul of suite.fvg.unmitigated_lines) {
        const x1 = tsToX(ul.start_ts);
        const x2 = tsToX(ul.end_ts);
        const y = pToY(ul.price);
        if (x1 === null || x2 === null || y === null) continue;
        ctx.save();
        ctx.strokeStyle = ul.is_bull ? '#089981' : '#f23645';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(x1, y);
        ctx.lineTo(x2, y);
        ctx.stroke();
        ctx.restore();
      }
    }

    // --- 4. 0DTE Anchored Expected Move [SyntaxGeek] ---
    if (suite.aem) {
      drawNullableSegmentedLine(suite.aem.center, '#ffffff', 2.4);
      drawNullableSegmentedLine(suite.aem.em_high, '#14b8a6', 2.4);
      drawNullableSegmentedLine(suite.aem.em_low, '#ef4444', 2.4);
      drawNullableSegmentedLine(suite.aem.run_high, 'rgba(20, 184, 166, 0.65)', 1.0);
      drawNullableSegmentedLine(suite.aem.run_low, 'rgba(239, 68, 68, 0.65)', 1.0);
    }

    // --- 2. MA Cross (Short SMA #FF6D00, Long SMA #43A047, Cross #2962FF +) ---
    if (suite.ma) {
      drawValueLine(suite.ma.short_ma, '#FF6D00', 1.7);
      drawValueLine(suite.ma.long_ma, '#43A047', 1.7);

      ctx.save();
      ctx.strokeStyle = '#2962FF';
      ctx.lineWidth = 2.8;
      for (const cr of suite.ma.crosses) {
        const x = tsToX(cr.time);
        const y = pToY(cr.price);
        if (x === null || y === null) continue;
        const arm = 5.5;
        ctx.beginPath();
        ctx.moveTo(x - arm, y);
        ctx.lineTo(x + arm, y);
        ctx.moveTo(x, y - arm);
        ctx.lineTo(x, y + arm);
        ctx.stroke();
      }
      ctx.restore();
    }

    // --- 5. Multi-Timeframe Right-Side Candles (15m +6, 1H +11, 4H +16, 1D +21) ---
    if (suite.mtf_candles && suite.mtf_candles.length > 0 && n >= 2) {
      const lastIdx = n - 1;
      const xLast = tsApi.logicalToCoordinate(lastIdx as Logical);
      const xPrev = tsApi.logicalToCoordinate((lastIdx - 1) as Logical);
      const barPx = xLast !== null && xPrev !== null ? Math.max(3, Math.min(14, Math.abs(xLast - xPrev) * 0.85)) : 6;

      for (const mc of suite.mtf_candles) {
        const cx = tsApi.logicalToCoordinate((lastIdx + mc.offset) as Logical);
        const yOpen = pToY(mc.open);
        const yHigh = pToY(mc.high);
        const yLow = pToY(mc.low);
        const yClose = pToY(mc.close);
        if (cx === null || yOpen === null || yHigh === null || yLow === null || yClose === null) continue;
        if (cx < 0 || cx > plotW - 4) continue;

        const isBull = mc.close >= mc.open;
        const strokeCol = isBull ? '#089981' : '#f23645';
        const fillCol = isBull ? 'rgba(8, 153, 129, 0.55)' : 'rgba(242, 54, 69, 0.55)';

        // Wick
        ctx.save();
        ctx.strokeStyle = strokeCol;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(cx, yHigh);
        ctx.lineTo(cx, yLow);
        ctx.stroke();

        // Body (offset -1 .. +1 logical bars around center, matching Pine box.new(idx+5, ..., idx+7, ...))
        const halfW = Math.max(4, barPx * 1.15);
        const bodyTop = Math.min(yOpen, yClose);
        const bodyH = Math.max(2, Math.abs(yClose - yOpen));
        ctx.fillStyle = fillCol;
        ctx.fillRect(cx - halfW, bodyTop, halfW * 2, bodyH);
        ctx.strokeRect(cx - halfW, bodyTop, halfW * 2, bodyH);

        // Label above high ("15m", "1H", "4H", "1D")
        ctx.fillStyle = strokeCol;
        ctx.font = 'bold 10px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(mc.label, cx, Math.max(11, yHigh - 6));
        ctx.restore();
      }
    }

    ctx.restore();
  }, [compact]);

  // Initialize TradingView Lightweight Chart
  useEffect(() => {
    if (!chartContainerRef.current || !wrapRef.current) return;
    const chart = createChart(chartContainerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: '#131722' },
        textColor: '#d1d4dc',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: '#1e222d' },
        horzLines: { color: '#1e222d' },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: '#758696', width: 1, style: LineStyle.Dashed, labelBackgroundColor: '#2962FF' },
        horzLine: { color: '#758696', width: 1, style: LineStyle.Dashed, labelBackgroundColor: '#2962FF' },
      },
      rightPriceScale: {
        borderColor: '#2a2e39',
        scaleMargins: { top: 0.08, bottom: 0.16 },
      },
      localization: {
        timeFormatter: (t: number) => `${etFullFmt.format(new Date(t * 1000))} ET`,
      },
      timeScale: {
        borderColor: '#2a2e39',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 27,
        shiftVisibleRangeOnNewBar: true,
        tickMarkFormatter: (t: number) => etTickFmt.format(new Date(t * 1000)),
      },
    });

    const candleSeries = chart.addCandlestickSeries({
      upColor: '#089981',
      downColor: '#f23645',
      borderUpColor: '#089981',
      borderDownColor: '#f23645',
      wickUpColor: '#089981',
      wickDownColor: '#f23645',
    });

    const volSeries = chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: '',
    });
    volSeries.priceScale().applyOptions({
      scaleMargins: { top: 0.87, bottom: 0 },
    });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volSeriesRef.current = volSeries;

    let rafId = 0;
    const scheduleDraw = () => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(drawOverlay);
    };

    chart.timeScale().subscribeVisibleLogicalRangeChange(scheduleDraw);

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        chart.applyOptions({ width, height });
        scheduleDraw();
      }
    });
    ro.observe(wrapRef.current);

    return () => {
      cancelAnimationFrame(rafId);
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
    };
  }, [drawOverlay]);

  // Click-on-chart handler for interactive SL / TP / Limit-Stop placement
  useEffect(() => {
    const chart = chartRef.current;
    const series = candleSeriesRef.current;
    if (!chart || !series) return;

    const clickHandler = (param: { point?: { x: number; y: number } }) => {
      if (!pickMode || !onPickPrice || !param.point) return;
      const rawPrice = series.coordinateToPrice(param.point.y);
      if (rawPrice !== null) {
        const rounded = Math.round(Number(rawPrice) / tickSize) * tickSize;
        onPickPrice(Number(rounded.toFixed(2)));
      }
    };
    chart.subscribeClick(clickHandler);
    return () => {
      chart.unsubscribeClick(clickHandler);
    };
  }, [pickMode, onPickPrice, tickSize]);

  // Update candles & closed trade markers when `pane` or `closedTrades` changes
  useEffect(() => {
    const chart = chartRef.current;
    const series = candleSeriesRef.current;
    const volSeries = volSeriesRef.current;
    if (!chart || !series || !volSeries || !pane) return;

    const candles = pane.candles;
    series.setData(
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
        color: c.close >= c.open ? 'rgba(8, 153, 129, 0.22)' : 'rgba(242, 54, 69, 0.22)',
      }))
    );

    const byTs = new Map(candles.map((c) => [c.time, c]));
    const moveSub = (param: { time?: Time }) => {
      if (!param.time) {
        setHoverBar(null);
      } else {
        const b = byTs.get(Number(param.time));
        if (b) setHoverBar({ et: b.et, open: b.open, high: b.high, low: b.low, close: b.close });
      }
      requestAnimationFrame(drawOverlay);
    };
    chart.subscribeCrosshairMove(moveSub);

    // Closed session trades markers
    if (candles.length >= 2 && closedTrades.length > 0) {
      const stepSec = Math.max(60, candles[candles.length - 1].time - candles[candles.length - 2].time);
      const minT = candles[0].time;
      const maxT = candles[candles.length - 1].time + stepSec;
      const markers: SeriesMarker<Time>[] = [];

      for (const tr of closedTrades) {
        const eBucket = Math.floor(tr.entryTs / stepSec) * stepSec;
        const xBucket = Math.floor(tr.exitTs / stepSec) * stepSec;
        if (eBucket >= minT && eBucket <= maxT) {
          markers.push({
            time: eBucket as Time,
            position: tr.direction === 'LONG' ? 'belowBar' : 'aboveBar',
            color: tr.direction === 'LONG' ? '#089981' : '#f23645',
            shape: tr.direction === 'LONG' ? 'arrowUp' : 'arrowDown',
            text: `${tr.direction} ${tr.contracts}`,
          });
        }
        if (xBucket >= minT && xBucket <= maxT) {
          markers.push({
            time: xBucket as Time,
            position: tr.direction === 'LONG' ? 'aboveBar' : 'belowBar',
            color: tr.netPnl >= 0 ? '#2962FF' : '#fb923c',
            shape: 'circle',
            text: `${tr.netPnl >= 0 ? '+' : ''}$${tr.netPnl.toFixed(0)}`,
          });
        }
      }
      markers.sort((a, b) => Number(a.time) - Number(b.time));
      series.setMarkers(markers);
    } else {
      series.setMarkers([]);
    }

    requestAnimationFrame(drawOverlay);

    return () => {
      chart.unsubscribeCrosshairMove(moveSub);
    };
  }, [pane, closedTrades, drawOverlay]);

  // Reset viewport range smoothly on initial load / jump / TF change (without resetting during +1m steps!)
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !pane || pane.candles.length === 0) return;
    const n = pane.candles.length;
    const visibleBars = compact ? 75 : 115;
    chart.timeScale().setVisibleLogicalRange({
      from: Math.max(0, n - visibleBars),
      to: n + 26,
    });
    requestAnimationFrame(drawOverlay);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetViewportKey, tfLabel]);

  // Active Position & Pending Orders Price Lines
  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series) return;

    for (const pl of priceLinesRef.current) {
      series.removePriceLine(pl);
    }
    priceLinesRef.current = [];

    if (position) {
      const markExit = position.direction === 'LONG' ? currentBid : currentAsk;
      const unrPts = position.direction === 'LONG' ? markExit - position.entryPrice : position.entryPrice - markExit;
      const unrUsd = unrPts * pointValue * position.contracts;

      priceLinesRef.current.push(
        series.createPriceLine({
          price: position.entryPrice,
          color: '#2962FF',
          lineWidth: 2,
          lineStyle: LineStyle.Solid,
          axisLabelVisible: true,
          title: `${position.direction} ${position.contracts} (${unrUsd >= 0 ? '+' : ''}$${unrUsd.toFixed(0)})`,
        })
      );

      if (position.slPrice !== null) {
        const slRiskPts =
          position.direction === 'LONG' ? position.slPrice - position.entryPrice : position.entryPrice - position.slPrice;
        const slUsd = slRiskPts * pointValue * position.contracts;
        priceLinesRef.current.push(
          series.createPriceLine({
            price: position.slPrice,
            color: '#f23645',
            lineWidth: 2,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: `SL (${slUsd >= 0 ? '+' : ''}$${slUsd.toFixed(0)})`,
          })
        );
      }

      if (position.tpPrice !== null) {
        const tpPts =
          position.direction === 'LONG' ? position.tpPrice - position.entryPrice : position.entryPrice - position.tpPrice;
        const tpUsd = tpPts * pointValue * position.contracts;
        priceLinesRef.current.push(
          series.createPriceLine({
            price: position.tpPrice,
            color: '#089981',
            lineWidth: 2,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: `TP (+$${tpUsd.toFixed(0)})`,
          })
        );
      }
    }

    for (const ord of pendingOrders) {
      priceLinesRef.current.push(
        series.createPriceLine({
          price: ord.triggerPrice,
          color: '#f59e0b',
          lineWidth: 1,
          lineStyle: LineStyle.Dotted,
          axisLabelVisible: true,
          title: `${ord.direction} ${ord.orderType} x${ord.contracts}`,
        })
      );
    }
  }, [position, pendingOrders, currentBid, currentAsk, pointValue]);

  const latest = pane?.candles[pane.candles.length - 1];
  const shown = hoverBar ?? (latest ? { et: latest.et, open: latest.open, high: latest.high, low: latest.low, close: latest.close } : null);

  return (
    <div
      ref={wrapRef}
      className={`relative w-full h-full bg-[#131722] rounded-xl border overflow-hidden select-none ${
        pickMode ? 'border-amber-400 cursor-crosshair ring-1 ring-amber-400/50' : 'border-slate-800/90'
      }`}
    >
      {/* Top-Left TradingView Watermark / Legend */}
      <div className="absolute top-2 left-2.5 z-20 pointer-events-none flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2 bg-[#131722]/88 backdrop-blur-xs px-2 py-1 rounded border border-slate-800/80 text-[11px] font-mono">
          <span className="font-bold text-white px-1.5 py-0.2 rounded bg-[#2962FF]/25 border border-[#2962FF]/50 text-cyan-200">
            NAS100 · {tfLabel}
          </span>
          {shown && (
            <>
              <span className="text-slate-400">{shown.et} ET</span>
              <span className="text-slate-300">O {shown.open.toFixed(2)}</span>
              <span className="text-[#089981]">H {shown.high.toFixed(2)}</span>
              <span className="text-[#f23645]">L {shown.low.toFixed(2)}</span>
              <span className={shown.close >= shown.open ? 'text-[#089981] font-bold' : 'text-[#f23645] font-bold'}>
                C {shown.close.toFixed(2)}
              </span>
            </>
          )}
        </div>

        {!compact && (
          <div className="flex flex-wrap items-center gap-2.5 px-2 py-0.5 bg-[#131722]/75 rounded text-[10px] font-mono text-slate-300">
            <span className="text-slate-400 font-semibold">Universal Suite:</span>
            {pane?.suite.fvg && <span className="text-[#089981]">■ FVG ({pane.suite.fvg.boxes.length})</span>}
            {pane?.suite.ma && (
              <span>
                <span className="text-[#FF6D00]">SMA {pane.suite.ma.short_len}</span> /{' '}
                <span className="text-[#43A047]">SMA {pane.suite.ma.long_len}</span>
              </span>
            )}
            {pane?.suite.vwap && <span className="text-[#2962FF]">● VWAP</span>}
            {pane?.suite.aem && <span className="text-white">━ 0DTE AEM</span>}
            {pane?.suite.mtf_candles && <span className="text-cyan-300">▮ MTF (15m·1H·4H·1D)</span>}
          </div>
        )}

        {pickMode && (
          <div className="px-2.5 py-1 rounded bg-amber-500/20 border border-amber-400/60 text-amber-200 text-xs font-semibold">
            Click anywhere on chart to set {pickMode === 'SL' ? 'Stop-Loss' : pickMode === 'TP' ? 'Take-Profit' : 'Order Trigger'} price
          </div>
        )}
      </div>

      {/* Base Lightweight Charts Canvas */}
      <div ref={chartContainerRef} className="w-full h-full" />

      {/* Synchronized High-DPI Universal Suite Overlay Canvas */}
      <canvas ref={canvasRef} className="absolute inset-0 pointer-events-none z-10" />
    </div>
  );
};
