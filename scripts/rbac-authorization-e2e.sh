#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COMPOSE_PROJECT="${COMPOSE_PROJECT:-pluginmax-batch14c-rbac}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.batch14c-rbac.yml}"
DATABASE_URL_INPUT="${DATABASE_URL:-postgres://pluginmax:pluginmax@127.0.0.1:54424/pluginmax}"
API_PORT="${API_PORT:-4476}"
WEB_PORT="${WEB_PORT:-4432}"
STAMP="$(date -u +%Y%m%d%H%M%S)"
DATABASE_NAME="pluginmax_batch14c_rbac_e2e_$STAMP"
DATABASE_URL="${DATABASE_URL_INPUT%/*}/$DATABASE_NAME"
API_BASE="http://127.0.0.1:$API_PORT/api/v1"
WEB_BASE="http://127.0.0.1:$WEB_PORT"
TMP_ROOT="$ROOT/.tmp/batch14c-rbac-e2e"
LOG_DIR="$TMP_ROOT/logs"
RBAC_E2E_FIXTURE_PATH="$TMP_ROOT/fixture.json"
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
export RBAC_E2E_FIXTURE_PATH
export API_HOST=127.0.0.1
export API_PORT
export WEB_PORT
export AUTH_MODE=bearer
export DSH_HOME="$TMP_ROOT/dsh-home"
export FILE_STORE_ROOT="$TMP_ROOT/files"
export AGENT_WORKSPACE_ROOT="$TMP_ROOT/workspaces"

node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null
node_modules/.bin/tsx scripts/rbac-e2e-seed.ts

if [[ "${RBAC_E2E_SKIP_BUILD:-0}" != "1" ]]; then
  for package in contracts domain files config agent-runtime context database application ui; do
    (
      cd "packages/$package"
      ../../node_modules/.bin/tsdown >/dev/null
    )
  done
  (
    cd apps/api
    ../../node_modules/.bin/tsdown >/dev/null
  )
fi

start_process api node apps/api/lib/index.js
start_process web apps/web/node_modules/.bin/vite apps/web \
  --host 127.0.0.1 --port "$WEB_PORT" --config apps/web/vite.config.ts
wait_http "$API_BASE/health"
wait_http "$WEB_BASE/"

PLUGINMAX_WEB_BASE_URL="$WEB_BASE" \
  node_modules/.bin/playwright test e2e/rbac-authorization.spec.ts
