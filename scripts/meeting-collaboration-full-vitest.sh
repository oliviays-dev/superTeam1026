#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COMPOSE_PROJECT="${COMPOSE_PROJECT:-pluginmax-batch18-db}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.batch18.yml}"
DATABASE_URL_INPUT="${DATABASE_URL:-postgres://pluginmax:pluginmax@127.0.0.1:54432/pluginmax}"
STAMP="$(date -u +%Y%m%d%H%M%S)"
DATABASE_NAME="pluginmax_batch18_full_$STAMP"
TEST_DATABASE_URL="${DATABASE_URL_INPUT%/*}/$DATABASE_NAME"
TMP_ROOT="$ROOT/.tmp/batch18-full-vitest"

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
  if compose exec -T postgres psql -U pluginmax -d postgres \
    -c "SELECT 1" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
compose exec -T postgres psql -U pluginmax -d postgres \
  -c "SELECT 1" >/dev/null
psql_database postgres "CREATE DATABASE $DATABASE_NAME;"

mkdir -p \
  "$TMP_ROOT/dsh-home" \
  "$TMP_ROOT/files" \
  "$TMP_ROOT/workspaces" \
  "$TMP_ROOT/logs" \
  "$TMP_ROOT/screenshots"
export DSH_HOME="$TMP_ROOT/dsh-home"
export FILE_STORE_ROOT="$TMP_ROOT/files"
export AGENT_WORKSPACE_ROOT="$TMP_ROOT/workspaces"

DATABASE_URL="$TEST_DATABASE_URL" \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null
TEST_DATABASE_URL="$TEST_DATABASE_URL" CI=true \
  node_modules/.bin/vitest run --no-file-parallelism

printf 'meeting_collaboration_full_vitest=ok\n'
printf 'fresh_migration=%s\n' "$(
  psql_database "$DATABASE_NAME" \
    "SELECT MAX(version) FROM platform_migrations;"
)"
