#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-pluginmax-batch8}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.batch8.yml}"
DATABASE_URL_INPUT="${DATABASE_URL:-postgres://pluginmax:pluginmax@127.0.0.1:54389/pluginmax}"
STAMP="$(date +%Y%m%d%H%M%S)"

compose() {
  "$ROOT/scripts/db-compose.sh" -p "$COMPOSE_PROJECT" -f "$ROOT/$COMPOSE_FILE" "$@"
}

psql_query() {
  local database="$1"
  local sql="$2"
  compose exec -T postgres psql \
    -U pluginmax -d "$database" -qAt -v ON_ERROR_STOP=1 -c "$sql"
}

compose up -d postgres >/dev/null
for _ in {1..60}; do
  if compose exec -T postgres pg_isready \
    -U pluginmax -d pluginmax >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

upgrade_database="pluginmax_v12_to_v13_$STAMP"
upgrade_database_url="${DATABASE_URL_INPUT%/*}/$upgrade_database"
psql_query postgres "CREATE DATABASE $upgrade_database;"

cleanup() {
  psql_query postgres \
    "DROP DATABASE IF EXISTS $upgrade_database WITH (FORCE);" \
    >/dev/null 2>&1 || true
}
trap cleanup EXIT

DATABASE_URL="$upgrade_database_url" MIGRATION_TARGET_VERSION=12 \
  CI=true pnpm --filter @pluginmax/database exec tsx src/migrate-cli.ts

psql_query "$upgrade_database" "
  INSERT INTO projects (
    id, name, code, description, status, created_at, updated_at
  ) VALUES (
    '30000000-0000-4000-8000-000000000001',
    'V12 effects project',
    'V12-EFFECTS',
    'migration 13 smoke',
    'active',
    NOW(),
    NOW()
  );
  INSERT INTO tasks (
    id, project_id, title, description, acceptance, status,
    agent_id, created_at, updated_at
  ) VALUES (
    '30000000-0000-4000-8000-000000000002',
    '30000000-0000-4000-8000-000000000001',
    'V12 effects task',
    'migration 13 smoke',
    '[]'::jsonb,
    'in_progress',
    '00000000-0000-4000-8000-000000000001',
    NOW(),
    NOW()
  );
  INSERT INTO runs (
    id, project_id, task_id, agent_id, status, input_snapshot,
    observability, attempt, created_at, updated_at
  ) VALUES (
    '30000000-0000-4000-8000-000000000003',
    '30000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000001',
    'running',
    '{\"taskTitle\":\"v12\",\"taskDescription\":\"v12\",\"acceptance\":[],\"instruction\":\"v12\",\"agentName\":\"Fake\",\"runtimeKind\":\"fake\"}'::jsonb,
    '{\"planVisibility\":\"structured\",\"toolEventCompleteness\":\"complete\",\"textStreaming\":\"delta\",\"subagentVisibility\":\"none\"}'::jsonb,
    1,
    NOW(),
    NOW()
  );
  INSERT INTO jobs (
    id, run_id, kind, status, attempts, available_at, created_at, updated_at
  ) VALUES (
    '30000000-0000-4000-8000-000000000004',
    '30000000-0000-4000-8000-000000000003',
    'agent.run',
    'running',
    1,
    NOW(),
    NOW(),
    NOW()
  );
  INSERT INTO runtime_maintenance_runs (
    id, kind, status, processed_count, metrics, started_at, completed_at
  ) VALUES (
    '30000000-0000-4000-8000-000000000005',
    'approval_sla',
    'completed',
    0,
    '{}'::jsonb,
    NOW() - INTERVAL '1 minute',
    NOW()
  );
"

DATABASE_URL="$upgrade_database_url" MIGRATION_TARGET_VERSION=13 CI=true \
  pnpm --filter @pluginmax/database exec tsx src/migrate-cli.ts

version="$(psql_query "$upgrade_database" \
  "SELECT MAX(version) FROM platform_migrations;")"
schedule_count="$(psql_query "$upgrade_database" \
  "SELECT COUNT(*) FROM runtime_maintenance_schedules;")"
effect_table="$(psql_query "$upgrade_database" "
  SELECT COUNT(*)
  FROM information_schema.tables
  WHERE table_schema = 'public'
    AND table_name = 'runtime_effect_receipts';
")"
legacy_trigger="$(psql_query "$upgrade_database" "
  SELECT trigger_source
  FROM runtime_maintenance_runs
  WHERE id = '30000000-0000-4000-8000-000000000005';
")"
postgres_definition="$(psql_query "$upgrade_database" "
  SELECT
    EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'job_attempts'
        AND column_name = 'lease_jitter_ms'
    ) || ':' || EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'runtime_effect_receipts'
        AND column_name = 'replay_count'
    );
")"

psql_query "$upgrade_database" "
  INSERT INTO runtime_effect_receipts (
    id, effect_key, run_id, job_id, operation, status, attempt,
    lease_owner, lease_token, lease_expires_at, started_at, updated_at
  ) VALUES (
    '30000000-0000-4000-8000-000000000006',
    'run:30000000-0000-4000-8000-000000000003:agent.execute:v1',
    '30000000-0000-4000-8000-000000000003',
    '30000000-0000-4000-8000-000000000004',
    'agent.execute',
    'running',
    1,
    'worker-smoke',
    '30000000-0000-4000-8000-000000000007',
    NOW() + INTERVAL '1 minute',
    NOW(),
    NOW()
  );
  UPDATE runtime_effect_receipts
  SET
    status = 'cancelled',
    cancel_requested_at = NOW(),
    cancel_acknowledged_at = NOW(),
    completed_at = NOW()
  WHERE id = '30000000-0000-4000-8000-000000000006';
"

cancel_state="$(psql_query "$upgrade_database" "
  SELECT status || ':' || (cancel_acknowledged_at IS NOT NULL)
  FROM runtime_effect_receipts
  WHERE id = '30000000-0000-4000-8000-000000000006';
")"

if [[ "$version" != "13" ||
      "$schedule_count" != "4" ||
      "$effect_table" != "1" ||
      "$legacy_trigger" != "legacy" ||
      "$postgres_definition" != "true:true" ||
      "$cancel_state" != "cancelled:true" ]]; then
  printf 'v12 to v13 smoke failed: version=%s schedules=%s effect_table=%s legacy_trigger=%s columns=%s cancel=%s\n' \
    "$version" "$schedule_count" "$effect_table" "$legacy_trigger" \
    "$postgres_definition" "$cancel_state" >&2
  exit 1
fi

printf 'maintenance_effects_postgres_smoke=ok\n'
printf 'database=%s\n' "$upgrade_database"
printf 'migration_version=%s\n' "$version"
printf 'maintenance_schedules=%s\n' "$schedule_count"
printf 'effect_table=%s\n' "$effect_table"
printf 'legacy_trigger=%s\n' "$legacy_trigger"
printf 'effect_columns=%s\n' "$postgres_definition"
printf 'cancel_state=%s\n' "$cancel_state"
