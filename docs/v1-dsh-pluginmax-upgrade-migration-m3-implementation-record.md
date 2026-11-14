# dsh-pluginmax 升级迁移 M3 实施记录

> 阶段：M3 Router 动态计划、Plan Version、Task Materialization、Reconciler
> 日期：2026-11-13
> 仓库：`pluginmax-platform`
> 实施基线：`main@5b7f7f5bc179ca0435c96126a950e7b3605847f4`
> 只读备份：`/Users/oliviayang/Codex/backups/dsh-migration-preflight-20261113-105957`

## 1. 实施前核对

```text
branch: main
HEAD:   5b7f7f5bc179ca0435c96126a950e7b3605847f4
```

开始前确认 Migration 最高版本为 38，不存在高于 38 的 Migration。工作树包含
Shared Space、Human Avatar Delegation、Identity Hardening 等既有用户改动和
未跟踪文件。本轮未执行 `git reset --hard`、`git checkout --`、`git clean`，
未清理或覆盖用户未跟踪文件，也未修改外部 `dsh-pluginmax` 仓库和只读备份。

## 2. Contract

新增 `packages/contracts/src/workflow-plan.ts`：

- `WorkflowPlanSource = template | router | manual`
- `WorkflowPlanStatus`
- `WorkflowPlanSettings`
- `WorkflowPlanVersion`
- `WorkflowPlan`
- `PlanMaterialization`
- `RouterAgent`
- `RouterFeatureGate`
- `WorkflowPlanDiff`
- `ROUTER_TOOL_CONTRACT`
- `planCreationKey(planId, planVersion, nodeId)`

扩展 Workflow Graph Node：

- `acceptance?: string[]`

新增纯 Domain Validator
`packages/domain/src/workflow-plan.ts`：

- 节点 ID 唯一。
- 依赖节点存在。
- 无自依赖、无环。
- 至少一个 start，所有节点从 start 可达。
- 拒绝多弱连通分量。
- 只允许无条件 AND-join，拒绝 condition/result/default/break。
- 校验节点名称、描述、验收项、Task receiver。
- 校验节点数、深度、出度和初始并发。
- `diffWorkflowPlanGraphs` 提供不可变版本节点/边 diff。

## 3. Migration 39

Migration 39 位于
`packages/database/src/schema.ts` 的 `M3_WORKFLOW_PLAN_SCHEMA_SQL`，
由 `packages/database/src/migrate.ts` 注册为最高版本 39。

新增或扩展：

```text
workflow_plans
workflow_plan_versions
plan_materializations
task_origins
router_agents
workflow_feature_gate_epochs
workflow_plan_outbox_messages
workflow_plan_audit_events

workflow_definitions
  + plan_id
  + plan_version

workflow_instances
  + plan_id
  + plan_version

tasks
  + creation_key

teammate_templates
  + protected
```

关键约束：

- `UNIQUE(plan_id, version)` on `workflow_plan_versions`。
- `UNIQUE(plan_id, plan_version, node_id)` on
  `plan_materializations`。
- `creation_key` 唯一；`task_origins.task_id` 与
  `task_origins.idempotency_key` 唯一。
- Plan Version 使用 trigger 禁止 UPDATE/DELETE。
- Task Origin 使用 trigger 禁止 UPDATE/DELETE。
- `router_agents.teammate_id`、`agent_id` 唯一。
- Plan Outbox 使用稳定 `message_id` 主键。
- Gate epoch、Plan revision、Plan lease 和 Outbox lease 均持久化。

默认 Feature Flag：

```text
workflow.router_worker=off
```

## 4. Plan 物化与 Reconciler

新增：

- `packages/application/src/workflow-plan.ts`
- `packages/database/src/workflow-plan-repository.ts`

Task 物化幂等键：

```text
plan-node:{planId}:v{planVersion}:{nodeId}
```

不包含 attempt、客户端重试次数、时间戳或操作人。

物化语义：

- Plan Version 固定 Graph、Settings、Source、Reason、Creator 和 Router Agent
  Snapshot。
- 批准后生成或复用唯一的 Workflow Instance。
- 节点物化为正式 Task，写 `task_origins` 与
  `plan_materializations`。
- 子 Task 创建人、Run 归属使用 Plan 确认人。
- Root Task 只作为业务承诺和最终 Review 载体，不被子节点完成自动改写。
- `pending -> materializing -> materialized / failed` 状态落地。
- Task 已创建但 Origin 缺失时，通过 creationKey 反查并补齐。
- Outbox 使用稳定 message ID、lease、SKIP LOCKED 和重放幂等。

Reconciler：

- 使用 Plan lease 与 `FOR UPDATE SKIP LOCKED` 领取候选。
- 按数据库权威依赖状态决定是否派发。
- 已存在 active Run 时只完成 Outbox 消息，不重复创建 Run。
- Gate 关闭或 epoch 变化时，在副作用前 fence。
- 重开 Gate 不自动恢复，必须显式 resume。

## 5. Router Agent 与 Feature Gate

Router Agent 必须是：

- 活跃 AI Teammate。
- 活跃 Agent。
- 使用 active 且 `protected=true` 的 Teammate Template。
- Template Version 声明：

```text
router_worker_submit_plan
router_worker_submit_final_draft
```

普通 Agent ID、普通 Teammate Template 或缺失 Router Tool Contract 均被拒绝。
当前平台不存在独立 Data Agent Contract；其对应能力在被建模后也必须通过
同一 protected template + Router Tool Contract 门禁，不能复用普通 Agent 注册路径。

Feature Gate：

- 默认 off。
- 关闭事务递增 epoch。
- Plan 从 `approved/active/finalizing` 进入 `resume_required`。
- 取消 pending/processing Outbox。
- Reconciler 与派发前重新读取 Gate。
- Epoch 不匹配时停止，不产生 Task、Run 或外部副作用。

## 6. API

新增：

```http
POST /api/v1/tasks/:id/plans
GET  /api/v1/task-plans/:planId
GET  /api/v1/projects/:projectId/task-plans
POST /api/v1/task-plans/:planId/versions
GET  /api/v1/task-plans/:planId/versions/:version/diff
POST /api/v1/task-plans/:planId/approve
POST /api/v1/task-plans/:planId/materialize
POST /api/v1/task-plans/:planId/finalize
POST /api/v1/task-plans/:planId/resume
POST /api/v1/projects/:projectId/router-template
GET  /api/v1/projects/:projectId/router-agents
POST /api/v1/projects/:projectId/router-agents
GET  /api/v1/projects/:projectId/router-gate
PUT  /api/v1/projects/:projectId/router-gate
POST /api/v1/operations/workflow-plans/sweep
```

## 7. 审计

Plan Audit：

```text
plan.created
plan.updated
plan.approved
plan.materialized
plan.reconciled
plan.finalized
plan.failed
plan.resume_required
router_agent.registered
feature_gate.updated
```

Gate 更新同时写 Identity Audit：

```text
workflow.router_worker.gate_updated
```

## 8. 测试结果

M3 Migration：

```text
./scripts/m3-migration-vitest.sh
fresh_migration=0->39
upgrade_migration=38->39
router_flag=off
legacy_read=project|template|true
legacy_task=true|queued
```

Plan Materialization：

```text
./scripts/m3-plan-materialization-vitest.sh
Test Files  2 passed
Tests       15 passed
```

覆盖：

- G9 并发 approve/materialize。
- G9 附加并发 finalize，仅生成一条 Final Draft Outbox。
- G10 Task 创建后 Origin 缺失恢复。
- 非法 DAG 拒绝。
- Plan Version 不可变与 diff。
- Manual / Template / Router 共用 Workflow Instance / Graph 投影。
- protected Router Template 与 Router Tool Contract。
- 普通 Agent / 普通 Template 拒绝。

Reconciler / Gate fencing：

```text
./scripts/m3-router-reconciler-vitest.sh
Test Files  1 passed
Tests       1 passed
```

覆盖 G11：

- 关闭 Gate 无新派发。
- 在途 Outbox 被取消。
- Plan 进入 `resume_required`。
- 重开不自动执行。
- 显式 resume 后只派发起始节点。
- 重复 sweep 不重复创建 Run。

历史回归：

```text
./scripts/m1a-migration-vitest.sh  pass（34->39）
./scripts/m1b-migration-vitest.sh  pass（36->39）
./scripts/m2-migration-vitest.sh   pass（37->39）
./scripts/m2-workflow-assignment-vitest.sh  pass（6 files / 30 tests）
```

全仓门禁：

```text
CI=true pnpm typecheck  pass
CI=true pnpm test       pass
CI=true pnpm lint       pass
CI=true pnpm build      pass
```

全仓 Vitest：

```text
Test Files  38 passed | 42 skipped (80)
Tests       199 passed | 182 skipped (381)
```

Teammates PostgreSQL 集成仍存在实施前已知失败：

```text
./scripts/teammate-vitest.sh
apps/api/src/teammates.test.ts:442
expected statistics.runCount=1, received 0
Test Files  1 failed | 13 passed
Tests       1 failed | 46 passed
```

本轮未修改该既有统计夹具或日期归属逻辑，也未声明其已修复。

## 9. 剩余风险

- M3 动态计划节点当前收敛为 Task 节点；Approval / Decision / Subworkflow
  节点需要后续单独定义物化与审批语义。
- Data Agent 当前没有独立 Principal/Contract 类型；后续引入时必须复用
  Router Tool Contract 门禁。
- 自动 Resume 后如果 Plan 已物化，Reconciler 会重新激活被 Gate 关闭取消的
  Dispatch Outbox；这是显式 resume 后的预期路径。
- Gate 关闭与最后一次“副作用前复核”之间仍是极短窗口。当前通过数据库
  epoch、Plan 状态、Outbox lease 和 Run active 检查收敛重复副作用，但
  外部不可回滚动作仍需 Execution Gate 单次消费。
- Plan 最终汇总仍以节点 Task `done` 作为 M3 完成投影，最终 Router Draft
  由 Outbox 记录，尚未接入 M4 Skill / 报告体系。

## 10. 进入 M4 条件

- 保持 Migration 39 之上 additive 演进，禁止改写 37/38/39。
- 目标环境先关闭 `workflow.router_worker` 完成发布，再按项目 Gate epoch
  单独开启。
- Teammates 既有周报统计失败需修复或由负责人正式豁免。
- 若扩展 Approval / Decision / Subworkflow Plan Node，必须先补 Graph
  Validator、物化账本和 Gate fencing 退出门。
- M4 不得复用 Router Plan 账本承载 Skill Version/Installation/Binding。
