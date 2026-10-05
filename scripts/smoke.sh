#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

RUN_ID="$(date +%s)$$"
export SMOKE_ID="$RUN_ID"
PG_BASE="${SMOKE_PG_URL:-postgres://127.0.0.1:5432}"
export DATABASE_URL="${PG_BASE}/bop_test_smoke_${RUN_ID}"
export REDIS_URL="${SMOKE_REDIS_URL:-redis://127.0.0.1:6379/5}"
export REDIS_PREFIX="bop_smoke_${RUN_ID}"
export API_PORT=4550 WEB_PORT=4551 MCP_PORT=4552 REALTIME_PORT=4554 WORKER_METRICS_PORT=4555 SCHEDULER_METRICS_PORT=4556
export API_URL="http://127.0.0.1:${API_PORT}" WEB_URL="http://127.0.0.1:${WEB_PORT}" MCP_URL="http://127.0.0.1:${MCP_PORT}/mcp" REALTIME_URL="http://127.0.0.1:${REALTIME_PORT}"
export PUBLIC_API_URL="$API_URL" PUBLIC_WEB_URL="$WEB_URL"
export REALTIME_SERVER_KEY="smoke-server-key-${RUN_ID}" REALTIME_JWT_SECRET="smoke-jwt-${RUN_ID}"
export S3_PREFIX="smoke/${RUN_ID}/"
export SCAN_INTERVAL_MS=2000 SWEEP_INTERVAL_MS=500 OUTBOX_POLL_MS=100 EMAIL_POLL_MS=300 LOG_LEVEL=warn
export MAILPIT_URL="${MAILPIT_URL:-http://127.0.0.1:8025}"
LOG_DIR="${ROOT}/.smoke/${RUN_ID}"
mkdir -p "$LOG_DIR"
PIDS=()

cleanup() {
  local code=$?
  for pid in "${PIDS[@]:-}"; do
    [ -n "$pid" ] && kill "$pid" >/dev/null 2>&1 || true
  done
  sleep 2
  for pid in "${PIDS[@]:-}"; do
    [ -n "$pid" ] && kill -9 "$pid" >/dev/null 2>&1 || true
  done
  psql "${PG_BASE}/postgres" -qc "DROP DATABASE IF EXISTS \"bop_test_smoke_${RUN_ID}\" WITH (FORCE)" >/dev/null 2>&1 || true
  redis-cli -u "$REDIS_URL" --scan --pattern "${REDIS_PREFIX}*" 2>/dev/null | xargs -n 500 redis-cli -u "$REDIS_URL" del >/dev/null 2>&1 || true
  rm -rf "${ROOT}/apps/web/dist-smoke"
  if [ "$code" -eq 0 ]; then
    echo "smoke: PASSED (logs in ${LOG_DIR})"
  else
    echo "smoke: FAILED with exit code ${code}, logs in ${LOG_DIR}"
    tail -n 25 "$LOG_DIR"/*.log || true
  fi
  exit "$code"
}
trap cleanup EXIT INT TERM

wait_for() {
  local url="$1" name="$2"
  for _ in $(seq 1 120); do
    if curl -sf "$url" >/dev/null 2>&1; then
      echo "smoke: ${name} is up"
      return 0
    fi
    sleep 0.5
  done
  echo "smoke: ${name} did not start" >&2
  return 1
}

for port in $API_PORT $WEB_PORT $MCP_PORT $REALTIME_PORT $WORKER_METRICS_PORT $SCHEDULER_METRICS_PORT; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "smoke: port ${port} is already in use" >&2
    exit 1
  fi
done

echo "smoke: building (turbo cache makes this fast when nothing changed)"
pnpm turbo run build --filter=@bop/api --filter=@bop/worker --filter=@bop/scheduler --filter=@bop/realtime --filter=@bop/ops-mcp --output-logs=errors-only >"$LOG_DIR/build.log" 2>&1

echo "smoke: migrating and seeding ${DATABASE_URL##*/}"
node packages/core/dist/cli/seed.js >"$LOG_DIR/seed.log" 2>&1

PORT="$REALTIME_PORT" HOST=127.0.0.1 REDIS_PREFIX="${REDIS_PREFIX}:rt:" JWT_SECRET="$REALTIME_JWT_SECRET" SERVER_API_KEY="$REALTIME_SERVER_KEY" \
  ALLOWED_ORIGINS="$WEB_URL" node apps/realtime/dist/main.js >"$LOG_DIR/realtime.log" 2>&1 &
PIDS+=($!)
node apps/api/dist/main.js >"$LOG_DIR/api.log" 2>&1 &
PIDS+=($!)
WORKER_ID=smoke-worker node apps/worker/dist/main.js >"$LOG_DIR/worker.log" 2>&1 &
PIDS+=($!)
node apps/scheduler/dist/main.js >"$LOG_DIR/scheduler.log" 2>&1 &
PIDS+=($!)
BOP_API_URL="$API_URL" MCP_PORT="$MCP_PORT" node apps/ops-mcp/dist/main.js --http >"$LOG_DIR/mcp.log" 2>&1 &
PIDS+=($!)
(cd apps/web && VITE_API_URL="$API_URL" pnpm exec vite build --outDir dist-smoke --emptyOutDir >"$LOG_DIR/web-build.log" 2>&1)
(cd apps/web && exec pnpm exec vite preview --outDir dist-smoke --port "$WEB_PORT" --host 127.0.0.1 --strictPort >"$LOG_DIR/web.log" 2>&1) &
PIDS+=($!)

wait_for "${API_URL}/health" api
wait_for "${REALTIME_URL}/health/live" realtime
wait_for "http://127.0.0.1:${MCP_PORT}/health" ops-mcp
wait_for "http://127.0.0.1:${WORKER_METRICS_PORT}/health" worker
wait_for "http://127.0.0.1:${SCHEDULER_METRICS_PORT}/health" scheduler
wait_for "${WEB_URL}/" web

node scripts/smoke.mjs
