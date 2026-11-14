# dsh-pluginmax 升级迁移 M2 实施记录

> 阶段：M2 Workflow 模板作用域、责任槽位、Instance Binding、预检与角色映射预设
> 日期：2026-11-13
> 仓库：`pluginmax-platform`
> 实施基线：`main@5b7f7f5bc179ca0435c96126a950e7b3605847f4`
> 只读备份：`/Users/oliviayang/Codex/backups/dsh-migration-preflight-20261113-105957`

## 1. 实施前核对

```text
branch: main
HEAD:   5b7f7f5bc179ca0435c96126a950e7b3605847f4
```

开始前确认 Migration 最高版本为 37，不存在高于 37 的 Migration。工作树包含
Shared Space、Human Avatar Delegation、Identity Hardening 等既有用户改动和
未跟踪文件。本轮未执行 `git reset --hard`、`git checkout --`、`git clean`，
未清理或覆盖用户未跟踪文件，也未修改外部 `dsh-pluginmax` 仓库和只读备份。

## 2. Contract

新增 `packages/contracts/src/workflow-assignment.ts`：

- `WorkflowDefinitionScope = project | platform`
- `WorkflowDefinitionOrigin = template | router | manual`
- `TemplatePortability = required | suggested`
- `DispatchMode = assigned | claim`
- `RoleSlot`、`FixedSlot`
- `WorkflowInstancePreflight`
- `WorkflowInstanceAssignment`
- `WorkflowInstanceApprover`
- `WorkflowInstanceBindings`
- `ProjectRoleMappingPreset`
- `WORKFLOW_ASSIGNMENT_BINDINGS_FLAG`
- `WORKFLOW_PLATFORM_TEMPLATES_FLAG`

扩展 `WorkflowDefinition`：

- `ownerProjectId`
- `scope`
- `origin`
- `publishedByPrincipalId`
- `publishedAt`
- `revision`

扩展 Workflow Graph：

- executor `roleCode`
- executor `label`
- executor `portability`
- executor `dispatchMode`

扩展实例与启动输入：

- `WorkflowInstance.bindingRevision`
- `StartWorkflowInput.projectId`
- `StartWorkflowInput.expectedDefinitionVersion`
- `StartWorkflowInput.expectedBindingRevision`
- `StartWorkflowInput.bindingOverrides`

平台 Grant 增加受控附加权限 `manage_workflow_templates`。

## 3. Migration 38

文件：`packages/database/src/schema.ts`、`packages/database/src/migrate.ts`

Migration 38 为 additive：

```text
workflow_definitions
  + scope
  + origin
  + published_by_principal_id
  + published_at
  + revision

workflow_instances
  + definition_snapshot
  + binding_revision

workflow_instance_assignments
workflow_instance_approvers
project_role_mapping_presets
```

关键约束：

- `UNIQUE(instance_id, node_id)` on assignments。
- `UNIQUE(instance_id, node_id, principal_id)` on approvers。
- assigned resolved 绑定必须存在唯一 `primary_principal_id`。
- claim resolved 绑定必须存在非空 candidate pool。
- `task_id` 在 assignment 上唯一，绑定复用现有 Task，不创建第二套抢单表。
- `(project_id, role_id)` 唯一角色映射预设。
- `project_roles(project_id, lower(code))` 唯一，迁移前提供重复 code 冲突预检。
- `definition_snapshot` 回填存量实例的 Definition graph。

默认 Feature Flags：

```text
workflow.assignment_bindings=off
workflow.platform_templates=off
```

## 4. Application / Repository

新增 `packages/application/src/workflow-assignment.ts`：

- 平台模板读取、管理、目标项目实例化三条授权路径分离。
- Role Slot 按目标项目 `roleCode` 解析。
- 固定人员、审批人、候选池和 override 均以目标项目活跃成员解析。
- 预检只读，不写 Instance、Task、Run 或授权事实。
- assigned 必须唯一 primary。
- claim 使用现有 Task Queue `execution_claim_token`、
  `execution_claim_owner`、`execution_claim_expires_at`。
- Runtime 与 Runtime Binding 状态进入预检 evidence。
- Definition snapshot、binding revision 和实例绑定在同一事务创建。

新增 `packages/database/src/workflow-assignment-repository.ts`：

- 实例绑定读取与替换。
- Role Mapping Preset CAS revision。
- claim 候选池查询。
- assignment / approver 原子写入。
- Workflow Audit append。

旧 `GET /api/v1/workflows?projectId=...` 继续只返回该项目 scope=`project`
的 Definition，不自动混入平台模板。

## 5. API

新增：

```http
GET    /api/v1/workflows/platform-templates
GET    /api/v1/workflows/:workflowId
PATCH  /api/v1/workflows/:workflowId
POST   /api/v1/workflows/:workflowId/publish
POST   /api/v1/workflows/:workflowId/unpublish
POST   /api/v1/workflows/:workflowId/instances/preflight
GET    /api/v1/workflow-instances/:instanceId/bindings
PUT    /api/v1/workflow-instances/:instanceId/bindings
GET    /api/v1/projects/:projectId/role-mapping-presets
POST   /api/v1/projects/:projectId/role-mapping-presets
DELETE /api/v1/projects/:projectId/role-mapping-presets/:roleId
```

扩展：

```http
POST /api/v1/workflows/:workflowId/start
```

正式启动重新执行：

- 目标项目 active + `write`。
- Definition version。
- binding revision。
- Feature Flags。
- Role Slot、Assigned primary、Claim candidate pool。
- Runtime / Agent / Runtime Binding。

## 6. Audit

Workflow Audit 新增：

- `assignment.resolved`
- `assignment.unresolved`
- `assignment.remapped`
- `node.claimed`
- `node.claim_rejected`

Identity Audit 新增：

- `workflow.template.published`
- `workflow.template.unpublished`
- `workflow.template.updated`
- `workflow.role_mapping_preset.updated`
- `workflow.role_mapping_preset.deleted`
- `identity.platform_grant.permissions_extended`

预检不写审计，确保严格只读。

## 7. 负向与兼容测试

新增 `apps/api/src/workflow-assignment.test.ts`：

```text
non-owner project member can read platform template          pass
non-owner cannot edit/unpublish                             pass
owner project ordinary member cannot manage                 pass
target project without write cannot instantiate             pass
read/manage/instantiate authorization are not inferred      pass
required role slot unresolved blocks preflight/start        pass
preflight creates no Instance/Task/Run/Assignment           pass
assigned primary uniqueness                                 pass
concurrent claim has exactly one success                    pass
definition snapshot isolates started instance               pass
feature flag off creates no new binding or instance          pass
explicit manage_workflow_templates Platform Grant           pass
role mapping preset revision CAS                            pass
```

Migration 脚本：

```text
./scripts/m2-migration-vitest.sh
fresh_migration=0->38
upgrade_migration=37->38
definition_snapshot=Legacy snapshot
legacy_app_read=project|template|true
assignment_constraints=assigned_primary+instance_node_unique
role_preset_cascade=0
```

M1a / M1b Migration 兼容：

```text
./scripts/m1a-migration-vitest.sh
fresh_migration=0->38
upgrade_migration=34->38
constraint_conflicts=0

./scripts/m1b-migration-vitest.sh
fresh_migration=0->38
upgrade_migration=36->38
old_app_read=["Required item"]|review
old_app_review=return|local-admin
```

M2 PostgreSQL 聚焦集：

```text
./scripts/m2-workflow-assignment-vitest.sh
Test Files  6 passed
Tests       30 passed
```

覆盖 M2、M1a G1-G8、M1b Tool、Task Policy、External Runtime 和 Approval SLA。

## 8. 全仓门禁

```text
CI=true pnpm typecheck  pass
CI=true pnpm lint       pass
CI=true pnpm test       pass
CI=true pnpm build      pass
```

全仓 Vitest：

```text
Test Files  37 passed | 40 skipped (77)
Tests       190 passed | 175 skipped (365)
```

`CI=true` 用于避免 pnpm 在无 TTY 环境重复安装依赖。Colima 启动后，
PostgreSQL 集成脚本在沙箱外运行。

Teammates PostgreSQL 集成仍存在实施前已知失败：

```text
./scripts/teammate-vitest.sh
apps/api/src/teammates.test.ts:442
expected statistics.runCount=1, received 0
Test Files  1 failed | 13 passed
Tests       1 failed | 46 passed
```

该失败未在本轮修改，也未声明为已修复。

## 9. 剩余风险

- 平台模板的 graph 版本链仍沿用现有 Definition `key + graph.version`，
  未引入独立 Definition Version 表。
- 预检与正式启动之间仍存在外部 Runtime 探测/配置变化的自然 TOCTOU 窗口；
  正式启动会在绑定写入和实例创建前重新读取 Runtime Binding 和 Feature Flag。
- Assignment/Approver 当前记录当前绑定，历史依赖 Workflow Audit；
  database trigger 级不可变历史尚未增加。
- 自动 dispatch 的 claim 节点需要至少一个可执行 AI 成员来承载现有 Task
  `agent_id`；纯人工 Claim 节点仍需后续任务模型演进。
- 平台模板详情与 `graph` 编辑 API 仍保持保守元数据更新，未开放任意 graph
  原地覆盖。

## 10. 进入 M3 条件

- 保持 Migration 38 之上 additive 演进，禁止改写 37/38。
- 将 M2 Feature Flags 在目标环境开启并通过观察窗口。
- 将 `workflow.assignment_bindings=on`、`workflow.platform_templates=on`
  的配置变更纳入发布审计。
- Teammates 周报归属统计失败需修复或由负责人正式豁免。
- M3 Router 继续复用 Workflow Instance、Task、Run，不得新增平行 DAG
  抢单或权限事实源。
- M3 Plan Version / Materialization Ledger 必须单独 Migration，不复用 M2
  assignment 表承载动态计划。
