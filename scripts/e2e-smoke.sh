#!/usr/bin/env bash
set -euo pipefail

API_BASE="${API_BASE:-http://127.0.0.1:4310/api/v1}"
STAMP="$(date +%Y%m%d-%H%M%S)"

curl -fsS "$API_BASE/health" >/dev/null

project_json="$(
  curl -fsS -X POST "$API_BASE/projects" \
    -H "content-type: application/json" \
    -d "{\"name\":\"E2E Smoke $STAMP\",\"description\":\"Automated engineering smoke test\"}"
)"
project_id="$(printf '%s' "$project_json" | jq -r '.id')"
agent_id="$(curl -fsS "$API_BASE/agents" | jq -r '.items[0].id')"

task_json="$(
  curl -fsS -X POST "$API_BASE/tasks" \
    -H "content-type: application/json" \
    -d "{\"projectId\":\"$project_id\",\"title\":\"E2E smoke $STAMP\",\"description\":\"Validate task, run, worker, and event persistence.\",\"acceptance\":[\"Run completes\",\"Events are persisted\"],\"agentId\":\"$agent_id\"}"
)"
task_id="$(printf '%s' "$task_json" | jq -r '.id')"
run_id="$(
  curl -fsS -X POST "$API_BASE/tasks/$task_id/dispatch" |
    jq -r '.runId'
)"

status=""
for _ in {1..80}; do
  run_json="$(curl -fsS "$API_BASE/runs/$run_id")"
  status="$(printf '%s' "$run_json" | jq -r '.run.status')"
  case "$status" in
    completed | failed | cancelled | timeout | interrupted) break ;;
  esac
  sleep 0.25
done

if [[ "$status" != "completed" ]]; then
  printf 'run %s finished with status %s\n' "$run_id" "$status" >&2
  printf '%s\n' "$run_json" >&2
  exit 1
fi

event_count="$(printf '%s' "$run_json" | jq '.events | length')"
output_length="$(printf '%s' "$run_json" | jq -r '.run.output // "" | length')"
if [[ "$event_count" -lt 5 || "$output_length" -lt 20 ]]; then
  printf 'run verification failed: events=%s output=%s\n' \
    "$event_count" "$output_length" >&2
  exit 1
fi

printf 'e2e_smoke=ok\n'
printf 'project_id=%s\n' "$project_id"
printf 'task_id=%s\n' "$task_id"
printf 'run_id=%s\n' "$run_id"
printf 'events=%s\n' "$event_count"
printf 'output_length=%s\n' "$output_length"
