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

curl -fsS "$API_BASE/health" >/dev/null

agent_id="$(
  curl -fsS "$API_BASE/agents" |
    jq -r '[.items[] | select(.runtimeKind == "fake")][0].id'
)"
project_one="$(
  curl -fsS -X POST "$API_BASE/projects" \
    -H "content-type: application/json" \
    -d "{\"name\":\"Membership smoke $STAMP\"}"
)"
project_one_id="$(printf '%s' "$project_one" | jq -r '.id')"
role_one="$(
  curl -fsS -X POST "$API_BASE/projects/$project_one_id/roles" \
    -H "content-type: application/json" \
    -d "{\"name\":\"Reviewer $STAMP\",\"description\":\"Membership test role\"}"
)"
role_one_id="$(printf '%s' "$role_one" | jq -r '.id')"
member="$(
  curl -fsS -X POST "$API_BASE/projects/$project_one_id/members" \
    -H "content-type: application/json" \
    -d "{\"kind\":\"agent\",\"agentId\":\"$agent_id\",\"responsibility\":\"Review changes\",\"roleIds\":[\"$role_one_id\"]}"
)"
member_id="$(printf '%s' "$member" | jq -r '.id')"
members="$(curl -fsS "$API_BASE/projects/$project_one_id/members")"
owner_id="$(
  printf '%s' "$members" |
    jq -r '.items[] | select(.owner) | .id'
)"
owner_count="$(printf '%s' "$members" | jq '[.items[] | select(.owner)] | length')"
if [[ "$owner_count" -ne 1 || -z "$owner_id" ]]; then
  printf 'owner bootstrap failed\n' >&2
  exit 1
fi

owner_removal_code="$(
  request_code DELETE "/projects/$project_one_id/members/$owner_id"
)"
expect_code 409 "$owner_removal_code" "owner removal"

owner_deactivation_code="$(
  request_code PATCH "/projects/$project_one_id/members/$owner_id" \
    '{"status":"inactive"}'
)"
expect_code 409 "$owner_deactivation_code" "owner deactivation"

role_in_use_code="$(
  request_code DELETE "/projects/$project_one_id/roles/$role_one_id"
)"
expect_code 409 "$role_in_use_code" "role in use"

duplicate_member_code="$(
  request_code POST "/projects/$project_one_id/members" \
    "{\"kind\":\"agent\",\"agentId\":\"$agent_id\"}"
)"
expect_code 409 "$duplicate_member_code" "duplicate member"

project_two="$(
  curl -fsS -X POST "$API_BASE/projects" \
    -H "content-type: application/json" \
    -d "{\"name\":\"Membership scope $STAMP\"}"
)"
project_two_id="$(printf '%s' "$project_two" | jq -r '.id')"
role_two="$(
  curl -fsS -X POST "$API_BASE/projects/$project_two_id/roles" \
    -H "content-type: application/json" \
    -d "{\"name\":\"Foreign role $STAMP\"}"
)"
role_two_id="$(printf '%s' "$role_two" | jq -r '.id')"
agent_two="$(
  curl -fsS -X POST "$API_BASE/agents" \
    -H "content-type: application/json" \
    -d "{\"name\":\"Scope Agent $STAMP\",\"runtimeKind\":\"fake\"}"
)"
agent_two_id="$(printf '%s' "$agent_two" | jq -r '.id')"
foreign_role_code="$(
  request_code POST "/projects/$project_one_id/members" \
    "{\"kind\":\"agent\",\"agentId\":\"$agent_two_id\",\"roleIds\":[\"$role_two_id\"]}"
)"
expect_code 400 "$foreign_role_code" "foreign role"

member_removal_code="$(
  request_code DELETE "/projects/$project_one_id/members/$member_id"
)"
expect_code 204 "$member_removal_code" "member removal"

role_removal_code="$(
  request_code DELETE "/projects/$project_one_id/roles/$role_one_id"
)"
expect_code 204 "$role_removal_code" "unassigned role removal"

printf 'membership_smoke=ok\n'
printf 'project_id=%s\n' "$project_one_id"
printf 'agent_member_id=%s\n' "$member_id"
printf 'owner_id=%s\n' "$owner_id"
