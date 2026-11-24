#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COMPOSE_PROJECT="${M13D_MIGRATION_COMPOSE_PROJECT:-pluginmax-m13d-migration}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.core-regression.yml}"
PORT="${M13D_MIGRATION_POSTGRES_PORT:-54483}"
export CORE_REGRESSION_POSTGRES_PORT="$PORT"
DATABASE_URL_INPUT="${DATABASE_URL:-postgres://pluginmax:pluginmax@127.0.0.1:${PORT}/pluginmax}"
STAMP="$(date -u +%Y%m%d%H%M%S)"
EMPTY_DATABASE="pluginmax_m13d_empty_${STAMP}"
FROM_51_DATABASE="pluginmax_m13d_from51_${STAMP}"
EMPTY_URL="${DATABASE_URL_INPUT%/*}/${EMPTY_DATABASE}"
FROM_51_URL="${DATABASE_URL_INPUT%/*}/${FROM_51_DATABASE}"

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
  for database in "$EMPTY_DATABASE" "$FROM_51_DATABASE"; do
    psql_database postgres \
      "DROP DATABASE IF EXISTS $database WITH (FORCE);" \
      >/dev/null 2>&1 || true
  done
  if [[ "${M13D_MIGRATION_KEEP_ENV:-0}" != "1" ]]; then
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

for database in "$EMPTY_DATABASE" "$FROM_51_DATABASE"; do
  psql_database postgres "CREATE DATABASE $database;"
done

DATABASE_URL="$EMPTY_URL" MIGRATION_TARGET_VERSION=52 \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null

FRESH_VERSION="$(psql_database "$EMPTY_DATABASE" \
  "SELECT MAX(version) FROM platform_migrations;")"
FRESH_FLAG="$(psql_database "$EMPTY_DATABASE" \
  "SELECT mode FROM feature_flag_settings
   WHERE flag_key = 'project.source.mcp'
     AND scope_type = 'platform'
     AND scope_id = 'platform';")"
FRESH_TABLES="$(psql_database "$EMPTY_DATABASE" \
  "SELECT COUNT(*) FROM unnest(ARRAY[
     'project_source_mcp_reads',
     'project_source_mcp_read_events'
   ]) AS expected(name)
   WHERE to_regclass('public.' || expected.name) IS NOT NULL;")"
FRESH_TRIGGERS="$(psql_database "$EMPTY_DATABASE" \
  "SELECT COUNT(*) FROM pg_trigger
   WHERE NOT tgisinternal
     AND tgname IN (
       'project_source_mcp_reads_guard',
       'project_source_mcp_reads_delete_guard',
       'project_source_mcp_read_events_seq_guard',
       'project_source_mcp_reads_event_insert',
       'project_source_mcp_reads_event_terminal',
       'project_source_mcp_read_events_append_only'
     );")"

DATABASE_URL="$EMPTY_URL" MIGRATION_TARGET_VERSION=52 \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null
IDEMPOTENT_VERSION="$(psql_database "$EMPTY_DATABASE" \
  "SELECT MAX(version) FROM platform_migrations;")"

DATABASE_URL="$FROM_51_URL" MIGRATION_TARGET_VERSION=51 \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null
DATABASE_URL="$FROM_51_URL" MIGRATION_TARGET_VERSION=52 \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null
FROM_51_VERSION="$(psql_database "$FROM_51_DATABASE" \
  "SELECT MAX(version) FROM platform_migrations;")"

printf 'm13d_migration_vitest=ok\n'
printf 'fresh_migration=0->%s\n' "$FRESH_VERSION"
printf 'idempotent_migration=%s->%s\n' \
  "$FRESH_VERSION" "$IDEMPOTENT_VERSION"
printf 'upgrade_migration=51->%s\n' "$FROM_51_VERSION"
printf 'flag=project.source.mcp=%s\n' "$FRESH_FLAG"
printf 'tables=%s\n' "$FRESH_TABLES"
printf 'triggers=%s\n' "$FRESH_TRIGGERS"
