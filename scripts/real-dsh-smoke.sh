#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${DEEPSEEK_API_KEY:-}" ]]; then
  printf 'DEEPSEEK_API_KEY is required for the real DSH smoke\n' >&2
  exit 2
fi

API_BASE="${API_BASE:-http://127.0.0.1:4450/api/v1}"
STAMP="$(date +%Y%m%d-%H%M%S)"

project_json="$(
  curl -fsS -X POST "$API_BASE/projects" \
    -H "content-type: application/json" \
    -d "{\"name\":\"DSH effect smoke $STAMP\",\"description\":\"Manual real-runtime validation\"}"
)"
project_id="$(printf '%s' "$project_json" | jq -r '.id')"

task_json="$(
  curl -fsS -X POST "$API_BASE/tasks" \
    -H "content-type: application/json" \
    -d "$(
      jq -n \
        --arg projectId "$project_id" \
        --arg title "DSH effect smoke $STAMP" \
        '{
          projectId: $projectId,
          title: $title,
          description: "State one durable engineering conclusion in two sentences.",
          acceptance: ["Return a concise engineering conclusion"],
          agentId: "00000000-0000-4000-8000-000000000002"
        }'
    )"
)"
task_id="$(printf '%s' "$task_json" | jq -r '.id')"
run_id="$(
  curl -fsS -X POST "$API_BASE/tasks/$task_id/dispatch" |
    jq -r '.runId'
)"

status=""
for _ in $(seq 1 600); do
  run_json="$(curl -fsS "$API_BASE/runs/$run_id")"
  status="$(printf '%s' "$run_json" | jq -r '.run.status')"
  case "$status" in
    completed) break ;;
    failed | cancelled | timeout | interrupted)
      printf 'real DSH run ended with status %s\n' "$status" >&2
      printf '%s\n' "$run_json" | jq '{status: .run.status, error: .run.error}' >&2
      exit 1
      ;;
  esac
  sleep 1
done

if [[ "$status" != "completed" ]]; then
  printf 'real DSH run did not complete before the timeout; last status=%s\n' \
    "$status" >&2
  exit 1
fi

artifacts="$(curl -fsS "$API_BASE/runs/$run_id/artifacts")"
artifact_count="$(printf '%s' "$artifacts" | jq '.items | length')"
replayed_events="$(curl -fsS "$API_BASE/runs/$run_id/events" |
  jq '[.items[] | select(.type == "runtime.effect_replayed")] | length')"

if [[ "$artifact_count" -lt 1 ]]; then
  printf 'real DSH smoke completed without an artifact\n' >&2
  exit 1
fi

printf 'real_dsh_smoke=ok\n'
printf 'project_id=%s\n' "$project_id"
printf 'task_id=%s\n' "$task_id"
printf 'run_id=%s\n' "$run_id"
printf 'artifacts=%s\n' "$artifact_count"
printf 'effect_replays=%s\n' "$replayed_events"
