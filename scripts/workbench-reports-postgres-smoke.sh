#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-pluginmax-batch11a}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.batch11a.yml}"
DATABASE_URL_INPUT="${DATABASE_URL:-postgres://pluginmax:pluginmax@127.0.0.1:54417/pluginmax}"
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

database="pluginmax_batch11a_migration_$STAMP"
database_url="${DATABASE_URL_INPUT%/*}/$database"
psql_database postgres "CREATE DATABASE $database;"

cleanup() {
  psql_database postgres \
    "DROP DATABASE IF EXISTS $database WITH (FORCE);" \
    >/dev/null 2>&1 || true
}
trap cleanup EXIT

DATABASE_URL="$database_url" MIGRATION_TARGET_VERSION=16 CI=true \
  pnpm --filter @pluginmax/database exec tsx src/migrate-cli.ts >/dev/null

psql_database "$database" "
  INSERT INTO projects (
    id, name, code, description, status, created_at, updated_at
  ) VALUES (
    '71000000-0000-4000-8000-000000000001',
    'Legacy Batch 11A project',
    'B11A-MIG',
    'migration 17 smoke',
    'active',
    NOW(),
    NOW()
  );
  INSERT INTO tasks (
    id, project_id, title, description, acceptance, status, agent_id,
    created_at, updated_at
  ) VALUES (
    '71000000-0000-4000-8000-000000000002',
    '71000000-0000-4000-8000-000000000001',
    'Legacy task remains readable',
    'Batch 10B data must survive migration 17',
    '[]'::jsonb,
    'queued',
    '00000000-0000-4000-8000-000000000001',
    NOW(),
    NOW()
  );
  INSERT INTO memory_topics (
    id, project_id, title, created_at, updated_at
  ) VALUES (
    '71000000-0000-4000-8000-000000000003',
    '71000000-0000-4000-8000-000000000001',
    'Legacy memory topic',
    NOW(),
    NOW()
  );
"

DATABASE_URL="$database_url" MIGRATION_TARGET_VERSION=17 CI=true \
  pnpm --filter @pluginmax/database exec tsx src/migrate-cli.ts >/dev/null

version="$(psql_database "$database" \
  'SELECT MAX(version) FROM platform_migrations;')"
legacy_task="$(psql_database "$database" \
  "SELECT title FROM tasks WHERE id = '71000000-0000-4000-8000-000000000002';")"
legacy_topic="$(psql_database "$database" \
  "SELECT title FROM memory_topics WHERE id = '71000000-0000-4000-8000-000000000003';")"
project_reports="$(psql_database "$database" \
  "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'project_reports';")"
workbench_briefs="$(psql_database "$database" \
  "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'workbench_briefs';")"
supply_exceptions="$(psql_database "$database" \
  "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'supply_exceptions';")"
supplier_risks="$(psql_database "$database" \
  "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'supplier_risks';")"
report_trigger="$(psql_database "$database" \
  "SELECT COUNT(*) FROM pg_trigger WHERE tgname = 'project_reports_immutable' AND NOT tgisinternal;")"
brief_trigger="$(psql_database "$database" \
  "SELECT COUNT(*) FROM pg_trigger WHERE tgname = 'workbench_briefs_immutable' AND NOT tgisinternal;")"
report_hash_unique="$(psql_database "$database" \
  "SELECT COUNT(*) FROM pg_indexes WHERE tablename = 'project_reports' AND indexdef LIKE '%project_id, report_date, content_hash%';")"
brief_hash_unique="$(psql_database "$database" \
  "SELECT COUNT(*) FROM pg_indexes WHERE tablename = 'workbench_briefs' AND indexdef LIKE '%actor_id, brief_date, content_hash%';")"

if [[ "$version" != "17" ||
      "$legacy_task" != "Legacy task remains readable" ||
      "$legacy_topic" != "Legacy memory topic" ||
      "$project_reports" != "1" ||
      "$workbench_briefs" != "1" ||
      "$supply_exceptions" != "1" ||
      "$supplier_risks" != "1" ||
      "$report_trigger" != "1" ||
      "$brief_trigger" != "1" ||
      "$report_hash_unique" != "1" ||
      "$brief_hash_unique" != "1" ]]; then
  printf 'v16 to v17 workbench reports smoke failed: version=%s legacy_task=%s legacy_topic=%s project_reports=%s workbench_briefs=%s supply_exceptions=%s supplier_risks=%s report_trigger=%s brief_trigger=%s report_hash_unique=%s brief_hash_unique=%s\n' \
    "$version" "$legacy_task" "$legacy_topic" "$project_reports" \
    "$workbench_briefs" "$supply_exceptions" "$supplier_risks" \
    "$report_trigger" "$brief_trigger" "$report_hash_unique" \
    "$brief_hash_unique" >&2
  exit 1
fi

printf 'workbench_reports_postgres_smoke=ok\n'
printf 'database=%s\n' "$database"
printf 'migration_version=%s\n' "$version"
printf 'legacy_task=%s\n' "$legacy_task"
printf 'legacy_topic=%s\n' "$legacy_topic"
printf 'project_reports=%s\n' "$project_reports"
printf 'workbench_briefs=%s\n' "$workbench_briefs"
printf 'supply_exceptions=%s\n' "$supply_exceptions"
printf 'supplier_risks=%s\n' "$supplier_risks"
