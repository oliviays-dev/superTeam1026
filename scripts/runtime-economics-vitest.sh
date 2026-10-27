#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COMPOSE_PROJECT="${COMPOSE_PROJECT:-pluginmax-batch13-1b-db}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.batch13.1b.yml}"
DATABASE_URL_INPUT="${DATABASE_URL:-postgres://pluginmax:pluginmax@127.0.0.1:54430/pluginmax}"
STAMP="$(date -u +%Y%m%d%H%M%S)"
FRESH_DATABASE="pluginmax_batch13_1b_fresh_$STAMP"
UPGRADE_DATABASE="pluginmax_batch13_1b_upgrade_$STAMP"
FRESH_URL="${DATABASE_URL_INPUT%/*}/$FRESH_DATABASE"
UPGRADE_URL="${DATABASE_URL_INPUT%/*}/$UPGRADE_DATABASE"
TMP_ROOT="$ROOT/.tmp/batch13.1b-vitest"

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

mkdir -p \
  "$TMP_ROOT/dsh-home" \
  "$TMP_ROOT/files" \
  "$TMP_ROOT/workspaces" \
  "$TMP_ROOT/logs"
export DSH_HOME="$TMP_ROOT/dsh-home"
export FILE_STORE_ROOT="$TMP_ROOT/files"
export AGENT_WORKSPACE_ROOT="$TMP_ROOT/workspaces"

DATABASE_URL="$UPGRADE_URL" MIGRATION_TARGET_VERSION=28 \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null
psql_database "$UPGRADE_DATABASE" \
  "INSERT INTO projects (
     id, name, code, description, status, created_at, updated_at
   ) VALUES (
     '00000000-0000-4000-8000-000000000600',
     'Migration 28 economics fixture',
     'MIG28-ECON',
     '',
     'active',
     NOW(),
     NOW()
   );
   INSERT INTO tasks (
     id, project_id, title, description, acceptance, status, agent_id,
     created_at, updated_at
   ) VALUES (
     '00000000-0000-4000-8000-000000000601',
     '00000000-0000-4000-8000-000000000600',
     'Migration 28 task',
     'preserve before migration 29',
     '[]'::jsonb,
     'done',
     '00000000-0000-4000-8000-000000000001',
     NOW(),
     NOW()
   );
   INSERT INTO runs (
     id, project_id, task_id, agent_id, status, input_snapshot,
     output, observability, attempt, created_at, updated_at, ended_at
   ) VALUES (
     '00000000-0000-4000-8000-000000000602',
     '00000000-0000-4000-8000-000000000600',
     '00000000-0000-4000-8000-000000000601',
     '00000000-0000-4000-8000-000000000001',
     'completed',
     '{}'::jsonb,
     'migration-28-output',
     '{\"planVisibility\":\"structured\",\"toolEventCompleteness\":\"complete\",\"textStreaming\":\"delta\",\"subagentVisibility\":\"none\"}'::jsonb,
     1,
     NOW(),
     NOW(),
     NOW()
   );
   INSERT INTO external_runtimes (
     id, name, provider, protocol, command, managed_args, custom_args,
     supported_models, default_model, context_window_tokens, supported_tools,
     network_mode, sandbox_mode, status, visibility, owner_id, revision,
     command_digest, args_digest, created_at, updated_at
   ) VALUES (
     '00000000-0000-4000-8000-000000000603',
     'Migration 28 runtime',
     'workbuddy',
     'plain-text',
     'workbuddy',
     '[]'::jsonb,
     '[]'::jsonb,
     '[]'::jsonb,
     NULL,
     NULL,
     '[]'::jsonb,
     'unknown',
     'read-only',
     'disabled',
     'owner',
     'local-admin',
     1,
     repeat('a', 64),
     repeat('b', 64),
     NOW(),
     NOW()
   );"

DATABASE_URL="$UPGRADE_URL" \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null
upgrade_version="$(
  psql_database "$UPGRADE_DATABASE" \
    "SELECT MAX(version) FROM platform_migrations;"
)"
upgrade_run="$(
  psql_database "$UPGRADE_DATABASE" \
    "SELECT output FROM runs
     WHERE id = '00000000-0000-4000-8000-000000000602';"
)"
legacy_runtime="$(
  psql_database "$UPGRADE_DATABASE" \
    "SELECT provider || '|' || protocol || '|' || visibility || '|' ||
       (workspace_id IS NULL)::text
     FROM external_runtimes
     WHERE id = '00000000-0000-4000-8000-000000000603';"
)"
usage_backfill="$(
  psql_database "$UPGRADE_DATABASE" \
    "SELECT COUNT(*) FROM run_runtime_usage_receipts;"
)"
[[ "$upgrade_version" == "30" ]]
[[ "$upgrade_run" == "migration-28-output" ]]
[[ "$legacy_runtime" == "workbuddy|plain-text|owner|true" ]]
[[ "$usage_backfill" == "0" ]]

DATABASE_URL="$FRESH_URL" \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null
fresh_version="$(
  psql_database "$FRESH_DATABASE" \
    "SELECT MAX(version) FROM platform_migrations;"
)"
[[ "$fresh_version" == "30" ]]

TEST_DATABASE_URL="$FRESH_URL" CI=true \
  node_modules/.bin/vitest run \
    packages/contracts/src/runtime-economics.test.ts \
    packages/agent-runtime/src/codex-jsonl.test.ts \
    packages/application/src/runtime-economics.test.ts \
    packages/database/src/runtime-economics-repository.test.ts \
    apps/api/src/runtime-economics.test.ts \
    apps/api/src/task-execution-policy.test.ts \
    apps/api/src/external-runtime-execution.test.ts \
    apps/api/src/meeting-ai-participation.test.ts \
    apps/api/src/ai-direct-chat.test.ts \
    apps/api/src/action-ticket-gate.test.ts \
    apps/api/src/scene-context.test.ts \
    apps/api/src/task-execution-depth.test.ts \
    apps/worker/src/worker-runtime.test.ts \
    --no-file-parallelism

printf 'runtime_economics_vitest=ok\n'
printf 'fresh_migration=%s\n' "$fresh_version"
printf 'upgrade_migration=%s\n' "$upgrade_version"
printf 'legacy_usage_backfill=%s\n' "$usage_backfill"
