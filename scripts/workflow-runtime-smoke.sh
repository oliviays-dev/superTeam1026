#!/usr/bin/env bash
set -euo pipefail

API_BASE="${API_BASE:-http://127.0.0.1:4430/api/v1}"
STAMP="$(date +%Y%m%d-%H%M%S)"
RESPONSE=""
STATUS=""

request() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  local actor="${4:-local-admin}"
  local idempotency_key="${5:-}"
  local output
  local args=(
    -sS
    -X "$method"
    "$API_BASE$path"
    -H "x-pluginmax-actor: $actor"
    -w $'\n%{http_code}'
  )
  if [[ -n "$body" ]]; then
    args+=(-H "content-type: application/json" -d "$body")
  fi
  if [[ -n "$idempotency_key" ]]; then
    args+=(-H "Idempotency-Key: $idempotency_key")
  fi
  output="$(curl "${args[@]}")"
  STATUS="${output##*$'\n'}"
  RESPONSE="${output%$'\n'*}"
}

assert_status() {
  local expected="$1"
  local label="$2"
  if [[ "$STATUS" != "$expected" ]]; then
    printf '%s expected HTTP %s, received %s\n' "$label" "$expected" "$STATUS" >&2
    printf '%s\n' "$RESPONSE" >&2
    exit 1
  fi
}

assert_value() {
  local actual="$1"
  local expected="$2"
  local label="$3"
  if [[ "$actual" != "$expected" ]]; then
    printf '%s expected %s, received %s\n' "$label" "$expected" "$actual" >&2
    exit 1
  fi
}

json_field() {
  printf '%s' "$RESPONSE" | jq -r "$1"
}

import_workflow() {
  local project_id="$1"
  local markdown="$2"
  local label="$3"
  request POST "/workflows/import" \
    "$(jq -n --arg projectId "$project_id" --arg markdown "$markdown" \
      '{projectId: $projectId, markdown: $markdown}')"
  assert_status 201 "$label"
  json_field '.id'
}

start_workflow() {
  local workflow_id="$1"
  local title="$2"
  local context="${3:-}"
  local key="${4:-}"
  if [[ -z "$context" ]]; then
    context="{}"
  fi
  request POST "/workflows/$workflow_id/start" \
    "$(jq -n --arg title "$title" --argjson context "$context" \
      '{title: $title, context: $context}')" \
    local-admin "$key"
  assert_status 201 "start workflow"
  json_field '.id'
}

complete_node() {
  local instance_id="$1"
  local node_id="$2"
  local actor="${3:-local-admin}"
  local key="${4:-}"
  request POST "/workflow-instances/$instance_id/nodes/complete" \
    "$(jq -n --arg nodeId "$node_id" --arg output "smoke complete" \
      '{nodeId: $nodeId, output: $output}')" \
    "$actor" "$key"
}

request GET "/health"
assert_status 200 "health"

request POST "/projects" \
  "$(jq -n --arg name "Workflow runtime smoke $STAMP" \
    '{name: $name, description: "batch 5 runtime smoke"}')"
assert_status 201 "create project"
project_id="$(json_field '.id')"

request GET "/projects/$project_id/roles"
assert_status 200 "list project roles"
owner_role_id="$(
  printf '%s' "$RESPONSE" |
    jq -r '.items[] | select(.name == "项目负责人") | .id'
)"

request POST "/agents" \
  "$(jq -n --arg name "Workflow fake $STAMP" \
    '{name: $name, runtimeKind: "fake", description: "workflow runtime smoke"}')"
assert_status 201 "create fake agent"
agent_id="$(json_field '.id')"

request POST "/projects/$project_id/roles" \
  '{"name":"Workflow executor","description":"workflow runtime smoke"}'
assert_status 201 "create executor role"
executor_role_id="$(json_field '.id')"

request POST "/projects/$project_id/members" \
  "$(jq -n --arg agentId "$agent_id" --arg roleId "$executor_role_id" \
    '{kind: "agent", agentId: $agentId, responsibility: "smoke", roleIds: [$roleId]}')"
assert_status 201 "create agent member"
agent_member_actor="$(json_field '.actorId')"

branch_markdown="# 工作流：条件审批 $STAMP

## 元信息

- key: branch-approval-$STAMP
- version: 1

## 节点

### Review

- id: review
- type: approval
- executor: user:local-admin
- approver: role:$owner_role_id
- policy: all

### Choose

- id: choose
- type: decision
- executor: system:rules

### Complex

- id: complex
- type: service
- executor: user:local-admin

### Standard

- id: standard
- type: service
- executor: user:local-admin

### Done

- id: done
- type: service
- executor: user:local-admin

## 连接

- review -> choose [result: approved]
- review -> done [result: rejected]
- choose -> complex [condition: complexity >= 8]
- choose -> standard [default: true]
- complex -> done
- standard -> done"

branch_workflow_id="$(
  import_workflow "$project_id" "$branch_markdown" "import branch workflow"
)"
request POST "/workflows/$branch_workflow_id/start" \
  "$(jq -n --arg title "Forbidden start $STAMP" \
    '{title: $title, context: {complexity: 9}}')" \
  outsider "forbidden-start-$STAMP"
assert_status 403 "start permission"
branch_instance_id="$(
  start_workflow "$branch_workflow_id" "Branch smoke $STAMP" \
    '{"complexity":9}' "branch-start-$STAMP"
)"
request POST "/workflows/$branch_workflow_id/start" \
  "$(jq -n --arg title "Branch smoke $STAMP" \
    '{title: $title, context: {complexity: 9}}')" \
  local-admin "branch-start-$STAMP"
assert_status 201 "duplicate workflow start"
assert_value "$(json_field '.id')" "$branch_instance_id" \
  "idempotent workflow start"

request GET "/workflow-instances/$branch_instance_id/detail"
assert_status 200 "get approval detail"
assert_value "$(printf '%s' "$RESPONSE" | jq -r '.instance.status')" "waiting" \
  "approval instance status"
assert_value \
  "$(printf '%s' "$RESPONSE" | jq -r '.instance.runtime.nodes[] | select(.nodeId == "review") | .status')" \
  "waiting_approval" "approval node status"
assert_value "$(printf '%s' "$RESPONSE" | jq '.approvals | length')" "1" \
  "approval row count"

request POST "/workflow-instances/$branch_instance_id/approvals" \
  '{"nodeId":"review","decision":"approve","note":"not allowed"}' \
  "$agent_member_actor"
assert_status 403 "approval permission"

request POST "/workflow-instances/$branch_instance_id/pause" \
  '{"reason":"not allowed"}' "$agent_member_actor" "pause-forbidden-$STAMP"
assert_status 403 "pause permission"

request POST "/workflow-instances/$branch_instance_id/pause" \
  '{"reason":"smoke pause"}' local-admin "pause-$STAMP"
assert_status 200 "pause workflow"
assert_value "$(json_field '.status')" "paused" "paused status"

request POST "/workflow-instances/$branch_instance_id/resume" \
  '{"reason":"smoke resume"}' local-admin "resume-$STAMP"
assert_status 200 "resume workflow"
assert_value "$(json_field '.status')" "waiting" "resumed status"

request POST "/workflow-instances/$branch_instance_id/approvals" \
  '{"nodeId":"review","decision":"approve","note":"approved"}' \
  local-admin "approval-$STAMP"
assert_status 200 "approve workflow"
assert_value \
  "$(json_field '.runtime.edges[] | select(.edgeId | contains("choose-complex")) | .status')" \
  "selected" "conditional branch selection"
assert_value \
  "$(json_field '.runtime.nodes[] | select(.nodeId == "standard") | .status')" \
  "skipped" "default branch skipped"

complete_node "$branch_instance_id" complex "$agent_member_actor" \
  "complex-forbidden-$STAMP"
assert_status 403 "node completion permission"
complete_node "$branch_instance_id" complex local-admin "complex-$STAMP"
assert_status 200 "complete complex branch"
complete_node "$branch_instance_id" done local-admin "done-$STAMP"
assert_status 200 "complete branch join"
assert_value "$(json_field '.status')" "completed" "branch workflow completed"

request GET "/workflow-instances/$branch_instance_id/detail"
assert_status 200 "branch audit"
audit_kinds="$(printf '%s' "$RESPONSE" | jq -r '[.audit[].kind] | join(",")')"
if [[ "$audit_kinds" != *"approval.decided"* ||
      "$audit_kinds" != *"branch.selected"* ||
      "$audit_kinds" != *"node.completed"* ]]; then
  printf 'workflow audit missing required event kinds: %s\n' "$audit_kinds" >&2
  exit 1
fi

reject_markdown="# 工作流：拒绝流程 $STAMP

## 元信息

- key: reject-$STAMP
- version: 1

## 节点

### Reject

- id: reject
- type: approval
- executor: user:local-admin
- approver: user:local-admin

## 连接
"
reject_workflow_id="$(
  import_workflow "$project_id" "$reject_markdown" "import reject workflow"
)"
reject_instance_id="$(
  start_workflow "$reject_workflow_id" "Reject smoke $STAMP" '{}' \
    "reject-start-$STAMP"
)"
request POST "/workflow-instances/$reject_instance_id/approvals" \
  '{"nodeId":"reject","decision":"reject","note":"rejected"}' \
  local-admin "reject-$STAMP"
assert_status 200 "reject workflow"
assert_value "$(json_field '.status')" "blocked" "rejected workflow status"

loop_markdown="# 工作流：受控循环 $STAMP

## 元信息

- key: loop-$STAMP
- version: 1

## 节点

### Work

- id: work
- type: service
- executor: user:local-admin
- loop-limit: 3
- start: true

### Check

- id: check
- type: decision
- executor: system:rules

### Exit

- id: exit
- type: service
- executor: user:local-admin

## 连接

- work -> check
- check -> work [condition: visits.work < 3] [break: visits.work >= 3]
- check -> exit [default: true]"

loop_workflow_id="$(import_workflow "$project_id" "$loop_markdown" "import loop workflow")"
loop_instance_id="$(
  start_workflow "$loop_workflow_id" "Loop smoke $STAMP" '{}' "loop-start-$STAMP"
)"

for iteration in 1 2 3; do
  complete_node "$loop_instance_id" work local-admin "loop-work-$STAMP-$iteration"
  assert_status 200 "complete loop work $iteration"
done
request GET "/workflow-instances/$loop_instance_id"
assert_status 200 "get loop instance"
assert_value \
  "$(printf '%s' "$RESPONSE" | jq -r '.runtime.nodes[] | select(.nodeId == "work") | .visits')" \
  "3" "loop visit count"
assert_value \
  "$(printf '%s' "$RESPONSE" | jq -r '.runtime.nodes[] | select(.nodeId == "exit") | .status')" \
  "ready" "loop exit ready"
complete_node "$loop_instance_id" exit local-admin "loop-exit-$STAMP"
assert_status 200 "complete loop exit"
assert_value "$(json_field '.status')" "completed" "loop workflow completed"

invalid_loop_markdown="# 工作流：非法循环 $STAMP

## 元信息

- key: invalid-loop-$STAMP
- version: 1

## 节点

### A

- id: a
- type: task
- executor: user:local-admin

### B

- id: b
- type: task
- executor: user:local-admin

## 连接

- a -> b
- b -> a [break: attempts >= 2]"
request POST "/workflows/import" \
  "$(jq -n --arg projectId "$project_id" --arg markdown "$invalid_loop_markdown" \
    '{projectId: $projectId, markdown: $markdown}')"
assert_status 400 "reject loop without limit"
assert_value \
  "$(printf '%s' "$RESPONSE" | jq -r '.details.errors[] | select(.code == "loop_limit_required") | .code')" \
  "loop_limit_required" "loop limit validation"

child_markdown="# 工作流：子流程 $STAMP

## 元信息

- key: child-$STAMP
- version: 1

## 节点

### Child start

- id: child-start
- type: service
- executor: user:local-admin

### Child end

- id: child-end
- type: service
- executor: user:local-admin

## 连接

- child-start -> child-end"
child_workflow_id="$(
  import_workflow "$project_id" "$child_markdown" "import child workflow"
)"
parent_markdown="# 工作流：父流程 $STAMP

## 元信息

- key: parent-$STAMP
- version: 1

## 节点

### Sub

- id: sub
- type: subworkflow
- executor: system:workflow
- subworkflow: child-$STAMP
- subworkflow-version: 1

### Parent done

- id: parent-done
- type: service
- executor: user:local-admin

## 连接

- sub -> parent-done"
parent_workflow_id="$(
  import_workflow "$project_id" "$parent_markdown" "import parent workflow"
)"
parent_instance_id="$(
  start_workflow "$parent_workflow_id" "Parent smoke $STAMP" '{}' \
    "parent-start-$STAMP"
)"
request GET "/workflow-instances/$parent_instance_id/detail"
assert_status 200 "parent detail"
child_instance_id="$(
  printf '%s' "$RESPONSE" |
    jq -r '.instance.runtime.nodes[] | select(.nodeId == "sub") | .childInstanceId'
)"
if [[ -z "$child_instance_id" || "$child_instance_id" == "null" ]]; then
  printf 'parent did not create a child instance\n' >&2
  exit 1
fi
complete_node "$child_instance_id" child-start local-admin "child-start-$STAMP"
assert_status 200 "complete child start"
complete_node "$child_instance_id" child-end local-admin "child-end-$STAMP"
assert_status 200 "complete child end"
assert_value "$(json_field '.status')" "completed" "child completed"

request POST "/workflow-instances/$parent_instance_id/reconcile"
assert_status 200 "reconcile parent"
assert_value \
  "$(json_field '.runtime.nodes[] | select(.nodeId == "sub") | .status')" \
  "completed" "child status propagated"
complete_node "$parent_instance_id" parent-done local-admin "parent-done-$STAMP"
assert_status 200 "complete parent"
assert_value "$(json_field '.status')" "completed" "parent completed"

fail_child_markdown="# 工作流：失败子流程 $STAMP

## 元信息

- key: fail-child-$STAMP
- version: 1

## 节点

### Fail agent

- id: fail-agent
- type: task
- executor: role:$executor_role_id
- execution: task-worker
- trigger: auto-on-ready
- timeout: 5s
- max-attempts: 1
- runtime-fault: fail

## 连接
"
fail_child_workflow_id="$(
  import_workflow "$project_id" "$fail_child_markdown" "import failing child"
)"
fail_parent_markdown="# 工作流：失败父流程 $STAMP

## 元信息

- key: fail-parent-$STAMP
- version: 1

## 节点

### Fail sub

- id: fail-sub
- type: subworkflow
- executor: system:workflow
- subworkflow: fail-child-$STAMP
- subworkflow-version: 1

## 连接
"
fail_parent_workflow_id="$(
  import_workflow "$project_id" "$fail_parent_markdown" "import failing parent"
)"
fail_parent_instance_id="$(
  start_workflow "$fail_parent_workflow_id" "Failure propagation $STAMP" '{}' \
    "fail-parent-start-$STAMP"
)"
request GET "/workflow-instances/$fail_parent_instance_id/detail"
assert_status 200 "failing parent detail"
fail_child_instance_id="$(
  printf '%s' "$RESPONSE" |
    jq -r '.instance.runtime.nodes[] | select(.nodeId == "fail-sub") | .childInstanceId'
)"
sleep 1
request POST "/workflow-instances/$fail_child_instance_id/reconcile"
assert_status 200 "reconcile failing child"
assert_value "$(json_field '.status')" "failed" "failing child status"
request POST "/workflow-instances/$fail_parent_instance_id/reconcile"
assert_status 200 "reconcile failing parent"
assert_value \
  "$(json_field '.runtime.nodes[] | select(.nodeId == "fail-sub") | .status')" \
  "failed" "child failure propagated"
assert_value "$(json_field '.status')" "failed" "failing parent status"

self_cycle_markdown="# 工作流：循环子流程 $STAMP

## 元信息

- key: self-cycle-$STAMP
- version: 1

## 节点

### Self

- id: self
- type: subworkflow
- executor: system:workflow
- subworkflow: self-cycle-$STAMP

## 连接
"
request POST "/workflows/import" \
  "$(jq -n --arg projectId "$project_id" --arg markdown "$self_cycle_markdown" \
    '{projectId: $projectId, markdown: $markdown}')"
assert_status 409 "reject subworkflow cycle"

retry_markdown="# 工作流：超时恢复 $STAMP

## 元信息

- key: timeout-$STAMP
- version: 1

## 节点

### Agent

- id: agent
- type: task
- executor: role:$executor_role_id
- execution: task-worker
- trigger: auto-on-ready
- timeout: 1s
- max-attempts: 2
- runtime-fault: timeout

### Done

- id: retry-done
- type: service
- executor: user:local-admin

## 连接

- agent -> retry-done"
retry_workflow_id="$(
  import_workflow "$project_id" "$retry_markdown" "import timeout workflow"
)"
retry_instance_id="$(
  start_workflow "$retry_workflow_id" "Timeout smoke $STAMP" '{}' \
    "timeout-start-$STAMP"
)"
sleep 2
request POST "/workflow-instances/$retry_instance_id/reconcile"
assert_status 200 "reconcile timeout"
assert_value \
  "$(json_field '.runtime.nodes[] | select(.nodeId == "agent") | .status')" \
  "failed" "timed out node status"

request POST "/workflow-instances/$retry_instance_id/retry" \
  '{"nodeId":"agent","reason":"retry smoke"}' local-admin "retry-$STAMP"
assert_status 200 "retry timed out node"
assert_value \
  "$(json_field '.runtime.nodes[] | select(.nodeId == "agent") | .attempt')" \
  "2" "retry attempt"

request POST "/workflow-instances/$retry_instance_id/retry" \
  '{"nodeId":"agent","reason":"duplicate"}' local-admin "retry-$STAMP"
assert_status 409 "duplicate retry protection"

sleep 2
request POST "/workflow-instances/$retry_instance_id/reconcile"
assert_status 200 "reconcile second timeout"
request POST "/workflow-instances/$retry_instance_id/retry" \
  '{"nodeId":"agent","reason":"too many"}' local-admin "retry-third-$STAMP"
assert_status 409 "retry cap"

request GET "/projects/$project_id/roles"
assert_status 200 "role audit"

printf 'workflow_runtime_smoke=ok\n'
printf 'project_id=%s\n' "$project_id"
printf 'agent_id=%s\n' "$agent_id"
printf 'approval_instance_id=%s\n' "$branch_instance_id"
printf 'loop_instance_id=%s\n' "$loop_instance_id"
printf 'parent_instance_id=%s\n' "$parent_instance_id"
printf 'child_instance_id=%s\n' "$child_instance_id"
printf 'fail_parent_instance_id=%s\n' "$fail_parent_instance_id"
printf 'timeout_instance_id=%s\n' "$retry_instance_id"
printf 'audit_kinds=%s\n' "$audit_kinds"
