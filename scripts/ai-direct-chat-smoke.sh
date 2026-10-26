#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COMPOSE_PROJECT="${COMPOSE_PROJECT:-pluginmax-batch12b}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.batch12b.yml}"
DATABASE_URL_INPUT="${DATABASE_URL:-postgres://pluginmax:pluginmax@127.0.0.1:54420/pluginmax}"
API_PORT="${API_PORT:-4477}"
WEB_PORT="${WEB_PORT:-4418}"
STAMP="$(date -u +%Y%m%d%H%M%S)"
DATABASE_NAME="pluginmax_batch12b_smoke_$STAMP"
DATABASE_URL="${DATABASE_URL_INPUT%/*}/$DATABASE_NAME"
API_BASE="http://127.0.0.1:$API_PORT/api/v1"
WEB_BASE="http://127.0.0.1:$WEB_PORT"
LOG_DIR="${LOG_DIR:-$ROOT/.tmp/batch12b}"
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
  local key="${4:-}"
  local headers=(-H "content-type: application/json")
  if [[ -n "$key" ]]; then
    headers+=(-H "idempotency-key: $key")
  fi
  if [[ -n "$body" ]]; then
    curl -fsS -X "$method" "$API_BASE$path" \
      "${headers[@]}" \
      -d "$body"
  else
    curl -fsS -X "$method" "$API_BASE$path" "${headers[@]}"
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
export DSH_HOME="${DSH_HOME:-$ROOT/../dsh-home-batch12b}"
export FILE_STORE_ROOT="$ROOT/.tmp/files-batch12b"
export AGENT_WORKSPACE_ROOT="$ROOT/.tmp/workspaces-batch12b"
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
    jq -n --arg name "Batch 12B direct smoke agent $STAMP" \
      '{
        name: $name,
        description: "Deterministic direct chat smoke agent",
        runtimeKind: "fake",
        soul: "Reply only within this private conversation."
      }'
  )"
)"
agent_id="$(printf '%s' "$agent_json" | jq -r '.id')"
thread_json="$(
  api POST /direct-chats "$(
    jq -n --arg agentId "$agent_id" '{agentId: $agentId}'
  )"
)"
thread_id="$(printf '%s' "$thread_json" | jq -r '.id')"
client_message_id="$(uuidgen | tr '[:upper:]' '[:lower:]')"
message_payload="$(
  jq -n --arg content "Run the direct chat smoke." \
    --arg clientMessageId "$client_message_id" \
    '{content: $content, clientMessageId: $clientMessageId}'
)"
send_json="$(
  api POST "/direct-chats/$thread_id/messages" "$message_payload" \
    "batch12b-smoke-$client_message_id"
)"
replay_json="$(
  api POST "/direct-chats/$thread_id/messages" "$message_payload" \
    "batch12b-smoke-$client_message_id"
)"
message_id="$(printf '%s' "$send_json" | jq -r '.message.id')"
replay_message_id="$(printf '%s' "$replay_json" | jq -r '.message.id')"
run_id="$(printf '%s' "$send_json" | jq -r '.run.id')"

turn_status=""
run_status=""
for _ in {1..200}; do
  turn_status="$(
    psql_database "$DATABASE_NAME" \
      "SELECT status FROM direct_chat_turns WHERE run_id = '$run_id';"
  )"
  run_status="$(
    psql_database "$DATABASE_NAME" \
      "SELECT status FROM runs WHERE id = '$run_id';"
  )"
  if [[ "$turn_status" == "completed" && "$run_status" == "completed" ]]; then
    break
  fi
  sleep 0.2
done

provenance="$(
  psql_database "$DATABASE_NAME" \
    "SELECT sender_type || ':' || status || ':' || COALESCE(trace_id, '') || ':' || COALESCE(run_id::text, '') FROM direct_chat_messages WHERE turn_id = (
       SELECT id FROM direct_chat_turns WHERE run_id = '$run_id'
     );"
)"
turn_count="$(
  psql_database "$DATABASE_NAME" \
    "SELECT COUNT(*) FROM direct_chat_turns WHERE thread_id = '$thread_id';"
)"
reply_count="$(
  psql_database "$DATABASE_NAME" \
    "SELECT COUNT(*) FROM direct_chat_messages WHERE thread_id = '$thread_id' AND sender_type = 'agent';"
)"
context_nullable="$(
  psql_database "$DATABASE_NAME" \
    "SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'runs' AND column_name = 'project_id';"
)"

if [[ "$message_id" != "$replay_message_id" ||
      "$turn_status" != "completed" ||
      "$run_status" != "completed" ||
      "$provenance" != agent:sent:* ||
      "$turn_count" != "1" ||
      "$reply_count" != "1" ||
      "$context_nullable" != "YES" ]]; then
  printf 'direct chat worker smoke failed: message=%s replay=%s turn=%s run=%s provenance=%s turns=%s replies=%s project_nullable=%s\n' \
    "$message_id" "$replay_message_id" "$turn_status" "$run_status" \
    "$provenance" "$turn_count" "$reply_count" "$context_nullable" >&2
  exit 1
fi

PLUGINMAX_WEB_BASE_URL="$WEB_BASE" \
  pnpm playwright test e2e/ai-direct-chat.spec.ts

printf 'ai_direct_chat_smoke=ok\n'
printf 'api=%s\n' "$API_BASE"
printf 'web=%s\n' "$WEB_BASE"
printf 'database=%s\n' "$DATABASE_NAME"
printf 'agent_id=%s\n' "$agent_id"
printf 'thread_id=%s\n' "$thread_id"
printf 'run_id=%s\n' "$run_id"
printf 'turn_status=%s\n' "$turn_status"
printf 'reply_count=%s\n' "$reply_count"
