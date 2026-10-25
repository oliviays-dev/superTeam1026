#!/usr/bin/env bash
set -euo pipefail

API_BASE="${API_BASE:-http://127.0.0.1:4310/api/v1}"
STAMP="$(date +%Y%m%d-%H%M%S)"

curl -fsS "$API_BASE/health" >/dev/null

agent="$(
  curl -fsS -X POST "$API_BASE/agents" \
    -H "content-type: application/json" \
    -d "{\"name\":\"Collaboration agent $STAMP\",\"runtimeKind\":\"fake\"}"
)"
agent_id="$(printf '%s' "$agent" | jq -r '.id')"
project="$(
  curl -fsS -X POST "$API_BASE/projects" \
    -H "content-type: application/json" \
    -d "{\"name\":\"Task collaboration $STAMP\"}"
)"
project_id="$(printf '%s' "$project" | jq -r '.id')"
task="$(
  curl -fsS -X POST "$API_BASE/tasks" \
    -H "content-type: application/json" \
    -d "{\"projectId\":\"$project_id\",\"title\":\"Collaboration task $STAMP\",\"description\":\"Verify comments, attachments and activity.\",\"agentId\":\"$agent_id\"}"
)"
task_id="$(printf '%s' "$task" | jq -r '.id')"

message="$(
  curl -fsS -X POST "$API_BASE/tasks/$task_id/messages" \
    -H "content-type: application/json" \
    -d '{"content":"Top-level decision"}'
)"
message_id="$(printf '%s' "$message" | jq -r '.id')"
reply="$(
  curl -fsS -X POST "$API_BASE/tasks/$task_id/messages" \
    -H "content-type: application/json" \
    -d "{\"content\":\"Reply with evidence\",\"replyToId\":\"$message_id\"}"
)"
reply_id="$(printf '%s' "$reply" | jq -r '.id')"

content="batch4 attachment evidence"
encoded="$(printf '%s' "$content" | base64 | tr -d '\n')"
attachment="$(
  curl -fsS -X POST "$API_BASE/tasks/$task_id/attachments" \
    -H "content-type: application/json" \
    -d "{\"name\":\"evidence.txt\",\"mimeType\":\"text/plain\",\"contentBase64\":\"$encoded\"}"
)"
attachment_id="$(printf '%s' "$attachment" | jq -r '.id')"

detail="$(curl -fsS "$API_BASE/tasks/$task_id/detail")"
message_count="$(printf '%s' "$detail" | jq '.messages | length')"
reply_target="$(
  printf '%s' "$detail" |
    jq -r --arg reply "$reply_id" \
      '.messages[] | select(.id == $reply) | .replyToId'
)"
attachment_count="$(printf '%s' "$detail" | jq '.attachments | length')"
activity_count="$(printf '%s' "$detail" | jq '.activity | length')"

downloaded="$(
  curl -fsS "$API_BASE/attachments/$attachment_id/download"
)"
archived="$(
  curl -fsS -X POST "$API_BASE/attachments/$attachment_id/archive" \
    -H "content-type: application/json" \
    -d '{"archived":true}'
)"
archived_at="$(printf '%s' "$archived" | jq -r '.archivedAt')"
restored="$(
  curl -fsS -X POST "$API_BASE/attachments/$attachment_id/archive" \
    -H "content-type: application/json" \
    -d '{"archived":false}'
)"
restored_at="$(printf '%s' "$restored" | jq -r '.archivedAt')"
final_detail="$(curl -fsS "$API_BASE/tasks/$task_id/detail")"
final_activity_count="$(printf '%s' "$final_detail" | jq '.activity | length')"
final_archived_at="$(
  printf '%s' "$final_detail" | jq -r '.attachments[0].archivedAt'
)"

if [[ "$message_count" -ne 2 ||
      "$reply_target" != "$message_id" ||
      "$attachment_count" -ne 1 ||
      "$activity_count" -lt 4 ||
      "$final_activity_count" -lt 6 ||
      "$downloaded" != "$content" ||
      "$archived_at" == "null" ||
      "$restored_at" != "null" ||
      "$final_archived_at" != "null" ]]; then
  printf 'task collaboration verification failed\n' >&2
  printf '%s\n' "$detail" >&2
  exit 1
fi

printf 'task_collaboration_smoke=ok\n'
printf 'project_id=%s\n' "$project_id"
printf 'task_id=%s\n' "$task_id"
printf 'message_id=%s\n' "$message_id"
printf 'reply_id=%s\n' "$reply_id"
printf 'attachment_id=%s\n' "$attachment_id"
printf 'activity_count=%s\n' "$final_activity_count"
