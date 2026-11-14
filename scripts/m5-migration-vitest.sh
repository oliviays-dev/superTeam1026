#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COMPOSE_PROJECT="${M5_MIGRATION_COMPOSE_PROJECT:-pluginmax-m5-migration}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.core-regression.yml}"
PORT="${M5_MIGRATION_POSTGRES_PORT:-54450}"
export CORE_REGRESSION_POSTGRES_PORT="$PORT"
DATABASE_URL_INPUT="${DATABASE_URL:-postgres://pluginmax:pluginmax@127.0.0.1:${PORT}/pluginmax}"
STAMP="$(date -u +%Y%m%d%H%M%S)"
EMPTY_DATABASE="pluginmax_m5_empty_${STAMP}"
UPGRADE_DATABASE="pluginmax_m5_upgrade_${STAMP}"
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
  if [[ "${M5_MIGRATION_KEEP_ENV:-0}" != "1" ]]; then
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
  "SELECT COUNT(*)
   FROM pg_class
   WHERE relname IN (
     'scene_participant_bindings',
     'context_policy_heads',
     'context_policy_versions',
     'scene_context_commit_receipts',
     'task_capture_sessions',
     'task_capture_candidates',
     'task_draft_batches',
     'task_drafts',
     'task_draft_conversions'
   )
     AND relkind = 'r';")"
FRESH_FLAGS="$(psql_database "$EMPTY_DATABASE" \
  "SELECT string_agg(flag_key || '=' || mode, ',' ORDER BY flag_key)
   FROM feature_flag_settings
   WHERE flag_key IN ('task.capture', 'context.group_policy');")"
FRESH_POLICIES="$(psql_database "$EMPTY_DATABASE" \
  "SELECT COUNT(*) FROM context_policy_heads
   WHERE scope_type = 'platform' AND scope_id = 'platform';")"

[[ "$FRESH_VERSION" == "41" ]]
[[ "$FRESH_TABLES" == "9" ]]
[[ "$FRESH_FLAGS" == "context.group_policy=off,task.capture=off" ]]
[[ "$FRESH_POLICIES" == "4" ]]

DATABASE_URL="$UPGRADE_URL" MIGRATION_TARGET_VERSION=40 \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null
psql_database "$UPGRADE_DATABASE" "
INSERT INTO projects (
  id, name, code, description, status, created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000005000',
  'M5 migration snapshot',
  'M5-MIG-41',
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
  '00000000-0000-4000-8000-000000005001',
  '00000000-0000-4000-8000-000000005000',
  'Legacy task before M5',
  'Snapshot task',
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
  '00000000-0000-4000-8000-000000005002',
  '00000000-0000-4000-8000-000000005000',
  '00000000-0000-4000-8000-000000005001',
  '00000000-0000-4000-8000-000000000001',
  'completed',
  '{}'::jsonb,
  '{}'::jsonb,
  NOW(),
  NOW()
);
INSERT INTO context_packs (
  id, run_id, project_id, task_id, agent_id, pack, receipt,
  content_hash, created_at
) VALUES (
  '00000000-0000-4000-8000-000000005003',
  '00000000-0000-4000-8000-000000005002',
  '00000000-0000-4000-8000-000000005000',
  '00000000-0000-4000-8000-000000005001',
  '00000000-0000-4000-8000-000000000001',
  '{\"id\":\"00000000-0000-4000-8000-000000005003\"}'::jsonb,
  '{\"contextPackId\":\"00000000-0000-4000-8000-000000005003\"}'::jsonb,
  'legacy-context-hash',
  NOW()
);
INSERT INTO meetings (
  id, project_id, title, agenda, status, participants, summary,
  created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000005004',
  '00000000-0000-4000-8000-000000005000',
  'Legacy meeting',
  '',
  'open',
  '[{\"id\":\"local-admin\",\"name\":\"Local Admin\",\"kind\":\"human\"}]'::jsonb,
  '',
  NOW(),
  NOW()
);
INSERT INTO meeting_messages (
  id, meeting_id, author_type, author_id, author_name, content, created_at
) VALUES (
  '00000000-0000-4000-8000-000000005005',
  '00000000-0000-4000-8000-000000005004',
  'human',
  'local-admin',
  'Local Admin',
  'Legacy message before M5',
  NOW()
);"

DATABASE_URL="$UPGRADE_URL" \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null

UPGRADE_VERSION="$(psql_database "$UPGRADE_DATABASE" \
  "SELECT MAX(version) FROM platform_migrations;")"
LEGACY_TASK="$(psql_database "$UPGRADE_DATABASE" \
  "SELECT title || '|' || status
   FROM tasks
   WHERE id = '00000000-0000-4000-8000-000000005001';")"
LEGACY_PACK="$(psql_database "$UPGRADE_DATABASE" \
  "SELECT context_boundary_seq || '|' || context_policy_version || '|' ||
          context_usage_ratio
   FROM context_packs
   WHERE id = '00000000-0000-4000-8000-000000005003';")"
LEGACY_MESSAGE="$(psql_database "$UPGRADE_DATABASE" \
  "SELECT sequence || '|' || trigger_depth
   FROM meeting_messages
   WHERE id = '00000000-0000-4000-8000-000000005005';")"
psql_database "$UPGRADE_DATABASE" "
INSERT INTO meeting_messages (
  id, meeting_id, author_type, author_id, author_name, content, created_at
) VALUES (
  '00000000-0000-4000-8000-000000005006',
  '00000000-0000-4000-8000-000000005004',
  'human',
  'local-admin',
  'Local Admin',
  'Old application write after M5',
  NOW()
);" >/dev/null
OLD_APP_WRITE="$(psql_database "$UPGRADE_DATABASE" \
  "SELECT sequence || '|' || trigger_depth
   FROM meeting_messages
   WHERE id = '00000000-0000-4000-8000-000000005006';")"
CONSTRAINT_CONFLICTS="$(psql_database "$UPGRADE_DATABASE" \
  "SELECT (
     (SELECT COUNT(*) FROM (
       SELECT scene_type, scene_id, agent_id, principal_id
       FROM scene_participant_bindings
       GROUP BY scene_type, scene_id, agent_id, principal_id
       HAVING COUNT(*) > 1
     ) AS duplicate_binding)
     +
     (SELECT COUNT(*) FROM (
       SELECT scope_type, scope_id, scene_type, revision
       FROM context_policy_versions
       GROUP BY scope_type, scope_id, scene_type, revision
       HAVING COUNT(*) > 1
     ) AS duplicate_policy)
   );")"

[[ "$UPGRADE_VERSION" == "41" ]]
[[ "$LEGACY_TASK" == "Legacy task before M5|queued" ]]
[[ "$LEGACY_PACK" == "0|0|0.000000" ]]
[[ "$LEGACY_MESSAGE" == "1|0" ]]
[[ "$OLD_APP_WRITE" == "2|0" ]]
[[ "$CONSTRAINT_CONFLICTS" == "0" ]]

printf 'm5_migration_vitest=ok\n'
printf 'fresh_migration=0->41\n'
printf 'upgrade_migration=40->41\n'
printf 'flags=%s\n' "$FRESH_FLAGS"
printf 'context_policy_platform_versions=%s\n' "$FRESH_POLICIES"
printf 'legacy_read=%s\n' "$LEGACY_TASK"
printf 'old_app_write=%s\n' "$OLD_APP_WRITE"
