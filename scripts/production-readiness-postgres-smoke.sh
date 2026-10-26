#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-pluginmax-batch9}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.batch9.yml}"
DATABASE_URL_INPUT="${DATABASE_URL:-postgres://pluginmax:pluginmax@127.0.0.1:54399/pluginmax}"
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

upgrade_database="pluginmax_v13_to_v14_$STAMP"
upgrade_database_url="${DATABASE_URL_INPUT%/*}/$upgrade_database"
psql_database postgres "CREATE DATABASE $upgrade_database;"

cleanup() {
  psql_database postgres \
    "DROP DATABASE IF EXISTS $upgrade_database WITH (FORCE);" \
    >/dev/null 2>&1 || true
}
trap cleanup EXIT

DATABASE_URL="$upgrade_database_url" MIGRATION_TARGET_VERSION=13 CI=true \
  pnpm --filter @pluginmax/database exec tsx src/migrate-cli.ts >/dev/null

psql_database "$upgrade_database" "
  INSERT INTO projects (
    id, name, code, description, status, created_at, updated_at
  ) VALUES (
    '40000000-0000-4000-8000-000000000001',
    'V13 production readiness',
    'V13-PROD',
    'migration 14 smoke',
    'active',
    NOW(),
    NOW()
  );
  INSERT INTO tasks (
    id, project_id, title, description, acceptance, status,
    agent_id, created_at, updated_at
  ) VALUES (
    '40000000-0000-4000-8000-000000000002',
    '40000000-0000-4000-8000-000000000001',
    'V13 trace task',
    'migration 14 smoke',
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
    '40000000-0000-4000-8000-000000000003',
    '40000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000001',
    'running',
    '{\"taskTitle\":\"trace\",\"taskDescription\":\"trace\",\"acceptance\":[],\"instruction\":\"trace\",\"agentName\":\"Fake\",\"runtimeKind\":\"fake\"}'::jsonb,
    '{\"planVisibility\":\"structured\",\"toolEventCompleteness\":\"complete\",\"textStreaming\":\"delta\",\"subagentVisibility\":\"none\"}'::jsonb,
    1,
    NOW(),
    NOW()
  );
  INSERT INTO run_events (
    id, run_id, seq, type, visibility, summary, data, created_at
  ) VALUES (
    '40000000-0000-4000-8000-000000000004',
    '40000000-0000-4000-8000-000000000003',
    1,
    'run.started',
    'public',
    'legacy event',
    '{}'::jsonb,
    NOW()
  );
  INSERT INTO jobs (
    id, run_id, kind, status, attempts, max_attempts, available_at,
    lease_owner, lease_expires_at, created_at, updated_at
  ) VALUES (
    '40000000-0000-4000-8000-000000000005',
    '40000000-0000-4000-8000-000000000003',
    'agent.run',
    'running',
    1,
    3,
    NOW(),
    'worker-v13',
    NOW() + INTERVAL '1 minute',
    NOW(),
    NOW()
  );
  INSERT INTO job_attempts (
    id, job_id, attempt, worker_id, lease_token, status,
    started_at, heartbeat_at
  ) VALUES (
    '40000000-0000-4000-8000-000000000006',
    '40000000-0000-4000-8000-000000000005',
    1,
    'worker-v13',
    '40000000-0000-4000-8000-000000000007',
    'running',
    NOW(),
    NOW()
  );
  INSERT INTO runtime_effect_receipts (
    id, effect_key, run_id, job_id, operation, status, attempt,
    lease_owner, lease_token, lease_expires_at, started_at, updated_at
  ) VALUES (
    '40000000-0000-4000-8000-000000000008',
    'run:40000000-0000-4000-8000-000000000003:agent.execute:v1',
    '40000000-0000-4000-8000-000000000003',
    '40000000-0000-4000-8000-000000000005',
    'agent.execute',
    'running',
    1,
    'worker-v13',
    '40000000-0000-4000-8000-000000000009',
    NOW() + INTERVAL '1 minute',
    NOW(),
    NOW()
  );
  INSERT INTO runtime_maintenance_runs (
    id, kind, status, processed_count, metrics, started_at, completed_at
  ) VALUES (
    '40000000-0000-4000-8000-000000000010',
    'effect_recovery',
    'completed',
    0,
    '{}'::jsonb,
    NOW() - INTERVAL '1 minute',
    NOW()
  );
  INSERT INTO task_events (
    id, task_id, kind, actor_id, actor_name, summary, data, created_at
  ) VALUES (
    '40000000-0000-4000-8000-000000000011',
    '40000000-0000-4000-8000-000000000002',
    'dispatch',
    'local-admin',
    'Local Admin',
    'legacy dispatch',
    '{}'::jsonb,
    NOW()
  );
"

DATABASE_URL="$upgrade_database_url" MIGRATION_TARGET_VERSION=14 CI=true \
  pnpm --filter @pluginmax/database exec tsx src/migrate-cli.ts >/dev/null

psql_database "$upgrade_database" "
  INSERT INTO task_events (
    id, task_id, kind, actor_id, actor_name, summary, data, created_at
  ) VALUES (
    '40000000-0000-4000-8000-000000000012',
    '40000000-0000-4000-8000-000000000002',
    'transfer',
    'local-admin',
    'Local Admin',
    'migration 14 transfer',
    '{}'::jsonb,
    NOW()
  );
"

version="$(psql_database "$upgrade_database" \
  'SELECT MAX(version) FROM platform_migrations;')"
trace_shape="$(psql_database "$upgrade_database" "
  SELECT
    run.trace_id = event.trace_id AND
    run.trace_id = job.trace_id AND
    run.trace_id = effect.trace_id
  FROM runs AS run
  JOIN run_events AS event ON event.run_id = run.id
  JOIN jobs AS job ON job.run_id = run.id
  JOIN runtime_effect_receipts AS effect ON effect.run_id = run.id
  WHERE run.id = '40000000-0000-4000-8000-000000000003';
")"
attempt_trace="$(psql_database "$upgrade_database" "
  SELECT attempt.trace_id = job.trace_id
    AND attempt.span_id ~ '^[0-9a-f]{16}$'
  FROM job_attempts AS attempt
  JOIN jobs AS job ON job.id = attempt.job_id
  WHERE attempt.id = '40000000-0000-4000-8000-000000000006';
")"
maintenance_trace="$(psql_database "$upgrade_database" "
  SELECT trace_id ~ '^[0-9a-f]{32}$' AND span_id ~ '^[0-9a-f]{16}$'
  FROM runtime_maintenance_runs
  WHERE id = '40000000-0000-4000-8000-000000000010';
")"
trace_columns="$(psql_database "$upgrade_database" "
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
transfer_kind="$(psql_database "$upgrade_database" "
  SELECT COUNT(*)
  FROM task_events
  WHERE kind = 'transfer';
")"

if [[ "$version" != "14" ||
      "$trace_shape" != "t" ||
      "$attempt_trace" != "t" ||
      "$maintenance_trace" != "t" ||
      "$trace_columns" != "6" ||
      "$transfer_kind" != "1" ]]; then
  printf 'v13 to v14 smoke failed: version=%s trace=%s attempt=%s maintenance=%s columns=%s transfer=%s\n' \
    "$version" "$trace_shape" "$attempt_trace" "$maintenance_trace" \
    "$trace_columns" "$transfer_kind" >&2
  exit 1
fi

printf 'production_readiness_postgres_smoke=ok\n'
printf 'database=%s\n' "$upgrade_database"
printf 'migration_version=%s\n' "$version"
printf 'legacy_trace_shape=%s\n' "$trace_shape"
printf 'attempt_trace=%s\n' "$attempt_trace"
printf 'maintenance_trace=%s\n' "$maintenance_trace"
printf 'trace_columns=%s\n' "$trace_columns"
printf 'transfer_kind=%s\n' "$transfer_kind"
