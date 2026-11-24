# dsh-pluginmax 增量升级 M13d Production Secret Resolver + Read-only MCP ProjectSourceAdapter 实施记录

> 阶段：M13d Production Secret Resolver + Read-only MCP ProjectSourceAdapter
> 日期：2026-11-21
> 前置基线：M13c Agent Runtime MCP Tool Request Bridge，Migration 51
> Migration：52
> 目标方案：`docs/v2-dsh-pluginmax-upgrade-delta-architecture-and-migration-plan.md`

## 1. 完成范围

M13d 补齐了两个边界：

1. 生产 Secret Resolver 端口，支持显式 Secret Store Adapter、超时、缓存、
   轮换边界、错误分类和默认 fail-closed。
2. 只读 MCP ProjectSourceAdapter，只能从 Worker 内部通过 M13c Runtime Tool
   Bridge 和 M13b `tools/call` 执行链读取来源。

本批包含：

- `secret://` 引用格式和统一 Resolver 端口。
- 环境变量兼容 Adapter 与显式挂载文件 Secret Store Adapter。
- 未配置 Secret Store 时 `secret://` 拒绝解析，不访问远端。
- Resolver 缓存 TTL、适配器代际、过期时间和显式失效边界。
- Secret Store 超时、取消、权限、缺失和未知错误分类。
- Secret 值不进入错误消息、DB、普通 API、日志或 Market 投影。
- `mcp-project-source-read-v1` 只读 Tool 协议。
- ProjectSource 绑定 Provider、Provider Version、Provider Revision 和 Tool Key。
- Worker-only Source Adapter 通过 M13c Bridge 执行 M13b Worker Tool Call。
- Source Read 请求、回执、快照、Alert 和 Prometheus 指标。
- `project.source.mcp=off` 默认关闭。
- 浏览器只读项目来源状态，不提供 MCP 直连或通用 `tools/call`。

本批明确未实现：

- Vault、AWS Secrets Manager、GCP Secret Manager 或 Azure Key Vault 的具体
  SDK 接入。
- 浏览器 ProjectSource MCP 调用 API。
- 通用 MCP invoke 或 Provider Tool 代理 API。
- 自动周期刷新调度器。当前端口由后续 Worker 内部调用方显式触发。
- 原始 Tool 结果正文持久化。
- 对可能有远端副作用的调用自动重试。
- Market Binding、Provider Owner 或 Platform Admin 的隐式来源读取授权。

## 2. 部署配置审计

现有部署只明确提供：

- PostgreSQL。
- `DATABASE_URL`。
- 进程环境变量和根目录 `.env`。
- MCP Provider HTTPS、Host allowlist 和私网地址拒绝配置。
- DSH 本地运行目录。

仓库没有明确选择 Vault、AWS Secrets Manager、GCP Secret Manager 或其他外部
Secret Store，因此 M13d 没有擅自引入新的外部服务或 SDK。

部署方必须提供以下任意一种能力：

1. 由 Vault Agent、Kubernetes Secret、云 Secret Manager 同步任务或等价机制
   生成一个只读 JSON 文件，并通过 `MCP_SECRET_STORE_FILE` 显式挂载。
2. 在 Worker 组装代码中注入一个实现 `SecretStoreAdapter` 的部署适配器。

挂载文件格式：

```json
{
  "secrets": {
    "secret://mcp/provider/example/token": "deployment-managed-value"
  }
}
```

文件默认必须是 `0600`，不得 group/world readable。仅在明确接受该风险的开发
环境可使用：

```text
MCP_SECRET_STORE_ALLOW_LOOSE_PERMISSIONS=1
```

## 3. Secret Resolver

文件：

- `packages/contracts/src/secret-reference.ts`
- `apps/worker/src/secret-resolver.ts`

引用格式：

```text
env://ENV_VAR_NAME
secret://namespace/path/to/credential
```

端口：

```ts
interface SecretStoreAdapter {
  id: string;
  load(input: {
    reference: string;
    name: string;
    signal: AbortSignal;
    timeoutMs: number;
    now: Date;
  }): Promise<
    | {
        value: string;
        generation?: string;
        expiresAt?: Date;
      }
    | undefined
  >;
}
```

默认行为：

- `env://` 继续兼容。
- 未配置任何非 `env` Adapter 时，`secret://` 返回
  `secret_store_not_configured`。
- 配置 `MCP_SECRET_STORE_FILE` 后才读取挂载文件。
- 缺失值不缓存。
- 正值缓存默认 30 秒，可由
  `MCP_SECRET_RESOLUTION_CACHE_TTL_MS` 调整。
- 缓存不超过 Adapter 返回的 `expiresAt`。
- Resolver 提供显式 `invalidate(ref)` 与 `resolveUncached(ref)`。
- 挂载文件使用 mtime 和文件大小作为代际标识，支持原子轮换。
- 解析超时默认 5 秒，可由 `MCP_SECRET_RESOLUTION_TIMEOUT_MS` 调整。

错误分类：

```text
not_configured
invalid_reference
not_found
timeout
cancelled
authentication
authorization
unavailable
invalid
unknown
```

敏感边界：

- Secret 值只在 Worker 内存中存在。
- 错误只返回分类和固定错误码。
- 不记录 Credential Ref、解析值、文件内容或原始异常正文。

## 4. Migration 52

文件：

- `packages/database/src/m13d-schema.ts`
- `packages/database/src/migrate.ts`

Flag：

```text
project.source.mcp=off
```

新增表：

`project_source_mcp_reads`：

```text
request_id
project_id
ref_key
source_kind
source_system
source_object_type
source_object_id
source_path
source_binding_revision
source_binding_digest
provider_id
provider_version_id
provider_revision
tool_key
run_id
run_attempt
ticket_id
gate_id
policy_id
policy_revision
envelope_id
envelope_digest
runtime_request_id
call_id
snapshot_id
idempotency_key
request_digest
status
source_revision
error_category
error_code
error_message
lease_owner
lease_token
lease_expires_at
started_at
completed_at
created_at
updated_at
```

`project_source_mcp_read_events`，append-only：

```text
id
request_id
project_id
seq
status
actor_principal_id
error_category
error_code
created_at
```

约束：

- 同一 Project、Source Binding、Ref Key 和幂等键唯一。
- Source Binding、Provider、Version、Tool Key、Run、Attempt、Ticket、Gate、
  Policy 和 Envelope 身份字段不可修改。
- 终态不可重新打开或删除。
- Running 必须持有 Worker 租约；终态必须清空租约。
- Read Event 只能 INSERT。
- `snapshot_id` 和 `runtime_request_id` 唯一，防止重复投影。

## 5. 只读 Tool 协议

文件：

- `packages/contracts/src/project-source-mcp.ts`

协议：

```text
mcp-project-source-read-v1
```

请求只包含来源对象身份：

```json
{
  "protocol": "mcp-project-source-read-v1",
  "projectId": "...",
  "refKey": "erp:order:order-42",
  "sourceSystem": "erp",
  "objectType": "order",
  "objectId": "order-42",
  "path": "amount"
}
```

Tool 输出：

```json
{
  "protocol": "mcp-project-source-read-v1",
  "sourceRevision": "external-revision",
  "observedAt": "2026-11-21T00:00:00.000Z",
  "effectiveAt": "2026-11-21T00:00:00.000Z",
  "freshUntil": "2026-11-21T00:05:00.000Z",
  "payload": {
    "amount": 420
  },
  "alerts": []
}
```

输出可从 `structuredContent`、JSON 文本 `content` 或顶层结果读取，但必须通过
strict Schema。

字段映射：

```text
sourceRevision -> project_source_snapshots.source_revision
observedAt     -> observed_at
effectiveAt    -> effective_at
freshUntil     -> fresh_until
payload        -> payload + payload_digest
alerts         -> project_alerts / project_alert_events
```

## 6. Worker-only 执行链

文件：

- `apps/worker/src/project-source-mcp-adapter.ts`

执行顺序：

```text
McpProjectSourceAdapter.read()
  -> require project.source.mcp=on
  -> require project.business_chain=on
  -> require Provider control plane, Tool invocation, Runtime Bridge = on
  -> resolve current Project Business Chain binding
  -> validate MCP source binding, Provider Version and Tool Key
  -> load Run, Action Ticket, Gate and Policy revision
  -> begin idempotent Source Read with Worker lease
  -> RuntimeToolRequestBridge.request()
  -> McpToolCallService.execute()
  -> complete M13b authorization chain
  -> call Provider tools/call
  -> return ephemeral result
  -> sanitize payload
  -> insert immutable Source Snapshot
  -> project M11 Alert
  -> complete Source Read and append event
```

完整授权仍然来自 M13b/M13c：

1. Running Run 和当前 Attempt。
2. Task-backed Execution Envelope。
3. Action Ticket 与 `mcp.invoke` / `connector-data` Scope。
4. blocking `tool-approval` Gate。
5. Policy Revision allow 且 requireApproval。
6. Provider 当前版本 active/healthy/ready。
7. Tool Key 属于当前 Provider Version。
8. Run Tool Call 预算。

Provider Owner、Platform Admin、Market Binding 均不替代上述任一项。

## 7. 数据脱敏

以下内容不持久化：

- Credential Ref。
- Credential 值。
- Provider Endpoint。
- Authorization Header。
- 原始 MCP JSON-RPC Response。
- Tool 输入/输出正文。

Payload 在落库前递归移除高风险键：

```text
credential
secret
token
authorization
password
private key
endpoint
header
```

字符串形式的 `env://` 与 `secret://` 引用替换为 `[redacted]`。

普通日志仅记录：

- Request、Project、Ref、Provider 和 Tool Key 身份。
- Provider Version。
- Alert 数量。
- 脱敏后的 Payload Key。
- 状态、错误分类和耗时。

## 8. 状态机与并发

Source Read：

```text
running -> succeeded
        -> failed
        -> timed_out
        -> cancelled
        -> interrupted
```

Snapshot：

```text
fresh | stale | error
```

并发策略：

- `project_id + source_binding_digest + ref_key + idempotency_key` 唯一。
- PostgreSQL advisory transaction lock 串行化同一请求。
- 同 Worker in-flight Promise 复用。
- 相同请求重放返回已有 Snapshot，不第二次访问 Provider。
- 相同幂等键不同 Source Binding 返回 conflict。
- 不同 Run 的并发读取各自使用自己的 Gate 和 Request。
- Worker 租约过期由 Sweep 收敛为 `interrupted`，追加 error Snapshot 与 Alert。
- Run 取消、超时和 Lease Lost 分别分类。

## 9. API 与 Web

新增：

```text
GET /api/v1/admin/project-source-mcp/summary
POST /api/v1/admin/project-source-mcp/reconcile
GET /api/v1/admin/project-source-mcp/retention
```

Admin Reconcile 只关闭租约已过期的 Running Read，不访问 Provider、不重放远端调用。
Retention 仅执行 Dry Run，返回过期 Read/Event/Snapshot 数量和最早完成时间；
正式清理必须先归档，再按分区或受控维护任务执行。

不新增：

```text
POST /projects/:id/sources/read
POST /projects/:id/business-chain/mcp-tools/call
POST /mcp-providers/:id/invoke
POST /runs/:id/project-source-reads
```

浏览器：

- 只读 Project Overview / Source Freshness / Alert。
- MCP Source 不显示“刷新来源”按钮。
- 直接调用 M13d Worker 端口或通用 Tool invoke 返回 404。
- 直接调用旧 Project Source refresh 且来源为 MCP 返回
  `403 project_source_mcp_worker_only`。
- 不展示 Endpoint、Credential Ref、Provider Version ID、Tool Key 或原始响应。

M11 Mock Fixture 刷新继续保留为显式测试兼容路径；任何 `sourceKind=mcp` 都会
在 API 进程内被拒绝。

## 10. 指标与 Alert

`project.source.mcp=on` 时 `/api/v1/metrics` 额外输出：

```text
pluginmax_project_source_mcp_reads{status=...}
pluginmax_project_source_mcp_stale_reads
pluginmax_project_source_mcp_oldest_running_seconds
pluginmax_project_source_mcp_errors{category=...}
pluginmax_project_source_mcp_alert_level
```

告警规则：

```text
stale_running > 0                  -> critical
oldest_running >= 300s             -> warning
oldest_running >= 900s             -> critical
total >= 10 && error ratio >= 25%  -> warning
total >= 10 && error ratio >= 50%  -> critical
```

Alert 继续写 M11 `project_alerts` / `project_alert_events`，不创建第二套 Alert
事实源。

## 11. 验证结果

### 11.1 Migration 52 隔离

```text
./scripts/m13d-project-source-migration-vitest.sh

m13d_migration_vitest=ok
fresh_migration=0->52
idempotent_migration=52->52
upgrade_migration=51->52
flag=project.source.mcp=off
tables=2
triggers=6
```

### 11.2 M13d PostgreSQL 集成

```text
./scripts/m13d-project-source-vitest.sh

Test Files  7 passed
Tests       38 passed
```

覆盖：

- Secret Store 未配置时 fail closed。
- 挂载 Secret Store、文件权限、超时、取消、缓存和显式轮换失效。
- 挂载 Secret Store 原子轮换后可重新加载新值。
- 凭证值、Credential Ref、Endpoint、Tool Key 和原始响应不进入 DB、日志、
  Overview 或 E2E 页面。
- MCP Source 只能通过 Worker Bridge 读取；浏览器调用返回 404 / 403。
- 缺 Ticket、Gate 或 Policy Revision 拒绝。
- Provider 版本切换后拒绝，且不访问远端。
- 来源超时、取消、Run 租约丢失和错误分类。
- 同请求幂等重放、并发读取、乱序完成和 Snapshot 唯一。
- Flag 关闭不访问 Provider，不写 Source Read、Snapshot、Runtime Request、
  Tool Call、Audit 或 Alert。
- Source Read Event append-only。
- M11 Overview、Stale/Error 和 Alert 兼容。
- M13c Runtime Bridge、M13b Tool Call 和 M11 Project Business Chain 回归。
- Admin Summary、Reconcile 和 Retention Dry Run。

### 11.3 Web E2E

```text
./scripts/m13d-project-source-e2e.sh

1 passed
```

覆盖：

- 浏览器展示来源值、错误状态和 M11 Alert。
- MCP Source 页面没有刷新入口。
- 直接刷新返回 `403 project_source_mcp_worker_only`。
- 通用 MCP invoke / Source read 路径返回 404。
- Secret、Endpoint、Credential Ref、Provider Version ID 和 Tool Key 不回显。
- `1440x960`、`900x900`、`390x844` 无横向溢出。

截图：

- `.tmp/m13d-project-source-1440.png`
- `.tmp/m13d-project-source-900.png`
- `.tmp/m13d-project-source-390.png`

### 11.4 历史批次回归

```text
M13c Migration   pass  (fresh 0->52, M13c tables/trigger/flag unchanged)
M13c Integration pass  (4 files, 20 tests)
M13c E2E         pass  (1 test)

M13b Migration   pass
M13b Integration pass  (4 files, 15 tests)
M13b E2E         pass  (1 test)

M13a Migration   pass
M13a Integration pass  (1 file, 7 tests)
M13a E2E         pass  (1 test)

M12 Migration    pass
M12 Integration  pass  (1 file, 8 tests)

M11 Migration    pass
M11 Integration  pass  (1 file, 8 tests)
M11 E2E          pass  (1 test)
```

### 11.5 全仓检查

```text
pnpm typecheck  pass
pnpm lint       pass
pnpm test       pass（224 passed / 294 skipped）
pnpm build      pass
```

## 12. 未完成项与剩余风险

- 未绑定具体 Vault/AWS/GCP Secret Manager SDK。部署方必须显式提供挂载文件
  或注入 Adapter；否则所有 `secret://` 继续 fail closed。
- 挂载文件模式适合由部署平台管理轮换；它不是远程 Secret Store 的等价替代，
  需要部署方确保目录权限、原子写入和备份策略。
- 正值缓存默认 30 秒。需要更快撤销的部署应减小 TTL 或调用显式失效。
- 当前没有自动定时刷新调度器。后续 Worker 调用方必须显式发起已授权
  Source Read，不能从浏览器旁路。
- Source Tool 是否真正只读仍依赖 Provider 与 Tool Contract 的部署约定；
  M13d 通过显式 `readOnly=true`、固定 Tool Key 和 Worker-only 端口限制暴露面。
- 远端读取成功但本地 Snapshot 完成前 Worker 崩溃时，远端结果已丢失，只能
  以 `interrupted` 收敛并使用新请求重读。本批不自动重试。
- Payload 脱敏依赖键名规则和 Secret Ref 模式；来源系统本身仍不得把凭据放入
  业务 Payload。
- Source Read/Snapshot/Event 会持续增长，需要后续保留、归档与分区策略。

## 13. Alert Runbook 锚点

### Alert

1. 检查 `project.source.mcp` 是否开启。
2. 检查 `pluginmax_project_source_mcp_stale_reads`。
3. 检查 `pluginmax_project_source_mcp_errors` 的分类。
4. 检查 Provider 当前版本、健康状态和 Tool Key。
5. 检查 Action Ticket、Execution Gate、Policy Revision 和 Envelope。
6. 检查 Secret Store 文件权限、挂载状态和轮换时间。
7. 只通过 Worker Reconcile 关闭过期 Running Read，不手工删除 Receipt。
