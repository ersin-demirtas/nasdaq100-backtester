import React, { useEffect, useState } from 'react';
import { Play, Sparkles } from 'lucide-react';
import { api } from '../api';
import type { ExecutionConfig, OptimizeCell, OptimizeResult, StrategyInfo } from '../types';

interface Props {
  datasetId: string;
  strategy: StrategyInfo;
  strategyParams: Record<string, unknown>;
  execution: ExecutionConfig;
  startDate: string;
  endDate: string;
  onApplyCombination: (xAxis: { target: string; name: string }, xVal: number, yAxis: { target: string; name: string }, yVal: number) => void;
}

const EXEC_SWEEPABLE = [
  { key: 'execution:tp_rr', label: 'Exec: Take Profit RR Multiple', defaultRange: '1.2, 1.5, 2.0, 2.5, 3.0' },
  { key: 'execution:sl_atr_mult', label: 'Exec: Stop Loss ATR Mult', defaultRange: '1.0, 1.25, 1.5, 2.0, 2.5' },
  { key: 'execution:sl_pts', label: 'Exec: Fixed Stop Loss (Pts)', defaultRange: '15, 20, 25, 35, 45' },
  { key: 'execution:max_bars_in_trade', label: 'Exec: Max Hold Bars (5m)', defaultRange: '6, 12, 18, 24, 36' },
  { key: 'execution:breakeven_trigger_rr', label: 'Exec: Break-Even Trigger RR', defaultRange: '0.75, 1.0, 1.25, 1.5' },
];

function parseNumericList(str: string): number[] {
  return str
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((v) => !Number.isNaN(v));
}

export const OptimizerPanel: React.FC<Props> = ({
  datasetId,
  strategy,
  strategyParams,
  execution,
  startDate,
  endDate,
  onApplyCombination,
}) => {
  const numericStratParams = strategy.params.filter((p) => p.type === 'int' || p.type === 'float');

  const buildDefaultRange = (min = 5, max = 30, step = 5, defVal = 15) => {
    const vals: number[] = [];
    const s = step || 1;
    for (let k = -2; k <= 2; k++) {
      const cand = Number((Number(defVal) + k * s * 2).toFixed(2));
      if (cand >= min && cand <= max) vals.push(cand);
    }
    return Array.from(new Set(vals)).join(', ');
  };

  const [xKey, setXKey] = useState<string>('execution:tp_rr');
  const [xValuesStr, setXValuesStr] = useState<string>('1.2, 1.5, 2.0, 2.5, 3.0');
  const [yKey, setYKey] = useState<string>('execution:sl_atr_mult');
  const [yValuesStr, setYValuesStr] = useState<string>('1.0, 1.25, 1.5, 2.0, 2.5');
  const [splitDate, setSplitDate] = useState<string>('2024-01-01');
  const [useWalkForward, setUseWalkForward] = useState<boolean>(true);
  const [metric, setMetric] = useState<'profit_factor' | 'net_pnl' | 'sharpe' | 'expectancy_r'>('profit_factor');
  const [sliceView, setSliceView] = useState<'full' | 'in_sample' | 'out_of_sample'>('full');

  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<OptimizeResult | null>(null);

  useEffect(() => {
    if (numericStratParams.length >= 1) {
      const p0 = numericStratParams[0];
      setXKey(`strategy:${p0.name}`);
      setXValuesStr(buildDefaultRange(p0.min, p0.max, p0.step, Number(p0.default)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strategy.id]);

  const handleAxisChange = (which: 'x' | 'y', key: string) => {
    const [target, name] = key.split(':');
    let range = '1.0, 1.5, 2.0, 2.5';
    if (target === 'strategy') {
      const p = numericStratParams.find((sp) => sp.name === name);
      if (p) range = buildDefaultRange(p.min, p.max, p.step, Number(p.default));
    } else {
      const ex = EXEC_SWEEPABLE.find((e) => e.key === key);
      if (ex) range = ex.defaultRange;
    }
    if (which === 'x') {
      setXKey(key);
      setXValuesStr(range);
    } else {
      setYKey(key);
      setYValuesStr(range);
    }
  };

  const runSweep = async () => {
    const xVals = parseNumericList(xValuesStr);
    const yVals = parseNumericList(yValuesStr);
    if (xVals.length === 0 || yVals.length === 0) {
      setError('Enter comma-separated numeric values for both Axis X and Axis Y.');
      return;
    }
    setRunning(true);
    setError(null);
    try {
      const [xTarget, xName] = xKey.split(':') as ['strategy' | 'execution', string];
      const [yTarget, yName] = yKey.split(':') as ['strategy' | 'execution', string];
      const res = await api.runOptimization({
        dataset_id: datasetId,
        strategy_id: strategy.id,
        strategy_params: strategyParams,
        execution,
        start_date: startDate || undefined,
        end_date: endDate || undefined,
        split_date: useWalkForward && splitDate ? splitDate : null,
        axis_x: { target: xTarget, name: xName, values: xVals },
        axis_y: { target: yTarget, name: yName, values: yVals },
        ranking_metric: metric,
      });
      setResult(res);
      if (useWalkForward && res.cells[0]?.out_of_sample) {
        setSliceView('out_of_sample');
      } else {
        setSliceView('full');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  const getCellMetric = (cell: OptimizeCell): number => {
    const sub =
      sliceView === 'in_sample' && cell.in_sample
        ? cell.in_sample
        : sliceView === 'out_of_sample' && cell.out_of_sample
        ? cell.out_of_sample
        : cell.full;
    return sub[metric];
  };

  return (
    <div className="space-y-4 pb-6">
      <div className="bg-slate-900/85 border border-slate-800 rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-sm font-semibold text-white flex items-center gap-1.5">
              <Sparkles className="w-4 h-4 text-cyan-400" /> 2D Parameter Grid Sweep & Walk-Forward Out-of-Sample Validator
            </h3>
            <p className="text-xs text-slate-400">
              Sweep strategy & risk rules across 5–10 years and verify robustness on unseen Out-of-Sample years
            </p>
          </div>
          <button
            onClick={runSweep}
            disabled={running}
            className="px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white text-xs font-semibold flex items-center gap-1.5 shadow-lg shadow-cyan-900/30 transition"
          >
            <Play className="w-3.5 h-3.5 fill-current" />
            {running ? 'Sweeping Grid...' : 'Run 2D Sweep'}
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
          <div>
            <label className="text-slate-400 block mb-1">Axis X Parameter</label>
            <select
              value={xKey}
              onChange={(e) => handleAxisChange('x', e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 text-slate-200 mb-1.5"
            >
              {numericStratParams.map((p) => (
                <option key={p.name} value={`strategy:${p.name}`}>
                  Strategy: {p.label}
                </option>
              ))}
              {EXEC_SWEEPABLE.map((ex) => (
                <option key={ex.key} value={ex.key}>
                  {ex.label}
                </option>
              ))}
            </select>
            <input
              value={xValuesStr}
              onChange={(e) => setXValuesStr(e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded px-2.5 py-1 font-mono text-cyan-300"
              placeholder="e.g. 10, 15, 20, 30"
            />
          </div>

          <div>
            <label className="text-slate-400 block mb-1">Axis Y Parameter</label>
            <select
              value={yKey}
              onChange={(e) => handleAxisChange('y', e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 text-slate-200 mb-1.5"
            >
              {EXEC_SWEEPABLE.map((ex) => (
                <option key={ex.key} value={ex.key}>
                  {ex.label}
                </option>
              ))}
              {numericStratParams.map((p) => (
                <option key={p.name} value={`strategy:${p.name}`}>
                  Strategy: {p.label}
                </option>
              ))}
            </select>
            <input
              value={yValuesStr}
              onChange={(e) => setYValuesStr(e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded px-2.5 py-1 font-mono text-cyan-300"
              placeholder="e.g. 1.0, 1.5, 2.0, 2.5"
            />
          </div>

          <div>
            <label className="text-slate-400 block mb-1">Ranking Metric</label>
            <select
              value={metric}
              onChange={(e) => setMetric(e.target.value as 'profit_factor' | 'net_pnl' | 'sharpe' | 'expectancy_r')}
              className="w-full bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 text-slate-200"
            >
              <option value="profit_factor">Profit Factor</option>
              <option value="net_pnl">Net Profit ($)</option>
              <option value="sharpe">Sharpe Ratio</option>
              <option value="expectancy_r">Expectancy (R / Trade)</option>
            </select>
          </div>

          <div>
            <label className="text-slate-400 flex items-center gap-2 mb-1">
              <input
                type="checkbox"
                checked={useWalkForward}
                onChange={(e) => setUseWalkForward(e.target.checked)}
                className="accent-cyan-500"
              />
              Walk-Forward Split Date (IS / OOS)
            </label>
            <input
              type="date"
              disabled={!useWalkForward}
              value={splitDate}
              onChange={(e) => setSplitDate(e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 text-slate-200 disabled:opacity-40 font-mono"
            />
          </div>
        </div>

        {error && <div className="mt-3 text-xs text-rose-400 bg-rose-950/40 border border-rose-800/50 rounded p-2">{error}</div>}
      </div>

      {result && (
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
          {/* 2D Heatmap */}
          <div className="xl:col-span-2 bg-slate-900/85 border border-slate-800 rounded-xl p-4 overflow-x-auto">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
              <div>
                <h4 className="text-xs font-semibold text-white">
                  2D Parameter Stability Heatmap ({result.total_combinations} runs in {result.elapsed_ms} ms)
                </h4>
                <p className="text-[11px] text-slate-400">Click any cell to apply its parameters immediately</p>
              </div>
              {result.split_date && (
                <div className="flex rounded bg-slate-950 border border-slate-800 p-0.5 text-xs">
                  {(['full', 'in_sample', 'out_of_sample'] as const).map((s) => (
                    <button
                      key={s}
                      onClick={() => setSliceView(s)}
                      className={`px-2.5 py-1 rounded ${
                        sliceView === s ? 'bg-cyan-600 text-white font-semibold' : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      {s === 'full' ? 'Full Span' : s === 'in_sample' ? 'In-Sample (Train)' : 'Out-of-Sample (Test)'}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <table className="w-full text-xs font-mono border-collapse">
              <thead>
                <tr className="text-slate-400 border-b border-slate-800">
                  <th className="py-2 px-2 text-left">
                    {result.axis_y.name} \ {result.axis_x.name}
                  </th>
                  {result.axis_x.values.map((xv) => (
                    <th key={xv} className="py-2 px-2 text-center text-cyan-300">
                      {xv}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.axis_y.values.map((yv) => (
                  <tr key={yv} className="border-b border-slate-800/50">
                    <td className="py-2 px-2 font-bold text-cyan-300">{yv}</td>
                    {result.axis_x.values.map((xv) => {
                      const cell = result.cells.find((c) => c.x === xv && c.y === yv);
                      if (!cell) return <td key={xv} />;
                      const val = getCellMetric(cell);
                      const good =
                        metric === 'profit_factor'
                          ? val >= 1.05
                          : metric === 'net_pnl'
                          ? val > 0
                          : val > 0;
                      const bg = good ? 'rgba(16, 185, 129, 0.22)' : 'rgba(244, 63, 94, 0.18)';
                      return (
                        <td
                          key={xv}
                          onClick={() => onApplyCombination(result.axis_x, xv, result.axis_y, yv)}
                          style={{ backgroundColor: bg }}
                          className="py-2.5 px-2 text-center cursor-pointer hover:ring-1 hover:ring-cyan-400 transition"
                          title="Click to load these parameters"
                        >
                          <div className={good ? 'text-emerald-200 font-bold' : 'text-rose-200 font-semibold'}>
                            {metric === 'net_pnl' ? `$${val.toFixed(0)}` : val.toFixed(2)}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Top Ranked Walk-Forward Combinations */}
          <div className="bg-slate-900/85 border border-slate-800 rounded-xl p-4">
            <h4 className="text-xs font-semibold text-white mb-2">Top Ranked Parameter Sets</h4>
            <div className="space-y-2 max-h-96 overflow-y-auto pr-1">
              {result.top_combinations.map((c, idx) => (
                <div
                  key={`${c.x}_${c.y}`}
                  className="bg-slate-950/80 border border-slate-800 rounded-lg p-2.5 text-xs font-mono flex items-center justify-between"
                >
                  <div>
                    <div className="text-white font-semibold">
                      #{idx + 1} · {result.axis_x.name}={c.x}, {result.axis_y.name}={c.y}
                    </div>
                    <div className="text-[11px] text-slate-400 mt-0.5">
                      Full PF {c.full.profit_factor} (${c.full.net_pnl.toFixed(0)})
                      {c.out_of_sample && (
                        <span className={c.out_of_sample.net_pnl >= 0 ? ' text-emerald-400' : ' text-rose-400'}>
                          {' '}
                          · OOS PF {c.out_of_sample.profit_factor} (${c.out_of_sample.net_pnl.toFixed(0)})
                        </span>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={() => onApplyCombination(result.axis_x, c.x, result.axis_y, c.y)}
                    className="px-2.5 py-1 rounded bg-cyan-500/20 hover:bg-cyan-500/35 text-cyan-300 border border-cyan-500/30"
                  >
                    Apply
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
