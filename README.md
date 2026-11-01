# NAS100 ScalpLab — Local Nasdaq-100 Replay Simulator & Backtester

A local, high-speed intraday simulation and backtesting platform purpose-built for **Nasdaq-100 (`NAS100` / `MNQ` / `NQ` / `QQQ`)** across **5–10+ years** of historical bars.

## Key Capabilities

- **Live Historical Replay & Paper-Trading Terminal (`3m · 15m · 1H · 4H`)**:
  - **Multi-Timeframe TradingView Candlesticks**: Switch instantly between **Single (`1m` / `3m` / `5m` / `15m` / `1H` / `4H` / `1D`)**, **Split (`3m + 15m`)**, and **Quad (`3m · 15m · 1H · 4H`)** synchronized layouts with zero future lookahead (`candles <= sim_ts`).
  - **Multi-Strategy Universal Suite (Pine v6 Port)**: Native high-DPI rendering of **LuxAlgo Fair Value Gap** (`240` / `Chart` / `15` / `60` / `D` with real-time mitigation deletion, dynamic bands, and dashed mitigation levels), **SMA 9/21 + Cross markers**, **VWAP + Standard Deviation / Percentage Bands #1–#3**, **0DTE Anchored Expected Move** (`09:30 ET` anchor + intraday running decay), and **Right-Side Live MTF Candles (`15m`, `1H`, `4H`, `1D`)**.
  - **Realistic Sim Order Execution**: Market, Limit, and Stop orders on `MNQ`, `NQ`, `NAS100_CFD`, or `QQQ`, click-on-chart `SL` / `TP` / `Trigger` price picking, `SL -> BE`, `Close 50%`, `Flatten`, 1-minute sub-bar fill resolution, and hotkeys (`Space` Play/Pause, `→` +1m, `Shift+→` +3m, `B` Buy, `S` Sell, `F` Flatten).
- **Numba-Compiled Execution Engine (`< 100ms` across 8–10 years)**:
  - **1-Minute Sub-Bar Intrabar Resolution**: Steps through constituent 1-minute candles inside every 5-minute bar to resolve exact Stop-Loss vs. Take-Profit fill order, Break-Even triggers, Partial TP1 scale-outs, and Trailing Stops.
  - **Scalping Friction Modeling**: Explicit Bid/Ask spread (using real historical bar spread when available), entry & stop-market slippage, and round-turn commissions, with **Net vs. Zero-Friction Gross Equity Curves** plotted side-by-side.
  - **New York (`America/New_York` ET) Killzones & Prop-Firm Rules**: Automatic EST/EDT handling across 10 years, session presets (`NY Open 09:30–11:00`, `ICT Silver Bullet 10:00–11:00`, `NY AM`, `US RTH`), mandatory EOD flatten (`15:55 ET`), max trades/day, and daily max loss / profit target halts.
- **Built-in 5–10 Year Historical Data Hub**:
  1. **Free Dukascopy `USATECHIDXUSD` (`NAS100`) Downloader** — No API key required; fetches 1-minute Bid & Ask candles back 5–10+ years, caches `.bi5` files locally for instant resume, and stores ZSTD-compressed `1m` + `5m` Parquet datasets.
  2. **Universal CSV / TSV / Parquet Importer** — Drag-and-drop exports from TradingView, NinjaTrader, Sierra Chart, FirstRateData, Databento, or MetaTrader (auto-resamples 1m → 5m while keeping 1m sub-bars).
  3. **Alpaca Historical Bars (`QQQ` / `TQQQ`)** — Supports free Alpaca Market Data v2 API keys.
  4. **Calibrated 8–10 Year Offline Benchmark** — Pre-built multi-year 1m + 5m dataset ready immediately offline.
- **5 Built-in Scalping Kernels + Live Python Strategy Studio**:
  - `NY Opening Range Breakout (ORB + VWAP)`
  - `Session VWAP + 9/21 EMA Pullback Scalp`
  - `ICT Fair Value Gap (FVG) Displacement Scalp`
  - `Pre-Market High/Low Liquidity Sweep & Reclaim`
  - `Keltner + RSI Exhaustion Mean-Reversion`
  - Plus custom `.py` plugins in `strategies/custom/` editable in your IDE or in the browser's **Python Strategy Studio**.
- **2D Grid Optimizer & Walk-Forward Out-of-Sample Validator**:
  - Sweep strategy and risk parameters across 2D heatmaps with optional `In-Sample (Train)` vs. `Out-of-Sample (Test)` date splits.

## Quick Start

### Single-Command Launch (Unified Local Server)
```zsh
./start.sh
```
Then open **http://127.0.0.1:8000** in your browser.

### Development Mode (Hot Reload Backend + Frontend)
```zsh
./dev.sh
```
Opens Vite HMR at **http://localhost:5173** proxying `/api` to FastAPI at `http://127.0.0.1:8000`.

### Run Backend Test Suite
```zsh
cd backend
.venv/bin/pytest
```
