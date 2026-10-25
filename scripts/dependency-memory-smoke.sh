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
    curl -sS -o /dev/null -w "%{http_code}" \
      -X "$method" "$API_BASE$path" \
      -H "content-type: application/json" \
      -d "$body"
  fi
}

expect_code() {
  local expected="$1"
  local actual="$2"
  local label="$3"
  if [[ "$actual" != "$expected" ]]; then
    printf '%s: expected HTTP %s, received %s\n' \
      "$label" "$expected" "$actual" >&2
    exit 1
  fi
}

wait_for_run() {
  local run_id="$1"
  local status=""
  local body=""
  for _ in {1..100}; do
    body="$(curl -fsS "$API_BASE/runs/$run_id")"
    status="$(printf '%s' "$body" | jq -r '.run.status')"
    case "$status" in
      completed | failed | cancelled | timeout | interrupted) break ;;
    esac
    sleep 0.2
  done
  if [[ "$status" != "completed" ]]; then
    printf 'run %s finished with status %s\n' "$run_id" "$status" >&2
    printf '%s\n' "$body" >&2
    exit 1
  fi
}

curl -fsS "$API_BASE/health" >/dev/null

agent="$(
  curl -fsS -X POST "$API_BASE/agents" \
    -H "content-type: application/json" \
    -d "{\"name\":\"Dependency agent $STAMP\",\"runtimeKind\":\"fake\"}"
)"
agent_id="$(printf '%s' "$agent" | jq -r '.id')"

project="$(
  curl -fsS -X POST "$API_BASE/projects" \
    -H "content-type: application/json" \
    -d "{\"name\":\"Dependency memory $STAMP\"}"
)"
project_id="$(printf '%s' "$project" | jq -r '.id')"

role="$(
  curl -fsS -X POST "$API_BASE/projects/$project_id/roles" \
    -H "content-type: application/json" \
    -d '{"name":"Delivery role","description":"Owns dependency execution"}'
)"
role_id="$(printf '%s' "$role" | jq -r '.id')"

curl -fsS -X POST "$API_BASE/projects/$project_id/members" \
  -H "content-type: application/json" \
  -d "{\"kind\":\"agent\",\"agentId\":\"$agent_id\",\"roleIds\":[\"$role_id\"]}" \
  >/dev/null

workflow="$(
  curl -fsS -X POST "$API_BASE/workflows" \
    -H "content-type: application/json" \
    -d "{\"projectId\":\"$project_id\",\"name\":\"Role workflow $STAMP\",\"stepNames\":[\"Draft\",\"Deliver\"],\"stepRoleIds\":[\"$role_id\",\"$role_id\"]}"
)"
workflow_agent_id="$(printf '%s' "$workflow" | jq -r '.steps[0].agentId')"
workflow_role_id="$(printf '%s' "$workflow" | jq -r '.steps[0].roleId')"

blocker="$(
  curl -fsS -X POST "$API_BASE/tasks" \
    -H "content-type: application/json" \
    -d "{\"projectId\":\"$project_id\",\"title\":\"Provide contract $STAMP\",\"description\":\"Produce the prerequisite contract.\",\"agentId\":\"$agent_id\"}"
)"
blocker_id="$(printf '%s' "$blocker" | jq -r '.id')"

dependent="$(
  curl -fsS -X POST "$API_BASE/tasks" \
    -H "content-type: application/json" \
    -d "{\"projectId\":\"$project_id\",\"title\":\"Implement integration $STAMP\",\"description\":\"Consume the prerequisite contract.\",\"roleId\":\"$role_id\",\"dependsOn\":[\"$blocker_id\"]}"
)"
dependent_id="$(printf '%s' "$dependent" | jq -r '.id')"
resolved_agent_id="$(printf '%s' "$dependent" | jq -r '.agentId')"
resolved_role_id="$(printf '%s' "$dependent" | jq -r '.roleId')"

blocked_code="$(request_code POST "/tasks/$dependent_id/dispatch")"
expect_code 409 "$blocked_code" "unresolved dependency dispatch"

cycle_code="$(
  request_code PATCH "/tasks/$blocker_id" \
    "{\"dependsOn\":[\"$dependent_id\"]}"
)"
expect_code 409 "$cycle_code" "dependency cycle"

blocker_run="$(
  curl -fsS -X POST "$API_BASE/tasks/$blocker_id/dispatch" |
    jq -r '.runId'
)"
wait_for_run "$blocker_run"
curl -fsS -X POST "$API_BASE/tasks/$blocker_id/review" \
  -H "content-type: application/json" \
  -d '{"decision":"approve","note":"Prerequisite accepted"}' \
  >/dev/null

released_code="$(request_code POST "/tasks/$dependent_id/dispatch")"
expect_code 202 "$released_code" "resolved dependency dispatch"

topic="$(
  curl -fsS -X POST "$API_BASE/projects/$project_id/memory/topics" \
    -H "content-type: application/json" \
    -d "{\"title\":\"Delivery truth $STAMP\"}"
)"
topic_id="$(printf '%s' "$topic" | jq -r '.id')"

claim_one="$(
  curl -fsS -X POST \
    "$API_BASE/projects/$project_id/memory/topics/$topic_id/claims" \
    -H "content-type: application/json" \
    -d '{"content":"The interface contract is versioned."}'
)"
claim_one_id="$(printf '%s' "$claim_one" | jq -r '.id')"
curl -fsS -X PATCH \
  "$API_BASE/projects/$project_id/memory/topics/$topic_id/claims/$claim_one_id" \
  -H "content-type: application/json" \
  -d '{"status":"confirmed"}' \
  >/dev/null
truth_one="$(
  curl -fsS -X POST \
    "$API_BASE/projects/$project_id/memory/topics/$topic_id/truths" \
    -H "content-type: application/json" \
    -d "{\"claimIds\":[\"$claim_one_id\"]}"
)"
truth_one_version="$(printf '%s' "$truth_one" | jq -r '.currentTruth.version')"

claim_two="$(
  curl -fsS -X POST \
    "$API_BASE/projects/$project_id/memory/topics/$topic_id/claims" \
    -H "content-type: application/json" \
    -d '{"content":"Integration tests must cover the dependency gate."}'
)"
claim_two_id="$(printf '%s' "$claim_two" | jq -r '.id')"
curl -fsS -X PATCH \
  "$API_BASE/projects/$project_id/memory/topics/$topic_id/claims/$claim_two_id" \
  -H "content-type: application/json" \
  -d '{"status":"confirmed"}' \
  >/dev/null
truth_two="$(
  curl -fsS -X POST \
    "$API_BASE/projects/$project_id/memory/topics/$topic_id/truths" \
    -H "content-type: application/json" \
    -d "{\"claimIds\":[\"$claim_one_id\",\"$claim_two_id\"]}"
)"
truth_two_version="$(printf '%s' "$truth_two" | jq -r '.currentTruth.version')"
truth_claim_count="$(printf '%s' "$truth_two" | jq '.currentTruth.claimIds | length')"
claim_count="$(printf '%s' "$truth_two" | jq '.claims | length')"

if [[ "$resolved_agent_id" != "$agent_id" ||
      "$resolved_role_id" != "$role_id" ||
      "$workflow_agent_id" != "$agent_id" ||
      "$workflow_role_id" != "$role_id" ||
      "$truth_one_version" -ne 1 ||
      "$truth_two_version" -ne 2 ||
      "$truth_claim_count" -ne 2 ||
      "$claim_count" -ne 2 ]]; then
  printf 'dependency/memory verification failed\n' >&2
  exit 1
fi

printf 'dependency_memory_smoke=ok\n'
printf 'project_id=%s\n' "$project_id"
printf 'role_id=%s\n' "$role_id"
printf 'blocker_task_id=%s\n' "$blocker_id"
printf 'dependent_task_id=%s\n' "$dependent_id"
printf 'workflow_agent_id=%s\n' "$workflow_agent_id"
printf 'memory_topic_id=%s\n' "$topic_id"
printf 'truth_versions=%s->%s\n' "$truth_one_version" "$truth_two_version"
