#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-pluginmax-batch12a}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.batch12a.yml}"
DATABASE_URL_INPUT="${DATABASE_URL:-postgres://pluginmax:pluginmax@127.0.0.1:54419/pluginmax}"
STAMP="$(date -u +%Y%m%d%H%M%S)"

compose() {
  "$ROOT/scripts/db-compose.sh" -p "$COMPOSE_PROJECT" -f "$ROOT/$COMPOSE_FILE" "$@"
}

psql_database() {
  local database="$1"
  local sql="$2"
  compose exec -T postgres psql -U pluginmax -d "$database" \
    -qAt -v ON_ERROR_STOP=1 -c "$sql"
}

compose up -d postgres >/dev/null
for _ in {1..60}; do
  if compose exec -T postgres pg_isready \
    -U pluginmax -d pluginmax >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

database="pluginmax_batch12a_migration_$STAMP"
database_url="${DATABASE_URL_INPUT%/*}/$database"
psql_database postgres "CREATE DATABASE $database;"

cleanup() {
  psql_database postgres \
    "DROP DATABASE IF EXISTS $database WITH (FORCE);" \
    >/dev/null 2>&1 || true
}
trap cleanup EXIT

DATABASE_URL="$database_url" MIGRATION_TARGET_VERSION=18 CI=true \
  pnpm --filter @pluginmax/database exec tsx src/migrate-cli.ts >/dev/null

psql_database "$database" "
  INSERT INTO projects (
    id, name, code, description, status, created_at, updated_at
  ) VALUES (
    '12000000-0000-4000-8000-000000000001',
    'Legacy meeting AI project',
    'B12A-MIG',
    'migration 19 smoke',
    'active',
    NOW(),
    NOW()
  );
  INSERT INTO agents (
    id, name, description, runtime_kind, status, soul, scenarios, goals,
    tools, source, owner_id, version, created_at, updated_at
  ) VALUES (
    '12000000-0000-4000-8000-000000000002',
    'Legacy meeting AI agent',
    '',
    'fake',
    'active',
    '',
    '[]'::jsonb,
    '[]'::jsonb,
    '[]'::jsonb,
    'personal',
    'local-admin',
    1,
    NOW(),
    NOW()
  );
  INSERT INTO project_members (
    id, project_id, kind, actor_id, name, responsibility, status, is_owner,
    created_at, updated_at
  ) VALUES (
    '12000000-0000-4000-8000-000000000003',
    '12000000-0000-4000-8000-000000000001',
    'agent',
    '12000000-0000-4000-8000-000000000002',
    'Legacy meeting AI agent',
    '',
    'active',
    FALSE,
    NOW(),
    NOW()
  );
  INSERT INTO tasks (
    id, project_id, title, description, acceptance, status, agent_id,
    created_at, updated_at
  ) VALUES (
    '12000000-0000-4000-8000-000000000004',
    '12000000-0000-4000-8000-000000000001',
    'Legacy task remains readable',
    'Batch 11B task',
    '[]'::jsonb,
    'queued',
    '00000000-0000-4000-8000-000000000001',
    NOW(),
    NOW()
  );
  INSERT INTO meetings (
    id, project_id, title, agenda, status, participants, summary,
    created_at, updated_at
  ) VALUES (
    '12000000-0000-4000-8000-000000000005',
    '12000000-0000-4000-8000-000000000001',
    'Legacy meeting',
    'Legacy agenda',
    'open',
    '[{\"id\":\"local-admin\",\"name\":\"Local Admin\",\"kind\":\"human\"},{\"id\":\"12000000-0000-4000-8000-000000000002\",\"name\":\"Legacy meeting AI agent\",\"kind\":\"agent\"}]'::jsonb,
    '',
    NOW(),
    NOW()
  );
  INSERT INTO meeting_messages (
    id, meeting_id, author_type, author_id, author_name, content, created_at
  ) VALUES (
    '12000000-0000-4000-8000-000000000006',
    '12000000-0000-4000-8000-000000000005',
    'human',
    'local-admin',
    'Local Admin',
    'Legacy meeting message',
    NOW()
  );
"

DATABASE_URL="$database_url" MIGRATION_TARGET_VERSION=19 CI=true \
  pnpm --filter @pluginmax/database exec tsx src/migrate-cli.ts >/dev/null

version="$(psql_database "$database" \
  'SELECT MAX(version) FROM platform_migrations;')"
legacy_task="$(psql_database "$database" \
  "SELECT title FROM tasks WHERE id = '12000000-0000-4000-8000-000000000004';")"
policy_status="$(psql_database "$database" \
  "SELECT status FROM meeting_ai_policies WHERE meeting_id = '12000000-0000-4000-8000-000000000005';")"
participant_count="$(psql_database "$database" \
  "SELECT COUNT(*) FROM meeting_ai_participants WHERE meeting_id = '12000000-0000-4000-8000-000000000005';")"
message_status="$(psql_database "$database" \
  "SELECT status FROM meeting_messages WHERE id = '12000000-0000-4000-8000-000000000006';")"
new_tables="$(psql_database "$database" \
  "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('meeting_ai_policies','meeting_ai_participants','meeting_ai_rounds','meeting_ai_turns');")"
run_task_nullable="$(psql_database "$database" \
  "SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'runs' AND column_name = 'task_id';")"
run_turn_column="$(psql_database "$database" \
  "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'runs' AND column_name = 'meeting_turn_id';")"
message_turn_unique="$(psql_database "$database" \
  "SELECT COUNT(*) FROM pg_indexes WHERE tablename = 'meeting_messages' AND indexname = 'meeting_messages_turn_idx';")"

if [[ "$version" != "19" ||
      "$legacy_task" != "Legacy task remains readable" ||
      "$policy_status" != "paused" ||
      "$participant_count" != "1" ||
      "$message_status" != "sent" ||
      "$new_tables" != "4" ||
      "$run_task_nullable" != "YES" ||
      "$run_turn_column" != "1" ||
      "$message_turn_unique" != "1" ]]; then
  printf 'v18 to v19 meeting AI smoke failed: version=%s legacy_task=%s policy=%s participants=%s message_status=%s tables=%s run_task_nullable=%s run_turn_column=%s message_turn_unique=%s\n' \
    "$version" "$legacy_task" "$policy_status" "$participant_count" \
    "$message_status" "$new_tables" "$run_task_nullable" \
    "$run_turn_column" "$message_turn_unique" >&2
  exit 1
fi

printf 'meeting_ai_participation_postgres_smoke=ok\n'
printf 'database=%s\n' "$database"
printf 'migration_version=%s\n' "$version"
printf 'legacy_policy_status=%s\n' "$policy_status"
printf 'legacy_ai_participants=%s\n' "$participant_count"
printf 'run_task_nullable=%s\n' "$run_task_nullable"
