#!/usr/bin/env zsh
set -e

ROOT_DIR="${0:A:h}"

echo "Starting FastAPI backend (http://127.0.0.1:8000) + Vite HMR UI (http://localhost:5173)..."
trap 'kill 0' EXIT

(cd "$ROOT_DIR/backend" && "$ROOT_DIR/backend/.venv/bin/uvicorn" app.main:app --reload --host 127.0.0.1 --port 8000) &
(cd "$ROOT_DIR/frontend" && npm run dev) &

wait
