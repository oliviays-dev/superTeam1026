#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COMPOSE_PROJECT="${COMPOSE_PROJECT:-pluginmax-batch17b-db}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.batch17b.yml}"
DATABASE_URL_INPUT="${DATABASE_URL:-postgres://pluginmax:pluginmax@127.0.0.1:54431/pluginmax}"
STAMP="$(date -u +%Y%m%d%H%M%S)"
FRESH_DATABASE="pluginmax_batch17b_fresh_$STAMP"
UPGRADE_DATABASE="pluginmax_batch17b_upgrade_$STAMP"
FRESH_URL="${DATABASE_URL_INPUT%/*}/$FRESH_DATABASE"
UPGRADE_URL="${DATABASE_URL_INPUT%/*}/$UPGRADE_DATABASE"
TMP_ROOT="$ROOT/.tmp/batch17b-vitest"

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
  if compose exec -T postgres pg_isready -U pluginmax -d pluginmax \
    >/dev/null 2>&1; then
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
  "$TMP_ROOT/logs" \
  "$TMP_ROOT/screenshots"
export DSH_HOME="$TMP_ROOT/dsh-home"
export FILE_STORE_ROOT="$TMP_ROOT/files"
export AGENT_WORKSPACE_ROOT="$TMP_ROOT/workspaces"

DATABASE_URL="$UPGRADE_URL" MIGRATION_TARGET_VERSION=29 \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null
psql_database "$UPGRADE_DATABASE" \
  "INSERT INTO projects (
     id, name, code, description, status, created_at, updated_at
   ) VALUES (
     '00000000-0000-4000-8000-000000001700',
     'Migration 29 teammate fixture',
     'MIG29-17B',
     '',
     'active',
     NOW(),
     NOW()
   );
   INSERT INTO tasks (
     id, project_id, title, description, acceptance, status, agent_id,
     created_at, updated_at
   ) VALUES (
     '00000000-0000-4000-8000-000000001701',
     '00000000-0000-4000-8000-000000001700',
     'Migration 29 task',
     'preserve before migration 30',
     '[]'::jsonb,
     'queued',
     '00000000-0000-4000-8000-000000000001',
     NOW(),
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
    "SELECT title FROM tasks
     WHERE id = '00000000-0000-4000-8000-000000001701';"
)"
attribution_backfill="$(
  psql_database "$UPGRADE_DATABASE" \
    "SELECT COUNT(*) FROM teammate_run_attributions;"
)"
[[ "$upgrade_version" == "30" ]]
[[ "$upgrade_task" == "Migration 29 task" ]]
[[ "$attribution_backfill" == "0" ]]

DATABASE_URL="$FRESH_URL" \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null
fresh_version="$(
  psql_database "$FRESH_DATABASE" \
    "SELECT MAX(version) FROM platform_migrations;"
)"
teammate_tables="$(
  psql_database "$FRESH_DATABASE" \
    "SELECT COUNT(*) FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name LIKE 'teammate_%';"
)"
maintenance_schedule="$(
  psql_database "$FRESH_DATABASE" \
    "SELECT COUNT(*) FROM runtime_maintenance_schedules
     WHERE kind = 'teammate_queue';"
)"
[[ "$fresh_version" == "30" ]]
[[ "$teammate_tables" == "9" ]]
[[ "$maintenance_schedule" == "1" ]]

TEST_DATABASE_URL="$FRESH_URL" CI=true \
  node_modules/.bin/vitest run \
    packages/contracts/src/teammate.test.ts \
    packages/application/src/teammates.test.ts \
    packages/application/src/runtime-economics.test.ts \
    packages/database/src/teammate-repository.test.ts \
    packages/database/src/runtime-economics-repository.test.ts \
    apps/worker/src/maintenance-service.test.ts \
    apps/api/src/teammates.test.ts \
    apps/api/src/task-execution-depth.test.ts \
    apps/api/src/action-ticket-gate.test.ts \
    apps/api/src/scene-context.test.ts \
    apps/api/src/task-execution-policy.test.ts \
    apps/api/src/meeting-ai-participation.test.ts \
    apps/api/src/ai-direct-chat.test.ts \
    apps/api/src/read-authorization.test.ts \
    --no-file-parallelism

printf 'teammate_vitest=ok\n'
printf 'fresh_migration=%s\n' "$fresh_version"
printf 'upgrade_migration=%s\n' "$upgrade_version"
printf 'legacy_attribution_backfill=%s\n' "$attribution_backfill"
printf 'teammate_tables=%s\n' "$teammate_tables"
