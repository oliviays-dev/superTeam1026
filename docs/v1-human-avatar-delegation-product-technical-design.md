# Pluginmax V1 Human Avatar Delegation 产品与技术方案

> 状态：独立设计方案，尚未实现
>
> 优先级：P1
>
> 依赖：Batch 14 Principal/RBAC、Batch 15A Envelope、Batch 15B Ticket/Gate、Batch
> 16 Scene Session、Batch 18 Meeting Delegate、Batch 20A Identity Administration
>
> 对照基线：`dsh-pluginmax@a702267abfc6baebc7cab7b3045e71c204079e10`

## 1. 结论

Human Avatar 是真人 Principal 在特定上下文中的受限代表，不是一个独立 Principal，
也不是 Digital Employee 或 Teammate 的别名。

核心公式：

```text
Avatar 有效权限 =
  主人 Principal 的有效权限
  ∩ Delegation Allow
  - Delegation Deny
  ∩ 上下文 Scope
  ∩ Runtime Capability
  ∩ Task Policy
```

现有 Meeting Delegate 继续作为会议内专用投影，不直接扩展为通用 Delegation。
通用方案使用独立 `delegations` 事实，Meeting、Task 和 Workflow 都可以绑定同一个
Delegation 模型。

## 2. 当前基础与缺口

### 2.1 当前已有

- Human/AI Principal。
- Project Grant、Project Capability。
- Action Ticket、Execution Gate。
- Scene Session、Context Cursor 和 Receipt。
- Meeting Delegate：speak、read_private、attach_file、summarize。
- Meeting 私密嘱咐。
- AI Teammate、Runtime Binding 和 Run。
- Identity/Project/Grant 审计。

### 2.2 当前缺口

- Delegation 只覆盖 Meeting。
- 没有跨 Task/Workflow/Meeting 的 Delegation 对象。
- 没有本人允许/禁止动作的通用规则。
- 没有暂停、延期、撤销、过期和到期通知。
- 没有 Delegation-scoped Ticket。
- 没有代表执行时间线和报告中心。
- 没有代表动作与主人确认的细粒度策略。

## 3. 产品目标

1. 真人可以为明确上下文创建受限代表。
2. 代表能读取授权材料、提问、建议、提交草稿或执行允许动作。
3. 高风险动作默认只建议，不能替本人审批。
4. 主人能暂停、延期、恢复、撤销和完成 Delegation。
5. 代表每次动作可追溯到 Delegation、Ticket、Scene 和 Run。
6. 过期或撤销后立即失去读取和动作能力。
7. 主人能收到过程报告、风险、待确认项和最终结果。
8. 不因创建 Avatar 产生第二套 Principal、Grant 或登录账号。

## 4. 非目标

- 创建可登录的新 Human Principal。
- 让 Avatar 继承主人全部 Platform/Workspace/Project Grant。
- 自动批准所有工作流审批。
- Digital Employee 或 Teammate 的替代模型。
- HR 员工、绩效、合同或组织汇报域。
- 通用代理机器人或任意工具执行入口。
- 旧 DSH Employee/Delegation 数据迁移。
- 把 Meeting Delegate 表改造成跨场景万能表。

## 5. 用户故事

### 5.1 会议代表

用户无法亲自参加会议，创建一个只覆盖该 Meeting 的 Avatar：

- 目标：收集评审意见并表达既有立场。
- 允许：读会议、读指定材料、发言、提问、记录风险、总结。
- 禁止：最终批准、修改任务状态、读取其他项目。
- 到期：会议结束或指定时间。
- 报告：主人会前嘱咐、表达立场、风险、待确认问题和后续建议。

### 5.2 任务代理

用户出差期间委托 Avatar 推进一个 Task：

- 允许读取任务上下文、评论、提交草稿。
- 不允许完成任务、改派、改变验收结论。
- 高风险操作转成主人待确认。

### 5.3 工作流代理

用户为自己负责的 Workflow 节点创建 Avatar：

- 允许读取节点上下文和交付物。
- 允许提交草稿或交付物。
- `approve` 默认禁止。
- 只有显式允许、`auto-within-rules` 和有效 Ticket 才能执行审批。

### 5.4 紧急召回

主人发现代表偏离目标：

1. 打开 Delegation 详情。
2. 点击“立即召回”。
3. 所有活跃 Ticket 立即失效。
4. 正在运行的 Avatar Run 收到取消。
5. 产生召回报告和审计。

## 6. 产品模型

### 6.1 Delegation

字段：

- id。
- ownerPrincipalId。
- displayName。
- representativePrincipalId。
- representativeAgentId，可空。
- contextType。
- contextId。
- workspaceId。
- projectId。
- objective。
- stance。
- watchItems。
- materialScopes。
- allowedActions。
- deniedActions。
- approvalPolicy。
- autoParticipation。
- status。
- expiresAt。
- reportRequired。
- revision。
- createdBy、createdAt、updatedAt。

### 6.2 代表身份

- 代表主体必须是现有 Human 或 AI Principal。
- 若为 AI Principal，必须绑定 active Teammate 或 Agent。
- Human Avatar 不创建新 Principal。
- 用户看到“Alice 的分身”，同时可查看实际代表主体和 Runtime。
- 不能使用 Human Bearer 代跑。

### 6.3 Context

V1 支持：

- `meeting`。
- `task`。
- `workflow_instance`。
- `workflow_node`。

每次 Delegation 只绑定一个上下文。

若需要覆盖多个上下文，应创建多个 Delegation，而不是一个无界委托。

### 6.4 Allowed / Denied Actions

建议动作枚举：

| Action | 含义 | 默认 |
| --- | --- | --- |
| `read_context` | 读取当前上下文 | allow |
| `read_materials` | 读取委托材料 | allow |
| `comment` | 发表评论或会议消息 | allow |
| `ask_question` | 提问 | allow |
| `record_risk` | 记录风险 | allow |
| `summarize` | 生成摘要 | allow |
| `submit_draft` | 提交草稿 | allow |
| `submit_deliverable` | 提交正式交付物 | deny |
| `update_status` | 修改 Task/Workflow 状态 | deny |
| `reassign` | 改派 | deny |
| `approve` | 最终审批 | deny |
| `reject` | 最终拒绝 | deny |
| `archive` | 归档 | deny |
| `delete` | 删除 | deny |

规则：

- deny 永远优先。
- allow 必须是显式子集。
- 未列出动作默认拒绝。
- `approve` 和 `reject` 只能通过显式规则和 Gate 执行。
- 删除、归档等破坏性动作首版不开放给 Avatar。

### 6.5 Approval Policy

- `suggest-only`：所有高风险动作只生成建议。
- `require-confirmation`：执行前要求主人确认。
- `auto-within-rules`：仅允许规则内动作自动执行，仍需 Ticket。

默认 `suggest-only`。

### 6.6 Auto Participation

- `mentions`：被提及时参与。
- `all`：所有上下文事件。
- `manual`：仅主人或系统触发。

即使 `all`，也必须遵守消息频率、Context Cursor 和 Runtime Policy。

## 7. 状态机

```text
draft
  -> active
  -> paused
  -> active
  -> completed

active/paused -> revoked
active -> expired
```

规则：

- draft 不能产生 Run。
- paused 保留历史，但不能继续读取新内容或执行动作。
- revoked 不可恢复，必须创建新 Delegation。
- completed 保留报告和审计。
- expired 由定时任务更新。
- 只有 owner 或授权管理员可改变状态。

## 8. 权限计算

### 8.1 读取

```text
canRead =
  owner active
  AND representative active
  AND Delegation active
  AND now < expiresAt
  AND context/project matches
  AND read_context or read_materials allowed
  AND owner has resource permission
  AND no deny match
```

### 8.2 执行

```text
canExecute(action) =
  canRead
  AND action explicitly allowed
  AND action not denied
  AND representative runtime capability
  AND task execution policy
  AND valid DelegationTicket
  AND required Gate approved
```

### 8.3 人类浏览器操作

Avatar 不持有人类 Bearer Token。

代表动作通过受控 Agent/Runtime API：

- 使用 AI Principal 或专用 representative execution context。
- 请求携带 Delegation ID 和 Ticket。
- 服务端解析 owner 权限。
- 不把 owner Session 发放给 Avatar。

## 9. Action Ticket 集成

现有 Action Ticket 增加可选字段：

- `delegation_id`。
- `delegation_revision`。
- `delegation_context_hash`。
- `owner_principal_id`。
- `representative_principal_id`。

Ticket 必须绑定：

- Workspace。
- Project。
- Context type/id。
- Run/Scene。
- 允许动作。
- 资源范围。
- 到期时间。

Worker 每次执行前复核：

- Delegation status。
- revision。
- expiresAt。
- owner active。
- representative active。
- context hash。
- Ticket usage。

## 10. Scene Context

Delegation 使用独立 Scene：

```text
delegation:<delegationId>
```

Context 包含：

- 主人的 objective。
- stance。
- watch items。
- allowed/denied actions。
- 指定材料。
- 当前上下文增量。

不自动注入：

- 主人其他项目。
- 私聊。
- 无关会议。
- Runtime Credential。
- 其他 Delegation 的 private briefing。

每次 Run 生成 Context Receipt。

## 11. 数据模型

### 11.1 `delegations`

| 字段 | 说明 |
| --- | --- |
| id | UUID |
| owner_principal_id | 主人 |
| representative_principal_id | 代表主体 |
| representative_agent_id | 可空 Agent |
| workspace_id / project_id | Scope |
| context_type / context_id | 唯一上下文 |
| display_name | 展示名 |
| objective / stance | 目标与立场 |
| watch_items | JSONB |
| material_scopes | JSONB |
| allowed_actions | JSONB |
| denied_actions | JSONB |
| approval_policy | enum |
| auto_participation | enum |
| status | enum |
| expires_at | 时间 |
| report_required | boolean |
| revision | 乐观锁 |
| created_by / created_at / updated_at | 审计 |
| completed_at / revoked_at / revoked_by | 生命周期 |

唯一约束按产品决定：

- 同一 owner、context、representative 最多一个 active Delegation。

### 11.2 `delegation_events`

append-only：

- created、activated、paused、resumed、extended、revoked、expired、completed。
- actor。
- before/after revision。
- reason。
- metadata。

### 11.3 `delegation_runs`

- delegation_id。
- run_id。
- scene_session_id。
- ticket_id。
- started_at、ended_at、status。

### 11.4 `delegation_reports`

- delegation_id。
- status：pending/generating/ready/failed。
- summary。
- keyProcess。
- positions。
- risks。
- openQuestions。
- nextSteps。
- generatedAt。
- sourceEventCursor。

### 11.5 `delegation_notifications`

- ownerPrincipalId。
- delegationId。
- kind：expiry_soon/confirmation_required/report_ready/anomaly。
- status。
- dedupeKey。
- dueAt。

### 11.6 `delegation_confirmation_requests`

用于 `require-confirmation`：

- action。
- target。
- proposed payload hash。
- status pending/approved/rejected/expired。
- decision actor。
- ticket/run links。

## 12. API

### 12.1 Delegation

```text
GET    /api/v1/delegations
POST   /api/v1/delegations
GET    /api/v1/delegations/:delegationId
PATCH  /api/v1/delegations/:delegationId
POST   /api/v1/delegations/:delegationId/activate
POST   /api/v1/delegations/:delegationId/pause
POST   /api/v1/delegations/:delegationId/resume
POST   /api/v1/delegations/:delegationId/extend
POST   /api/v1/delegations/:delegationId/revoke
POST   /api/v1/delegations/:delegationId/complete
```

PATCH 和状态命令必须携带 `expectedRevision`。

### 12.2 执行与报告

```text
GET  /api/v1/delegations/:delegationId/runs
GET  /api/v1/delegations/:delegationId/reports
POST /api/v1/delegations/:delegationId/reports/retry
GET  /api/v1/delegations/:delegationId/events
GET  /api/v1/delegations/:delegationId/context
```

### 12.3 主人确认

```text
GET  /api/v1/delegations/:delegationId/confirmations
POST /api/v1/delegations/:delegationId/confirmations/:requestId/decision
```

### 12.4 Meeting 兼容

Meeting Delegate 保持现有 API。

新增可选字段：

- `delegationId`。
- Delegation 状态投影。

新 UI 可以创建 Meeting Delegation 并同步生成 Meeting Delegate 投影，但不能继续让
Meeting Delegate 单独充当跨场景权限来源。

### 12.5 错误码

```text
delegation_not_found
delegation_revision_conflict
delegation_expired
delegation_revoked
delegation_paused
delegation_action_denied
delegation_scope_mismatch
delegation_approval_required
delegation_ticket_invalid
delegation_report_not_ready
delegation_owner_conflict
representative_inactive
```

## 13. 通知

通知事件：

- 24 小时前到期提醒。
- 1 小时前到期提醒。
- 需要主人确认。
- 报告生成完成。
- 代表连续失败。
- 代表触发 deny 动作。

去重键：

```text
delegation:<id>:expiry:<window>
delegation:<id>:confirmation:<requestId>
delegation:<id>:report:<version>
```

用户关闭提醒不改变 Delegation 状态。

## 14. 报告

报告触发：

- 代表完成上下文目标。
- 主人召回。
- 会议关闭。
- 委托到期。
- Workflow 节点完成或取消。

固定结构：

```markdown
# 分身工作报告

## 目标与委托范围
## 关键过程
## 已表达立场
## 结论
## 风险与反对意见
## 待主人确认
## 后续建议
## 信息缺口
```

失败时：

- 显示 failed。
- 保存错误类别。
- 允许重试。
- 不生成伪造报告。

## 15. GUI

### 15.1 委托中心

列表：

- Active。
- Paused。
- Expiring soon。
- Completed。
- Revoked/Expired。

筛选：

- 上下文类型。
- Project。
- Representative。
- 状态。
- 到期时间。

### 15.2 创建向导

步骤：

1. 选择上下文。
2. 选择代表。
3. 填写目标、立场和关注点。
4. 选择材料和资源范围。
5. 配置 allow/deny actions。
6. 设置审批策略和有效期。
7. 预览有效权限。
8. 激活。

权限预览必须直接展示：

```text
可以：读取任务、评论、提交草稿
不可：完成任务、改派、审批
审批策略：高风险动作需要主人确认
到期：2026-11-01 18:00
```

### 15.3 详情

- 当前状态和倒计时。
- 目标和规则。
- 有效权限。
- Run 时间线。
- 消息/评论/交付物。
- 待确认项。
- 报告。
- 暂停、延期、召回。

### 15.4 视觉身份

显示：

```text
Alice 的工作分身
代表主体：Research Teammate
适用范围：Task ABC
```

不得显示为独立员工或普通 Human 账号。

## 16. 事务与并发

### 16.1 创建

- 校验 owner/representative。
- 校验 context 存在且 owner 有权限。
- 校验 representative 可执行。
- 创建 draft。
- 激活时创建 Scene binding。
- 写事件和通知。

### 16.2 执行

```text
receive action
  -> load delegation
  -> check status/revision/expiry
  -> resolve owner permission
  -> apply allow/deny
  -> check runtime/task policy
  -> validate Ticket
  -> optional confirmation
  -> execute
  -> append run/event
```

### 16.3 撤销

单事务：

1. compare revision。
2. status revoked。
3. revoke active tickets。
4. cancel active runs。
5. append event。
6. enqueue notification and report。

## 17. Migration

1. 新建 delegations、events、runs、reports、notifications、confirmations。
2. Action Ticket 增加 nullable delegation 字段。
3. Meeting Delegate 保持原表，增加 optional delegation_id。
4. 历史 Meeting Delegate 不自动升级为通用 Delegation。
5. 新 Meeting Delegation 双投影，通用 Delegation 为权限事实。
6. 不迁移旧 DSH Delegation。

升级门禁：

- fresh `0 -> N`。
- `N-1 -> N`。
- Meeting Delegate 行为不变。
- 15B Ticket 向后兼容，无 delegation 的 Ticket 仍按原逻辑执行。

## 18. 测试

### 18.1 Contracts

- 状态机。
- allow/deny 去重。
- approve 规则。
- context type/id。
- revision。

### 18.2 Database

- active 唯一性。
- 状态转换。
- 过期。
- Ticket 撤销。
- append-only events。
- 报告幂等。

### 18.3 Application/API

- owner 权限子集。
- deny-wins。
- 跨 Project/Context 拒绝。
- paused/revoked/expired 拒绝。
- require-confirmation。
- ticket revision mismatch。
- AI Principal 不能使用 Human Bearer。

### 18.4 GUI

- 创建向导。
- 有效权限预览。
- 暂停/恢复/延期/召回。
- 待确认动作。
- 报告。
- 1440、900、390。

## 19. 分期

### Phase 1：会议 Delegation

- 通用模型。
- Meeting 双投影。
- 私密嘱咐和报告。

### Phase 2：Task

- Task context。
- 评论、草稿、风险。
- 主人确认。

### Phase 3：Workflow Node

- Node context。
- 交付物草稿。
- approve 默认禁止。

### Phase 4：治理体验

- Delegation Center。
- 到期通知。
- 异常和审计。
- 跨场景统计。

## 20. 风险

| 风险 | 控制 |
| --- | --- |
| Avatar 被当成独立 Principal | DTO 始终携带 owner |
| 越权扩大 | owner Grant ∩ allow - deny - scope |
| 高危审批 | suggest-only 默认 + Gate |
| 过期仍可执行 | 每次请求重算 + ticket revalidation |
| 私密上下文泄漏 | 独立 Scene + source scope |
| 代表身份漂移 | representative binding revision |
| 报告伪造成功 | 明确 failed + retry |
| Meeting Delegate 双事实 | 通用 Delegation 为来源，Meeting 为投影 |

## 21. 完成定义

- 真人可创建、暂停、恢复、延期和撤销 Delegation。
- Meeting、Task、Workflow 三种上下文均有受控执行路径。
- 有效权限是主人权限的严格子集。
- 高风险动作默认建议或待确认。
- 每次动作可追溯到 Delegation、Run、Ticket、Scene 和审计。
- 报告、通知、过期和召回闭环完成。
- Human Avatar 从 `MISSING` 变为 `EQUIVALENT` 或 `STRONGER`。
