import type {
  BacktestResult,
  BootstrapResponse,
  CandleWindowResponse,
  DatasetMeta,
  DownloadJobStatus,
  ExecutionConfig,
  OptimizeResult,
  ReplayFrameResponse,
  StrategyInfo,
  UniversalSuiteSettings,
} from './types';

async function jsonReq<T>(url: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(url, init);
  if (!resp.ok) {
    let errText = resp.statusText;
    try {
      const body = await resp.json();
      errText = body.detail || JSON.stringify(body);
    } catch {
      errText = await resp.text();
    }
    throw new Error(errText || `HTTP ${resp.status}`);
  }
  return resp.json() as Promise<T>;
}

export const api = {
  bootstrap: () => jsonReq<BootstrapResponse>('/api/bootstrap'),

  listDatasets: () => jsonReq<DatasetMeta[]>('/api/datasets'),

  deleteDataset: (id: string) =>
    jsonReq<{ deleted: string; datasets: DatasetMeta[] }>(`/api/datasets/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),

  generateSynthetic: (years: number, include_1m: boolean) =>
    jsonReq<{ dataset: DatasetMeta; datasets: DatasetMeta[] }>('/api/datasets/synthetic', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ years, end_date: '2026-10-30', seed: 42, include_1m }),
    }),

  startDukascopyDownload: (start_date: string, end_date: string, include_ask_spread: boolean) =>
    jsonReq<DownloadJobStatus>('/api/datasets/dukascopy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ start_date, end_date, include_ask_spread }),
    }),

  startAlpacaDownload: (payload: {
    symbol: string;
    start_date: string;
    end_date: string;
    api_key: string;
    api_secret: string;
    feed: 'iex' | 'sip';
    fetch_1m: boolean;
  }) =>
    jsonReq<DownloadJobStatus>('/api/datasets/alpaca', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),

  uploadDatasetFile: async (file: File, symbol: string, sourceTz: string) => {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('symbol', symbol);
    fd.append('source_tz', sourceTz);
    return jsonReq<{ dataset: DatasetMeta; datasets: DatasetMeta[] }>('/api/datasets/upload', {
      method: 'POST',
      body: fd,
    });
  },

  getJob: (jobId: string) => jsonReq<DownloadJobStatus>(`/api/jobs/${encodeURIComponent(jobId)}`),

  cancelJob: (jobId: string) =>
    jsonReq<DownloadJobStatus>(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' }),

  fetchCandles: (params: {
    dataset_id: string;
    center_ts?: number;
    end_ts?: number;
    limit?: number;
    strategy_id?: string;
    strategy_params?: Record<string, unknown>;
  }) => {
    const q = new URLSearchParams({ dataset_id: params.dataset_id, limit: String(params.limit ?? 1500) });
    if (params.center_ts !== undefined) q.set('center_ts', String(params.center_ts));
    if (params.end_ts !== undefined) q.set('end_ts', String(params.end_ts));
    if (params.strategy_id) q.set('strategy_id', params.strategy_id);
    if (params.strategy_params) q.set('strategy_params_json', JSON.stringify(params.strategy_params));
    return jsonReq<CandleWindowResponse>(`/api/candles?${q.toString()}`);
  },

  runBacktest: (payload: {
    dataset_id: string;
    strategy_id: string;
    strategy_params: Record<string, unknown>;
    execution: ExecutionConfig;
    start_date?: string;
    end_date?: string;
  }) =>
    jsonReq<BacktestResult>('/api/backtest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),

  runOptimization: (payload: {
    dataset_id: string;
    strategy_id: string;
    strategy_params: Record<string, unknown>;
    execution: ExecutionConfig;
    start_date?: string;
    end_date?: string;
    split_date?: string | null;
    axis_x: { target: 'strategy' | 'execution'; name: string; values: number[] };
    axis_y: { target: 'strategy' | 'execution'; name: string; values: number[] };
    ranking_metric: string;
  }) =>
    jsonReq<OptimizeResult>('/api/optimize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),

  saveCustomStrategy: (strategy_id: string, code: string) =>
    jsonReq<{ strategy: StrategyInfo; strategies: StrategyInfo[] }>('/api/strategies/custom', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ strategy_id, code }),
    }),

  deleteCustomStrategy: (strategy_id: string) =>
    jsonReq<{ deleted: string; strategies: StrategyInfo[] }>(
      `/api/strategies/custom/${encodeURIComponent(strategy_id)}`,
      { method: 'DELETE' }
    ),

  fetchReplayFrame: (payload: {
    dataset_id: string;
    mode: 'init' | 'at_ts' | 'step' | 'jump_date' | 'random_ny_open' | 'next_ny_open';
    sim_ts?: number;
    step_bars?: number;
    jump_date_et?: string;
    jump_time_et?: string;
    timeframes: string[];
    limit?: number;
    suite_settings: UniversalSuiteSettings;
  }) =>
    jsonReq<ReplayFrameResponse>('/api/replay/frame', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
};
