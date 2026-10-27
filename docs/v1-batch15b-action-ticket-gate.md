# V1 Batch 15B：Action Ticket 与 Execution Gate

> 状态：Batch 15B 已完成。Batch 16 Scene Context、Shared Space 与 sandbox
> 仍未实现，也不在本批冒充完成。

## 1. 基线

- 基线 worktree：`.tmp/pluginmax-platform-batch15a-task-execution-policy`
- 基线分支：`feat/v1-batch15a-task-execution-policy`
- 基线 HEAD：`7a2643ec78ceca768ec25893e353f77c62aa1ed0`
- 工作 worktree：`.tmp/pluginmax-platform-batch15b-action-ticket-gate`
- 工作分支：`feat/v1-batch15b-action-ticket-gate`
- 独立数据库：`127.0.0.1:54427`

开始前确认基线 worktree、分支、HEAD 和干净 status；工作区未读取正式数据库、
正式 Session/Profile、原始 `dsh-pluginmax` 或历史业务数据。

## 2. 持久化模型

Migration 26 为 additive migration，新增：

- `action_tickets`
  - `ticketId`、`ticketVersion`
  - `principalId`、`workspaceId`
  - `contextType` / `contextId`
  - `taskId` / `runId`
  - `allowedActions` / `deniedActions`
  - `resourceScopes`
  - `policyId` / `policyRevision`
  - `envelopeId` / `envelopeDigest`
  - 完整 Run Execution Envelope 与授权快照
  - `issuedAt` / `expiresAt` / `issuedBy`
- `execution_gate_requests`
  - Gate 类型、blocking/non-blocking enforcement、原因、资源 Scope
  - policy revision 与 envelope digest 绑定
- `execution_gate_decisions`
  - approve / reject / timeout / cancel
  - 决策人、依据、决策时间
  - policy revision 与 envelope digest 绑定
- `action_ticket_usages`
  - Runtime execute 和业务 writeback 的幂等 receipt
  - 唯一键为 Ticket、Action、idempotency key

Ticket、Gate request、Gate decision 均禁止更新和删除；usage receipt 的
identity 与 terminal 状态不可变。

### Migration 与回滚

- fresh：`0 -> 26` 通过。
- upgrade：`25 -> 26` 通过，既有 project/task/Run 内容不变。
- backfill：不自动为历史 Run 伪造 Ticket。历史 queued Run 在新 Worker 中因缺少
  Ticket fail closed，需要按当前 Principal/Project Grant 重新派发。
- rollback：删除 `action_ticket_usages`、`execution_gate_decisions`、
  `execution_gate_requests`、`action_tickets` 及对应 trigger function/index。
  Migration 26 不修改既有业务列，因此回滚不会回写或删除 Run 快照。

## 3. Ticket 签发

Preflight 在生成 Run Execution Envelope 前生成 `ticketId`，并将它写入
Envelope 的 `executionEnvelope.ticketId`。Ticket 完整保存同一 Envelope 和
digest，因此后续策略、Grant、Runtime 或上下文变化不能扩展现有 Ticket。

四类入口在各自 Run 创建事务内签发 Ticket：

- Task：`task.writeback`
- Workflow Task：`workflow.writeback`
- Meeting AI：`meeting.writeback`
- Direct Chat：`direct-chat.writeback`

每个 Ticket 同时允许 `agent.execute`。Direct Chat 的 Ticket `taskId` 绑定
`turnId`，不是 `threadId`。

## 4. Execution Gate

Policy 的 `toolPolicy.requireApproval` 和 `humanGates` 会生成持久化 Gate。
`humanGates[].enforcement` 支持 `blocking` / `non-blocking`，默认 blocking。

- blocking + pending：Run 为 `waiting_approval`，Job 不进入 claim。
- blocking + approve：最后一个未决定 blocking Gate 通过后，Run/Job 恢复排队。
- blocking + reject：Run 为 `cancelled`，Job 取消，不派发 Runtime。
- blocking + cancel：插入不可变 cancel decision，并取消 Run。
- blocking + timeout：插入不可变 timeout decision，Run 为 `timeout`。
- non-blocking：pending 不阻止 Run；一旦明确 reject/cancel，deny-wins 仍会停止
  Run。

Gate 决策同时绑定请求时的 policy revision、Envelope ID 和 digest。决策人、
依据和时间只能写入一次。

## 5. 授权与 Worker 门禁

Ticket/Gate 决策默认拒绝，deny-wins。Worker 在 Runtime effect 启动前复核：

1. Ticket 存在且未过期，Principal 与 Account 仍 active。
2. Ticket 的 Principal、Workspace、Context、Task/Turn、Run 与 Envelope 一致。
3. Run Envelope digest 可复算，Ticket 中 Envelope 快照与 Run 快照完全相同。
4. policy ID/revision 与 Run 快照一致，历史 revision 仍可读取。
5. Project 执行复核只使用 Project Grant `write`；Platform ADMIN 不绕过
   Project Grant，Workspace Grant 不映射为 Project Grant。
6. Direct Chat 只允许 Thread owner 的 self scope。
7. blocking Gate 必须有有效 approved decision。
8. Runtime Binding/Capability revision 继续由 15A Worker 复核。

无 Ticket、Ticket 过期、上下文不匹配、Principal 停用、Gate pending/denied/
timeout/cancel 时不进入 Runtime Adapter。

## 6. 幂等与恢复

Runtime execute 与业务 writeback 分别占用 Ticket action usage：

- 首次 execute：`claimed`。
- 同一 execute 未结束再次调用：`in_progress`，Job 不再启动第二次副作用。
- 已完成 execute：`replay`。
- writeback 允许同一 receipt 在已占用后继续做幂等回写。

Runtime effect 仍保留既有单次消费约束。已启动 External Runtime 的自动重试继续
禁止；Ticket usage 提供第二道边界。Meeting AI 和 Direct Chat 的写回依赖既有
唯一约束，重复恢复不会重复发言或回复。

## 7. API

```text
GET  /api/v1/runs/:runId/action-ticket
GET  /api/v1/runs/:runId/execution-gates
POST /api/v1/execution-gates/:gateId/decisions
POST /api/v1/execution-gates/:gateId/cancel
```

Gate 决策要求 active Project `approve`；Gate cancel 要求 Project `write`。
Direct Chat 只允许 Ticket Principal/Thread owner 决策。

Web Run 视图展示 Ticket policy revision、Envelope 短 ID、Gate 类型、
enforcement、过期时间与不可变决策，并支持批准、拒绝和取消。

## 8. 验证结果

- Migration：fresh `0 -> 26`、upgrade `25 -> 26` 通过；历史 Run 内容保持，
  Migration 26 回填 Ticket 数为 `0`。
- 15B 定向 Vitest：7 files / 35 tests 通过。
- 完整 Vitest（fresh DB）：49 files / 236 tests 通过。
- Playwright：blocking Gate 等待、UI 批准、Worker 恢复并完成；覆盖 1440px、
  900px、390px，均无水平溢出。
- `pnpm run typecheck`、`pnpm run lint` 和 `git diff --check` 通过。
- API/Worker/Web production build 通过。

已知非阻断告警：

- Web production bundle 单 chunk 超过 500 kB。
- `tsdown` 的 `external` deprecation 与 API/Worker d.ts sourcemap 告警。

## 9. 本批边界

未实现：

- Batch 16 Scene Context / Scene Session
- Shared Space、路径级 Grant、Locks、Global Write
- sandbox 扩展
- Provider Session resume
- Runtime 级 `maxTurns` / `maxToolCalls` / `maxCost` 的细粒度执行

本批没有修改 Batch 16 的完成状态。
