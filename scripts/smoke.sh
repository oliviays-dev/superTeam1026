#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# 默认使用隔离的 smoke 数据目录；需要复跑真实环境时用
# PLUGINMAX_SMOKE_HOME 指向自己的 DSH_HOME，避免清空正在使用的数据。
DSH_HOME="${PLUGINMAX_SMOKE_HOME:-$ROOT/.tmp/dsh-home}"
DSH_BIN="$ROOT/vendor/deepseek-harness/apps/cli/lib/bin.js"
LOG="$ROOT/.tmp/pluginmax-web.log"
COOKIE="$ROOT/.tmp/pluginmax-smoke.cookies"
BODY="$ROOT/.tmp/pluginmax-smoke.body.json"
PORT="${PLUGINMAX_SMOKE_PORT:-33117}"
WORKSPACE_ROOT="$ROOT/.tmp/smoke-workspace"
WORKSPACE_ID="00000000-0000-4000-8000-000000000001"
HEALTH_URL="http://127.0.0.1:$PORT/api/collab/canary/health"
IDENTITY_BASE="http://127.0.0.1:$PORT/api/collab"

if [[ ! -f "$DSH_BIN" ]]; then
  echo "upstream DSH CLI is not built; run ./scripts/bootstrap.sh" >&2
  exit 1
fi

mkdir -p "$ROOT/.tmp"
mkdir -p "$WORKSPACE_ROOT"
mkdir -p "$DSH_HOME/storages"
: > "$LOG"
rm -f "$COOKIE"
rm -f "$DSH_HOME/storages/collab_team.json"
rm -f "$DSH_HOME/storages/collab_principal.json"
rm -f "$DSH_HOME/storages/collab_principal_runtime.json"
rm -f "$DSH_HOME/storages/collab_sharing.json"
rm -f "$DSH_HOME/storages/collab_config.json"
rm -f "$DSH_HOME/storages/collab_locks.json"
rm -f "$DSH_HOME/storages/collab_assignment.json"
rm -f "$DSH_HOME/storages/collab_memory.json"
rm -f "$DSH_HOME/storages/collab_context.json"
rm -f "$DSH_HOME/storages/collab_meeting.json"
rm -f "$DSH_HOME/storages/workspace.json"
rm -rf "$DSH_HOME/pluginmax/shared"
rm -rf "$DSH_HOME/pluginmax/personas"
rm -rf "$DSH_HOME/pluginmax/workspace-types"

# The locked DSH workspace registry starts empty and is normally populated by
# the Web workspace picker. Seed one existing local directory so API smoke
# coverage does not depend on interactive UI setup.
DSH_HOME="$DSH_HOME" WORKSPACE_PATH="$WORKSPACE_ROOT" SEEDED_WORKSPACE_ID="$WORKSPACE_ID" node <<'NODE'
const fs = require("node:fs");
const path = fs.realpathSync(process.env.WORKSPACE_PATH);
const now = new Date().toISOString();
fs.writeFileSync(
  `${process.env.DSH_HOME}/storages/workspace.json`,
  `${JSON.stringify(
    {
      unit: { name: "workspace", version: 2 },
      global: {
        initialized: true,
        workspaceIds: [process.env.SEEDED_WORKSPACE_ID],
        archivedSessionIds: [],
      },
      tables: {
        workspaces: {
          [process.env.SEEDED_WORKSPACE_ID]: {
            path,
            title: "Pluginmax smoke",
            sessionIds: [],
            createdAt: now,
            updatedAt: now,
          },
        },
      },
    },
    null,
    2,
  )}\n`,
);
NODE

DSH_HOME="$DSH_HOME" node "$DSH_BIN" --profile pluginmax --no-open --port "$PORT" >"$LOG" 2>&1 &
pid=$!
cleanup() {
  kill "$pid" >/dev/null 2>&1 || true
  wait "$pid" >/dev/null 2>&1 || true
}
trap cleanup EXIT

launch_url=""
for _ in {1..120}; do
  launch_url="$(sed -nE 's/^.*dsh web: (http:\/\/[^[:space:]]+).*$/\1/p' "$LOG" | tail -n 1)"
  if [[ -n "$launch_url" ]]; then
    break
  fi
  if ! kill -0 "$pid" >/dev/null 2>&1; then
    echo "DSH exited before smoke completed" >&2
    cat "$LOG" >&2
    exit 1
  fi
  sleep 1
done

if [[ -z "$launch_url" ]]; then
  echo "timed out waiting for DSH web launch URL" >&2
  cat "$LOG" >&2
  exit 1
fi

# DSH protects /api with an authority-bound HttpOnly browser cookie.
# Exchange the process launch URL for that cookie before probing the plugin.
if ! curl -fsS -c "$COOKIE" -o /dev/null "$launch_url"; then
  echo "could not exchange the DSH launch URL for a browser cookie" >&2
  cat "$LOG" >&2
  exit 1
fi

canary_ready=false
for _ in {1..20}; do
  if body="$(curl -fsS -b "$COOKIE" "$HEALTH_URL" 2>/dev/null)"; then
    echo "$body"
    if [[ "$body" == *'"ok":true'* && "$body" == *'"domain":"pluginmax_canary"'* ]]; then
      canary_ready=true
      break
    fi
    echo "unexpected canary response: $body" >&2
    exit 1
  fi
  if ! kill -0 "$pid" >/dev/null 2>&1; then
    echo "DSH exited while probing canary health" >&2
    cat "$LOG" >&2
    exit 1
  fi
  sleep 1
done

if [[ "$canary_ready" != true ]]; then
  echo "timed out waiting for $HEALTH_URL" >&2
  cat "$LOG" >&2
  exit 1
fi

expect_code() {
  local expected="$1"
  local actual="$2"
  local label="$3"
  if [[ "$actual" != "$expected" ]]; then
    echo "$label expected HTTP $expected, got $actual" >&2
    cat "$BODY" >&2
    exit 1
  fi
}

api() {
  local method="$1"
  local path="$2"
  local token="${3:-}"
  local data="${4:-}"
  local origin="${5:-}"
  local args=(
    -sS
    -o "$BODY"
    -w '%{http_code}'
    -X "$method"
    -b "$COOKIE"
  )
  if [[ -n "$origin" ]]; then args+=(-H "Origin: $origin"); fi
  if [[ -n "$token" ]]; then args+=(-H "Authorization: Bearer $token"); fi
  if [[ -n "$data" ]]; then
    args+=(-H "Content-Type: application/json" -d "$data")
  fi
  curl "${args[@]}" "$IDENTITY_BASE$path"
}

code="$(curl -sS -o "$BODY" -w '%{http_code}' -b "$COOKIE" "$IDENTITY_BASE/auth/status")"
expect_code 200 "$code" "identity status"
grep -q '"initialized":false' "$BODY" || {
  echo "identity should start uninitialized" >&2
  cat "$BODY" >&2
  exit 1
}

code="$(api POST /auth/bootstrap "" '{"userId":"admin","name":"Admin","password":"password-123"}' "https://evil.example")"
expect_code 403 "$code" "cross-origin bootstrap"

code="$(api GET /auth/me "wrong-token")"
expect_code 401 "$code" "invalid bearer token"

code="$(api GET "/space/files?workspaceId=main" "wrong-token" "" "http://127.0.0.1:$PORT")"
expect_code 401 "$code" "invalid space bearer token"

code="$(api POST /auth/bootstrap "" '{"userId":"admin","name":"Admin","password":"password-123"}')"
expect_code 201 "$code" "identity bootstrap"
TOKEN="$(node -e 'const body=require(process.argv[1]);process.stdout.write(body.token)' "$BODY")"

code="$(api GET /roles/personas "wrong-token")"
expect_code 401 "$code" "invalid roles bearer token"

code="$(api GET /roles/personas "$TOKEN")"
expect_code 200 "$code" "roles persona list"

code="$(api POST /roles/personas "$TOKEN" '{"id":"architect","name":"Architect","description":"Module boundaries","tags":["architecture"],"soul":"Use engineering judgment."}' "http://127.0.0.1:$PORT")"
expect_code 201 "$code" "persona creation"

code="$(api POST /roles/personas "$TOKEN" '{"id":"../escape","name":"Escape","soul":"bad"}' "http://127.0.0.1:$PORT")"
expect_code 400 "$code" "persona path traversal"

code="$(api POST /roles/types "$TOKEN" '{"id":"product","name":"Product collaboration","seats":[{"id":"owner","label":"Owner","participantKind":"human","personaId":"architect","permissions":["read","write","approve"]},{"id":"builder","label":"Builder","participantKind":"agent","permissions":["read","write"]},{"id":"reviewer","label":"Reviewer","participantKind":"human","permissions":["read","approve"]}]}' "http://127.0.0.1:$PORT")"
expect_code 201 "$code" "workspace type creation"

code="$(api POST /team/users/create "$TOKEN" '{"userId":"outsider","name":"Outsider","password":"password-789","role":"member"}')"
expect_code 201 "$code" "non-member account creation"

code="$(api POST /auth/login "" '{"userId":"outsider","password":"password-789"}')"
expect_code 200 "$code" "non-member login"
OUTSIDER_TOKEN="$(node -e 'const body=require(process.argv[1]);process.stdout.write(body.token)' "$BODY")"

code="$(api POST /roles/materialize "$OUTSIDER_TOKEN" "{\"workspaceId\":\"$WORKSPACE_ID\",\"typeId\":\"product\"}" "http://127.0.0.1:$PORT")"
expect_code 403 "$code" "non-member role materialization"

code="$(api POST /roles/materialize "$TOKEN" "{\"workspaceId\":\"$WORKSPACE_ID\",\"typeId\":\"product\"}" "http://127.0.0.1:$PORT")"
expect_code 201 "$code" "workspace type materialization"

code="$(api POST /roles/seats/claim "$TOKEN" "{\"workspaceId\":\"$WORKSPACE_ID\",\"seatId\":\"owner\"}" "http://127.0.0.1:$PORT")"
expect_code 201 "$code" "human role claim"
grep -q '"leader":true' "$BODY" || {
  echo "first role claim should become leader" >&2
  cat "$BODY" >&2
  exit 1
}

code="$(api POST /roles/seats/assign "$TOKEN" "{\"workspaceId\":\"$WORKSPACE_ID\",\"seatId\":\"builder\",\"assigneeKind\":\"agent\",\"assigneeId\":\"session-a\",\"personaId\":\"architect\"}" "http://127.0.0.1:$PORT")"
expect_code 201 "$code" "agent role assignment"

code="$(api GET "/roles/seats?workspaceId=$WORKSPACE_ID" "$TOKEN" "" "http://127.0.0.1:$PORT")"
expect_code 200 "$code" "role seat list"
grep -q '"assigneeId":"session-a"' "$BODY" || {
  echo "role seat list is missing assigned agent" >&2
  cat "$BODY" >&2
  exit 1
}

code="$(api GET "/meetings?workspaceId=$WORKSPACE_ID" "wrong-token")"
expect_code 401 "$code" "invalid meeting bearer token"

code="$(api GET "/meetings?workspaceId=$WORKSPACE_ID" "$TOKEN" "" "https://evil.example")"
expect_code 403 "$code" "cross-origin meeting request"

code="$(api GET "/meetings?workspaceId=$WORKSPACE_ID" "$OUTSIDER_TOKEN")"
expect_code 403 "$code" "non-member meeting request"

code="$(api POST /meetings "$TOKEN" "{\"workspaceId\":\"$WORKSPACE_ID\",\"title\":\"Pluginmax sync\",\"agenda\":\"Verify meeting collaboration.\"}" "http://127.0.0.1:$PORT")"
expect_code 201 "$code" "meeting creation"
MEETING_ID="$(node -e 'const body=require(process.argv[1]);process.stdout.write(body.meeting.id)' "$BODY")"

code="$(api POST /meeting/join "$TOKEN" "{\"meetingId\":\"$MEETING_ID\",\"displayName\":\"Admin\"}" "http://127.0.0.1:$PORT")"
expect_code 409 "$code" "duplicate human meeting join"

code="$(api POST /meeting/message "$TOKEN" "{\"meetingId\":\"$MEETING_ID\",\"content\":\"Meeting smoke message.\"}" "http://127.0.0.1:$PORT")"
expect_code 201 "$code" "meeting message"

code="$(api POST /meeting/close "$TOKEN" "{\"meetingId\":\"$MEETING_ID\",\"summary\":\"Meeting collaboration verified.\"}" "http://127.0.0.1:$PORT")"
expect_code 200 "$code" "meeting close"
grep -q '"status":"closed"' "$BODY" || {
  echo "meeting close did not return a closed meeting" >&2
  cat "$BODY" >&2
  exit 1
}

code="$(api GET "/meeting?meetingId=$MEETING_ID" "$TOKEN" "" "http://127.0.0.1:$PORT")"
expect_code 200 "$code" "closed meeting detail"
grep -q '"summary":"Meeting collaboration verified."' "$BODY" || {
  echo "closed meeting detail is missing the persisted summary" >&2
  cat "$BODY" >&2
  exit 1
}
grep -q "Meeting smoke message." "$BODY" || {
  echo "closed meeting detail is missing the transcript" >&2
  cat "$BODY" >&2
  exit 1
}

code="$(api GET /auth/me "$TOKEN")"
expect_code 200 "$code" "current identity"
grep -q '"role":"admin"' "$BODY" || {
  echo "bootstrap account should be admin" >&2
  cat "$BODY" >&2
  exit 1
}

code="$(api GET /space/workspaces "$TOKEN" "" "http://127.0.0.1:$PORT")"
expect_code 200 "$code" "space workspace list"
grep -q "\"id\":\"$WORKSPACE_ID\"" "$BODY" || {
  echo "space workspace list is missing the smoke fixture" >&2
  cat "$BODY" >&2
  exit 1
}

code="$(api GET "/space/files?workspaceId=$WORKSPACE_ID" "$TOKEN" "" "https://evil.example")"
expect_code 403 "$code" "cross-origin space request"

code="$(api POST /space/files "$TOKEN" "{\"workspaceId\":\"$WORKSPACE_ID\",\"path\":\"../escape.md\",\"content\":\"bad path\"}" "http://127.0.0.1:$PORT")"
expect_code 400 "$code" "space path traversal"

code="$(api POST /space/files "$TOKEN" "{\"workspaceId\":\"$WORKSPACE_ID\",\"path\":\"docs/secret.md\",\"content\":\"key = sk-abcdefghijklmnopqrstuvwx\\n\"}" "http://127.0.0.1:$PORT")"
expect_code 403 "$code" "space secret scan"

code="$(api POST /space/files "$TOKEN" "{\"workspaceId\":\"$WORKSPACE_ID\",\"path\":\"docs/readme.md\",\"content\":\"workspace shared content\\n\"}" "http://127.0.0.1:$PORT")"
expect_code 201 "$code" "workspace shared upload"
grep -q '"path":"workspace/docs/readme.md"' "$BODY" || {
  echo "workspace upload returned an unexpected file path" >&2
  cat "$BODY" >&2
  exit 1
}

code="$(api POST /space/file/read "$TOKEN" "{\"workspaceId\":\"$WORKSPACE_ID\",\"path\":\"workspace/docs/readme.md\"}" "http://127.0.0.1:$PORT")"
expect_code 200 "$code" "policy-gated shared read"
grep -q 'workspace shared content' "$BODY" || {
  echo "shared read returned unexpected content" >&2
  cat "$BODY" >&2
  exit 1
}

code="$(api POST /space/locks/acquire "$TOKEN" "{\"workspaceId\":\"$WORKSPACE_ID\",\"path\":\"docs/readme.md\",\"sessionId\":\"smoke-session-a\",\"ttlMs\":60000}" "http://127.0.0.1:$PORT")"
expect_code 201 "$code" "first advisory lock"

code="$(api POST /space/locks/acquire "$TOKEN" "{\"workspaceId\":\"$WORKSPACE_ID\",\"path\":\"docs/readme.md\",\"sessionId\":\"smoke-session-b\",\"ttlMs\":60000}" "http://127.0.0.1:$PORT")"
expect_code 409 "$code" "conflicting advisory lock"

code="$(api POST /space/locks/release "$TOKEN" "{\"workspaceId\":\"$WORKSPACE_ID\",\"path\":\"docs/readme.md\",\"sessionId\":\"smoke-session-a\"}" "http://127.0.0.1:$PORT")"
expect_code 200 "$code" "advisory lock release"

code="$(api POST /space/files "$TOKEN" "{\"workspaceId\":\"$WORKSPACE_ID\",\"path\":\"docs/global.md\",\"scope\":\"global\",\"content\":\"approved global content\\n\"}" "http://127.0.0.1:$PORT")"
expect_code 202 "$code" "global sharing approval request"
GLOBAL_REQUEST_ID="$(node -e 'const body=require(process.argv[1]);process.stdout.write(body.request.id)' "$BODY")"

code="$(api POST /space/global/requests/decision "$TOKEN" "{\"requestId\":\"$GLOBAL_REQUEST_ID\",\"approve\":true}" "http://127.0.0.1:$PORT")"
expect_code 200 "$code" "global sharing approval"
grep -q '"status":"approved"' "$BODY" || {
  echo "global approval did not approve the request" >&2
  cat "$BODY" >&2
  exit 1
}

code="$(api GET "/space/audit?workspaceId=$WORKSPACE_ID&limit=100" "$TOKEN" "" "http://127.0.0.1:$PORT")"
expect_code 200 "$code" "space audit"
grep -q '"action":"file_write"' "$BODY" || {
  echo "space audit is missing file_write" >&2
  cat "$BODY" >&2
  exit 1
}

# ---- project management (dsh-collab-project) ----
# 「项目」复用 DSH 工作区：这里把 smoke 工作区注册成项目，并验证项目角色、
# 成员席位、日报与项目模版维护都在真实路由上可用。
code="$(api GET /projects "$TOKEN")"
expect_code 200 "$code" "project list"

code="$(api GET /projects/templates "$TOKEN")"
expect_code 200 "$code" "project template list"
grep -q '"role-owner"' "$BODY" || {
  echo "project template list is missing the built-in role library" >&2
  cat "$BODY" >&2
  exit 1
}

code="$(api POST /projects/create "$TOKEN" "{\"path\":\"$WORKSPACE_ROOT\",\"name\":\"Pluginmax smoke\",\"templateId\":\"tpl-plugin-dev\"}" "http://127.0.0.1:$PORT")"
expect_code 201 "$code" "project creation"
PROJECT_ID="$(node -e 'const body=require(process.argv[1]);process.stdout.write(body.workspaceId)' "$BODY")"

code="$(api GET "/projects/detail?workspaceId=$PROJECT_ID" "$TOKEN")"
expect_code 200 "$code" "project detail"
grep -q '"role-owner"' "$BODY" || {
  echo "project detail is missing the materialized project roles" >&2
  cat "$BODY" >&2
  exit 1
}
grep -q '"canManage":true' "$BODY" || {
  echo "project detail should report the owner as manager" >&2
  cat "$BODY" >&2
  exit 1
}

code="$(api POST /projects/update "$TOKEN" "{\"workspaceId\":\"$PROJECT_ID\",\"status\":\"进行中\",\"health\":\"健康\",\"progress\":40,\"description\":\"smoke project\"}" "http://127.0.0.1:$PORT")"
expect_code 200 "$code" "project update"

code="$(api GET "/projects/detail?workspaceId=$PROJECT_ID" "$TOKEN")"
expect_code 200 "$code" "project detail for role draft"

# 草稿确认：整组覆盖生效，改名 + 新增角色。
node -e '
const body = require(process.argv[1]);
const workspaceId = process.argv[2];
const roles = body.project.projectRoles.map((role) =>
  role.code === "PROJECT_OWNER" ? { ...role, name: "项目总负责人" } : role,
);
roles.push({
  id: "role-smoke-confirm",
  name: "Smoke 项目角色",
  code: "SMOKE_PROJECT_ROLE",
  category: "支持",
  description: "项目自己的角色副本",
  permissions: ["read"],
});
process.stdout.write(
  JSON.stringify({
    workspaceId,
    expectedRevision: body.project.rolesRevision,
    roles,
  }),
);
' "$BODY" "$PROJECT_ID" > "$ROOT/.tmp/project-role-confirm.json"

code="$(api POST /projects/roles/confirm "$TOKEN" "$(cat "$ROOT/.tmp/project-role-confirm.json")" "http://127.0.0.1:$PORT")"
expect_code 200 "$code" "project roles confirm"
grep -q '"SMOKE_PROJECT_ROLE"' "$BODY" || {
  echo "project roles confirm did not persist the project role" >&2
  cat "$BODY" >&2
  exit 1
}
grep -q '"revision":2' "$BODY" || {
  echo "project roles confirm did not bump rolesRevision" >&2
  cat "$BODY" >&2
  exit 1
}

code="$(api POST /projects/members/save "$TOKEN" "{\"workspaceId\":\"$PROJECT_ID\",\"memberKind\":\"human\",\"memberId\":\"admin\",\"roleIds\":[\"role-owner\"]}" "http://127.0.0.1:$PORT")"
expect_code 200 "$code" "project member save"

code="$(api POST /projects/reports/generate "$TOKEN" "{\"workspaceId\":\"$PROJECT_ID\"}" "http://127.0.0.1:$PORT")"
expect_code 200 "$code" "project report generation"
grep -q '今日结论' "$BODY" || {
  echo "project report is missing the 今日结论 section" >&2
  cat "$BODY" >&2
  exit 1
}

code="$(api GET "/projects/reports?workspaceId=$PROJECT_ID" "$TOKEN")"
expect_code 200 "$code" "project report list"

code="$(api POST /projects/roles/save "$TOKEN" '{"id":"role-smoke","name":"Smoke 角色","code":"SMOKE_ROLE","category":"支持","description":"","permissions":["read"]}' "http://127.0.0.1:$PORT")"
expect_code 200 "$code" "project role save"

code="$(api POST /projects/roles/remove "$TOKEN" '{"id":"role-smoke"}' "http://127.0.0.1:$PORT")"
expect_code 200 "$code" "project role remove"

code="$(api POST /team/users/create "$TOKEN" '{"userId":"member","name":"Member","password":"password-456","role":"member"}')"
expect_code 201 "$code" "member creation"

code="$(api PUT /team/members/set "$TOKEN" "{\"workspaceId\":\"$WORKSPACE_ID\",\"userId\":\"member\",\"role\":\"owner\"}")"
expect_code 200 "$code" "workspace member add"

code="$(api GET "/team/members?workspaceId=$WORKSPACE_ID" "$TOKEN")"
expect_code 200 "$code" "workspace member list"
grep -q '"userId":"member"' "$BODY" || {
  echo "workspace member list is missing member" >&2
  cat "$BODY" >&2
  exit 1
}

code="$(api GET /team/audit "$TOKEN")"
expect_code 200 "$code" "identity audit"
grep -q '"action":"member_add"' "$BODY" || {
  echo "audit timeline is missing member_add" >&2
  cat "$BODY" >&2
  exit 1
}

code="$(api POST /auth/bootstrap "" '{"userId":"other","name":"Other","password":"password-789"}')"
expect_code 409 "$code" "duplicate bootstrap"

code="$(api POST /auth/logout "$TOKEN")"
expect_code 200 "$code" "identity logout"

echo "Pluginmax canary, identity, space, roles, meeting, and project smoke passed on port $PORT"
exit 0
