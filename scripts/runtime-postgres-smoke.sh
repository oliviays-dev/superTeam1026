#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-pluginmax-batch7}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.batch7.yml}"
DATABASE_URL_INPUT="${DATABASE_URL:-postgres://pluginmax:pluginmax@127.0.0.1:54379/pluginmax}"
STAMP="$(date +%Y%m%d%H%M%S)"

psql_query() {
  docker-compose -p "$COMPOSE_PROJECT" -f "$ROOT/$COMPOSE_FILE" \
    exec -T postgres psql -U pluginmax -d pluginmax -qAt -v ON_ERROR_STOP=1 -c "$1"
}

psql_database() {
  local database="$1"
  local sql="$2"
  docker-compose -p "$COMPOSE_PROJECT" -f "$ROOT/$COMPOSE_FILE" \
    exec -T postgres psql -U pluginmax -d "$database" -qAt -v ON_ERROR_STOP=1 -c "$sql"
}

upgrade_database="pluginmax_v11_to_v13_$STAMP"
upgrade_database_url="${DATABASE_URL_INPUT%/*}/$upgrade_database"
psql_query "CREATE DATABASE $upgrade_database;"

cleanup() {
  psql_query "DROP DATABASE IF EXISTS $upgrade_database WITH (FORCE);" \
    >/dev/null 2>&1 || true
}
trap cleanup EXIT

DATABASE_URL="$upgrade_database_url" MIGRATION_TARGET_VERSION=11 \
  CI=true pnpm --filter @pluginmax/database exec tsx src/migrate-cli.ts

psql_database "$upgrade_database" "
  INSERT INTO projects (
    id, name, code, description, status, created_at, updated_at
  ) VALUES (
    '20000000-0000-4000-8000-000000000001',
    'V11 runtime project',
    'V11-RUNTIME',
    'migration 12 smoke',
    'active',
    NOW() - INTERVAL '2 hours',
    NOW() - INTERVAL '2 hours'
  );
  INSERT INTO tasks (
    id, project_id, title, description, acceptance, status,
    agent_id, created_at, updated_at
  ) VALUES (
    '20000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000001',
    'V11 runtime task',
    'migration 12 smoke',
    '[]'::jsonb,
    'in_progress',
    '00000000-0000-4000-8000-000000000001',
    NOW() - INTERVAL '2 hours',
    NOW() - INTERVAL '2 hours'
  );
  INSERT INTO runs (
    id, project_id, task_id, agent_id, status, input_snapshot,
    observability, attempt, created_at, updated_at
  ) VALUES (
    '20000000-0000-4000-8000-000000000003',
    '20000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000001',
    'queued',
    '{\"taskTitle\":\"v11\",\"taskDescription\":\"v11\",\"acceptance\":[],\"instruction\":\"v11\",\"agentName\":\"Fake\",\"runtimeKind\":\"fake\"}'::jsonb,
    '{\"planVisibility\":\"structured\",\"toolEventCompleteness\":\"complete\",\"textStreaming\":\"delta\",\"subagentVisibility\":\"none\"}'::jsonb,
    1,
    NOW() - INTERVAL '2 hours',
    NOW() - INTERVAL '2 hours'
  );
  INSERT INTO jobs (
    id, run_id, kind, status, attempts, available_at, created_at, updated_at
  ) VALUES (
    '20000000-0000-4000-8000-000000000004',
    '20000000-0000-4000-8000-000000000003',
    'agent.run',
    'queued',
    0,
    NOW() - INTERVAL '2 hours',
    NOW() - INTERVAL '2 hours',
    NOW() - INTERVAL '2 hours'
  );
  INSERT INTO workflow_definitions (
    id, project_id, name, description, steps, source_md, graph,
    status, created_at, updated_at
  ) VALUES (
    '20000000-0000-4000-8000-000000000005',
    '20000000-0000-4000-8000-000000000001',
    'V11 approval workflow',
    'migration 12 smoke',
    '[]'::jsonb,
    '',
    '{\"key\":\"v11-approval\",\"version\":1,\"name\":\"V11 approval\",\"description\":\"\",\"nodes\":[],\"edges\":[],\"startNodeIds\":[],\"warnings\":[]}'::jsonb,
    'active',
    NOW() - INTERVAL '2 hours',
    NOW() - INTERVAL '2 hours'
  );
  INSERT INTO workflow_instances (
    id, workflow_id, project_id, title, status, current_step, steps,
    definition_key, definition_version, runtime_context, runtime_nodes,
    runtime_edges, revision, created_at, updated_at
  ) VALUES (
    '20000000-0000-4000-8000-000000000006',
    '20000000-0000-4000-8000-000000000005',
    '20000000-0000-4000-8000-000000000001',
    'V11 legacy approval',
    'waiting',
    0,
    '[]'::jsonb,
    'v11-approval',
    1,
    '{}'::jsonb,
    '[]'::jsonb,
    '[]'::jsonb,
    1,
    NOW() - INTERVAL '2 hours',
    NOW() - INTERVAL '2 hours'
  );
  INSERT INTO workflow_approvals (
    id, instance_id, node_id, round, approver_id, kind, status, note,
    created_at
  ) VALUES (
    '20000000-0000-4000-8000-000000000007',
    '20000000-0000-4000-8000-000000000006',
    'approval',
    1,
    'local-admin',
    'primary',
    'pending',
    '',
    NOW() - INTERVAL '2 hours'
  );
  INSERT INTO workflow_idempotency_keys (
    id, scope, operation, idempotency_key, request_hash, state,
    response_status, response_body, created_at, updated_at, completed_at
  ) VALUES (
    '20000000-0000-4000-8000-000000000008',
    'v11', 'legacy', 'legacy-v11', 'hash',
    'completed', 200, '{}'::jsonb,
    NOW() - INTERVAL '2 hours',
    NOW() - INTERVAL '2 hours',
    NOW() - INTERVAL '2 hours'
  );
"

DATABASE_URL="$upgrade_database_url" MIGRATION_TARGET_VERSION=13 CI=true \
  pnpm --filter @pluginmax/database exec tsx src/migrate-cli.ts

version="$(psql_database "$upgrade_database" \
  "SELECT MAX(version) FROM platform_migrations;")"
job_shape="$(psql_database "$upgrade_database" "
  SELECT max_attempts || ':' || (lease_token IS NULL) || ':' || status
  FROM jobs
  WHERE id = '20000000-0000-4000-8000-000000000004';
")"
approval_sla="$(psql_database "$upgrade_database" "
  SELECT
    (due_at IS NOT NULL) || ':' ||
    (remind_at IS NOT NULL) || ':' ||
    (expires_at IS NOT NULL)
  FROM workflow_approvals
  WHERE id = '20000000-0000-4000-8000-000000000007';
")"
reliable_tables="$(psql_database "$upgrade_database" "
  SELECT COUNT(*)
  FROM information_schema.tables
  WHERE table_schema = 'public'
    AND table_name IN (
      'job_attempts',
      'runtime_workers',
      'workflow_idempotency_archive',
      'runtime_maintenance_runs'
    );
")"
v13_tables="$(psql_database "$upgrade_database" "
  SELECT COUNT(*)
  FROM information_schema.tables
  WHERE table_schema = 'public'
    AND table_name IN (
      'runtime_maintenance_schedules',
      'runtime_effect_receipts'
    );
")"
psql_database "$upgrade_database" "
  UPDATE jobs SET status = 'dead_letter'
  WHERE id = '20000000-0000-4000-8000-000000000004';
  INSERT INTO workflow_approvals (
    id, instance_id, node_id, round, approver_id, kind, status, note,
    due_at, remind_at, expires_at, created_at
  ) VALUES (
    '20000000-0000-4000-8000-000000000009',
    '20000000-0000-4000-8000-000000000006',
    'approval',
    1,
    'escalation-user',
    'escalation',
    'pending',
    '',
    NOW() + INTERVAL '1 hour',
    NOW() + INTERVAL '30 minutes',
    NOW() + INTERVAL '2 hours',
    NOW()
  );
"
dead_letter_status="$(psql_database "$upgrade_database" "
  SELECT status FROM jobs
  WHERE id = '20000000-0000-4000-8000-000000000004';
")"
escalation_count="$(psql_database "$upgrade_database" "
  SELECT COUNT(*) FROM workflow_approvals WHERE kind = 'escalation';
")"

if [[ "$version" != "13" ||
      "$job_shape" != "3:true:queued" ||
      "$approval_sla" != "true:true:true" ||
      "$reliable_tables" != "4" ||
      "$v13_tables" != "2" ||
      "$dead_letter_status" != "dead_letter" ||
      "$escalation_count" != "1" ]]; then
  printf 'v11 to v13 smoke failed: version=%s job=%s sla=%s tables=%s v13_tables=%s dead_letter=%s escalation=%s\n' \
    "$version" "$job_shape" "$approval_sla" "$reliable_tables" \
    "$v13_tables" "$dead_letter_status" "$escalation_count" >&2
  exit 1
fi

printf 'runtime_postgres_smoke=ok\n'
printf 'database=%s\n' "$upgrade_database"
printf 'migration_version=%s\n' "$version"
printf 'job_backfill=%s\n' "$job_shape"
printf 'approval_sla_backfill=%s\n' "$approval_sla"
printf 'reliability_tables=%s\n' "$reliable_tables"
printf 'maintenance_effect_tables=%s\n' "$v13_tables"
printf 'dead_letter_constraint=%s\n' "$dead_letter_status"
printf 'escalation_constraint_count=%s\n' "$escalation_count"
