# 三层员工体系技术设计

> 2026-10-17 方向调整：本文的 Employee 领域目标已暂停。平台目标模型改为 Principal + Account/Credential + AI Companion + Role Grant。现有 Employee 服务只用于兼容任务、工作流、会议、运行票据和历史审计，不再新增员工平台能力。新方案见 `docs/platform-principal-rbac-design.md`。

## 1. 目标

本文定义 Pluginmax 的统一员工身份与委托执行模型，覆盖：

1. Human Employee；
2. Digital Employee；
3. Human Avatar / Delegation；
4. 现有 Persona；
5. 现有 Agent Profile / Task Worker；
6. 会议、工作流和审计。

设计原则：

1. Employee 是身份主体；
2. Persona 是行为资产；
3. Runtime Profile 是执行配置；
4. Role / Permission 是授权；
5. Delegation 是 Human Avatar 的委托票据；
6. Run 是一次可观测执行；
7. Audit 是所有敏感动作的强制记录。

## 2. 总体架构

```text
identity
  登录、真人认证、session token
        |
        v
employee
  Human Employee / Digital Employee / Delegation
        |
        +--> roles / workspace membership
        +--> workflow assignment / approval
        +--> meeting participant / avatar
        +--> agent runtime profile / run
        +--> audit / governance
```

新增插件：

```text
plugins/dsh-collab-employee/
```

职责边界：

| 插件                  | 职责                                                   |
| --------------------- | ------------------------------------------------------ |
| `dsh-collab-identity` | 真人认证、登录、旧用户和工作区成员兼容                 |
| `dsh-collab-employee` | 员工目录、员工生命周期、Delegation、Employee Principal |
| `dsh-collab-roles`    | Persona、工作区类型、席位；不再充当员工目录            |
| `dsh-collab-meeting`  | 会议、参与者、消息、Avatar 会话和报告                  |
| `dsh-collab-workflow` | 流程定义、实例、节点、审批和交付物门禁                 |
| `dsh-collab-agent`    | Runtime Profile 兼容层、Task Worker runtime、Run 记录  |

## 3. Principal 模型

旧模型以 `userId` 为中心。新模型引入 Employee Principal。

```ts
export type EmployeeKind = "human" | "digital";

export type PrincipalSource = "direct" | "delegation" | "runtime";

export interface EmployeePrincipal {
  employeeId: string;
  employeeKind: EmployeeKind;
  /** Human Employee 的登录用户 ID。Digital Employee 为空。 */
  authUserId?: string;
  source: PrincipalSource;
  /** Human Avatar / Delegation 才有。 */
  delegationId?: string;
  /** Digital Employee 运行才有。 */
  runId?: string;
  workspaceId: string;
}
```

规则：

1. Human Employee 可以有 `authUserId`；
2. Digital Employee 不允许 `authUserId`；
3. 所有插件逐步从 `actor.userId` 改为消费 `EmployeePrincipal`；
4. 迁移期间保留 `resolveLegacyUserId(principal)`。

## 4. 数据模型

### 4.1 employees

```ts
export const employeeSchema = z.object({
  id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9._-]*$/),
  kind: z.enum(["human", "digital"]),
  displayName: z.string().min(1).max(120),
  email: z.string().email().optional(),
  department: z.string().max(120).default(""),
  title: z.string().max(120).default(""),
  tags: z.array(z.string().max(32)).max(16).default([]),
  /** Digital Employee 必填；Human Employee 可选。 */
  personaId: z.string().optional(),
  /** Human Employee 关联登录用户。 */
  authUserId: z.string().optional(),
  managerEmployeeId: z.string().optional(),
  status: z.enum(["draft", "active", "suspended", "archived"]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  createdBy: z.string(),
});
```

约束：

1. `id` 全局唯一；
2. `kind: digital` 时必须有 `personaId` 和 `managerEmployeeId`；
3. `kind: digital` 时不能有 `authUserId`；
4. `kind: human` 时 `authUserId` 必须唯一；
5. archived 员工不能参与新任务。

### 4.2 employee_role_assignments

```ts
export const employeeRoleAssignmentSchema = z.object({
  id: z.string(),
  employeeId: z.string(),
  workspaceId: z.string(),
  role: z.enum(["owner", "member", "guest", "custom"]),
  permissions: z.array(z.string()).default([]),
  resourceScopes: z.array(z.string()).default([]),
  grantedBy: z.string(),
  grantedAt: z.string().datetime(),
  status: z.enum(["active", "revoked"]),
});
```

说明：

1. Digital Employee 与 Human Employee 使用同一套授权颗粒度；
2. 默认不给 Digital Employee 任何角色；
3. `permissions` 是显式扩展权限；
4. `resourceScopes` 限制资料、目录、节点或连接器。

### 4.3 digital_runtime_profiles

当前 `AgentProfile` 会迁移到这里。

```ts
export const digitalRuntimeProfileSchema = z.object({
  id: z.string(),
  employeeId: z.string(),
  workspaceId: z.string(),
  runtimeKind: z.enum(["task-worker", "continuable-session", "connector"]),
  defaultModel: z
    .object({
      provider: z.string(),
      model: z.string(),
      reasoningEffort: z.string().optional(),
    })
    .optional(),
  allowedTools: z.array(z.string()).max(100).default([]),
  deniedTools: z.array(z.string()).max(100).default([]),
  maxConcurrentRuns: z.number().int().min(1).max(10).default(1),
  maxRunsPerDay: z.number().int().min(1).max(10_000).default(100),
  timeoutMs: z.number().int().min(1_000).max(3_600_000),
  status: z.enum(["active", "disabled"]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
```

约束：

1. 一个 Digital Employee 在一个工作区最多一个 active Runtime Profile；
2. `allowedTools` 默认为空；
3. Runtime Profile 不授予业务权限，只限制执行方式；
4. connector 不启动模型，只执行已注册服务动作。

### 4.4 delegations

Human Avatar 的核心对象。

```ts
export const delegationSchema = z.object({
  id: z.string(),
  ownerEmployeeId: z.string(),
  avatarEmployeeId: z.string().optional(),
  personaId: z.string(),
  displayName: z.string().min(1).max(120),
  contextType: z.enum(["meeting", "task", "review"]),
  contextId: z.string(),
  workspaceId: z.string(),
  objective: z.string().min(1).max(5_000),
  stance: z.string().max(5_000).default(""),
  watchItems: z.array(z.string().max(500)).max(50).default([]),
  materialScopes: z.array(z.string()).max(100).default([]),
  allowedActions: z
    .array(
      z.enum([
        "read_meeting",
        "read_materials",
        "speak",
        "ask_question",
        "record_risk",
        "draft_summary",
        "suggest_approval",
        "submit_deliverable",
        "approve",
      ]),
    )
    .default([]),
  deniedActions: z
    .array(
      z.enum([
        "read_materials",
        "speak",
        "ask_question",
        "suggest_approval",
        "submit_deliverable",
        "approve",
      ]),
    )
    .default([]),
  approvalPolicy: z.enum(["none", "suggest-only", "auto-within-rules"]),
  autoSpeak: z.enum(["all", "mentions", "manual"]),
  expiresAt: z.string().datetime(),
  status: z.enum([
    "draft",
    "active",
    "paused",
    "completed",
    "revoked",
    "expired",
  ]),
  reportRequired: z.boolean().default(true),
  createdBy: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
```

约束：

1. Delegation 不创建员工目录记录；
2. `avatarEmployeeId` 预留给“Digital Employee 作为代理执行器”的场景；
3. Human Avatar 默认 `approvalPolicy: suggest-only`；
4. `approve` 只有显式写入 `allowedActions` 且 policy 为 `auto-within-rules` 时才可执行；
5. 过期或召回后不能再发言和读取新资料。

### 4.5 delegation_reports

```ts
export const delegationReportSchema = z.object({
  id: z.string(),
  delegationId: z.string(),
  ownerEmployeeId: z.string(),
  contextType: z.enum(["meeting", "task", "review"]),
  contextId: z.string(),
  status: z.enum(["pending", "generating", "ready", "failed"]),
  content: z
    .object({
      summary: z.string(),
      keyProcess: z.string(),
      conclusions: z.string(),
      positionsTaken: z.string(),
      risks: z.string(),
      openQuestions: z.string(),
      nextSteps: z.string(),
      missingInformation: z.string(),
      transcriptRefs: z.array(z.string()).default([]),
    })
    .optional(),
  error: z.string().max(1_000).optional(),
  createdAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
});
```

报告生成时机：

1. Avatar 主动离开；
2. 主人召回；
3. 会议关闭；
4. 委托到期；
5. Avatar 运行中断后的恢复流程。

## 5. 权限模型

### 5.1 权限来源

| 主体             | 权限来源                                        |
| ---------------- | ----------------------------------------------- |
| Human Employee   | 登录身份 + 工作区角色 + 显式授权                |
| Digital Employee | 员工岗位授权 + 工作区角色 + Runtime Tool Policy |
| Human Avatar     | 主人有效权限 + Delegation Allow - Deny          |

### 5.2 Action Ticket

每次非真人浏览器操作必须持有 Action Ticket。

```ts
export interface ActionTicket {
  id: string;
  principal: EmployeePrincipal;
  workspaceId: string;
  contextType: "workflow" | "meeting" | "task" | "review";
  contextId: string;
  allowedActions: string[];
  deniedActions: string[];
  resourceScopes: string[];
  expiresAt: string;
  createdAt: string;
}
```

规则：

1. Digital Employee Run 使用 run-scoped ticket；
2. Human Avatar 使用 delegation-scoped ticket；
3. ticket 不可跨工作区；
4. ticket 不可跨 meeting / instance / task 复用；
5. 服务端每次执行动作都重新校验 ticket；
6. 不把真人 Bearer token 下发给模型。

### 5.3 判定流程

```text
request
  -> resolve Principal
  -> load Employee
  -> if digital: load employee roles + runtime profile + run ticket
  -> if avatar: load owner + delegation ticket
  -> if human: load employee roles + session
  -> evaluate allow / deny
  -> execute
  -> audit
```

## 6. Persona、Runtime Profile 与 Employee 的关系

```text
Persona
  行为约束、语气、专业边界

Digital Employee
  企业身份、岗位、状态、职责
      |
      +--> Persona
      |
      +--> Runtime Profile
      |
      +--> Workspace Role Assignments
      |
      +--> Employee Runs
```

Human Avatar：

```text
Human Employee
      |
      +--> Delegation
              |
              +--> Persona
              +--> Meeting / Task Context
              +--> Action Ticket
              +--> Avatar Report
```

Persona 可以复用，但 Persona 本身不能获得权限。

## 7. 现有模型迁移

### 7.1 真人用户迁移

第一阶段不重写 Identity 存储。

1. 启动时为每个现有 `UserRecord` 生成或映射 `Employee`；
2. `employee.authUserId = user.id`；
3. 员工类型为 `human`；
4. 旧 `userId` API 继续可用；
5. 新 UI 显示 Employee ID 和 Human Employee。

映射表可以放在 `collab_employee`：

```text
auth_user_index
  authUserId -> employeeId
```

### 7.2 Agent Profile 迁移

当前 `AgentProfile` 定位为 transitional Task Worker 配置。

迁移策略：

1. E1/E2 建立员工模型后，提供 one-click migration；
2. 每个 active Agent Profile 创建一个 Digital Employee；
3. 原 Profile ID 写入兼容索引；
4. Runtime Profile 承接 model、tools、timeout、workspace；
5. 旧工作流 `agent:<profileId>` 继续解析；
6. 新工作流推荐 `employee:<employeeId>`。

兼容索引：

```text
legacy_agent_profiles
  agentProfileId -> employeeId
```

### 7.3 AgentRun 迁移

旧字段保留，新增字段：

```ts
employeeId?: string;
principalType?: "transitional-agent" | "digital-employee" | "human-avatar";
delegationId?: string;
ticketId?: string;
```

迁移完成后：

1. 新运行必须写入 `employeeId`；
2. 旧记录只读保留；
3. UI 中不再新建 `transitional-agent`。

### 7.4 会议分身迁移

当前 `MeetingParticipant` 中的 spawned agent 继续可用。

迁移策略：

1. 新派遣必须创建 Delegation；
2. participant 增加 `delegationId`；
3. 旧 participant 没有 delegation 时标记 `legacy-avatar`；
4. 旧记录不能自动获得新权限；
5. 只有新委托可以读取结构化资料或提交报告。

## 8. 工作流集成

### 8.1 Markdown 语法

新语法：

```md
### 开发

- id: development
- type: task
- executor: employee:backend-engineer-01
- responsible: employee:olivia
- execution: task-worker
- trigger: manual-dispatch
- max-attempts: 2
- timeout: 30m
- deliverable: implementation-report
  title: 实现说明
  type: text
  required: true
```

审批节点：

```md
### 发布审批

- id: release-approval
- type: approval
- approver: employee:li-gong
- countersigner: employee:risk-reviewer-01
```

兼容规则：

```text
employee:<employeeId>  新规范
agent:<profileId>      旧兼容
user:<userId>          旧兼容
```

### 8.2 执行流程

```text
node ready
  -> resolve executor employee
  -> check employee active
  -> check workflow assignment permission
  -> create EmployeeRun / AgentRun
  -> issue ActionTicket
  -> runtime adapter starts worker
  -> worker output -> candidate deliverable
  -> deliverable gate validation
  -> responsible review / approval
  -> node completion
```

不变式：

1. Agent 输出成功不等于节点完成；
2. required deliverable 不满足时不能推进；
3. timeout、cancel、retry 语义保持现有 Phase X 行为；
4. runtime 不可用时允许人工兜底；
5. 人工兜底记录 `onBehalfOf`。

### 8.3 审批

审批者类型：

| 类型             | 默认能力                               |
| ---------------- | -------------------------------------- |
| Human Employee   | 可通过、否决、转交、加签               |
| Digital Employee | 可在规则内通过或否决，必须记录规则依据 |
| Human Avatar     | 默认只能建议，不能最终审批             |

管理员可以在工作流定义中显式允许 Digital Employee 审批，但系统仍要记录：

1. 审批规则；
2. 输入材料；
3. 模型输出；
4. 命中的条件；
5. 最终责任负责人。

## 9. 会议集成

### 9.1 参与者

`MeetingParticipant` 新增：

```ts
employeeId?: string;
principalType?: "human" | "digital-employee" | "human-avatar";
delegationId?: string;
```

显示规则：

```text
human             显示员工名
digital-employee  显示员工名 + Digital 标识
human-avatar      显示“主人名 的分身” + AI 标识
```

### 9.2 Avatar 发送消息

流程：

```text
dispatch avatar
  -> create Delegation
  -> create MeetingParticipant
  -> issue DelegationTicket
  -> runtime starts scoped worker
  -> worker checks allowedActions
  -> postWorkerReply()
  -> audit delegation action
```

Avatar 不能直接持有 Bearer token，也不能直接调用普通浏览器 API。

### 9.3 会后报告

报告 prompt 必须基于：

1. Delegation objective；
2. 允许动作；
3. 会议 transcript；
4. Avatar 自己的发言；
5. 自己提出的风险；
6. 上下文材料；
7. 未回答问题。

报告结构固定：

```md
# 分身会议报告

## 会议关键过程

## 已表达立场

## 关键结论

## 风险与反对意见

## 待主人确认

## 后续建议

## 信息缺口
```

报告失败时不伪造成功，必须显示原因并允许重试。

## 10. API 设计

### 员工

| 方法   | 路径                                  | 说明                                 |
| ------ | ------------------------------------- | ------------------------------------ |
| `GET`  | `/api/collab/employee`                | 查询员工目录                         |
| `GET`  | `/api/collab/employee/me`             | 查询当前登录账号映射的员工           |
| `POST` | `/api/collab/employee/digital`        | 创建 Digital Employee                |
| `GET`  | `/api/collab/employee/detail`         | 查看员工详情                         |
| `POST` | `/api/collab/employee/update`         | 更新资料                             |
| `POST` | `/api/collab/employee/status`         | 启用、暂停、归档                     |
| `GET`  | `/api/collab/employee/roles`          | 查询授权                             |
| `POST` | `/api/collab/employee/roles/assign`   | 授权                                 |
| `POST` | `/api/collab/employee/roles/revoke`   | 回收授权                             |
| `GET`  | `/api/collab/employee/runtime`        | 查询 Runtime Profile                 |
| `POST` | `/api/collab/employee/runtime/upsert` | 创建或更新 Runtime Profile           |
| `POST` | `/api/collab/employee/ticket`         | 签发 Digital Employee Runtime Ticket |
| `GET`  | `/api/collab/employee/audit`          | 查询员工审计                         |

安全规则：

1. Human Employee 目录全员可读，具体字段可脱敏；
2. Digital Employee 创建、更新、启停只允许平台管理员或授权管理员；
3. 工作区 owner 只能管理本工作区授权；
4. 所有写操作审计。

### Delegation

| 方法   | 路径                                  | 说明                           |
| ------ | ------------------------------------- | ------------------------------ |
| `GET`  | `/api/collab/delegation`              | 查询委托列表                   |
| `POST` | `/api/collab/delegation/create`       | 创建 Human Avatar 委托         |
| `GET`  | `/api/collab/delegation/detail`       | 查看委托详情                   |
| `POST` | `/api/collab/delegation/extend`       | 延长有效期                     |
| `POST` | `/api/collab/delegation/status`       | 统一处理暂停、恢复、召回和完成 |
| `POST` | `/api/collab/delegation/ticket`       | 签发委托上下文 Ticket          |
| `GET`  | `/api/collab/delegation/report`       | 查询报告                       |
| `POST` | `/api/collab/delegation/report/retry` | 重试报告                       |

### Runtime

| 方法   | 路径                                  | 说明                 |
| ------ | ------------------------------------- | -------------------- |
| `GET`  | `/api/collab/employee/runtime`        | 查询 Runtime Profile |
| `POST` | `/api/collab/employee/runtime/upsert` | 保存 Runtime Profile |
| `GET`  | `/api/collab/employee/runs`           | 查询运行记录         |
| `POST` | `/api/collab/employee/runs/dispatch`  | 派发任务             |
| `POST` | `/api/collab/employee/runs/cancel`    | 取消运行             |
| `POST` | `/api/collab/employee/runs/retry`     | 重试运行             |

## 11. UI 设计

关键页面见：

```text
docs/demos/employee-platform-demo.html
```

页面包括：

1. 员工目录；
2. Digital Employee 创建向导；
3. Digital Employee 详情；
4. Human Avatar 派遣；
5. 会议参与者与分身报告；
6. 工作流节点执行；
7. 治理与审计。

主操作区新增 Workstation tab。第一期固定展示六个基础面板：

```text
员工详情 | 委托详情
工作流节点 | 审批
Avatar 报告 | 管理员权限
```

面板数据通过各域已有 API 组合，操作仍由服务端校验。by-role 面板组合保留 schema 预留：

```ts
const workstationLayout = {
  version: 1,
  status: "reserved",
  baseModules: [
    "employee-detail",
    "delegation-detail",
    "workflow-node",
    "approval",
    "avatar-report",
    "admin-permission",
  ],
  roleProfiles: {
    admin: [],
    owner: [],
    member: [],
    viewer: [],
  },
};
```

`roleProfiles` 当前不生效；自定义模块注册和持久化布局延后到独立迭代。

UI 原则：

1. 员工、Persona、Runtime、Run 分开展示；
2. 不用“Agent”作为唯一泛化标签；
3. Digital Employee 有稳定徽标；
4. Human Avatar 必须显示主人；
5. 所有到期时间使用本地可读时间；
6. 所有 ID 可复制，但不作为主要展示名。

## 12. 审计事件

核心事件：

```text
employee.created
employee.updated
employee.status_changed
employee.role_assigned
employee.role_revoked
employee.runtime.updated

delegation.created
delegation.paused
delegation.resumed
delegation.revoked
delegation.expired
delegation.material_read
delegation.message_sent
delegation.report_generated
delegation.report_failed

employee.run.dispatched
employee.run.succeeded
employee.run.failed
employee.run.cancelled
employee.run.timeout

workflow.employee_assigned
workflow.deliverable_submitted
workflow.approval_decided
```

每条审计事件包含：

```ts
{
  eventId: string;
  at: string;
  workspaceId: string;
  actorEmployeeId?: string;
  authUserId?: string;
  principalType: "human" | "digital" | "avatar";
  delegationId?: string;
  ticketId?: string;
  runId?: string;
  action: string;
  resourceType: string;
  resourceId: string;
  decision: "allowed" | "denied";
  reason?: string;
}
```

越权请求也要记录，不能只返回 403。

## 13. 存储域

新增：

```ts
export const employeeDomainSpec = {
  name: "collab_employee",
  version: 1,
  tables: {
    employees: {},
    authUserIndex: {},
    roleAssignments: {},
    runtimeProfiles: {},
    delegations: {},
    delegationReports: {},
    legacyAgentProfileIndex: {},
  },
};
```

分表原则：

1. `employees` 是目录；
2. `delegations` 是临时委托；
3. `runtimeProfiles` 是执行配置；
4. `delegationReports` 是交付给主人的结果；
5. 不把大文本 transcript 直接写入主表。

## 14. 测试策略

### 单元测试

1. Employee schema；
2. Human / Digital 约束；
3. Runtime Profile 约束；
4. Delegation allow / deny 计算；
5. ticket 过期；
6. archived / suspended 拒绝派发。

### 权限测试

1. Digital Employee 无角色时不能读资料；
2. Digital Employee 只能调用工具白名单；
3. Avatar 不能继承主人未显式允许的动作；
4. deny 优先于 allow；
5. approve 只有显式授权时可用；
6. 跨工作区 ticket 无效。

### 会议测试

1. Avatar 创建 Delegation；
2. participant 显示主人；
3. AI 发言有标识；
4. 召回后不能发言；
5. 到期后不能读取新消息；
6. 每次退出生成报告；
7. 报告失败可重试。

### 工作流测试

1. `employee:<id>` 正确解析；
2. `agent:<id>` 兼容解析；
3. disabled employee 不派发；
4. run ticket 不跨节点复用；
5. 必交交付物缺失时不能完成；
6. Digital Employee 审批必须记录规则依据；
7. Human Avatar 默认只能建议审批。

### 迁移测试

1. 现有用户生成 Human Employee；
2. 一个 auth user 只映射一个 Employee；
3. Agent Profile 可迁移；
4. 旧工作流模板仍可导入；
5. 旧会议记录保持只读；
6. 新旧 API 并存不冲突。

## 15. 实施顺序

| 阶段 | 技术交付                  | 主要验收                      |
| ---- | ------------------------- | ----------------------------- |
| E0   | 现有 Phase X 收尾         | 输出契约、重试、check、commit |
| E1   | Employee 目录和 ID 映射   | 真人账号映射、目录可见        |
| E2   | Digital Employee 生命周期 | 创建、启停、归档、审计        |
| E3   | Principal + Action Ticket | 权限计算和越权拒绝            |
| E4   | Human Avatar / Delegation | 结构化委托、报告、召回        |
| E5   | Workflow 收敛             | 员工执行者、旧语法兼容、审批  |
| E6   | 治理中心                  | 审计、预算、异常、权限矩阵    |
| E7   | Workstation               | 面板组合和权限一致            |

## 16. 验收总标准

当以下句子同时成立时，本设计完成：

1. 管理员可以在同一个员工目录中管理真人和数字员工。
2. Digital Employee 可以像 Human Employee 一样被分配工作区角色。
3. Digital Employee 的权限不来自 Persona，也不自动继承创建者。
4. Human Avatar 明确显示为某个真人的受限代表。
5. Human Avatar 的每个动作可以追溯到 Delegation Ticket。
6. 会议结束后 Human Avatar 能生成分身维度报告。
7. 工作流可以稳定指派 Digital Employee，并保留交付物和审批门禁。
8. 旧 Phase X 能力以兼容方式运行，且新能力不再扩散 transitional 模型。
