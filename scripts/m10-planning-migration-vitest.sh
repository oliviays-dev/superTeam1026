#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COMPOSE_PROJECT="${M10_MIGRATION_COMPOSE_PROJECT:-pluginmax-m10-migration}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.core-regression.yml}"
PORT="${M10_MIGRATION_POSTGRES_PORT:-54461}"
export CORE_REGRESSION_POSTGRES_PORT="$PORT"
DATABASE_URL_INPUT="${DATABASE_URL:-postgres://pluginmax:pluginmax@127.0.0.1:${PORT}/pluginmax}"
STAMP="$(date -u +%Y%m%d%H%M%S)"
EMPTY_DATABASE="pluginmax_m10_empty_${STAMP}"
UPGRADE_DATABASE="pluginmax_m10_upgrade_${STAMP}"
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
  if [[ "${M10_MIGRATION_KEEP_ENV:-0}" != "1" ]]; then
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

DATABASE_URL="$EMPTY_URL" MIGRATION_TARGET_VERSION=46 \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null

FRESH_VERSION="$(psql_database "$EMPTY_DATABASE" \
  "SELECT MAX(version) FROM platform_migrations;")"
FRESH_FLAGS="$(psql_database "$EMPTY_DATABASE" \
  "SELECT string_agg(flag_key || '=' || mode, ',' ORDER BY flag_key)
   FROM feature_flag_settings
   WHERE flag_key IN ('planning.manual', 'planning.autopilot');")"
FRESH_TABLES="$(psql_database "$EMPTY_DATABASE" \
  "SELECT COUNT(*) FROM unnest(ARRAY[
     'planning_policies',
     'planning_runs',
     'planning_trigger_receipts',
     'planning_artifacts',
     'planning_events',
     'planning_quality_metrics'
   ]) AS expected(name)
   WHERE to_regclass('public.' || expected.name) IS NOT NULL;")"
FRESH_COLUMN="$(psql_database "$EMPTY_DATABASE" \
  "SELECT COUNT(*) FROM information_schema.columns
   WHERE table_name = 'workflow_plans'
     AND column_name = 'planning_run_id';")"
FRESH_TRIGGERS="$(psql_database "$EMPTY_DATABASE" \
  "SELECT COUNT(*) FROM pg_trigger
   WHERE NOT tgisinternal
     AND tgname IN (
       'planning_runs_scope_guard',
       'planning_runs_transition_guard',
       'planning_trigger_receipts_immutable',
       'planning_artifacts_immutable',
       'planning_events_append_only',
       'planning_quality_metrics_immutable',
       'workflow_plan_versions_planning_source_guard',
       'workflow_plans_planning_source_guard',
       'workflow_plans_planning_legacy_guard'
     );")"
FRESH_POLICY="$(psql_database "$EMPTY_DATABASE" \
  "SELECT
     (config ->> 'requireHumanReview') || '|' ||
     (config ->> 'autoApprove')
   FROM planning_policies
   WHERE scope_type = 'platform' AND scope_id = 'platform';")"
DATABASE_URL="$EMPTY_URL" MIGRATION_TARGET_VERSION=46 \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null
IDEMPOTENT_VERSION="$(psql_database "$EMPTY_DATABASE" \
  "SELECT MAX(version) FROM platform_migrations;")"

[[ "$FRESH_VERSION" == "46" ]]
[[ "$FRESH_FLAGS" == "planning.autopilot=off,planning.manual=off" ]]
[[ "$FRESH_TABLES" == "6" ]]
[[ "$FRESH_COLUMN" == "1" ]]
[[ "$FRESH_TRIGGERS" == "9" ]]
[[ "$FRESH_POLICY" == "true|false" ]]
[[ "$IDEMPOTENT_VERSION" == "46" ]]

psql_database "$EMPTY_DATABASE" "
INSERT INTO principals (
  id, kind, display_name, status, status_authority, source,
  version, created_at, updated_at
) VALUES (
  'local-admin', 'human', 'Local Admin', 'active', 'system', 'local',
  1, NOW(), NOW()
)
ON CONFLICT (id) DO NOTHING;
INSERT INTO projects (
  id, name, code, description, status, created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000010000',
  'M10 migration snapshot',
  'M10-MIG-46',
  '',
  'active',
  NOW(),
  NOW()
);
INSERT INTO tasks (
  id, project_id, title, description, acceptance, status, agent_id,
  created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000010001',
  '00000000-0000-4000-8000-000000010000',
  'M10 planning root',
  'planning root fixture',
  '[]'::jsonb,
  'queued',
  '00000000-0000-4000-8000-000000000001',
  NOW(),
  NOW()
);
INSERT INTO planning_runs (
  id, project_id, root_task_id, status, revision, trigger_kind,
  root_task_revision, policy_revision, trigger_count,
  created_by_principal_id, created_at, updated_at, started_at
) VALUES (
  '00000000-0000-4000-8000-000000010010',
  '00000000-0000-4000-8000-000000010000',
  '00000000-0000-4000-8000-000000010001',
  'preparing',
  1,
  'human-manual',
  (SELECT revision FROM tasks
   WHERE id = '00000000-0000-4000-8000-000000010001'),
  1,
  1,
  'local-admin',
  NOW(),
  NOW(),
  NOW()
);"

if psql_database "$EMPTY_DATABASE" "
INSERT INTO planning_runs (
  id, project_id, root_task_id, status, revision, trigger_kind,
  root_task_revision, policy_revision, trigger_count,
  created_by_principal_id, created_at, updated_at, started_at
) VALUES (
  '00000000-0000-4000-8000-000000010011',
  '00000000-0000-4000-8000-000000010000',
  '00000000-0000-4000-8000-000000010001',
  'queued',
  1,
  'human-manual',
  (SELECT revision FROM tasks
   WHERE id = '00000000-0000-4000-8000-000000010001'),
  1,
  1,
  'local-admin',
  NOW(),
  NOW(),
  NOW()
);" >/dev/null 2>&1; then
  echo "second active planning run was accepted" >&2
  exit 1
fi
ACTIVE_UNIQUE="rejected"

if psql_database "$EMPTY_DATABASE" "
INSERT INTO workflow_plans (
  id, project_id, root_task_id, source, current_version, status, revision,
  created_by, created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000010020',
  '00000000-0000-4000-8000-000000010000',
  '00000000-0000-4000-8000-000000010001',
  'router',
  1,
  'proposed',
  1,
  'local-admin',
  NOW(),
  NOW()
);" >/dev/null 2>&1; then
  echo "router plan without planning run was accepted" >&2
  exit 1
fi
ROUTER_PROVENANCE="rejected"

psql_database "$EMPTY_DATABASE" "
UPDATE planning_runs
SET status = 'review_required',
    revision = revision + 1,
    blocked_reason = 'migration fixture review',
    updated_at = NOW()
WHERE id = '00000000-0000-4000-8000-000000010010';
INSERT INTO workflow_plans (
  id, project_id, root_task_id, source, planning_run_id, current_version,
  status, revision, created_by, created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000010040',
  '00000000-0000-4000-8000-000000010000',
  '00000000-0000-4000-8000-000000010001',
  'router',
  '00000000-0000-4000-8000-000000010010',
  1,
  'proposed',
  1,
  'local-admin',
  NOW(),
  NOW()
);
INSERT INTO workflow_plan_versions (
  id, plan_id, version, graph, settings, source, reason, content_digest,
  created_by, created_at
) VALUES (
  '00000000-0000-4000-8000-000000010041',
  '00000000-0000-4000-8000-000000010040',
  1,
  '{\"key\":\"migration-plan\",\"version\":1,\"name\":\"Migration plan\",\"description\":\"\",\"nodes\":[],\"edges\":[],\"startNodeIds\":[],\"warnings\":[]}'::jsonb,
  '{\"maxNodes\":100,\"maxDepth\":32,\"maxOutDegree\":20,\"maxConcurrency\":8}'::jsonb,
  'router',
  'planning provenance fixture',
  repeat('f', 64),
  'local-admin',
  NOW()
);
UPDATE planning_runs
SET status = 'succeeded',
    workflow_plan_id = '00000000-0000-4000-8000-000000010040',
    revision = revision + 1,
    terminal_at = NOW(),
    updated_at = NOW()
WHERE id = '00000000-0000-4000-8000-000000010010';"

DATABASE_URL="$UPGRADE_URL" MIGRATION_TARGET_VERSION=45 \
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
  '00000000-0000-4000-8000-000000011000',
  'M10 upgrade snapshot',
  'M10-UPG-46',
  '',
  'active',
  NOW(),
  NOW()
);
INSERT INTO tasks (
  id, project_id, title, description, acceptance, status, agent_id,
  created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000011001',
  '00000000-0000-4000-8000-000000011000',
  'Legacy manual plan task',
  'preserve across migration 46',
  '[]'::jsonb,
  'queued',
  '00000000-0000-4000-8000-000000000001',
  NOW(),
  NOW()
);
INSERT INTO teammate_templates (
  id, project_id, workspace_id, scope, owner_principal_id, status,
  current_version, definition, created_by, created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000011020',
  '00000000-0000-4000-8000-000000011000',
  'm10-workspace',
  'platform',
  NULL,
  'active',
  1,
  '{\"name\":\"M10 Legacy Router\",\"role\":\"\",\"description\":\"\",\"soul\":\"\",\"scenarios\":[],\"goals\":[],\"tools\":[]}'::jsonb,
  'local-admin',
  NOW(),
  NOW()
);
INSERT INTO teammate_template_versions (
  id, template_id, project_id, version, definition, content_digest,
  created_by, created_at
) VALUES (
  '00000000-0000-4000-8000-000000011021',
  '00000000-0000-4000-8000-000000011020',
  '00000000-0000-4000-8000-000000011000',
  1,
  '{\"name\":\"M10 Legacy Router\",\"role\":\"\",\"description\":\"\",\"soul\":\"\",\"scenarios\":[],\"goals\":[],\"tools\":[]}'::jsonb,
  repeat('d', 64),
  'local-admin',
  NOW()
);
INSERT INTO teammates (
  id, project_id, workspace_id, template_id, template_version_id,
  template_version, agent_id, ai_principal_id, owner_principal_id, name,
  status, version, auto_execute, created_by, created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000011022',
  '00000000-0000-4000-8000-000000011000',
  'm10-workspace',
  '00000000-0000-4000-8000-000000011020',
  '00000000-0000-4000-8000-000000011021',
  1,
  '00000000-0000-4000-8000-000000000001',
  'local-admin',
  'local-admin',
  'M10 Legacy Router',
  'active',
  1,
  FALSE,
  'local-admin',
  NOW(),
  NOW()
);
INSERT INTO router_agents (
  id, project_id, teammate_id, agent_id, ai_principal_id, template_id,
  template_version_id, template_version, contract_tools, contract_digest,
  status, created_by, created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000011023',
  '00000000-0000-4000-8000-000000011000',
  '00000000-0000-4000-8000-000000011022',
  '00000000-0000-4000-8000-000000000001',
  'local-admin',
  '00000000-0000-4000-8000-000000011020',
  '00000000-0000-4000-8000-000000011021',
  1,
  '[\"router_worker_submit_plan\",\"router_worker_submit_final_draft\"]'::jsonb,
  repeat('e', 64),
  'active',
  'local-admin',
  NOW(),
  NOW()
);
INSERT INTO workflow_plans (
  id, project_id, root_task_id, source, current_version, status, revision,
  created_by, created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000011010',
  '00000000-0000-4000-8000-000000011000',
  '00000000-0000-4000-8000-000000011001',
  'manual',
  1,
  'proposed',
  1,
  'local-admin',
  NOW(),
  NOW()
);
INSERT INTO workflow_plans (
  id, project_id, root_task_id, source, current_version, status, revision,
  router_agent_id, created_by, created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000011030',
  '00000000-0000-4000-8000-000000011000',
  '00000000-0000-4000-8000-000000011001',
  'router',
  1,
  'proposed',
  1,
  '00000000-0000-4000-8000-000000011023',
  'local-admin',
  NOW(),
  NOW()
);"

DATABASE_URL="$UPGRADE_URL" MIGRATION_TARGET_VERSION=46 \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null

UPGRADE_VERSION="$(psql_database "$UPGRADE_DATABASE" \
  "SELECT MAX(version) FROM platform_migrations;")"
LEGACY_READ="$(psql_database "$UPGRADE_DATABASE" \
  "SELECT string_agg(
     plan.source || ':' ||
     (plan.planning_run_id IS NULL)::text || ':' ||
     plan.planning_source_legacy_unverified::text,
     ',' ORDER BY plan.source
   )
   FROM tasks AS task
   JOIN workflow_plans AS plan ON plan.root_task_id = task.id
   WHERE plan.id IN (
     '00000000-0000-4000-8000-000000011010',
     '00000000-0000-4000-8000-000000011030'
   );")"
LEGACY_PLANNING_ROWS="$(psql_database "$UPGRADE_DATABASE" \
  "SELECT COUNT(*) FROM planning_runs;")"
psql_database "$UPGRADE_DATABASE" "
INSERT INTO tasks (
  id, project_id, title, description, acceptance, status, agent_id,
  created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000011002',
  '00000000-0000-4000-8000-000000011000',
  'Legacy app write after M10',
  'N-1 compatibility',
  '[]'::jsonb,
  'queued',
  '00000000-0000-4000-8000-000000000001',
  NOW(),
  NOW()
);
INSERT INTO workflow_plans (
  id, project_id, root_task_id, source, current_version, status, revision,
  created_by, created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000011011',
  '00000000-0000-4000-8000-000000011000',
  '00000000-0000-4000-8000-000000011002',
  'manual',
  1,
  'proposed',
  1,
  'local-admin',
  NOW(),
  NOW()
);"
OLD_APP_WRITE="$(psql_database "$UPGRADE_DATABASE" \
  "SELECT task.title || '|' || plan.source
   FROM tasks AS task
   JOIN workflow_plans AS plan ON plan.root_task_id = task.id
   WHERE task.id = '00000000-0000-4000-8000-000000011002';")"

if psql_database "$UPGRADE_DATABASE" "
INSERT INTO workflow_plans (
  id, project_id, root_task_id, source, current_version, status, revision,
  router_agent_id, created_by, created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000011031',
  '00000000-0000-4000-8000-000000011000',
  '00000000-0000-4000-8000-000000011002',
  'router',
  1,
  'proposed',
  1,
  '00000000-0000-4000-8000-000000011023',
  'local-admin',
  NOW(),
  NOW()
);" >/dev/null 2>&1; then
  echo "new router plan without planning run was accepted after migration" >&2
  exit 1
fi
NEW_ROUTER_REJECTED="rejected"
PLANNING_PROVENANCE="$(psql_database "$EMPTY_DATABASE" \
  "SELECT COUNT(*)
   FROM planning_runs AS run
   JOIN workflow_plans AS plan ON plan.id = run.workflow_plan_id
   JOIN workflow_plan_versions AS version ON version.plan_id = plan.id
   WHERE run.id = '00000000-0000-4000-8000-000000010010'
     AND plan.source = 'router'
     AND plan.planning_run_id = run.id
     AND plan.router_agent_id IS NULL
     AND version.router_agent_id IS NULL;")"

[[ "$UPGRADE_VERSION" == "46" ]]
[[ "$LEGACY_READ" == "manual:true:false,router:true:true" ]]
[[ "$LEGACY_PLANNING_ROWS" == "0" ]]
[[ "$OLD_APP_WRITE" == "Legacy app write after M10|manual" ]]
[[ "$PLANNING_PROVENANCE" == "1" ]]

printf 'm10_migration_vitest=ok\n'
printf 'fresh_migration=0->46\n'
printf 'upgrade_migration=45->46\n'
printf 'idempotent_migration=46->46\n'
printf 'flags=%s\n' "$FRESH_FLAGS"
printf 'tables=%s\n' "$FRESH_TABLES"
printf 'triggers=%s\n' "$FRESH_TRIGGERS"
printf 'policy=%s\n' "$FRESH_POLICY"
printf 'idempotent_version=%s\n' "$IDEMPOTENT_VERSION"
printf 'active_run_unique=%s\n' "$ACTIVE_UNIQUE"
printf 'router_provenance=%s\n' "$ROUTER_PROVENANCE"
printf 'planning_provenance=%s\n' "$PLANNING_PROVENANCE"
printf 'legacy_read=%s\n' "$LEGACY_READ"
printf 'legacy_planning_rows=%s\n' "$LEGACY_PLANNING_ROWS"
printf 'old_app_write=%s\n' "$OLD_APP_WRITE"
printf 'new_router_rejected=%s\n' "$NEW_ROUTER_REJECTED"
