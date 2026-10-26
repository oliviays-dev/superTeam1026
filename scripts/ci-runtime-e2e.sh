#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COMPOSE_PROJECT="${COMPOSE_PROJECT:-pluginmax-ci}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.batch8.yml}"
DATABASE_URL_INPUT="${DATABASE_URL:-postgres://pluginmax:pluginmax@127.0.0.1:54389/pluginmax}"
API_PORT="${API_PORT:-4450}"
WEB_PORT="${WEB_PORT:-4411}"
API_BASE="http://127.0.0.1:$API_PORT/api/v1"
LOG_DIR="${LOG_DIR:-$ROOT/.tmp/ci-batch8}"
PIDS=()
LAST_PID=""

mkdir -p "$LOG_DIR"

stop_pid() {
  local pid="$1"
  if kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null || true
  fi
}

cleanup() {
  local pid
  for pid in "${PIDS[@]:-}"; do
    stop_pid "$pid"
  done
  for pid in "${PIDS[@]:-}"; do
    wait "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT

start_process() {
  local name="$1"
  shift
  "$@" >"$LOG_DIR/$name.log" 2>&1 &
  LAST_PID=$!
  PIDS+=("$LAST_PID")
}

wait_http() {
  local url="$1"
  for _ in {1..120}; do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  printf 'timed out waiting for %s\n' "$url" >&2
  return 1
}

./scripts/db-compose.sh -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" \
  up -d postgres >/dev/null
for _ in {1..60}; do
  if ./scripts/db-compose.sh -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" \
    exec -T postgres pg_isready -U pluginmax -d pluginmax >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

export DATABASE_URL="$DATABASE_URL_INPUT"
export API_HOST=127.0.0.1
export API_PORT
export WEB_PORT
export WORKFLOW_SWEEP_INTERVAL_MS=250
export MAINTENANCE_POLL_INTERVAL_MS=250
export RUNTIME_EFFECT_POLL_INTERVAL_MS=100
export WORKER_HEARTBEAT_INTERVAL_MS=500
export WORKER_HEARTBEAT_STALE_AFTER_SECONDS=5
export DSH_HOME="$ROOT/.tmp/dsh-home-ci-batch8"
export FILE_STORE_ROOT="$ROOT/.tmp/files-ci-batch8"
export AGENT_WORKSPACE_ROOT="$ROOT/.tmp/workspaces-ci-batch8"

pnpm db:migrate
./scripts/db-compose.sh -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" \
  exec -T postgres psql -U pluginmax -d pluginmax -v ON_ERROR_STOP=1 \
  -c "UPDATE runtime_maintenance_schedules SET next_run_at = NOW(), lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL;" \
  >/dev/null
pnpm build

start_process api node apps/api/lib/index.js
api_pid="$LAST_PID"
start_process web pnpm --filter @pluginmax/web exec vite \
  --host 127.0.0.1 --port "$WEB_PORT"
web_pid="$LAST_PID"
wait_http "$API_BASE/health"
wait_http "http://127.0.0.1:$WEB_PORT/"

start_process smoke-worker node apps/worker/lib/index.js
smoke_worker_pid="$LAST_PID"
for _ in {1..120}; do
  if curl -fsS "$API_BASE/ready" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done
COMPOSE_PROJECT="$COMPOSE_PROJECT" \
COMPOSE_FILE="$COMPOSE_FILE" \
DATABASE_URL="$DATABASE_URL_INPUT" \
API_BASE="$API_BASE" \
  ./scripts/e2e-smoke.sh
stop_pid "$smoke_worker_pid"
wait "$smoke_worker_pid" 2>/dev/null || true

COMPOSE_PROJECT="$COMPOSE_PROJECT" \
COMPOSE_FILE="$COMPOSE_FILE" \
DATABASE_URL="$DATABASE_URL_INPUT" \
API_BASE="$API_BASE" \
LOG_DIR="$LOG_DIR/runtime-smoke" \
  ./scripts/runtime-reliability-smoke.sh

start_process browser-worker node apps/worker/lib/index.js
for _ in {1..120}; do
  if curl -fsS "$API_BASE/ready" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

PLUGINMAX_WEB_BASE_URL="http://127.0.0.1:$WEB_PORT" \
  pnpm playwright test

printf 'ci_runtime_e2e=ok\n'
printf 'api=%s\n' "$API_BASE"
printf 'web=http://127.0.0.1:%s\n' "$WEB_PORT"
printf 'log_dir=%s\n' "$LOG_DIR"
