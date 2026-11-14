# Pluginmax V1 Project Governance 产品与技术方案

> 状态：设计方案，尚未实现
>
> 目标批次：Batch 20 项目治理部分
>
> 优先级：P1
>
> 依赖：Project RBAC、Project Template、Project Report、Workflow Instance、
> Task Role Assignment、Identity Audit
>
> 对照基线：`dsh-pluginmax@a702267abfc6baebc7cab7b3045e71c204079e10`

## 1. 结论

Project Governance 不是新增第二套 Project，而是在现有 Project、Project Member、
Project Role、Task、Workflow 和 Report 上补齐：

- 项目负责人和经营摘要。
- 健康度、进度、开始日期、目标日期。
- 阶段性产出物和来源追溯。
- 只追加项目审计。
- 项目角色草稿、整组确认和 revision 冲突保护。
- 角色删除的成员、任务和工作流影响处理。
- 已启动工作流的角色快照。

项目角色仍以 Project Role 和 Project Grant 为唯一可写授权事实。

## 2. 当前基础与缺口

### 2.1 平台已有

- `projects`：id、name、code、description、status。
- `project_roles`：code、name、category、permissions、library role。
- `project_members`、`project_member_roles`。
- Project Grant 镜像和 Project Capability。
- Project Template 与 materialization。
- Project Report 与来源引用。
- Task role assignment。
- Workflow Definition/Instance、Approval、Audit。
- `identity_audit_events`。

### 2.2 当前缺口

- 没有项目负责人字段。
- 没有健康度、进度和日期。
- 没有项目级产出物对象。
- 没有项目只追加历史。
- Project Role 只能直接 CRUD，没有草稿整组确认。
- 没有 `rolesRevision`。
- 删除角色不会给出完整成员、任务和工作流影响。
- Workflow Instance 没有启动时角色快照。
- 项目编号没有 DSH 的全局递增语义。

## 3. 产品目标

1. 用户进入 Project 后能判断项目是否健康、进行到哪里、谁负责。
2. 用户能记录阶段性产出物并追溯来源。
3. 用户能查看完整项目历史，不被最新配置覆盖。
4. 管理员能安全地整组调整项目角色。
5. 角色确认前能看见成员、任务和工作流影响。
6. 并发角色变更不会静默覆盖。
7. 已启动工作流使用角色快照，不受后续角色修改影响。
8. 项目删除角色后，受影响任务明确进入“需改派”。

## 4. 非目标

- 自建完整项目管理套件或甘特图编辑。
- 用 Project Health 替代任务、Workflow 或风险系统的业务真相。
- 项目成员页编辑平台账号、密码或 Platform Grant。
- 把 Project Role 扩展成 Platform Grant。
- 迁移旧 DSH Workspace、旧 Project ID 或旧 JSON Storage。
- 自动改写历史审计和已启动工作流事实。
- 在本批次实现 Workbench 拖拽布局。

## 5. 用户角色

| 角色 | 能力 |
| --- | --- |
| Project Member | 查看项目摘要、产出物、可访问历史和角色只读信息 |
| Project Owner | 编辑项目摘要、产出物、角色草稿并确认 |
| Project `manage_roles` | 管理角色草稿和确认 |
| Project `manage_members` | 查看成员影响并调整成员 |
| `approve` | 确认阶段产出物或治理变更，如产品要求 |
| Platform ADMIN | 可进入管理面，但不绕过 Project Grant |
| AI Principal | 可作为项目成员，不默认拥有项目管理权限 |

## 6. 信息架构

项目详情建议分为：

```text
项目详情
├── 概览
│   ├── 负责人、状态、健康度、进度
│   ├── 开始日期、目标日期
│   ├── 关键指标与日报入口
│   └── 当前风险摘要
├── 成员与角色
│   ├── 成员
│   ├── 有效角色集
│   ├── 草稿差异
│   └── 影响预览
├── 产出物
│   ├── 阶段、主题、时间
│   ├── 来源任务/工作流/会议
│   └── 文件或外部链接
├── 任务
├── 工作流
├── 项目日报
└── 历史
```

## 7. 产品需求

### 7.1 项目概览

字段：

| 字段 | 规则 |
| --- | --- |
| Owner | active Project Member 中的 Human Principal，默认创建者 |
| Health | `healthy / watch / at_risk / blocked` |
| Progress | 0 到 100 的整数 |
| Start Date | 可选业务日期 |
| Target Date | 可选业务日期，不得早于 Start Date |
| Project Code | 新项目默认为不可变全局编号 |
| Status | 保持 `active / archived` |

Owner 规则：

- Owner 是项目范围事实，不是 Platform Role。
- Owner 必须有 active Project membership 和 Project Owner Grant。
- Owner 变更和 Grant 变更在同一事务完成。
- Owner 不能被直接删除，必须先转移 Owner。
- Platform ADMIN 不因身份自动成为 Owner。
- AI Principal 是否可成为 Owner 默认不允许，单独产品决策后再扩展。

Health 规则：

- 用户手工设置，不由系统自动推断为唯一事实。
- 系统可显示“建议健康度”，但不能覆盖手工值。
- `blocked` 需要非空原因或关联风险。
- 健康度变化写项目审计。

Progress 规则：

- 用户维护，不由任务完成率自动覆盖。
- 页面可并列展示手工进度和系统计算参考值。
- 修改写 before/after 审计。

### 7.2 项目产出物

产出物是项目阶段成果，不是 Workflow Deliverable 的副本。

字段：

- 标题。
- 阶段，例如 discovery、design、delivery、review、release。
- 主题。
- 摘要。
- 产出时间。
- 产出者 Principal。
- 来源引用：Task、Workflow Node、Meeting、Run、Report、Shared File、URL。
- 文件对象或外部链接。
- 状态：draft、published、archived。

规则：

- Workflow Deliverable 继续负责流程门禁。
- Project Output 负责项目成果目录和来源追溯。
- 同一来源可以产生多个产出物，但需稳定幂等键避免重复登记。
- 产出物发布后可编辑元数据，但内容版本必须保留。
- 删除使用 archive。

### 7.3 项目历史

项目历史必须只追加，覆盖：

- 项目基础信息。
- Owner、健康度、进度和日期变化。
- 成员添加、移除和状态变化。
- 项目角色草稿确认。
- 角色影响处理。
- 产出物创建、发布、归档。
- 模板应用。
- 项目归档和恢复。
- 与项目相关的身份 Grant 变化。

用户可按：

- 时间。
- 类别。
- Actor。
- 资源类型。
- 关键字。

筛选和分页。

### 7.4 角色草稿与确认

页面状态：

```text
有效角色集 + 当前草稿 = 工作副本
```

草稿支持：

- 新增角色。
- 修改角色 name、description、category、permissions。
- 删除角色。
- 从模板加载。
- 从其他项目按 code 合并。
- 取消编辑。
- 离开页面前未保存提示。

确认流程：

1. 客户端提交完整角色数组和 `expectedRevision`。
2. 服务端计算 added、updated、removed。
3. 校验 code 唯一、权限合法、Owner role 仍存在。
4. 校验被移除角色是否被项目工作流模板引用。
5. 计算成员影响和进行中任务影响。
6. 如存在成员影响，返回 `409 member_impact` 和影响明细。
7. 用户确认影响后重试，携带 `acknowledgeMemberImpact=true`。
8. 服务端加项目角色锁，再次验证 revision。
9. 整组覆盖项目角色。
10. 清理受影响成员角色关系。
11. 对引用已删除角色的任务标记 `needs_reassignment`。
12. 撤销对应 Project Grant。
13. `rolesRevision + 1`。
14. 写项目审计和 Grant 审计。
15. 提交后发布 Outbox 事件。

错误：

- `role_code_conflict`
- `role_name_conflict`
- `owner_role_required`
- `member_impact`
- `workflow_template_blocked`
- `roles_revision_conflict`
- `role_in_use_by_active_workflow`

### 7.5 角色删除影响

成员影响：

```json
{
  "memberId": "...",
  "principalId": "...",
  "displayName": "...",
  "removedRoleCodes": ["REVIEWER"]
}
```

任务影响：

```json
{
  "taskId": "...",
  "title": "...",
  "status": "queued",
  "removedRoleCode": "REVIEWER",
  "suggestedAction": "reassign"
}
```

工作流模板影响：

```json
{
  "workflowTemplateId": "...",
  "name": "...",
  "referencedRoleCodes": ["REVIEWER"]
}
```

规则：

- 被活动 Workflow Template 引用时阻止删除。
- 已完成或已归档模板可忽略。
- 已启动 Instance 不阻止，继续使用快照。
- 任务允许失去角色，但必须明确“需改派”。
- 角色 Grant 必须撤销。

### 7.6 已启动工作流角色快照

启动 Instance 时保存：

- 使用的 `rolesRevision`。
- 仅被流程实际引用的角色定义。
- role id、code、name、permissions。
- 快照 hash。

规则：

- 后续角色 name/code/permissions 变化不影响旧 Instance。
- 旧 Instance 页面显示启动时角色名。
- 快照成员被移出项目后，其旧事实仍显示。
- 没有操作权限的旧成员不能继续操作。
- 管理员可以显式改派节点。
- 历史 Instance 没有快照时标记 `legacy-live-roles`，不能声称已受保护。

## 8. 技术架构

```text
Web
  -> ProjectGovernanceApplication
  -> ProjectAuthorization
  -> ProjectRepository / ProjectRoleRepository / OutputRepository
  -> RoleGrantRepository
  -> WorkflowRepository / TaskRepository
  -> ProjectAudit
  -> Outbox
```

事务边界：

- Project metadata：单事务。
- Project Output：metadata 单事务，文件走 FileStore staging。
- Role Confirm：单事务锁定 project + roles + member roles + affected tasks。
- Workflow start snapshot：与 Instance 创建同一事务。

## 9. 数据模型

### 9.1 `projects` 扩展

| 字段 | 说明 |
| --- | --- |
| `owner_principal_id` | 当前 Owner |
| `health` | `healthy / watch / at_risk / blocked` |
| `health_reason` | blocked 等状态原因 |
| `progress` | 0-100 |
| `start_date` | DATE |
| `target_date` | DATE |
| `roles_revision` | 默认 1 |
| `roles_updated_at` | 最近确认 |
| `roles_updated_by` | Principal |
| `code_mode` | `manual / generated` |
| `sequence_number` | 全局项目序号 |
| `governance_version` | 乐观锁 |

### 9.2 项目全局编号

新增 `project_code_sequences`：

- sequence_name。
- next_value。
- updated_at。

建议：

- 新项目默认 `PRJ` + 6 位序号。
- 事务内使用行锁分配，不回退。
- 编号唯一且不可变。
- 现有手工 code 继续保留，标记 `manual`。
- 不批量重写已有 code，避免破坏外部引用。

### 9.3 `project_outputs`

| 字段 | 说明 |
| --- | --- |
| id | UUID |
| project_id | Project |
| title | 标题 |
| stage | 阶段 |
| theme | 主题 |
| summary | 摘要 |
| status | draft/published/archived |
| produced_at | 业务时间 |
| producer_principal_id | 产出者 |
| source_refs | JSONB 来源数组 |
| idempotency_key | 幂等键 |
| version | 版本 |
| created_at / updated_at | 时间 |

### 9.4 `project_output_files`

- output_id。
- entry_id 或 file metadata。
- role：primary/supporting。
- sha256。
- version。

若复用 Shared Space，保存 `shared_space_entry_id` 和版本；否则保存独立 FileStore
metadata。

### 9.5 `project_audit_events`

append-only：

- id。
- project_id。
- category。
- action。
- actor_principal_id。
- target_type / target_id。
- summary。
- before / after JSONB。
- metadata JSONB。
- created_at。

禁止 update/delete，通过数据库 trigger 保证。

### 9.6 `project_role_drafts`

| 字段 | 说明 |
| --- | --- |
| project_id | 主键 |
| base_revision | 草稿基于的有效 revision |
| document | 完整角色数组 JSONB |
| updated_by | Principal |
| updated_at | 时间 |
| version | 草稿并发版本 |

草稿不是授权事实，生效只来自 Confirm。

### 9.7 `project_role_revisions`

可选但推荐：

- project_id、revision。
- roles snapshot。
- changed_by、changed_at。
- diff。

用途：

- 实例回溯。
- 审计详情。
- 未来回滚设计。

### 9.8 `workflow_instances` 扩展

- `roles_revision_snapshot` INTEGER NULL。
- `role_snapshot` JSONB NULL。
- `role_snapshot_hash` TEXT NULL。

### 9.9 `tasks` 扩展

- `needs_reassignment` BOOLEAN DEFAULT FALSE。
- `reassignment_reason` TEXT NULL。
- `removed_role_id` UUID NULL。
- `removed_role_code` TEXT NULL。

保留现有 `tasks.role_id`，删除角色时设为 NULL。

## 10. API

### 10.1 项目概览

```text
GET   /api/v1/projects/:projectId/governance
PATCH /api/v1/projects/:projectId/governance
POST  /api/v1/projects/:projectId/owner-transfer
```

PATCH 使用 `expectedVersion`，返回 before/after 审计摘要。

### 10.2 产出物

```text
GET   /api/v1/projects/:projectId/outputs
POST  /api/v1/projects/:projectId/outputs
GET   /api/v1/projects/:projectId/outputs/:outputId
PATCH /api/v1/projects/:projectId/outputs/:outputId
POST  /api/v1/projects/:projectId/outputs/:outputId/publish
POST  /api/v1/projects/:projectId/outputs/:outputId/archive
```

### 10.3 历史

```text
GET /api/v1/projects/:projectId/history
GET /api/v1/projects/:projectId/history/:eventId
```

查询：

- cursor。
- limit。
- category。
- actorPrincipalId。
- action。
- from/to。
- query。

### 10.4 角色草稿

```text
GET  /api/v1/projects/:projectId/role-draft
PUT  /api/v1/projects/:projectId/role-draft
DELETE /api/v1/projects/:projectId/role-draft
POST /api/v1/projects/:projectId/role-draft/import-template
POST /api/v1/projects/:projectId/role-draft/import-project
POST /api/v1/projects/:projectId/roles/confirm
GET  /api/v1/projects/:projectId/roles/impact
```

Confirm 输入：

```ts
{
  expectedRevision: number;
  roles: ProjectRoleDraft[];
  acknowledgeMemberImpact?: boolean;
  acknowledgeTaskReassignment?: boolean;
}
```

Confirm 输出：

```ts
{
  project: Project;
  revision: number;
  diff: {
    added: string[];
    updated: string[];
    removed: string[];
  };
  impacts: {
    members: MemberImpact[];
    tasks: TaskImpact[];
    workflowTemplates: WorkflowTemplateImpact[];
  };
}
```

## 11. 授权

| 操作 | 权限 |
| --- | --- |
| 查看治理概览 | Project `read` |
| 编辑概览 | Project `write` 或 Owner |
| 转移 Owner | Project `manage_members` + 管理权限 |
| 管理产出物 | Project `write`，发布可选 `approve` |
| 查看历史 | Project `read`，敏感详情可 `approve` |
| 编辑角色草稿 | Project `manage_roles` |
| 确认角色 | Project `manage_roles` |
| 调整成员影响 | Project `manage_members` |
| 修改工作流模板引用 | 对应模板管理权限 |

Platform ADMIN 仍不绕过 Project Grant。

## 12. 并发与事务

### 12.1 Metadata

```text
SELECT project FOR UPDATE
  -> compare governance_version
  -> update
  -> append audit
```

### 12.2 Role Confirm

锁顺序固定：

```text
project
  -> project roles
  -> project member roles
  -> project grants
  -> affected tasks
  -> audit/outbox
```

避免与 Workflow start 的锁顺序相反。

### 12.3 Owner Transfer

- 锁定 Project 和两个成员。
- 新 Owner 必须 active 且是 Human Project Member。
- 新 Project Owner Grant、旧 Grant 撤销和 metadata 更新同事务。
- 写 before/after 审计。

## 13. Migration

建议加法 Migration：

1. `projects` 增加治理字段，`roles_revision` 默认 1。
2. 回填 `owner_principal_id`：
   - 优先 explicit Project Owner Grant。
   - 其次唯一 legacy owner。
   - 冲突时停在该项目并输出报告，不自动猜测。
3. 回填 health `healthy`、progress `0`。
4. 现有 code 标记 manual。
5. 新建 outputs、output files、audit、drafts、revisions。
6. 新建 project code sequence。
7. `workflow_instances` 增 snapshot 列。
8. `tasks` 增 reassignment 字段。
9. 不重写历史审计。

升级门禁：

- fresh `0 -> N`。
- `N-1 -> N`。
- 已有 Project 全有 Owner 或明确报告。
- Project Grant 与 Owner 来源一致。
- 任务、Workflow、Report 和 Meeting 关联不丢失。

## 14. GUI 交互

### 14.1 概览编辑

- 字段就地编辑。
- 日期和进度有校验。
- blocked 需要原因。
- 保存和取消清晰。
- 并发冲突保留用户输入，提示刷新并重试。

### 14.2 角色工作台

三栏或两栏布局：

- 左：有效角色和草稿差异。
- 中：角色编辑。
- 右：影响预览。

顶部固定：

- 基于 revision。
- 保存草稿。
- 确认生效。
- 取消编辑。
- 冲突状态。

角色行状态：

- added。
- updated。
- removed。
- unchanged。
- blocked-by-workflow。

### 14.3 影响确认

确认弹层必须分组展示：

- 成员失去角色。
- 任务需改派。
- 工作流模板阻塞。

用户可以取消，不会写入部分变更。

### 14.4 历史

- 时间线为主要形态。
- 详情 drawer 显示 before/after。
- 审计 ID 和 Actor 可复制。
- 敏感字段脱敏。

## 15. 测试

### 15.1 Database

- 项目唯一编号并发分配。
- Owner Grant 双源一致。
- role revision 并发确认只有一个成功。
- append-only project audit。
- 移除角色撤销 Grant。
- 任务置 needs_reassignment。
- Workflow snapshot hash 稳定。

### 15.2 API

- 非成员、跨项目、revoked/expired Grant。
- Platform ADMIN 不绕过 Project。
- member impact 未确认时 409。
- workflow template blocked 时 409。
- archived Project 只读。
- output 幂等创建。
- history cursor 和过滤。

### 15.3 GUI

- 编辑概览并刷新恢复。
- 角色草稿新增、修改、删除。
- 影响确认和取消。
- 并发 revision 冲突。
- 历史过滤。
- 1440、900、390。

## 16. 分期

### Phase 1：概览与历史

- Owner、health、progress、dates。
- project audit。
- 全局编号。

### Phase 2：产出物

- outputs 和 source refs。
- publish/archive。
- 与 Workflow Deliverable、Meeting、Task 的来源链接。

### Phase 3：角色草稿

- drafts。
- revision。
- impact API。
- confirm 事务。

### Phase 4：快照与改派

- workflow role snapshot。
- task needs_reassignment。
- GUI 改派流程。

## 17. 风险

| 风险 | 控制 |
| --- | --- |
| Owner 双源漂移 | Project Grant 为授权事实，实时一致性报告 |
| 编号冲突 | 事务序列 + 唯一索引 |
| 角色并发覆盖 | expectedRevision + project lock |
| 角色删除断链 | impact preview + task reassignment |
| 旧实例漂移 | 启动时角色快照 |
| 审计被修改 | append-only trigger |
| 历史数据无法回填 Owner | 报告冲突，不自动猜 |

## 18. 完成定义

- 用户能查看和编辑项目治理字段。
- 能创建阶段产出物并追溯来源。
- 能查看只追加项目历史。
- 角色修改使用草稿和整组确认。
- 影响确认、revision 冲突和 Workflow 快照全部有测试。
- Project Governance 从 `PARTIAL/MISSING` 变为 `EQUIVALENT` 或 `STRONGER`。
