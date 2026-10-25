#!/usr/bin/env bash
set -euo pipefail

API_BASE="${API_BASE:-http://127.0.0.1:4430/api/v1}"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-pluginmax-batch5}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.batch5.yml}"
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
  psql_query "SELECT version FROM platform_migrations WHERE version = 10;"
)"

if [[ "$definition_key" != "legacy-$STAMP" ||
      "$definition_version" != "7" ||
      "$runtime_node_count" != "1" ||
      "$runtime_node_status" != "completed" ||
      "$migration_version" != "10" ]]; then
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
