# dsh-pluginmax 增量升级 M13c Agent Runtime MCP Tool Request Bridge 实施记录

> 阶段：M13c Agent Runtime MCP Tool Request Bridge
> 日期：2026-11-21
> 前置基线：M13b MCP Tool 调用与执行授权，Migration 50
> Migration：51
> 目标方案：`docs/v2-dsh-pluginmax-upgrade-delta-architecture-and-migration-plan.md`

## 1. 完成范围

M13c 把结构化 Agent Runtime Tool Request 自动桥接到 M13b 的 Worker-only
`tools/call` 执行端口。浏览器仍然没有 Tool Request 提交或 MCP 直连能力。

本批包含：

- 服务端 Runtime Tool Request / Tool Result 协议。
- Run、Attempt、Task、Ticket、Gate、Policy Revision、Execution Envelope
  联合绑定。
- Worker Runtime 内存结果交付与持久层脱敏状态。
- 并发请求、乱序完成、重复请求和幂等重放。
- 取消、超时、Worker 租约丢失、Run 终止和远端错误分类。
- append-only Runtime Request Receipt。
- `mcp.runtime_tool_bridge=off` 默认关闭。
- Run 页最小只读 Runtime Tool Request 状态。

本批明确未实现：

- 浏览器 Runtime Tool Request 提交 API。
- 浏览器 MCP 直连或公共 Tool invoke API。
- 对可能有副作用的远端调用自动重试。
- 原始 Tool 参数和结果正文持久化。
- 真实 ProjectSourceAdapter 和 `secret://` 生产 Resolver。
- ProjectMember、RoleGrant、WorkspaceGrant 或通用权限体系扩展。

## 2. Migration 51

文件：

- `packages/database/src/schema.ts`
- `packages/database/src/migrate.ts`

### 2.1 Flag

```text
mcp.runtime_tool_bridge=off
```

Runtime Request 同时要求：

```text
mcp.provider_control_plane=on
mcp.tool_invocation=on
mcp.runtime_tool_bridge=on
```

任一 Flag 关闭时：

- 不创建 Runtime Request。
- 不创建 Receipt 或 Provider Audit。
- 不创建 MCP Tool Call。
- 不访问 Provider。

### 2.2 新增表

`runtime_tool_requests`：

```text
request_id
run_id
run_attempt
task_id
project_id
agent_id
agent_principal_id
tool_key
ticket_id
gate_id
policy_id
policy_revision
envelope_id
envelope_digest
call_id
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

`runtime_tool_request_receipts`，append-only：

```text
id
request_id
seq
status
request_digest
input_summary
output_summary
output_digest
error_category
error_code
error_message
created_at
```

### 2.3 Enforce

- 同一 Run 的 `idempotency_key` 唯一。
- 同一 Gate 只能被一个 Runtime Request 或 Tool 调用消费。
- Runtime Request 身份字段不可修改。
- Running 只能进入终态，终态不可更新或删除。
- Run、Attempt、Task、Project、Agent、Envelope 必须匹配实际 Run。
- Request Receipt 只能 INSERT，UPDATE/DELETE 由 Trigger 拒绝。
- Running 和终态 Receipt 由数据库状态迁移自动追加。

## 3. 协议

文件：

- `packages/contracts/src/runtime-tool-bridge.ts`
- `packages/agent-runtime/src/index.ts`

Runtime 只能提交意图：

```text
requestId
toolKey
gateId
idempotencyKey
arguments
timeoutMs?
```

Runtime 不能提交可信的：

```text
runId
runAttempt
taskId
ticketId
policyId
policyRevision
envelopeId
envelopeDigest
```

这些字段由 `RunExecutor` 当前执行上下文和数据库事实注入。契约使用 strict
Schema，模型或 Runtime 自带这些字段时直接拒绝。

Tool Result 通过 `requestMcpTool()` 的内存回调返回给当前 Runtime。持久记录
只包含状态、摘要、摘要值和错误分类。跨进程或幂等重放只返回状态，不重新调用
Provider，也不能恢复已经丢弃的结果正文。

Adapter 必须显式声明：

```text
mcpToolRequestProtocol = "structured-v1"
```

只有声明该能力的 Adapter 才会收到 `requestMcpTool()`，并允许发出内部
`tool.request` 事件。事件携带一次性内存 `complete(result)` 回调，RunExecutor
在收到事件后调用 Worker Bridge，再把 Tool Result 只在内存中回填给 Adapter。
事件、参数和结果正文不会写入 Run Event、日志或普通 API。

现有 DSH SDK、Codex JSONL 和 PlainText Adapter 明确声明为 `none`，因为它们
当前只上报已发生的 Tool 事件，不能安全地在执行前接管 Tool Request。

## 4. 数据流

```text
Runtime adapter
  -> requestMcpTool(intent)
  -> RunExecutor injects Run/Attempt + AbortSignal + lease assertion
  -> RuntimeToolRequestBridge
       checks three flags
       loads Run, Ticket, Gate, Policy Revision and Envelope
       computes request digest and redacted input summary
       atomically claims request idempotency and Gate
  -> McpToolCallService.execute()
       runs the complete M13b authorization chain
       calls Provider only after all checks pass
  -> ephemeral result returned to Runtime
  -> redacted terminal state and append-only receipt persisted
```

关键边界：

- `McpToolCallService.invoke()` 原协议不变。
- 新增 Worker-only `execute()` 同时返回脱敏 Call 状态和当前内存 Tool Result。
- 浏览器只读 `runtime_tool_requests`，不接触 Tool Result。

## 5. 状态机

```text
running -> succeeded
        -> failed
        -> timed_out
        -> cancelled
        -> interrupted
```

- `succeeded`：Provider 返回有效 Tool Result。
- `failed`：认证、授权、HTTP、协议、Schema、Tool 或未知错误。
- `timed_out`：Tool 或 Run 超时。
- `cancelled`：调用方 Abort 或 Run 取消。
- `interrupted`：Worker 租约丢失、Run 异常终止或过期对账。

Run 取消、超时和失败会在 Run 状态事务内收敛所有 Running Request。Worker
Sweep 只关闭 Run 已终止或租约过期的记录，不访问远端 Provider。

## 6. 并发与幂等

并发控制使用三层事实：

1. `request_id` 和 `run_id + idempotency_key` 数据库唯一约束。
2. PostgreSQL advisory transaction lock。
3. 同 Worker 内 in-flight Promise 复用。

行为：

- 相同 requestId、幂等键、参数和绑定：终态重放，不二次调用。
- 相同幂等键不同参数：`runtime_tool_idempotency_conflict`。
- 相同 Gate 的第二个请求：`runtime_tool_gate_already_used`。
- 不同请求可以并行，完成顺序不影响各自终态。
- 跨 Worker 的进行中重复不会再次访问 Provider。

## 7. 授权接入

Runtime Request 不增加授权来源，只会继续使用：

1. Running Run 且 Attempt 匹配。
2. Task-backed Run 具备 Execution Envelope。
3. Action Ticket 绑定 Run、Envelope、Policy Revision 和 `mcp.invoke` Scope。
4. Execution Gate 为 blocking、approved、未过期且绑定当前 Envelope。
5. TaskExecutionPolicy allow 且 requireApproval `mcp.invoke`。
6. Policy allow `connector-data`，且未 deny。
7. M13b Provider 当前版本、健康、Tool Key 和预算检查。

Market Binding、Provider Owner、Platform Admin 均不能替代任一项。

## 8. 权限矩阵

| 操作 | Runtime Worker | 浏览器/普通 API | Provider Owner | Platform Admin | Market Binding |
| --- | --- | --- | --- | --- | --- |
| 提交 Runtime Tool Request | 仅当前 Run Worker 内部端口 | 禁止，404 | 不自动允许 | 不自动允许 | 不自动允许 |
| 执行 Provider Tool | 通过完整 M13b 授权链 | 禁止 | 不自动允许 | 不自动允许 | 不自动允许 |
| 读取 Run Request 状态 | 内部使用 | 按 Run 访问控制只读 | 跟随 Run 权限 | 跟随 Run 权限 | 不产生读取权 |
| Sweep 过期 Request | 允许，无远端副作用 | 不新增用户 API | 禁止 | 不新增旁路 | 禁止 |

没有新增 ProjectMember、RoleGrant、WorkspaceGrant 或 PlatformPermission。

## 9. API 与 Web

新增：

```text
GET /api/v1/runs/:runId/runtime-tool-requests
GET  /api/v1/admin/runtime-tool-requests/summary
POST /api/v1/admin/runtime-tool-requests/reconcile
GET  /api/v1/admin/runtime-tool-requests/retention
```

不新增：

```text
POST /runs/:runId/runtime-tool-requests
POST /runtime-tool-requests
POST /mcp-providers/:id/tools/:toolKey/invoke
```

Run 页新增最小只读区域：

- Tool Key 短摘要。
- Request 状态。
- Run Attempt。
- Policy Revision。
- 参数数量和字节摘要。
- 错误分类和错误码。
- Request 短 ID。

页面不展示参数正文、结果正文、Endpoint、Credential Ref 或请求头。

Admin 汇总只返回状态计数、过期 Running 数、最老 Running 年龄和错误分类。
Admin Reconcile 只关闭 Run 已终止或租约过期的 Request，不访问 Provider，
也不重放远端调用。

告警阈值：

- 任一 Stale Running：`critical`。
- 最老 Running `>= 300s`：`warning`。
- 最老 Running `>= 900s`：`critical`。
- 记录数 `>= 10` 且错误率 `>= 25%`：`warning`。
- 记录数 `>= 10` 且错误率 `>= 50%`：`critical`。

Retention API 仅执行 Dry Run，返回超过保留期的 Request/Receipt 数量。由于
Receipt 是 append-only，本阶段不提供物理删除；正式策略必须先归档，再按分区
或受控维护任务清理。

启用 Bridge Flag 后，`/api/v1/metrics` 额外输出：

```text
pluginmax_runtime_tool_requests{status=...}
pluginmax_runtime_tool_requests_stale
pluginmax_runtime_tool_request_oldest_running_seconds
pluginmax_runtime_tool_request_errors{category=...}
pluginmax_runtime_tool_request_alert_level
```

## 10. M13a / M13b / M12 兼容

- M13a Provider、Probe、Tool 发现和审计 API 不变。
- M13b `invoke()`、Tool Call Receipt、Gate 单次消费和 Read API 不变。
- M13b 执行面继续是唯一 Provider `tools/call` 端口。
- M12 Market Binding 仍只引用 Provider 身份，不复制连接或执行授权。
- 旧 Run、旧 Tool Event 和旧 `tool.call/tool.result` 读取不变。
- 新表为 additive，不修改 Migration 45-50 已验收业务语义。

## 11. 验证

### 11.1 Migration 51 隔离

```text
./scripts/m13c-runtime-tool-migration-vitest.sh

m13c_migration_vitest=ok
fresh_migration=0->51
idempotent_migration=51->51
upgrade_migration=49->51,50->51
flag=mcp.runtime_tool_bridge=off
tables=2
triggers=7
```

### 11.2 M13c PostgreSQL 集成

```text
./scripts/m13c-runtime-tool-vitest.sh

Test Files  4 passed
Tests       20 passed
```

覆盖：

- 浏览器没有 Runtime Tool Request 提交路由。
- 缺 Ticket、Gate 或 Policy Revision 拒绝。
- Market Binding、Provider Owner、Platform Admin 不自动授权。
- 并发请求、乱序完成和重复请求。
- 幂等重放不重复调用 Provider。
- Run 取消后 Request 收敛且不增加 Provider 调用。
- Tool 取消、超时、未知错误和 Worker 租约丢失。
- Feature Flag 关闭不写 Request、Receipt、Call、Audit 或远端副作用。
- Runtime Receipt、M13b Receipt 和 Provider Audit append-only。
- 同一 Run/Provider 的并发事件与审计序号由事务级 advisory lock 串行分配。
- 输入/输出 Secret、Credential 和 Credential Ref 不出现在持久状态或日志。
- 旧 Run Event 和 Tool Event 读取兼容。
- Platform Admin 才能读取 Runtime Request 汇总和执行无远端副作用对账。
- Runtime Adapter 声明 `structured-v1` 后，可通过 RunExecutor 全链路消费 Bridge 结果。
- 12 个独立 Run 的并发突发请求全部收敛。
- 告警级别、Prometheus Alert Gauge 和 Retention Dry Run 正常。

### 11.3 Web E2E

```text
./scripts/m13c-runtime-tool-e2e.sh

1 passed
```

覆盖：

- Run 页显示 Runtime Tool Request 脱敏状态。
- 浏览器直接 POST Runtime Tool Request 返回 404。
- 输入/输出 Secret 不出现在页面。
- `1440x960`、`900x900`、`390x844` 无横向溢出。

截图：

- `.tmp/m13c-runtime-tool-1440.png`
- `.tmp/m13c-runtime-tool-900.png`
- `.tmp/m13c-runtime-tool-390.png`

## 12. 未完成项与剩余风险

- Runtime Adapter 必须显式调用 `requestMcpTool()`；尚未把任意第三方 Runtime
  的私有 Tool 协议自动翻译成该端口。
- 原始 Tool Result 只在当前 Worker 内存中存在。进程崩溃或跨 Worker 重放只能
  得到终态摘要。
- 远端成功但本地 Request 完成前租约丢失时，Runtime Request 会收敛为
  `interrupted`；平台不会自动重试可能有副作用的远端调用。
- `secret://` 仍依赖后续生产 Secret Store Resolver。
- Runtime Request 和 Receipt 会持续增长，需要后续保留策略和观测索引。
- 真实 ProjectSourceAdapter 读取 MCP 仍属后续 M13 批次。
