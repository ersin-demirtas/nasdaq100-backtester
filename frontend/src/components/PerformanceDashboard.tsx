import React, { useEffect, useRef } from 'react';
import { ColorType, LineStyle, createChart, type Time } from 'lightweight-charts';
import type { BacktestResult } from '../types';

interface Props {
  result: BacktestResult;
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const fmtUsd = (v: number) =>
  `${v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const PerformanceDashboard: React.FC<Props> = ({ result }) => {
  const eqChartRef = useRef<HTMLDivElement | null>(null);
  const ddChartRef = useRef<HTMLDivElement | null>(null);

  const { kpis, equity_curve, time_of_day, day_of_week, monthly_matrix, exit_reasons, r_distribution, mae_mfe_scatter } =
    result;

  // Render Net vs Gross Equity Curve & Drawdown % Curve with TradingView Lightweight Charts
  useEffect(() => {
    if (!eqChartRef.current || !ddChartRef.current || equity_curve.length === 0) return;

    const eqChart = createChart(eqChartRef.current, {
      height: 240,
      layout: { background: { type: ColorType.Solid, color: '#0b1222' }, textColor: '#94a3b8', fontSize: 11 },
      grid: { vertLines: { color: '#141e33' }, horzLines: { color: '#141e33' } },
      rightPriceScale: { borderColor: '#1e293b' },
      timeScale: { borderColor: '#1e293b', timeVisible: true },
    });

    const grossSeries = eqChart.addLineSeries({
      color: '#f59e0b',
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      title: 'Gross (Zero Friction)',
    });
    const netSeries = eqChart.addAreaSeries({
      lineColor: kpis.net_pnl >= 0 ? '#10b981' : '#f43f5e',
      topColor: kpis.net_pnl >= 0 ? 'rgba(16, 185, 129, 0.28)' : 'rgba(244, 63, 94, 0.28)',
      bottomColor: 'rgba(15, 23, 42, 0.0)',
      lineWidth: 2,
      title: 'Net Equity',
    });

    grossSeries.setData(equity_curve.map((p) => ({ time: p.time as Time, value: p.gross_equity })));
    netSeries.setData(equity_curve.map((p) => ({ time: p.time as Time, value: p.net_equity })));
    eqChart.timeScale().fitContent();

    const ddChart = createChart(ddChartRef.current, {
      height: 120,
      layout: { background: { type: ColorType.Solid, color: '#0b1222' }, textColor: '#94a3b8', fontSize: 11 },
      grid: { vertLines: { color: '#141e33' }, horzLines: { color: '#141e33' } },
      rightPriceScale: { borderColor: '#1e293b' },
      timeScale: { borderColor: '#1e293b', timeVisible: true },
    });
    const ddSeries = ddChart.addAreaSeries({
      lineColor: '#f43f5e',
      topColor: 'rgba(244, 63, 94, 0.04)',
      bottomColor: 'rgba(244, 63, 94, 0.35)',
      lineWidth: 1,
      title: 'DD %',
    });
    ddSeries.setData(equity_curve.map((p) => ({ time: p.time as Time, value: p.drawdown_pct })));
    ddChart.timeScale().fitContent();

    const ro = new ResizeObserver(() => {
      if (eqChartRef.current) eqChart.applyOptions({ width: eqChartRef.current.clientWidth });
      if (ddChartRef.current) ddChart.applyOptions({ width: ddChartRef.current.clientWidth });
    });
    ro.observe(eqChartRef.current);

    return () => {
      ro.disconnect();
      eqChart.remove();
      ddChart.remove();
    };
  }, [equity_curve, kpis.net_pnl]);

  const maxAbsTodPnl = Math.max(1, ...time_of_day.map((t) => Math.abs(t.net_pnl)));
  const maxRCount = Math.max(1, ...r_distribution.map((r) => r.count));
  const maxMae = Math.max(20, ...mae_mfe_scatter.map((s) => s.mae_pts));
  const maxMfe = Math.max(20, ...mae_mfe_scatter.map((s) => s.mfe_pts));

  return (
    <div className="space-y-4 pb-6">
      {/* Top 8 Institutional Scalping KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-2.5">
        <div className="bg-slate-900/90 border border-slate-800 rounded-lg p-3">
          <div className="text-[11px] text-slate-400 uppercase tracking-wider">Net Profit</div>
          <div className={`text-lg font-bold font-mono mt-0.5 ${kpis.net_pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
            {fmtUsd(kpis.net_pnl)}
          </div>
          <div className="text-[11px] font-mono text-slate-400">
            {kpis.net_return_pct >= 0 ? '+' : ''}
            {kpis.net_return_pct}% ROI
          </div>
        </div>

        <div className="bg-slate-900/90 border border-slate-800 rounded-lg p-3">
          <div className="text-[11px] text-slate-400 uppercase tracking-wider">Gross vs Friction</div>
          <div className="text-base font-bold font-mono mt-0.5 text-amber-300">{fmtUsd(kpis.gross_pnl)}</div>
          <div className="text-[11px] font-mono text-rose-400">Cost: -{fmtUsd(kpis.total_friction_cost)}</div>
        </div>

        <div className="bg-slate-900/90 border border-slate-800 rounded-lg p-3">
          <div className="text-[11px] text-slate-400 uppercase tracking-wider">Profit Factor</div>
          <div className={`text-lg font-bold font-mono mt-0.5 ${kpis.profit_factor >= 1.2 ? 'text-emerald-400' : kpis.profit_factor >= 1.0 ? 'text-amber-300' : 'text-rose-400'}`}>
            {kpis.profit_factor.toFixed(2)}
          </div>
          <div className="text-[11px] font-mono text-slate-400">Payoff {kpis.payoff_ratio.toFixed(2)}x</div>
        </div>

        <div className="bg-slate-900/90 border border-slate-800 rounded-lg p-3">
          <div className="text-[11px] text-slate-400 uppercase tracking-wider">Win Rate</div>
          <div className="text-lg font-bold font-mono mt-0.5 text-cyan-300">{kpis.win_rate_pct.toFixed(1)}%</div>
          <div className="text-[11px] font-mono text-slate-400">
            {kpis.total_trades.toLocaleString()} scalps
          </div>
        </div>

        <div className="bg-slate-900/90 border border-slate-800 rounded-lg p-3">
          <div className="text-[11px] text-slate-400 uppercase tracking-wider">Expectancy</div>
          <div className={`text-lg font-bold font-mono mt-0.5 ${kpis.expectancy_r >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
            {kpis.expectancy_r >= 0 ? '+' : ''}
            {kpis.expectancy_r.toFixed(2)}R
          </div>
          <div className="text-[11px] font-mono text-slate-400">{fmtUsd(kpis.expectancy_usd)} / trade</div>
        </div>

        <div className="bg-slate-900/90 border border-slate-800 rounded-lg p-3">
          <div className="text-[11px] text-slate-400 uppercase tracking-wider">Max Drawdown</div>
          <div className="text-lg font-bold font-mono mt-0.5 text-rose-400">-{kpis.max_drawdown_pct.toFixed(2)}%</div>
          <div className="text-[11px] font-mono text-slate-400">-{fmtUsd(kpis.max_drawdown_usd)}</div>
        </div>

        <div className="bg-slate-900/90 border border-slate-800 rounded-lg p-3">
          <div className="text-[11px] text-slate-400 uppercase tracking-wider">Sharpe / Sortino</div>
          <div className="text-lg font-bold font-mono mt-0.5 text-indigo-300">
            {kpis.sharpe_ratio.toFixed(2)} <span className="text-slate-500">/</span> {kpis.sortino_ratio.toFixed(2)}
          </div>
          <div className="text-[11px] font-mono text-slate-400">Calmar {kpis.calmar_ratio.toFixed(2)}</div>
        </div>

        <div className="bg-slate-900/90 border border-slate-800 rounded-lg p-3">
          <div className="text-[11px] text-slate-400 uppercase tracking-wider">Hold & Bias</div>
          <div className="text-lg font-bold font-mono mt-0.5 text-slate-100">{kpis.avg_hold_minutes}m avg</div>
          <div className="text-[11px] font-mono text-slate-400">
            L:{kpis.long_win_rate_pct}% · S:{kpis.short_win_rate_pct}%
          </div>
        </div>
      </div>

      {/* Net vs Gross Equity Curve + Underwater Drawdown */}
      <div className="bg-[#0b1222] border border-slate-800 rounded-xl p-4">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
          <div>
            <h3 className="text-sm font-semibold text-white">
              Net Equity vs. Zero-Friction Gross Equity & Underwater Drawdown
            </h3>
            <p className="text-xs text-slate-400">
              Visualizes exact scalping spread + slippage + commission drag over the multi-year test horizon
            </p>
          </div>
          <div className="flex items-center gap-4 text-xs font-mono">
            <span className="flex items-center gap-1.5 text-emerald-400">
              <span className="w-3 h-0.5 bg-emerald-400 inline-block" /> Net Equity
            </span>
            <span className="flex items-center gap-1.5 text-amber-400">
              <span className="w-3 h-0.5 border-t border-dashed border-amber-400 inline-block" /> Gross (No Spread/Slip/Comm)
            </span>
            <span className="flex items-center gap-1.5 text-rose-400">
              <span className="w-3 h-2 bg-rose-500/40 inline-block rounded-xs" /> Drawdown %
            </span>
          </div>
        </div>
        <div ref={eqChartRef} className="w-full" />
        <div ref={ddChartRef} className="w-full mt-1" />
      </div>

      {/* NY Time-of-Day Killzone Edge & Day-of-Week Breakdown */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 bg-slate-900/80 border border-slate-800 rounded-xl p-4">
          <h3 className="text-sm font-semibold text-white mb-1">
            New York Time-of-Day Edge (ET 30-Minute Entry Windows)
          </h3>
          <p className="text-xs text-slate-400 mb-3">
            Pinpoints which NY Killzone half-hours generate net alpha vs. midday chop bleed
          </p>
          {time_of_day.length === 0 ? (
            <div className="text-xs text-slate-500 py-8 text-center">No trades executed.</div>
          ) : (
            <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
              {time_of_day.map((row) => {
                const widthPct = Math.max(3, (Math.abs(row.net_pnl) / maxAbsTodPnl) * 100);
                const pos = row.net_pnl >= 0;
                return (
                  <div key={row.slot} className="grid grid-cols-12 items-center gap-2 text-xs font-mono">
                    <div className="col-span-2 text-slate-300">{row.slot} ET</div>
                    <div className="col-span-6 bg-slate-950 rounded h-4 overflow-hidden flex items-center px-1">
                      <div
                        className={`h-2.5 rounded ${pos ? 'bg-emerald-500' : 'bg-rose-500'}`}
                        style={{ width: `${widthPct}%` }}
                      />
                    </div>
                    <div className={`col-span-2 text-right font-semibold ${pos ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {fmtUsd(row.net_pnl)}
                    </div>
                    <div className="col-span-2 text-right text-slate-400">
                      {row.win_rate_pct}% ({row.trades})
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4 flex flex-col justify-between">
          <div>
            <h3 className="text-sm font-semibold text-white mb-1">Day-of-Week & Exit Breakdown</h3>
            <p className="text-xs text-slate-400 mb-3">Net PnL by weekday & trade termination reason</p>
            <div className="space-y-1.5 mb-4">
              {day_of_week.map((d) => (
                <div key={d.day} className="flex items-center justify-between text-xs font-mono py-1 border-b border-slate-800/60">
                  <span className="text-slate-300 w-10">{d.day}</span>
                  <span className="text-slate-400">{d.trades} tr · {d.win_rate_pct}% WR</span>
                  <span className={d.net_pnl >= 0 ? 'text-emerald-400 font-semibold' : 'text-rose-400 font-semibold'}>
                    {fmtUsd(d.net_pnl)}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div>
            <div className="text-xs font-semibold text-slate-300 mb-2">Exit Reasons</div>
            <div className="space-y-1">
              {exit_reasons.map((ex) => (
                <div key={ex.reason} className="flex items-center justify-between text-[11px] font-mono bg-slate-950/70 px-2.5 py-1 rounded">
                  <span className="text-cyan-300">{ex.reason}</span>
                  <span className="text-slate-400">
                    {ex.trades} ({ex.pct_of_trades}%)
                  </span>
                  <span className={ex.net_pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}>{fmtUsd(ex.net_pnl)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Multi-Year Monthly Returns Matrix */}
      <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4 overflow-x-auto">
        <h3 className="text-sm font-semibold text-white mb-1">Multi-Year Monthly Return Heatmap (% of Initial Capital)</h3>
        <p className="text-xs text-slate-400 mb-3">Regime consistency check across bull, bear, and high-rate years</p>
        <table className="w-full text-xs font-mono border-collapse">
          <thead>
            <tr className="text-slate-400 border-b border-slate-800">
              <th className="text-left py-1.5 px-2">Year</th>
              {MONTH_NAMES.map((m) => (
                <th key={m} className="text-right py-1.5 px-2">
                  {m}
                </th>
              ))}
              <th className="text-right py-1.5 px-2 text-white">Year Total</th>
            </tr>
          </thead>
          <tbody>
            {monthly_matrix.map((row) => (
              <tr key={row.year} className="border-b border-slate-800/50">
                <td className="py-1.5 px-2 font-bold text-slate-200">{row.year}</td>
                {Array.from({ length: 12 }, (_, idx) => {
                  const cell = row.months[String(idx + 1)];
                  if (!cell) {
                    return (
                      <td key={idx} className="text-right py-1.5 px-2 text-slate-700">
                        —
                      </td>
                    );
                  }
                  const intensity = Math.min(0.45, Math.max(0.08, Math.abs(cell.pct) / 12));
                  const bg =
                    cell.pct >= 0
                      ? `rgba(16, 185, 129, ${intensity})`
                      : `rgba(244, 63, 94, ${intensity})`;
                  return (
                    <td
                      key={idx}
                      style={{ backgroundColor: bg }}
                      className={`text-right py-1.5 px-2 rounded-xs ${
                        cell.pct >= 0 ? 'text-emerald-200' : 'text-rose-200'
                      }`}
                      title={`${fmtUsd(cell.usd)} (${cell.trades} scalps)`}
                    >
                      {cell.pct >= 0 ? '+' : ''}
                      {cell.pct.toFixed(1)}%
                    </td>
                  );
                })}
                <td
                  className={`text-right py-1.5 px-2 font-bold ${
                    row.year_total_pct >= 0 ? 'text-emerald-400' : 'text-rose-400'
                  }`}
                >
                  {row.year_total_pct >= 0 ? '+' : ''}
                  {row.year_total_pct.toFixed(1)}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* R-Multiple Histogram + MAE vs MFE Excursion Scatter */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4">
          <h3 className="text-sm font-semibold text-white mb-1">R-Multiple Distribution</h3>
          <p className="text-xs text-slate-400 mb-3">Realized reward-to-initial-risk profile across all scalps</p>
          <div className="flex items-end gap-1.5 h-44 pt-4">
            {r_distribution.map((b) => {
              const hPct = Math.max(2, (b.count / maxRCount) * 100);
              const isPos = !b.bucket.startsWith('-') && !b.bucket.startsWith('<-');
              return (
                <div key={b.bucket} className="flex-1 flex flex-col items-center h-full justify-end">
                  <span className="text-[10px] font-mono text-slate-400 mb-1">{b.count || ''}</span>
                  <div
                    className={`w-full rounded-t ${isPos ? 'bg-emerald-500/80' : 'bg-rose-500/80'}`}
                    style={{ height: `${hPct}%` }}
                  />
                  <span className="text-[9px] font-mono text-slate-400 mt-1.5 rotate-[-25deg] origin-top-left whitespace-nowrap">
                    {b.bucket}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4">
          <h3 className="text-sm font-semibold text-white mb-1">MAE vs. MFE Excursion Scatter (Points)</h3>
          <p className="text-xs text-slate-400 mb-2">
            X = Max Adverse Drawdown (Pts) · Y = Max Favorable Run-up (Pts). Tune tight stops & TP targets!
          </p>
          <svg viewBox="0 0 420 190" className="w-full h-48 bg-slate-950/80 rounded border border-slate-800/80">
            <line x1="40" y1="165" x2="405" y2="165" stroke="#334155" strokeWidth="1" />
            <line x1="40" y1="15" x2="40" y2="165" stroke="#334155" strokeWidth="1" />
            <text x="215" y="184" fill="#64748b" fontSize="9" textAnchor="middle">
              MAE — Adverse Excursion (0 → {maxMae.toFixed(0)} pts)
            </text>
            <text x="12" y="95" fill="#64748b" fontSize="9" textAnchor="middle" transform="rotate(-90 12 95)">
              MFE (0 → {maxMfe.toFixed(0)} pts)
            </text>
            {mae_mfe_scatter.map((pt) => {
              const cx = 40 + Math.min(1, pt.mae_pts / maxMae) * 355;
              const cy = 165 - Math.min(1, pt.mfe_pts / maxMfe) * 142;
              return (
                <circle
                  key={pt.id}
                  cx={cx}
                  cy={cy}
                  r="2.8"
                  fill={pt.win ? 'rgba(16, 185, 129, 0.72)' : 'rgba(244, 63, 94, 0.68)'}
                >
                  <title>
                    #{pt.id}: MAE -{pt.mae_pts}pt | MFE +{pt.mfe_pts}pt | Net ${pt.net_pnl} ({pt.r_multiple}R)
                  </title>
                </circle>
              );
            })}
          </svg>
        </div>
      </div>
    </div>
  );
};
