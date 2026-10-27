#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COMPOSE_PROJECT="${COMPOSE_PROJECT:-pluginmax-batch16-db}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.batch16.yml}"
DATABASE_URL_INPUT="${DATABASE_URL:-postgres://pluginmax:pluginmax@127.0.0.1:54428/pluginmax}"
STAMP="$(date -u +%Y%m%d%H%M%S)"
FRESH_DATABASE="pluginmax_batch16_fresh_$STAMP"
UPGRADE_DATABASE="pluginmax_batch16_upgrade_$STAMP"
FRESH_URL="${DATABASE_URL_INPUT%/*}/$FRESH_DATABASE"
UPGRADE_URL="${DATABASE_URL_INPUT%/*}/$UPGRADE_DATABASE"
TMP_ROOT="$ROOT/.tmp/batch16-vitest"

compose() {
  "$ROOT/scripts/db-compose.sh" -p "$COMPOSE_PROJECT" -f "$ROOT/$COMPOSE_FILE" "$@"
}

psql_database() {
  local database="$1"
  local sql="$2"
  compose exec -T postgres psql -U pluginmax -d "$database" \
    -qAt -v ON_ERROR_STOP=1 -c "$sql"
}

cleanup() {
  psql_database postgres \
    "DROP DATABASE IF EXISTS $FRESH_DATABASE WITH (FORCE);" \
    >/dev/null 2>&1 || true
  psql_database postgres \
    "DROP DATABASE IF EXISTS $UPGRADE_DATABASE WITH (FORCE);" \
    >/dev/null 2>&1 || true
}
trap cleanup EXIT

compose up -d postgres >/dev/null
for _ in {1..80}; do
  if compose exec -T postgres pg_isready \
    -U pluginmax -d pluginmax >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
psql_database postgres "CREATE DATABASE $FRESH_DATABASE;"
psql_database postgres "CREATE DATABASE $UPGRADE_DATABASE;"

mkdir -p "$TMP_ROOT/dsh-home" "$TMP_ROOT/files" "$TMP_ROOT/workspaces"
export DSH_HOME="$TMP_ROOT/dsh-home"
export FILE_STORE_ROOT="$TMP_ROOT/files"
export AGENT_WORKSPACE_ROOT="$TMP_ROOT/workspaces"

DATABASE_URL="$UPGRADE_URL" MIGRATION_TARGET_VERSION=26 \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null
psql_database "$UPGRADE_DATABASE" \
  "INSERT INTO projects (id, name, code, description, status, created_at, updated_at)
   VALUES (
     '00000000-0000-4000-8000-000000000300',
     'Migration 26 Scene fixture',
     'MIG26-SCENE',
     '',
     'active',
     NOW(),
     NOW()
   );
   INSERT INTO tasks (
     id, project_id, title, description, acceptance, status, agent_id,
     created_at, updated_at
   ) VALUES (
     '00000000-0000-4000-8000-000000000301',
     '00000000-0000-4000-8000-000000000300',
     'Migration 26 task',
     'preserve before migration 27',
     '[]'::jsonb,
     'done',
     '00000000-0000-4000-8000-000000000001',
     NOW(),
     NOW()
   );
   INSERT INTO task_messages (
     id, task_id, author_type, author_id, author_name, content,
     reply_to_id, created_at
   ) VALUES (
     '00000000-0000-4000-8000-000000000303',
     '00000000-0000-4000-8000-000000000301',
     'human',
     'local-admin',
     'Local Admin',
     'legacy comment',
     NULL,
     NOW()
   );
   INSERT INTO runs (
     id, project_id, task_id, agent_id, status, input_snapshot,
     output, observability, attempt, created_at, updated_at
   ) VALUES (
     '00000000-0000-4000-8000-000000000302',
     '00000000-0000-4000-8000-000000000300',
     '00000000-0000-4000-8000-000000000301',
     '00000000-0000-4000-8000-000000000001',
     'completed',
     '{}'::jsonb,
     'migration-26-output',
     '{\"planVisibility\":\"structured\",\"toolEventCompleteness\":\"complete\",\"textStreaming\":\"delta\",\"subagentVisibility\":\"none\"}'::jsonb,
     1,
     NOW(),
     NOW()
   );
   INSERT INTO context_packs (
     id, run_id, project_id, task_id, agent_id, pack, receipt,
     content_hash, created_at
   ) VALUES (
     '00000000-0000-4000-8000-000000000304',
     '00000000-0000-4000-8000-000000000302',
     '00000000-0000-4000-8000-000000000300',
     '00000000-0000-4000-8000-000000000301',
     '00000000-0000-4000-8000-000000000001',
     '{\"id\":\"00000000-0000-4000-8000-000000000304\",\"runId\":\"00000000-0000-4000-8000-000000000302\"}'::jsonb,
     '{\"contextPackId\":\"00000000-0000-4000-8000-000000000304\"}'::jsonb,
     'legacy-context-hash',
     NOW()
   );"
DATABASE_URL="$UPGRADE_URL" \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null

upgrade_version="$(
  psql_database "$UPGRADE_DATABASE" \
    "SELECT MAX(version) FROM platform_migrations;"
)"
upgrade_tables="$(
  psql_database "$UPGRADE_DATABASE" \
    "SELECT COUNT(*)
     FROM (VALUES
       (to_regclass('public.scene_chat_channels')),
       (to_regclass('public.scene_sessions')),
       (to_regclass('public.scene_context_contributions')),
       (to_regclass('public.scene_context_receipts')),
       (to_regclass('public.scene_context_delivery_cursors'))
     ) AS table_name(value)
     WHERE value IS NOT NULL;"
)"
upgrade_pack="$(
  psql_database "$UPGRADE_DATABASE" \
    "SELECT pack->>'runId' || '|' || (scene_session_id IS NULL)::text
     FROM context_packs
     WHERE id = '00000000-0000-4000-8000-000000000304';"
)"
upgrade_consensus="$(
  psql_database "$UPGRADE_DATABASE" \
    "SELECT is_key_consensus
     FROM task_messages
     WHERE id = '00000000-0000-4000-8000-000000000303';"
)"
upgrade_sessions="$(
  psql_database "$UPGRADE_DATABASE" \
    "SELECT COUNT(*) FROM scene_sessions;"
)"
[[ "$upgrade_version" == "30" ]]
[[ "$upgrade_tables" == "5" ]]
[[ "$upgrade_pack" == "00000000-0000-4000-8000-000000000302|true" ]]
[[ "$upgrade_consensus" == "f" ]]
[[ "$upgrade_sessions" == "0" ]]

DATABASE_URL="$FRESH_URL" \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null
fresh_version="$(
  psql_database "$FRESH_DATABASE" \
    "SELECT MAX(version) FROM platform_migrations;"
)"
[[ "$fresh_version" == "30" ]]

TEST_DATABASE_URL="$FRESH_URL" CI=true \
  node_modules/.bin/vitest run \
    packages/context/src/index.test.ts \
    packages/database/src/scene-context-repository.test.ts \
    apps/api/src/scene-context.test.ts \
    apps/api/src/task-execution-policy.test.ts \
    apps/api/src/action-ticket-gate.test.ts \
    apps/api/src/meeting-ai-participation.test.ts \
    apps/api/src/ai-direct-chat.test.ts \
    apps/api/src/external-runtime-execution.test.ts \
    --no-file-parallelism

printf 'scene_context_vitest=ok\n'
printf 'fresh_migration=%s\n' "$fresh_version"
printf 'upgrade_migration=%s\n' "$upgrade_version"
printf 'scene_session_backfill=0\n'
