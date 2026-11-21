#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COMPOSE_PROJECT="${M13C_E2E_COMPOSE_PROJECT:-pluginmax-m13c-e2e}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.core-regression.yml}"
PORT="${M13C_E2E_POSTGRES_PORT:-54475}"
API_PORT="${M13C_E2E_API_PORT:-4478}"
WEB_PORT="${M13C_E2E_WEB_PORT:-4419}"
export CORE_REGRESSION_POSTGRES_PORT="$PORT"
DATABASE_URL_INPUT="${DATABASE_URL:-postgres://pluginmax:pluginmax@127.0.0.1:${PORT}/pluginmax}"
STAMP="$(date -u +%Y%m%d%H%M%S)"
DATABASE_NAME="pluginmax_m13c_e2e_${STAMP}"
DATABASE_URL="${DATABASE_URL_INPUT%/*}/${DATABASE_NAME}"
LOG_DIR="${M13C_E2E_LOG_DIR:-$ROOT/.tmp/m13c-e2e}"
M13B_FIXTURE_PATH="${M13C_E2E_M13B_FIXTURE_PATH:-$ROOT/.tmp/m13c-e2e-m13b-fixture.json}"
M13C_FIXTURE_PATH="${M13C_E2E_FIXTURE_PATH:-$ROOT/.tmp/m13c-e2e-fixture.json}"
PIDS=()

mkdir -p "$LOG_DIR" .tmp

compose() {
  "$ROOT/scripts/db-compose.sh" \
    -p "$COMPOSE_PROJECT" \
    -f "$ROOT/$COMPOSE_FILE" \
    "$@"
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
  if [[ "${M13C_E2E_KEEP_ENV:-0}" != "1" ]]; then
    compose down -v >/dev/null 2>&1 || true
  fi
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
for _ in {1..120}; do
  container_id="$(compose ps -q postgres)"
  health="$(
    docker inspect --format '{{.State.Health.Status}}' \
      "$container_id" 2>/dev/null || true
  )"
  if [[ "$health" == "healthy" ]] &&
    psql_database postgres "SELECT 1;" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

psql_database postgres "CREATE DATABASE $DATABASE_NAME;"

export DATABASE_URL
export NODE_ENV=test
export AUTH_MODE=local-development
export API_HOST=127.0.0.1
export API_PORT
export WEB_PORT
export LOG_LEVEL=error
export FILE_STORE_ROOT="$ROOT/.tmp/m13c-e2e-files"
export M13B_E2E_FIXTURE_PATH="$M13B_FIXTURE_PATH"
export M13C_E2E_FIXTURE_PATH="$M13C_FIXTURE_PATH"

pnpm db:migrate >/dev/null
pnpm build >/dev/null
node_modules/.bin/tsx scripts/m13b-tool-call-e2e-seed.ts
node_modules/.bin/tsx scripts/m13c-runtime-tool-e2e-seed.ts

start_process api node apps/api/lib/index.js
start_process web pnpm --filter @pluginmax/web exec vite \
  --host 127.0.0.1 --port "$WEB_PORT"
wait_http "http://127.0.0.1:$API_PORT/api/v1/health"
wait_http "http://127.0.0.1:$WEB_PORT/"

PLUGINMAX_WEB_BASE_URL="http://127.0.0.1:$WEB_PORT" \
  pnpm exec playwright test e2e/runtime-tool-request.spec.ts
