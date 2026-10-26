# V1 Batch 14A: Principal / RBAC 数据模型与认证边界

> 状态：规范模型已落 Contracts 与 Migration 24；运行时认证/授权改造未在本批实施

## 1. 核心不变量

```text
Principal = 谁
Account   = Human Principal 如何登录
Credential = 登录凭据/方法
Session   = 一次 Bearer 认证上下文
Member    = Principal 在某范围的成员事实
RoleGrant = Principal 在某范围能做什么
Alias     = 历史/外部 ID 到 Principal 的只读解析
Link      = 外部权威身份源到 Principal 的同步关系
```

约束：

1. Human Principal 和 AI Principal 共用同一 Principal/Grant 模型。
2. Account 只属于 Human Principal；AI Principal 永远不能拥有 Account。
3. Alias 不是身份、不是认证凭据，也不授予权限。
4. Principal 状态与 Account/Credential/Session 状态必须同时通过认证门禁。
5. Owner、Persona、Agent 名称和 Runtime Profile 都不产生权限继承。
6. 新敏感动作必须留下 Principal、Scope、Grant/Run/Ticket 关联。
7. 规范引用为 `principal:<principalId>`；裸 ID 只允许兼容解析。

## 2. 实体关系

```text
Human Principal ── 0..1 Account ── * Credential
        │                 │
        │                 └── * Bearer Session
        ├── * WorkspaceMember
        ├── * RoleGrant
        ├── * ExternalIdentityLink
        └── * PrincipalAlias

AI Principal ── * Agent
        ├── * Runtime Profile（后续批次）
        ├── * RoleGrant
        └── * PrincipalAlias
```

`ProjectMember` 是 Project 域中的成员投影。目标状态应引用 `principal_id`；
迁移期继续保留旧 `kind + actor_id + is_owner`，以 Compatibility Resolver 双读。

## 3. Principal

| 字段 | 规则 |
| --- | --- |
| `id` | 全局稳定 TEXT，1–180 字符；迁移时优先保留旧 Principal ID |
| `kind` | `human / ai`，创建后不可改变 |
| `displayName` | 展示名，不参与唯一认证 |
| `status` | `active / suspended / archived` |
| `statusAuthority` | `account / ai-companion / hrm / legacy / system` |
| `source` | `local / account / ai-companion / agent / hrm / system` |
| `version` | 乐观锁 |
| `createdAt/updatedAt` | UTC |

状态规则：

1. `archived` 是终态，不接收新 Grant，不参与新运行。
2. `suspended` 禁止新建 Session 和新敏感动作，但历史审计和 Grant 保留。
3. 账号安全停用只暂停登录资格，不自动删除项目成员、历史 Grant 或审计。
4. HRM 离职可以归档 Principal 并停用 Account；手动 Account 停用不能自动解释为离职。
5. 旧 Employee 状态只通过 `statusAuthority = legacy` 进入迁移期；目标写入后逐步消失。

## 4. Account / Credential / Session

### 4.1 Account

| 字段 | 规则 |
| --- | --- |
| `id` | 保留旧 `users.id` 或新生成稳定 ID |
| `principalId` | 唯一；必须指向 Human Principal |
| `loginId` | 大小写不敏感唯一 |
| `status` | `active / pending / disabled` |
| `version` | 乐观锁 |

一个 Human Principal 最多一个主 Account。SSO/OIDC 的多个外部主体通过
`ExternalIdentityLink` 或 Credential 表达，不复制 Human Principal。

### 4.2 Credential

支持 `password | sso`。密码只存 scrypt 等可验证 Hash，不存明文。

状态：

```text
pending -> active -> disabled
                    └-> revoked
```

同一 Account 的同一 Credential Type 最多一个 active，避免“密码已撤销但仍可登录”。

### 4.3 Bearer Session

Session 保存 `token_hash`，不保存 Bearer 明文。默认 TTL 仍可沿用旧实现，但必须
支持：

1. 过期拒绝。
2. 主动吊销。
3. Account 停用时批量吊销。
4. Principal 非 active 时立即失效。
5. AI Principal 不能创建 Bearer Session。
6. Session 的 `principal_id` 必须与 Account 的 `principal_id` 一致，数据库触发器
   对不匹配写入直接拒绝。

### 4.4 人类访问判定

```text
human access =
  Principal.status = active
  AND Account.status = active
  AND Credential.status = active
  AND Session.status = active
  AND Session.expires_at > now
```

契约函数 `evaluateHumanSessionAccess` 已实现 fail-closed 判定；它只是纯模型，
尚未接入 API 中间件。

### 4.5 状态映射

| 事件 | Principal | Account | Credential | Session |
| --- | --- | --- | --- | --- |
| 初始化邀请 | active | pending | pending | 无 |
| 首次激活 | active | active | active | 新建 |
| 密码修改 | 不变 | 不变 | 更新 Hash | 除当前外吊销 |
| 手动账号停用 | suspended（authority=account） | disabled | disabled | 全部吊销 |
| 账号重新启用 | active（若未被 HRM/archive 约束） | active | active | 无，重新登录 |
| HRM 离职 | archived（authority=hrm） | disabled | disabled/revoked | 全部吊销 |
| AI Companion 暂停 | suspended（authority=ai-companion） | 无 | 无 | 无 |
| AI Companion 归档 | archived | 无 | 无 | 无 |

`archived` 与 `hrm` 权威状态不能被普通账号重新启用覆盖。

## 5. WorkspaceMember

Workspace Member 只表示“此 Principal 属于该 Workspace”，不含角色。

```text
workspace_members(workspace_id, principal_id, status)
```

角色由 `role_grants(scope_type = workspace, scope_id = workspaceId)` 表达。
Workspace Membership 失效时，Workspace Grant 不应继续产生访问；历史 Grant 保留。

14A 不新增 Workspace API。现有旧 Workspace ID 作为 TEXT 保留，避免在没有 V1
Workspace 主表时伪造 FK。

## 6. ExternalIdentityLink 与 Alias

### 6.1 ExternalIdentityLink

| 字段 | 规则 |
| --- | --- |
| provider | `hrm`、OIDC、SCIM 等外部系统标识 |
| externalSubjectId | 外部系统稳定 Subject |
| principalId | 对应 Human/AI Principal |
| status | `active / retired` |
| syncVersion | 外部同步版本 |
| syncedAt | 最近同步时间 |

同一 `(provider, externalSubjectId)` 只能映射一个 Principal。它是同步/审计关系，
不是登录 Token，也不直接授予平台权限。

### 6.2 Alias

允许类型：

```text
auth-user | employee | teammate | agent | runtime-profile | legacy-actor | external
```

解析顺序：

1. `principal:<id>` 精确匹配 Principal。
2. `aliasType + aliasValue` 精确匹配 Alias。
3. 裸 ID 仅在兼容期按受限顺序解析，并记录冲突。

Alias 不进入认证流程，不替代 ExternalIdentityLink，不用于新 API 写模型。

## 7. RoleGrant

### 7.1 模型

| 字段 | 规则 |
| --- | --- |
| principalId | 被授权 Principal |
| scopeType | `platform / workspace / project` |
| scopeId | Platform 固定 `platform`；其他为实体 ID |
| roleKey | 稳定角色键；动态项目角色使用 `project-role:<id>` 或项目角色 code |
| permissions | 该 Grant 的有效权限快照，去重 |
| status | `active / revoked / expired` |
| sourceKind | manual / legacy / template 来源 |
| sourceRef | 幂等迁移和审计来源 |
| grantedBy/revokedBy | Principal |
| grantedAt/expiresAt/revokedAt | 生效与撤销事实 |

同一 Principal、Scope、Role 最多一个 active Grant；历史撤销记录保留。

### 7.2 Scope 与权限

| Scope | 典型 Role | 说明 |
| --- | --- | --- |
| Platform | `ADMIN`、`MEMBER` | 平台管理，不等于全部项目权限 |
| Workspace | `owner`、`member`、`guest` | Workspace 成员范围 |
| Project | `PROJECT_OWNER`、项目自定义角色 | 项目内权限 |

权限不从父 Scope 自动继承。平台管理员如要操作项目，仍需经过明确的平台管理权限
或项目 Grant 规则；跨 Scope 的“管理员旁路”必须显式编码和审计。

### 7.3 与现有模型兼容

| 现有模型 | 目标映射 | 14A 策略 |
| --- | --- | --- |
| `users.role` | Platform Grant | dry-run 映射，不删除旧列 |
| Workspace Member 角色 | Workspace Grant | 统一来源前保持只读兼容 |
| Employee role assignment | Workspace Grant | 只作为旧来源，不新增第二写源 |
| `project_members` | Project Principal 投影 | nullable `principal_id`，不 backfill |
| `project_member_roles` | Project Grant | 由 Alias + roleKey 映射 |
| `project_members.is_owner` | `PROJECT_OWNER` Grant | 保留 bool，做一致性报告 |
| Agent owner | 业务负责人 Alias/字段 | 不产生权限 |
| AI Companion owner | 业务负责人字段 | 不产生平台角色 |

兼容判定：

```text
project manage =
  active Principal/legacy member
  AND (
    migrated active PROJECT_OWNER Grant
    OR legacy project_members.is_owner = true
  )
```

正式切换前必须禁止两个来源产生不同 owner 结论。

## 8. 认证中间件边界

目标执行顺序：

```text
request-id / trace
  -> parse Bearer
  -> resolve Session
  -> resolve Principal/Account/Credential
  -> reject inactive
  -> inject RequestPrincipal
  -> route validation
  -> authorization
  -> application service
  -> identity/audit event
```

注入对象最小化：

```ts
interface RequestPrincipal {
  principalId: string;
  principalKind: "human" | "ai";
  accountId?: string;
  sessionId?: string;
  authSource: "bearer" | "local-development";
}
```

规则：

1. 业务服务不得读取原始 `Authorization` Header。
2. Token 不写日志、Trace、Audit 或错误响应。
3. 缺少凭据返回 401；Principal/Account/Credential inactive 也返回稳定的 401。
4. 权限不足返回 403；不能通过 404/500 隐藏认证配置错误。
5. `x-pluginmax-actor` 只在显式 `local-development` 模式启用，生产模式禁止回退。
6. AI Run 不接收人类 Bearer；后续使用 Worker 签发、短时有效的 Action Ticket。

## 9. 审计模型

`identity_audit_events` 为 append-only：

| 字段 | 用途 |
| --- | --- |
| action | login/account/grant/session/principal 操作 |
| decision | allowed / denied |
| actorPrincipalId | 操作者 |
| subjectPrincipalId | 被操作主体 |
| accountId/sessionId | 认证上下文 |
| grantId | 授权变更关联 |
| reason | 拒绝或敏感变更原因 |
| metadata | 非秘密结构化上下文 |

Grant 变更、Account 启停、Session 吊销、Principal 归档必须写审计。数据库触发器
拒绝 `UPDATE` 和 `DELETE`。

## 10. Contracts 与 Migration 24

新增 Contracts：

- `Principal`
- `Account`
- `AccountCredential`
- `BearerSession`
- `WorkspaceMember`
- `ExternalIdentityLink`
- `PrincipalAlias`
- `RoleGrant`
- `IdentityAuditEvent`
- `evaluateHumanSessionAccess`
- `principalReference` / `parsePrincipalReference`

Migration 24 新增：

- 9 张 Identity/Principal/RBAC 表。
- `agents.principal_id`、`project_members.principal_id`。
- `runs.agent_principal_id`、`runs.initiated_by_principal_id`。
- Human-only Account 约束、active Grant 唯一约束、append-only 审计约束。
- 全部新增关联列 nullable；没有回填，没有删除或重命名旧列。
