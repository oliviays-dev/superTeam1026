#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COMPOSE_PROJECT="${M6_MIGRATION_COMPOSE_PROJECT:-pluginmax-m6-migration}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.core-regression.yml}"
PORT="${M6_MIGRATION_POSTGRES_PORT:-54453}"
export CORE_REGRESSION_POSTGRES_PORT="$PORT"
DATABASE_URL_INPUT="${DATABASE_URL:-postgres://pluginmax:pluginmax@127.0.0.1:${PORT}/pluginmax}"
STAMP="$(date -u +%Y%m%d%H%M%S)"
EMPTY_DATABASE="pluginmax_m6_empty_${STAMP}"
UPGRADE_DATABASE="pluginmax_m6_upgrade_${STAMP}"
EMPTY_URL="${DATABASE_URL_INPUT%/*}/${EMPTY_DATABASE}"
UPGRADE_URL="${DATABASE_URL_INPUT%/*}/${UPGRADE_DATABASE}"

compose() {
  "$ROOT/scripts/db-compose.sh" \
    -p "$COMPOSE_PROJECT" \
    -f "$ROOT/$COMPOSE_FILE" \
    "$@"
}

psql_database() {
  local database="$1"
  local sql="$2"
  compose exec -T postgres psql -U pluginmax -d "$database" \
    -qAt -v ON_ERROR_STOP=1 -c "$sql"
}

cleanup() {
  psql_database postgres \
    "DROP DATABASE IF EXISTS $EMPTY_DATABASE WITH (FORCE);" \
    >/dev/null 2>&1 || true
  psql_database postgres \
    "DROP DATABASE IF EXISTS $UPGRADE_DATABASE WITH (FORCE);" \
    >/dev/null 2>&1 || true
  if [[ "${M6_MIGRATION_KEEP_ENV:-0}" != "1" ]]; then
    compose down -v >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

compose up -d postgres >/dev/null
for _ in {1..120}; do
  container_id="$(compose ps -q postgres)"
  health="$(
    docker inspect --format '{{.State.Health.Status}}' \
      "$container_id" 2>/dev/null || true
  )"
  if [[ "$health" == "healthy" ]] &&
    psql_database postgres "SELECT 1;" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done
psql_database postgres "CREATE DATABASE $EMPTY_DATABASE;"
psql_database postgres "CREATE DATABASE $UPGRADE_DATABASE;"

DATABASE_URL="$EMPTY_URL" \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null
FRESH_VERSION="$(psql_database "$EMPTY_DATABASE" \
  "SELECT MAX(version) FROM platform_migrations;")"
FRESH_TABLE="$(psql_database "$EMPTY_DATABASE" \
  "SELECT COUNT(*) FROM pg_class
   WHERE relname = 'project_ai_pms' AND relkind = 'r';")"
FRESH_FLAG="$(psql_database "$EMPTY_DATABASE" \
  "SELECT flag_key || '=' || mode
   FROM feature_flag_settings
   WHERE flag_key = 'project.ai_pm';")"
FRESH_REPORT_COLUMNS="$(psql_database "$EMPTY_DATABASE" \
  "SELECT COUNT(*) FROM information_schema.columns
   WHERE table_name = 'project_reports'
     AND column_name IN (
       'report_kind', 'period_start', 'period_end',
       'generated_by_principal_id', 'run_id', 'skill_id',
       'skill_version', 'skill_digest', 'trigger_source',
       'source_digest', 'source_cutoff_at'
     );")"

[[ "$FRESH_VERSION" == "42" ]]
[[ "$FRESH_TABLE" == "1" ]]
[[ "$FRESH_FLAG" == "project.ai_pm=off" ]]
[[ "$FRESH_REPORT_COLUMNS" == "11" ]]

DATABASE_URL="$UPGRADE_URL" MIGRATION_TARGET_VERSION=41 \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null
psql_database "$UPGRADE_DATABASE" "
INSERT INTO principals (
  id, kind, display_name, status, status_authority, source,
  version, created_at, updated_at
) VALUES (
  'local-admin', 'human', 'Local Admin', 'active', 'system', 'local',
  1, NOW(), NOW()
);
INSERT INTO projects (
  id, name, code, description, status, created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000006000',
  'M6 migration snapshot',
  'M6-MIG-42',
  '',
  'active',
  NOW(),
  NOW()
);
INSERT INTO project_reports (
  id, project_id, report_date, version, content_hash, snapshot,
  generated_by, generated_at
) VALUES (
  '00000000-0000-4000-8000-000000006001',
  '00000000-0000-4000-8000-000000006000',
  '2026-11-12',
  1,
  repeat('a', 64),
  '{
    \"projectName\":\"M6 migration snapshot\",
    \"projectCode\":\"M6-MIG-42\",
    \"periodStart\":\"2026-11-11T16:00:00.000Z\",
    \"periodEnd\":\"2026-11-12T16:00:00.000Z\",
    \"counts\":{
      \"tasks\":0,\"runs\":0,\"reviews\":0,\"workflows\":0,
      \"meetings\":0,\"actionItems\":0,\"memory\":0
    },
    \"items\":[]
  }'::jsonb,
  'local-admin',
  '2026-11-12T17:00:00.000Z'
);"

DATABASE_URL="$UPGRADE_URL" \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null

UPGRADE_VERSION="$(psql_database "$UPGRADE_DATABASE" \
  "SELECT MAX(version) FROM platform_migrations;")"
BACKFILL="$(psql_database "$UPGRADE_DATABASE" \
  "SELECT report_kind || '|' ||
          (period_start IS NOT NULL) || '|' ||
          (period_end IS NOT NULL) || '|' ||
          generated_by_principal_id || '|' ||
          trigger_source || '|' ||
          (source_digest = content_hash) || '|' ||
          (source_cutoff_at = generated_at)
   FROM project_reports
   WHERE id = '00000000-0000-4000-8000-000000006001';")"
CONSTRAINTS="$(psql_database "$UPGRADE_DATABASE" \
  "SELECT COUNT(*) FROM pg_constraint
   WHERE conname IN (
     'project_reports_project_kind_date_version_key',
     'project_reports_project_kind_date_content_key'
   );")"
IMMUTABLE_TRIGGER="$(psql_database "$UPGRADE_DATABASE" \
  "SELECT COUNT(*) FROM pg_trigger
   WHERE tgname = 'project_reports_immutable' AND NOT tgisinternal;")"
LEGACY_READ="$(psql_database "$UPGRADE_DATABASE" \
  "SELECT report_date || '|' || version || '|' || generated_by
   FROM project_reports
   WHERE id = '00000000-0000-4000-8000-000000006001';")"

psql_database "$UPGRADE_DATABASE" "
INSERT INTO project_reports (
  id, project_id, report_date, version, content_hash, snapshot,
  generated_by, generated_at
) VALUES (
  '00000000-0000-4000-8000-000000006002',
  '00000000-0000-4000-8000-000000006000',
  '2026-11-12',
  2,
  repeat('b', 64),
  '{}'::jsonb,
  'local-admin',
  NOW()
);" >/dev/null
OLD_APP_WRITE="$(psql_database "$UPGRADE_DATABASE" \
  "SELECT report_kind || '|' || trigger_source || '|' ||
          (source_cutoff_at IS NOT NULL) || '|' ||
          (period_start IS NULL)
   FROM project_reports
   WHERE id = '00000000-0000-4000-8000-000000006002';")"
CONFLICT_COUNT="$(psql_database "$UPGRADE_DATABASE" \
  "SELECT COUNT(*) FROM (
     SELECT project_id, report_kind, report_date, version
     FROM project_reports
     GROUP BY project_id, report_kind, report_date, version
     HAVING COUNT(*) > 1
   ) AS conflicts;")"

[[ "$UPGRADE_VERSION" == "42" ]]
[[ "$BACKFILL" == "daily|t|t|local-admin|legacy|t|t" ]]
[[ "$CONSTRAINTS" == "2" ]]
[[ "$IMMUTABLE_TRIGGER" == "1" ]]
[[ "$LEGACY_READ" == "2026-11-12|1|local-admin" ]]
[[ "$OLD_APP_WRITE" == "daily|manual|t|t" ]]
[[ "$CONFLICT_COUNT" == "0" ]]

printf 'm6_migration_vitest=ok\n'
printf 'fresh_migration=0->42\n'
printf 'upgrade_migration=41->42\n'
printf 'flag=%s\n' "$FRESH_FLAG"
printf 'legacy_backfill=%s\n' "$BACKFILL"
printf 'old_app_read=%s\n' "$LEGACY_READ"
printf 'old_app_write=%s\n' "$OLD_APP_WRITE"
printf 'constraint_conflicts=%s\n' "$CONFLICT_COUNT"
