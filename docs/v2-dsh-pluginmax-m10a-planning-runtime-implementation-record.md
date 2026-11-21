# dsh-pluginmax 增量升级 M10a Planning Runtime 控制面实施记录

> 阶段：M10a Planning Runtime 控制面
> 日期：2026-11-21
> 前置基线：M9 兼容底座，Migration 45
> Migration：46
> 目标方案：`docs/v2-dsh-pluginmax-upgrade-delta-architecture-and-migration-plan.md`

## 1. 完成范围

M10a 已落地 Planning Runtime 的控制面，不包含 M10b 的完整 Planner、Critic
执行、自动规划、Task Dispatch Readiness 或 Planning Review UI。

本批包含：

- Planning Policy 与 Planning Settings。
- Planning Run 状态机和 Revision CAS。
- Planning Trigger Receipt 幂等、活动 Run 合并与终态重试。
- Requirement Brief、Facts Ledger、Critic、Skill Snapshot、Knowledge Receipt
  的强类型契约和不可变 Artifact 存储。
- Append-only Planning Event。
- Planning Quality Metric 快照。
- `workflow_plans.planning_run_id` 来源证明。
- Router Plan 创建时与 Planning Run 的同一事务绑定。
- `planning.manual`、`planning.autopilot` 默认关闭。

## 2. Migration 46

文件：

- `packages/database/src/schema.ts`
- `packages/database/src/migrate.ts`

执行顺序：

1. Expand
   - `planning_policies`
   - `planning_runs`
   - `planning_trigger_receipts`
   - `planning_artifacts`
   - `planning_events`
   - `planning_quality_metrics`
   - `workflow_plans.planning_run_id`
2. Backfill
   - 建立平台默认 Planning Policy。
   - 仅将迁移前缺少 Planning Run 的 Router Plan 标记为
     `planning_source_legacy_unverified=true`。
   - 不为历史 Router Plan 伪造 Planning Run。
3. Validate
   - 校验不存在未标记且缺少 Run 的新 Router Plan。
   - 校验活动 Run 的唯一 Root Task 范围。
4. Enforce
   - 同一 Root Task 最多一个非终态 Planning Run。
   - Planning Run 必须指向同项目 Root Task。
   - Run 状态转换只允许状态机中的边。
   - Run revision 每次更新必须递增 1。
   - Artifact、Receipt、Event、Quality Metric 禁止修改或删除。
   - `workflow_plans.planning_run_id` 唯一。
   - Router Plan 必须有 Planning Run，且项目与 Root Task 必须一致。
   - `succeeded` Run 必须绑定 Workflow Plan。
5. Enable
   - `planning.manual=off`
   - `planning.autopilot=off`
   - 本 Migration 不打开任何 Planning 行为。

历史 Router Plan 的兼容标记只能由 Migration 46 回填。数据库 Trigger 禁止
应用或调用方新建、提升该标记，因此新 Router Plan 仍必须提供 Planning Run。

## 3. Contracts

文件：

- `packages/contracts/src/planning.ts`
- `packages/contracts/src/workflow-plan.ts`

新增契约：

- `PlanningPolicy`、`PlanningPolicyConfig`、`PlanningSettings`。
- `PlanningRun`、`PlanningRunDetail`、`PlanningOverview`。
- `PlanningTriggerKind`、`PlanningTriggerReceipt`。
- `RequirementBriefPayload`。
- `FactsLedgerPayload`。
- `CriticReportPayload`。
- `PlanningSkillSnapshotPayload`。
- `PlanningKnowledgeReceiptPayload`。
- `PlanningArtifact` 判别联合。
- `PlanningEvent`。
- `PlanningQualityMetric`。

输入边界：

- Start、Pause、Start、Cancel、Review Required、Retry、Settings 更新均使用
  strict schema。
- 调用方不能提交 `projectId`、`rootTaskId`、`planningRunId`、
  `agentPrincipalId` 等信任字段。
- Router Workflow Plan 输入必须同时提供 `planningRunId` 与
  `planningRunRevision`。
- `PlanningTrigger` 的 eventKey 由服务端稳定字段生成，不使用请求 ID、时间戳
  或随机 UUID。

## 4. Repository

文件：

- `packages/database/src/planning-repository.ts`
- `packages/database/src/repositories.ts`

关键规则：

- Start 先锁定 Root Task 行，再查询或创建活动 Run。
- 同一 eventKey 重放直接返回原 Receipt 对应 Run，不创建新 Run 或 Event。
- 新 Trigger 遇到活动 Run 时写入 `merged` Receipt，并增加 Run
  `triggerCount` 与 `revision`。
- Pause、启动暂停 Run、Cancel、Review Required、Retry 全部使用
  `expectedRevision` CAS。
- `review_required` 的 Retry 在原 Run 内回到 `preparing`。
- 终态 Retry 创建新 Run，并通过 `sourceRunId` 保留来源。
- Artifact 版本按 `run_id + kind` 单调递增。
- Artifact payload 通过对应 Zod Contract 校验，摘要由服务端计算。
- Quality Metric 按 Run 版本化并保持不可变。

## 5. Application 与 API

文件：

- `packages/application/src/planning.ts`
- `packages/application/src/index.ts`
- `apps/api/src/app.ts`

API：

```http
GET   /api/v1/projects/:projectId/planning/settings
PATCH /api/v1/projects/:projectId/planning/settings
POST  /api/v1/tasks/:id/planning/start
GET   /api/v1/tasks/:id/planning
POST  /api/v1/planning-runs/:runId/pause
POST  /api/v1/planning-runs/:runId/start
POST  /api/v1/planning-runs/:runId/cancel
POST  /api/v1/planning-runs/:runId/review-required
POST  /api/v1/planning-runs/:runId/retry
```

权限：

- Settings 读取要求项目读权限。
- Settings 更新和 Run 控制要求项目写权限。
- Project、Root Task、Actor Principal 均从数据库和认证上下文解析。
- API 不接受调用方自报 Planning Run 范围或 Agent Principal。

## 6. Workflow Plan 来源证明

创建 Router Plan 时：

- 应用层校验 Run 属于同项目、同 Root Task。
- Run 必须处于 `review_required`。
- `planningRunRevision` 不一致时返回 409。
- Workflow Plan Repository 在同一事务内再次锁定 Run。
- Plan Version 写入成功后，Run 原子进入 `succeeded` 并绑定 Workflow Plan。
- Planning Event 同步记录 `run.succeeded`。

人工与模板 Plan 仍可保持 `planning_run_id=NULL`。历史 Router Plan 保持
`planning_run_id=NULL`，但读取时可通过兼容标记识别为迁移前来源。

## 7. 验证结果

### 7.1 Migration 隔离

```text
./scripts/m10-planning-migration-vitest.sh

m10_migration_vitest=ok
fresh_migration=0->46
upgrade_migration=45->46
flags=planning.autopilot=off,planning.manual=off
tables=6
triggers=8
policy=true|false
active_run_unique=rejected
router_provenance=rejected
legacy_read=manual:true:false,router:true:true
legacy_planning_rows=0
old_app_write=Legacy app write after M10|manual
new_router_rejected=rejected
```

### 7.2 聚焦集成测试

```text
pnpm vitest run \
  apps/api/src/planning-runtime.test.ts \
  apps/api/src/workflow-plan.test.ts

Test Files  2 passed
Tests       13 passed
```

覆盖：

- Feature Flag 默认关闭。
- 同一稳定 Trigger 并发重放只消费一次。
- 同一 Root Task 只有一个活动 Run。
- 新 Trigger 合并到活动 Run。
- Pause Revision conflict。
- Cancel 与终态 Retry。
- 伪造 Project/Root/Run/Agent Principal 字段被拒绝。
- 无 Planning Run 的 Router Plan 被拒绝。
- Artifact 与 Quality Metric 不可变。
- 状态与 basis 查询。
- M3 Router Plan 在 M10a 来源绑定后继续完成物化。

### 7.3 全仓检查

```text
pnpm typecheck  pass
pnpm lint       pass
pnpm test       pass（无数据库模式下 208 passed / 237 skipped）
pnpm build      pass
```

contracts barrel 不引入 `node:crypto`。Planning eventKey 和 Artifact 摘要只在
服务端数据库层计算，避免 Node 内置模块进入 Web bundle。

## 8. 当前边界

M10a 不包含：

- Planner ContextPack 的实际构造。
- Requirement Brief、Facts、Skill/Knowledge Snapshot 的自动生成。
- Critic 与 Validator 的执行。
- Quality Gate 自动批准。
- Task Dispatch Readiness / Plan-first Gate。
- Agent 自动触发消费者。
- Planning Review UI。
- M11 项目业务链路。
- M12 Market 治理。

Artifact 契约与存储已就绪，但 M10a 只提供受控写入入口，不自动产生模型产物。

## 9. 后续入口

M10b 应在现有边界上增加：

- Planning Context 构建与证据固化。
- Planner/Critic/Validator Worker。
- Quality Gate 与人工审核状态转换。
- 自动触发消费和 Planner 自触发抑制。
- Task Dispatch Readiness。
