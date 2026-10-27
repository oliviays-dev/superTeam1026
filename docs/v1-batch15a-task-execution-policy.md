# V1 Batch 14C 写授权审计与 Batch 15A: TaskExecutionPolicy

> 状态：Batch 14C 写授权残余审计完成；Batch 15A 持久化策略、统一 Preflight
> 与 Run Execution Envelope 已完成。Batch 15B 已在其独立批次完成 Action
> Ticket / Execution Gate，详见
> [v1-batch15b-action-ticket-gate.md](./v1-batch15b-action-ticket-gate.md)。

## 1. 基线

- 基线 worktree：`.tmp/pluginmax-platform-batch14d-read-authorization`
- 基线分支：`feat/v1-batch14d-read-authorization`
- 基线 HEAD：`8b62d6a7a5c1e56f9496fd8890af602a0a4ee19e`
- 工作 worktree：`.tmp/pluginmax-platform-batch15a-task-execution-policy`
- 工作分支：`feat/v1-batch15a-task-execution-policy`

## 2. Batch 14C 写授权残余审计

审计以 `AuthorizationService.authorizeRoute` 的 14C 权限映射为准，删除
Application 层 legacy owner 二次门禁和平台管理员隐式捷径。

| 写路径 | 14C 必需权限 | 修正前 | 修正后 |
| --- | --- | --- | --- |
| Task attachment upload / archive | `write` | owner-only | active Project `write` |
| Memory topic / claim create / update | `write` | owner-only | active Project `write` |
| Memory review / truth publish | `approve` | owner-only | active Project `approve` |
| Meeting Minutes ingest | `approve` | owner-only | active Project `approve` |
| Handoff create / update | `write` | owner-only | active Project `write` |
| Handoff confirm | `approve` | owner-only | active Project `approve` |
| Meeting create / message / AI policy / AI trigger / Action Item | `write` | owner-only | active Project `write` |
| Project report generate | `approve` | legacy owner | active Project `approve` |
| Supply exception / supplier risk create | `write` | legacy owner | active Project `write` |
| Agent episode create | `write` | owner or target agent | active Project `write` |
| Task transfer | `manage_members` | platform administrator only | active Project `manage_members` |
| Workflow pause / resume / retry / system node | `write` | legacy owner | active Project `write` |
| Workflow co-sign approvers | `approve` | owner or pending approver | active Project `approve` + pending approver |

保持不变的边界：

1. Platform `ADMIN` 不产生 Project Grant，也不绕过 Project membership。
2. Workspace Grant 不映射为 Project Grant；Project Grant 也不映射为 Workspace Grant。
3. archived Project 的写操作返回 `409 project_archived`。
4. Project owner 仍是显式 `PROJECT_OWNER` Grant 或 Migration 24 兼容来源，
   不再是所有写路径的统一硬编码前提。

## 3. 持久化模型

Migration 25 新增：

- `task_execution_policies`
  - `context_type`: `project` / `task` / `meeting` / `direct-chat`
  - `context_id`
  - `project_id`
  - `revision`
  - `policy` JSONB
  - `created_by` / `created_at`
  - 每个 `(context_type, context_id, revision)` 唯一
- Database trigger 禁止更新或删除策略 revision。
- `runs` 新增：
  - `execution_context_type`
  - `execution_context_id`
  - `execution_policy_id`
  - `execution_policy_revision`
  - `execution_binding_revision`
  - `execution_runtime_revision`
  - `execution_envelope_snapshot` JSONB
- Database trigger 禁止修改已写入的 Run execution envelope 和关联 revision 列。

策略更新使用 `expectedRevision`：

- 首次写入必须传 `0`。
- 当前 revision 与 `expectedRevision` 不一致返回 `409`
  `task_execution_policy_revision_conflict`。
- 成功更新追加新 revision，不覆盖历史行。

## 4. 策略解析

优先级：

```text
context-specific policy
  -> project default policy
  -> legacy/default policy
```

- Task 与 Workflow Task 读取 Task context；无 Task policy 时读取 Project default。
- Meeting AI 读取 Meeting context；无 Meeting policy 时读取 Project default。
- Direct Chat 读取 Direct Chat context；无配置时使用 legacy/default。
- legacy/default policy revision 为 `0`，运行快照仍完整保存。

## 5. 统一 Preflight

四类入口统一调用 `TaskExecutionPreflightService`：

```text
Principal Grant
  ∩ Project permission
  ∩ Agent Runtime Binding
  ∩ Runtime Capability
  ∩ TaskExecutionPolicy
  -> Run Execution Envelope
```

具体行为：

1. Project context 要求发起 Principal 有 active Project membership 和 `write`。
2. Direct Chat 保持既有 Principal self scope。
3. Runtime allowlist 只能排除绑定 Runtime，不能自动切换或扩大绑定。
4. Policy required Capability 必须由 Runtime Capability snapshot 满足。
5. Policy tool allowlist 与 Runtime tool categories 取交集；deny-wins。
6. Policy 请求审批或 human gate 时，在 15B 未完成前 fail closed，返回
   `execution_gate_not_available`。
7. Fake、DSH SDK 使用 synthetic builtin runtime snapshot；External Runtime 使用
   Binding、Probe、Capability 与 Runtime revision 快照。
8. `timeoutMs` 进入 Run timeout；其他预算字段保存在 envelope，等待后续 Worker
   细化消费。

## 6. Run 快照

每个新建 Run 保存：

- 策略 ID、revision、版本与完整 policy JSON
- 完整 `RunExecutionEnvelope`
- 发起 Principal 与 Project Grant 有效权限
- Binding kind / ID / revision
- Runtime ID / revision
- Capability snapshot ID 与完整 Capability profile
- 最终 `ExecutionEnvelope`
- SHA-256 digest

Worker 启动前：

1. 复核 envelope digest。
2. 按 ID + revision 读取策略历史，不允许读取最新 revision 替代快照。
3. 复核 builtin Runtime 或 external Binding / Runtime / Capability revision。
4. External Runtime 继续执行既有 Probe、Capability、command/args digest 复核。

策略后续变更只影响新 Preflight；已创建 Run 不重算策略。

## 7. API

```text
GET /api/v1/projects/:projectId/execution-policy
PUT /api/v1/projects/:projectId/execution-policy

GET /api/v1/tasks/:id/execution-policy
PUT /api/v1/tasks/:id/execution-policy

GET /api/v1/meetings/:meetingId/execution-policy
PUT /api/v1/meetings/:meetingId/execution-policy

GET /api/v1/direct-chats/:threadId/execution-policy
PUT /api/v1/direct-chats/:threadId/execution-policy

GET /api/v1/runs/:runId/execution-envelope
```

Project、Task、Meeting policy 写操作要求 Project `write`。Direct Chat policy
写操作只允许 Thread owner。Run envelope 读操作遵循 Resource Project read 或
Direct Chat self boundary。

## 8. 本批边界

15A 当时未实现、后续由 Batch 15B 完成的边界：

- Action Ticket
- Execution Gate 的真实暂停、审批、恢复和超时

Batch 15B 后仍未实现：

- Scene Context / Scene Session
- Shared Space
- sandbox 扩展
- `maxTurns` / `maxToolCalls` / `maxCost` 的 Runtime 级细粒度强制执行
- Provider Session resume

## 9. 验证入口

```text
./scripts/task-execution-policy-vitest.sh
./scripts/task-execution-policy-e2e.sh
pnpm run typecheck
pnpm run lint
pnpm run test
pnpm --filter @pluginmax/web build
git diff --check
```

## 10. 验证结果

- Migration：fresh `0 -> 25` 通过；`24 -> 25` 保留 project/task/Run 旧数据通过。
- 定向 Vitest：10 files / 59 tests 通过。
- 完整 Vitest：47 files / 230 tests 通过。
- 四入口：Task、Workflow Task、Meeting AI、Direct Chat 均生成 Execution
  Envelope；Fake、DSH SDK、External Runtime 均有策略快照。
- Run 快照：独立测试确认旧 Run 在 policy revision 更新后保持不变，Worker 使用
  原 revision 继续执行通过。
- Playwright：RBAC + Task policy 场景通过，覆盖 1440px、900px、390px 且无水平溢出。
- `pnpm run typecheck`、`pnpm run lint`、根级构建和 Web production build 通过。
- `git diff --check` 与测试脚本 `bash -n` 通过。

已知非阻断告警：

- Web production bundle 单 chunk 超过 500 kB。
- `tsdown` 的 `external` deprecation 和 API/Worker d.ts sourcemap 告警。
