#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COMPOSE_PROJECT="${COMPOSE_PROJECT:-pluginmax-batch18-db}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.batch18.yml}"
DATABASE_URL_INPUT="${DATABASE_URL:-postgres://pluginmax:pluginmax@127.0.0.1:54432/pluginmax}"
STAMP="$(date -u +%Y%m%d%H%M%S)"
FRESH_DATABASE="pluginmax_batch18_fresh_$STAMP"
UPGRADE_DATABASE="pluginmax_batch18_upgrade_$STAMP"
FRESH_URL="${DATABASE_URL_INPUT%/*}/$FRESH_DATABASE"
UPGRADE_URL="${DATABASE_URL_INPUT%/*}/$UPGRADE_DATABASE"
TMP_ROOT="$ROOT/.tmp/batch18-vitest"

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
  if compose exec -T postgres psql -U pluginmax -d postgres \
    -c "SELECT 1" \
    >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
compose exec -T postgres psql -U pluginmax -d postgres \
  -c "SELECT 1" >/dev/null
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

DATABASE_URL="$UPGRADE_URL" MIGRATION_TARGET_VERSION=30 \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null
psql_database "$UPGRADE_DATABASE" \
  "INSERT INTO projects (
     id, name, code, description, status, created_at, updated_at
   ) VALUES (
     '00000000-0000-4000-8000-000000001800',
     'Migration 30 meeting fixture',
     'MIG30-18',
     '',
     'active',
     NOW(),
     NOW()
   );
   INSERT INTO meetings (
     id, project_id, title, agenda, status, participants, summary,
     created_at, updated_at
   ) VALUES (
     '00000000-0000-4000-8000-000000001801',
     '00000000-0000-4000-8000-000000001800',
     'Legacy meeting',
     'Preserve this meeting',
     'open',
     '[{\"id\":\"legacy-facilitator\",\"name\":\"Legacy Facilitator\",\"kind\":\"human\"}]'::jsonb,
     '',
     NOW(),
     NOW()
   );
   INSERT INTO meeting_minutes_drafts (
     id, meeting_id, project_id, content, decisions, source_message_ids,
     revision, updated_by, created_at, updated_at
   ) VALUES (
     gen_random_uuid(),
     '00000000-0000-4000-8000-000000001801',
     '00000000-0000-4000-8000-000000001800',
     '',
     '[]'::jsonb,
     '{}'::uuid[],
     0,
     'local-admin',
     NOW(),
     NOW()
   );"
DATABASE_URL="$UPGRADE_URL" \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null
upgrade_version="$(
  psql_database "$UPGRADE_DATABASE" \
    "SELECT MAX(version) FROM platform_migrations;"
)"
upgrade_title="$(
  psql_database "$UPGRADE_DATABASE" \
    "SELECT title FROM meetings
     WHERE id = '00000000-0000-4000-8000-000000001801';"
)"
upgrade_facilitator="$(
  psql_database "$UPGRADE_DATABASE" \
    "SELECT facilitator_principal_id
     FROM meeting_collaboration_states
     WHERE meeting_id = '00000000-0000-4000-8000-000000001801';"
)"
delivery_backfill="$(
  psql_database "$UPGRADE_DATABASE" \
    "SELECT COUNT(*) FROM meeting_message_deliveries;"
)"
[[ "$upgrade_version" == "31" ]]
[[ "$upgrade_title" == "Legacy meeting" ]]
[[ "$upgrade_facilitator" == "legacy-facilitator" ]]
[[ "$delivery_backfill" == "0" ]]

DATABASE_URL="$FRESH_URL" \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null
fresh_version="$(
  psql_database "$FRESH_DATABASE" \
    "SELECT MAX(version) FROM platform_migrations;"
)"
collaboration_tables="$(
  psql_database "$FRESH_DATABASE" \
    "SELECT COUNT(*) FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name IN (
         'meeting_collaboration_states',
         'meeting_facilitator_handoffs',
         'meeting_delegates',
         'meeting_private_briefings',
         'meeting_message_deliveries',
         'meeting_read_positions',
         'meeting_files',
         'meeting_minutes_confirmations',
         'meeting_tasks',
         'meeting_collaboration_events'
       );"
)"
[[ "$fresh_version" == "31" ]]
[[ "$collaboration_tables" == "10" ]]

TEST_DATABASE_URL="$FRESH_URL" CI=true \
  node_modules/.bin/vitest run \
    packages/contracts/src/meeting-collaboration.test.ts \
    apps/api/src/meeting-collaboration.test.ts \
    apps/api/src/meeting-decisions.test.ts \
    apps/api/src/meeting-ai-participation.test.ts \
    apps/api/src/scene-context.test.ts \
    apps/api/src/task-execution-depth.test.ts \
    apps/api/src/action-ticket-gate.test.ts \
    apps/api/src/ai-direct-chat.test.ts \
    --no-file-parallelism

printf 'meeting_collaboration_vitest=ok\n'
printf 'fresh_migration=%s\n' "$fresh_version"
printf 'upgrade_migration=%s\n' "$upgrade_version"
printf 'collaboration_tables=%s\n' "$collaboration_tables"
printf 'delivery_backfill=%s\n' "$delivery_backfill"
