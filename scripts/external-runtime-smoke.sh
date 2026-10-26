#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COMPOSE_PROJECT="${COMPOSE_PROJECT:-pluginmax-batch13}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.batch13.yml}"
DATABASE_URL_INPUT="${DATABASE_URL:-postgres://pluginmax:pluginmax@127.0.0.1:54422/pluginmax}"
API_PORT="${API_PORT:-4479}"
WEB_PORT="${WEB_PORT:-4420}"
STAMP="$(date -u +%Y%m%d%H%M%S)"
DATABASE_NAME="pluginmax_batch13_smoke_$STAMP"
DATABASE_URL="${DATABASE_URL_INPUT%/*}/$DATABASE_NAME"
API_BASE="http://127.0.0.1:$API_PORT/api/v1"
WEB_BASE="http://127.0.0.1:$WEB_PORT"
LOG_DIR="${LOG_DIR:-$ROOT/.tmp/batch13e}"
DSH_HOME_VALUE="${DSH_HOME:-$(cd "$ROOT/.." && pwd)/dsh-home-batch13}"
PIDS=()

mkdir -p "$LOG_DIR" "$DSH_HOME_VALUE"

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
  local headers=(-H "content-type: application/json")
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
export DSH_HOME="$DSH_HOME_VALUE"
export FILE_STORE_ROOT="$ROOT/.tmp/files-batch13"
export AGENT_WORKSPACE_ROOT="$ROOT/.tmp/workspaces-batch13"
export WORKER_POLL_INTERVAL_MS=80
export WORKER_RETRY_BASE_DELAY_MS=50
export WORKER_RETRY_MAX_DELAY_MS=200
export WORKER_HEARTBEAT_INTERVAL_MS=250
export WORKER_HEARTBEAT_STALE_AFTER_SECONDS=5
export WORKFLOW_SWEEP_INTERVAL_MS=500
export MAINTENANCE_POLL_INTERVAL_MS=500
export RUNTIME_PROBE_POLL_INTERVAL_MS=100
export RUNTIME_PROBE_TIMEOUT_MS=5000
export RUNTIME_PROBE_LEASE_SECONDS=30

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

node_bin="$(command -v node)"
runtime_payload="$(
  jq -n --arg name "Batch 13 API Worker Runtime $STAMP" \
    --arg command "$node_bin" \
    '{
      name: $name,
      provider: "command",
      protocol: "plain-text",
      command: $command,
      managedArgs: [],
      customArgs: [],
      supportedModels: [],
      defaultModel: null,
      contextWindowTokens: null,
      supportedTools: [],
      networkMode: "unknown",
      sandboxMode: "read-only",
      visibility: "owner"
    }'
)"
runtime_json="$(api POST /runtimes "$runtime_payload")"
runtime_id="$(printf '%s' "$runtime_json" | jq -r '.id')"
runtime_status="$(printf '%s' "$runtime_json" | jq -r '.status')"
runtime_revision="$(printf '%s' "$runtime_json" | jq -r '.revision')"

if [[ "$runtime_status" != "disabled" || "$runtime_revision" != "1" ]]; then
  printf 'new runtime was not disabled at revision 1: status=%s revision=%s\n' \
    "$runtime_status" "$runtime_revision" >&2
  exit 1
fi

probe_json="$(
  api POST "/runtimes/$runtime_id/probe" \
    "$(jq -n --argjson expectedRevision "$runtime_revision" \
      '{expectedRevision: $expectedRevision}')"
)"
probe_status="$(printf '%s' "$probe_json" | jq -r '.probe.status')"
if [[ "$probe_status" != "requested" ]]; then
  printf 'probe request did not return requested: %s\n' "$probe_status" >&2
  exit 1
fi

completed_status=""
for _ in {1..200}; do
  completed_status="$(
    psql_database "$DATABASE_NAME" \
      "SELECT status FROM external_runtime_probes WHERE runtime_id = '$runtime_id' ORDER BY requested_at DESC LIMIT 1;"
  )"
  if [[ "$completed_status" == "passed" || "$completed_status" == "failed" ]]; then
    break
  fi
  sleep 0.2
done
if [[ "$completed_status" != "passed" ]]; then
  printf 'worker probe did not pass: %s\n' "$completed_status" >&2
  exit 1
fi

enable_json="$(
  api POST "/runtimes/$runtime_id/enable" \
    "$(jq -n --argjson expectedRevision "$runtime_revision" \
      '{expectedRevision: $expectedRevision}')"
)"
enabled_status="$(printf '%s' "$enable_json" | jq -r '.status')"
if [[ "$enabled_status" != "active" ]]; then
  printf 'runtime did not enable after probe: %s\n' "$enabled_status" >&2
  exit 1
fi

capability_count="$(
  psql_database "$DATABASE_NAME" \
    "SELECT COUNT(*) FROM external_runtime_capabilities WHERE runtime_id = '$runtime_id';"
)"
event_kinds="$(
  psql_database "$DATABASE_NAME" \
    "SELECT string_agg(kind, ',' ORDER BY created_at) FROM external_runtime_events WHERE runtime_id = '$runtime_id';"
)"
outbox_status="$(
  psql_database "$DATABASE_NAME" \
    "SELECT status FROM domain_outbox WHERE topic = 'runtime.probe' AND payload ->> 'runtimeId' = '$runtime_id' ORDER BY created_at DESC LIMIT 1;"
)"
probe_stdout="$(
  psql_database "$DATABASE_NAME" \
    "SELECT COALESCE(stdout_excerpt, '') FROM external_runtime_probes WHERE runtime_id = '$runtime_id' ORDER BY requested_at DESC LIMIT 1;"
)"

if [[ "$capability_count" != "1" ||
      "$outbox_status" != "published" ||
      -z "$probe_stdout" ||
      "$event_kinds" != *"registered"* ||
      "$event_kinds" != *"probed"* ||
      "$event_kinds" != *"enabled"* ]]; then
  printf 'probe/audit verification failed: capabilities=%s outbox=%s stdout=%s events=%s\n' \
    "$capability_count" "$outbox_status" "$probe_stdout" "$event_kinds" >&2
  exit 1
fi

PLUGINMAX_WEB_BASE_URL="$WEB_BASE" \
  pnpm playwright test \
    e2e/external-runtimes.spec.ts \
    e2e/external-runtime-gui.spec.ts

printf 'external_runtime_smoke=ok\n'
printf 'api=%s\n' "$API_BASE"
printf 'web=%s\n' "$WEB_BASE"
printf 'database=%s\n' "$DATABASE_NAME"
printf 'runtime_id=%s\n' "$runtime_id"
printf 'probe_status=%s\n' "$completed_status"
printf 'runtime_status=%s\n' "$enabled_status"
printf 'dsh_home=%s\n' "$DSH_HOME"
