#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COMPOSE_PROJECT="${COMPOSE_PROJECT:-pluginmax-batch10a}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.batch10a.yml}"
DATABASE_URL_INPUT="${DATABASE_URL:-postgres://pluginmax:pluginmax@127.0.0.1:54400/pluginmax}"
API_PORT="${API_PORT:-4460}"
WEB_PORT="${WEB_PORT:-4412}"
STAMP="$(date -u +%Y%m%d%H%M%S)"
DATABASE_NAME="pluginmax_batch10a_smoke_$STAMP"
DATABASE_URL="${DATABASE_URL_INPUT%/*}/$DATABASE_NAME"
API_BASE="http://127.0.0.1:$API_PORT/api/v1"
WEB_BASE="http://127.0.0.1:$WEB_PORT"
LOG_DIR="${LOG_DIR:-$ROOT/.tmp/batch10a}"
PIDS=()
LAST_PID=""

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
  LAST_PID=$!
  PIDS+=("$LAST_PID")
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
export WEB_PORT
export DSH_HOME="$ROOT/.tmp/dsh-home-batch10a"
export FILE_STORE_ROOT="$ROOT/.tmp/files-batch10a"
export AGENT_WORKSPACE_ROOT="$ROOT/.tmp/workspaces-batch10a"
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
start_process web pnpm --filter @pluginmax/web exec vite \
  --host 127.0.0.1 --port "$WEB_PORT"
wait_http "$API_BASE/health"
wait_http "$WEB_BASE/"
for _ in {1..120}; do
  if curl -fsS "$API_BASE/ready" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done
curl -fsS "$API_BASE/ready" >/dev/null

agent_json="$(
  api POST /agents "$(
    jq -n --arg name "Batch 10A action agent $STAMP" \
      '{name: $name, description: "meeting action execution", runtimeKind: "fake"}'
  )"
)"
agent_id="$(printf '%s' "$agent_json" | jq -r '.id')"
project_json="$(
  api POST /projects "$(
    jq -n --arg name "Batch 10A smoke $STAMP" \
      '{name: $name, description: "meeting decision closure smoke"}'
  )"
)"
project_id="$(printf '%s' "$project_json" | jq -r '.id')"
api POST "/projects/$project_id/members" "$(
  jq -n --arg agentId "$agent_id" \
    '{
      kind: "agent",
      agentId: $agentId,
      responsibility: "Deliver meeting decisions",
      roleIds: []
    }'
)" >/dev/null
meeting_json="$(
  api POST /meetings "$(
    jq -n --arg projectId "$project_id" --arg agentId "$agent_id" \
      '{
        projectId: $projectId,
        title: "Batch 10A meeting",
        agenda: "Confirm the release decision and action owner",
        agentIds: [$agentId]
      }'
  )"
)"
meeting_id="$(printf '%s' "$meeting_json" | jq -r '.id')"
message_json="$(
  api POST "/meetings/$meeting_id/messages" \
    '{"content":"Decision: ship the closure flow after review."}'
)"
message_id="$(printf '%s' "$message_json" | jq -r '.id')"
saved="$(
  api PUT "/meetings/$meeting_id/minutes/draft" "$(
    jq -n --arg sourceId "$message_id" \
      '{
        content: "Decision: ship the closure flow after review.",
        decisions: ["Ship the closure flow after review"],
        sourceMessageIds: [$sourceId],
        expectedRevision: 0
      }'
  )"
)"
expected_revision="$(printf '%s' "$saved" | jq -r '.revision')"
published="$(
  api POST "/meetings/$meeting_id/minutes/publish" "$(
    jq -n --argjson expectedRevision "$expected_revision" \
      '{expectedRevision: $expectedRevision}'
  )"
)"
expected_revision="$(printf '%s' "$published" | jq -r '.minutes.draft.revision')"
version_one="$(printf '%s' "$published" | jq -r '.version.id')"
revised="$(
  api PUT "/meetings/$meeting_id/minutes/draft" "$(
    jq -n --arg sourceId "$message_id" --argjson expectedRevision "$expected_revision" \
      '{
        content: "Decision: ship after review, with traceable memory.",
        decisions: ["Ship after review", "Write accepted output to project memory"],
        sourceMessageIds: [$sourceId],
        expectedRevision: $expectedRevision
      }'
  )"
)"
expected_revision="$(printf '%s' "$revised" | jq -r '.revision')"
published_v2="$(
  api POST "/meetings/$meeting_id/minutes/publish" "$(
    jq -n --argjson expectedRevision "$expected_revision" \
      '{expectedRevision: $expectedRevision}'
  )"
)"
version_two="$(printf '%s' "$published_v2" | jq -r '.version.id')"
version_two_number="$(printf '%s' "$published_v2" | jq -r '.version.version')"
action_json="$(
  api POST "/meetings/$meeting_id/action-items" "$(
    jq -n --arg sourceVersionId "$version_two" --arg sourceMessageId "$message_id" \
      '{
        title: "Ship meeting decision closure",
        description: "Execute the accepted meeting decision and retain evidence.",
        ownerActorId: "local-admin",
        priority: "high",
        sourceType: "minutes_version",
        sourceVersionId: $sourceVersionId,
        sourceMessageIds: [$sourceMessageId],
        dedupeKey: "batch10a-ship-meeting-closure"
      }'
  )"
)"
action_id="$(printf '%s' "$action_json" | jq -r '.id')"
converted="$(
  api POST "/meetings/$meeting_id/action-items/$action_id/convert" "$(
    jq -n --arg assigneeAgentId "$agent_id" \
      '{assigneeAgentId: $assigneeAgentId, dispatch: true}'
  )"
)"
task_id="$(printf '%s' "$converted" | jq -r '.task.id')"
run_id="$(printf '%s' "$converted" | jq -r '.runId')"

run_status=""
for _ in {1..160}; do
  run_status="$(api GET "/runs/$run_id" | jq -r '.run.status')"
  case "$run_status" in
    completed | failed | cancelled | timeout | interrupted) break ;;
  esac
  sleep 0.25
done
if [[ "$run_status" != "completed" ]]; then
  printf 'meeting action run finished with status %s\n' "$run_status" >&2
  exit 1
fi

reviewed="$(
  api POST "/tasks/$task_id/review" \
    '{"decision":"approve","note":"Meeting action delivered and accepted."}'
)"
task_status="$(printf '%s' "$reviewed" | jq -r '.status')"
trace="$(api GET "/meetings/$meeting_id/traceability")"
trace_status="$(printf '%s' "$trace" | jq -r '.actionItems[0].status')"
trace_task_id="$(printf '%s' "$trace" | jq -r '.actionItems[0].taskId')"
trace_run_status="$(printf '%s' "$trace" | jq -r '.actionItems[0].runs[-1].status')"
trace_review="$(printf '%s' "$trace" | jq -r '.actionItems[0].reviews[-1].decision')"
trace_memories="$(printf '%s' "$trace" | jq '.actionItems[0].memories | length')"

if [[ "$task_status" != "done" ||
      "$trace_status" != "done" ||
      "$trace_task_id" != "$task_id" ||
      "$trace_run_status" != "completed" ||
      "$trace_review" != "approve" ||
      "$trace_memories" -lt 1 ||
      "$version_two_number" -ne 2 ]]; then
  printf 'meeting decisions closure verification failed\n' >&2
  printf '%s\n' "$trace" >&2
  exit 1
fi

PLUGINMAX_WEB_BASE_URL="$WEB_BASE" \
  pnpm playwright test e2e/meeting-decisions.spec.ts

printf 'meeting_decisions_smoke=ok\n'
printf 'api=%s\n' "$API_BASE"
printf 'web=%s\n' "$WEB_BASE"
printf 'database=%s\n' "$DATABASE_NAME"
printf 'meeting_id=%s\n' "$meeting_id"
printf 'minutes_version_1=%s\n' "$version_one"
printf 'minutes_version_2=%s\n' "$version_two"
printf 'action_item_id=%s\n' "$action_id"
printf 'task_id=%s\n' "$task_id"
printf 'run_id=%s\n' "$run_id"
printf 'trace_status=%s\n' "$trace_status"
printf 'trace_memories=%s\n' "$trace_memories"
printf 'log_dir=%s\n' "$LOG_DIR"
