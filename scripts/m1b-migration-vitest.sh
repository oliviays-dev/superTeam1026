#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COMPOSE_PROJECT="${M1B_MIGRATION_COMPOSE_PROJECT:-pluginmax-m1b-migration}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.core-regression.yml}"
PORT="${M1B_MIGRATION_POSTGRES_PORT:-54443}"
export CORE_REGRESSION_POSTGRES_PORT="$PORT"
DATABASE_URL_INPUT="${DATABASE_URL:-postgres://pluginmax:pluginmax@127.0.0.1:${PORT}/pluginmax}"
STAMP="$(date -u +%Y%m%d%H%M%S)"
EMPTY_DATABASE="pluginmax_m1b_empty_${STAMP}"
UPGRADE_DATABASE="pluginmax_m1b_upgrade_${STAMP}"
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
  if [[ "${M1B_MIGRATION_KEEP_ENV:-0}" != "1" ]]; then
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
FRESH_FLAGS="$(psql_database "$EMPTY_DATABASE" \
  "SELECT flag_key || '=' || mode
   FROM feature_flag_settings
   WHERE flag_key IN ('agent.task_tools', 'agent.workspace_files')
   ORDER BY flag_key;")"
FRESH_TABLE="$(psql_database "$EMPTY_DATABASE" \
  "SELECT to_regclass('public.tool_invocations') IS NOT NULL;")"

[[ "$FRESH_VERSION" == "40" ]]
[[ "$FRESH_FLAGS" == $'agent.task_tools=off\nagent.workspace_files=off' ]]
[[ "$FRESH_TABLE" == "t" ]]

DATABASE_URL="$UPGRADE_URL" MIGRATION_TARGET_VERSION=36 \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null
psql_database "$UPGRADE_DATABASE" "
INSERT INTO projects (
  id, name, code, description, status, created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000003700',
  'M1b migration snapshot',
  'M1B-MIG-37',
  '',
  'active',
  NOW(),
  NOW()
);
INSERT INTO tasks (
  id, project_id, title, description, acceptance, status, agent_id,
  created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000003701',
  '00000000-0000-4000-8000-000000003700',
  'M1b migration task',
  'Legacy application compatibility',
  '[\"Required item\"]'::jsonb,
  'review',
  '00000000-0000-4000-8000-000000000001',
  NOW(),
  NOW()
);"

DATABASE_URL="$UPGRADE_URL" \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null

UPGRADE_VERSION="$(psql_database "$UPGRADE_DATABASE" \
  "SELECT MAX(version) FROM platform_migrations;")"
UPGRADE_TABLE="$(psql_database "$UPGRADE_DATABASE" \
  "SELECT to_regclass('public.tool_invocations') IS NOT NULL;")"
UPGRADE_FLAGS="$(psql_database "$UPGRADE_DATABASE" \
  "SELECT string_agg(flag_key || '=' || mode, ',' ORDER BY flag_key)
   FROM feature_flag_settings
   WHERE flag_key IN ('agent.task_tools', 'agent.workspace_files');")"
OLD_APP_READ="$(psql_database "$UPGRADE_DATABASE" \
  "SELECT acceptance::text || '|' || status
   FROM tasks
   WHERE id = '00000000-0000-4000-8000-000000003701';")"
psql_database "$UPGRADE_DATABASE" "
INSERT INTO task_reviews (
  id, task_id, decision, note, actor_id, created_at
) VALUES (
  '00000000-0000-4000-8000-000000003702',
  '00000000-0000-4000-8000-000000003701',
  'return',
  'legacy application write remains compatible',
  'local-admin',
  NOW()
);" >/dev/null
OLD_APP_REVIEW="$(psql_database "$UPGRADE_DATABASE" \
  "SELECT decision || '|' || actor_id
   FROM task_reviews
   WHERE id = '00000000-0000-4000-8000-000000003702';")"

[[ "$UPGRADE_VERSION" == "40" ]]
[[ "$UPGRADE_TABLE" == "t" ]]
[[ "$UPGRADE_FLAGS" == "agent.task_tools=off,agent.workspace_files=off" ]]
[[ "$OLD_APP_READ" == '["Required item"]|review' ]]
[[ "$OLD_APP_REVIEW" == "return|local-admin" ]]

printf 'fresh_migration=0->%s\n' "$FRESH_VERSION"
printf 'fresh_flags=%s\n' "$(printf '%s' "$FRESH_FLAGS" | tr '\n' ',')"
printf 'upgrade_migration=36->%s\n' "$UPGRADE_VERSION"
printf 'upgrade_flags=%s\n' "$UPGRADE_FLAGS"
printf 'old_app_read=%s\n' "$OLD_APP_READ"
printf 'old_app_review=%s\n' "$OLD_APP_REVIEW"
