#!/usr/bin/env bash
set -euo pipefail

API_BASE="${API_BASE:-http://127.0.0.1:4440/api/v1}"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-pluginmax-batch6}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.batch6.yml}"
STAMP="$(date +%Y%m%d-%H%M%S)"
WORK_DIR="${WORK_DIR:-.tmp/batch6-governance-smoke}"
RESPONSE=""
STATUS=""

mkdir -p "$WORK_DIR"

request() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  local actor="${4:-local-admin}"
  local key="${5:-}"
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
  if [[ -n "$key" ]]; then
    args+=(-H "idempotency-key: $key")
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

canonical_json() {
  printf '%s' "$1" | jq -S -c .
}

psql_query() {
  docker-compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" \
    exec -T postgres psql -U pluginmax -d pluginmax -qAt -v ON_ERROR_STOP=1 -c "$1"
}

wait_instance() {
  local instance_id="$1"
  local filter="$2"
  local label="$3"
  local attempts="${4:-80}"
  local current=""
  for _ in $(seq 1 "$attempts"); do
    request GET "/workflow-instances/$instance_id"
    assert_status 200 "$label poll"
    current="$(printf '%s' "$RESPONSE" | jq -r "$filter")"
    if [[ "$current" == "true" ]]; then
      return 0
    fi
    sleep 0.25
  done
  printf '%s did not satisfy %s\n' "$label" "$filter" >&2
  printf '%s\n' "$RESPONSE" >&2
  exit 1
}

wait_run() {
  local run_id="$1"
  local expected="$2"
  local label="$3"
  local current=""
  for _ in $(seq 1 80); do
    request GET "/runs/$run_id"
    assert_status 200 "$label poll"
    current="$(printf '%s' "$RESPONSE" | jq -r '.run.status')"
    if [[ "$current" == "$expected" ]]; then
      return 0
    fi
    sleep 0.25
  done
  printf '%s did not reach %s, received %s\n' "$label" "$expected" "$current" >&2
  exit 1
}

request GET /health
assert_status 200 "health"

request POST /projects \
  "$(jq -n --arg name "Workflow governance smoke $STAMP" \
    '{name: $name, description: "batch 6 governance smoke"}')"
assert_status 201 "create project"
project_id="$(json_field '.id')"

request POST "/projects/$project_id/roles" \
  '{"name":"Reviewer","description":"batch 6 reviewer"}'
assert_status 201 "create reviewer role"
reviewer_role_id="$(json_field '.id')"

request POST "/projects/$project_id/members" \
  "$(jq -n --arg roleId "$reviewer_role_id" \
    '{kind: "human", actorId: "reviewer-1", name: "Reviewer One", responsibility: "first reviewer", roleIds: [$roleId]}')"
assert_status 201 "create reviewer one"
request POST "/projects/$project_id/members" \
  "$(jq -n --arg roleId "$reviewer_role_id" \
    '{kind: "human", actorId: "reviewer-2", name: "Reviewer Two", responsibility: "second reviewer", roleIds: [$roleId]}')"
assert_status 201 "create reviewer two"
request POST "/projects/$project_id/members" \
  "$(jq -n --arg roleId "$reviewer_role_id" \
    '{kind: "human", actorId: "reviewer-3", name: "Reviewer Three", responsibility: "security reviewer", roleIds: [$roleId]}')"
assert_status 201 "create reviewer three"

request POST /agents \
  "$(jq -n --arg name "Governance fake $STAMP" \
    '{name: $name, runtimeKind: "fake", description: "batch 6 recovery smoke"}')"
assert_status 201 "create fake agent"
agent_id="$(json_field '.id')"
request POST "/projects/$project_id/roles" \
  '{"name":"Workflow executor","description":"batch 6 executor"}'
assert_status 201 "create executor role"
executor_role_id="$(json_field '.id')"
request POST "/projects/$project_id/members" \
  "$(jq -n --arg agentId "$agent_id" --arg roleId "$executor_role_id" \
    '{kind: "agent", agentId: $agentId, responsibility: "executor", roleIds: [$roleId]}')"
assert_status 201 "create executor member"

approval_markdown="# 工作流：审批治理 $STAMP

## 元信息

- key: approval-governance-$STAMP
- version: 1

## 节点

### Review

- id: review
- type: approval
- executor: user:reviewer-1
- approver: user:reviewer-1
- policy: all

## 连接
"
request POST /workflows/import \
  "$(jq -n --arg projectId "$project_id" --arg markdown "$approval_markdown" \
    '{projectId: $projectId, markdown: $markdown}')"
assert_status 201 "import approval workflow"
approval_workflow_id="$(json_field '.id')"

start_body="$(
  jq -n --arg title "Approval governance $STAMP" \
    '{title: $title, context: {source: "smoke"}}'
)"
request POST "/workflows/$approval_workflow_id/start" "$start_body" \
  local-admin "governance-start-$STAMP"
assert_status 201 "start approval workflow"
approval_instance_id="$(json_field '.id')"
first_start_response="$(canonical_json "$RESPONSE")"
request POST "/workflows/$approval_workflow_id/start" "$start_body" \
  local-admin "governance-start-$STAMP"
assert_status 201 "replay workflow start"
assert_value "$(canonical_json "$RESPONSE")" "$first_start_response" \
  "workflow start replay body"
request POST "/workflows/$approval_workflow_id/start" \
  "$(jq -n --arg title "Different $STAMP" \
    '{title: $title, context: {source: "smoke"}}')" \
  local-admin "governance-start-$STAMP"
assert_status 409 "workflow start hash conflict"
assert_value "$(json_field '.code')" "idempotency_key_conflict" \
  "workflow start conflict code"

request POST "/workflow-instances/$approval_instance_id/approvals" \
  '{"nodeId":"review","decision":"approve","note":"outsider"}' \
  reviewer-2 "outside-approval-$STAMP"
assert_status 403 "outsider approval permission"

transfer_body='{"nodeId":"review","targetActorId":"reviewer-2","note":"handoff"}'
request POST "/workflow-instances/$approval_instance_id/approvals/transfer" \
  "$transfer_body" reviewer-1 "transfer-$STAMP"
assert_status 200 "transfer approval"
transfer_response="$(canonical_json "$RESPONSE")"
assert_value \
  "$(printf '%s' "$RESPONSE" | jq -r '.approvals? // empty')" "" \
  "transfer response shape"
request POST "/workflow-instances/$approval_instance_id/approvals/transfer" \
  "$transfer_body" reviewer-1 "transfer-$STAMP"
assert_status 200 "replay approval transfer"
assert_value "$(canonical_json "$RESPONSE")" "$transfer_response" \
  "transfer replay body"

request POST "/workflow-instances/$approval_instance_id/approvals/cosign" \
  '{"nodeId":"review","approvers":[{"kind":"user","id":"reviewer-3"}],"note":"security review"}' \
  reviewer-2 "cosign-$STAMP"
assert_status 200 "cosign approval"
request GET "/workflow-instances/$approval_instance_id/detail"
assert_status 200 "approval detail"
assert_value "$(printf '%s' "$RESPONSE" | jq '.approvals | length')" "3" \
  "approval rows after transfer and cosign"
assert_value \
  "$(printf '%s' "$RESPONSE" | jq '[.approvals[] | select(.status == "transferred")] | length')" \
  "1" "transferred approval count"
assert_value \
  "$(printf '%s' "$RESPONSE" | jq '[.approvals[] | select(.kind == "cosign")] | length')" \
  "1" "cosign approval count"

approve_body='{"nodeId":"review","decision":"approve","note":"reviewer one approved"}'
request POST "/workflow-instances/$approval_instance_id/approvals" \
  "$approve_body" reviewer-2 "reviewer-two-approval-$STAMP"
assert_status 200 "reviewer two approval"
first_approval_response="$(canonical_json "$RESPONSE")"
request POST "/workflow-instances/$approval_instance_id/approvals" \
  "$approve_body" reviewer-2 "reviewer-two-approval-$STAMP"
assert_status 200 "replay reviewer two approval"
assert_value "$(canonical_json "$RESPONSE")" "$first_approval_response" \
  "approval replay body"
request POST "/workflow-instances/$approval_instance_id/approvals" \
  '{"nodeId":"review","decision":"reject","note":"different body"}' \
  reviewer-2 "reviewer-two-approval-$STAMP"
assert_status 409 "approval request hash conflict"
assert_value "$(json_field '.code')" "idempotency_key_conflict" \
  "approval hash conflict code"
request POST "/workflow-instances/$approval_instance_id/approvals" \
  '{"nodeId":"review","decision":"approve","note":"reviewer three approved"}' \
  reviewer-3 "reviewer-three-approval-$STAMP"
assert_status 200 "reviewer three approval"
assert_value "$(json_field '.status')" "completed" "approval workflow completed"

request POST "/workflow-instances/$approval_instance_id/approvals" \
  '{"nodeId":"review","decision":"reject","note":"terminal"}' \
  reviewer-3 "terminal-approval-$STAMP"
assert_status 409 "terminal approval rejection"
assert_value "$(json_field '.code')" "workflow_approval_not_pending" \
  "terminal approval code"

request GET \
  "/workflow-audit?projectId=$project_id&instanceId=$approval_instance_id&kind=approval.transferred&page=1&pageSize=1"
assert_status 200 "filter audit by action"
assert_value "$(json_field '.total')" "1" "transferred audit total"
assert_value "$(json_field '.items[0].kind')" "approval.transferred" \
  "transferred audit kind"
request GET \
  "/workflow-audit?projectId=$project_id&instanceId=$approval_instance_id&query=security&page=1&pageSize=10"
assert_status 200 "search audit"
if [[ "$(json_field '.total')" -lt 1 ]]; then
  printf 'audit search did not find co-sign event\n' >&2
  exit 1
fi

concurrent_markdown="# 工作流：并发审批 $STAMP

## 元信息

- key: concurrent-approval-$STAMP
- version: 1

## 节点

### Review

- id: concurrent-review
- type: approval
- executor: user:reviewer-1
- approver: user:reviewer-1
- approver: user:reviewer-2
- policy: all

## 连接
"
request POST /workflows/import \
  "$(jq -n --arg projectId "$project_id" --arg markdown "$concurrent_markdown" \
    '{projectId: $projectId, markdown: $markdown}')"
assert_status 201 "import concurrent approval workflow"
concurrent_workflow_id="$(json_field '.id')"
request POST "/workflows/$concurrent_workflow_id/start" \
  "$(jq -n --arg title "Concurrent approval $STAMP" '{title: $title}')" \
  local-admin "concurrent-start-$STAMP"
assert_status 201 "start concurrent approval workflow"
concurrent_instance_id="$(json_field '.id')"

curl -sS -X POST "$API_BASE/workflow-instances/$concurrent_instance_id/approvals" \
  -H "x-pluginmax-actor: reviewer-1" \
  -H "idempotency-key: concurrent-r1-$STAMP" \
  -H "content-type: application/json" \
  -d '{"nodeId":"concurrent-review","decision":"approve","note":"r1"}' \
  -w $'\n%{http_code}' > "$WORK_DIR/concurrent-r1.txt" &
pid_one=$!
curl -sS -X POST "$API_BASE/workflow-instances/$concurrent_instance_id/approvals" \
  -H "x-pluginmax-actor: reviewer-2" \
  -H "idempotency-key: concurrent-r2-$STAMP" \
  -H "content-type: application/json" \
  -d '{"nodeId":"concurrent-review","decision":"approve","note":"r2"}' \
  -w $'\n%{http_code}' > "$WORK_DIR/concurrent-r2.txt" &
pid_two=$!
wait "$pid_one"
wait "$pid_two"
concurrent_status_one="$(tail -n 1 "$WORK_DIR/concurrent-r1.txt")"
concurrent_status_two="$(tail -n 1 "$WORK_DIR/concurrent-r2.txt")"
assert_value "$concurrent_status_one" "200" "concurrent approval one"
assert_value "$concurrent_status_two" "200" "concurrent approval two"
request GET "/workflow-instances/$concurrent_instance_id"
assert_status 200 "concurrent approval result"
assert_value "$(json_field '.status')" "completed" "concurrent approval completed"

completion_markdown="# 工作流：幂等完成 $STAMP

## 元信息

- key: idempotent-complete-$STAMP
- version: 1

## 节点

### Complete

- id: complete
- type: service
- executor: user:local-admin

## 连接
"
request POST /workflows/import \
  "$(jq -n --arg projectId "$project_id" --arg markdown "$completion_markdown" \
    '{projectId: $projectId, markdown: $markdown}')"
assert_status 201 "import completion workflow"
completion_workflow_id="$(json_field '.id')"
request POST "/workflows/$completion_workflow_id/start" \
  "$(jq -n --arg title "Idempotent completion $STAMP" '{title: $title}')" \
  local-admin "completion-start-$STAMP"
assert_status 201 "start completion workflow"
completion_instance_id="$(json_field '.id')"
completion_body='{"nodeId":"complete","output":"first result"}'
request POST "/workflow-instances/$completion_instance_id/nodes/complete" \
  "$completion_body" local-admin "completion-key-$STAMP"
assert_status 200 "complete workflow node"
completion_response="$(canonical_json "$RESPONSE")"
assert_value "$(json_field '.status')" "completed" "completion status"
request POST "/workflow-instances/$completion_instance_id/nodes/complete" \
  "$completion_body" local-admin "completion-key-$STAMP"
assert_status 200 "replay workflow completion"
assert_value "$(canonical_json "$RESPONSE")" "$completion_response" \
  "completion replay body"
request POST "/workflow-instances/$completion_instance_id/nodes/complete" \
  '{"nodeId":"complete","output":"different result"}' \
  local-admin "completion-key-$STAMP"
assert_status 409 "completion hash conflict"
assert_value "$(json_field '.code')" "idempotency_key_conflict" \
  "completion hash conflict code"

retry_markdown="# 工作流：自动恢复 $STAMP

## 元信息

- key: recovery-$STAMP
- version: 1

## 节点

### Agent

- id: recovery-agent
- type: task
- executor: role:$executor_role_id
- execution: task-worker
- trigger: auto-on-ready
- timeout: 1s
- max-attempts: 2
- retry-backoff: 5s
- runtime-fault: timeout

## 连接
"
request POST /workflows/import \
  "$(jq -n --arg projectId "$project_id" --arg markdown "$retry_markdown" \
    '{projectId: $projectId, markdown: $markdown}')"
assert_status 201 "import retry workflow"
retry_workflow_id="$(json_field '.id')"
request POST "/workflows/$retry_workflow_id/start" \
  "$(jq -n --arg title "Recovery $STAMP" '{title: $title}')" \
  local-admin "recovery-start-$STAMP"
assert_status 201 "start recovery workflow"
retry_instance_id="$(json_field '.id')"
wait_instance "$retry_instance_id" \
  '.runtime.nodes[] | select(.nodeId == "recovery-agent") | .failureCount >= 1' \
  "first retry failure"
request POST "/workflow-instances/$retry_instance_id/pause" \
  '{"reason":"freeze retry"}' local-admin "recovery-pause-$STAMP"
assert_status 200 "pause retry workflow"
retry_before_pause="$(
  printf '%s' "$RESPONSE" |
    jq -r '.runtime.nodes[] | select(.nodeId == "recovery-agent") | .nextRetryAt'
)"
sleep 2
request POST "/workflow-instances/$retry_instance_id/resume" \
  '{"reason":"resume retry"}' local-admin "recovery-resume-$STAMP"
assert_status 200 "resume retry workflow"
retry_after_resume="$(
  printf '%s' "$RESPONSE" |
    jq -r '.runtime.nodes[] | select(.nodeId == "recovery-agent") | .nextRetryAt'
)"
if [[ "$retry_after_resume" < "$retry_before_pause" ]]; then
  printf 'retry deadline moved backwards during pause: %s -> %s\n' \
    "$retry_before_pause" "$retry_after_resume" >&2
  exit 1
fi
wait_instance "$retry_instance_id" \
  '.runtime.nodes[] | select(.nodeId == "recovery-agent") | .attempt == 2' \
  "automatic retry attempt" 80
wait_instance "$retry_instance_id" \
  '.runtime.nodes[] | select(.nodeId == "recovery-agent") | .failureCount == 2 and .nextRetryAt == null' \
  "retry limit reached" 80
request GET "/workflow-instances/$retry_instance_id"
assert_status 200 "retry limit result"
assert_value "$(json_field '.status')" "failed" "retry terminal status"

lease_markdown="# 工作流：租约恢复 $STAMP

## 元信息

- key: lease-recovery-$STAMP
- version: 1

## 节点

### Agent

- id: lease-agent
- type: task
- executor: role:$executor_role_id
- execution: task-worker
- trigger: auto-on-ready
- timeout: 30s
- max-attempts: 1
- runtime-delay-ms: 60000

## 连接
"
request POST /workflows/import \
  "$(jq -n --arg projectId "$project_id" --arg markdown "$lease_markdown" \
    '{projectId: $projectId, markdown: $markdown}')"
assert_status 201 "import lease workflow"
lease_workflow_id="$(json_field '.id')"
request POST "/workflows/$lease_workflow_id/start" \
  "$(jq -n --arg title "Lease recovery $STAMP" '{title: $title}')" \
  local-admin "lease-start-$STAMP"
assert_status 201 "start lease workflow"
lease_instance_id="$(json_field '.id')"
wait_instance "$lease_instance_id" \
  '.runtime.nodes[] | select(.nodeId == "lease-agent") | .runId != null' \
  "lease run dispatch" 40
lease_run_id="$(
  printf '%s' "$RESPONSE" |
    jq -r '.runtime.nodes[] | select(.nodeId == "lease-agent") | .runId'
)"
lease_job_status=""
for _ in $(seq 1 50); do
  lease_job_status="$(
    psql_query "SELECT status FROM jobs WHERE run_id = '$lease_run_id';"
  )"
  if [[ "$lease_job_status" == "running" ]]; then
    break
  fi
  sleep 0.1
done
assert_value "$lease_job_status" "running" "lease job claim"
psql_query \
  "UPDATE jobs
   SET
     max_attempts = attempts,
     lease_expires_at = NOW() - INTERVAL '1 second'
   WHERE run_id = '$lease_run_id';" \
  >/dev/null
wait_run "$lease_run_id" interrupted "worker lease recovery"
lease_retry_status="$(
  psql_query "SELECT status FROM jobs WHERE run_id = '$lease_run_id';"
)"
if [[ "$lease_retry_status" != "dead_letter" ]]; then
  printf 'expired job dead-letter status mismatch: %s\n' \
    "$lease_retry_status" >&2
  exit 1
fi
wait_instance "$lease_instance_id" \
  '.runtime.nodes[] | select(.nodeId == "lease-agent") | .failureCount >= 1' \
  "interrupted run reconciliation" 80

request GET \
  "/workflow-audit?projectId=$project_id&instanceId=$lease_instance_id&failuresOnly=true&page=1&pageSize=20"
assert_status 200 "failure audit query"
if [[ "$(json_field '.total')" -lt 1 ]]; then
  printf 'failure audit query returned no events\n' >&2
  exit 1
fi
if [[ "$(json_field '[.items[] | select(.nodeId == "lease-agent")] | length')" -lt 1 ]]; then
  printf 'failure audit query did not include the interrupted node\n' >&2
  exit 1
fi

printf 'workflow_governance_smoke=ok\n'
printf 'project_id=%s\n' "$project_id"
printf 'approval_instance_id=%s\n' "$approval_instance_id"
printf 'concurrent_instance_id=%s\n' "$concurrent_instance_id"
printf 'completion_instance_id=%s\n' "$completion_instance_id"
printf 'retry_instance_id=%s\n' "$retry_instance_id"
printf 'lease_instance_id=%s\n' "$lease_instance_id"
printf 'lease_run_id=%s\n' "$lease_run_id"
printf 'audit_total=%s\n' "$(json_field '.total')"
