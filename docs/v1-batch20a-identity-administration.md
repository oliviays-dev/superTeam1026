# V1 Batch 20A: Identity Administration

> 状态：已完成，本地 commit，未 push
>
> 分支：`feat/v1-batch20a-identity-admin`
>
> 基线：`main` / `e1dca0dc1da3ebd3a41373172eda0082842e1d80`
>
> Migration：32（additive）

## 1. 范围与结论

Batch 20A 补齐多用户上线所需的 Identity Administration 闭环：

- Human Principal、Account、Credential 的创建、邀请、资料更新和启停。
- 一次性激活凭据的签发、消费、撤销和受控重置。
- Platform Role/Grant 的目录、查询、授予、续期和撤销。
- Workspace 列表、成员状态、Workspace Grant 和到期管理。
- 管理员账号目录、搜索、分页、状态和身份审计详情。
- Platform ADMIN 与 Workspace Grant 的服务端授权边界。

本批复用既有 `principals`、`accounts`、`account_credentials`、
`auth_sessions`、`workspace_members`、`role_grants` 和
`identity_audit_events`，没有建立第二套账号、权限或审计事实。

不在本批范围：

- Batch 19 Shared Space、路径级权限、Global Write、Locks 或 sandbox。
- Batch 20 Project Governance、Workbench 可配置布局或 Brief SSE。
- Global Write、Lane 级路径权限、通用 Human Avatar。
- 15A Execution Envelope、15B Ticket/Gate、16 Scene Session/Cursor/Receipt
  的任何语义变化。

WorkBuddy 仍只使用 plain-text、stdin Prompt 和 final-only stdout。未知 Provider、
模型和 Runtime 信息仍保持 unknown。

## 2. Migration 32

Migration 32 为 additive migration：

1. 新增 `workspaces` 管理投影表：
   - `id`、`display_name`、`status`、`created_by_principal_id`、version 和时间字段。
   - 只服务 Workspace 身份管理面，不取代 Project、Runtime 或 Scene 的资源事实。
2. `workspace_members` 新增 `version`，默认 `1`，用于成员状态并发保护。
3. 增加账号状态/登录 ID、身份审计 account/action 查询索引。
4. 从现有 `workspace_members.workspace_id`、`role_grants.scope_id`
   （`scope_type = workspace`）和 `external_runtimes.workspace_id` 去重回填
   `workspaces`。回填名称使用原 Workspace ID。

兼容读取：

- 既有 `workspace_members`、Workspace `role_grants` 和 Runtime workspace 语义不变。
- 既有 `/api/v1/workspaces/:workspaceId/runtimes` 与
  `/runtime-economics` 仍按 Project Grant 授权，不被 Identity Workspace 路由接管。
- 历史 Grant 和审计不修改；Migration 32 只新增结构、索引和管理投影。

回滚：

1. 先回滚应用。
2. 停止 Workspace 身份管理写入。
3. 删除 `workspaces_status_name_idx`、`accounts_status_login_idx`、
   `identity_audit_account_idx`、`identity_audit_action_idx`。
4. 删除 `workspace_members.version` 和 `workspaces` 表。
5. 最后删除 `platform_migrations.version = 32`。

回滚会丢失 Workspace 管理名称/状态，但不删除 Principal、Account、Credential、
Workspace Membership、Grant 或审计历史。

## 3. Credential 安全语义

账号创建支持两种初始化方式：

| 方式 | Account | Credential | 响应 |
| --- | --- | --- | --- |
| 管理员初始密码 | `active` | scrypt 密码 Hash，`active` | 不返回密码 |
| 邀请 | `pending` | 一次性 Token 的 SHA-256，`pending` | 仅创建时返回一次 Token |

重置流程：

```text
active Account
  -> 生成 32-byte 随机一次性 Token
  -> account_credentials 只保存 SHA-256
  -> Credential 改为 pending
  -> 撤销该 Principal 全部 Auth Session
  -> 管理员通过安全渠道交付 Token
  -> 用户提交 Token + 新密码
  -> 服务端再次 scrypt 后激活 Credential
```

安全约束：

- 数据库不保存可恢复密码或一次性 Token 明文。
- 审计只记录 action、原因、主体、账号、Grant 和过期时间，不记录密码或 Token。
- Token 消费使用行锁和 `pending` 条件，并发重放最多成功一次。
- disabled Account、archived/suspended Principal、过期 Token 均 fail closed。
- Account/Credential 激活和状态变化通过既有 Auth Session 门禁即时生效。

## 4. 授权边界

平台管理路由：

- `/api/v1/admin/accounts*`
- `/api/v1/admin/platform-roles`
- `/api/v1/admin/platform-grants*`
- `/api/v1/admin/identity-audit`

这些路由要求 active Platform `ADMIN` Grant。

Workspace 路由：

- `/api/v1/workspaces`：返回当前 Principal 可见 Workspace；Platform ADMIN 可见全部。
- `/api/v1/workspaces/:workspaceId`：Platform ADMIN，或该 Workspace 的 active
  `read` Grant。
- 成员写：Platform ADMIN，或 Workspace `manage_members` Grant。
- Workspace 资料/Grant 写：Platform ADMIN，或 Workspace `manage_roles` Grant。

约束：

1. Platform ADMIN 只获得平台身份管理能力，不产生 Project membership 或 Project Grant。
2. Project 读写继续走既有 Project RBAC；本批没有扩大 Platform ADMIN 的 Project 权限。
3. Workspace Membership 与 Workspace Grant 分离；成员关系本身不隐式产生授权。
4. revoked/expired Grant 不参与授权。
5. 最后一个 active Platform ADMIN Grant 不能撤销；没有其他有效管理员时，该账号
   不能停用或签发重置凭据。
6. 最后一个 active Workspace ADMIN 成员/Grant 不能移除或撤销。

## 5. API

账号与凭据：

```text
GET    /api/v1/admin/accounts
POST   /api/v1/admin/accounts
GET    /api/v1/admin/accounts/:accountId
PATCH  /api/v1/admin/accounts/:accountId
POST   /api/v1/admin/accounts/:accountId/credential
POST   /api/v1/accounts/:accountId/status
POST   /api/v1/auth/credential-activations
```

Platform Grant：

```text
GET    /api/v1/admin/platform-roles
GET    /api/v1/admin/platform-grants
POST   /api/v1/admin/platform-grants
PATCH  /api/v1/admin/platform-grants/:grantId/expiry
POST   /api/v1/admin/platform-grants/:grantId/revoke
```

Workspace：

```text
GET    /api/v1/workspaces
POST   /api/v1/workspaces
GET    /api/v1/workspaces/:workspaceId
PATCH  /api/v1/workspaces/:workspaceId
POST   /api/v1/workspaces/:workspaceId/members
PATCH  /api/v1/workspaces/:workspaceId/members/:memberId
POST   /api/v1/workspaces/:workspaceId/grants
PATCH  /api/v1/workspaces/:workspaceId/grants/:grantId/expiry
POST   /api/v1/workspaces/:workspaceId/grants/:grantId/revoke
```

审计：

```text
GET /api/v1/admin/identity-audit
```

稳定冲突码：

- `account_exists`
- `login_id_conflict`
- `principal_archived`
- `principal_not_human`
- `account_disabled`
- `credential_activation_invalid`
- `grant_exists`
- `grant_not_active`
- `last_platform_admin`
- `last_workspace_admin`
- `workspace_archived`
- `membership_exists`
- `version_conflict`

## 6. Web

新增“账号与权限”工作面：

- 账号目录、搜索、状态过滤和分页。
- 邀请/初始密码创建，只显示一次的激活凭据。
- Principal 资料更新、账号启停、Credential 重置。
- Platform Role 与 Grant 查询、授予、到期和撤销。
- Workspace 创建、成员状态、Workspace Grant 创建、续期和撤销。
- 身份审计过滤和详情。

非 Platform ADMIN 不显示账号、平台 Grant 和身份审计入口，只保留其有权访问的
Workspace 面；服务端仍是最终授权边界。

## 7. 验证

已执行：

- `pnpm run typecheck`
- `pnpm run lint`
- 完整 Vitest：63 files / 294 tests
- Migration fresh `0 -> 32`
- Migration upgrade `31 -> 32`
- Workspace 回填断言
- Identity Administration Playwright：2 scenarios
- Project RBAC Playwright：1 scenario
- Identity Administration 1440/900/390 截图与页面级横向溢出检查
- Web production build
- `git diff --check`

定向测试覆盖：

- 邀请创建、一次性激活、重复消费。
- 密码/Token 不进入审计，Token 只保存 SHA-256。
- 并发创建账号与 Grant 的稳定 201/409 结果。
- disabled Account、archived Principal 和重复成员冲突。
- Platform Grant 到期、续期、撤销、重复撤销，以及最后管理员的撤销、停用和
  Credential 重置保护。
- Workspace Grant 到期更新、撤销后即时 403、Platform ADMIN 仍可管理。
- 非管理员账号目录 fail closed。

## 8. 已知限制

- 邀请 Token 通过 API/Web 只返回一次，实际交付仍依赖管理员使用安全渠道；未集成邮件。
- 登录 Rate Limit、账号锁定、MFA、SSO 和密码找回仍按原认证批次限制处理。
- 单一管理员环境无法通过管理 API 停用或重置自己；上线时应至少保留两个有效
  Platform ADMIN，或使用受控的离线恢复流程。
- `workspaces` 是身份管理投影；Project/Runtime 的 workspace ID 语义保持原事实来源。
- 本批没有实现 Shared Space、sandbox、Global Write、Lane 路径权限或 Human Avatar。
- 未执行 Batch 19、Batch 20 或 Batch 21，也未读取正式 Session/Profile/业务数据库。

## 9. 远端状态

- 本地分支独立开发。
- 完成后只创建本地 commit。
- 未 push，远端分支状态不变。
