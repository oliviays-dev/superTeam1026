#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COMPOSE_PROJECT="${M13C_MIGRATION_COMPOSE_PROJECT:-pluginmax-m13c-migration}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.core-regression.yml}"
PORT="${M13C_MIGRATION_POSTGRES_PORT:-54473}"
export CORE_REGRESSION_POSTGRES_PORT="$PORT"
DATABASE_URL_INPUT="${DATABASE_URL:-postgres://pluginmax:pluginmax@127.0.0.1:${PORT}/pluginmax}"
STAMP="$(date -u +%Y%m%d%H%M%S)"
EMPTY_DATABASE="pluginmax_m13c_empty_${STAMP}"
FROM_49_DATABASE="pluginmax_m13c_from49_${STAMP}"
FROM_50_DATABASE="pluginmax_m13c_from50_${STAMP}"
EMPTY_URL="${DATABASE_URL_INPUT%/*}/${EMPTY_DATABASE}"
FROM_49_URL="${DATABASE_URL_INPUT%/*}/${FROM_49_DATABASE}"
FROM_50_URL="${DATABASE_URL_INPUT%/*}/${FROM_50_DATABASE}"

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

cleanup() {
  for database in "$EMPTY_DATABASE" "$FROM_49_DATABASE" "$FROM_50_DATABASE"; do
    psql_database postgres \
      "DROP DATABASE IF EXISTS $database WITH (FORCE);" \
      >/dev/null 2>&1 || true
  done
  if [[ "${M13C_MIGRATION_KEEP_ENV:-0}" != "1" ]]; then
    compose down -v >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

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

for database in "$EMPTY_DATABASE" "$FROM_49_DATABASE" "$FROM_50_DATABASE"; do
  psql_database postgres "CREATE DATABASE $database;"
done

DATABASE_URL="$EMPTY_URL" MIGRATION_TARGET_VERSION=51 \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null

FRESH_VERSION="$(psql_database "$EMPTY_DATABASE" \
  "SELECT MAX(version) FROM platform_migrations;")"
FRESH_FLAG="$(psql_database "$EMPTY_DATABASE" \
  "SELECT mode FROM feature_flag_settings
   WHERE flag_key = 'mcp.runtime_tool_bridge'
     AND scope_type = 'platform'
     AND scope_id = 'platform';")"
FRESH_TABLES="$(psql_database "$EMPTY_DATABASE" \
  "SELECT COUNT(*) FROM unnest(ARRAY[
     'runtime_tool_requests',
     'runtime_tool_request_receipts'
   ]) AS expected(name)
   WHERE to_regclass('public.' || expected.name) IS NOT NULL;")"
FRESH_TRIGGERS="$(psql_database "$EMPTY_DATABASE" \
  "SELECT COUNT(*) FROM pg_trigger
   WHERE NOT tgisinternal
     AND tgname IN (
       'runtime_tool_requests_scope_guard',
       'runtime_tool_requests_mutation_guard',
       'runtime_tool_requests_receipt_insert',
       'runtime_tool_requests_receipt_terminal',
       'runtime_tool_request_receipts_seq_guard',
       'runtime_tool_request_receipts_append_only',
       'run_events_seq_guard'
     );")"

DATABASE_URL="$EMPTY_URL" MIGRATION_TARGET_VERSION=51 \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null
IDEMPOTENT_VERSION="$(psql_database "$EMPTY_DATABASE" \
  "SELECT MAX(version) FROM platform_migrations;")"

DATABASE_URL="$FROM_49_URL" MIGRATION_TARGET_VERSION=49 \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null
DATABASE_URL="$FROM_49_URL" MIGRATION_TARGET_VERSION=51 \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null
FROM_49_VERSION="$(psql_database "$FROM_49_DATABASE" \
  "SELECT MAX(version) FROM platform_migrations;")"

DATABASE_URL="$FROM_50_URL" MIGRATION_TARGET_VERSION=50 \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null
DATABASE_URL="$FROM_50_URL" MIGRATION_TARGET_VERSION=51 \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null
FROM_50_VERSION="$(psql_database "$FROM_50_DATABASE" \
  "SELECT MAX(version) FROM platform_migrations;")"

printf 'm13c_migration_vitest=ok\n'
printf 'fresh_migration=0->%s\n' "$FRESH_VERSION"
printf 'idempotent_migration=%s->%s\n' \
  "$FRESH_VERSION" "$IDEMPOTENT_VERSION"
printf 'upgrade_migration=49->%s,50->%s\n' \
  "$FROM_49_VERSION" "$FROM_50_VERSION"
printf 'flag=mcp.runtime_tool_bridge=%s\n' "$FRESH_FLAG"
printf 'tables=%s\n' "$FRESH_TABLES"
printf 'triggers=%s\n' "$FRESH_TRIGGERS"
