import React, { useEffect, useState } from 'react';
import { CloudDownload, Database, FileUp, Loader2, Sparkles, Trash2, X } from 'lucide-react';
import { api } from '../api';
import type { DatasetMeta, DownloadJobStatus } from '../types';

interface Props {
  open: boolean;
  onClose: () => void;
  datasets: DatasetMeta[];
  onDatasetsChanged: (datasets: DatasetMeta[], selectId?: string) => void;
}

export const DataHubModal: React.FC<Props> = ({ open, onClose, datasets, onDatasetsChanged }) => {
  const [tab, setTab] = useState<'dukascopy' | 'upload' | 'alpaca' | 'manage'>('dukascopy');

  // Dukascopy state
  const [dukaStart, setDukaStart] = useState('2019-01-01');
  const [dukaEnd, setDukaEnd] = useState('2026-10-30');
  const [dukaAsk, setDukaAsk] = useState(true);

  // Alpaca state
  const [alpSymbol, setAlpSymbol] = useState('QQQ');
  const [alpStart, setAlpStart] = useState('2018-01-01');
  const [alpEnd, setAlpEnd] = useState('2026-10-30');
  const [alpKey, setAlpKey] = useState('');
  const [alpSecret, setAlpSecret] = useState('');
  const [alpFeed, setAlpFeed] = useState<'iex' | 'sip'>('iex');

  // Upload state
  const [uploadSym, setUploadSym] = useState('NAS100');
  const [uploadTz, setUploadTz] = useState('UTC');
  const [uploading, setUploading] = useState(false);

  // Synthetic benchmark state
  const [synYears, setSynYears] = useState(10);
  const [generatingSyn, setGeneratingSyn] = useState(false);

  // Active download job polling
  const [activeJob, setActiveJob] = useState<DownloadJobStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!activeJob || activeJob.status !== 'running') return;
    const timer = setInterval(async () => {
      try {
        const j = await api.getJob(activeJob.job_id);
        setActiveJob(j);
        if (j.status === 'completed') {
          const list = await api.listDatasets();
          onDatasetsChanged(list, j.dataset_id || undefined);
        }
      } catch {
        // ignore transient poll err
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [activeJob, onDatasetsChanged]);

  if (!open) return null;

  const startDukascopy = async () => {
    setError(null);
    try {
      const job = await api.startDukascopyDownload(dukaStart, dukaEnd, dukaAsk);
      setActiveJob(job);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const startAlpaca = async () => {
    setError(null);
    try {
      const job = await api.startAlpacaDownload({
        symbol: alpSymbol,
        start_date: alpStart,
        end_date: alpEnd,
        api_key: alpKey,
        api_secret: alpSecret,
        feed: alpFeed,
        fetch_1m: true,
      });
      setActiveJob(job);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const res = await api.uploadDatasetFile(file, uploadSym, uploadTz);
      onDatasetsChanged(res.datasets, res.dataset.id);
      setTab('manage');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  };

  const handleGenerateSyn = async () => {
    setGeneratingSyn(true);
    setError(null);
    try {
      const res = await api.generateSynthetic(synYears, true);
      onDatasetsChanged(res.datasets, res.dataset.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setGeneratingSyn(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (datasets.length <= 1) {
      setError('Keep at least one dataset loaded.');
      return;
    }
    try {
      const res = await api.deleteDataset(id);
      onDatasetsChanged(res.datasets);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-700/80 rounded-2xl max-w-3xl w-full shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-800 bg-slate-950/70">
          <div className="flex items-center gap-2">
            <Database className="w-4 h-4 text-cyan-400" />
            <h2 className="text-sm font-bold text-white">Historical 5m + 1m Data Hub (5–10+ Years Local Parquet Store)</h2>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-slate-800 bg-slate-950/40 text-xs">
          {[
            { id: 'dukascopy', label: '1. Dukascopy NAS100 (Free, No Key)' },
            { id: 'upload', label: '2. Import CSV / Parquet' },
            { id: 'alpaca', label: '3. Alpaca QQQ API' },
            { id: 'manage', label: `4. Stored Datasets (${datasets.length})` },
          ].map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id as typeof tab)}
              className={`px-4 py-2.5 font-medium border-b-2 transition ${
                tab === t.id
                  ? 'border-cyan-400 text-cyan-300 bg-cyan-500/5'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="p-5 space-y-4 text-xs">
          {activeJob && (
            <div className="bg-slate-950 border border-cyan-500/30 rounded-xl p-3.5 space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-cyan-300 flex items-center gap-2">
                  {activeJob.status === 'running' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  {activeJob.provider} — {activeJob.status.toUpperCase()}
                </span>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-slate-300">{activeJob.progress_pct}%</span>
                  {activeJob.status === 'running' && (
                    <button
                      onClick={() => api.cancelJob(activeJob.job_id)}
                      className="px-2 py-0.5 rounded bg-rose-500/20 text-rose-300 hover:bg-rose-500/30"
                    >
                      Cancel
                    </button>
                  )}
                </div>
              </div>
              <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
                <div
                  className={`h-full transition-all ${
                    activeJob.status === 'failed' ? 'bg-rose-500' : 'bg-cyan-500'
                  }`}
                  style={{ width: `${activeJob.progress_pct}%` }}
                />
              </div>
              <div className="font-mono text-[11px] text-slate-400">{activeJob.message}</div>
            </div>
          )}

          {error && <div className="p-2.5 rounded bg-rose-950/50 border border-rose-800 text-rose-300">{error}</div>}

          {tab === 'dukascopy' && (
            <div className="space-y-3">
              <p className="text-slate-300 leading-relaxed">
                Downloads genuine historical 1-minute Bid & Ask candles for{' '}
                <code className="text-cyan-300">USATECHIDXUSD</code> (Nasdaq-100 Index CFD) directly from Dukascopy’s
                free historical archive, computes exact historical Bid-Ask spread, resamples cleanly to 5m, and retains
                1m sub-bars for exact intrabar SL/TP scalping fills. Cached locally so resuming is instant!
              </p>

              <div className="flex gap-2">
                <button
                  onClick={() => {
                    setDukaStart('2021-10-30');
                    setDukaEnd('2026-10-30');
                  }}
                  className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200"
                >
                  Preset: Last 5 Years
                </button>
                <button
                  onClick={() => {
                    setDukaStart('2018-10-30');
                    setDukaEnd('2026-10-30');
                  }}
                  className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200"
                >
                  Preset: Last 8 Years
                </button>
                <button
                  onClick={() => {
                    setDukaStart('2016-10-30');
                    setDukaEnd('2026-10-30');
                  }}
                  className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200"
                >
                  Preset: Full 10 Years
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-1">
                <div>
                  <label className="text-slate-400 block mb-1">Start Date</label>
                  <input
                    type="date"
                    value={dukaStart}
                    onChange={(e) => setDukaStart(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 font-mono text-white"
                  />
                </div>
                <div>
                  <label className="text-slate-400 block mb-1">End Date</label>
                  <input
                    type="date"
                    value={dukaEnd}
                    onChange={(e) => setDukaEnd(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 font-mono text-white"
                  />
                </div>
                <div className="flex items-end pb-1.5">
                  <label className="flex items-center gap-2 text-slate-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={dukaAsk}
                      onChange={(e) => setDukaAsk(e.target.checked)}
                      className="accent-cyan-500"
                    />
                    Include Ask candles (real Bid-Ask spread)
                  </label>
                </div>
              </div>

              <button
                onClick={startDukascopy}
                disabled={activeJob?.status === 'running'}
                className="px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white font-semibold flex items-center gap-2"
              >
                <CloudDownload className="w-4 h-4" /> Download Real Dukascopy NAS100 Data
              </button>
            </div>
          )}

          {tab === 'upload' && (
            <div className="space-y-3">
              <p className="text-slate-300">
                Import CSV, TSV, or Parquet bars exported from TradingView, NinjaTrader (`NQ`/`MNQ`), Sierra Chart,
                FirstRateData, Databento, or MetaTrader. If you upload 1-minute data, the engine automatically builds
                5-minute candles AND preserves 1-minute sub-bars for intrabar stop/target resolution!
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-slate-400 block mb-1">Symbol Tag</label>
                  <input
                    value={uploadSym}
                    onChange={(e) => setUploadSym(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 font-mono text-white"
                  />
                </div>
                <div>
                  <label className="text-slate-400 block mb-1">Timestamp Timezone (if naive strings)</label>
                  <select
                    value={uploadTz}
                    onChange={(e) => setUploadTz(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 text-white"
                  >
                    <option value="UTC">UTC</option>
                    <option value="America/New_York">America/New_York (ET)</option>
                    <option value="America/Chicago">America/Chicago (CME CT)</option>
                  </select>
                </div>
              </div>

              <label className="border-2 border-dashed border-slate-700 hover:border-cyan-500 rounded-xl p-6 flex flex-col items-center justify-center cursor-pointer bg-slate-950/50 transition">
                <FileUp className="w-6 h-6 text-cyan-400 mb-2" />
                <span className="font-semibold text-white">
                  {uploading ? 'Importing & Indexing Parquet...' : 'Click to select .csv, .tsv, or .parquet file'}
                </span>
                <span className="text-slate-500 mt-1">Auto-detects timestamp, open, high, low, close, volume, spread</span>
                <input type="file" accept=".csv,.tsv,.txt,.parquet" onChange={handleFileUpload} className="hidden" />
              </label>
            </div>
          )}

          {tab === 'alpaca' && (
            <div className="space-y-3">
              <p className="text-slate-300">
                Fetch 5–10 years of US Equity ETF (`QQQ` / `TQQQ`) 1m + 5m bars using free Alpaca Market Data v2 keys.
              </p>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div>
                  <label className="text-slate-400 block mb-1">Symbol</label>
                  <input
                    value={alpSymbol}
                    onChange={(e) => setAlpSymbol(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 font-mono text-white"
                  />
                </div>
                <div>
                  <label className="text-slate-400 block mb-1">Feed</label>
                  <select
                    value={alpFeed}
                    onChange={(e) => setAlpFeed(e.target.value as 'iex' | 'sip')}
                    className="w-full bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 text-white"
                  >
                    <option value="iex">IEX (Free Key)</option>
                    <option value="sip">SIP (Full Tape)</option>
                  </select>
                </div>
                <div>
                  <label className="text-slate-400 block mb-1">Start Date</label>
                  <input
                    type="date"
                    value={alpStart}
                    onChange={(e) => setAlpStart(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 font-mono text-white"
                  />
                </div>
                <div>
                  <label className="text-slate-400 block mb-1">End Date</label>
                  <input
                    type="date"
                    value={alpEnd}
                    onChange={(e) => setAlpEnd(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 font-mono text-white"
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <input
                  placeholder="APCA-API-KEY-ID"
                  value={alpKey}
                  onChange={(e) => setAlpKey(e.target.value)}
                  className="bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 font-mono text-white"
                />
                <input
                  type="password"
                  placeholder="APCA-API-SECRET-KEY"
                  value={alpSecret}
                  onChange={(e) => setAlpSecret(e.target.value)}
                  className="bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 font-mono text-white"
                />
              </div>
              <button
                onClick={startAlpaca}
                disabled={activeJob?.status === 'running'}
                className="px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white font-semibold flex items-center gap-2"
              >
                <CloudDownload className="w-4 h-4" /> Download Alpaca Historical Bars
              </button>
            </div>
          )}

          {tab === 'manage' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between bg-slate-950 border border-slate-800 rounded-lg p-3">
                <div className="flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-amber-400" />
                  <span>Generate Calibrated Offline Benchmark (1m + 5m):</span>
                  <select
                    value={synYears}
                    onChange={(e) => setSynYears(Number(e.target.value))}
                    className="bg-slate-900 border border-slate-700 rounded px-2 py-1 font-mono"
                  >
                    <option value={5}>5 Years</option>
                    <option value={8}>8 Years</option>
                    <option value={10}>10 Years</option>
                  </select>
                </div>
                <button
                  onClick={handleGenerateSyn}
                  disabled={generatingSyn}
                  className="px-3 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-cyan-300 font-semibold"
                >
                  {generatingSyn ? 'Generating...' : 'Build Dataset'}
                </button>
              </div>

              <div className="space-y-2 max-h-64 overflow-y-auto">
                {datasets.map((ds) => (
                  <div
                    key={ds.id}
                    className="flex items-center justify-between bg-slate-950/80 border border-slate-800 rounded-lg p-3"
                  >
                    <div>
                      <div className="font-semibold text-white flex items-center gap-2">
                        {ds.name}
                        {ds.has_1m_subbars && (
                          <span className="px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 text-[10px] font-mono">
                            1m Sub-Bars
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] font-mono text-slate-400 mt-0.5">
                        {ds.bars_5m.toLocaleString()} 5m bars ({ds.years_span}y) · {ds.start_utc} → {ds.end_utc} ·{' '}
                        {ds.file_size_mb} MB
                      </div>
                    </div>
                    <button
                      onClick={() => handleDelete(ds.id)}
                      className="p-1.5 rounded hover:bg-rose-500/20 text-slate-400 hover:text-rose-400"
                      title="Delete dataset"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
