# V1 Batch 14A: Identity / Principal / RBAC 迁移方案

> 状态：设计与 dry-run 规范完成；正式数据迁移未执行

## 1. 迁移原则

1. 源数据只读；任何 dry-run 或测试都不得打开正式 DSH Profile、Storage 或 Session。
2. 先建映射和冲突报告，再 backfill；禁止在 Migration 24 内自动猜规则。
3. 一件事实只有一个可写主权。
4. 旧 ID 保留为 Alias，历史审计、Run、Meeting、Workflow 和 Ticket 可回查。
5. 密码 Hash 不进入报告；Bearer 明文从不进入迁移输入。
6. 迁移失败只丢弃当前 worktree 的副本和临时数据库。
7. 认证切换晚于数据一致性验证；数据迁移晚于 dry-run 通过。

## 2. 来源与目标

### 2.1 来源

允许的迁移来源：

- `collab_team.users`
- `collab_team.workspace_members`
- `collab_team.auth_sessions`（只统计，不默认迁移）
- `collab_principal.principals`
- `collab_principal.principal_links`
- `collab_principal.role_grants`
- `collab_employee.employees`
- `collab_employee.role_assignments`
- `collab_employee.runtime_profiles`
- `collab_employee.action_tickets`
- `collab_employee.delegations`
- `collab_teammate` 实例
- 旧插件 Project Member / Role / Audit 投影

不在来源中：

- DSH Shell、Slot、UI 状态。
- `node_modules`、Profile 缓存和非业务 Session 文件。
- 旧 Runtime 进程、终端 history 和模型私有会话。
- 正式数据库或正式 `DSH_HOME`。

### 2.2 目标

- `principals`
- `accounts`
- `account_credentials`
- `auth_sessions`
- `workspace_members`
- `external_identity_links`
- `principal_aliases`
- `role_grants`
- `identity_audit_events`
- `agents.principal_id`
- `project_members.principal_id`
- `runs.*_principal_id`

## 3. 确定性主体映射

### 3.1 Human Principal

优先级：

1. 已有 `collab_principal` 且通过 `auth-user` 绑定账号：复用。
2. 已有 `employee(kind=human)` 且通过 `authUserId` 绑定账号，并且唯一：复用该
   Principal 或确定性生成 Human Principal。
3. 只有账号：生成 Human Principal，并写 `auth-user` Alias。
4. 只有无账号 Human Employee：生成 Human Principal，写 `employee` Alias，
   Account 保持不存在。
5. 同一账号多个 Employee、或账号/Employee 指向不同 Principal：阻断该主体，
   输出冲突，不自动合并。

### 3.2 AI Principal

优先级：

1. 已有 Digital Employee 的 Principal：复用。
2. 已有 Teammate 的 Principal：复用。
3. 只有 Digital Employee：生成 AI Principal，写 `employee` Alias。
4. Teammate 同步写 `teammate` Alias，并与 Companion 产品投影关联。
5. Agent 写 `agent` Alias；Agent 不等于 Principal，不能自动生成多个身份。
6. 系统 Agent 映射必须显式决定，dry-run 只列为待确认。

### 3.3 Account 与 Credential

| 旧字段 | 目标 |
| --- | --- |
| `users.id` | `accounts.id` |
| `users.name` | Principal displayName 候选 |
| `users.status` | Account/Credential 状态输入 |
| `users.role` | Platform Role Grant 输入 |
| `users.passwordHash` | Credential Hash（不输出明文/Hash 到报告） |

会话：

- 不默认迁移旧 `auth_sessions`。
- 认证切换要求所有用户重新登录，但可保留密码 Hash，避免强制改密。
- 如安全政策要求强制改密，应作为独立决策，不在 14A 猜测。

### 3.4 Workspace

- `workspace_members.members[]` 拆为一行一个 `workspace_members`。
- 成员角色转 Workspace Scope Grant。
- 同一 `(workspaceId, principalId)` 多角色时保留多条不同 role grant。
- Employee 的 workspace role assignment 与旧 workspace member role 冲突时阻断，
  进入 `grant_source_conflict`。

### 3.5 Project

映射步骤：

1. 解析 `project_members.actor_id`：
   - human 优先匹配 `auth-user` Alias。
   - agent 优先匹配 `agent` Alias，再匹配 Digital Employee/Teammate。
   - 裸 ID 只有在唯一命中时接受。
2. 写 `project_members.principal_id`。
3. `project_member_roles` 映射为 Project Grant：
   - scope = `project`
   - scopeId = project ID
   - roleKey = `project-role:<roleId>` 或已有稳定 code
   - permissions = `project_roles.permissions`
   - sourceRef = `project_member_roles:<projectMemberId>:<roleId>`
4. `is_owner = true` 映射 `PROJECT_OWNER` Grant。
5. 多个 owner 或 owner 非 Human 时阻断。

### 3.6 Run、审批和会议

这些字段在 14A 只 dry-run：

- Run：通过 `agent_id` 解析 `agent_principal_id`；发起人无可靠来源时标记
  `initiator_unknown`。
- Workflow Approval：通过 `approver_id` / `approver_role_id` 解析 Principal；
  `role` 审批可能一对多，无法唯一归因时保留 role 事实并标记待迁移。
- Meeting Participant：按 participant `kind + id` 解析；缺失时阻断会议迁移。
- Task Message / Review / Audit：按 Alias 解析；冲突时只报告，不改历史行。

## 4. Migration 版本规划

| 版本 | 内容 | 本批状态 |
| --- | --- | --- |
| 24 | Principal/RBAC 空表、nullable 关联列、约束和 append-only 审计 | 已实现 |
| 25 | 从受控快照 backfill Principal/Account/Workspace | 后续 |
| 26 | Project Member/Role/owner 兼容双读与一致性报告 | 后续 |
| 27 | Run/Workflow/Meeting/Task/Audit Principal 字段 backfill | 后续 |
| 28 | 认证切换、Bearer Session 和开发 Actor 收口 | 后续 |

版本号是顺序计划，不代表各版本可以跳过 dry-run。

## 5. 旧数据 dry-run

### 5.1 输入

CLI 必须显式接收：

```text
--source-home <只读快照目录>
--output <当前 worktree 内 JSON/Markdown 路径>
--as-of <UTC 时间>
```

禁止默认读取当前用户 `DSH_HOME`。Batch 14A 测试使用
`/Users/oliviayang/Codex/一切皆插件/.tmp/dsh-home-batch14` 下的隔离数据。

### 5.2 步骤

1. 复制源数据到当前 worktree `.tmp` 的随机快照目录。
2. 以只读方式解析 Domain 表；不执行 Migration、写回或插件启动。
3. 统计原始行数、主键、状态、引用、重复和孤儿。
4. 生成 Principal 候选与 Alias 解析结果，不写数据库。
5. 生成 Account/Credential 候选；Hash 只校验格式，不写报告。
6. 生成 Workspace/Project Grant 候选和 owner 一致性检查。
7. 生成 Run/Workflow/Meeting/Audit 未解析 actor 清单。
8. 输出机器可读报告和人工摘要，计算稳定 content hash。

### 5.3 报告分类

```text
ready
already-mapped
skipped-non-target
conflict
orphan
blocked-security-decision
```

任何 `conflict`、`orphan` 或 `blocked-security-decision` 都阻止正式 backfill。

### 5.4 必查项

1. Account ID 重复、登录 ID 大小写冲突。
2. Human Employee 多对一账号。
3. Principal/Employee/Teammate/Agent 多对一冲突。
4. Workspace role 两个来源冲突。
5. 每项目 owner 数量与 kind。
6. `project_members.actor_id` 无法解析或解析到多个 Principal。
7. Workflow approver / meeting participant 无法唯一解析。
8. Runtime Profile / Action Ticket / Delegation 的 Principal 缺失。
9. 历史审计 actor 缺失，单独计数，不自动伪造成 system。
10. Session 数量、过期数量和安全风险；不导出 Token/Hash。

### 5.5 输出示例

```json
{
  "sourceDigest": "sha256:...",
  "asOf": "2026-10-26T00:00:00.000Z",
  "counts": {
    "users": 0,
    "employeesHuman": 0,
    "employeesDigital": 0,
    "principalsCandidate": 0,
    "aliasesCandidate": 0,
    "accountsCandidate": 0,
    "workspaceGrantsCandidate": 0,
    "projectGrantsCandidate": 0,
    "runActorsResolved": 0,
    "runActorsUnknown": 0
  },
  "conflicts": [],
  "blocked": [],
  "readyToBackfill": false
}
```

14A 未对正式旧数据运行该流程，因此不填真实数量；不能用示例中的 `0` 代表现状。

## 6. 正式 backfill 顺序

```text
1. 在只读副本生成并审阅 dry-run
2. 在临时 PostgreSQL 执行 0 -> 24 -> backfill
3. 逐表核对主键、状态、Grant、owner、Alias
4. 执行 API/Repository 双读兼容测试
5. 切换认证写入与 Session
6. 观察新旧差异，修复覆盖缺口
7. 停止旧写，保留旧读和导出
```

每一步都使用当前 worktree 独立 PostgreSQL、FileStore、日志和 `.tmp`。

## 7. 回滚

### 7.1 Migration 24 回滚

Migration 24 是纯加法：

- 旧代码不认识新表/新列时仍可正常运行。
- 不删除、不重命名、不 backfill 旧字段。
- 正常回滚只需回滚应用提交，不删除已应用表。
- 测试数据库可直接删除 schema；正式删除表属于破坏性操作，不纳入自动回滚。

### 7.2 Backfill 回滚

后续 backfill 必须记录 `migration_run_id` 和源记录 ID：

1. 回滚只撤销该 run 写入的新 Principal/Account/Alias/Grant。
2. 不删除源数据。
3. 已产生的新审计不可删除，保留并追加回滚事件。
4. 若认证已切换，先恢复旧认证路径，再撤销 backfill。

### 7.3 认证回滚

- 保留短期开关，回退到 `local-development` 仅限非生产。
- 生产不允许回退到客户端自报 Header。
- Session 可通过批量吊销安全停机；不恢复旧行为。

## 8. 验收标准

### 8.1 14A 本批

- [x] 完成 V1 Agent/Member/Owner/Run/Approver/Meeting/Audit 清点。
- [x] 完成 20 项旧能力映射，统计为 8/5/5/2。
- [x] 完成 Principal/Account/WorkspaceMember/ExternalIdentityLink/Alias/RoleGrant
  规范契约。
- [x] 完成认证状态映射和 fail-closed 纯函数测试。
- [x] 完成 Migration 24 加法式表结构，不 backfill。
- [x] 完成 dry-run、回滚、兼容读取和认证切换方案。
- [x] 修正 V1 总设计中 Batch 13 的过期状态。

### 8.2 后续 backfill 前

- [ ] dry-run 无 conflict/orphan/blocked。
- [ ] 每个项目唯一 Human owner。
- [ ] 每个历史 actor 唯一解析，或明确列入不可迁移。
- [ ] Account/Credential 状态映射通过安全评审。
- [ ] Project owner、项目角色和 Grant 双读一致。
- [ ] 旧 Session 不迁移的决定被安全负责人确认。

## 9. 本批明确不执行

- 不读取正式数据库或正式 DSH 数据。
- 不执行正式 dry-run 数据回填。
- 不签发 Bearer Session。
- 不实现认证中间件。
- 不接入新 API 或 UI。
- 不迁移 Runtime Profile、Action Ticket、Shared Space 或 sandbox。
