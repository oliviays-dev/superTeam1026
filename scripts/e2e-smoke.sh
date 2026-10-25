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
context_json="$(curl -fsS "$API_BASE/runs/$run_id/context")"
context_hash="$(printf '%s' "$context_json" | jq -r '.pack.contentHash')"
source_count="$(printf '%s' "$context_json" | jq '.pack.sources | length')"
artifact_json="$(curl -fsS "$API_BASE/runs/$run_id/artifacts")"
artifact_id="$(printf '%s' "$artifact_json" | jq -r '.items[0].id')"
if [[ "$event_count" -lt 5 || "$output_length" -lt 20 || ${#context_hash} -ne 64 || "$source_count" -lt 2 || "$artifact_id" == "null" ]]; then
  printf 'run verification failed: events=%s output=%s\n' \
    "$event_count" "$output_length" >&2
  exit 1
fi

curl -fsS "$API_BASE/artifacts/$artifact_id/download" >/dev/null

reviewed_task="$(
  curl -fsS -X POST "$API_BASE/tasks/$task_id/review" \
    -H "content-type: application/json" \
    -d '{"decision":"approve","note":"E2E acceptance passed"}'
)"
approved_status="$(printf '%s' "$reviewed_task" | jq -r '.status')"

memory_json="$(curl -fsS "$API_BASE/projects/$project_id/memory")"
memory_count="$(printf '%s' "$memory_json" | jq '.items | length')"

workflow_json="$(
  curl -fsS -X POST "$API_BASE/workflows" \
    -H "content-type: application/json" \
    -d "{\"projectId\":\"$project_id\",\"name\":\"E2E workflow $STAMP\",\"description\":\"Workflow smoke\",\"stepNames\":[\"Analysis\",\"Approval\"]}"
)"
workflow_id="$(printf '%s' "$workflow_json" | jq -r '.id')"
instance_json="$(
  curl -fsS -X POST "$API_BASE/workflows/$workflow_id/start" \
    -H "content-type: application/json" \
    -d "{\"title\":\"Workflow run $STAMP\"}"
)"
instance_id="$(printf '%s' "$instance_json" | jq -r '.id')"
curl -fsS -X POST "$API_BASE/workflow-instances/$instance_id/advance" >/dev/null
workflow_final="$(
  curl -fsS -X POST "$API_BASE/workflow-instances/$instance_id/advance"
)"
workflow_status="$(printf '%s' "$workflow_final" | jq -r '.status')"

meeting_json="$(
  curl -fsS -X POST "$API_BASE/meetings" \
    -H "content-type: application/json" \
    -d "{\"projectId\":\"$project_id\",\"title\":\"E2E meeting $STAMP\",\"agenda\":\"Smoke test\",\"agentIds\":[\"$agent_id\"]}"
)"
meeting_id="$(printf '%s' "$meeting_json" | jq -r '.id')"
curl -fsS -X POST "$API_BASE/meetings/$meeting_id/messages" \
  -H "content-type: application/json" \
  -d '{"content":"Meeting message smoke"}' >/dev/null
meeting_detail="$(curl -fsS "$API_BASE/meetings/$meeting_id")"
meeting_messages="$(printf '%s' "$meeting_detail" | jq '.messages | length')"
meeting_participants="$(printf '%s' "$meeting_detail" | jq '.meeting.participants | length')"
curl -fsS -X POST "$API_BASE/meetings/$meeting_id/close" \
  -H "content-type: application/json" \
  -d '{"summary":"Smoke closed"}' >/dev/null

if [[ "$approved_status" != "done" || "$memory_count" -lt 1 || "$workflow_status" != "completed" || "$meeting_messages" -lt 1 || "$meeting_participants" -lt 2 ]]; then
  printf 'full e2e verification failed\n' >&2
  exit 1
fi

printf 'e2e_smoke=ok\n'
printf 'project_id=%s\n' "$project_id"
printf 'task_id=%s\n' "$task_id"
printf 'run_id=%s\n' "$run_id"
printf 'events=%s\n' "$event_count"
printf 'output_length=%s\n' "$output_length"
printf 'context_hash=%s\n' "$context_hash"
printf 'context_sources=%s\n' "$source_count"
printf 'artifact_id=%s\n' "$artifact_id"
printf 'task_after_review=%s\n' "$approved_status"
printf 'memory_topics=%s\n' "$memory_count"
printf 'workflow_status=%s\n' "$workflow_status"
printf 'meeting_messages=%s\n' "$meeting_messages"
printf 'meeting_participants=%s\n' "$meeting_participants"
