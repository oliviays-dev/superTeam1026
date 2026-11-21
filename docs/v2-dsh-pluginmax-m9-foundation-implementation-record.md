# dsh-pluginmax 增量升级 M9 兼容底座实施记录

> 阶段：M9 基线与兼容底座
> 日期：2026-11-21
> 项目基线：`8db80a2`，Migration 44
> 目标方案：`docs/v2-dsh-pluginmax-upgrade-delta-architecture-and-migration-plan.md`
> Migration：45

## 1. 完成范围

M9 已完成以下兼容底座：

- 外部增量事实已在目标方案中冻结提交、工作区统计与指纹。
- Task 增加一层 `parentTaskId` 关系。
- Router 物化 Task 自动关联 Root Task。
- Teammate Template 与项目解耦，保留创建上下文但不再持久化项目归属。
- Platform Template 全局唯一，Personal Template 按 Owner 唯一。
- Skill Binding 增加 `mode`、`scenes` 和 `instructionsHash`。
- Instance Skill Extension 固定为 `additive`，并带场景范围。

本阶段没有开启 Planning Runtime、项目业务链路、Market 治理或 MCP Provider。

## 2. Migration 45

文件：

- `packages/database/src/schema.ts`
- `packages/database/src/migrate.ts`

执行顺序：

1. Expand
   - `tasks.parent_task_id`
   - Task hierarchy 索引与跨项目、单层 Trigger。
   - `task_events.kind=hierarchy`。
   - `skill_versions.instructions_hash`。
   - Template Binding `mode/scenes`。
   - Instance Extension `mode/scenes`。
2. Backfill
   - 旧 Template 与 Template Version 的 `project_id/workspace_id` 置空。
   - required Binding 回填 `mode=required`。
   - default Binding 回填 `mode=default`。
   - 所有旧 Binding 和 Extension 回填 `scenes=["task-execution"]`。
3. Validate
   - Platform Template 名称全局冲突检查。
   - Personal Template 按 Owner 的名称冲突检查。
4. Enforce
   - Template 名称全局/按 Owner 唯一索引。
   - Template Version 与 Template 作用域一致性 Trigger。
   - Skill Binding mode 与 required 一致性约束。
   - Instance Extension 只允许 additive。

Migration 45 不自动回填历史 Run Skill Snapshot，也不伪造历史 Planner 数据。

## 3. Task 一层层级

Contract：

```text
Task.parentTaskId?: UUID
CreateTaskInput.parentTaskId?: UUID
UpdateTaskParentInput {
  parentTaskId: UUID | null
  expectedRevision: number
}
```

API：

```http
PATCH /api/v1/tasks/:taskId/parent
```

规则：

- 主任务和子任务必须同项目。
- 任务不能关联自身。
- 最多一层；已有父任务的 Task 不能再作为父任务。
- 已有子任务的 Task 不能变为子任务。
- 完成或取消的 Task 不能接收新的子任务。
- 使用 `expectedRevision` 做 CAS。
- 解绑只清空产品层级，不影响 `task_origins` 来源血缘。
- Router 物化 Task 同时写 `tasks.parent_task_id` 和
  `task_origins.parent_task_id`。

Web：

- Task Detail 增加“任务层级”。
- 显示主任务、子任务和独立任务。
- 有项目写权限且无子任务时，可以调整主任务。

## 4. Teammate Template 作用域

目标语义：

- `scope=platform`：平台资产，不归属任何项目。
- `scope=personal`：个人资产，归属创建者。
- Instance：仍归属具体项目。

兼容处理：

- `teammate_templates.project_id/workspace_id` 保留为 nullable。
- `teammate_template_versions.project_id` 保留为 nullable。
- 新 Template 与 Version 写入 `NULL`。
- 创建 API 仍要求 `projectId`，只作为创建时的项目权限上下文。
- Platform Template 名称全局唯一。
- Personal Template 名称在 Owner 范围内唯一。
- Instance 的 Owner 仍必须与 Personal Template Owner 一致。

结果：

- Personal Template 可由 Owner 在其它有写权限的项目创建实例。
- Platform Template 可由管理员维护，并由有目标项目写权限的成员使用。
- Template 不再因为来源项目归档或成员变化而失去管理路径。

## 5. Skill Binding 扩展

新增：

```text
mode = required | default | additive | primary
scenes = task-planning | task-execution | meeting | project-report
instructionsHash = SHA-256(instructions)
```

规则：

- `required=true` 时 mode 固定为 `required`。
- `required=false` 默认 mode 为 `default`。
- Instance Extension 固定 mode 为 `additive`。
- 同一 Template 的同一场景最多一个 `primary` Skill。
- 旧 Binding 默认只作用于 `task-execution`，不自动进入规划场景。
- 历史 Run Skill Snapshot 继续可读；新 Snapshot 固化 mode、scenes 和
  instructionsHash。

## 6. 验证结果

### 6.1 Migration

```text
./scripts/m9-foundation-migration-vitest.sh
fresh_migration=0->45
upgrade_migration=44->45
legacy_read=M9 snapshot task|true
template_scope=true|true|true
skill_metadata=required|["task-execution"]|true
grandchild_insert=rejected
```

覆盖：

- 空库升级。
- `44 -> 45` 隔离升级。
- 旧 Task 可读。
- Template 与 Version 项目归属回填为空。
- required Binding 的 mode 与 scenes 回填。
- 旧 Skill Version 的 instructionsHash 保持可兼容空值。
- 三层任务插入被数据库 Trigger 拒绝。

### 6.2 聚焦集成测试

```text
pnpm vitest run \
  apps/api/src/task-hierarchy.test.ts \
  apps/api/src/teammates.test.ts \
  apps/api/src/skill-resolution.test.ts

Test Files  3 passed
Tests       9 passed
```

覆盖：

- 子任务创建、解绑、重新关联。
- 三层任务、父任务反向关联和跨项目主任务拒绝。
- Revision conflict。
- Personal Template 跨项目创建实例。
- Template 项目归属为 null。
- Skill mode、scenes、instructionsHash。
- required/default/instance extension 优先级不回退。

### 6.3 全仓检查

```text
pnpm typecheck  pass
pnpm lint       pass
pnpm test       pass（无数据库模式下 208 passed / 230 skipped）
pnpm build      pass
```

## 7. 当前边界

M9 只建立后续阶段需要的数据边界，不包含：

- Planning Run、Trigger Receipt、Critic 与质量门。
- 项目业务链路绑定与来源 Snapshot。
- Project Alert 与项目概览 Read Model。
- Market 来源、共享、发布和可用性拆分。
- MCP Provider。

## 8. 下一步

下一阶段进入 M10 Planning Runtime，建议拆成两个可独立验收的子批次：

1. M10a
   - Planning Policy、Run、Trigger Receipt、Artifact、Event。
   - 人工发起、取消、恢复与状态机。
   - `workflow_plans.planning_run_id` 来源证明。
2. M10b
   - Planner Context、Skill/Knowledge Snapshot。
   - Plan Critic、质量门、人工审核。
   - Task Dispatch Readiness 与 Plan-first Gate。

在 M10 完成前，`source=router` 仍不应被当作“AI 已规划”的充分证据。
