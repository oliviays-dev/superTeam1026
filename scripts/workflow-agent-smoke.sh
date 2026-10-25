#!/usr/bin/env bash
set -euo pipefail

API_BASE="${API_BASE:-http://127.0.0.1:4310/api/v1}"
STAMP="$(date +%Y%m%d-%H%M%S)"

request_code() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  if [[ -z "$body" ]]; then
    curl -sS -o /dev/null -w "%{http_code}" -X "$method" "$API_BASE$path"
  else
    curl -sS -o /dev/null -w "%{http_code}" -X "$method" "$API_BASE$path" \
      -H "content-type: application/json" -d "$body"
  fi
}

curl -fsS "$API_BASE/health" >/dev/null
agent="$(
  curl -fsS -X POST "$API_BASE/agents" \
    -H "content-type: application/json" \
    -d "{\"name\":\"Workflow agent $STAMP\",\"runtimeKind\":\"fake\"}"
)"
agent_id="$(printf '%s' "$agent" | jq -r '.id')"
project="$(
  curl -fsS -X POST "$API_BASE/projects" \
    -H "content-type: application/json" \
    -d "{\"name\":\"Workflow agent $STAMP\"}"
)"
project_id="$(printf '%s' "$project" | jq -r '.id')"
role="$(
  curl -fsS -X POST "$API_BASE/projects/$project_id/roles" \
    -H "content-type: application/json" \
    -d '{"name":"Workflow executor"}'
)"
role_id="$(printf '%s' "$role" | jq -r '.id')"
curl -fsS -X POST "$API_BASE/projects/$project_id/members" \
  -H "content-type: application/json" \
  -d "{\"kind\":\"agent\",\"agentId\":\"$agent_id\",\"roleIds\":[\"$role_id\"]}" \
  >/dev/null

markdown="# 工作流：Agent 自动派发

## 元信息

- key: agent-auto-$STAMP
- version: 1

## 节点

### 分析

- id: analysis
- type: task
- executor: role:$role_id
- execution: task-worker
- trigger: auto-on-ready

### 人工确认

- id: confirm
- type: service
- executor: system:manual

## 连接

- analysis -> confirm"

workflow="$(
  curl -fsS -X POST "$API_BASE/workflows/import" \
    -H "content-type: application/json" \
    -d "$(jq -n --arg projectId "$project_id" --arg markdown "$markdown" \
      '{projectId: $projectId, markdown: $markdown}')"
)"
workflow_id="$(printf '%s' "$workflow" | jq -r '.id')"
instance="$(
  curl -fsS -X POST "$API_BASE/workflows/$workflow_id/start" \
    -H "content-type: application/json" \
    -d "{\"title\":\"Auto dispatch $STAMP\"}"
)"
instance_id="$(printf '%s' "$instance" | jq -r '.id')"
task_id="$(printf '%s' "$instance" | jq -r '.steps[0].taskId')"
run_id="$(printf '%s' "$instance" | jq -r '.steps[0].runId')"

status=""
for _ in {1..100}; do
  task_status="$(
    curl -fsS "$API_BASE/tasks/$task_id" | jq -r '.status'
  )"
  if [[ "$task_status" == "review" ]]; then
    status="review"
    break
  fi
  sleep 0.2
done
if [[ "$status" != "review" ]]; then
  printf 'workflow task did not reach review\n' >&2
  exit 1
fi

blocked_code="$(
  request_code POST "/workflow-instances/$instance_id/advance"
)"
if [[ "$blocked_code" != "409" ]]; then
  printf 'expected workflow gate 409, received %s\n' "$blocked_code" >&2
  exit 1
fi

curl -fsS -X POST "$API_BASE/tasks/$task_id/review" \
  -H "content-type: application/json" \
  -d '{"decision":"approve","note":"Agent step accepted"}' \
  >/dev/null
artifact_count="$(
  curl -fsS "$API_BASE/runs/$run_id/artifacts" | jq '.items | length'
)"
if [[ "$artifact_count" -lt 1 ]]; then
  printf 'workflow deliverable gate has no artifact\n' >&2
  exit 1
fi
advanced="$(
  curl -fsS -X POST "$API_BASE/workflow-instances/$instance_id/advance"
)"
completed="$(
  curl -fsS -X POST "$API_BASE/workflow-instances/$instance_id/advance"
)"
final_status="$(printf '%s' "$completed" | jq -r '.status')"
first_step_status="$(printf '%s' "$advanced" | jq -r '.steps[0].status')"

if [[ -z "$task_id" ||
      "$task_id" == "null" ||
      -z "$run_id" ||
      "$run_id" == "null" ||
      "$first_step_status" != "completed" ||
      "$final_status" != "completed" ]]; then
  printf 'workflow agent verification failed\n' >&2
  printf '%s\n' "$advanced" >&2
  printf '%s\n' "$completed" >&2
  exit 1
fi

printf 'workflow_agent_smoke=ok\n'
printf 'project_id=%s\n' "$project_id"
printf 'workflow_id=%s\n' "$workflow_id"
printf 'instance_id=%s\n' "$instance_id"
printf 'task_id=%s\n' "$task_id"
printf 'run_id=%s\n' "$run_id"
printf 'artifact_count=%s\n' "$artifact_count"
