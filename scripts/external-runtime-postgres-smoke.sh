#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-pluginmax-batch13}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.batch13.yml}"
DATABASE_URL_INPUT="${DATABASE_URL:-postgres://pluginmax:pluginmax@127.0.0.1:54422/pluginmax}"
STAMP="$(date -u +%Y%m%d%H%M%S)"

compose() {
  "$ROOT/scripts/db-compose.sh" -p "$COMPOSE_PROJECT" -f "$ROOT/$COMPOSE_FILE" "$@"
}

psql_database() {
  local database="$1"
  local sql="$2"
  compose exec -T postgres psql -U pluginmax -d "$database" \
    -qAt -v ON_ERROR_STOP=1 -c "$sql"
}

compose up -d postgres >/dev/null
for _ in {1..60}; do
  if compose exec -T postgres pg_isready \
    -U pluginmax -d pluginmax >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

database="pluginmax_batch13_migration_$STAMP"
database_url="${DATABASE_URL_INPUT%/*}/$database"
psql_database postgres "CREATE DATABASE $database;"

cleanup() {
  psql_database postgres \
    "DROP DATABASE IF EXISTS $database WITH (FORCE);" \
    >/dev/null 2>&1 || true
}
trap cleanup EXIT

DATABASE_URL="$database_url" MIGRATION_TARGET_VERSION=20 CI=true \
  pnpm --filter @pluginmax/database exec tsx src/migrate-cli.ts >/dev/null

psql_database "$database" "
  INSERT INTO projects (
    id, name, code, description, status, created_at, updated_at
  ) VALUES (
    '13000000-0000-4000-8001-000000000001',
    'Batch 13 migration project',
    'B13-MIG',
    'Migration 20 to 21 preserves legacy data',
    'active',
    NOW(),
    NOW()
  );
"

DATABASE_URL="$database_url" MIGRATION_TARGET_VERSION=21 CI=true \
  pnpm --filter @pluginmax/database exec tsx src/migrate-cli.ts >/dev/null

version="$(psql_database "$database" \
  'SELECT MAX(version) FROM platform_migrations;')"
runtime_tables="$(psql_database "$database" \
  "SELECT COUNT(*) FROM information_schema.tables
   WHERE table_schema = 'public'
     AND table_name IN (
       'external_runtimes',
       'external_runtime_probes',
       'external_runtime_capabilities',
       'external_runtime_events',
       'runtime_probe_jobs'
     );")"
append_only_trigger="$(psql_database "$database" \
  "SELECT COUNT(DISTINCT trigger_name) FROM information_schema.triggers
   WHERE trigger_name = 'external_runtime_events_append_only';")"
probe_immutable_trigger="$(psql_database "$database" \
  "SELECT COUNT(DISTINCT trigger_name) FROM information_schema.triggers
   WHERE trigger_name = 'external_runtime_probes_terminal_immutable';")"
probe_job_index="$(psql_database "$database" \
  "SELECT COUNT(*) FROM pg_indexes
   WHERE indexname = 'runtime_probe_jobs_active_runtime_idx';")"
legacy_project="$(psql_database "$database" \
  "SELECT name FROM projects
   WHERE id = '13000000-0000-4000-8001-000000000001';")"
imported_runtimes="$(psql_database "$database" \
  'SELECT COUNT(*) FROM external_runtimes;')"

if [[ "$version" != "21" ||
      "$runtime_tables" != "5" ||
      "$append_only_trigger" != "1" ||
      "$probe_immutable_trigger" != "1" ||
      "$probe_job_index" != "1" ||
      "$legacy_project" != "Batch 13 migration project" ||
      "$imported_runtimes" != "0" ]]; then
  printf 'v20 to v21 external runtime smoke failed: version=%s tables=%s event_trigger=%s probe_trigger=%s job_index=%s project=%s imported=%s\n' \
    "$version" "$runtime_tables" "$append_only_trigger" \
    "$probe_immutable_trigger" "$probe_job_index" "$legacy_project" \
    "$imported_runtimes" >&2
  exit 1
fi

printf 'external_runtime_postgres_smoke=ok\n'
printf 'database=%s\n' "$database"
printf 'migration_version=%s\n' "$version"
printf 'runtime_tables=%s\n' "$runtime_tables"
printf 'legacy_project=%s\n' "$legacy_project"
printf 'imported_legacy_runtimes=%s\n' "$imported_runtimes"
