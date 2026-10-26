#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COMPOSE_PROJECT="${COMPOSE_PROJECT:-pluginmax-batch10b}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.batch10b.yml}"
DATABASE_URL_INPUT="${DATABASE_URL:-postgres://pluginmax:pluginmax@127.0.0.1:54410/pluginmax}"
API_PORT="${API_PORT:-4470}"
WEB_PORT="${WEB_PORT:-4413}"
STAMP="$(date -u +%Y%m%d%H%M%S)"
DATABASE_NAME="pluginmax_batch10b_smoke_$STAMP"
DATABASE_URL="${DATABASE_URL_INPUT%/*}/$DATABASE_NAME"
API_BASE="http://127.0.0.1:$API_PORT/api/v1"
WEB_BASE="http://127.0.0.1:$WEB_PORT"
LOG_DIR="${LOG_DIR:-$ROOT/.tmp/batch10b}"
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
export WEB_PORT
export DSH_HOME="$ROOT/.tmp/dsh-home-batch10b"
export FILE_STORE_ROOT="$ROOT/.tmp/files-batch10b"
export AGENT_WORKSPACE_ROOT="$ROOT/.tmp/workspaces-batch10b"
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
    jq -n --arg name "Batch 10B smoke agent $STAMP" \
      '{name: $name, description: "memory closure execution", runtimeKind: "fake"}'
  )"
)"
agent_id="$(printf '%s' "$agent_json" | jq -r '.id')"
project_json="$(
  api POST /projects "$(
    jq -n --arg name "Batch 10B smoke $STAMP" \
      '{name: $name, description: "context and memory closure smoke"}'
  )"
)"
project_id="$(printf '%s' "$project_json" | jq -r '.id')"
api POST "/projects/$project_id/members" "$(
  jq -n --arg agentId "$agent_id" \
    '{
      kind: "agent",
      agentId: $agentId,
      responsibility: "Review and execute memory closure",
      roleIds: []
    }'
)" >/dev/null
api POST "/projects/$project_id/agent-episodes" "$(
  jq -n --arg agentId "$agent_id" \
    '{
      agentId: $agentId,
      visibility: "project",
      kind: "decision",
      summary: "Batch 10B context episode",
      content: "Use the reviewed meeting decision as project context.",
      sourceRefs: []
    }'
)" >/dev/null
meeting_json="$(
  api POST /meetings "$(
    jq -n --arg projectId "$project_id" --arg agentId "$agent_id" \
      '{
        projectId: $projectId,
        title: "Batch 10B memory meeting",
        agenda: "Publish a decision and review its memory claim",
        agentIds: [$agentId]
      }'
  )"
)"
meeting_id="$(printf '%s' "$meeting_json" | jq -r '.id')"
message_json="$(
  api POST "/meetings/$meeting_id/messages" \
    '{"content":"Decision: close the memory review loop with traceable sources."}'
)"
message_id="$(printf '%s' "$message_json" | jq -r '.id')"
saved="$(
  api PUT "/meetings/$meeting_id/minutes/draft" "$(
    jq -n --arg sourceId "$message_id" \
      '{
        content: "Decision: close the memory review loop with traceable sources.",
        decisions: ["Close the memory review loop with traceable sources"],
        sourceMessageIds: [$sourceId],
        expectedRevision: 0
      }'
  )"
)"
revision="$(printf '%s' "$saved" | jq -r '.revision')"
published="$(
  api POST "/meetings/$meeting_id/minutes/publish" "$(
    jq -n --argjson expectedRevision "$revision" \
      '{expectedRevision: $expectedRevision}'
  )"
)"
version_id="$(printf '%s' "$published" | jq -r '.version.id')"
queue="$(api GET "/projects/$project_id/memory/reviews")"
claim_id="$(printf '%s' "$queue" | jq -r '.items[0].claim.id')"
claim_version="$(printf '%s' "$queue" | jq -r '.items[0].claim.version')"
api POST "/projects/$project_id/memory/reviews" "$(
  jq -n --arg claimId "$claim_id" --argjson expectedVersion "$claim_version" \
    '{
      decision: "accept",
      reason: "Published minutes support this claim",
      items: [{claimId: $claimId, expectedVersion: $expectedVersion}]
    }'
)" >/dev/null
memory="$(api GET "/projects/$project_id/memory")"
truth_version="$(printf '%s' "$memory" | jq -r '.items[0].currentTruth.version')"

action_json="$(
  api POST "/meetings/$meeting_id/action-items" "$(
    jq -n --arg sourceVersionId "$version_id" --arg sourceMessageId "$message_id" \
      --arg ownerActorId "$agent_id" \
      '{
        title: "Execute reviewed memory closure",
        description: "Run the accepted decision and preserve context evidence.",
        ownerActorId: $ownerActorId,
        priority: "high",
        sourceType: "minutes_version",
        sourceVersionId: $sourceVersionId,
        sourceMessageIds: [$sourceMessageId],
        dedupeKey: "batch10b-memory-closure-action"
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
  printf 'memory closure run finished with status %s\n' "$run_status" >&2
  exit 1
fi

context="$(api GET "/runs/$run_id/context")"
if ! printf '%s' "$context" | jq -e \
  '.pack.renderedPrompt | contains("Batch 10B context episode")' >/dev/null; then
  printf 'run context did not include the scoped Agent Episode\n' >&2
  exit 1
fi

handoff="$(
  api POST "/projects/$project_id/handoffs" "$(
    jq -n --arg projectId "$project_id" --arg taskId "$task_id" \
      --arg claimId "$claim_id" --arg taskTitle "Execute reviewed memory closure" \
      '{
        title: "Batch 10B execution handoff",
        summary: "Continue from the reviewed decision and completed run.",
        sourceRefs: [
          {kind: "task", id: $taskId, projectId: $projectId, label: $taskTitle},
          {kind: "memory-claim", id: $claimId, projectId: $projectId, label: "Reviewed decision"}
        ]
      }'
  )"
)"
handoff_id="$(printf '%s' "$handoff" | jq -r '.id')"
handoff_version="$(printf '%s' "$handoff" | jq -r '.version')"
confirmed="$(
  api POST "/projects/$project_id/handoffs/$handoff_id/confirm" "$(
    jq -n --argjson expectedVersion "$handoff_version" \
      '{expectedVersion: $expectedVersion}'
  )"
)"
confirmation_count="$(printf '%s' "$confirmed" | jq '.confirmations | length')"

if [[ "$truth_version" -lt 1 || "$confirmation_count" -ne 1 ]]; then
  printf 'memory closure smoke assertions failed: truth=%s confirmations=%s\n' \
    "$truth_version" "$confirmation_count" >&2
  exit 1
fi

PLUGINMAX_WEB_BASE_URL="$WEB_BASE" \
  pnpm exec playwright test e2e/memory-closure.spec.ts

printf 'memory_closure_smoke=ok\n'
printf 'database=%s\n' "$DATABASE_NAME"
printf 'project_id=%s\n' "$project_id"
printf 'claim_id=%s\n' "$claim_id"
printf 'task_id=%s\n' "$task_id"
printf 'run_id=%s\n' "$run_id"
printf 'truth_version=%s\n' "$truth_version"
printf 'handoff_confirmations=%s\n' "$confirmation_count"
