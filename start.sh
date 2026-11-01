#!/usr/bin/env zsh
set -e

ROOT_DIR="${0:A:h}"

echo "============================================================"
echo "  NAS100 ScalpLab — Local 5m + 1m Backtesting Platform"
echo "  URL: http://127.0.0.1:8000"
echo "============================================================"

if [ ! -d "$ROOT_DIR/backend/.venv" ]; then
  echo "Installing Python backend dependencies via uv..."
  uv sync --project "$ROOT_DIR/backend"
fi

if [ ! -d "$ROOT_DIR/frontend/node_modules" ]; then
  echo "Installing frontend dependencies..."
  npm --prefix "$ROOT_DIR/frontend" install
fi

if [ ! -d "$ROOT_DIR/frontend/dist" ]; then
  echo "Building frontend bundle..."
  npm --prefix "$ROOT_DIR/frontend" run build
fi

cd "$ROOT_DIR/backend"
exec "$ROOT_DIR/backend/.venv/bin/uvicorn" app.main:app --host 127.0.0.1 --port 8000
