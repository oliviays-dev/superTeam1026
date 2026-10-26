#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-pluginmax-batch10a}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.batch10a.yml}"
DATABASE_URL_INPUT="${DATABASE_URL:-postgres://pluginmax:pluginmax@127.0.0.1:54400/pluginmax}"
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

database="pluginmax_batch10a_migration_$STAMP"
database_url="${DATABASE_URL_INPUT%/*}/$database"
psql_database postgres "CREATE DATABASE $database;"

cleanup() {
  psql_database postgres \
    "DROP DATABASE IF EXISTS $database WITH (FORCE);" \
    >/dev/null 2>&1 || true
}
trap cleanup EXIT

DATABASE_URL="$database_url" MIGRATION_TARGET_VERSION=14 CI=true \
  pnpm --filter @pluginmax/database exec tsx src/migrate-cli.ts >/dev/null

psql_database "$database" "
  INSERT INTO projects (
    id, name, code, description, status, created_at, updated_at
  ) VALUES (
    '50000000-0000-4000-8000-000000000001',
    'Legacy meeting decisions',
    'B10-MIG',
    'migration 15 smoke',
    'active',
    NOW(),
    NOW()
  );
  INSERT INTO meetings (
    id, project_id, title, agenda, status, participants, summary,
    created_at, updated_at
  ) VALUES (
    '50000000-0000-4000-8000-000000000002',
    '50000000-0000-4000-8000-000000000001',
    'Legacy meeting',
    'Backfill immutable minutes',
    'closed',
    '[{\"id\":\"local-admin\",\"name\":\"Local Admin\",\"kind\":\"human\"}]'::jsonb,
    'Legacy published summary',
    NOW() - INTERVAL '2 hours',
    NOW() - INTERVAL '1 hour'
  );
  INSERT INTO meeting_messages (
    id, meeting_id, author_type, author_id, author_name, content, created_at
  ) VALUES (
    '50000000-0000-4000-8000-000000000003',
    '50000000-0000-4000-8000-000000000002',
    'human',
    'local-admin',
    'Local Admin',
    'Legacy meeting source message',
    NOW() - INTERVAL '90 minutes'
  );
"

DATABASE_URL="$database_url" MIGRATION_TARGET_VERSION=15 CI=true \
  pnpm --filter @pluginmax/database exec tsx src/migrate-cli.ts >/dev/null

version="$(psql_database "$database" \
  'SELECT MAX(version) FROM platform_migrations;')"
draft_count="$(psql_database "$database" \
  'SELECT COUNT(*) FROM meeting_minutes_drafts;')"
version_count="$(psql_database "$database" \
  'SELECT COUNT(*) FROM meeting_minutes_versions;')"
legacy_revision="$(psql_database "$database" \
  "SELECT revision FROM meeting_minutes_drafts WHERE meeting_id = '50000000-0000-4000-8000-000000000002';")"
legacy_content="$(psql_database "$database" \
  "SELECT content FROM meeting_minutes_versions WHERE meeting_id = '50000000-0000-4000-8000-000000000002';")"
immutable_trigger="$(psql_database "$database" \
  "SELECT COUNT(*) FROM pg_trigger WHERE tgname = 'meeting_minutes_versions_immutable' AND NOT tgisinternal;")"
trace_columns="$(psql_database "$database" "
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND column_name = 'trace_id'
    AND table_name IN (
      'runs',
      'run_events',
      'jobs',
      'job_attempts',
      'runtime_effect_receipts',
      'runtime_maintenance_runs'
    );
")"

if [[ "$version" != "15" ||
      "$draft_count" != "1" ||
      "$version_count" != "1" ||
      "$legacy_revision" != "1" ||
      "$legacy_content" != "Legacy published summary" ||
      "$immutable_trigger" != "1" ||
      "$trace_columns" != "6" ]]; then
  printf 'v14 to v15 meeting decisions smoke failed: version=%s drafts=%s versions=%s revision=%s content=%s trigger=%s trace_columns=%s\n' \
    "$version" "$draft_count" "$version_count" "$legacy_revision" \
    "$legacy_content" "$immutable_trigger" "$trace_columns" >&2
  exit 1
fi

printf 'meeting_decisions_postgres_smoke=ok\n'
printf 'database=%s\n' "$database"
printf 'migration_version=%s\n' "$version"
printf 'legacy_drafts=%s\n' "$draft_count"
printf 'legacy_versions=%s\n' "$version_count"
printf 'immutable_trigger=%s\n' "$immutable_trigger"
printf 'trace_columns=%s\n' "$trace_columns"
