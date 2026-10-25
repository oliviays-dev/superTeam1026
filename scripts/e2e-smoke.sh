#!/usr/bin/env bash
set -euo pipefail

API_BASE="${API_BASE:-http://127.0.0.1:4310/api/v1}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"

curl -fsS "$API_BASE/health" >/dev/null

agent_json="$(
  curl -fsS -X POST "$API_BASE/agents" \
    -H "content-type: application/json" \
    -d "{\"name\":\"E2E Agent $STAMP\",\"description\":\"Agent management smoke\",\"soul\":\"Use evidence and report clearly.\",\"scenarios\":[\"Task execution\"],\"goals\":[\"Return a verifiable result\"],\"tools\":[\"task.read\",\"artifact.write\"],\"runtimeKind\":\"fake\",\"source\":\"personal\"}"
)"
agent_id="$(printf '%s' "$agent_json" | jq -r '.id')"
agent_detail="$(
  curl -fsS -X PATCH "$API_BASE/agents/$agent_id" \
    -H "content-type: application/json" \
    -d '{"soul":"Use evidence, state assumptions, and report clearly.","expectedVersion":1}'
)"
agent_version="$(printf '%s' "$agent_detail" | jq -r '.agent.version')"
agent_event_count="$(printf '%s' "$agent_detail" | jq '.events | length')"

project_json="$(
  curl -fsS -X POST "$API_BASE/projects" \
    -H "content-type: application/json" \
    -d "{\"name\":\"E2E Smoke $STAMP\",\"description\":\"Automated engineering smoke test\"}"
)"
project_id="$(printf '%s' "$project_json" | jq -r '.id')"
project_updated="$(
  curl -fsS -X PATCH "$API_BASE/projects/$project_id" \
    -H "content-type: application/json" \
    -d '{"description":"Automated engineering smoke test with project updates"}'
)"
project_description="$(printf '%s' "$project_updated" | jq -r '.description')"

role_json="$(
  curl -fsS -X POST "$API_BASE/projects/$project_id/roles" \
    -H "content-type: application/json" \
    -d "{\"name\":\"E2E Reviewer $STAMP\",\"description\":\"Project membership smoke role\"}"
)"
role_id="$(printf '%s' "$role_json" | jq -r '.id')"
member_json="$(
  curl -fsS -X POST "$API_BASE/projects/$project_id/members" \
    -H "content-type: application/json" \
    -d "{\"kind\":\"agent\",\"agentId\":\"$agent_id\",\"responsibility\":\"Membership smoke\",\"roleIds\":[\"$role_id\"]}"
)"
member_id="$(printf '%s' "$member_json" | jq -r '.id')"
member_updated="$(
  curl -fsS -X PATCH "$API_BASE/projects/$project_id/members/$member_id" \
    -H "content-type: application/json" \
    -d "{\"responsibility\":\"Updated membership smoke\",\"roleIds\":[\"$role_id\"]}"
)"
member_responsibility="$(printf '%s' "$member_updated" | jq -r '.responsibility')"
members_json="$(curl -fsS "$API_BASE/projects/$project_id/members")"
project_member_count="$(printf '%s' "$members_json" | jq '.items | length')"
project_owner_count="$(printf '%s' "$members_json" | jq '[.items[] | select(.owner)] | length')"
project_role_count="$(
  curl -fsS "$API_BASE/projects/$project_id/roles" | jq '.items | length'
)"

task_json="$(
  curl -fsS -X POST "$API_BASE/tasks" \
    -H "content-type: application/json" \
    -d "{\"projectId\":\"$project_id\",\"title\":\"E2E smoke $STAMP\",\"description\":\"Validate task, run, worker, and event persistence.\",\"acceptance\":[\"Run completes\",\"Events are persisted\"],\"agentId\":\"$agent_id\"}"
)"
task_id="$(printf '%s' "$task_json" | jq -r '.id')"
task_updated="$(
  curl -fsS -X PATCH "$API_BASE/tasks/$task_id" \
    -H "content-type: application/json" \
    -d '{"acceptance":["Run completes","Events are persisted","Task collaboration is traceable"]}'
)"
task_acceptance_count="$(printf '%s' "$task_updated" | jq '.task.acceptance | length')"
curl -fsS -X POST "$API_BASE/tasks/$task_id/messages" \
  -H "content-type: application/json" \
  -d '{"content":"E2E task comment"}' >/dev/null
task_detail="$(curl -fsS "$API_BASE/tasks/$task_id/detail")"
task_message_count="$(printf '%s' "$task_detail" | jq '.messages | length')"
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

agent_disabled="$(
  curl -fsS -X POST "$API_BASE/agents/$agent_id/status" \
    -H "content-type: application/json" \
    -d '{"status":"disabled"}'
)"
agent_final_status="$(printf '%s' "$agent_disabled" | jq -r '.agent.status')"
agent_final_version="$(printf '%s' "$agent_disabled" | jq -r '.agent.version')"

if [[ "$agent_version" -ne 2 || "$agent_event_count" -lt 2 || "$project_description" != "Automated engineering smoke test with project updates" || "$project_member_count" -lt 2 || "$project_owner_count" -ne 1 || "$project_role_count" -lt 2 || "$member_responsibility" != "Updated membership smoke" || "$task_acceptance_count" -ne 3 || "$task_message_count" -lt 1 || "$approved_status" != "done" || "$memory_count" -lt 1 || "$workflow_status" != "completed" || "$meeting_messages" -lt 1 || "$meeting_participants" -lt 2 || "$agent_final_status" != "disabled" || "$agent_final_version" -ne 3 ]]; then
  printf 'full e2e verification failed\n' >&2
  exit 1
fi

API_BASE="$API_BASE" "$SCRIPT_DIR/dependency-memory-smoke.sh"
API_BASE="$API_BASE" "$SCRIPT_DIR/task-collaboration-smoke.sh"
API_BASE="$API_BASE" "$SCRIPT_DIR/workflow-markdown-smoke.sh"
API_BASE="$API_BASE" "$SCRIPT_DIR/workflow-agent-smoke.sh"
API_BASE="$API_BASE" "$SCRIPT_DIR/workflow-runtime-smoke.sh"

printf 'e2e_smoke=ok\n'
printf 'agent_id=%s\n' "$agent_id"
printf 'agent_version=%s\n' "$agent_final_version"
printf 'agent_events=%s\n' "$agent_event_count"
printf 'project_id=%s\n' "$project_id"
printf 'project_description=%s\n' "$project_description"
printf 'project_members=%s\n' "$project_member_count"
printf 'project_roles=%s\n' "$project_role_count"
printf 'project_member_id=%s\n' "$member_id"
printf 'task_id=%s\n' "$task_id"
printf 'task_acceptance=%s\n' "$task_acceptance_count"
printf 'task_messages=%s\n' "$task_message_count"
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
