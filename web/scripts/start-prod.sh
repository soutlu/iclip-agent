#!/usr/bin/env bash

# 本地预览生产构建；正式部署使用静态 dist/ 与反向代理。

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-3013}"

cd "$ROOT_DIR"

pnpm run build
exec "$ROOT_DIR/node_modules/.bin/vite" preview --host "$HOST" --port "$PORT"
