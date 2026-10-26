#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COMPOSE_PROJECT="${COMPOSE_PROJECT:-pluginmax-batch11a}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.batch11a.yml}"
DATABASE_URL_INPUT="${DATABASE_URL:-postgres://pluginmax:pluginmax@127.0.0.1:54417/pluginmax}"
API_PORT="${API_PORT:-4471}"
STAMP="$(date -u +%Y%m%d%H%M%S)"
DATABASE_NAME="pluginmax_batch11a_smoke_$STAMP"
DATABASE_URL="${DATABASE_URL_INPUT%/*}/$DATABASE_NAME"
API_BASE="http://127.0.0.1:$API_PORT/api/v1"
LOG_DIR="${LOG_DIR:-$ROOT/.tmp/batch11a}"
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
export DSH_HOME="$ROOT/.tmp/dsh-home-batch11a"
export FILE_STORE_ROOT="$ROOT/.tmp/files-batch11a"
export AGENT_WORKSPACE_ROOT="$ROOT/.tmp/workspaces-batch11a"
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

project_json="$(
  api POST /projects "$(
    jq -n --arg name "Batch 11A smoke $STAMP" \
      '{name: $name, description: "workbench reports smoke"}'
  )"
)"
project_id="$(printf '%s' "$project_json" | jq -r '.id')"
task_json="$(
  api POST /tasks "$(
    jq -n --arg projectId "$project_id" \
      '{
        projectId: $projectId,
        title: "Validate report source navigation",
        description: "Persist a workbench and report source",
        acceptance: ["Source remains traceable"],
        agentId: "00000000-0000-4000-8000-000000000001",
        dependsOn: []
      }'
  )"
)"
task_id="$(printf '%s' "$task_json" | jq -r '.id')"

curl -fsS -X POST "$API_BASE/projects/$project_id/reports/generate" \
  -H "content-type: application/json" \
  -d "{\"reportDate\":\"2026-10-26\"}" \
  >"$LOG_DIR/report-a.json" &
report_a_pid="$!"
curl -fsS -X POST "$API_BASE/projects/$project_id/reports/generate" \
  -H "content-type: application/json" \
  -d "{\"reportDate\":\"2026-10-26\"}" \
  >"$LOG_DIR/report-b.json" &
report_b_pid="$!"
wait "$report_a_pid"
wait "$report_b_pid"
report_a_id="$(jq -r '.report.id' "$LOG_DIR/report-a.json")"
report_b_id="$(jq -r '.report.id' "$LOG_DIR/report-b.json")"
[[ "$report_a_id" == "$report_b_id" ]]
report_count="$(psql_database "$DATABASE_NAME" \
  "SELECT COUNT(*) FROM project_reports WHERE project_id = '$project_id' AND report_date = '2026-10-26';")"
[[ "$report_count" == "1" ]]

api POST /workbench/supply-exceptions "$(
  jq -n --arg projectId "$project_id" --arg taskId "$task_id" \
    '{
      projectId: $projectId,
      title: "Persisted supply exception",
      severity: "high",
      suggestedAction: "Open the qualification action",
      ownerActorId: "local-admin",
      impactScope: "Smoke project",
      sourceTaskId: $taskId,
      status: "open"
    }'
)" >/dev/null
api POST /workbench/supplier-risks "$(
  jq -n --arg projectId "$project_id" \
    '{
      projectId: $projectId,
      supplierName: "Persisted supplier",
      riskType: "Capacity",
      riskScore: 88,
      commitmentRate: 70,
      qualityMetric: "Two open deviations",
      purchaseShare: 40,
      suggestedAction: "Review backup capacity",
      status: "open",
      sourceNote: "supplier_risks smoke"
    }'
)" >/dev/null
api POST /workbench/follows "$(
  jq -n --arg projectId "$project_id" --arg taskId "$task_id" \
    '{
      targetType: "task",
      targetId: $taskId,
      projectId: $projectId,
      followed: true
    }'
)" >/dev/null

dashboard="$(api GET /workbench/dashboard)"
printf '%s' "$dashboard" | jq -e \
  --arg taskId "$task_id" \
  --arg reportId "$report_a_id" '
    (.brief.snapshot.items | length) > 0 and
    (.focus | any(.id == $taskId and .directFollow == true and .followPriority == 5)) and
    (.projectReports | any(.id == $reportId)) and
    (.supplyExceptions | any(.title == "Persisted supply exception")) and
    (.supplierRisks | any(.supplierName == "Persisted supplier" and .riskScore == 88))
  ' >/dev/null

brief_id="$(printf '%s' "$dashboard" | jq -r '.brief.id')"
api POST "/workbench/brief/$brief_id/read" '{"read":true}' >/dev/null
settings="$(api PATCH /workbench/brief/settings '{"frequency":"daily-0800-1300"}')"
printf '%s' "$settings" | jq -e \
  '.frequency == "daily-0800-1300"' >/dev/null

ready="$(api GET /ready)"
printf '%s' "$ready" | jq -e \
  '.status == "ready" and .checks.worker.ok == true and .checks.migration.ok == true' \
  >/dev/null

printf 'workbench_reports_smoke=ok\n'
printf 'project_id=%s\n' "$project_id"
printf 'report_id=%s\n' "$report_a_id"
printf 'report_count=%s\n' "$report_count"
printf 'brief_id=%s\n' "$brief_id"
printf 'worker_ready=1\n'
