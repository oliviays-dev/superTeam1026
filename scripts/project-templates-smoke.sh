#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COMPOSE_PROJECT="${COMPOSE_PROJECT:-pluginmax-batch11b}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.batch11b.yml}"
DATABASE_URL_INPUT="${DATABASE_URL:-postgres://pluginmax:pluginmax@127.0.0.1:54418/pluginmax}"
API_PORT="${API_PORT:-4473}"
STAMP="$(date -u +%Y%m%d%H%M%S)"
DATABASE_NAME="pluginmax_batch11b_smoke_$STAMP"
DATABASE_URL="${DATABASE_URL_INPUT%/*}/$DATABASE_NAME"
API_BASE="http://127.0.0.1:$API_PORT/api/v1"
LOG_DIR="${LOG_DIR:-$ROOT/.tmp/batch11b}"
PIDS=()

mkdir -p "$LOG_DIR"

compose() {
  "$ROOT/scripts/db-compose.sh" -p "$COMPOSE_PROJECT" -f "$ROOT/$COMPOSE_FILE" "$@"
}

psql_database() {
  local database="$1"
  local sql="$2"
  compose exec -T postgres psql -U pluginmax -d "$database" \
    -qAt -v ON_ERROR_STOP=1 -c "$sql"
}

stop_pid() {
  local pid="$1"
  if kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null || true
  fi
}

cleanup() {
  local pid
  for pid in "${PIDS[@]:-}"; do
    stop_pid "$pid"
  done
  for pid in "${PIDS[@]:-}"; do
    wait "$pid" 2>/dev/null || true
  done
  psql_database postgres \
    "DROP DATABASE IF EXISTS $DATABASE_NAME WITH (FORCE);" \
    >/dev/null 2>&1 || true
}
trap cleanup EXIT

start_process() {
  local name="$1"
  shift
  "$@" >"$LOG_DIR/$name.log" 2>&1 &
  PIDS+=("$!")
}

wait_http() {
  local url="$1"
  for _ in {1..160}; do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  printf 'timed out waiting for %s\n' "$url" >&2
  return 1
}

api() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  if [[ -n "$body" ]]; then
    curl -fsS -X "$method" "$API_BASE$path" \
      -H "content-type: application/json" \
      -d "$body"
  else
    curl -fsS -X "$method" "$API_BASE$path"
  fi
}

api_idempotent() {
  local method="$1"
  local path="$2"
  local key="$3"
  local body="$4"
  curl -fsS -X "$method" "$API_BASE$path" \
    -H "content-type: application/json" \
    -H "idempotency-key: $key" \
    -d "$body"
}

compose up -d postgres >/dev/null
for _ in {1..80}; do
  if compose exec -T postgres pg_isready \
    -U pluginmax -d pluginmax >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
psql_database postgres "CREATE DATABASE $DATABASE_NAME;"

export DATABASE_URL
export API_HOST=127.0.0.1
export API_PORT
export DSH_HOME="$ROOT/.tmp/dsh-home-batch11b"
export FILE_STORE_ROOT="$ROOT/.tmp/files-batch11b"
export AGENT_WORKSPACE_ROOT="$ROOT/.tmp/workspaces-batch11b"
export WORKER_POLL_INTERVAL_MS=80
export WORKER_RETRY_BASE_DELAY_MS=50
export WORKER_RETRY_MAX_DELAY_MS=200
export WORKER_HEARTBEAT_INTERVAL_MS=250
export WORKER_HEARTBEAT_STALE_AFTER_SECONDS=5
export WORKFLOW_SWEEP_INTERVAL_MS=500
export MAINTENANCE_POLL_INTERVAL_MS=500

pnpm db:migrate >/dev/null
pnpm build >/dev/null

start_process api node apps/api/lib/index.js
start_process worker node apps/worker/lib/index.js
wait_http "$API_BASE/health"
for _ in {1..120}; do
  if curl -fsS "$API_BASE/ready" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done
curl -fsS "$API_BASE/ready" >/dev/null

role_json="$(api POST /template-roles "$(jq -n \
  --arg code "ROLE_SMOKE_$STAMP" \
  '{
    code: $code,
    name: "Smoke owner",
    category: "management",
    description: "Batch 11B smoke role",
    permissions: ["read", "write", "approve", "manage_members", "manage_roles"]
  }'
)")"
role_id="$(printf '%s' "$role_json" | jq -r '.id')"

workflow_json="$(api POST /workflow-templates "$(jq -n \
  --arg key "FLOW_SMOKE_$STAMP" \
  --arg roleCode "ROLE_SMOKE_$STAMP" \
  '{
    key: $key,
    name: "Smoke delivery workflow",
    description: "Stable Workflow-domain template reference",
    definition: {
      steps: [
        {name: "Execute", kind: "agent", roleCode: $roleCode},
        {name: "Accept", kind: "human"}
      ]
    }
  }'
)")"
workflow_template_id="$(printf '%s' "$workflow_json" | jq -r '.id')"
workflow_version="$(printf '%s' "$workflow_json" | jq -r '.version')"

template_json="$(api POST /project-templates "$(jq -n \
  --arg code "TPL_SMOKE_$STAMP" \
  --arg roleId "$role_id" \
  --arg workflowId "$workflow_template_id" \
  --argjson workflowVersion "$workflow_version" \
  '{
    name: "Smoke project template",
    code: $code,
    type: "Smoke",
    description: "Atomic template materialization",
    roleIds: [$roleId],
    ownerRoleId: $roleId,
    workflowTemplates: [
      {workflowTemplateId: $workflowId, expectedVersion: $workflowVersion}
    ],
    accessPolicy: "all-members",
    allowedActorIds: []
  }'
)")"
template_id="$(printf '%s' "$template_json" | jq -r '.id')"

materialization_key="smoke-materialize-$STAMP"
materialization_body="$(jq -n \
  --arg name "Smoke materialized project $STAMP" \
  --arg templateId "$template_id" \
  --arg key "$materialization_key" \
  '{
    name: $name,
    description: "API and Worker smoke",
    templateId: $templateId,
    materializationKey: $key
  }'
)"

for index in 1 2 3 4; do
  api_idempotent POST /projects "$materialization_key" "$materialization_body" \
    >"$LOG_DIR/materialize-$index.json" &
  materialize_pid="$!"
  PIDS+=("$materialize_pid")
done
for pid in "${PIDS[@]:2}"; do
  wait "$pid"
done
PIDS=("${PIDS[@]:0:2}")

project_ids="$(jq -r '.id' "$LOG_DIR"/materialize-*.json | sort -u)"
project_id="$(printf '%s\n' "$project_ids" | head -n 1)"
[[ "$(printf '%s\n' "$project_ids" | wc -l | tr -d ' ')" == "1" ]]
materialization_count="$(psql_database "$DATABASE_NAME" \
  "SELECT COUNT(*) FROM project_template_materializations WHERE template_id = '$template_id' AND idempotency_key = '$materialization_key';")"
project_count="$(psql_database "$DATABASE_NAME" \
  "SELECT COUNT(*) FROM projects WHERE source_template_id = '$template_id';")"
role_count="$(psql_database "$DATABASE_NAME" \
  "SELECT COUNT(*) FROM project_roles WHERE project_id = '$project_id';")"
workflow_count="$(psql_database "$DATABASE_NAME" \
  "SELECT COUNT(*) FROM workflow_definitions WHERE project_id = '$project_id' AND source_template_id = '$workflow_template_id';")"
[[ "$materialization_count" == "1" ]]
[[ "$project_count" == "1" ]]
[[ "$role_count" == "1" ]]
[[ "$workflow_count" == "1" ]]

archive_status="$(curl -sS -o "$LOG_DIR/archive-conflict.json" -w '%{http_code}' \
  -X POST "$API_BASE/project-templates/$template_id/archive" \
  -H "content-type: application/json" \
  -d "{\"expectedRevision\":$(printf '%s' "$template_json" | jq -r '.revision')}")"
[[ "$archive_status" == "409" ]]
jq -e '.code == "project_template_in_use"' \
  "$LOG_DIR/archive-conflict.json" >/dev/null

ready="$(api GET /ready)"
printf '%s' "$ready" | jq -e \
  '.status == "ready" and .checks.worker.ok == true and .checks.migration.ok == true' \
  >/dev/null
migration_version="$(psql_database "$DATABASE_NAME" \
  'SELECT MAX(version) FROM platform_migrations;')"
[[ "$migration_version" == "18" ]]

printf 'project_templates_smoke=ok\n'
printf 'project_id=%s\n' "$project_id"
printf 'template_id=%s\n' "$template_id"
printf 'materialization_count=%s\n' "$materialization_count"
printf 'project_count=%s\n' "$project_count"
printf 'role_count=%s\n' "$role_count"
printf 'workflow_count=%s\n' "$workflow_count"
printf 'worker_ready=1\n'
printf 'migration_version=%s\n' "$migration_version"
