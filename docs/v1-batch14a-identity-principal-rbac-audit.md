# V1 Batch 14A: Identity / Principal / RBAC 清点报告

> 状态：14A 审计与基础设计完成；未进行旧数据正式迁移、API/UI 改造或认证切换
>
> 分支：`feat/v1-batch14-identity-principal-rbac`
>
> 基线：`bc7f55b651737c34ea288b8ad2adf3c51bf3a6ea`
>
> Migration：24（仅新增空表、nullable Principal 关联列和约束，无数据回填）

## 1. 结论

当前 V1 已有 Project Member、项目 owner、项目角色、Run、审批、会议参与者和多组
审计事实，但这些事实没有统一到 Principal：

1. `agents.id` 是执行资产 ID，不是可授权主体 ID。
2. `project_members.actor_id`、`owner_id`、`approver_id`、`acted_by`、
   `author_id`、`owner_actor_id` 和多数审计 `actor_id` 都是自由文本。
3. 项目 owner 是 `project_members.is_owner` 布尔事实，项目角色是另一套
   `project_roles` + 成员角色关系；二者都不是通用 Role Grant。
4. Run 只记录执行 Agent，没有记录发起人 Principal；RunEvent 也没有
   `actor_principal_id` 列。
5. V1 没有正式登录、Account、Credential、Bearer Session 或 Principal 中间件。
   `x-pluginmax-actor` 只是开发期请求头，缺省值仍是 `local-admin`。
6. 旧 DSH 插件的 Employee、Teammate、账号、Principal、Grant、Runtime Profile
   和 Action Ticket 可以提取契约，但其 UI、DSH Shell、Slot 和 JSON Storage
   不属于 V1 迁移目标。

因此 Batch 14A 只建立规范模型、认证/授权边界、迁移方案和加法式 Migration 24。
在任何 dry-run 尚未通过前，不把旧账号、Employee、项目 actor 或审计 actor 自动
改写成 Principal。

## 2. V1 现状审计

### 2.1 Agent

当前事实：

| 字段 | 当前语义 | 问题 |
| --- | --- | --- |
| `agents.id` | UUID，执行资产主键 | 没有区分 AI Principal 与 Runtime/Agent 配置 |
| `agents.name`、`soul`、`tools` 等 | Agent 配置 | 可继续作为 AI 执行资产，不应成为授权主体 |
| `agents.owner_id` | 文本业务负责人 | 没有 FK，也没有“owner 不继承权限”的约束 |
| `agents.status` | `active / disabled` | 不是 Principal 状态，不能直接当作身份归档 |
| `agents.runtime_kind` | 执行通道 | 不是平台角色或业务授权 |
| `agent_events.actor_id` | 操作者文本 | 未记录 Principal ID；历史 `system` 和人工操作混用 |

目标关系：

```text
AI Principal 1 ── * Agent / Runtime Profile / Run
```

`Agent` 继续表示执行资产；`AI Principal` 表示可授权、可追责主体。旧 Agent ID
进入 `principal_aliases(alias_type = 'agent')`，不能直接成为 Principal ID。

### 2.2 Project Member

当前事实：

- `project_members` 保存 `kind = human | agent`、自由文本 `actor_id`、
  `name`、`responsibility`、`status` 和 `is_owner`。
- `project_member_roles` 把成员关联到当前项目内的 `project_roles`。
- 项目角色权限为 `read | write | approve | manage_members | manage_roles`。
- 项目成员查询以 `actor_id + status` 判断访问，缺少 Principal FK。

Migration 24 只增加 nullable `principal_id` 和索引，保留原 `kind/actor_id`，
不回填。未来兼容期应继续以旧列做读投影，同时用 Principal 双读校验。

### 2.3 Owner

当前事实：

- 项目创建会自动加入 `local-admin` 为唯一 human owner。
- `is_owner` 授予项目内 `canManage`；owner 不能被删除或停用。
- `local-admin` 同时在 API 层被当作平台管理员。
- AI 成员当前不能成为 owner。

目标约束：

1. Owner 是项目范围事实，不是 Principal 的全局属性。
2. `PROJECT_OWNER` 只能映射为 `scope_type = project` 的 Role Grant。
3. Owner 不继承 Platform Admin，也不产生 Workspace Grant。
4. 14A 保持“只有 Human Principal 可持有 PROJECT_OWNER”的现状，不扩展 AI owner。
5. 兼容期 `is_owner` 与 `PROJECT_OWNER` Grant 必须有一致性报告，不能永久双写。

### 2.4 Run Actor

当前事实：

- `runs.agent_id` 表示执行 Agent。
- `runs` 没有 `initiated_by_*` 字段。
- `run_events` 没有 actor 列，少量事件把 actor 放入 `data`。
- 任务、工作流、会议 AI 和直聊会从不同入口创建 Run。
- Worker 使用 `system-worker` 等文本 actor。

Migration 24 增加 nullable `runs.agent_principal_id` 和
`runs.initiated_by_principal_id`，但不回填。未来 Run 必须同时回答：

```text
谁发起：initiated_by_principal_id
谁执行：agent_principal_id
以什么授权执行：Role Grant / Runtime Policy / Action Ticket（后续批次）
```

### 2.5 审批人

当前事实：

- `workflow_approvals.approver_id`、`acted_by` 是文本。
- `workflow_approvals.approver_role_id` 引用当前项目的 `project_roles`。
- `workflowExecutor.kind` 支持 `system | user | agent | role`。
- 工作流审计 `workflow_audit_events.actor_id` 是文本。

目标：

- `user` / `agent` / `role` 最终都解析到 Principal。
- 角色审批保留 `role` 解析语义，但命中的成员必须是 active Principal 或兼容成员。
- `system` 使用受控 system Principal，不允许任意字符串绕过身份校验。
- 历史审批保留 `approver_id`，新增 Principal 映射后再做双读。

### 2.6 会议参与者

当前事实：

- `meetings.participants` 是 JSONB，元素只有 `id`、`name`、`kind`。
- Meeting Message 保存 `author_type` 和 `author_id`。
- Meeting AI Policy 保存 `created_by` / `updated_by` 文本。
- AI 参与者要求是当前项目的 active agent member。

目标：

- Meeting Participant 是 Principal 在会议上下文中的投影，不是第二身份。
- 历史参与者 ID 通过 Alias 解析；冲突或缺失时 dry-run 报告为阻断项。
- AI 仍不得使用人类 Bearer Session。

### 2.7 审计字段

当前主要审计/追责事实：

| 表 | Actor 字段 |
| --- | --- |
| `agent_events` | `actor_id` |
| `task_events` | `actor_id`、`actor_name` |
| `task_reviews` | `actor_id` |
| `task_messages` | `author_type`、`author_id` |
| `workflow_audit_events` | `actor_id` |
| `workflow_approvals` | `approver_id`、`acted_by` |
| `meeting_messages` | `author_type`、`author_id` |
| `meeting_ai_policies` | `created_by`、`updated_by` |
| `meeting_action_items` | `owner_kind`、`owner_actor_id` |
| `external_runtimes` | `owner_id` |
| `external_runtime_events` | `actor_id` |
| `direct_chat_threads` | `owner_id` |
| `project_template_grants` | `actor_id` |
| `workbench_*` | `actor_id` |

目标：

1. 新敏感动作统一写 `actor_principal_id`、`grant_id`、`run_id`、`ticket_id`。
2. 历史审计不改写原 actor；新增别名映射和一致性报告。
3. `identity_audit_events` 只追加，不更新或删除。
4. 不把密码、Token、Credential secret 或完整 session 写入审计。

## 3. 旧设计契约提取

| 旧能力 | 可提取契约 | 明确排除 |
| --- | --- | --- |
| `collab_team.users` | 账号 ID、登录 ID、显示名、启停、密码 Hash、会话过期 | 旧账号页面、JSON Storage |
| `collab_team.workspace_members` | 工作区成员事实和成员状态 | 嵌入式旧数组结构、旧 UI |
| `collab_employee.employees` | Human/Digital 主体、状态、来源、账号映射、负责人 | 员工产品域、HR 档案、Employee UI |
| `collab_teammate` | AI Companion 与 AI Principal 的产品投影关系 | DSH Slot、页面 Shell |
| `collab_principal` | Principal、Alias、Role Grant 的稳定主体与作用域 | 旧 KV 表实现 |
| Employee `role_assignments` | principal + workspace + role + permissions + expiry | 第二套可写授权来源 |
| Runtime Profile | AI Principal 的执行限制、工具、预算、状态 | 将 Runtime 权限当作业务授权 |
| Action Ticket | principal + scope + context + allowed/denied + expiry | Batch 14A 不实现票据签发/校验 |
| Delegation | Human Avatar 的限制性委托，不是 Principal | 14A 不迁移 Delegation Runtime |

## 4. 映射总表

状态定义：

- `canonical`：进入本批规范模型。
- `compat-read`：保留旧事实并建立映射，消费方后续渐进切换。
- `deferred`：只记录目标和 dry-run 检查，本批不改 API/UI。
- `non-target`：明确不在 14A 实现。

共 20 项能力映射：`canonical = 8`、`compat-read = 5`、`deferred = 5`、
`non-target = 2`。

| # | 旧能力 | V1 Principal 能力 | 状态 | 迁移来源 / 边界 |
| --- | --- | --- | --- | --- |
| 1 | 登录账号 | Human Principal + Account | canonical | `collab_team.users` |
| 2 | Human Employee | Human Principal Alias | canonical | `employee(kind=human)` 作为别名，不另造人员 |
| 3 | Digital Employee | AI Principal | canonical | `employee(kind=digital)` |
| 4 | Teammate | AI Principal 的 Companion 投影 | canonical | `teammate.employeeId/principalId` |
| 5 | Agent / Agent Profile | AI Principal 的执行资产 | compat-read | Agent ID 进入 alias，不能替代 Principal |
| 6 | 账号全局角色 | Platform Role Grant | canonical | `users.role` |
| 7 | 工作区成员及角色 | WorkspaceMember + Workspace Grant | canonical | `workspace_members`、Employee role assignment |
| 8 | Employee 工作区授权 | Workspace Role Grant | compat-read | 只允许一个可写事实来源 |
| 9 | 项目成员 | Project Principal 投影 | compat-read | `project_members.actor_id` 经 Alias 解析 |
| 10 | 项目角色 | Project Role Grant | compat-read | `project_members_roles -> project_roles` |
| 11 | 项目 owner | `PROJECT_OWNER` Project Grant | compat-read | `project_members.is_owner` 保留兼容 |
| 12 | Run 发起人/执行人 | Run Principal 字段 | deferred | 本批只加 nullable 列，不接 API |
| 13 | Workflow 审批人 | Principal 引用 + Project Grant | deferred | 保留角色审批解析 |
| 14 | 会议参与者 | Principal 上下文投影 | deferred | 历史 JSON 参与者保留 |
| 15 | 任务作者/验收人 | Principal 审计引用 | deferred | 不改 Task API/UI |
| 16 | 分散审计 Actor | Principal 审计边界 | canonical | 新事件写 Principal；历史只读映射 |
| 17 | Runtime Profile | Principal-owned Runtime Policy | deferred | 后续 Batch 实现 |
| 18 | Action Ticket | AI/Delegation 授权票据 | non-target | 14A 不签发、不校验 |
| 19 | HRM Employee | ExternalIdentityLink | canonical | 只建链接模型，不接 HRM |
| 20 | Human Avatar / Delegation | 受限代表，不是 Principal | non-target | 后续独立设计 |

## 5. 缺口与风险

### P0

1. 当前 `x-pluginmax-actor` 可由客户端自报，不能作为生产认证。
2. 没有 Principal 状态、Account 状态、Credential 状态和 Session 状态的统一门禁。
3. 审计 actor 为自由文本，无法可靠证明“谁授权、谁执行、以哪个 Grant 执行”。

### P1

1. 项目成员、Agent、会议参与者和审批人的 ID 命名空间不统一，容易同名冲突。
2. 项目 owner、平台 `local-admin` 和工作区 owner 可能被错误推导成同一权限。
3. 旧 Employee 与账号可能多对一，历史数据存在重复主体风险。
4. 旧 Runtime Profile 和 Action Ticket 只在旧插件中完整，V1 尚无 Principal-owned
   替代实现。
5. 历史 Session 的明文 Token 不会出现在数据快照中，无法也无必要直接迁移会话。

### P2

1. 会议参与者 JSON 和活动时间线中的展示名可能重复，不应作为唯一标识。
2. 部分审计事件把 actor 放在 `data` JSON 中，只能做启发式盘点，不能自动升级为强审计。

## 6. 需要 dry-run 阻断的决策点

以下情况不能自动猜测：

1. 同一 `authUserId` 对应多个 Human Employee。
2. 同一 Employee / Teammate / Agent ID 已映射到不同 Principal。
3. 一个项目出现多个 owner，或 owner 不是 Human。
4. 项目成员 `actor_id` 同时命中 Human、AI 或多个 Alias 命名空间。
5. 旧账号存在密码 Hash 但 Credential 方案不允许迁移。
6. 历史 Session 是否允许跨环境继续有效。
7. 两个 system Agent（`DEFAULT_AGENT_ID`、`DSH_AGENT_ID`）是否映射为 system AI
   Principal，还是映射到产品级共享 Principal。

14A 的默认处理是：保留源数据、输出冲突、停止该记录迁移，不自动合并、不删除、
不重置权限。上述事项需要后续明确产品/安全决定后才能进入正式 backfill。

## 7. 非目标

- 不迁移旧 Employee UI、DSH Shell、Slot、页面路由或 JSON Storage。
- 不删除 `project_members.actor_id`、`is_owner`、`project_member_roles`。
- 不一次性改造所有 API 的请求身份和响应 DTO。
- 不实现 Action Ticket、Shared Space 或危险 sandbox。
- 不在 14A 签发正式 Bearer Session，也不关闭 `x-pluginmax-actor` 开发兼容路径。
- 不连接正式数据库、正式 Session、正式 Profile 或原 `dsh-pluginmax` 数据目录。
