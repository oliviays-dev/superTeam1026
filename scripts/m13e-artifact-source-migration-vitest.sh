#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COMPOSE_PROJECT="${M13E_MIGRATION_COMPOSE_PROJECT:-pluginmax-m13e-migration}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.core-regression.yml}"
PORT="${M13E_MIGRATION_POSTGRES_PORT:-54486}"
export CORE_REGRESSION_POSTGRES_PORT="$PORT"
DATABASE_URL_INPUT="${DATABASE_URL:-postgres://pluginmax:pluginmax@127.0.0.1:${PORT}/pluginmax}"
STAMP="$(date -u +%Y%m%d%H%M%S)"
EMPTY_DATABASE="pluginmax_m13e_empty_${STAMP}"
FROM_52_DATABASE="pluginmax_m13e_from52_${STAMP}"
EMPTY_URL="${DATABASE_URL_INPUT%/*}/${EMPTY_DATABASE}"
FROM_52_URL="${DATABASE_URL_INPUT%/*}/${FROM_52_DATABASE}"

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
  for database in "$EMPTY_DATABASE" "$FROM_52_DATABASE"; do
    psql_database postgres \
      "DROP DATABASE IF EXISTS $database WITH (FORCE);" \
      >/dev/null 2>&1 || true
  done
  if [[ "${M13E_MIGRATION_KEEP_ENV:-0}" != "1" ]]; then
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

for database in "$EMPTY_DATABASE" "$FROM_52_DATABASE"; do
  psql_database postgres "CREATE DATABASE $database;"
done

DATABASE_URL="$EMPTY_URL" \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null
FRESH_VERSION="$(psql_database "$EMPTY_DATABASE" \
  "SELECT MAX(version) FROM platform_migrations;")"
COLUMN="$(psql_database "$EMPTY_DATABASE" \
  "SELECT data_type || ':' || is_nullable || ':' || column_default
   FROM information_schema.columns
   WHERE table_name = 'artifacts' AND column_name = 'source_refs';")"
INDEX="$(psql_database "$EMPTY_DATABASE" \
  "SELECT COUNT(*) FROM pg_indexes
   WHERE tablename = 'artifacts'
     AND indexname = 'artifacts_source_refs_idx';")"

DATABASE_URL="$EMPTY_URL" \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null
IDEMPOTENT_VERSION="$(psql_database "$EMPTY_DATABASE" \
  "SELECT MAX(version) FROM platform_migrations;")"

DATABASE_URL="$FROM_52_URL" MIGRATION_TARGET_VERSION=52 \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null
DATABASE_URL="$FROM_52_URL" \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null
FROM_52_VERSION="$(psql_database "$FROM_52_DATABASE" \
  "SELECT MAX(version) FROM platform_migrations;")"

printf 'm13e_migration_vitest=ok\n'
printf 'fresh_migration=0->%s\n' "$FRESH_VERSION"
printf 'idempotent_migration=%s->%s\n' \
  "$FRESH_VERSION" "$IDEMPOTENT_VERSION"
printf 'upgrade_migration=52->%s\n' "$FROM_52_VERSION"
printf 'column=%s\n' "$COLUMN"
printf 'source_refs_index=%s\n' "$INDEX"
