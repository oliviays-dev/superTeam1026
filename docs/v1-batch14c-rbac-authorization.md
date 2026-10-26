# V1 Batch 14C: RBAC 消费与身份审计

> 状态：统一授权门禁、项目 Grant 消费、撤销即时生效、身份审计和多 Principal
> Playwright 场景已完成。Migration 24 足够，本批未新增 Migration 25，未执行旧数据
> backfill，也未修改 Batch 14B 的 Password/Session 语义。

## 1. 授权入口

认证仍由 Batch 14B 的 Bearer Session 完成。认证结果作为可信 Principal 注入请求；
授权层只消费该 Principal，不重新读取 Authorization，也不信任客户端提交的
`x-pluginmax-authenticated-*` Header。

```text
Bearer Session
  -> active Human Principal / Account / Credential / Session
  -> trusted Principal
  -> AuthorizationService
  -> platform / workspace / project Grant
  -> membership and permission check
  -> application service
```

`AuthorizationRepository` 是唯一授权解析与 Grant 镜像入口。`AuthorizationService`
负责 HTTP 写路由到权限的映射。未显式分类的写路由默认 fail closed。

## 2. Scope 与权限

支持三个互不继承的 Grant Scope：

| Scope | Membership 事实 | Grant | 本批消费 |
| --- | --- | --- | --- |
| Platform | Principal 本身 | `scope_type=platform`, `scope_id=platform` | ADMIN 管理操作、MEMBER owner-scoped 平台资源 |
| Workspace | `workspace_members` | `scope_type=workspace` | 统一 Service/Repository 消费；当前 Platform API 尚无 Workspace 主表 |
| Project | 当前项目的 `project_members` | `scope_type=project` | 项目、任务、Workflow、Meeting、Memory、Handoff 等写操作 |

权限值：

```text
read
write
approve
manage_members
manage_roles
platform.access
platform.manage
```

关键边界：

1. Platform `ADMIN` 只产生 `platform.manage`，不是项目 Grant。
2. 任一项目写操作都需要当前项目的 active membership 与 active Project Grant。
3. Workspace Grant 不会自动映射为 Project Grant，反之亦然。
4. Grant 必须未过期； revoked/expired Grant 不参与权限计算。

## 3. 项目角色与 Grant

项目成员角色发生变化时，服务在同一事务内同步 `role_grants`：

```text
role_key   = project-role:<projectRoleId>
scope_type = project
scope_id   = <projectId>
permissions = project_roles.permissions
source_ref = project-member:<memberId>:role:<roleId>
```

行为：

1. 新增角色立即产生 active Grant。
2. 修改角色 permissions 立即更新所有已分配成员的 Grant 快照；后续请求立即使用新权限。
3. 移除角色将对应 Grant 标为 revoked，历史行保留。
4. 重新分配同一角色会插入新的 active Grant，不复用 revoked 行。
5. 成员停用或删除会撤销该成员的项目 Grant。
6. 已开始的 Run 不重新计算执行中权限；本批未引入 TaskExecutionPolicy、Action
   Ticket 或 Execution Gate，后续请求按最新 Grant 判断。

## 4. PROJECT_OWNER 双源兼容

新建项目的 owner 显式写入：

```text
Project Grant: role_key = PROJECT_OWNER
Legacy 字段:   project_members.is_owner = true
```

迁移期为 nullable `project_members.principal_id` 提供受控兼容：

1. 先按 `principal_id` 精确匹配成员。
2. 再通过该 Principal 的 active aliases 唯一匹配 legacy `actor_id`。
3. `is_owner=true` 仅在该成员从未存在显式 `PROJECT_OWNER` Grant 历史时作为
   `legacy-owner` 使用。
4. 一旦存在显式 owner Grant 历史，撤销后不会回退到 `is_owner`。
5. `GET /api/v1/projects/:projectId/authorization-report` 返回 legacy/grant owner
   来源、每个成员的 Grant、权限和一致性。

该报告用于迁移审计，不代表两个来源永久双写。目标状态仍以 explicit Project Grant
为唯一授权事实。

## 5. Principal 到 legacy actor

兼容解析顺序：

```text
principal:<principalId> -> exact Principal
<known-prefix>:<value>   -> active principal_aliases
bare id                  -> exact Principal id, then active aliases
```

裸 ID 若命中多个 Principal 则拒绝并记录 `membership_ambiguous` 或
`principal_reference_ambiguous`。解析不接受 `x-pluginmax-actor` 作为 Bearer 回退。

## 6. 高风险写路由

| 路由范围 | 权限 |
| --- | --- |
| Account / Job / Operations / Template 管理 | `platform.manage` |
| Project 创建 / Agent 与 Runtime owner-scoped 写 | `platform.access` |
| Project 基本写 | `write` |
| 项目角色写 | `manage_roles` |
| 项目成员写、任务转派 | `manage_members` |
| Review、审批、会议纪要发布、Memory Truth 发布 | `approve` |
| 任务、Workflow、Meeting 等按资源 ID 写 | 先解析资源所属项目，再校验 Project Grant |
| Direct Chat / personal Workbench | 仅当前 Principal 的 self scope；应用层继续校验资源归属 |

项目 archived 返回既有 `409 project_archived`，不存在项目返回 `404`，其余授权不足
统一返回 `403 forbidden` 与结构化 rejection reason。

## 7. 审计

`identity_audit_events` 继续作为 append-only 审计：

1. 授权允许与拒绝写 `authorization.http.*`。
2. Project Grant 创建、权限更新和撤销写 `authorization.project_grant.*`，关联 `grant_id`。
3. 拒绝元数据包含 Principal、Scope、Permission、reason、membership 和 owner 来源一致性。
4. 项目角色变更请求至少产生允许审计；Grant 变化另写 grant-level 审计。

## 8. local-development

`local-development` 只在显式模式启用：

1. 每个 local actor 被显式建立为 Human Principal。
2. 自动写入 active Platform `MEMBER` Grant，权限仅为 `platform.access`。
3. 默认 `LOCAL_ACTOR_ID` 额外获得 Platform `ADMIN` Grant。
4. 普通 local actor 不获得 ADMIN，也不获得任何 Project Grant。
5. Bearer 模式没有 Header actor 回退。

## 9. Migration 评估与回滚

Migration 24 已具备：

- `principals` / `accounts` / `auth_sessions`
- `workspace_members`
- `principal_aliases`
- `role_grants` 与其 active 唯一索引
- `identity_audit_events`
- `project_members.principal_id`

14C 只消费这些结构，因此不需要 Migration 25。项目 owner 双源报告采用实时查询，
不新增投影表；Grant 镜像写入已有表。

回滚说明：

1. 回滚应用提交即可恢复旧授权消费；Migration 24 表与 nullable 列保留。
2. 本批没有 backfill 脚本，也没有 `migration_run_id` 回滚范围。
3. 已写入的 `role_grants` 和 `identity_audit_events` 不删除；若业务需要撤销，
   应追加 revoked Grant 与审计事件。
4. 不恢复 Bearer Header actor 回退。

## 10. 本批边界

未实现：

- TaskExecutionPolicy
- Action Ticket / Execution Gate
- Scene Context
- Shared Space
- sandbox
- 登录 Rate Limit、MFA、SSO

本批不声称 Batch 15A / 15B 已完成。

## 11. 验证

- 定向 Repository / Application / API RBAC 测试。
- 完整 Vitest。
- Platform ADMIN 跨项目、非成员、跨项目、角色权限收紧、Grant 撤销、disabled
  Account、archived Principal、AI Principal 无 Grant 测试。
- 三角色真实登录 Playwright：Owner、Member、Platform Admin。
- Web production build、typecheck、lint、相关 package/API 构建与 `git diff --check`。
