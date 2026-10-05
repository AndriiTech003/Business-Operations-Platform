#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
STATE="$ROOT/.dev"
mkdir -p "$STATE/logs"

export DATABASE_URL="${DATABASE_URL:-postgres://127.0.0.1:5432/bop}"
export REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6379/5}"
export REDIS_PREFIX="${REDIS_PREFIX:-bop}"
export API_PORT="${API_PORT:-4500}"
export REALTIME_PORT="${REALTIME_PORT:-4520}"
export PUBLIC_API_URL="${PUBLIC_API_URL:-http://127.0.0.1:${API_PORT}}"
export PUBLIC_WEB_URL="${PUBLIC_WEB_URL:-http://127.0.0.1:4510}"
export REALTIME_URL="${REALTIME_URL:-http://127.0.0.1:${REALTIME_PORT}}"
export REALTIME_SERVER_KEY="${REALTIME_SERVER_KEY:-dev-realtime-server-key}"
export REALTIME_JWT_SECRET="${REALTIME_JWT_SECRET:-dev-realtime-jwt-secret}"
export SCAN_INTERVAL_MS="${SCAN_INTERVAL_MS:-15000}"
export SWEEP_INTERVAL_MS="${SWEEP_INTERVAL_MS:-2000}"

start_proc() {
  local name="$1"; shift
  if [ -f "$STATE/$name.pid" ] && kill -0 "$(cat "$STATE/$name.pid")" 2>/dev/null; then
    echo "$name already running"
    return
  fi
  nohup env "$@" >"$STATE/logs/$name.log" 2>&1 &
  echo $! >"$STATE/$name.pid"
  echo "started $name (pid $!)"
}

case "${1:-start}" in
  build)
    pnpm turbo run build --filter=@bop/api --filter=@bop/worker --filter=@bop/scheduler --filter=@bop/realtime --filter=@bop/core --output-logs=errors-only
    ;;
  seed)
    node packages/core/dist/cli/seed.js "${@:2}"
    ;;
  start)
    [ -f apps/api/dist/main.js ] || "$0" build
    node packages/core/dist/cli/seed.js
    start_proc realtime PORT="$REALTIME_PORT" HOST=127.0.0.1 REDIS_URL="$REDIS_URL" REDIS_PREFIX="${REDIS_PREFIX}:rt:" JWT_SECRET="$REALTIME_JWT_SECRET" SERVER_API_KEY="$REALTIME_SERVER_KEY" ALLOWED_ORIGINS="http://127.0.0.1:4510,http://localhost:4510,http://127.0.0.1:4511,http://localhost:4511" LOG_LEVEL=warn node apps/realtime/dist/main.js
    start_proc api node --enable-source-maps apps/api/dist/main.js
    start_proc worker WORKER_ID=dev-worker-1 node --enable-source-maps apps/worker/dist/main.js
    start_proc scheduler node --enable-source-maps apps/scheduler/dist/main.js
    for _ in $(seq 1 60); do
      curl -sf "http://127.0.0.1:${API_PORT}/health" >/dev/null 2>&1 && { echo "api is up on :${API_PORT}"; exit 0; }
      sleep 0.5
    done
    echo "api did not start, see $STATE/logs/api.log" >&2
    exit 1
    ;;
  stop)
    for name in scheduler worker api realtime; do
      if [ -f "$STATE/$name.pid" ]; then
        kill "$(cat "$STATE/$name.pid")" 2>/dev/null || true
        rm -f "$STATE/$name.pid"
        echo "stopped $name"
      fi
    done
    ;;
  status)
    for name in realtime api worker scheduler; do
      if [ -f "$STATE/$name.pid" ] && kill -0 "$(cat "$STATE/$name.pid")" 2>/dev/null; then echo "$name: running"; else echo "$name: stopped"; fi
    done
    ;;
  *)
    echo "usage: $0 build|seed [--reset]|start|stop|status" >&2
    exit 2
    ;;
esac
