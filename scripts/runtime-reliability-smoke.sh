#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
API_BASE="${API_BASE:-http://127.0.0.1:4450/api/v1}"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-pluginmax-batch7}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.batch7.yml}"
DATABASE_URL_INPUT="${DATABASE_URL:-postgres://pluginmax:pluginmax@127.0.0.1:54379/pluginmax}"
DSH_HOME_INPUT="${DSH_HOME:-$ROOT/../dsh-home-batch7}"
LOG_DIR="${LOG_DIR:-$ROOT/.tmp/batch7/runtime-smoke}"
STAMP="$(date +%Y%m%d-%H%M%S)"
WORKER_PIDS=()
WORKER_PID=""

mkdir -p "$LOG_DIR"

cleanup() {
  local pid
  for pid in "${WORKER_PIDS[@]:-}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill -TERM "$pid" 2>/dev/null || true
    fi
  done
  for pid in "${WORKER_PIDS[@]:-}"; do
    wait "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT

psql_query() {
  docker-compose -p "$COMPOSE_PROJECT" -f "$ROOT/$COMPOSE_FILE" \
    exec -T postgres psql -U pluginmax -d pluginmax -qAt -v ON_ERROR_STOP=1 -c "$1"
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

start_worker() {
  local name="$1"
  local concurrency="$2"
  local lease_seconds="$3"
  local renew_ms="$4"
  local grace_ms="$5"
  local log_file="$LOG_DIR/$name.log"
  env \
    DATABASE_URL="$DATABASE_URL_INPUT" \
    DSH_HOME="$DSH_HOME_INPUT" \
    DSH_BIN="" \
    WORKER_CONCURRENCY="$concurrency" \
    WORKER_POLL_INTERVAL_MS=40 \
    WORKER_LEASE_SECONDS="$lease_seconds" \
    WORKER_LEASE_RENEW_INTERVAL_MS="$renew_ms" \
    WORKER_SHUTDOWN_GRACE_MS="$grace_ms" \
    WORKER_RETRY_BASE_DELAY_MS=50 \
    WORKER_RETRY_MAX_DELAY_MS=200 \
    WORKER_HEARTBEAT_INTERVAL_MS=250 \
    WORKER_HEARTBEAT_STALE_AFTER_SECONDS=3 \
    WORKFLOW_SWEEP_INTERVAL_MS=250 \
    IDEMPOTENCY_RETENTION_SECONDS=60 \
    IDEMPOTENCY_CLEANUP_INTERVAL_MS=60000 \
    node "$ROOT/apps/worker/lib/index.js" >"$log_file" 2>&1 &
  local pid=$!
  WORKER_PIDS+=("$pid")
  for _ in {1..100}; do
    if grep -q '"event":"worker.started"' "$log_file" 2>/dev/null; then
      WORKER_PID="$pid"
      return 0
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      printf 'worker %s exited during startup\n' "$name" >&2
      sed -n '1,120p' "$log_file" >&2
      return 1
    fi
    sleep 0.05
  done
  printf 'worker %s did not become ready\n' "$name" >&2
  return 1
}

create_dispatched_run() {
  local title="$1"
  local task_json run_json task_id run_id
  task_json="$(
    api POST /tasks "$(
      jq -n \
        --arg projectId "$PROJECT_ID" \
        --arg title "$title $STAMP" \
        '{
          projectId: $projectId,
          title: $title,
          description: "runtime reliability process test",
          acceptance: ["process completes", "artifact exists"],
          agentId: "00000000-0000-4000-8000-000000000001"
        }'
    )"
  )"
  task_id="$(printf '%s' "$task_json" | jq -r '.id')"
  run_json="$(api POST "/tasks/$task_id/dispatch")"
  run_id="$(printf '%s' "$run_json" | jq -r '.runId')"
  printf '%s' "$run_id"
}

set_runtime_options() {
  local run_id="$1"
  local runtime_options="$2"
  psql_query "
    UPDATE runs
    SET
      input_snapshot =
        jsonb_set(input_snapshot, '{runtimeOptions}', '$runtime_options'::jsonb, true),
      updated_at = NOW()
    WHERE id = '$run_id';
  "
}

wait_run_status() {
  local run_id="$1"
  local expected="$2"
  local timeout_seconds="${3:-20}"
  local status=""
  for _ in $(seq 1 "$((timeout_seconds * 20))"); do
    status="$(api GET "/runs/$run_id" | jq -r '.run.status')"
    if [[ "$status" == "$expected" ]]; then
      return 0
    fi
    sleep 0.05
  done
  printf 'run %s did not reach %s; current=%s\n' \
    "$run_id" "$expected" "$status" >&2
  return 1
}

wait_job_field() {
  local run_id="$1"
  local field="$2"
  local expected="$3"
  local timeout_seconds="${4:-20}"
  local value=""
  for _ in $(seq 1 "$((timeout_seconds * 20))"); do
    value="$(psql_query "
      SELECT $field FROM jobs WHERE run_id = '$run_id';
    ")"
    if [[ "$value" == "$expected" ]]; then
      return 0
    fi
    sleep 0.05
  done
  printf 'job for run %s field %s did not reach %s; current=%s\n' \
    "$run_id" "$field" "$expected" "$value" >&2
  return 1
}

wait_log() {
  local log_file="$1"
  local pattern="$2"
  local timeout_seconds="${3:-20}"
  for _ in $(seq 1 "$((timeout_seconds * 20))"); do
    if grep -q "$pattern" "$log_file" 2>/dev/null; then
      return 0
    fi
    sleep 0.05
  done
  printf 'log %s did not contain %s\n' "$log_file" "$pattern" >&2
  return 1
}

wait_pid_exit() {
  local pid="$1"
  local watchdog
  (
    sleep 15
    if kill -0 "$pid" 2>/dev/null; then
      kill -KILL "$pid" 2>/dev/null || true
    fi
  ) &
  watchdog=$!
  wait "$pid" 2>/dev/null || true
  kill "$watchdog" 2>/dev/null || true
  wait "$watchdog" 2>/dev/null || true
}

curl -fsS "$API_BASE/health" >/dev/null

project_json="$(
  api POST /projects "$(
    jq -n --arg name "Runtime reliability $STAMP" \
      '{name: $name, description: "batch 7 process isolation"}'
  )"
)"
PROJECT_ID="$(printf '%s' "$project_json" | jq -r '.id')"

# Two workers and four queued jobs prove the pool never claims a Job twice.
concurrent_runs=()
for index in 1 2 3 4; do
  concurrent_runs+=("$(create_dispatched_run "Concurrent $index")")
done
start_worker concurrent-a 2 3 500 1000
worker_a="$WORKER_PID"
start_worker concurrent-b 2 3 500 1000
worker_b="$WORKER_PID"
for run_id in "${concurrent_runs[@]}"; do
  wait_run_status "$run_id" completed 20
  attempts="$(psql_query "
    SELECT COUNT(*) FROM job_attempts
    WHERE job_id = (SELECT id FROM jobs WHERE run_id = '$run_id');
  ")"
  artifacts="$(psql_query "
    SELECT COUNT(*) FROM artifacts WHERE run_id = '$run_id';
  ")"
  if [[ "$attempts" != "1" || "$artifacts" != "1" ]]; then
    printf 'concurrency convergence failed: run=%s attempts=%s artifacts=%s\n' \
      "$run_id" "$attempts" "$artifacts" >&2
    exit 1
  fi
done
kill -TERM "$worker_a" "$worker_b"
wait_pid_exit "$worker_a"
wait_pid_exit "$worker_b"

# SIGKILL a long-running worker, then recover the expired lease in another process.
crash_run="$(create_dispatched_run "Lease recovery")"
set_runtime_options "$crash_run" '{"delayMs":2500}'
start_worker crash-a 1 2 300 500
worker_crash="$WORKER_PID"
wait_log "$LOG_DIR/crash-a.log" '"event":"job.claimed"' 10
sleep 0.3
kill -KILL "$worker_crash"
wait_pid_exit "$worker_crash"
sleep 2.1
start_worker recovery-a 1 3 500 1000
worker_recovery="$WORKER_PID"
wait_run_status "$crash_run" completed 25
interrupted_events="$(psql_query "
  SELECT COUNT(*) FROM run_events
  WHERE run_id = '$crash_run' AND type = 'run.interrupted';
")"
recovered_events="$(psql_query "
  SELECT COUNT(*) FROM run_events
  WHERE run_id = '$crash_run' AND type = 'run.recovered';
")"
recovered_artifacts="$(psql_query "
  SELECT COUNT(*) FROM artifacts WHERE run_id = '$crash_run';
")"
recovered_attempts="$(psql_query "
  SELECT COUNT(*) FROM job_attempts
  WHERE job_id = (SELECT id FROM jobs WHERE run_id = '$crash_run');
")"
if [[ "$interrupted_events" -lt 1 || "$recovered_events" -lt 1 ||
      "$recovered_artifacts" != "1" || "$recovered_attempts" -lt 2 ]]; then
  printf 'lease recovery convergence failed: interrupted=%s recovered=%s artifacts=%s attempts=%s\n' \
    "$interrupted_events" "$recovered_events" "$recovered_artifacts" \
    "$recovered_attempts" >&2
  exit 1
fi
kill -TERM "$worker_recovery"
wait_pid_exit "$worker_recovery"

# Exhaust retries into dead letter, recover through the API, clear the fault, and converge.
dead_letter_run="$(create_dispatched_run "Dead letter")"
set_runtime_options "$dead_letter_run" '{"fault":"fail"}'
psql_query "
  UPDATE jobs SET max_attempts = 2
  WHERE run_id = '$dead_letter_run';
"
start_worker dead-letter-a 1 3 500 1000
worker_dead_letter="$WORKER_PID"
wait_job_field "$dead_letter_run" status dead_letter 20
dead_letter_job_id="$(psql_query "
  SELECT id FROM jobs WHERE run_id = '$dead_letter_run';
")"
dead_letter_events="$(psql_query "
  SELECT COUNT(*) FROM run_events
  WHERE run_id = '$dead_letter_run' AND type = 'job.dead_lettered';
")"
if [[ "$dead_letter_events" -lt 1 ]]; then
  printf 'dead letter event missing for run %s\n' "$dead_letter_run" >&2
  exit 1
fi
kill -TERM "$worker_dead_letter"
wait_pid_exit "$worker_dead_letter"
recovered_job="$(
  api POST "/jobs/$dead_letter_job_id/recover" \
    '{"reason":"runtime reliability smoke recovery"}'
)"
if [[ "$(printf '%s' "$recovered_job" | jq -r '.status')" != "queued" ]]; then
  printf 'manual job recovery failed: %s\n' "$recovered_job" >&2
  exit 1
fi
set_runtime_options "$dead_letter_run" '{}'
start_worker dead-letter-recovered-a 1 3 500 1000
worker_dead_letter_recovered="$WORKER_PID"
wait_job_field "$dead_letter_run" status completed 20
manual_recoveries="$(psql_query "
  SELECT manual_recovery_count FROM jobs WHERE run_id = '$dead_letter_run';
")"
if [[ "$manual_recoveries" != "1" ]]; then
  printf 'manual recovery count mismatch: %s\n' "$manual_recoveries" >&2
  exit 1
fi
kill -TERM "$worker_dead_letter_recovered"
wait_pid_exit "$worker_dead_letter_recovered"

# SIGTERM waits for an in-flight Job within the configured grace period.
grace_run="$(create_dispatched_run "Graceful shutdown")"
set_runtime_options "$grace_run" '{"delayMs":1200}'
start_worker graceful-a 1 3 500 5000
worker_grace="$WORKER_PID"
wait_log "$LOG_DIR/graceful-a.log" '"event":"job.claimed"' 10
kill -TERM "$worker_grace"
wait_pid_exit "$worker_grace"
wait_run_status "$grace_run" completed 20
grace_interrupts="$(psql_query "
  SELECT COUNT(*) FROM run_events
  WHERE run_id = '$grace_run' AND type = 'run.interrupted';
")"
if [[ "$grace_interrupts" != "0" ]]; then
  printf 'graceful shutdown interrupted a completed run\n' >&2
  exit 1
fi

# SIGTERM after the deadline aborts the Job safely so a later worker can recover it.
timeout_run="$(create_dispatched_run "Forced interrupt")"
set_runtime_options "$timeout_run" '{"delayMs":5000}'
start_worker timeout-a 1 3 500 250
worker_timeout="$WORKER_PID"
wait_log "$LOG_DIR/timeout-a.log" '"event":"job.claimed"' 10
kill -TERM "$worker_timeout"
wait_pid_exit "$worker_timeout"
wait_run_status "$timeout_run" interrupted 10
start_worker after-timeout-a 1 3 500 1000
worker_after_timeout="$WORKER_PID"
wait_run_status "$timeout_run" completed 20
kill -TERM "$worker_after_timeout"
wait_pid_exit "$worker_after_timeout"

# SIGINT drains an idle process without leaving a heartbeat in running state.
start_worker sigint-a 1 3 500 1000
worker_int="$WORKER_PID"
kill -INT "$worker_int"
wait_pid_exit "$worker_int"
wait_log "$LOG_DIR/sigint-a.log" '"event":"worker.drained"' 10

metrics="$(api GET /operations)"
if [[ "$(printf '%s' "$metrics" | jq '.metrics.migrationVersion')" != "12" ]]; then
  printf 'operations migration version mismatch\n' >&2
  exit 1
fi

printf 'runtime_reliability_smoke=ok\n'
printf 'project_id=%s\n' "$PROJECT_ID"
printf 'concurrent_runs=%s\n' "${#concurrent_runs[@]}"
printf 'lease_recovery_run=%s\n' "$crash_run"
printf 'dead_letter_run=%s\n' "$dead_letter_run"
printf 'graceful_shutdown_run=%s\n' "$grace_run"
printf 'forced_interrupt_run=%s\n' "$timeout_run"
printf 'log_dir=%s\n' "$LOG_DIR"
