#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COMPOSE_PROJECT="${M8_MIGRATION_COMPOSE_PROJECT:-pluginmax-m8-migration}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.core-regression.yml}"
PORT="${M8_MIGRATION_POSTGRES_PORT:-54457}"
export CORE_REGRESSION_POSTGRES_PORT="$PORT"
DATABASE_URL_INPUT="${DATABASE_URL:-postgres://pluginmax:pluginmax@127.0.0.1:${PORT}/pluginmax}"
STAMP="$(date -u +%Y%m%d%H%M%S)"
EMPTY_DATABASE="pluginmax_m8_empty_${STAMP}"
UPGRADE_DATABASE="pluginmax_m8_upgrade_${STAMP}"
EMPTY_URL="${DATABASE_URL_INPUT%/*}/${EMPTY_DATABASE}"
UPGRADE_URL="${DATABASE_URL_INPUT%/*}/${UPGRADE_DATABASE}"

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
  psql_database postgres \
    "DROP DATABASE IF EXISTS $EMPTY_DATABASE WITH (FORCE);" \
    >/dev/null 2>&1 || true
  psql_database postgres \
    "DROP DATABASE IF EXISTS $UPGRADE_DATABASE WITH (FORCE);" \
    >/dev/null 2>&1 || true
  if [[ "${M8_MIGRATION_KEEP_ENV:-0}" != "1" ]]; then
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
psql_database postgres "CREATE DATABASE $EMPTY_DATABASE;"
psql_database postgres "CREATE DATABASE $UPGRADE_DATABASE;"

DATABASE_URL="$EMPTY_URL" \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null
FRESH_VERSION="$(psql_database "$EMPTY_DATABASE" \
  "SELECT MAX(version) FROM platform_migrations;")"
FRESH_FLAGS="$(psql_database "$EMPTY_DATABASE" \
  "SELECT string_agg(flag_key || '=' || mode, ',' ORDER BY flag_key)
   FROM feature_flag_settings
   WHERE flag_key IN ('workbench.v2', 'market');")"
FRESH_TABLES="$(psql_database "$EMPTY_DATABASE" \
  "SELECT COUNT(*) FROM unnest(ARRAY[
     'market_assets',
     'market_asset_versions',
     'market_templates',
     'market_template_dependencies',
     'market_entitlements',
     'market_installations',
     'market_template_copies',
     'workbenches',
     'workbench_layouts',
     'workbench_panels',
     'workbench_panel_instances',
     'workbench_layout_versions',
     'workbench_versions'
   ]) AS expected(name)
   WHERE to_regclass('public.' || expected.name) IS NOT NULL;")"
FRESH_TRIGGERS="$(psql_database "$EMPTY_DATABASE" \
  "SELECT COUNT(*) FROM pg_trigger
   WHERE NOT tgisinternal
     AND tgname IN (
       'workbench_layouts_owner_guard',
       'workbench_layout_versions_immutable',
       'workbench_versions_immutable',
       'market_asset_versions_guard',
       'market_installations_scope_guard',
       'market_template_copies_owner_guard',
       'market_template_dependencies_immutable'
     );")"
FRESH_PANELS="$(psql_database "$EMPTY_DATABASE" \
  "SELECT COUNT(*) FROM workbench_panels WHERE trusted_build;")"

[[ "$FRESH_VERSION" == "44" ]]
[[ "$FRESH_FLAGS" == "market=off,workbench.v2=off" ]]
[[ "$FRESH_TABLES" == "13" ]]
[[ "$FRESH_TRIGGERS" == "7" ]]
[[ "$FRESH_PANELS" == "10" ]]

DATABASE_URL="$UPGRADE_URL" MIGRATION_TARGET_VERSION=43 \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null
psql_database "$UPGRADE_DATABASE" "
INSERT INTO principals (
  id, kind, display_name, status, status_authority, source,
  version, created_at, updated_at
) VALUES (
  'local-admin', 'human', 'Local Admin', 'active', 'system', 'local',
  1, NOW(), NOW()
);
INSERT INTO projects (
  id, name, code, description, status, created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000008000',
  'M8 migration snapshot',
  'M8-MIG-44',
  '',
  'active',
  NOW(),
  NOW()
);
INSERT INTO tasks (
  id, project_id, title, description, acceptance, status, agent_id,
  created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000008001',
  '00000000-0000-4000-8000-000000008000',
  'M8 snapshot task',
  'preserve before migration 44',
  '[]'::jsonb,
  'queued',
  '00000000-0000-4000-8000-000000000001',
  NOW(),
  NOW()
);
INSERT INTO runs (
  id, project_id, task_id, agent_id, status, input_snapshot,
  observability, attempt, created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000008002',
  '00000000-0000-4000-8000-000000008000',
  '00000000-0000-4000-8000-000000008001',
  '00000000-0000-4000-8000-000000000001',
  'completed',
  '{}'::jsonb,
  '{}'::jsonb,
  1,
  NOW(),
  NOW()
);"

DATABASE_URL="$UPGRADE_URL" \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null

UPGRADE_VERSION="$(psql_database "$UPGRADE_DATABASE" \
  "SELECT MAX(version) FROM platform_migrations;")"
FACTORY_COUNTS="$(psql_database "$UPGRADE_DATABASE" \
  "SELECT
     (SELECT COUNT(*) FROM workbenches) || '|' ||
     (SELECT COUNT(*) FROM workbench_layouts WHERE is_factory_default) || '|' ||
     (SELECT COUNT(*) FROM workbench_layout_versions) || '|' ||
     (SELECT COUNT(*) FROM workbench_versions);")"
LEGACY_READ="$(psql_database "$UPGRADE_DATABASE" \
  "SELECT task.title || '|' || run.status || '|' ||
          workbench.owner_principal_id || '|' || layout.is_default
   FROM tasks AS task
   JOIN runs AS run ON run.task_id = task.id
   JOIN workbenches AS workbench ON workbench.owner_principal_id = 'local-admin'
   JOIN workbench_layouts AS layout ON layout.workbench_id = workbench.id
   WHERE task.id = '00000000-0000-4000-8000-000000008001'
   LIMIT 1;")"
psql_database "$UPGRADE_DATABASE" \
  "INSERT INTO run_events (
     id, run_id, seq, type, visibility, summary, data, created_at
   ) VALUES (
     '00000000-0000-4000-8000-000000008003',
     '00000000-0000-4000-8000-000000008002',
     1, 'progress.summary', 'user', 'legacy app write',
     '{}'::jsonb, NOW()
   );" >/dev/null
OLD_APP_WRITE="$(psql_database "$UPGRADE_DATABASE" \
  "SELECT summary FROM run_events
   WHERE id = '00000000-0000-4000-8000-000000008003';")"
CONFLICT_COUNT="$(psql_database "$UPGRADE_DATABASE" \
  "SELECT COUNT(*) FROM (
     SELECT owner_principal_id
     FROM workbench_layouts
     WHERE is_default AND status = 'active'
     GROUP BY owner_principal_id
     HAVING COUNT(*) > 1
     UNION ALL
     SELECT workbench.id::text
     FROM workbenches AS workbench
     LEFT JOIN workbench_versions AS version
       ON version.workbench_id = workbench.id
      AND version.version = workbench.current_version
     WHERE version.id IS NULL
   ) AS conflicts;")"

[[ "$UPGRADE_VERSION" == "44" ]]
[[ "$FACTORY_COUNTS" == "1|1|1|1" ]]
[[ "$LEGACY_READ" == "M8 snapshot task|completed|local-admin|t" ]]
[[ "$OLD_APP_WRITE" == "legacy app write" ]]
[[ "$CONFLICT_COUNT" == "0" ]]

printf 'm8_migration_vitest=ok\n'
printf 'fresh_migration=0->44\n'
printf 'upgrade_migration=43->44\n'
printf 'flags=%s\n' "$FRESH_FLAGS"
printf 'tables=%s\n' "$FRESH_TABLES"
printf 'triggers=%s\n' "$FRESH_TRIGGERS"
printf 'factory_counts=%s\n' "$FACTORY_COUNTS"
printf 'old_app_read=%s\n' "$LEGACY_READ"
printf 'old_app_write=%s\n' "$OLD_APP_WRITE"
printf 'constraint_conflicts=%s\n' "$CONFLICT_COUNT"
