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

  useEffect(() => {
    if (!eqChartRef.current || !ddChartRef.current || equity_curve.length === 0) return;

    const eqChart = createChart(eqChartRef.current, {
      height: 250,
      layout: { background: { type: ColorType.Solid, color: '#131722' }, textColor: '#787b86', fontSize: 11 },
      grid: { vertLines: { color: '#1e222d' }, horzLines: { color: '#1e222d' } },
      rightPriceScale: { borderColor: '#222631' },
      timeScale: { borderColor: '#222631', timeVisible: true },
    });

    const grossSeries = eqChart.addLineSeries({
      color: '#787b86',
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      title: 'Gross',
    });
    const netSeries = eqChart.addAreaSeries({
      lineColor: kpis.net_pnl >= 0 ? '#089981' : '#f23645',
      topColor: kpis.net_pnl >= 0 ? 'rgba(8, 153, 129, 0.24)' : 'rgba(242, 54, 69, 0.24)',
      bottomColor: 'rgba(19, 23, 34, 0.0)',
      lineWidth: 2,
      title: 'Net',
    });

    grossSeries.setData(equity_curve.map((p) => ({ time: p.time as Time, value: p.gross_equity })));
    netSeries.setData(equity_curve.map((p) => ({ time: p.time as Time, value: p.net_equity })));
    eqChart.timeScale().fitContent();

    const ddChart = createChart(ddChartRef.current, {
      height: 110,
      layout: { background: { type: ColorType.Solid, color: '#131722' }, textColor: '#787b86', fontSize: 11 },
      grid: { vertLines: { color: '#1e222d' }, horzLines: { color: '#1e222d' } },
      rightPriceScale: { borderColor: '#222631' },
      timeScale: { borderColor: '#222631', timeVisible: true },
    });
    const ddSeries = ddChart.addAreaSeries({
      lineColor: '#f23645',
      topColor: 'rgba(242, 54, 69, 0.04)',
      bottomColor: 'rgba(242, 54, 69, 0.3)',
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
      {/* Miller's Law: 4 Clear Hero KPI Cards with Secondary Context Subtext */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        <div className="bg-[#131722] border border-[#222631] rounded-lg p-4">
          <div className="flex items-center justify-between text-xs text-[#787b86]">
            <span>Net Profit</span>
            <span className={kpis.net_return_pct >= 0 ? 'text-[#089981] font-mono' : 'text-[#f23645] font-mono'}>
              {kpis.net_return_pct >= 0 ? '+' : ''}
              {kpis.net_return_pct}%
            </span>
          </div>
          <div
            className={`text-2xl font-bold font-mono tabular-nums mt-1 ${
              kpis.net_pnl >= 0 ? 'text-[#089981]' : 'text-[#f23645]'
            }`}
          >
            {fmtUsd(kpis.net_pnl)}
          </div>
          <div className="text-[11px] font-mono text-[#787b86] mt-1.5">
            Gross {fmtUsd(kpis.gross_pnl)} · Costs -{fmtUsd(kpis.total_friction_cost)}
          </div>
        </div>

        <div className="bg-[#131722] border border-[#222631] rounded-lg p-4">
          <div className="flex items-center justify-between text-xs text-[#787b86]">
            <span>Win Rate</span>
            <span className="font-mono">{kpis.total_trades.toLocaleString()} trades</span>
          </div>
          <div className="text-2xl font-bold font-mono tabular-nums mt-1 text-white">
            {kpis.win_rate_pct.toFixed(1)}%
          </div>
          <div className="text-[11px] font-mono text-[#787b86] mt-1.5">
            Long {kpis.long_win_rate_pct}% · Short {kpis.short_win_rate_pct}% · Avg {kpis.avg_hold_minutes}m
          </div>
        </div>

        <div className="bg-[#131722] border border-[#222631] rounded-lg p-4">
          <div className="flex items-center justify-between text-xs text-[#787b86]">
            <span>Profit Factor</span>
            <span className="font-mono">Payoff {kpis.payoff_ratio.toFixed(2)}x</span>
          </div>
          <div
            className={`text-2xl font-bold font-mono tabular-nums mt-1 ${
              kpis.profit_factor >= 1.1 ? 'text-[#089981]' : kpis.profit_factor >= 1.0 ? 'text-white' : 'text-[#f23645]'
            }`}
          >
            {kpis.profit_factor.toFixed(2)}
          </div>
          <div className="text-[11px] font-mono text-[#787b86] mt-1.5">
            Expectancy {kpis.expectancy_r >= 0 ? '+' : ''}
            {kpis.expectancy_r.toFixed(2)}R ({fmtUsd(kpis.expectancy_usd)}/trade)
          </div>
        </div>

        <div className="bg-[#131722] border border-[#222631] rounded-lg p-4">
          <div className="flex items-center justify-between text-xs text-[#787b86]">
            <span>Max Drawdown</span>
            <span className="font-mono">Sharpe {kpis.sharpe_ratio.toFixed(2)}</span>
          </div>
          <div className="text-2xl font-bold font-mono tabular-nums mt-1 text-[#f23645]">
            -{kpis.max_drawdown_pct.toFixed(2)}%
          </div>
          <div className="text-[11px] font-mono text-[#787b86] mt-1.5">
            -{fmtUsd(kpis.max_drawdown_usd)} · Sortino {kpis.sortino_ratio.toFixed(2)}
          </div>
        </div>
      </div>

      {/* Equity Curve & Drawdown */}
      <div className="bg-[#131722] border border-[#222631] rounded-lg p-4">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <div>
            <h3 className="text-sm font-semibold text-white">Equity Curve & Drawdown</h3>
            <p className="text-xs text-[#787b86]">Net equity after spread, slippage, and commissions vs. zero-friction gross</p>
          </div>
          <div className="flex items-center gap-4 text-xs font-mono">
            <span className="flex items-center gap-1.5 text-[#089981]">
              <span className="w-3 h-0.5 bg-[#089981] inline-block" /> Net Equity
            </span>
            <span className="flex items-center gap-1.5 text-[#9598a1]">
              <span className="w-3 h-0.5 border-t border-dashed border-[#9598a1] inline-block" /> Gross
            </span>
            <span className="flex items-center gap-1.5 text-[#f23645]">
              <span className="w-3 h-2 bg-[#f23645]/40 inline-block rounded-xs" /> Drawdown %
            </span>
          </div>
        </div>
        <div ref={eqChartRef} className="w-full" />
        <div ref={ddChartRef} className="w-full mt-1" />
      </div>

      {/* Monthly Returns Heatmap */}
      <div className="bg-[#131722] border border-[#222631] rounded-lg p-4 overflow-x-auto">
        <h3 className="text-sm font-semibold text-white mb-0.5">Monthly Returns (% of Initial Capital)</h3>
        <p className="text-xs text-[#787b86] mb-3">Multi-year consistency across market regimes</p>
        <table className="w-full text-xs font-mono tabular-nums border-collapse">
          <thead>
            <tr className="text-[#787b86] border-b border-[#222631]">
              <th className="text-left py-2 px-2 font-medium">Year</th>
              {MONTH_NAMES.map((m) => (
                <th key={m} className="text-right py-2 px-2 font-medium">
                  {m}
                </th>
              ))}
              <th className="text-right py-2 px-2 font-semibold text-white">Total</th>
            </tr>
          </thead>
          <tbody>
            {monthly_matrix.map((row) => (
              <tr key={row.year} className="border-b border-[#1e222d]">
                <td className="py-1.5 px-2 font-semibold text-white">{row.year}</td>
                {Array.from({ length: 12 }, (_, idx) => {
                  const cell = row.months[String(idx + 1)];
                  if (!cell) {
                    return (
                      <td key={idx} className="text-right py-1.5 px-2 text-[#363a45]">
                        —
                      </td>
                    );
                  }
                  const intensity = Math.min(0.4, Math.max(0.08, Math.abs(cell.pct) / 12));
                  const bg =
                    cell.pct >= 0
                      ? `rgba(8, 153, 129, ${intensity})`
                      : `rgba(242, 54, 69, ${intensity})`;
                  return (
                    <td
                      key={idx}
                      style={{ backgroundColor: bg }}
                      className={`text-right py-1.5 px-2 rounded-xs ${
                        cell.pct >= 0 ? 'text-[#d1f4eb]' : 'text-[#ffd6da]'
                      }`}
                      title={`${fmtUsd(cell.usd)} (${cell.trades} trades)`}
                    >
                      {cell.pct >= 0 ? '+' : ''}
                      {cell.pct.toFixed(1)}%
                    </td>
                  );
                })}
                <td
                  className={`text-right py-1.5 px-2 font-bold ${
                    row.year_total_pct >= 0 ? 'text-[#089981]' : 'text-[#f23645]'
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

      {/* Time-of-Day & Weekday Breakdown + Excursion */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <div className="lg:col-span-2 bg-[#131722] border border-[#222631] rounded-lg p-4">
          <h3 className="text-sm font-semibold text-white mb-0.5">Time-of-Day Performance (NY ET)</h3>
          <p className="text-xs text-[#787b86] mb-3">Net P&L by 30-minute entry window</p>
          {time_of_day.length === 0 ? (
            <div className="text-xs text-[#5d606b] py-8 text-center">No trades executed.</div>
          ) : (
            <div className="space-y-1.5 max-h-60 overflow-y-auto pr-1">
              {time_of_day.map((row) => {
                const widthPct = Math.max(3, (Math.abs(row.net_pnl) / maxAbsTodPnl) * 100);
                const pos = row.net_pnl >= 0;
                return (
                  <div key={row.slot} className="grid grid-cols-12 items-center gap-2 text-xs font-mono tabular-nums">
                    <div className="col-span-2 text-[#9598a1]">{row.slot}</div>
                    <div className="col-span-6 bg-[#0b0e14] rounded h-3.5 overflow-hidden flex items-center px-0.5">
                      <div
                        className={`h-2 rounded-xs ${pos ? 'bg-[#089981]' : 'bg-[#f23645]'}`}
                        style={{ width: `${widthPct}%` }}
                      />
                    </div>
                    <div className={`col-span-2 text-right font-medium ${pos ? 'text-[#089981]' : 'text-[#f23645]'}`}>
                      {fmtUsd(row.net_pnl)}
                    </div>
                    <div className="col-span-2 text-right text-[#787b86]">
                      {row.win_rate_pct}% ({row.trades})
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="bg-[#131722] border border-[#222631] rounded-lg p-4 flex flex-col justify-between">
          <div>
            <h3 className="text-sm font-semibold text-white mb-0.5">Weekday & Exits</h3>
            <p className="text-xs text-[#787b86] mb-3">Breakdown by day and exit trigger</p>
            <div className="space-y-1.5 mb-4">
              {day_of_week.map((d) => (
                <div key={d.day} className="flex items-center justify-between text-xs font-mono tabular-nums py-1 border-b border-[#1e222d]">
                  <span className="text-[#d1d4dc] w-10">{d.day}</span>
                  <span className="text-[#787b86]">{d.trades} tr · {d.win_rate_pct}%</span>
                  <span className={d.net_pnl >= 0 ? 'text-[#089981] font-medium' : 'text-[#f23645] font-medium'}>
                    {fmtUsd(d.net_pnl)}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-1">
            {exit_reasons.map((ex) => (
              <div key={ex.reason} className="flex items-center justify-between text-[11px] font-mono tabular-nums bg-[#0b0e14] px-2.5 py-1.5 rounded">
                <span className="text-[#d1d4dc]">{ex.reason}</span>
                <span className="text-[#787b86]">{ex.pct_of_trades}%</span>
                <span className={ex.net_pnl >= 0 ? 'text-[#089981]' : 'text-[#f23645]'}>{fmtUsd(ex.net_pnl)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* R-Multiple & MAE/MFE */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div className="bg-[#131722] border border-[#222631] rounded-lg p-4">
          <h3 className="text-sm font-semibold text-white mb-0.5">R-Multiple Distribution</h3>
          <p className="text-xs text-[#787b86] mb-3">Realized reward-to-risk across all trades</p>
          <div className="flex items-end gap-1.5 h-44 pt-4">
            {r_distribution.map((b) => {
              const hPct = Math.max(2, (b.count / maxRCount) * 100);
              const isPos = !b.bucket.startsWith('-') && !b.bucket.startsWith('<-');
              return (
                <div key={b.bucket} className="flex-1 flex flex-col items-center h-full justify-end">
                  <span className="text-[10px] font-mono text-[#787b86] mb-1">{b.count || ''}</span>
                  <div
                    className={`w-full rounded-t ${isPos ? 'bg-[#089981]/80' : 'bg-[#f23645]/80'}`}
                    style={{ height: `${hPct}%` }}
                  />
                  <span className="text-[9px] font-mono text-[#787b86] mt-1.5 rotate-[-25deg] origin-top-left whitespace-nowrap">
                    {b.bucket}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="bg-[#131722] border border-[#222631] rounded-lg p-4">
          <h3 className="text-sm font-semibold text-white mb-0.5">MAE vs. MFE Excursion (Points)</h3>
          <p className="text-xs text-[#787b86] mb-2">Adverse drawdown (X) vs. favorable run-up (Y) per trade</p>
          <svg viewBox="0 0 420 190" className="w-full h-48 bg-[#0b0e14] rounded border border-[#222631]">
            <line x1="40" y1="165" x2="405" y2="165" stroke="#2a2e39" strokeWidth="1" />
            <line x1="40" y1="15" x2="40" y2="165" stroke="#2a2e39" strokeWidth="1" />
            <text x="215" y="184" fill="#787b86" fontSize="9" textAnchor="middle">
              MAE — Adverse Excursion (0 → {maxMae.toFixed(0)} pts)
            </text>
            <text x="12" y="95" fill="#787b86" fontSize="9" textAnchor="middle" transform="rotate(-90 12 95)">
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
                  fill={pt.win ? 'rgba(8, 153, 129, 0.72)' : 'rgba(242, 54, 69, 0.68)'}
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
