#!/usr/bin/env bash
set -euo pipefail

API_BASE="${API_BASE:-http://127.0.0.1:4440/api/v1}"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-pluginmax-batch6}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.batch6.yml}"
DATABASE_URL_INPUT="${DATABASE_URL:-postgres://pluginmax:pluginmax@127.0.0.1:54369/pluginmax}"
STAMP="$(date +%Y%m%d-%H%M%S)"
RESPONSE=""
STATUS=""

request() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  local output
  local args=(-sS -X "$method" "$API_BASE$path" -w $'\n%{http_code}')
  if [[ -n "$body" ]]; then
    args+=(-H "content-type: application/json" -d "$body")
  fi
  output="$(curl "${args[@]}")"
  STATUS="${output##*$'\n'}"
  RESPONSE="${output%$'\n'*}"
}

psql_query() {
  docker-compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" \
    exec -T postgres psql -U pluginmax -d pluginmax -qAt -v ON_ERROR_STOP=1 -c "$1"
}

psql_database() {
  local database="$1"
  local sql="$2"
  docker-compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" \
    exec -T postgres psql -U pluginmax -d "$database" -qAt -v ON_ERROR_STOP=1 -c "$sql"
}

upgrade_database="pluginmax_v10_$(printf '%s' "$STAMP" | tr -d '-')"
upgrade_database_url="${DATABASE_URL_INPUT%/*}/$upgrade_database"
psql_query "CREATE DATABASE $upgrade_database;"
DATABASE_URL="$upgrade_database_url" MIGRATION_TARGET_VERSION=10 \
  pnpm --filter @pluginmax/database exec tsx src/migrate-cli.ts

psql_database "$upgrade_database" "
  INSERT INTO projects (
    id, name, code, description, status, created_at, updated_at
  ) VALUES (
    '00000000-0000-4000-8000-000000000611',
    'V10 upgrade project',
    'V10-UPGRADE',
    'batch 6 migration smoke',
    'active',
    NOW(),
    NOW()
  );
  INSERT INTO workflow_definitions (
    id, project_id, name, description, steps, source_md, graph,
    status, created_at, updated_at
  ) VALUES (
    '00000000-0000-4000-8000-000000000612',
    '00000000-0000-4000-8000-000000000611',
    'V10 workflow',
    'pre-migration definition',
    '[]'::jsonb,
    '',
    NULL,
    'active',
    NOW(),
    NOW()
  );
  INSERT INTO workflow_instances (
    id, workflow_id, project_id, title, status, current_step, steps,
    definition_key, definition_version, runtime_context, runtime_nodes,
    runtime_edges, revision, created_at, updated_at
  ) VALUES (
    '00000000-0000-4000-8000-000000000613',
    '00000000-0000-4000-8000-000000000612',
    '00000000-0000-4000-8000-000000000611',
    'V10 legacy instance',
    'waiting',
    0,
    '[]'::jsonb,
    'v10-workflow',
    10,
    '{}'::jsonb,
    '[]'::jsonb,
    '[]'::jsonb,
    1,
    NOW(),
    NOW()
  );
  INSERT INTO workflow_command_receipts (
    id, instance_id, command_key, idempotency_key, created_at
  ) VALUES (
    '00000000-0000-4000-8000-000000000614',
    '00000000-0000-4000-8000-000000000613',
    'legacy-command',
    'legacy-key',
    NOW()
  );
"

DATABASE_URL="$upgrade_database_url" \
  pnpm --filter @pluginmax/database exec tsx src/migrate-cli.ts

upgrade_version="$(
  psql_database "$upgrade_database" \
    "SELECT MAX(version) FROM platform_migrations;"
)"
upgrade_instance_count="$(
  psql_database "$upgrade_database" \
    "SELECT COUNT(*) FROM workflow_instances WHERE id = '00000000-0000-4000-8000-000000000613' AND definition_key = 'v10-workflow';"
)"
upgrade_receipt_state="$(
  psql_database "$upgrade_database" \
    "SELECT state || ':' || request_hash FROM workflow_command_receipts WHERE idempotency_key = 'legacy-key';"
)"
upgrade_reconciled_at="$(
  psql_database "$upgrade_database" \
    "SELECT last_reconciled_at IS NOT NULL FROM workflow_instances WHERE id = '00000000-0000-4000-8000-000000000613';"
)"
if [[ "$upgrade_version" != "11" ||
      "$upgrade_instance_count" != "1" ||
      "$upgrade_receipt_state" != "completed:legacy-v10" ||
      "$upgrade_reconciled_at" != "t" ]]; then
  printf 'v10 to v11 upgrade failed: version=%s instances=%s receipt=%s reconciled=%s\n' \
    "$upgrade_version" "$upgrade_instance_count" "$upgrade_receipt_state" \
    "$upgrade_reconciled_at" >&2
  exit 1
fi
psql_query "DROP DATABASE $upgrade_database WITH (FORCE);"

request POST /projects \
  "$(jq -n --arg name "Workflow migration smoke $STAMP" \
    '{name: $name, description: "batch 5 migration smoke"}')"
if [[ "$STATUS" != "201" ]]; then
  printf 'create migration project failed: %s %s\n' "$STATUS" "$RESPONSE" >&2
  exit 1
fi
project_id="$(printf '%s' "$RESPONSE" | jq -r '.id')"

definition_id="$(
  psql_query "
    INSERT INTO workflow_definitions (
      id, project_id, name, description, steps, source_md, graph,
      status, created_at, updated_at
    ) VALUES (
      gen_random_uuid(),
      '$project_id',
      'Legacy workflow $STAMP',
      'pre-batch5 linear row',
      jsonb_build_array(
        jsonb_build_object(
          'id', gen_random_uuid(),
          'name', 'Legacy step',
          'kind', 'human'
        )
      ),
      '',
      jsonb_build_object(
        'key', 'legacy-$STAMP',
        'version', 7,
        'name', 'Legacy workflow $STAMP',
        'description', 'pre-batch5 linear row',
        'nodes', jsonb_build_array(
          jsonb_build_object(
            'id', 'legacy-node',
            'name', 'Legacy step',
            'type', 'service',
            'executor', jsonb_build_object('kind', 'user', 'id', 'local-admin'),
            'description', '',
            'approvers', '[]'::jsonb,
            'approvalPolicy', 'all',
            'autoDispatch', false,
            'start', false,
            'maxAttempts', 1,
            'timeoutSeconds', 300
          )
        ),
        'edges', '[]'::jsonb,
        'startNodeIds', jsonb_build_array('legacy-node'),
        'warnings', '[]'::jsonb
      ),
      'active',
      NOW(),
      NOW()
    )
    RETURNING id;
  " | tail -n 1
)"

instance_id="$(
  psql_query "
    INSERT INTO workflow_instances (
      id, workflow_id, project_id, title, status, current_step,
      steps, created_at, updated_at
    ) VALUES (
      gen_random_uuid(),
      '$definition_id',
      '$project_id',
      'Legacy instance $STAMP',
      'completed',
      0,
      jsonb_build_array(
        jsonb_build_object(
          'stepId', gen_random_uuid(),
          'name', 'Legacy step',
          'kind', 'human',
          'status', 'completed',
          'completedAt', NOW()
        )
      ),
      NOW(),
      NOW()
    )
    RETURNING id;
  " | tail -n 1
)"

request GET "/workflow-instances/$instance_id"
if [[ "$STATUS" != "200" ]]; then
  printf 'legacy instance read failed: %s %s\n' "$STATUS" "$RESPONSE" >&2
  exit 1
fi

definition_key="$(printf '%s' "$RESPONSE" | jq -r '.definitionKey')"
definition_version="$(printf '%s' "$RESPONSE" | jq -r '.definitionVersion')"
runtime_node_count="$(printf '%s' "$RESPONSE" | jq '.runtime.nodes | length')"
runtime_node_status="$(
  printf '%s' "$RESPONSE" |
    jq -r '.runtime.nodes[] | select(.nodeId == "legacy-node") | .status'
)"
migration_version="$(
    psql_query "SELECT version FROM platform_migrations WHERE version = 11;"
)"

if [[ "$definition_key" != "legacy-$STAMP" ||
      "$definition_version" != "7" ||
      "$runtime_node_count" != "1" ||
      "$runtime_node_status" != "completed" ||
      "$migration_version" != "11" ]]; then
  printf 'legacy migration verification failed\n' >&2
  printf 'definitionKey=%s version=%s nodes=%s status=%s migration=%s\n' \
    "$definition_key" "$definition_version" "$runtime_node_count" \
    "$runtime_node_status" "$migration_version" >&2
  exit 1
fi

printf 'workflow_postgres_smoke=ok\n'
printf 'project_id=%s\n' "$project_id"
printf 'legacy_instance_id=%s\n' "$instance_id"
printf 'migration_version=%s\n' "$migration_version"
printf 'legacy_nodes=%s\n' "$runtime_node_count"
