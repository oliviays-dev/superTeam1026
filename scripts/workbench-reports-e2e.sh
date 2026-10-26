#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COMPOSE_PROJECT="${COMPOSE_PROJECT:-pluginmax-batch11a}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.batch11a.yml}"
DATABASE_URL_INPUT="${DATABASE_URL:-postgres://pluginmax:pluginmax@127.0.0.1:54417/pluginmax}"
API_PORT="${API_PORT:-4472}"
WEB_PORT="${WEB_PORT:-4414}"
STAMP="$(date -u +%Y%m%d%H%M%S)"
DATABASE_NAME="pluginmax_batch11a_e2e_$STAMP"
DATABASE_URL="${DATABASE_URL_INPUT%/*}/$DATABASE_NAME"
API_BASE="http://127.0.0.1:$API_PORT/api/v1"
WEB_BASE="http://127.0.0.1:$WEB_PORT"
LOG_DIR="${LOG_DIR:-$ROOT/.tmp/batch11a-e2e}"
PIDS=()

mkdir -p "$LOG_DIR"

compose() {
  "$ROOT/scripts/db-compose.sh" -p "$COMPOSE_PROJECT" -f "$ROOT/$COMPOSE_FILE" "$@"
}

psql_database() {
  local database="$1"
  local sql="$2"
  compose exec -T postgres psql -U pluginmax -d "$database" \
    -qAt -v ON_ERROR_STOP=1 -c "$sql"
}

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
  psql_database postgres \
    "DROP DATABASE IF EXISTS $DATABASE_NAME WITH (FORCE);" \
    >/dev/null 2>&1 || true
}
trap cleanup EXIT

start_process() {
  local name="$1"
  shift
  "$@" >"$LOG_DIR/$name.log" 2>&1 &
  PIDS+=("$!")
}

wait_http() {
  local url="$1"
  for _ in {1..160}; do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  printf 'timed out waiting for %s\n' "$url" >&2
  return 1
}

compose up -d postgres >/dev/null
for _ in {1..80}; do
  if compose exec -T postgres pg_isready \
    -U pluginmax -d pluginmax >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
psql_database postgres "CREATE DATABASE $DATABASE_NAME;"

export DATABASE_URL
export API_HOST=127.0.0.1
export API_PORT
export WEB_PORT
export DSH_HOME="$ROOT/.tmp/dsh-home-batch11a-e2e"
export FILE_STORE_ROOT="$ROOT/.tmp/files-batch11a-e2e"
export AGENT_WORKSPACE_ROOT="$ROOT/.tmp/workspaces-batch11a-e2e"
export WORKER_POLL_INTERVAL_MS=80
export WORKER_HEARTBEAT_INTERVAL_MS=250
export WORKER_HEARTBEAT_STALE_AFTER_SECONDS=5
export WORKFLOW_SWEEP_INTERVAL_MS=500
export MAINTENANCE_POLL_INTERVAL_MS=500

pnpm db:migrate >/dev/null
pnpm build >/dev/null

start_process api node apps/api/lib/index.js
start_process worker node apps/worker/lib/index.js
start_process web pnpm --filter @pluginmax/web exec vite \
  --host 127.0.0.1 --port "$WEB_PORT"
wait_http "$API_BASE/health"
wait_http "$WEB_BASE/"
for _ in {1..120}; do
  if curl -fsS "$API_BASE/ready" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done
curl -fsS "$API_BASE/ready" >/dev/null

PLUGINMAX_WEB_BASE_URL="$WEB_BASE" \
  pnpm exec playwright test e2e/workbench-reports.spec.ts
