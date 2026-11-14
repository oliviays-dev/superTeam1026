#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COMPOSE_PROJECT="${COMPOSE_PROJECT:-pluginmax-core-regression-e2e}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.core-regression.yml}"
DATABASE_URL_INPUT="${DATABASE_URL:-postgres://pluginmax:pluginmax@127.0.0.1:54440/pluginmax}"
BEARER_API_PORT="${CORE_BEARER_API_PORT:-4540}"
BEARER_WEB_PORT="${CORE_BEARER_WEB_PORT:-4541}"
LOCAL_API_PORT="${CORE_LOCAL_API_PORT:-4560}"
LOCAL_WEB_PORT="${CORE_LOCAL_WEB_PORT:-4561}"
STAMP="$(date -u +%Y%m%d%H%M%S)"
BEARER_DATABASE="pluginmax_core_e2e_bearer_${STAMP}"
LOCAL_DATABASE="pluginmax_core_e2e_local_${STAMP}"
BEARER_URL="${DATABASE_URL_INPUT%/*}/${BEARER_DATABASE}"
LOCAL_URL="${DATABASE_URL_INPUT%/*}/${LOCAL_DATABASE}"
RUN_ID="${CORE_REGRESSION_RUN_ID:-e2e-${STAMP}}"
PHASE="${CORE_E2E_PHASE:-all}"
TMP_ROOT="$ROOT/.tmp/core-regression/${RUN_ID}"
LOG_DIR="$TMP_ROOT/logs"
SUMMARY="$TMP_ROOT/summary.txt"
FIXTURE_PATH="$TMP_ROOT/bearer-fixture.json"
CORE_REGRESSION_PASSWORD="${CORE_REGRESSION_PASSWORD:-core-regression-${STAMP}-password}"
PIDS=()

if [[ "$PHASE" != "all" && "$PHASE" != "bearer" && "$PHASE" != "local" ]]; then
  printf 'CORE_E2E_PHASE must be all, bearer, or local\n' >&2
  exit 1
fi

mkdir -p "$LOG_DIR" "$TMP_ROOT/screenshots"
: >"$SUMMARY"

record() {
  printf '%s\n' "$*" | tee -a "$SUMMARY"
}

compose() {
  "$ROOT/scripts/db-compose.sh" \
    -p "$COMPOSE_PROJECT" \
    -f "$ROOT/$COMPOSE_FILE" \
    "$@"
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

stop_phase_processes() {
  local pid
  for pid in "${PIDS[@]:-}"; do
    stop_pid "$pid"
  done
  for pid in "${PIDS[@]:-}"; do
    wait "$pid" 2>/dev/null || true
  done
  PIDS=()
}

cleanup() {
  stop_phase_processes
  psql_database postgres \
    "DROP DATABASE IF EXISTS $BEARER_DATABASE WITH (FORCE);" \
    >/dev/null 2>&1 || true
  psql_database postgres \
    "DROP DATABASE IF EXISTS $LOCAL_DATABASE WITH (FORCE);" \
    >/dev/null 2>&1 || true
  if [[ "${CORE_REGRESSION_KEEP_ENV:-0}" != "1" ]]; then
    compose down -v >/dev/null 2>&1 || true
  fi
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
  for _ in {1..200}; do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
  done
  printf 'timed out waiting for %s\n' "$url" >&2
  return 1
}

start_services() {
  local phase="$1"
  local api_port="$2"
  local web_port="$3"
  start_process "${phase}-api" node apps/api/lib/index.js
  start_process "${phase}-worker" node apps/worker/lib/index.js
  start_process "${phase}-web" \
    apps/web/node_modules/.bin/vite apps/web \
    --host 127.0.0.1 --port "$web_port" --config apps/web/vite.config.ts
  wait_http "http://127.0.0.1:${api_port}/api/v1/health"
  wait_http "http://127.0.0.1:${web_port}/"
}

run_playwright() {
  local phase="$1"
  local marker="$TMP_ROOT/$phase.started"
  local screenshots="$TMP_ROOT/$phase/screenshots"
  shift
  mkdir -p "$screenshots"
  touch "$marker"
  (
    cd "$ROOT"
    PLUGINMAX_WEB_BASE_URL="http://127.0.0.1:${WEB_PORT}" \
      node_modules/.bin/playwright test \
      --output="$TMP_ROOT/$phase/playwright-results" \
      "$@"
  ) 2>&1 | tee "$LOG_DIR/${phase}-playwright.log"
  while IFS= read -r -d '' screenshot; do
    cp "$screenshot" "$screenshots/$(basename "$screenshot")"
  done < <(find "$ROOT/.tmp" -type f -name '*.png' -newer "$marker")
  while IFS= read -r -d '' trace; do
    cp "$trace" "$screenshots/$(basename "$(dirname "$trace")")-trace.zip"
  done < <(find "$ROOT/.tmp" -type f -name 'trace.zip' -newer "$marker")
}

compose up -d postgres >/dev/null
for _ in {1..120}; do
  container_id="$(compose ps -q postgres)"
  health="$(docker inspect --format '{{.State.Health.Status}}' "$container_id" 2>/dev/null || true)"
  if [[ "$health" == "healthy" ]] &&
    psql_database postgres "SELECT 1;" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

if [[ "$PHASE" == "all" || "$PHASE" == "bearer" ]]; then
  psql_database postgres "CREATE DATABASE $BEARER_DATABASE;"
fi
if [[ "$PHASE" == "all" || "$PHASE" == "local" ]]; then
  psql_database postgres "CREATE DATABASE $LOCAL_DATABASE;"
fi

pnpm run build:packages >"$LOG_DIR/build-packages.log" 2>&1
pnpm --filter @pluginmax/api build >"$LOG_DIR/build-api.log" 2>&1
pnpm --filter @pluginmax/worker build >"$LOG_DIR/build-worker.log" 2>&1

if [[ "$PHASE" == "all" || "$PHASE" == "bearer" ]]; then
  export DATABASE_URL="$BEARER_URL"
  export AUTH_MODE=bearer
  export API_HOST=127.0.0.1
  export API_PORT="$BEARER_API_PORT"
  export WEB_PORT="$BEARER_WEB_PORT"
  export DSH_HOME="$TMP_ROOT/bearer/dsh-home"
  export FILE_STORE_ROOT="$TMP_ROOT/bearer/files"
  export AGENT_WORKSPACE_ROOT="$TMP_ROOT/bearer/workspaces"
  export RBAC_E2E_FIXTURE_PATH="$FIXTURE_PATH"
  export CORE_REGRESSION_PASSWORD
  export PLUGINMAX_ROOT="$ROOT"
  export WORKER_POLL_INTERVAL_MS=100
  export WORKER_LEASE_SECONDS=20
  export WORKER_LEASE_RENEW_INTERVAL_MS=500
  export WORKFLOW_SWEEP_INTERVAL_MS=250
  export MAINTENANCE_POLL_INTERVAL_MS=250
  export WORKER_HEARTBEAT_INTERVAL_MS=500
  mkdir -p "$DSH_HOME" "$FILE_STORE_ROOT" "$AGENT_WORKSPACE_ROOT"

  node_modules/.bin/tsx packages/database/src/migrate-cli.ts \
    >"$LOG_DIR/bearer-migrate.log" 2>&1
  node_modules/.bin/tsx scripts/core-regression-seed.ts \
    >"$LOG_DIR/bearer-seed.log" 2>&1

  WEB_PORT="$BEARER_WEB_PORT"
  start_services bearer "$BEARER_API_PORT" "$BEARER_WEB_PORT"
  record "bearer_phase=started"
  run_playwright \
    bearer \
    e2e/identity-administration.spec.ts \
    e2e/rbac-authorization.spec.ts \
    e2e/action-ticket-gate.spec.ts \
    e2e/meeting-collaboration.spec.ts \
    e2e/ai-teammate.spec.ts \
    e2e/scene-context.spec.ts \
    e2e/shared-space.spec.ts
  record "bearer_phase=passed"
  stop_phase_processes
fi

if [[ "$PHASE" == "all" || "$PHASE" == "local" ]]; then
  export DATABASE_URL="$LOCAL_URL"
  export AUTH_MODE=local-development
  export LOCAL_ACTOR_ID=local-admin
  export API_PORT="$LOCAL_API_PORT"
  export WEB_PORT="$LOCAL_WEB_PORT"
  export DSH_HOME="$TMP_ROOT/local/dsh-home"
  export FILE_STORE_ROOT="$TMP_ROOT/local/files"
  export AGENT_WORKSPACE_ROOT="$TMP_ROOT/local/workspaces"
  unset RBAC_E2E_FIXTURE_PATH CORE_REGRESSION_PASSWORD
  mkdir -p "$DSH_HOME" "$FILE_STORE_ROOT" "$AGENT_WORKSPACE_ROOT"

  node_modules/.bin/tsx packages/database/src/migrate-cli.ts \
    >"$LOG_DIR/local-migrate.log" 2>&1
  psql_database "$LOCAL_DATABASE" \
    "UPDATE feature_flag_settings
     SET mode = 'on', revision = revision + 1, updated_at = NOW()
     WHERE flag_key = 'workflow.assignment_bindings'
       AND scope_type = 'platform'
       AND scope_id = 'platform';" >/dev/null

  WEB_PORT="$LOCAL_WEB_PORT"
  start_services local "$LOCAL_API_PORT" "$LOCAL_WEB_PORT"
  record "local_phase=started"
  run_playwright \
    local \
    e2e/task-collaboration.spec.ts \
    e2e/delegation.spec.ts \
    e2e/ai-direct-chat.spec.ts \
    e2e/workbench-reports.spec.ts \
    e2e/external-runtime-gui.spec.ts
  record "local_phase=passed"
fi

cat >"$TMP_ROOT/manifest.json" <<JSON
{
  "runId": "$RUN_ID",
  "phase": "$PHASE",
  "platformSha": "$(git rev-parse HEAD)",
  "dshSha": "$(git -C '/Users/oliviayang/Codex/一切皆插件/dsh-pluginmax' rev-parse HEAD)",
  "fixturePath": "$FIXTURE_PATH",
  "bearerDatabase": "$BEARER_DATABASE",
  "localDatabase": "$LOCAL_DATABASE",
  "bearerPorts": { "api": $BEARER_API_PORT, "web": $BEARER_WEB_PORT },
  "localPorts": { "api": $LOCAL_API_PORT, "web": $LOCAL_WEB_PORT },
  "evidenceRoot": "$TMP_ROOT"
}
JSON

record "evidence_root=$TMP_ROOT"
