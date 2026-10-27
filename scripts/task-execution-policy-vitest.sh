#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COMPOSE_PROJECT="${COMPOSE_PROJECT:-pluginmax-batch15a-db}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.batch15a.yml}"
DATABASE_URL_INPUT="${DATABASE_URL:-postgres://pluginmax:pluginmax@127.0.0.1:54426/pluginmax}"
STAMP="$(date -u +%Y%m%d%H%M%S)"
FRESH_DATABASE="pluginmax_batch15a_fresh_$STAMP"
UPGRADE_DATABASE="pluginmax_batch15a_upgrade_$STAMP"
FRESH_URL="${DATABASE_URL_INPUT%/*}/$FRESH_DATABASE"
UPGRADE_URL="${DATABASE_URL_INPUT%/*}/$UPGRADE_DATABASE"
TMP_ROOT="$ROOT/.tmp/batch15a-vitest"

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

mkdir -p "$TMP_ROOT/dsh-home" "$TMP_ROOT/files"
export DSH_HOME="$TMP_ROOT/dsh-home"
export FILE_STORE_ROOT="$TMP_ROOT/files"

DATABASE_URL="$UPGRADE_URL" MIGRATION_TARGET_VERSION=24 \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null
psql_database "$UPGRADE_DATABASE" \
  "INSERT INTO projects (id, name, code, description, status, created_at, updated_at)
   VALUES (
     '00000000-0000-4000-8000-000000000100',
     'Migration 24 fixture',
     'MIG24-FIXTURE',
     '',
     'active',
     NOW(),
     NOW()
   );"
psql_database "$UPGRADE_DATABASE" \
  "INSERT INTO tasks (
     id, project_id, title, description, acceptance, status, agent_id,
     created_at, updated_at
   ) VALUES (
     '00000000-0000-4000-8000-000000000101',
     '00000000-0000-4000-8000-000000000100',
     'Migration 24 task',
     'preserve before migration 25',
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
     '00000000-0000-4000-8000-000000000102',
     '00000000-0000-4000-8000-000000000100',
     '00000000-0000-4000-8000-000000000101',
     '00000000-0000-4000-8000-000000000001',
     'completed',
     '{}'::jsonb,
     'migration-24-output',
     '{\"planVisibility\":\"structured\",\"toolEventCompleteness\":\"complete\",\"textStreaming\":\"delta\",\"subagentVisibility\":\"none\"}'::jsonb,
     1,
     NOW(),
     NOW()
   );"
DATABASE_URL="$UPGRADE_URL" \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null

upgrade_version="$(
  psql_database "$UPGRADE_DATABASE" \
    "SELECT MAX(version) FROM platform_migrations;"
)"
upgrade_project="$(
  psql_database "$UPGRADE_DATABASE" \
    "SELECT code FROM projects
     WHERE id = '00000000-0000-4000-8000-000000000100';"
)"
upgrade_table="$(
  psql_database "$UPGRADE_DATABASE" \
    "SELECT to_regclass('public.task_execution_policies') IS NOT NULL;"
)"
upgrade_run="$(
  psql_database "$UPGRADE_DATABASE" \
    "SELECT output || '|' || (execution_envelope_snapshot IS NULL)::text
     FROM runs
     WHERE id = '00000000-0000-4000-8000-000000000102';"
)"
[[ "$upgrade_version" == "30" ]]
[[ "$upgrade_project" == "MIG24-FIXTURE" ]]
[[ "$upgrade_table" == "t" ]]
[[ "$upgrade_run" == "migration-24-output|true" ]]

DATABASE_URL="$FRESH_URL" \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null
fresh_version="$(
  psql_database "$FRESH_DATABASE" \
    "SELECT MAX(version) FROM platform_migrations;"
)"
[[ "$fresh_version" == "30" ]]

TEST_DATABASE_URL="$FRESH_URL" CI=true \
  node_modules/.bin/vitest run \
    packages/database/src/task-execution-policy-repository.test.ts \
    packages/database/src/authorization-repository.test.ts \
    packages/application/src/authorization.test.ts \
    apps/api/src/authorization.test.ts \
    apps/api/src/read-authorization.test.ts \
    apps/api/src/task-execution-policy.test.ts \
    apps/api/src/app.test.ts \
    apps/api/src/external-runtime-execution.test.ts \
    apps/api/src/meeting-ai-participation.test.ts \
    apps/api/src/ai-direct-chat.test.ts \
    --no-file-parallelism

printf 'task_execution_policy_vitest=ok\n'
printf 'fresh_migration=%s\n' "$fresh_version"
printf 'upgrade_migration=%s\n' "$upgrade_version"
