#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COMPOSE_PROJECT="${COMPOSE_PROJECT:-pluginmax-batch12a}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.batch12a.yml}"
DATABASE_URL_INPUT="${DATABASE_URL:-postgres://pluginmax:pluginmax@127.0.0.1:54419/pluginmax}"
API_PORT="${API_PORT:-4476}"
WEB_PORT="${WEB_PORT:-4417}"
STAMP="$(date -u +%Y%m%d%H%M%S)"
DATABASE_NAME="pluginmax_batch12a_smoke_$STAMP"
DATABASE_URL="${DATABASE_URL_INPUT%/*}/$DATABASE_NAME"
API_BASE="http://127.0.0.1:$API_PORT/api/v1"
WEB_BASE="http://127.0.0.1:$WEB_PORT"
LOG_DIR="${LOG_DIR:-$ROOT/.tmp/batch12a}"
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

cleanup() {
  local pid
  for pid in "${PIDS[@]:-}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill -TERM "$pid" 2>/dev/null || true
    fi
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
export DSH_HOME="$ROOT/.tmp/dsh-home-batch12a"
export FILE_STORE_ROOT="$ROOT/.tmp/files-batch12a"
export AGENT_WORKSPACE_ROOT="$ROOT/.tmp/workspaces-batch12a"
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
    jq -n --arg name "Batch 12A meeting agent $STAMP" \
      '{name: $name, description: "Deterministic meeting participant", runtimeKind: "fake"}'
  )"
)"
agent_id="$(printf '%s' "$agent_json" | jq -r '.id')"
project_json="$(
  api POST /projects "$(
    jq -n --arg name "Batch 12A smoke $STAMP" \
      '{name: $name, description: "Meeting AI participation smoke"}'
  )"
)"
project_id="$(printf '%s' "$project_json" | jq -r '.id')"
api POST "/projects/$project_id/members" "$(
  jq -n --arg agentId "$agent_id" \
    '{
      kind: "agent",
      agentId: $agentId,
      responsibility: "Participate in meeting rounds",
      roleIds: []
    }'
)" >/dev/null
meeting_json="$(
  api POST /meetings "$(
    jq -n --arg projectId "$project_id" --arg agentId "$agent_id" \
      '{
        projectId: $projectId,
        title: "Batch 12A meeting",
        agenda: "Review the deterministic AI participation policy",
        agentIds: [$agentId]
      }'
  )"
)"
meeting_id="$(printf '%s' "$meeting_json" | jq -r '.id')"
policy_json="$(api GET "/meetings/$meeting_id/ai-policy")"
policy_revision="$(printf '%s' "$policy_json" | jq -r '.revision')"
api PUT "/meetings/$meeting_id/ai-policy" "$(
  jq -n --argjson expectedRevision "$policy_revision" \
    '{
      expectedRevision: $expectedRevision,
      status: "active",
      triggerKinds: ["mention", "round", "agenda", "summary"],
      cooldownSeconds: 0,
      maxRounds: 3,
      maxMessages: 5,
      runBudgetMs: 10000
    }'
)" >/dev/null
message_json="$(
  api POST "/meetings/$meeting_id/messages" "$(
    jq -n --arg agentId "$agent_id" \
      '{content: "Please review the current risk.", mentions: [$agentId]}'
  )"
)"
message_id="$(printf '%s' "$message_json" | jq -r '.id')"

turn_status=""
run_status=""
for _ in {1..200}; do
  turn_status="$(
    psql_database "$DATABASE_NAME" \
      "SELECT status FROM meeting_ai_turns WHERE source_message_id = '$message_id' ORDER BY created_at DESC LIMIT 1;"
  )"
  run_status="$(
    psql_database "$DATABASE_NAME" \
      "SELECT run.status FROM meeting_ai_turns AS turn JOIN runs AS run ON run.id = turn.run_id WHERE turn.source_message_id = '$message_id' ORDER BY turn.created_at DESC LIMIT 1;"
  )"
  if [[ "$turn_status" == "completed" && "$run_status" == "completed" ]]; then
    break
  fi
  sleep 0.2
done

agent_message_count="$(
  psql_database "$DATABASE_NAME" \
    "SELECT COUNT(*) FROM meeting_messages WHERE turn_id IS NOT NULL AND policy_id IS NOT NULL AND run_id IS NOT NULL AND trace_id IS NOT NULL AND status = 'sent' AND meeting_id = '$meeting_id';"
)"

if [[ "$turn_status" != "completed" ||
      "$run_status" != "completed" ||
      "$agent_message_count" -lt 1 ]]; then
  printf 'meeting AI worker smoke failed: turn=%s run=%s messages=%s\n' \
    "$turn_status" "$run_status" "$agent_message_count" >&2
  exit 1
fi

PLUGINMAX_WEB_BASE_URL="$WEB_BASE" \
  pnpm playwright test e2e/meeting-ai-participation.spec.ts

printf 'meeting_ai_participation_smoke=ok\n'
printf 'api=%s\n' "$API_BASE"
printf 'web=%s\n' "$WEB_BASE"
printf 'database=%s\n' "$DATABASE_NAME"
printf 'meeting_id=%s\n' "$meeting_id"
printf 'turn_status=%s\n' "$turn_status"
printf 'run_status=%s\n' "$run_status"
printf 'agent_message_count=%s\n' "$agent_message_count"
printf 'log_dir=%s\n' "$LOG_DIR"
