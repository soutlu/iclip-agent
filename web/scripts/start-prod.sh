#!/usr/bin/env bash

# 本地验证生产构建用（vite preview 不适合对外服务）；
# 正式部署为纯静态 dist/ + 反向代理，见 docs/vite-migration-plan.md §3 Phase 5。

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-3013}"

cd "$ROOT_DIR"

pnpm run build
exec "$ROOT_DIR/node_modules/.bin/vite" preview --host "$HOST" --port "$PORT"
