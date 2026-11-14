# dsh-pluginmax 升级迁移 M0 + M1a 实施记录

> 阶段：M0 契约冻结、M1a 执行可信基础
> 日期：2026-11-13
> 仓库：`pluginmax-platform`
> 实施前基线：`main@5b7f7f5bc179ca0435c96126a950e7b3605847f4`
> 只读备份：`/Users/oliviayang/Codex/backups/dsh-migration-preflight-20261113-105957`

## 1. 迁移前保护记录

### 1.1 备份校验

在只读备份目录执行：

```sh
LC_ALL=C LANG=C shasum -a 256 -c SHA256SUMS
```

结果：`SHA256SUMS` 中全部 36 个校验项均为 `OK`。本轮未修改、解冻、重写或删除备份目录。

### 1.2 Git 基线

```text
branch: main
HEAD:   5b7f7f5bc179ca0435c96126a950e7b3605847f4
```

开始实施时工作区已有 43 个已跟踪文件修改和 41 个未跟踪文件，包含 Shared Space、Human Avatar Delegation、Identity Hardening 等用户改动。本轮不执行 `git reset --hard`、`git checkout --`、未跟踪文件清理或任何回退用户改动的命令。

## 2. 当前事实源

### 2.1 Contracts

| 事实 | 当前落点 |
| --- | --- |
| TaskStatus | `packages/contracts/src/platform.ts` 的 `taskStatusSchema`，固定为 queued / in_progress / review / paused / blocked / needs_input / done / cancelled |
| Task acceptance | `taskSchema.acceptance` 和 `createTaskInputSchema.acceptance`，当前为字符串数组 |
| autoSubmit / autoAccept | `taskSchema`、创建/更新输入和数据库中现有布尔列 |
| Review 输入 | `packages/contracts/src/collaboration.ts` 的 `taskReviewInputSchema` |
| Action Ticket / Gate | `packages/contracts/src/action-ticket.ts` |
| Run / Event | `packages/contracts/src/platform.ts` |
| Task Execution Policy | `packages/contracts/src/task-execution.ts` |

### 2.2 Database

| 事实 | 当前落点 |
| --- | --- |
| Migration 机制 | `packages/database/src/migrate.ts` 中的有序 SQL 数组，不是独立 migration 目录 |
| 当前最高版本 | 34（Human Avatar Delegation）；33 为 Shared Space |
| Task | `tasks` 表，现有 `acceptance JSONB`、`auto_submit`、`auto_accept` |
| Run | `runs` 表，现有 `task_execution_kind`、`attempt`、`status`、`output` |
| Review | `task_reviews`，当前只追加 decision |
| 审计 | `identity_audit_events`，append-only |
| 授权 | `principals`、`role_grants`、`project_members`、`project_member_roles` |
| Runtime | `agent_runtime_bindings`、`external_runtimes`、Run 上的不可变 execution snapshot |

### 2.3 Application

| 调用链 | 当前行为 |
| --- | --- |
| 创建任务 | `PlatformApplication.createTask` -> `TaskRepository.create` -> `tasks` |
| 更新任务 | `PlatformApplication.updateTask` -> `TaskRepository.update` |
| 派发任务 | API `/tasks/:id/dispatch` -> `PlatformApplication.dispatchTask` -> 依赖/Agent/Runtime 检查 -> `TaskExecutionPreflightService.prepare` -> `RunRepository.enqueue` |
| Run 完成 | Worker `RunExecutor.completeRun` -> `runs.finish(completed)` -> 按 autoSubmit/autoAccept 改变 TaskStatus |
| 人工提交 | `PlatformApplication.submitTask` -> 只检查 completed owner Run -> `in_progress -> review` |
| Review | API `/tasks/:id/review` -> `PlatformApplication.reviewTask` -> `task_reviews` -> done 或 queued |

仓库事实与方案假设有两处需要修正：

1. Migration 不是独立目录，本轮必须在既有 SQL 数组中顺延 35。
2. 当前 `autoAccept=true` 在 Run 完成路径中确实直接写 approve、done 和 memory，且调用者固定为 `system:auto-accept`。M1a 必须在 enforce 模式阻止该旁路。

### 2.4 API / Worker

| 层 | 当前落点 |
| --- | --- |
| API | `apps/api/src/app.ts`，Task、Run、Gate 路由集中在单文件 |
| Worker | `apps/worker/src/worker-runtime.ts` -> `RunExecutor` |
| 身份 | API Bearer Session 或 local-development actor；Run 使用 Execution Envelope Principal |
| 权限门禁 | `AuthorizationService` preHandler + Application `requireActiveProjectPermission` |

## 3. M0 冻结结论

### 3.1 判定表

| 能力 | 判定 | 本轮处理 |
| --- | --- | --- |
| 分层 ExecutionDecision | ADOPT | 实现 Authorization / DispatchEligibility / ActionDecision |
| Task anomaly 维度 | ADOPT | 独立活动异常表，不新增 TaskStatus |
| 结构化验收 item / confirmation | ADOPT | 稳定 item、revision、contentDigest、typed evidenceRefs |
| autoSubmit / autoAccept 兼容 | ADAPT | observe 保留旧行为；enforce 以证据和人工 Review 为准 |
| Agent 自批保护 | ADOPT | 独立安全校验，不依赖 Feature Flag |
| M1a Task Tool Facade | DEFER 到 M1b | 本轮只提供受控 API，不开放任意 Tool |
| 工作区文件工具 | DEFER 到 M1b | 非本轮范围 |
| Workflow scope / Router / M2-M8 | DEFER | 非本轮范围 |
| DSH JSON Storage / Slot / 插件运行时 | NON_TARGET | 不迁移 |

### 3.2 核心契约

新增 `execution-decision` Contract：

```ts
type ExecutionDecision = {
  projectId: string;
  principalId: string;
  authorization: {
    allowed: boolean;
    permission: "read" | "write" | "approve" | "manage_members" | "manage_roles";
    grantIds: string[];
    membershipId?: string;
    reasons: DecisionReason[];
  };
  dispatchEligibility: {
    allowed: boolean;
    runtimeRevision?: number;
    policyRevision?: number;
    bindingRevision?: number;
    reasons: DecisionReason[];
  };
  actionDecision?: {
    allowed: boolean;
    action: string;
    resourceId: string;
    runId: string;
    ticketId?: string;
    gateId?: string;
    reasons: DecisionReason[];
  };
  decidedAt: string;
  cacheable: false;
};
```

新增 acceptance Contract：

- `TaskAcceptanceItem`
- `TaskAcceptanceConfirmation`
- `AcceptanceEvidenceRef`
- 证据类型固定为 `artifact | tool-event | run-output | external-resource`

新增 anomaly / health Contract：

- `TaskExecutionAnomaly`
- `TaskExecutionHealth = healthy | attention | anomaly`
- `TaskExecutionHealthProjection`

### 3.3 错误码

| 错误码 | 语义 |
| --- | --- |
| `execution_authorization_denied` | 当前 Principal 的项目授权已失效 |
| `execution_dispatch_ineligible` | Runtime、Agent、policy 或 binding 不允许派发 |
| `execution_runtime_unavailable` | Runtime 能力或绑定在预检后降级 |
| `execution_action_resource_mismatch` | A 资源 Ticket 被用于 B 资源 |
| `acceptance_item_not_current` | acceptance item 不存在或不是当前 revision |
| `acceptance_evidence_invalid` | evidence 不属于当前 task / owner Run |
| `acceptance_evidence_stale_run` | 使用了旧 Run、失败 Run 或 collaborator Run |
| `acceptance_evidence_incomplete` | required 验收项没有完整有效确认 |
| `acceptance_reviewer_conflict` | 执行确认主体不能同时做独立批准 |
| `agent_self_approval_denied` | Agent 尝试批准自己的任务 |
| `feature_mode_mismatch` | 当前 Flag 模式不允许该写操作 |

## 4. M1a 精确变更清单

### 4.1 Migration 35 + 36

新增表：

- `feature_flag_settings`
- `task_acceptance_items`
- `task_acceptance_item_revisions`
- `task_acceptance_confirmations`
- `task_execution_anomalies`

关键约束：

- acceptance item 当前身份：`UNIQUE(task_id, position) WHERE deprecated_at IS NULL`
- acceptance revision：`UNIQUE(acceptance_item_id, revision)`
- 当前 confirmation：`UNIQUE(acceptance_item_id, run_id) WHERE superseded_at IS NULL`
- 活动 anomaly：`UNIQUE(task_id, COALESCE(run_id, zero_uuid), code) WHERE status='active'`
- feature flag scope：`(flag_key, scope_type, scope_id)` 唯一

Migration 35 为 expand，Migration 36 为 backfill / validate：

1. Expand：创建新表、索引和默认 Flag。
2. Backfill：将现有 `tasks.acceptance` 按数组顺序写入 item current + revision 1，全部 `required=true`。
3. Validate：校验 item 数量与原 acceptance 数量一致。
4. Enable：代码默认仍为 observe / off。

实际顺序：

1. `35`：创建 Flag、acceptance item/revision/confirmation、anomaly 表和约束。
2. `36`：从现有 `tasks.acceptance` 回填 item 与 revision 1，并校验每个任务 item 数量与 JSON 数组长度一致。
3. Feature 默认仍为 `task.evidence_review=observe`、`task.anomaly=off`，不自动切换 enforce。

兼容：

- 不改 `tasks`、`task_reviews` 或 TaskStatus 约束。
- API 继续返回原 `string[]`。
- 新表不要求旧应用读取。
- 旧应用仍可读写原任务字段；新应用将规范化表作为 evidence 事实源。

### 4.2 Feature Flag

| Flag | 默认 | Scope | 关闭/observe 行为 |
| --- | --- | --- | --- |
| `task.evidence_review` | observe | Platform，可项目覆盖 | observe 只计算差异，不写 confirmation、不改 Task 状态；off 走旧链路 |
| `task.anomaly` | off | Project | off 不创建新 anomaly；已有 anomaly 保留 |

Flag 每次判定从数据库读取，不做进程内长期缓存。enforce 写路径在落确认和 Review 前重新读取。

### 4.3 Application

新增：

- `ExecutionDecisionService`
- `FeatureFlagService`
- `TaskAcceptanceService`
- `TaskAnomalyService`

接入点：

- `createTask` / `updateTask`：同步 acceptance item；内容或 required 变化时 supersede 旧 confirmation。
- `dispatchTaskExecution`：派发前重新计算 Authorization + DispatchEligibility。
- `ExecutionGateService`：增加按 action + resourceId 的单次判定包装，禁止 Ticket 跨资源复用。
- `submitTask`：enforce 下校验当前 owner Run 和全部 required confirmation。
- `reviewTask`：deny Agent 自批；enforce 下拒绝同一主体执行确认后自批。
- `RunExecutor.completeRun`：由 acceptance 服务决定 autoSubmit / autoAccept 行为。

### 4.4 API

新增只读/受控路由：

- `GET /api/v1/tasks/:id/acceptance-evidence`
- `POST /api/v1/tasks/:id/acceptance-evidence/confirmations`
- `GET /api/v1/tasks/:id/execution-health`

### 4.5 事件

新增 Run Event 类型：

- `task.evidence_shadow_evaluated`
- `task.acceptance_confirmed`
- `task.anomaly.detected`
- `task.anomaly.cleared`

审计继续使用 append-only `identity_audit_events`。

## 5. 必须覆盖的负向用例

| 编号 | 场景 | 预期 |
| --- | --- | --- |
| G1 | 预检后撤权，派发前撤 Grant | 拒绝派发，reason 为授权失效，不创建 Run |
| G2 | 预检后 Runtime 降级 | 拒绝派发，不创建 Run，返回可解释安全停点 |
| G3 | A 资源 Ticket 用于 B 资源 | 拒绝，action decision 绑定 resourceId |
| G4 | 多个 required item 只确认一部分 | 不进入 review，记录 missing acceptance |
| G5 | 旧 Run、失败 Run、collaborator Run 或旧 revision 证据 | 拒绝，不覆盖历史 |
| G6 | Agent 执行确认后批准自己任务 | 最终 approve 拒绝并写审计 |
| G7 | autoSubmit=true 且证据不完整 | enforce 下保持 in_progress，记录 anomaly |
| G8 | autoAccept=true 且证据不完整或不独立 | 不允许 done |
| G12 | 空库、34 快照升级、旧应用读取 | 均成功，冲突预检可执行 |

## 6. 非目标

本轮不实施：

- M1b Task Tool Facade 和工作区文件读写工具。
- M2 Workflow scope、role slot、instance binding。
- M3 Router Plan、materialization ledger、Reconciler。
- M4-M8。
- 新 TaskStatus `abnormal`。
- 第二套 Router、Skill、Data Agent 或 Workbench 存储。
- 修改外部 `dsh-pluginmax` 仓库。

## 7. 实施后需回答

1. G1-G8 已由 `apps/api/src/task-execution-evidence.test.ts` 覆盖并全部通过；最终聚焦集为 7/7，同时覆盖异常 occurrence、Run 范围清理和 acceptance 投影自动修复。
2. G12 已由 `scripts/m1a-migration-vitest.sh` 覆盖：空库 0 -> 36、34 快照 -> 36、旧字段读取和旧 Review 写入均通过。
3. Feature Flag 默认值为 `observe` / `off`；enforce 的证据、异常和自批门禁均通过负向测试。
4. 用户已有未提交改动未回退；本轮只做增量编辑。
5. 全仓类型检查、lint、build 通过。最后一次全仓 Vitest 为 72/73 个文件、339/340 个用例通过，唯一失败是既有 Teammates 周报日期夹具；此后新增的 M1a 投影修复测试已单独通过。

### 7.1 已知 M1a 边界

- `external-resource` evidence 在没有独立归属登记表的 M1a 中保守拒绝，不允许自由字符串绕过。
- M1a 当前通过受控 API 提交确认，尚未开放 Agent Tool Facade；该部分属于 M1b。
- `task.evidence_review=observe` 保留旧 autoSubmit/autoAccept 行为并与新判定做影子比较；enforce 才改变 Task 状态。
- 进入 M1b 前应先观察 observe 差异、补齐 Tool 身份反查和工具事件证据。
