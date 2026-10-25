#!/usr/bin/env bash
set -euo pipefail

API_BASE="${API_BASE:-http://127.0.0.1:4310/api/v1}"
STAMP="$(date +%Y%m%d-%H%M%S)"

curl -fsS "$API_BASE/health" >/dev/null
project="$(
  curl -fsS -X POST "$API_BASE/projects" \
    -H "content-type: application/json" \
    -d "{\"name\":\"Workflow markdown $STAMP\"}"
)"
project_id="$(printf '%s' "$project" | jq -r '.id')"

markdown="# 工作流：发布流程

## 元信息

- key: release-$STAMP
- version: 1
- description: validate and import workflow

## 节点

### 准备

- id: prepare
- type: task
- executor: user:local-admin

### 发布

- id: release
- type: service
- executor: system:deployment

## 连接

- prepare -> release"

json_payload="$(
  jq -n --arg projectId "$project_id" --arg markdown "$markdown" \
    '{projectId: $projectId, markdown: $markdown}'
)"
validation="$(
  curl -fsS -X POST "$API_BASE/workflows/validate" \
    -H "content-type: application/json" \
    -d "$(printf '%s' "$json_payload" | jq '{markdown}')"
)"
valid="$(printf '%s' "$validation" | jq -r '.valid')"
node_count="$(printf '%s' "$validation" | jq '.graph.nodes | length')"

imported="$(
  curl -fsS -X POST "$API_BASE/workflows/import" \
    -H "content-type: application/json" \
    -d "$json_payload"
)"
workflow_id="$(printf '%s' "$imported" | jq -r '.id')"
source_length="$(printf '%s' "$imported" | jq -r '.sourceMarkdown | length')"
graph_node_count="$(printf '%s' "$imported" | jq '.graph.nodes | length')"

invalid_markdown="# 工作流：循环

## 元信息

- key: cycle-$STAMP
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
- b -> a"
invalid="$(
  curl -fsS -X POST "$API_BASE/workflows/validate" \
    -H "content-type: application/json" \
    -d "$(jq -n --arg markdown "$invalid_markdown" '{markdown: $markdown}')"
)"
invalid_valid="$(printf '%s' "$invalid" | jq -r '.valid')"
cycle_error_count="$(
  printf '%s' "$invalid" |
    jq '[.errors[] | select(.code == "uncontrolled_cycle")] | length'
)"

if [[ "$valid" != "true" ||
      "$node_count" -ne 2 ||
      "$source_length" -lt 100 ||
      "$graph_node_count" -ne 2 ||
      "$invalid_valid" != "false" ||
      "$cycle_error_count" -lt 1 ]]; then
  printf 'workflow markdown verification failed\n' >&2
  printf '%s\n' "$validation" >&2
  printf '%s\n' "$imported" >&2
  printf '%s\n' "$invalid" >&2
  exit 1
fi

printf 'workflow_markdown_smoke=ok\n'
printf 'project_id=%s\n' "$project_id"
printf 'workflow_id=%s\n' "$workflow_id"
printf 'validated_nodes=%s\n' "$node_count"
printf 'cycle_errors=%s\n' "$cycle_error_count"
