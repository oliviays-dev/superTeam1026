# V1 Batch 14B: Identity / Principal 旧数据只读 dry-run

> 状态：只读 adapter、synthetic dry-run、稳定 JSON/Markdown 报告和定向测试已完成。
> 正式旧数据快照、账号权威源和必须自动合并的规则尚未确认；本批不执行 backfill。

## 1. 边界

本批只处理迁移前审计：

- Migration 仍为 24，不新增或执行 backfill。
- 不读取正式数据库、正式 `DSH_HOME`、正式 Session/Profile 或历史批次 worktree。
- 不修改 API、UI、认证中间件、Action Ticket、Shared Space 或 sandbox。
- 所有 fixture、日志、测试产物和报告均位于当前 worktree 的 `.tmp`。

本批的 synthetic 报告只证明 adapter/report 的确定性，不代表任何真实 DSH 的用户数量、
账号映射或可迁移状态。

## 2. 已审计的数据形状

以下结论来自当前 worktree 中的插件 Domain schema 与迁移设计，不是对真实数据的统计。

| Domain | 关键形状 | Dry-run 处理 |
| --- | --- | --- |
| `collab_team` | `users` 包含账号、角色、状态和 `passwordHash`；`workspace_members` 按 workspace 保存嵌套成员数组；`auth_sessions` 保存 `tokenHash`、用户和过期时间；`audit_log` 保存 actor。 | 账号转 Account 候选；Hash 仅识别 `scrypt`/unknown 与状态；Session 只计数，不迁移；audit actor 单独解析。 |
| `collab_principal` | `principals`、`principal_links`、`role_grants`；若快照已带显式 `external_identity_links`，也作为 ExternalIdentityLink 候选来源。 | 已有 Principal、subject link、Grant 和显式外部身份记录作为已有映射来源；link 冲突或目标缺失直接报告；不从 email/显示名推断外部身份。 |
| `collab_employee` | `employees` 区分 human/digital，human 可引用 `authUserId`；`role_assignments` 可包含 Principal 和 workspace 权限；Runtime Profile、Action Ticket、Delegation 的 Principal 字段可为空。 | 生成 Human/AI Principal、Workspace Grant 候选；缺 Principal 的 Runtime Profile/Ticket/Delegation 进入 blocked。 |
| `collab_teammate` | 实例可引用 `employeeId`、`principalId`，并有 `ownerUserId`。 | 与 Employee Principal 合并仅在显式 link/ID 一致时成立；缺 Employee 为 orphan。 |
| `collab_assignment` | `workspaces.seats` 定义项目角色；`assignments` 以 `assigneeKind + assigneeId` 指向 user/agent，并带 `principalId`、权限和 `leader`。 | Project Member/Grant 候选；裸 agent actor 必须唯一解析，`leader` 与项目 owner 共同检查多 owner。 |
| `collab_project` | `projects` 以 workspace ID 为主键，保存 `ownerId` 和项目角色定义。 | `ownerId` 解析为 Human Principal；owner 与 leader 冲突、owner 非 Human、无 owner 均报告。 |
| `collab_agent` | `profiles` 是 Agent 定义；`runs` 可带 `employeeId`/`principalId`。 | Agent 不自动生成 Principal；无唯一映射的系统 Agent 进入 blocked。 |
| `collab_principal_runtime` | 新形状的 Runtime Profile/Action Ticket 要求 `principalId`。 | 只检查引用完整性；不迁移，不签发 Ticket。 |

## 3. Legacy snapshot adapter

`packages/database/src/legacy-principal-snapshot.ts` 提供只读的
`readLegacyPrincipalSnapshot({ sourceHome })`：

1. `sourceHome` 必须是显式传入的绝对目录。
2. adapter 从不读取 `DSH_HOME` 或任何进程默认路径。
3. 只读取 `<sourceHome>/storages/<reviewed-domain>.json`。
4. 支持 DSH JSON Storage 的 `{ unit, global, tables }` single-unit 包装。
5. 对缺失的可选 domain 留空；JSON/table/domain/version 异常进入 blocked 报告。
6. `passwordHash` 和 `tokenHash` 不进入规范化快照；Credential 只返回 presence、
   `scrypt`/unknown 摘要和状态。
7. `sourceDigest` 是 8 个受审 domain 文件的稳定内容摘要；文件原始内容只参与
   Hash 计算，不写报告。

CLI 还要求 `sourceHome` 和 JSON 输出均位于当前 worktree 的 `.tmp`，避免误读正式
DSH 路径或把报告写入业务目录：

```bash
pnpm migration:principal-dry-run \
  --source-home "$PWD/.tmp/dsh-home-batch14b" \
  --output "$PWD/.tmp/batch14b-principal-dry-run/report.json" \
  --as-of "2026-10-26T00:00:00.000Z"
```

CLI 同时写出同名 `.md`。输入和输出都必须是绝对路径。

## 4. 报告与分类

JSON schema 版本为 `pluginmax.principal-dry-run.v1`，固定包含：

- `sourceDigest`、`asOf`、8 个 source file 摘要。
- 原始计数、Principal/Account/Alias/Workspace/Project Grant 候选计数。
- `classificationCounts`：ready、already-mapped、skipped-non-target、conflict、
  orphan、blocked-security-decision。
- `conflicts`、`orphans`、`blocked` 明细及 source refs。
- `readyToBackfill`；任一问题存在即为 `false`。

Many aliases mapping to one Principal 是允许且可统计的关系，记录在
`aliasManyToOnePrincipalGroups`。真正的阻断形态是一个 Alias key 映射到多个
Principal，或同一 subject link 指向多个 Principal。

报告不会输出：

- 密码明文或密码 Hash。
- Bearer Token、Session Token Hash 或 secret。
- Runtime 凭据、模型私有会话或 UI 状态。

## 5. Synthetic dry-run 结果

当前综合 fixture 用于覆盖阻断项，结果固定为：

| 指标 | 数量 |
| --- | ---: |
| Reviewed source files | 8 |
| Users | 5 |
| Human Employees | 3 |
| AI Employees | 2 |
| Teammates | 3 |
| Project assignments | 4 |
| Principal candidates | 9 |
| Account candidates | 5 |
| Alias candidates | 16 |
| WorkspaceMember candidates | 2 |
| ExternalIdentityLink candidates | 1 |
| Platform / Workspace / Project Grant candidates | 5 / 3 / 4 |
| Conflicts | 8 |
| Orphans | 8 |
| Blocked | 5 |
| `readyToBackfill` | `false` |

已覆盖的指定阻断项：

- 登录 ID 大小写重复账号。
- Human Employee 多对一账号。
- Alias key / subject 一对多 Principal。
- 项目多 owner，以及 owner 解析到非 Human Principal。
- Project Agent actor 无法唯一解析。
- Workspace membership role 与 Employee workspace role 来源冲突。
- Runtime Profile、Action Ticket、Delegation 缺 Principal。
- 系统 Agent 无显式 Principal 决策。
- audit actor 与 project/runtime 引用孤儿。

干净 fixture 同时验证无阻断时 `readyToBackfill=true`，确保报告机制不是恒为
blocked。

## 6. 仍未决的迁移规则

以下事项必须有明确权威来源后才能进入 backfill：

1. 哪一份真实旧 DSH 快照被批准为唯一迁移来源。
2. `collab_team.users.id` 是否就是唯一登录 ID，及其大小写归一规则。
3. 同一账号关联多条 Human Employee 时的合并没有自动规则。
4. 旧 Principal、Employee、Teammate、Agent 冲突时以哪一个为权威。
5. WorkspaceMember role 与 Employee role assignment 冲突时以哪一个为权威。
6. `viewer` 与 `guest` 是否语义等价；本批不自动折算。
7. Project owner 的权威来源是 `project.ownerId`、`assignment.leader`，还是外部项目源。
8. 系统 Agent 是否统一映射到平台 Principal、独立 AI Principal，或保持未迁移。
9. Runtime Profile、Action Ticket、Delegation 是否只做兼容读取，还是需要历史
   Principal 回填。
10. ExternalIdentityLink 的权威 Provider/Subject 字段；没有 HRM/OIDC/SCIM 来源时
    本批不推断。

## 7. 风险

- 旧表读由 JSON Storage 版本/布局驱动；新版本布局若变化会使文件进入 blocked。
- 当前测试证明字段兼容和冲突分类，不证明真实规模下的性能和完整性。
- Role key 可映射，但部分旧 role 没有显式 permission snapshot；后续需安全评审
  角色到权限的换算，本批不写默认权限。
- 旧 Session 明确不迁移；认证切换与强制重新登录仍需独立安全决策。
- 报告中包含业务 ID、显示名和 source refs，应按内部迁移材料管理。

## 8. 非目标

- 不正式 dry-run 真实数据，不 backfill。
- 不创建新 Migration。
- 不改认证、API、UI、Action Ticket、Shared Space 或 sandbox。
- 不自动合并重复账号或冲突 Principal。
- 不 push，不修改远端。
