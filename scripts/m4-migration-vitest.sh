#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COMPOSE_PROJECT="${M4_MIGRATION_COMPOSE_PROJECT:-pluginmax-m4-migration}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.core-regression.yml}"
PORT="${M4_MIGRATION_POSTGRES_PORT:-54448}"
export CORE_REGRESSION_POSTGRES_PORT="$PORT"
DATABASE_URL_INPUT="${DATABASE_URL:-postgres://pluginmax:pluginmax@127.0.0.1:${PORT}/pluginmax}"
STAMP="$(date -u +%Y%m%d%H%M%S)"
EMPTY_DATABASE="pluginmax_m4_empty_${STAMP}"
UPGRADE_DATABASE="pluginmax_m4_upgrade_${STAMP}"
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
  if [[ "${M4_MIGRATION_KEEP_ENV:-0}" != "1" ]]; then
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
FRESH_TABLES="$(psql_database "$EMPTY_DATABASE" \
  "SELECT COUNT(*) FROM pg_class
   WHERE relname IN (
     'skill_definitions',
     'skill_versions',
     'skill_installations',
     'teammate_template_skill_bindings',
     'teammate_instance_skill_extensions',
     'run_skill_snapshots',
     'skill_audit_events'
   ) AND relkind = 'r';")"
FRESH_FLAG="$(psql_database "$EMPTY_DATABASE" \
  "SELECT flag_key || '=' || mode
   FROM feature_flag_settings
   WHERE flag_key = 'skills.platform';")"
FRESH_SNAPSHOTS="$(psql_database "$EMPTY_DATABASE" \
  "SELECT COUNT(*) FROM run_skill_snapshots;")"

[[ "$FRESH_VERSION" == "40" ]]
[[ "$FRESH_TABLES" == "7" ]]
[[ "$FRESH_FLAG" == "skills.platform=off" ]]
[[ "$FRESH_SNAPSHOTS" == "0" ]]

DATABASE_URL="$UPGRADE_URL" MIGRATION_TARGET_VERSION=39 \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null
psql_database "$UPGRADE_DATABASE" "
INSERT INTO projects (
  id, name, code, description, status, created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000004000',
  'M4 migration snapshot',
  'M4-MIG-40',
  '',
  'active',
  NOW(),
  NOW()
);
INSERT INTO principals (
  id, kind, display_name, status, status_authority, source,
  version, created_at, updated_at
) VALUES (
  'local-admin',
  'human',
  'Local Admin',
  'active',
  'account',
  'local',
  1,
  NOW(),
  NOW()
);
INSERT INTO tasks (
  id, project_id, title, description, acceptance, status, agent_id,
  priority, auto_submit, auto_accept, auto_redispatch_on_return,
  created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000004001',
  '00000000-0000-4000-8000-000000004000',
  'Legacy run task',
  'Historical task before M4',
  '[]'::jsonb,
  'queued',
  '00000000-0000-4000-8000-000000000001',
  'medium',
  TRUE,
  FALSE,
  FALSE,
  NOW(),
  NOW()
);
INSERT INTO runs (
  id, project_id, task_id, agent_id, status, input_snapshot,
  observability, created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000004002',
  '00000000-0000-4000-8000-000000004000',
  '00000000-0000-4000-8000-000000004001',
  '00000000-0000-4000-8000-000000000001',
  'completed',
  '{}'::jsonb,
  '{}'::jsonb,
  NOW(),
  NOW()
);
INSERT INTO teammate_templates (
  id, project_id, workspace_id, scope, owner_principal_id, status,
  current_version, definition, created_by, created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000004003',
  '00000000-0000-4000-8000-000000004000',
  '00000000-0000-4000-8000-000000004000',
  'personal',
  'local-admin',
  'active',
  1,
  '{\"name\":\"Legacy Skill Template\",\"role\":\"\",\"description\":\"\",\"soul\":\"\",\"scenarios\":[],\"goals\":[],\"tools\":[]}'::jsonb,
  'local-admin',
  NOW(),
  NOW()
);
INSERT INTO teammate_template_versions (
  id, template_id, project_id, version, definition, content_digest,
  created_by, created_at
) VALUES (
  '00000000-0000-4000-8000-000000004004',
  '00000000-0000-4000-8000-000000004003',
  '00000000-0000-4000-8000-000000004000',
  1,
  '{\"name\":\"Legacy Skill Template\",\"role\":\"\",\"description\":\"\",\"soul\":\"\",\"scenarios\":[],\"goals\":[],\"tools\":[]}'::jsonb,
  repeat('a', 64),
  'local-admin',
  NOW()
);"

DATABASE_URL="$UPGRADE_URL" \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null

UPGRADE_VERSION="$(psql_database "$UPGRADE_DATABASE" \
  "SELECT MAX(version) FROM platform_migrations;")"
HISTORICAL_SNAPSHOTS="$(psql_database "$UPGRADE_DATABASE" \
  "SELECT COUNT(*) FROM run_skill_snapshots
   WHERE run_id = '00000000-0000-4000-8000-000000004002';")"
LEGACY_READ="$(psql_database "$UPGRADE_DATABASE" \
  "SELECT status || '|' || input_snapshot::text
   FROM runs
   WHERE id = '00000000-0000-4000-8000-000000004002';")"
LEGACY_TEMPLATE="$(psql_database "$UPGRADE_DATABASE" \
  "SELECT status || '|' || current_version
   FROM teammate_templates
   WHERE id = '00000000-0000-4000-8000-000000004003';")"
CONSTRAINT_CONFLICTS="$(psql_database "$UPGRADE_DATABASE" \
  "SELECT (
     (SELECT COUNT(*) FROM (
        SELECT key FROM skill_definitions GROUP BY key HAVING COUNT(*) > 1
      ) AS duplicate_skill_key)
     +
     (SELECT COUNT(*) FROM (
        SELECT principal_id, skill_id FROM skill_installations
        GROUP BY principal_id, skill_id HAVING COUNT(*) > 1
      ) AS duplicate_installation)
     +
     (SELECT COUNT(*) FROM (
        SELECT template_id, skill_id FROM teammate_template_skill_bindings
        GROUP BY template_id, skill_id HAVING COUNT(*) > 1
      ) AS duplicate_binding)
   );")"

[[ "$UPGRADE_VERSION" == "40" ]]
[[ "$HISTORICAL_SNAPSHOTS" == "0" ]]
[[ "$LEGACY_READ" == "completed|{}" ]]
[[ "$LEGACY_TEMPLATE" == "active|1" ]]
[[ "$CONSTRAINT_CONFLICTS" == "0" ]]

printf 'm4_migration_vitest=ok\n'
printf 'fresh_migration=0->40\n'
printf 'upgrade_migration=39->40\n'
printf 'skills_flag=off\n'
printf 'historical_run_snapshots=%s\n' "$HISTORICAL_SNAPSHOTS"
printf 'legacy_read=%s\n' "$LEGACY_READ"
