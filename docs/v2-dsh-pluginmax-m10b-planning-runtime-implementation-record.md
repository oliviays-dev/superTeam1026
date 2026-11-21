# dsh-pluginmax 增量升级 M10b Planning Runtime 执行面实施记录

> 阶段：M10b Planning Runtime 执行面
> 日期：2026-11-21
> 前置基线：M10a Planning Runtime 控制面，Migration 46
> 目标方案：`docs/v2-dsh-pluginmax-upgrade-delta-architecture-and-migration-plan.md`

## 1. 完成范围

M10b 已在 M10a 控制面上补齐 Planning Runtime 执行面，未实现 M11 项目业务
链路、M12 Market 治理或 Planning Review UI。

本批包含：

- Planning Context 的权威事实快照与不可变 Context Pack。
- Root Task revision、成员/角色、Agent 候选、Meeting、Workflow、Document、
  Memory、平台安全规则、Skill 与 Knowledge 贡献。
- `task-planning` 场景的 Skill Snapshot。
- Requirement Brief、Facts Ledger、Skill Snapshot、Knowledge Receipt。
- Planner Worker 状态推进与活动 Trigger 消费。
- Plan Draft、Critic、Validator 与 Quality Gate。
- 风险门、Root Acceptance 覆盖、节点证据、Critic verdict/score。
- 人工 Plan 编辑、重新规划、取消与 Revision CAS。
- Quality Gate 允许时的同事务自动批准。
- Task Dispatch Readiness / Plan-first Gate。
- `planning.manual=off`、`planning.autopilot=off`、
  `workflow.router_worker=off` 默认关闭。

## 2. Migration 46 复用

没有占用 Migration 47。

本批继续使用 M10a 已建立的：

- `planning_policies`
- `planning_runs`
- `planning_trigger_receipts`
- `planning_artifacts`
- `planning_events`
- `planning_quality_metrics`
- `workflow_plans.planning_run_id`

在同一 Migration 46 内补强了三个无法由旧约束正确表达的事实：

1. Planning Artifact 增加 `context-pack` 与 `plan-draft` kind。
2. Planning 生成的 Router Plan 允许“Planning Run 或 Router Agent”二选一，
   不再错误要求 Router Agent。
3. `workflow_plan_versions` 增加 provenance Trigger：Router Agent 为空时，
   父 Plan 必须绑定有效 Planning Run；历史兼容标记不能接收新版本。

历史 Router Plan 仍保留 `planning_source_legacy_unverified=true`，不伪造
Planning Run。

## 3. Planning Context

Context Builder 在数据库事务中读取权威事实：

- Root Task 当前 revision、描述、验收、状态、优先级和负责人。
- Project 当前状态。
- Project Member、Role 与 Agent 候选。
- 当前项目的 Meeting 和 Workflow Definition。
- Root Task 的未归档 Document。
- 项目最新 Memory Truth。
- 平台 Skill 安全规则。
- Knowledge Provider 的结构化贡献。

Context Pack 以不可变 Planning Artifact 固化，包含上下文摘要与来源标识。
Skill Snapshot 只纳入绑定到 `task-planning` 场景的 Skill，并记录版本、digest、
instructionsHash、来源、纳入/排除原因和 `grantsAuthorization=false`。

Knowledge Receipt 记录每个 Provider 来源是否纳入及原因；纳入事实同时进入
Facts Ledger。

## 4. Planner Worker

文件：

- `packages/application/src/planning-runtime.ts`
- `packages/application/src/planning-quality.ts`
- `packages/database/src/planning-repository.ts`

Worker 使用 Migration 46 状态机推进：

```text
queued
  -> preparing
  -> understanding
  -> clarifying | drafting
  -> critiquing
  -> validating
  -> review_required
  -> succeeded | failed | cancelled
```

关键规则：

- `preparing` 固化 Context Pack。
- `understanding` 固化 Brief、Facts、Skill Snapshot 与 Knowledge Receipt。
- `drafting` 固化不可变 Plan Draft。
- `critiquing` 固化 Critic Artifact 与 Quality Metric。
- `validating` 复核质量门后才允许创建 Plan Version。
- 所有状态推进使用 `expectedRevision` 与行锁 CAS。
- 终态 Run 不可恢复，只能新建 Run。
- 同一 Root Task 同时只有一个活动 Run。
- Planner 只生成 Plan，不直接写 Task；Router 物化子任务带有 Root Task 层级，
  不会反向触发 Root Planning。

默认 Planner 为确定性的 Acceptance Planner；Planner、Critic 和 Knowledge
Provider 均保留可注入端口，生产模型适配器不进入浏览器。

## 5. Quality Gate

质量门检查：

1. 图结构、依赖、环、连通性、深度和节点限制。
2. 每个 Root Acceptance 至少被一个节点覆盖。
3. 每个节点都有 description 与可检查 acceptance/evidence 要求。
4. 高风险节点必须满足 `autoDispatch=false` 且存在 `kind=user` 审批人。
5. Critic verdict 必须为 `pass`。
6. Critic score 必须达到项目策略的 `minScore`。
7. Validator 错误必须为零。
8. 人工 Trigger 或策略要求时必须人工审核。

质量失败时 Run 进入 `review_required`，不会绑定 Workflow Plan，也不会生成
可派发计划。

当且仅当策略允许、非人工 Trigger、无高风险门且所有检查通过时，
`autoApproveEligible=true`。此时 Plan Version、Run 终态、Plan 审核记录与
Workflow Instance 在同一数据库事务中收敛。

## 6. Plan 生成与绑定

Planning 生成的 Plan：

- `source=router`
- `planning_run_id` 必须有值
- `router_agent_id=NULL`
- Workflow Plan Version 1 与 Run `succeeded` 同事务写入
- Planning Run 与 Workflow Plan 一一绑定

人工 Plan、模板 Plan 和迁移前历史 Router Plan 保持兼容。

Planning 生成的 Plan 不依赖 `workflow.router_worker` 才能审核或物化；
M3 Router Agent Plan 仍受原 Feature Gate Epoch 约束。

## 7. 人工控制面

新增 API：

```http
GET  /api/v1/tasks/:id/dispatch-readiness
POST /api/v1/planning-runs/:runId/run
POST /api/v1/planning-runs/:runId/plan
```

已有能力继续复用：

- `review-required`
- Pause / Resume / Cancel
- Retry / Replan
- Revision CAS

人工编辑 Plan 会重新固化 Plan Draft、重跑 Critic/Validator/Quality Gate；
未通过时 Run 保持 `review_required`，不会覆盖历史 Artifact。

## 8. Dispatch Readiness

每次派发前从数据库重新计算，不缓存。

返回原因：

- `planning-required`
- `planning-running`
- `planning-review-required`
- `planning-blocked`

规则：

- 仅在项目开启 Planning Flag 时执行 Plan-first Gate。
- Agent 负责的 Root Task 必须有已确认 Plan。
- 人工角色负责的 Root Task 不强制规划。
- Router Origin Task 与子任务不重复规划。
- 计划未确认、Planning 运行中、质量阻断时返回明确原因。
- Gate 关闭时，如果仍有活动 Run 或未确认 Planning Plan，进入安全阻断，
  不会把它当作已批准计划。

## 9. 验证结果

### 9.1 全仓检查

```text
pnpm typecheck  pass
pnpm lint       pass
pnpm test       pass（208 passed / 247 skipped）
pnpm build      pass
```

构建保留既有 Web bundle 体积 warning，没有新增构建失败。

### 9.2 M10 PostgreSQL 集成

```text
./scripts/m10b-planning-runtime-vitest.sh

Test Files  2 passed
Tests       23 passed
```

覆盖：

- Plan-first 拒绝未确认计划的 Agent Root Task。
- 人工角色任务不强制规划。
- Router 子任务不重复规划。
- Planner 自触发被 Root/Origin 层级规则抑制。
- Critic/Validator 失败不得自动批准。
- Root Acceptance 未覆盖不得绑定 Plan。
- 高风险节点必须有用户 Gate。
- Validator 图错误不得绑定 Plan。
- Run succeeded 与 Plan Version 同事务绑定。
- 自动批准仅在完整质量门通过时发生。
- Autopilot Flag 开启但 Trigger Policy 关闭时仍拒绝自动 Trigger。
- Planning Flag 关闭时活动 Run 安全阻断。
- Planning 生成 Plan 可在 Router Worker Gate 关闭时审核和物化。
- 无有效 Planning Run 的 Router Plan 被拒绝。

### 9.3 Migration 隔离

```text
./scripts/m10-planning-migration-vitest.sh

m10_migration_vitest=ok
fresh_migration=0->46
upgrade_migration=45->46
idempotent_migration=46->46
flags=planning.autopilot=off,planning.manual=off
tables=6
triggers=9
policy=true|false
active_run_unique=rejected
router_provenance=rejected
planning_provenance=1
legacy_read=manual:true:false,router:true:true
legacy_planning_rows=0
old_app_write=Legacy app write after M10|manual
new_router_rejected=rejected
```

## 10. 当前边界与风险

未包含：

- M11 项目业务链路、Project Source Snapshot、Alert。
- M12 Market 治理。
- Planning Review UI。
- 生产 LLM Planner 适配器与 Prompt 版本管理。
- 外部 Knowledge Provider 的具体连接器。

剩余风险：

- 默认 Planner/Critic 是确定性实现，真实模型质量需通过注入端口和独立评测
  校准。
- 默认 Knowledge Provider 为空实现，接入外部知识源后需要评估延迟、超时和
  排除原因。
- Worker 并发下的最终 Plan/Run 由唯一约束和 CAS 保证单活；重复 Worker
  仍可能产生额外不可变中间 Artifact，但不影响最终绑定事实。
- Planning Review UI 尚未提供，当前通过 API 完成人工编辑与审核。
