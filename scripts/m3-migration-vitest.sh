#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COMPOSE_PROJECT="${M3_MIGRATION_COMPOSE_PROJECT:-pluginmax-m3-migration}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.core-regression.yml}"
PORT="${M3_MIGRATION_POSTGRES_PORT:-54446}"
export CORE_REGRESSION_POSTGRES_PORT="$PORT"
DATABASE_URL_INPUT="${DATABASE_URL:-postgres://pluginmax:pluginmax@127.0.0.1:${PORT}/pluginmax}"
STAMP="$(date -u +%Y%m%d%H%M%S)"
EMPTY_DATABASE="pluginmax_m3_empty_${STAMP}"
UPGRADE_DATABASE="pluginmax_m3_upgrade_${STAMP}"
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
  if [[ "${M3_MIGRATION_KEEP_ENV:-0}" != "1" ]]; then
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
     'workflow_plans',
     'workflow_plan_versions',
     'plan_materializations',
     'task_origins',
     'router_agents',
     'workflow_feature_gate_epochs',
     'workflow_plan_outbox_messages',
     'workflow_plan_audit_events'
   ) AND relkind = 'r';")"
FRESH_FLAG="$(psql_database "$EMPTY_DATABASE" \
  "SELECT flag_key || '=' || mode
   FROM feature_flag_settings
   WHERE flag_key = 'workflow.router_worker';")"
PROTECTED_COLUMN="$(psql_database "$EMPTY_DATABASE" \
  "SELECT COUNT(*) FROM information_schema.columns
   WHERE table_name = 'teammate_templates'
     AND column_name = 'protected';")"

[[ "$FRESH_VERSION" == "40" ]]
[[ "$FRESH_TABLES" == "8" ]]
[[ "$FRESH_FLAG" == "workflow.router_worker=off" ]]
[[ "$PROTECTED_COLUMN" == "1" ]]

DATABASE_URL="$UPGRADE_URL" MIGRATION_TARGET_VERSION=38 \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null
psql_database "$UPGRADE_DATABASE" "
INSERT INTO projects (
  id, name, code, description, status, created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000003900',
  'M3 migration snapshot',
  'M3-MIG-39',
  '',
  'active',
  NOW(),
  NOW()
);
INSERT INTO workflow_definitions (
  id, project_id, name, description, steps, source_md, graph, status,
  created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000003901',
  '00000000-0000-4000-8000-000000003900',
  'Legacy workflow',
  'Legacy workflow before M3',
  '[]'::jsonb,
  '',
  '{\"key\":\"legacy-m3\",\"version\":1,\"name\":\"Legacy\",\"description\":\"Legacy m3\",\"nodes\":[],\"edges\":[],\"startNodeIds\":[],\"warnings\":[]}'::jsonb,
  'active',
  NOW(),
  NOW()
);
INSERT INTO workflow_instances (
  id, workflow_id, project_id, title, status, current_step, steps,
  created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000003902',
  '00000000-0000-4000-8000-000000003901',
  '00000000-0000-4000-8000-000000003900',
  'Legacy instance',
  'active',
  0,
  '[]'::jsonb,
  NOW(),
  NOW()
);
INSERT INTO tasks (
  id, project_id, title, description, acceptance, status, agent_id,
  priority, auto_submit, auto_accept, auto_redispatch_on_return,
  created_at, updated_at
)
SELECT
  '00000000-0000-4000-8000-000000003903',
  '00000000-0000-4000-8000-000000003900',
  'Legacy task',
  'Legacy task before M3',
  '[\"legacy accepted\"]'::jsonb,
  'queued',
  id,
  'medium',
  TRUE,
  FALSE,
  FALSE,
  NOW(),
  NOW()
FROM agents
WHERE status = 'active'
ORDER BY created_at, id
LIMIT 1;"

DATABASE_URL="$UPGRADE_URL" \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null

UPGRADE_VERSION="$(psql_database "$UPGRADE_DATABASE" \
  "SELECT MAX(version) FROM platform_migrations;")"
LEGACY_READ="$(psql_database "$UPGRADE_DATABASE" \
  "SELECT definition.scope || '|' || definition.origin || '|' ||
          (definition.plan_id IS NULL)::text
   FROM workflow_definitions AS definition
   WHERE definition.id = '00000000-0000-4000-8000-000000003901';")"
TASK_COMPAT="$(psql_database "$UPGRADE_DATABASE" \
  "SELECT (creation_key IS NULL)::text || '|' || status
   FROM tasks
   WHERE id = '00000000-0000-4000-8000-000000003903';")"
PLAN_COLUMNS="$(psql_database "$UPGRADE_DATABASE" \
  "SELECT COUNT(*) FROM information_schema.columns
   WHERE table_name IN ('workflow_definitions', 'workflow_instances')
     AND column_name IN ('plan_id', 'plan_version');")"

[[ "$UPGRADE_VERSION" == "40" ]]
[[ "$LEGACY_READ" == "project|template|t" ]]
[[ "$TASK_COMPAT" == "t|queued" ]]
[[ "$PLAN_COLUMNS" == "4" ]]

printf 'm3_migration_vitest=ok\n'
printf 'fresh_migration=0->40\n'
printf 'upgrade_migration=38->40\n'
printf 'router_flag=off\n'
printf 'legacy_read=%s\n' "$LEGACY_READ"
printf 'legacy_task=%s\n' "$TASK_COMPAT"
