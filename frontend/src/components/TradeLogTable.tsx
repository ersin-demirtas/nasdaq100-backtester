import React, { useMemo, useState } from 'react';
import { Crosshair, Download, Search } from 'lucide-react';
import type { TradeRecord } from '../types';

interface Props {
  trades: TradeRecord[];
  onInspectTrade: (trade: TradeRecord) => void;
}

export const TradeLogTable: React.FC<Props> = ({ trades, onInspectTrade }) => {
  const [dirFilter, setDirFilter] = useState<'ALL' | 'LONG' | 'SHORT'>('ALL');
  const [outcomeFilter, setOutcomeFilter] = useState<'ALL' | 'WIN' | 'LOSS'>('ALL');
  const [reasonFilter, setReasonFilter] = useState<string>('ALL');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const pageSize = 75;

  const reasons = useMemo(() => ['ALL', ...Array.from(new Set(trades.map((t) => t.exit_reason)))], [trades]);

  const filtered = useMemo(() => {
    return trades.filter((t) => {
      if (dirFilter !== 'ALL' && t.direction !== dirFilter) return false;
      if (outcomeFilter === 'WIN' && t.net_pnl <= 0) return false;
      if (outcomeFilter === 'LOSS' && t.net_pnl >= 0) return false;
      if (reasonFilter !== 'ALL' && t.exit_reason !== reasonFilter) return false;
      if (query.trim() && !t.entry_et.includes(query.trim()) && !String(t.id).includes(query.trim())) return false;
      return true;
    });
  }, [trades, dirFilter, outcomeFilter, reasonFilter, query]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const curPage = Math.min(page, totalPages - 1);
  const visible = filtered.slice(curPage * pageSize, (curPage + 1) * pageSize);

  const exportCsv = () => {
    const headers = [
      'id',
      'direction',
      'entry_et',
      'exit_et',
      'entry_price',
      'exit_price',
      'initial_sl',
      'initial_tp',
      'contracts',
      'gross_pnl',
      'friction_cost',
      'net_pnl',
      'r_multiple',
      'mae_pts',
      'mfe_pts',
      'hold_minutes',
      'exit_reason',
    ];
    const rows = filtered.map((t) =>
      [
        t.id,
        t.direction,
        t.entry_et,
        t.exit_et,
        t.entry_price,
        t.exit_price,
        t.initial_sl,
        t.initial_tp,
        t.contracts,
        t.gross_pnl,
        t.friction_cost,
        t.net_pnl,
        t.r_multiple,
        t.mae_pts,
        t.mfe_pts,
        t.hold_minutes,
        t.exit_reason,
      ].join(',')
    );
    const blob = new Blob([[headers.join(','), ...rows].join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `nas100_scalp_trades_${filtered.length}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="bg-slate-900/85 border border-slate-800 rounded-xl overflow-hidden flex flex-col">
      {/* Filter Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 p-3 border-b border-slate-800 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-2" />
            <input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(0);
              }}
              placeholder="Search date (2024-05) or #id..."
              className="pl-7 pr-2.5 py-1 bg-slate-950 border border-slate-800 rounded text-slate-200 focus:border-cyan-500 outline-none w-52"
            />
          </div>

          <select
            value={dirFilter}
            onChange={(e) => {
              setDirFilter(e.target.value as 'ALL' | 'LONG' | 'SHORT');
              setPage(0);
            }}
            className="bg-slate-950 border border-slate-800 rounded px-2 py-1 text-slate-200"
          >
            <option value="ALL">All Directions</option>
            <option value="LONG">Long Only</option>
            <option value="SHORT">Short Only</option>
          </select>

          <select
            value={outcomeFilter}
            onChange={(e) => {
              setOutcomeFilter(e.target.value as 'ALL' | 'WIN' | 'LOSS');
              setPage(0);
            }}
            className="bg-slate-950 border border-slate-800 rounded px-2 py-1 text-slate-200"
          >
            <option value="ALL">All Outcomes</option>
            <option value="WIN">Winners (+PnL)</option>
            <option value="LOSS">Losers (-PnL)</option>
          </select>

          <select
            value={reasonFilter}
            onChange={(e) => {
              setReasonFilter(e.target.value);
              setPage(0);
            }}
            className="bg-slate-950 border border-slate-800 rounded px-2 py-1 text-slate-200"
          >
            {reasons.map((r) => (
              <option key={r} value={r}>
                {r === 'ALL' ? 'All Exit Reasons' : r}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-3">
          <span className="text-slate-400 font-mono">{filtered.length.toLocaleString()} scalps</span>
          <button
            onClick={exportCsv}
            className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 flex items-center gap-1 transition"
          >
            <Download className="w-3.5 h-3.5" /> Export CSV
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto max-h-[620px]">
        <table className="w-full text-xs font-mono border-collapse">
          <thead className="bg-slate-950/90 text-slate-400 sticky top-0 z-10">
            <tr className="border-b border-slate-800">
              <th className="text-left py-2 px-2.5">#</th>
              <th className="text-left py-2 px-2.5">Side</th>
              <th className="text-left py-2 px-2.5">Entry (ET)</th>
              <th className="text-right py-2 px-2.5">Entry → Exit</th>
              <th className="text-right py-2 px-2.5">SL / TP</th>
              <th className="text-right py-2 px-2.5">Qty</th>
              <th className="text-right py-2 px-2.5">Hold</th>
              <th className="text-left py-2 px-2.5">Reason</th>
              <th className="text-right py-2 px-2.5">MAE / MFE</th>
              <th className="text-right py-2 px-2.5">Friction</th>
              <th className="text-right py-2 px-2.5">R-Mult</th>
              <th className="text-right py-2 px-2.5">Net PnL</th>
              <th className="text-center py-2 px-2.5">Chart</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((t) => (
              <tr key={t.id} className="border-b border-slate-800/50 hover:bg-slate-800/40 transition">
                <td className="py-1.5 px-2.5 text-slate-400">{t.id}</td>
                <td className="py-1.5 px-2.5">
                  <span
                    className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                      t.direction === 'LONG'
                        ? 'bg-emerald-500/15 text-emerald-400'
                        : 'bg-rose-500/15 text-rose-400'
                    }`}
                  >
                    {t.direction}
                  </span>
                </td>
                <td className="py-1.5 px-2.5 text-slate-200">{t.entry_et}</td>
                <td className="py-1.5 px-2.5 text-right text-slate-300">
                  {t.entry_price.toFixed(2)} → {t.exit_price.toFixed(2)}
                </td>
                <td className="py-1.5 px-2.5 text-right text-slate-500">
                  {t.initial_sl.toFixed(1)} / {t.initial_tp.toFixed(1)}
                </td>
                <td className="py-1.5 px-2.5 text-right text-slate-300">{t.contracts}</td>
                <td className="py-1.5 px-2.5 text-right text-slate-400">{t.hold_minutes}m</td>
                <td className="py-1.5 px-2.5 text-cyan-300">{t.exit_reason}</td>
                <td className="py-1.5 px-2.5 text-right text-slate-400">
                  -{t.mae_pts.toFixed(1)} / +{t.mfe_pts.toFixed(1)}
                </td>
                <td className="py-1.5 px-2.5 text-right text-amber-400/90">-${t.friction_cost.toFixed(2)}</td>
                <td className={`py-1.5 px-2.5 text-right ${t.r_multiple >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {t.r_multiple >= 0 ? '+' : ''}
                  {t.r_multiple.toFixed(2)}R
                </td>
                <td
                  className={`py-1.5 px-2.5 text-right font-bold ${
                    t.net_pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'
                  }`}
                >
                  {t.net_pnl >= 0 ? '+' : ''}${t.net_pnl.toFixed(2)}
                </td>
                <td className="py-1.5 px-2.5 text-center">
                  <button
                    onClick={() => onInspectTrade(t)}
                    className="px-2 py-0.5 rounded bg-cyan-500/15 hover:bg-cyan-500/30 border border-cyan-500/30 text-cyan-300 inline-flex items-center gap-1"
                    title="Jump 5m chart directly to this scalp"
                  >
                    <Crosshair className="w-3 h-3" /> View
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between px-3 py-2 bg-slate-950/80 border-t border-slate-800 text-xs font-mono">
          <span className="text-slate-400">
            Page {curPage + 1} of {totalPages}
          </span>
          <div className="flex gap-1.5">
            <button
              disabled={curPage === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              className="px-2.5 py-1 rounded bg-slate-800 disabled:opacity-40 hover:bg-slate-700"
            >
              Prev
            </button>
            <button
              disabled={curPage >= totalPages - 1}
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              className="px-2.5 py-1 rounded bg-slate-800 disabled:opacity-40 hover:bg-slate-700"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
