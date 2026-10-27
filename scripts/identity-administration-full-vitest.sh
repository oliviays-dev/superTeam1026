#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COMPOSE_PROJECT="${COMPOSE_PROJECT:-pluginmax-batch20a-identity}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.batch20a.yml}"
DATABASE_URL_INPUT="${DATABASE_URL:-postgres://pluginmax:pluginmax@127.0.0.1:54433/pluginmax}"
STAMP="$(date -u +%Y%m%d%H%M%S)"
DATABASE_NAME="pluginmax_batch20a_full_$STAMP"
DATABASE_URL="${DATABASE_URL_INPUT%/*}/$DATABASE_NAME"
TMP_ROOT="$ROOT/.tmp/batch20a-full-vitest"

mkdir -p "$TMP_ROOT"

compose() {
  "$ROOT/scripts/db-compose.sh" -p "$COMPOSE_PROJECT" -f "$ROOT/$COMPOSE_FILE" "$@"
}

psql_database() {
  local database="$1"
  local sql="$2"
  compose exec -T postgres psql -U pluginmax -d "$database" \
    -qAt -v ON_ERROR_STOP=1 -c "$sql"
}

cleanup() {
  psql_database postgres \
    "DROP DATABASE IF EXISTS $DATABASE_NAME WITH (FORCE);" \
    >/dev/null 2>&1 || true
}
trap cleanup EXIT

compose up -d postgres >/dev/null
for _ in {1..80}; do
  container_id="$(compose ps -q postgres)"
  health="$(docker inspect --format '{{.State.Health.Status}}' "$container_id" 2>/dev/null || true)"
  if [[ "$health" == "healthy" ]] &&
    compose exec -T postgres psql -U pluginmax -d pluginmax -qAt \
      -c "SELECT 1" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
psql_database postgres "CREATE DATABASE $DATABASE_NAME;"

export TEST_DATABASE_URL="$DATABASE_URL"
export DSH_HOME="$TMP_ROOT/dsh-home"
export FILE_STORE_ROOT="$TMP_ROOT/files"
export AGENT_WORKSPACE_ROOT="$TMP_ROOT/workspaces"
export PLUGINMAX_ROOT="$ROOT"

node_modules/.bin/vitest run
