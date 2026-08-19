#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-3013}"
VITE_MODE="${VITE_MODE:-backend}"
VITE_BIN="$ROOT_DIR/node_modules/.bin/vite"

cd "$ROOT_DIR"

exec "$VITE_BIN" --host "$HOST" --port "$PORT" --mode "$VITE_MODE"
