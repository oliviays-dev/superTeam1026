# dsh-pluginmax 增量升级 M13b MCP Tool 调用与执行授权实施记录

> 阶段：M13b MCP Tool 调用与执行授权
> 日期：2026-11-21
> 前置基线：M13a MCP Provider 控制面，Migration 49
> Migration：50
> 目标方案：`docs/v2-dsh-pluginmax-upgrade-delta-architecture-and-migration-plan.md`

## 1. 完成范围

M13b 建立了服务端 MCP Tool 执行面和执行授权链，不包含完整 M13。

本批包含：

- Provider Tool 稳定身份 `toolKey`。
- Worker-only Streamable HTTP `tools/call` 调用端口。
- Task/Run、Action Ticket、Execution Gate 与 TaskExecutionPolicy 联合授权。
- Provider 当前版本、健康状态和 Tool Schema 身份校验。
- 调用状态、超时、取消、错误分类和租约对账。
- 幂等键、请求摘要和终态重放，不重复执行远端副作用。
- append-only Tool Call Receipt 与 Provider 审计。
- `mcp.tool_invocation=off` 默认关闭。
- Run 页最小只读 Tool 调用状态展示。

本批明确未实现：

- 浏览器 MCP 直连或公共 Tool invoke API。
- Agent Runtime 事件到 MCP Tool 调用端口的自动桥接。
- 真实 ProjectSourceAdapter 读取 MCP。
- 生产 Secret Store Resolver。
- 对可能有副作用的远端调用进行自动重试。
- 原始 Tool 输入、输出正文的持久化。
- ProjectMember、RoleGrant 或通用权限体系扩展。

## 2. Migration 50

文件：

- `packages/database/src/schema.ts`
- `packages/database/src/migrate.ts`

### 2.1 Flag

```text
mcp.tool_invocation=off
```

Tool 调用同时要求：

```text
mcp.provider_control_plane=on
mcp.tool_invocation=on
```

任一 Flag 关闭时，Worker 不调用 Provider、不写 Call、Receipt、Audit 或
Run Event。

### 2.2 稳定 Tool 身份

`mcp_provider_tools` 新增 `tool_key`：

```text
tool_key = deterministic-64-hex(
  providerId + providerVersionId + toolName + schemaDigest
)
```

Tool Schema 不可变，重新探测得到相同 Tool 时复用同一身份。Migration 回填
M13a Tool；旧应用省略 `tool_key` 插入时由数据库 Trigger 自动补值。

### 2.3 新增表

`mcp_tool_calls`：

```text
id
run_id
run_attempt
task_id
project_id
agent_id
agent_principal_id
provider_id
provider_key
provider_version_id
provider_version
provider_revision
tool_catalog_id
tool_key
tool_name
tool_schema_digest
ticket_id
gate_id
policy_id
policy_revision
envelope_id
envelope_digest
idempotency_key
request_digest
status
input_summary
output_summary
output_digest
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

`mcp_tool_call_receipts`，append-only：

```text
id
call_id
seq
status
idempotency_key
input_summary
output_summary
output_digest
error_category
error_code
error_message
created_at
```

### 2.4 Enforce

- 同一 Run 的 `idempotency_key` 唯一。
- 同一 `gate_id` 只能授权一次 MCP Tool 调用。
- Call 的身份字段不可修改，终态不可回到 running。
- 终态 Call 不可再更新或删除。
- Receipt 只能 INSERT，禁止 UPDATE/DELETE。
- Provider 审计继续使用 M13a append-only 表。
- 取消、超时和 Worker 崩溃结果不会覆盖旧 Receipt，只追加终态 Receipt。

## 3. 数据与状态机

```text
running -> succeeded
        -> failed
        -> timed_out
        -> cancelled
        -> interrupted
```

Receipt：

```text
started -> succeeded | failed | timed_out | cancelled | interrupted
```

结果：

- `succeeded`：远端返回有效 Tool Result。
- `failed`：认证、授权、HTTP、协议、Schema、Tool reported error 或未知错误。
- `timed_out`：调用超时。
- `cancelled`：外部 AbortSignal 取消。
- `interrupted`：Worker 租约过期，由对账任务关闭。

租约对账：

- 管理员 API 可执行无远端副作用的平台级 Reconcile。
- Worker Sweep 在 Flag 开启时自动对账过期 Call。
- 对账只追加 `interrupted` Receipt 和审计，不重放远端调用。

## 4. 权限矩阵

| 操作 | Provider Owner | Project Member | Platform Admin | Browser | Market Binding |
| --- | --- | --- | --- | --- | --- |
| 查看本人 Provider Tool | 允许 | 按 Provider 可见性 | 允许 | 只读 | 不因此允许 |
| 查看他人 Provider Tool | 禁止 | 禁止 | 允许 | 禁止 | 禁止 |
| Worker Tool 调用 | 不因 Owner 自动允许 | 需要完整执行授权链 | 不因 Admin 自动允许 | 禁止 | 不因 Binding 自动允许 |
| 平台 Tool Call 对账 | 禁止 | 禁止 | 允许 | 禁止 | 禁止 |
| 绑定 Provider 到 Market | 按 Market 规则 | 按 Market 规则 | 允许 | 不允许 | 仅身份引用 |

完整 Tool 执行授权链：

1. Run 为 running，Attempt 匹配。
2. Run 为 Task-backed，并有 Execution Envelope。
3. 当前 Principal 保留 Project `write`。
4. TaskExecutionPolicy 允许 `mcp.invoke`。
5. Policy 要求 `mcp.invoke` approval。
6. Policy 允许 `connector-data` 且未 deny。
7. Action Ticket 绑定 Run、Envelope、Policy Revision 和 Tool/Source Scope。
8. `tool-approval:mcp.invoke` Gate 为 blocking、approved，并绑定当前 Envelope。
9. Gate 未过期且未被其他工具消费。
10. Provider active、当前版本 healthy/ready，Tool Key 属于当前版本。
11. Tool Call 未超过 `maxToolCalls`。

Market Binding、Provider Owner、Platform Admin 均不能替代上述任一项。

## 5. Tool 调用端口

文件：

- `apps/worker/src/mcp-tool-call-service.ts`
- `apps/worker/src/mcp-provider-probe-service.ts`
- `apps/worker/src/worker-runtime.ts`
- `apps/worker/src/index.ts`

Worker 实现：

```text
initialize
notifications/initialized
tools/call
```

安全边界：

- 端口对象只在 Worker 构造。
- 浏览器没有 invoke 路由。
- 沿用 HTTPS、Host allowlist、私网拒绝、禁止重定向和 Cookie。
- 请求/响应硬超时。
- 响应仍限制为 2 MiB。
- 凭证只在 Worker 内存中解析。
- 日志只包含 Call/Run/Provider ID、Tool Key、耗时、状态和错误分类。

幂等：

- `runId + idempotencyKey + requestDigest` 决定调用身份。
- 相同参数重放返回已有终态，不重新调用 Provider。
- 相同幂等键不同参数返回 `mcp_tool_idempotency_conflict`。
- 显式重试必须使用新幂等键和新 Gate。

## 6. 脱敏数据

输入只保存：

```text
argumentKeys
argumentCount
inputBytes
```

输出只保存：

```text
contentCount
contentTypes
textBytes
structuredBytes
toolReportedError
outputDigest
```

不保存：

- Tool 参数值。
- Tool 输出正文。
- Authorization Header 或自定义凭证 Header。
- Credential Ref 到 Public API/Receipt/Market。
- 原始 Endpoint。
- 远端错误响应正文。

## 7. API

新增：

```text
GET  /api/v1/runs/:runId/mcp-tool-calls
POST /api/v1/admin/mcp-tool-calls/reconcile
```

不新增：

```text
POST /mcp-providers/:id/tools/:toolKey/call
POST /mcp-providers/:id/invoke
```

Run Tool Call 查询先执行 Run 访问控制，只返回状态、身份和脱敏摘要。
平台 Reconcile 只允许 Platform Admin，且不访问远端 MCP。

## 8. Web

Run 页新增最小只读区域：

- Provider Key。
- Tool Name。
- Provider Version。
- Policy Revision。
- Call 状态。
- 参数数量。
- 错误分类和错误码。
- 稳定 Tool Key 短摘要。

页面不展示输入/输出正文、Endpoint、Credential Ref 或请求头。

## 9. M13a / M12 兼容

- M13a Provider 注册、Probe、Tool 发现和审计 API 不变。
- Provider Catalog 继续返回 `invocationEnabled=false` 与
  `grantsExecution=false`。
- Tool Key 是新增只读身份，不改变 Provider 激活条件。
- Migration 50 不修改 Migration 45-49 已验收业务语义。
- M12 Market Binding 仍只引用 Provider 身份，不复制连接或授权。
- 旧应用读取 M13a Provider/Tool 继续兼容。
- 旧应用插入 Tool 时由 Trigger 补 `tool_key`。

## 10. 验证结果

### 10.1 Migration 50 隔离

```text
./scripts/m13b-mcp-tool-call-migration-vitest.sh

m13b_migration_vitest=ok
fresh_migration=0->50
upgrade_migration=48->50,49->50
idempotent_migration=50->50
flags=mcp.provider_control_plane=off,mcp.tool_invocation=off
tables=7
columns=13
triggers=9
tool_key_backfill=2
old_app_tool_insert=ok
old_app_market_read=user|private|published|active
```

### 10.2 M13b PostgreSQL 集成

```text
./scripts/m13b-mcp-tool-call-vitest.sh

Test Files  4 passed
Tests       15 passed
```

覆盖：

- 浏览器无直接 Tool invoke 路由。
- Provider Owner 不能读取/操作他人 Provider Tool。
- 非管理员不能执行平台 Tool Call 对账。
- 缺 Ticket、缺 Gate 拒绝。
- Market Binding 不替代 Ticket/Gate。
- Policy 必须 allow 且 requireApproval `mcp.invoke`。
- Timeout、Cancel、Unknown、Authentication、DNS、TLS、HTTP 分类。
- 有副作用的终态调用幂等重放只执行一次。
- Gate 单次消费。
- Provider Version/Revision CAS 冲突。
- Feature Flag 关闭不写 Call、Receipt、Audit，不访问远端。
- Receipt 和 Provider Audit append-only。
- 凭证、参数正文、输出正文、Credential Ref 不出现在 DB 回执、审计或日志。
- Streamable HTTP `tools/call` 与取消/超时。

### 10.3 Web E2E

```text
./scripts/m13b-mcp-tool-call-e2e.sh

1 passed
```

浏览器验证：

- Run 页展示脱敏 MCP Tool Call 状态。
- Tool Name、Provider、版本和成功状态可读。
- 输入/输出 Secret 不出现在页面。
- 浏览器直接 POST Tool invoke 返回 404。
- `1440x960`、`900x900`、`390x844` 无横向溢出。

截图：

- `.tmp/m13b-mcp-tool-call-1440.png`
- `.tmp/m13b-mcp-tool-call-900.png`
- `.tmp/m13b-mcp-tool-call-390.png`

### 10.4 M13a 回归

```text
./scripts/m13a-mcp-provider-migration-vitest.sh
m13a_migration_vitest=ok
fresh_migration=0->49

./scripts/m13a-mcp-provider-vitest.sh
Test Files  1 passed
Tests       7 passed
```

### 10.5 M12 回归

```text
./scripts/m12-market-governance-migration-vitest.sh
m12_migration_vitest=ok
fresh_migration=0->48

./scripts/m12-market-governance-vitest.sh
Test Files  1 passed
Tests       8 passed
```

### 10.6 全仓检查

```text
pnpm typecheck  pass
pnpm lint       pass
pnpm test       pass（216 passed / 276 skipped）
pnpm build      pass
```

## 11. 剩余风险与未完成项

- 当前 M13b 提供 Worker-only 调用服务端口；现有 Agent Runtime 事件只提供
  Tool 摘要，尚未自动把 Runtime Tool Request 桥接到该端口。
- 原始 Tool Result 不落库，因此跨进程重放只能返回状态/摘要，不能返回原正文。
- 超时或连接中断可能无法判断远端是否已经产生副作用；本批不自动重试这类调用。
- `secret://` 仍依赖后续生产 Secret Store Resolver。
- Tool Key 是确定性 64 位十六进制身份，不作为密码学凭证或授权凭据。
- 真实 ProjectSourceAdapter 读取 MCP 仍属后续 M13 批次。
- Provider 与 Call/Receipt 表会持续增长，需要后续观测索引、租约频率和保留策略。
