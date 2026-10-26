#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-pluginmax-batch12b}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.batch12b.yml}"
DATABASE_URL_INPUT="${DATABASE_URL:-postgres://pluginmax:pluginmax@127.0.0.1:54420/pluginmax}"
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

database="pluginmax_batch12b_migration_$STAMP"
database_url="${DATABASE_URL_INPUT%/*}/$database"
psql_database postgres "CREATE DATABASE $database;"

cleanup() {
  psql_database postgres \
    "DROP DATABASE IF EXISTS $database WITH (FORCE);" \
    >/dev/null 2>&1 || true
}
trap cleanup EXIT

DATABASE_URL="$database_url" MIGRATION_TARGET_VERSION=19 CI=true \
  pnpm --filter @pluginmax/database exec tsx src/migrate-cli.ts >/dev/null

psql_database "$database" "
  INSERT INTO projects (
    id, name, code, description, status, created_at, updated_at
  ) VALUES (
    '12000000-0000-4000-8001-000000000001',
    'Legacy direct chat project',
    'B12B-MIG',
    'migration 20 smoke',
    'active',
    NOW(),
    NOW()
  );
  INSERT INTO agents (
    id, name, description, runtime_kind, status, soul, scenarios, goals,
    tools, source, owner_id, version, created_at, updated_at
  ) VALUES (
    '12000000-0000-4000-8001-000000000002',
    'Legacy direct chat agent',
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
  INSERT INTO tasks (
    id, project_id, title, description, acceptance, status, agent_id,
    created_at, updated_at
  ) VALUES (
    '12000000-0000-4000-8001-000000000003',
    '12000000-0000-4000-8001-000000000001',
    'Legacy task remains readable',
    'Batch 12A task',
    '[]'::jsonb,
    'queued',
    '12000000-0000-4000-8001-000000000002',
    NOW(),
    NOW()
  );
  INSERT INTO meetings (
    id, project_id, title, agenda, status, participants, summary,
    created_at, updated_at
  ) VALUES (
    '12000000-0000-4000-8001-000000000004',
    '12000000-0000-4000-8001-000000000001',
    'Legacy meeting',
    'Legacy agenda',
    'open',
    '[{\"id\":\"local-admin\",\"name\":\"Local Admin\",\"kind\":\"human\"}]'::jsonb,
    '',
    NOW(),
    NOW()
  );
  INSERT INTO meeting_messages (
    id, meeting_id, author_type, author_id, author_name, content, created_at
  ) VALUES (
    '12000000-0000-4000-8001-000000000005',
    '12000000-0000-4000-8001-000000000004',
    'human',
    'local-admin',
    'Local Admin',
    'Legacy meeting message',
    NOW()
  );
  INSERT INTO runs (
    id, project_id, task_id, agent_id, status, input_snapshot,
    observability, attempt, created_at, updated_at
  ) VALUES (
    '12000000-0000-4000-8001-000000000006',
    '12000000-0000-4000-8001-000000000001',
    '12000000-0000-4000-8001-000000000003',
    '12000000-0000-4000-8001-000000000002',
    'queued',
    '{\"taskTitle\":\"legacy\",\"taskDescription\":\"legacy\",\"acceptance\":[],\"instruction\":\"legacy\",\"agentName\":\"Legacy direct chat agent\",\"runtimeKind\":\"fake\"}'::jsonb,
    '{\"planVisibility\":\"summary\",\"toolEventCompleteness\":\"partial\",\"textStreaming\":\"message\",\"subagentVisibility\":\"none\"}'::jsonb,
    1,
    NOW(),
    NOW()
  );
"

DATABASE_URL="$database_url" MIGRATION_TARGET_VERSION=20 CI=true \
  pnpm --filter @pluginmax/database exec tsx src/migrate-cli.ts >/dev/null

version="$(psql_database "$database" \
  'SELECT MAX(version) FROM platform_migrations;')"
legacy_run_project="$(psql_database "$database" \
  "SELECT project_id FROM runs WHERE id = '12000000-0000-4000-8001-000000000006';")"
legacy_direct_turn="$(psql_database "$database" \
  "SELECT COALESCE(direct_chat_turn_id::text, 'NULL') FROM runs WHERE id = '12000000-0000-4000-8001-000000000006';")"
legacy_message="$(psql_database "$database" \
  "SELECT content FROM meeting_messages WHERE id = '12000000-0000-4000-8001-000000000005';")"
direct_tables="$(psql_database "$database" \
  "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('direct_chat_threads','direct_chat_messages','direct_chat_turns');")"
run_project_nullable="$(psql_database "$database" \
  "SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'runs' AND column_name = 'project_id';")"
context_project_nullable="$(psql_database "$database" \
  "SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'context_packs' AND column_name = 'project_id';")"
direct_indexes="$(psql_database "$database" \
  "SELECT COUNT(*) FROM pg_indexes WHERE tablename IN ('direct_chat_turns','direct_chat_messages','runs') AND indexname IN ('direct_chat_turns_active_source_idx','direct_chat_messages_turn_idx','runs_direct_chat_turn_idx');")"

if [[ "$version" != "20" ||
      "$legacy_run_project" != "12000000-0000-4000-8001-000000000001" ||
      "$legacy_direct_turn" != "NULL" ||
      "$legacy_message" != "Legacy meeting message" ||
      "$direct_tables" != "3" ||
      "$run_project_nullable" != "YES" ||
      "$context_project_nullable" != "YES" ||
      "$direct_indexes" != "3" ]]; then
  printf 'v19 to v20 direct chat smoke failed: version=%s run_project=%s direct_turn=%s message=%s tables=%s run_nullable=%s context_nullable=%s indexes=%s\n' \
    "$version" "$legacy_run_project" "$legacy_direct_turn" \
    "$legacy_message" "$direct_tables" "$run_project_nullable" \
    "$context_project_nullable" "$direct_indexes" >&2
  exit 1
fi

printf 'ai_direct_chat_postgres_smoke=ok\n'
printf 'database=%s\n' "$database"
printf 'migration_version=%s\n' "$version"
printf 'legacy_run_project=%s\n' "$legacy_run_project"
printf 'direct_tables=%s\n' "$direct_tables"
