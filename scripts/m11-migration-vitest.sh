#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COMPOSE_PROJECT="${M11_MIGRATION_COMPOSE_PROJECT:-pluginmax-m11-migration}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.core-regression.yml}"
PORT="${M11_MIGRATION_POSTGRES_PORT:-54463}"
export CORE_REGRESSION_POSTGRES_PORT="$PORT"
DATABASE_URL_INPUT="${DATABASE_URL:-postgres://pluginmax:pluginmax@127.0.0.1:${PORT}/pluginmax}"
STAMP="$(date -u +%Y%m%d%H%M%S)"
EMPTY_DATABASE="pluginmax_m11_empty_${STAMP}"
FROM_45_DATABASE="pluginmax_m11_from45_${STAMP}"
FROM_46_DATABASE="pluginmax_m11_from46_${STAMP}"
EMPTY_URL="${DATABASE_URL_INPUT%/*}/${EMPTY_DATABASE}"
FROM_45_URL="${DATABASE_URL_INPUT%/*}/${FROM_45_DATABASE}"
FROM_46_URL="${DATABASE_URL_INPUT%/*}/${FROM_46_DATABASE}"

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
  for database in "$EMPTY_DATABASE" "$FROM_45_DATABASE" "$FROM_46_DATABASE"; do
    psql_database postgres \
      "DROP DATABASE IF EXISTS $database WITH (FORCE);" \
      >/dev/null 2>&1 || true
  done
  if [[ "${M11_MIGRATION_KEEP_ENV:-0}" != "1" ]]; then
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

for database in "$EMPTY_DATABASE" "$FROM_45_DATABASE" "$FROM_46_DATABASE"; do
  psql_database postgres "CREATE DATABASE $database;"
done

DATABASE_URL="$EMPTY_URL" MIGRATION_TARGET_VERSION=47 \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null

FRESH_VERSION="$(psql_database "$EMPTY_DATABASE" \
  "SELECT MAX(version) FROM platform_migrations;")"
FRESH_FLAGS="$(psql_database "$EMPTY_DATABASE" \
  "SELECT string_agg(flag_key || '=' || mode, ',' ORDER BY flag_key)
   FROM feature_flag_settings
   WHERE flag_key IN ('project.business_chain', 'project.source.mock');")"
FRESH_TABLES="$(psql_database "$EMPTY_DATABASE" \
  "SELECT COUNT(*) FROM unnest(ARRAY[
     'project_template_business_chain_refs',
     'project_business_chain_binding_revisions',
     'project_business_chain_bindings',
     'project_source_snapshots',
     'project_alerts',
     'project_alert_events'
   ]) AS expected(name)
   WHERE to_regclass('public.' || expected.name) IS NOT NULL;")"
FRESH_COLUMNS="$(psql_database "$EMPTY_DATABASE" \
  "SELECT COUNT(*) FROM information_schema.columns
   WHERE table_name = 'workflow_definitions'
     AND column_name IN (
       'kind', 'chain_key', 'business_chain_metadata', 'business_chain_nodes'
     );")"
FRESH_TRIGGERS="$(psql_database "$EMPTY_DATABASE" \
  "SELECT COUNT(*) FROM pg_trigger
   WHERE NOT tgisinternal
     AND tgname IN (
       'workflow_definitions_business_chain_guard',
       'project_template_business_chain_refs_guard',
       'project_business_chain_binding_revisions_immutable',
       'project_business_chain_bindings_guard',
       'project_business_chain_bindings_revision_guard',
       'project_business_chain_bindings_delete_guard',
       'project_source_snapshots_version_guard',
       'project_source_snapshots_immutable',
       'project_alerts_revision_guard',
       'project_alerts_delete_guard',
       'project_alert_events_seq_guard',
       'project_alert_events_append_only'
     );")"

DATABASE_URL="$EMPTY_URL" MIGRATION_TARGET_VERSION=47 \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null
IDEMPOTENT_VERSION="$(psql_database "$EMPTY_DATABASE" \
  "SELECT MAX(version) FROM platform_migrations;")"

DATABASE_URL="$FROM_45_URL" MIGRATION_TARGET_VERSION=45 \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null
psql_database "$FROM_45_DATABASE" "
INSERT INTO projects (
  id, name, code, description, status, created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000020000',
  'M11 from 45',
  'M11-45',
  '',
  'active',
  NOW(),
  NOW()
);
INSERT INTO workflow_definitions (
  id, project_id, name, description, steps, source_md, graph, status,
  created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000020001',
  '00000000-0000-4000-8000-000000020000',
  'Legacy workflow 45',
  '',
  '[]'::jsonb,
  '',
  NULL,
  'active',
  NOW(),
  NOW()
);"
DATABASE_URL="$FROM_45_URL" MIGRATION_TARGET_VERSION=47 \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null

DATABASE_URL="$FROM_46_URL" MIGRATION_TARGET_VERSION=46 \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null
psql_database "$FROM_46_DATABASE" "
INSERT INTO projects (
  id, name, code, description, status, created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000030000',
  'M11 from 46',
  'M11-46',
  '',
  'active',
  NOW(),
  NOW()
);
INSERT INTO workflow_definitions (
  id, project_id, name, description, steps, source_md, graph, status,
  created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000030001',
  '00000000-0000-4000-8000-000000030000',
  'Legacy workflow 46',
  '',
  '[]'::jsonb,
  '',
  NULL,
  'active',
  NOW(),
  NOW()
);"
DATABASE_URL="$FROM_46_URL" MIGRATION_TARGET_VERSION=47 \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null

FROM_45_VERSION="$(psql_database "$FROM_45_DATABASE" \
  "SELECT MAX(version) FROM platform_migrations;")"
FROM_46_VERSION="$(psql_database "$FROM_46_DATABASE" \
  "SELECT MAX(version) FROM platform_migrations;")"
LEGACY_READ="$(psql_database "$FROM_45_DATABASE" \
  "SELECT kind || ':' || (chain_key IS NULL)::text || ':' ||
          jsonb_array_length(business_chain_nodes)::text
   FROM workflow_definitions
   WHERE id = '00000000-0000-4000-8000-000000020001';")"
FROM_46_READ="$(psql_database "$FROM_46_DATABASE" \
  "SELECT kind || ':' || (chain_key IS NULL)::text || ':' ||
          jsonb_array_length(business_chain_nodes)::text
   FROM workflow_definitions
   WHERE id = '00000000-0000-4000-8000-000000030001';")"

psql_database "$FROM_45_DATABASE" "
INSERT INTO workflow_definitions (
  id, project_id, name, description, steps, source_md, graph, status,
  created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000020002',
  '00000000-0000-4000-8000-000000020000',
  'Old app workflow write',
  '',
  '[]'::jsonb,
  '',
  NULL,
  'active',
  NOW(),
  NOW()
);"
OLD_APP_WRITE="$(psql_database "$FROM_45_DATABASE" \
  "SELECT name || '|' || kind
   FROM workflow_definitions
   WHERE id = '00000000-0000-4000-8000-000000020002';")"
LEGACY_BINDINGS="$(psql_database "$FROM_45_DATABASE" \
  "SELECT COUNT(*) FROM project_business_chain_bindings;")"
LEGACY_ALERTS="$(psql_database "$FROM_45_DATABASE" \
  "SELECT COUNT(*) FROM project_alerts;")"

[[ "$FRESH_VERSION" == "47" ]]
[[ "$FRESH_FLAGS" == "project.business_chain=off,project.source.mock=off" ]]
[[ "$FRESH_TABLES" == "6" ]]
[[ "$FRESH_COLUMNS" == "4" ]]
[[ "$FRESH_TRIGGERS" == "12" ]]
[[ "$IDEMPOTENT_VERSION" == "47" ]]
[[ "$FROM_45_VERSION" == "47" ]]
[[ "$FROM_46_VERSION" == "47" ]]
[[ "$LEGACY_READ" == "workflow:true:0" ]]
[[ "$FROM_46_READ" == "workflow:true:0" ]]
[[ "$OLD_APP_WRITE" == "Old app workflow write|workflow" ]]
[[ "$LEGACY_BINDINGS" == "0" ]]
[[ "$LEGACY_ALERTS" == "0" ]]

printf 'm11_migration_vitest=ok\n'
printf 'fresh_migration=0->47\n'
printf 'upgrade_migration=45->47,46->47\n'
printf 'idempotent_migration=47->47\n'
printf 'flags=%s\n' "$FRESH_FLAGS"
printf 'tables=%s\n' "$FRESH_TABLES"
printf 'columns=%s\n' "$FRESH_COLUMNS"
printf 'triggers=%s\n' "$FRESH_TRIGGERS"
printf 'legacy_read=%s,%s\n' "$LEGACY_READ" "$FROM_46_READ"
printf 'old_app_write=%s\n' "$OLD_APP_WRITE"
printf 'legacy_rows=%s|%s\n' "$LEGACY_BINDINGS" "$LEGACY_ALERTS"
