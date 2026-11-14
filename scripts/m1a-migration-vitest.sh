#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COMPOSE_PROJECT="${M1A_COMPOSE_PROJECT:-pluginmax-m1a-migration}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.core-regression.yml}"
PORT="${M1A_POSTGRES_PORT:-54441}"
export CORE_REGRESSION_POSTGRES_PORT="$PORT"
DATABASE_URL_INPUT="${DATABASE_URL:-postgres://pluginmax:pluginmax@127.0.0.1:${PORT}/pluginmax}"
STAMP="$(date -u +%Y%m%d%H%M%S)"
EMPTY_DATABASE="pluginmax_m1a_empty_${STAMP}"
UPGRADE_DATABASE="pluginmax_m1a_upgrade_${STAMP}"
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
  if [[ "${M1A_KEEP_ENV:-0}" != "1" ]]; then
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
EMPTY_VERSION="$(psql_database "$EMPTY_DATABASE" \
  "SELECT MAX(version) FROM platform_migrations;")"
EMPTY_COUNT="$(psql_database "$EMPTY_DATABASE" \
  "SELECT COUNT(*) FROM platform_migrations;")"
EMPTY_TABLES="$(psql_database "$EMPTY_DATABASE" \
  "SELECT COUNT(*)
   FROM information_schema.tables
   WHERE table_schema = 'public'
     AND table_name IN (
       'feature_flag_settings',
       'task_acceptance_items',
       'task_acceptance_item_revisions',
       'task_acceptance_confirmations',
       'task_execution_anomalies'
       ,'tool_invocations'
     );")"
EMPTY_FLAGS="$(psql_database "$EMPTY_DATABASE" \
  "SELECT flag_key || '=' || mode
   FROM feature_flag_settings
   WHERE scope_type = 'platform' AND scope_id = 'platform'
   ORDER BY flag_key;")"

[[ "$EMPTY_VERSION" == "40" ]]
[[ "$EMPTY_COUNT" == "40" ]]
[[ "$EMPTY_TABLES" == "6" ]]
[[ "$EMPTY_FLAGS" == $'agent.task_tools=off\nagent.workspace_files=off\ntask.anomaly=off\ntask.evidence_review=observe\nworkflow.assignment_bindings=off\nworkflow.platform_templates=off' ]]
printf 'fresh_migration=0->%s\n' "$EMPTY_VERSION"
printf 'fresh_tables=%s\n' "$EMPTY_TABLES"
printf 'fresh_flags=%s\n' "$(printf '%s' "$EMPTY_FLAGS" | tr '\n' ',')"

DATABASE_URL="$UPGRADE_URL" MIGRATION_TARGET_VERSION=34 \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null
psql_database "$UPGRADE_DATABASE" "
INSERT INTO projects (
  id, name, code, description, status, created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000003600',
  'M1a migration snapshot',
  'M1A-MIG-36',
  '',
  'active',
  NOW(),
  NOW()
);
INSERT INTO tasks (
  id, project_id, title, description, acceptance, status, agent_id,
  created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000003601',
  '00000000-0000-4000-8000-000000003600',
  'M1a migration task',
  'Preserve legacy acceptance',
  '[\"First required item\",\"Second required item\"]'::jsonb,
  'review',
  '00000000-0000-4000-8000-000000000001',
  NOW(),
  NOW()
);
"

DATABASE_URL="$UPGRADE_URL" \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null
UPGRADE_VERSION="$(psql_database "$UPGRADE_DATABASE" \
  "SELECT MAX(version) FROM platform_migrations;")"
UPGRADE_ITEMS="$(psql_database "$UPGRADE_DATABASE" \
  "SELECT COUNT(*)
   FROM task_acceptance_items
   WHERE task_id = '00000000-0000-4000-8000-000000003601';")"
UPGRADE_REVISIONS="$(psql_database "$UPGRADE_DATABASE" \
  "SELECT COUNT(*)
   FROM task_acceptance_item_revisions AS revision
   JOIN task_acceptance_items AS item ON item.id = revision.acceptance_item_id
   WHERE item.task_id = '00000000-0000-4000-8000-000000003601';")"
UPGRADE_REQUIRED="$(psql_database "$UPGRADE_DATABASE" \
  "SELECT bool_and(required)
   FROM task_acceptance_items
   WHERE task_id = '00000000-0000-4000-8000-000000003601';")"
UPGRADE_DIGESTS="$(psql_database "$UPGRADE_DATABASE" \
  "SELECT bool_and(content_digest ~ '^[a-f0-9]{64}$')
   FROM task_acceptance_items
   WHERE task_id = '00000000-0000-4000-8000-000000003601';")"
OLD_APP_READ="$(psql_database "$UPGRADE_DATABASE" \
  "SELECT acceptance::text || '|' || status
   FROM tasks
   WHERE id = '00000000-0000-4000-8000-000000003601';")"
psql_database "$UPGRADE_DATABASE" "
INSERT INTO task_reviews (
  id, task_id, decision, note, actor_id, created_at
) VALUES (
  '00000000-0000-4000-8000-000000003602',
  '00000000-0000-4000-8000-000000003601',
  'return',
  'legacy application write remains compatible',
  'local-admin',
  NOW()
);
" >/dev/null
OLD_APP_REVIEW="$(psql_database "$UPGRADE_DATABASE" \
  "SELECT decision || '|' || actor_id
   FROM task_reviews
   WHERE id = '00000000-0000-4000-8000-000000003602';")"
CONFLICT_CHECK="$(psql_database "$UPGRADE_DATABASE" \
  "SELECT
     (SELECT COUNT(*) FROM (
        SELECT task_id, position
        FROM task_acceptance_items
        WHERE deprecated_at IS NULL
        GROUP BY task_id, position
        HAVING COUNT(*) > 1
      ) AS acceptance_conflicts)
     +
     (SELECT COUNT(*) FROM (
        SELECT task_id, COALESCE(run_id, '00000000-0000-0000-0000-000000000000'::uuid), code
        FROM task_execution_anomalies
        WHERE status = 'active'
        GROUP BY task_id, COALESCE(run_id, '00000000-0000-0000-0000-000000000000'::uuid), code
        HAVING COUNT(*) > 1
      ) AS anomaly_conflicts);")"

[[ "$UPGRADE_VERSION" == "40" ]]
[[ "$UPGRADE_ITEMS" == "2" ]]
[[ "$UPGRADE_REVISIONS" == "2" ]]
[[ "$UPGRADE_REQUIRED" == "t" ]]
[[ "$UPGRADE_DIGESTS" == "t" ]]
[[ "$OLD_APP_READ" == '["First required item", "Second required item"]|review' ]]
[[ "$OLD_APP_REVIEW" == "return|local-admin" ]]
[[ "$CONFLICT_CHECK" == "0" ]]

printf 'upgrade_migration=34->%s\n' "$UPGRADE_VERSION"
printf 'acceptance_items=%s\n' "$UPGRADE_ITEMS"
printf 'acceptance_revisions=%s\n' "$UPGRADE_REVISIONS"
printf 'legacy_required=%s\n' "$UPGRADE_REQUIRED"
printf 'legacy_digests=%s\n' "$UPGRADE_DIGESTS"
printf 'old_app_read=%s\n' "$OLD_APP_READ"
printf 'old_app_review=%s\n' "$OLD_APP_REVIEW"
printf 'constraint_conflicts=%s\n' "$CONFLICT_CHECK"
