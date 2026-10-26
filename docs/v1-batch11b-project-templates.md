# V1 Batch 11B: Project Templates

> 分支：`feat/v1-batch11b-project-templates`
>
> 基线：`884906c6290a4e04d9cb36f85b2c6aecde013e39`
>
> Migration：18

Batch 11B 在 Batch 11A 的项目日报与工作台上增加平台级项目模板。项目模板拥有
基础项目定义、预定义项目角色集合、工作流模板稳定引用、使用范围和不可变 revision
历史；工作流定义本体继续由 Workflow 域维护。

## 11B.1 模板与角色库

平台管理员可维护：

- 模板角色库：编码、名称、分类、说明和权限；
- 项目模板：名称、编码、类型、说明、负责人角色、预定义角色、工作流模板引用、
  使用范围和历史 revision；
- 工作流模板目录：稳定 key、名称、说明、版本和步骤定义。

普通成员只能看到启用且有权使用的项目模板。`selected-members` 模板只对显式授权的
账号出现在新建项目选择器中；接口仍会二次校验，不能通过直接请求绕过。

```text
GET    /api/v1/project-templates
POST   /api/v1/project-templates
GET    /api/v1/project-templates/:templateId
PATCH  /api/v1/project-templates/:templateId
POST   /api/v1/project-templates/:templateId/copy
POST   /api/v1/project-templates/:templateId/archive
GET    /api/v1/project-templates/:templateId/history

GET    /api/v1/template-roles
POST   /api/v1/template-roles
PATCH  /api/v1/template-roles/:roleId
DELETE /api/v1/template-roles/:roleId

GET    /api/v1/workflow-templates
POST   /api/v1/workflow-templates
PATCH  /api/v1/workflow-templates/:workflowTemplateId
```

每次创建、编辑或归档项目模板都会追加一条不可修改的 revision 摘要。编辑请求必须携带
`expectedRevision`；过期 revision 返回 `template_revision_conflict`。

## 11B.2 原子物化

`POST /api/v1/projects` 在携带 `templateId` 时要求 `Idempotency-Key` 或
`materializationKey`。单个数据库事务完成：

1. 校验模板启用状态、使用范围和 revision 快照；
2. 创建项目及来源模板 revision；
3. 复制项目角色，保留 `library_role_id` 来源但ID和后续修改完全独立；
4. 创建 Owner 成员并应用模板负责人角色；
5. 从 Workflow 域拥有的工作流模板创建项目内工作流定义；
6. 写入模板物化回执。

物化在事务内使用 `pg_advisory_xact_lock`，并受
`(template_id, idempotency_key)` 唯一约束保护。重复请求、并发请求或客户端重试返回
同一项目；同一键配合不同请求内容返回 `materialization_key_conflict`。

模板和历史项目之间没有运行时依赖：

- 后续修改模板或角色库不会修改已创建项目；
- 已物化模板不能归档，返回 `project_template_in_use`；
- 被模板或项目角色引用的角色库角色不能删除，返回 `template_role_in_use`；
- 空模板仍会物化一个项目负责人角色，不生成工作流定义。

## 11B.3 Database

Migration 18 新增：

- `template_roles`；
- `workflow_templates`；
- `project_templates`、`project_template_revisions`；
- `project_template_role_refs`、`project_template_workflow_refs`；
- `project_template_grants`；
- `project_template_materializations`。

同时以安全默认值扩展：

- `projects.source_template_id`、`projects.source_template_revision`；
- `project_roles.code/category/permissions/library_role_id`；
- `workflow_definitions.source_template_id/source_template_version`。

旧项目、旧项目角色和旧工作流定义保持可读；模板 revision 表由触发器拒绝更新和删除。

## 11B.4 GUI

项目页新增：

- 平台管理员可见的“项目模版”入口；
- 新建项目时可选当前账号有权使用的模板；
- 模板维护页的项目模版 / 角色库双面板；
- 模板基础信息、角色集合、工作流引用、使用范围、revision 历史和归档只读状态。

页面提供 loading、empty、error、busy、revision conflict 和只读状态；移动端维持单列，
不产生横向溢出。

## 11B.5 Validation

```bash
pnpm check
pnpm test:integration:project-templates
pnpm test:smoke:project-templates-postgres
pnpm test:smoke:project-templates
pnpm test:e2e:project-templates
git diff --check
```

定向覆盖模板越权、跨项目隔离、重复物化、并发物化、被引用角色删除、模板归档冲突、
revision 冲突、空模板、旧项目兼容和 Mobile viewport。
