#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COMPOSE_PROJECT="${COMPOSE_PROJECT:-pluginmax-batch17a-db}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.batch17a.yml}"
DATABASE_URL_INPUT="${DATABASE_URL:-postgres://pluginmax:pluginmax@127.0.0.1:54429/pluginmax}"
STAMP="$(date -u +%Y%m%d%H%M%S)"
FRESH_DATABASE="pluginmax_batch17a_fresh_$STAMP"
UPGRADE_DATABASE="pluginmax_batch17a_upgrade_$STAMP"
FRESH_URL="${DATABASE_URL_INPUT%/*}/$FRESH_DATABASE"
UPGRADE_URL="${DATABASE_URL_INPUT%/*}/$UPGRADE_DATABASE"
TMP_ROOT="$ROOT/.tmp/batch17a-vitest"

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

DATABASE_URL="$UPGRADE_URL" MIGRATION_TARGET_VERSION=27 \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null
psql_database "$UPGRADE_DATABASE" \
  "INSERT INTO projects (id, name, code, description, status, created_at, updated_at)
   VALUES (
     '00000000-0000-4000-8000-000000000500',
     'Migration 27 Batch 17A fixture',
     'MIG27-BATCH17A',
     '',
     'active',
     NOW(),
     NOW()
   );
   INSERT INTO tasks (
     id, project_id, title, description, acceptance, status, agent_id,
     created_at, updated_at
   ) VALUES (
     '00000000-0000-4000-8000-000000000501',
     '00000000-0000-4000-8000-000000000500',
     'Migration 27 task',
     'preserve before migration 28',
     '[]'::jsonb,
     'done',
     '00000000-0000-4000-8000-000000000001',
     NOW(),
     NOW()
   );
   INSERT INTO runs (
     id, project_id, task_id, agent_id, status, input_snapshot,
     output, observability, attempt, created_at, updated_at
   ) VALUES (
     '00000000-0000-4000-8000-000000000502',
     '00000000-0000-4000-8000-000000000500',
     '00000000-0000-4000-8000-000000000501',
     '00000000-0000-4000-8000-000000000001',
     'completed',
     '{}'::jsonb,
     'migration-27-output',
     '{\"planVisibility\":\"structured\",\"toolEventCompleteness\":\"complete\",\"textStreaming\":\"delta\",\"subagentVisibility\":\"none\"}'::jsonb,
     1,
     NOW(),
     NOW()
   );
   INSERT INTO task_messages (
     id, task_id, author_type, author_id, author_name, content,
     reply_to_id, created_at
   ) VALUES (
     '00000000-0000-4000-8000-000000000503',
     '00000000-0000-4000-8000-000000000501',
     'human',
     'local-admin',
     'Local Admin',
     'legacy task message',
     NULL,
     NOW()
   );
   INSERT INTO task_attachments (
     id, task_id, project_id, name, mime_type, size, sha256,
     storage_key, uploaded_by, archived_at, created_at
   ) VALUES (
     '00000000-0000-4000-8000-000000000504',
     '00000000-0000-4000-8000-000000000501',
     '00000000-0000-4000-8000-000000000500',
     'legacy.md',
     'text/markdown',
     6,
     'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
     'legacy/storage/content',
     'local-admin',
     NULL,
     NOW()
   );"
DATABASE_URL="$UPGRADE_URL" \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null

upgrade_version="$(
  psql_database "$UPGRADE_DATABASE" \
    "SELECT MAX(version) FROM platform_migrations;"
)"
upgrade_task="$(
  psql_database "$UPGRADE_DATABASE" \
    "SELECT status || '|' || priority || '|' || auto_submit::text
     FROM tasks
     WHERE id = '00000000-0000-4000-8000-000000000501';"
)"
upgrade_run="$(
  psql_database "$UPGRADE_DATABASE" \
    "SELECT output || '|' || task_execution_kind || '|' ||
       (task_trigger_message_id IS NULL)::text
     FROM runs
     WHERE id = '00000000-0000-4000-8000-000000000502';"
)"
upgrade_message="$(
  psql_database "$UPGRADE_DATABASE" \
    "SELECT content || '|' || (delivery_target IS NULL)::text || '|' ||
       cardinality(mention_agent_ids)::text || '|' ||
       cardinality(triggered_run_ids)::text
     FROM task_messages
     WHERE id = '00000000-0000-4000-8000-000000000503';"
)"
upgrade_attachment="$(
  psql_database "$UPGRADE_DATABASE" \
    "SELECT document_path
     FROM task_attachments
     WHERE id = '00000000-0000-4000-8000-000000000504';"
)"
[[ "$upgrade_version" == "28" ]]
[[ "$upgrade_task" == "done|medium|true" ]]
[[ "$upgrade_run" == "migration-27-output|owner|true" ]]
[[ "$upgrade_message" == "legacy task message|true|0|0" ]]
[[ "$upgrade_attachment" == "documents/00000000-0000-4000-8000-000000000504/content" ]]

DATABASE_URL="$FRESH_URL" \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null
fresh_version="$(
  psql_database "$FRESH_DATABASE" \
    "SELECT MAX(version) FROM platform_migrations;"
)"
[[ "$fresh_version" == "28" ]]

TEST_DATABASE_URL="$FRESH_URL" CI=true \
  node_modules/.bin/vitest run \
    packages/contracts/src/task-memory-dependencies.test.ts \
    packages/domain/src/index.test.ts \
    packages/database/src/job-repository.test.ts \
    packages/database/src/scene-context-repository.test.ts \
    packages/application/src/execution-gate.test.ts \
    apps/worker/src/worker-runtime.test.ts \
    apps/api/src/task-execution-depth.test.ts \
    apps/api/src/app.test.ts \
    apps/api/src/action-ticket-gate.test.ts \
    apps/api/src/scene-context.test.ts \
    apps/api/src/meeting-ai-participation.test.ts \
    apps/api/src/ai-direct-chat.test.ts \
    apps/api/src/external-runtime-execution.test.ts \
    apps/api/src/read-authorization.test.ts \
    --no-file-parallelism

printf 'task_execution_depth_vitest=ok\n'
printf 'fresh_migration=%s\n' "$fresh_version"
printf 'upgrade_migration=%s\n' "$upgrade_version"
printf 'legacy_task_backfill=defaults_preserved\n'
printf 'legacy_attachment_path_backfill=ok\n'
