#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COMPOSE_PROJECT="${M7_MIGRATION_COMPOSE_PROJECT:-pluginmax-m7-migration}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.core-regression.yml}"
PORT="${M7_MIGRATION_POSTGRES_PORT:-54455}"
export CORE_REGRESSION_POSTGRES_PORT="$PORT"
DATABASE_URL_INPUT="${DATABASE_URL:-postgres://pluginmax:pluginmax@127.0.0.1:${PORT}/pluginmax}"
STAMP="$(date -u +%Y%m%d%H%M%S)"
EMPTY_DATABASE="pluginmax_m7_empty_${STAMP}"
UPGRADE_DATABASE="pluginmax_m7_upgrade_${STAMP}"
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
  if [[ "${M7_MIGRATION_KEEP_ENV:-0}" != "1" ]]; then
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
FRESH_FLAG="$(psql_database "$EMPTY_DATABASE" \
  "SELECT flag_key || '=' || mode
   FROM feature_flag_settings
   WHERE flag_key = 'data_fabric';")"
FRESH_TABLES="$(psql_database "$EMPTY_DATABASE" \
  "SELECT COUNT(*) FROM unnest(ARRAY[
     'data_connections',
     'datasets',
     'dataset_columns',
     'semantic_metrics',
     'semantic_metric_versions',
     'data_policies',
     'data_policy_versions',
     'query_runs',
     'query_results',
     'data_agent_conversations',
     'data_agent_messages',
     'data_agent_context_refs',
     'data_agent_answers'
   ]) AS expected(name)
   WHERE to_regclass('public.' || expected.name) IS NOT NULL;")"
FRESH_IMMUTABLE="$(psql_database "$EMPTY_DATABASE" \
  "SELECT COUNT(*) FROM pg_trigger
   WHERE NOT tgisinternal
     AND tgname IN (
       'semantic_metric_versions_immutable',
       'data_policy_versions_immutable',
       'query_results_immutable',
       'data_agent_messages_immutable',
       'data_agent_context_refs_immutable',
       'data_agent_answers_immutable',
       'query_runs_guard_transition'
     );")"

[[ "$FRESH_VERSION" == "43" ]]
[[ "$FRESH_FLAG" == "data_fabric=off" ]]
[[ "$FRESH_TABLES" == "13" ]]
[[ "$FRESH_IMMUTABLE" == "7" ]]

DATABASE_URL="$UPGRADE_URL" MIGRATION_TARGET_VERSION=42 \
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
  '00000000-0000-4000-8000-000000007000',
  'M7 migration snapshot',
  'M7-MIG-43',
  '',
  'active',
  NOW(),
  NOW()
);
INSERT INTO tasks (
  id, project_id, title, description, acceptance, status, agent_id,
  created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000007001',
  '00000000-0000-4000-8000-000000007000',
  'M7 snapshot task',
  'preserve before migration 43',
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
  '00000000-0000-4000-8000-000000007002',
  '00000000-0000-4000-8000-000000007000',
  '00000000-0000-4000-8000-000000007001',
  '00000000-0000-4000-8000-000000000001',
  'completed',
  '{}'::jsonb,
  '{}'::jsonb,
  1,
  NOW(),
  NOW()
);
INSERT INTO project_reports (
  id, project_id, report_date, version, content_hash, snapshot,
  generated_by, generated_at
) VALUES (
  '00000000-0000-4000-8000-000000007003',
  '00000000-0000-4000-8000-000000007000',
  '2026-11-12',
  1,
  repeat('a', 64),
  '{
    \"projectName\":\"M7 migration snapshot\",
    \"projectCode\":\"M7-MIG-43\",
    \"periodStart\":\"2026-11-11T16:00:00.000Z\",
    \"periodEnd\":\"2026-11-12T16:00:00.000Z\",
    \"counts\":{
      \"tasks\":1,\"runs\":1,\"reviews\":0,\"workflows\":0,
      \"meetings\":0,\"actionItems\":0,\"memory\":0
    },
    \"items\":[]
  }'::jsonb,
  'local-admin',
  '2026-11-12T17:00:00.000Z'
);"

DATABASE_URL="$UPGRADE_URL" \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null

UPGRADE_VERSION="$(psql_database "$UPGRADE_DATABASE" \
  "SELECT MAX(version) FROM platform_migrations;")"
LEGACY_READ="$(psql_database "$UPGRADE_DATABASE" \
  "SELECT report_date || '|' || version || '|' ||
          (SELECT title FROM tasks
           WHERE id = '00000000-0000-4000-8000-000000007001') || '|' ||
          (SELECT status FROM runs
           WHERE id = '00000000-0000-4000-8000-000000007002')
   FROM project_reports
   WHERE id = '00000000-0000-4000-8000-000000007003';")"
psql_database "$UPGRADE_DATABASE" \
  "INSERT INTO run_events (
     id, run_id, seq, type, visibility, summary, data, created_at
   ) VALUES (
     '00000000-0000-4000-8000-000000007004',
     '00000000-0000-4000-8000-000000007002',
     1, 'progress.summary', 'user', 'legacy app write',
     '{}'::jsonb, NOW()
   );" >/dev/null
OLD_APP_WRITE="$(psql_database "$UPGRADE_DATABASE" \
  "SELECT summary FROM run_events
   WHERE id = '00000000-0000-4000-8000-000000007004';")"
CONFLICT_COUNT="$(psql_database "$UPGRADE_DATABASE" \
  "SELECT COUNT(*) FROM (
     SELECT metric_id, version FROM semantic_metric_versions
     GROUP BY metric_id, version HAVING COUNT(*) > 1
     UNION ALL
     SELECT policy_id, version FROM data_policy_versions
     GROUP BY policy_id, version HAVING COUNT(*) > 1
   ) AS conflicts;")"

[[ "$UPGRADE_VERSION" == "43" ]]
[[ "$LEGACY_READ" == "2026-11-12|1|M7 snapshot task|completed" ]]
[[ "$OLD_APP_WRITE" == "legacy app write" ]]
[[ "$CONFLICT_COUNT" == "0" ]]

printf 'm7_migration_vitest=ok\n'
printf 'fresh_migration=0->43\n'
printf 'upgrade_migration=42->43\n'
printf 'flag=%s\n' "$FRESH_FLAG"
printf 'tables=%s\n' "$FRESH_TABLES"
printf 'immutable_triggers=%s\n' "$FRESH_IMMUTABLE"
printf 'old_app_read=%s\n' "$LEGACY_READ"
printf 'old_app_write=%s\n' "$OLD_APP_WRITE"
printf 'constraint_conflicts=%s\n' "$CONFLICT_COUNT"
