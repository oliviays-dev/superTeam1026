# 平台身份与权限方案：Principal、账号与 AI 伙伴

> 状态：已确认方向（2026-10-17）  
> 结论：平台不建设 Employee 产品域，统一使用 Principal 作为授权与追责主体。  
> 取代：`docs/platform-settings-employee-overlap-audit.md` 中原有的 Employee 合并目标  
> 保留：现有 `collab_employee` 仅作为迁移期兼容运行层，不再新增员工平台能力。
> GUI 验收：`docs/platform-principal-gui-e2e-test-plan.md`
> GUI 执行结果：`docs/platform-principal-gui-e2e-results-20261017.md`

## 1. 核心决策

平台身份模型收敛为：

```text
Platform Principal
├─ Human Principal
│  └─ 可选绑定 Account / Credential
└─ AI Principal
   └─ 绑定 AI Companion 与 AI Runtime
```

关键规则：

1. Principal 是任务、工作流、会议、项目角色和审计的唯一主体。
2. Account 是人类的认证能力，不承担员工档案职责。
3. AI Companion 是 AI Principal 的产品与协作界面，不是第二份权限主体。
4. Role Grant 指向 Principal，不区分“账号角色”和“员工角色”两套主体。
5. HRM、组织、部门、岗位、汇报关系和入离职由未来独立 HRM 管理。
6. 平台只保存与认证、授权、运行和审计相关的数据。

## 2. 为什么不再引入 Employee 产品概念

Employee 适合作为 HRM 或企业管理系统的一等对象，但不应成为当前协作平台的核心业务对象。

原因：

1. 人类已经可以通过平台账号完成登录和协作，不需要第二套人员目录。
2. AI 没有雇佣关系，也不应被强制套进部门、岗位、汇报线和离职流程。
3. 未来接入 HRM 后，Employee 的业务事实应由 HRM 拥有，平台不应保存第二份员工主数据。
4. 当前任务、工作流和会议真正需要的是稳定主体 ID，而不是员工档案。
5. 继续建设 Employee 域会形成“平台员工状态”和“HRM 员工状态”双写。

因此，平台不使用 Employee 作为产品语言，也不继续建设员工目录、员工治理中心或 HR 生命周期页面。

## 3. 领域边界

| 领域              | 负责内容                                 | 不负责内容            |
| ----------------- | ---------------------------------------- | --------------------- |
| Platform Identity | Principal、账号、凭据、登录会话          | 部门、岗位、汇报关系  |
| RBAC              | 角色、权限、Grant、授权范围              | 人事生命周期          |
| AI Companion      | AI 身份投影、模版、协作入口              | 平台角色继承          |
| AI Runtime        | 模型、工具、预算、Action Ticket          | 员工档案              |
| Project           | 项目成员、项目角色和项目内授权           | 平台账号与凭据        |
| HRM（未来）       | 员工编号、组织、部门、岗位、经理、入离职 | 平台登录和项目授权    |
| Delegation        | Human Avatar 的受限代表                  | 独立 Principal 或员工 |

### 3.1 Principal

Principal 是平台内稳定、可授权、可追责的主体。

建议字段：

```ts
interface Principal {
  id: string;
  kind: "human" | "ai";
  displayName: string;
  status: "active" | "suspended" | "archived";
  source: "local" | "ai-companion" | "hrm";
  createdAt: string;
  updatedAt: string;
}
```

约束：

1. Principal ID 全局稳定。
2. Principal 不保存密码。
3. Principal 不保存组织汇报关系和 HR 档案。
4. Human Principal 可以没有登录账号，例如未来由 HRM 预同步的人员。
5. AI Principal 永远没有密码登录。
6. archived Principal 不能再参与新任务、新工作流或新授权。

### 3.2 Account / Credential

Account 是 Principal 的可选认证能力。

建议拆分：

```ts
interface AccountCredential {
  principalId: string;
  loginId: string;
  type: "password" | "sso" | "service";
  status: "active" | "pending" | "disabled";
  passwordHash?: string;
  lastLoginAt?: string;
}
```

规则：

1. 密码、SSO、会话和登录失败次数属于 Credential。
2. Human Principal 最多一个主登录账号。
3. AI Principal 默认没有 Credential。
4. 只有认证失败、会话吊销和安全限制属于账号领域。
5. 离职、组织调整和经理变化不属于 Credential。

### 3.3 AI Companion

AI Companion 是 AI Principal 的协作投影。

建议绑定：

```ts
interface AiCompanion {
  id: string;
  principalId: string;
  templateId: string;
  state: "active" | "paused" | "inactive" | "archived";
  ownerPrincipalId?: string;
  externalRuntimeId?: string;
}
```

规则：

1. 一个 AI Companion 绑定唯一 AI Principal。
2. Owner 只表示业务负责人，不产生权限继承。
3. AI 的平台角色必须显式授予，默认不是平台管理员。
4. AI Companion 归档时同步归档 AI Principal。
5. AI Partner 的页面继续使用产品名称「AI 伙伴」，不向用户暴露 Employee。

### 3.4 Role 与 Grant

角色定义和授权关系分离。

```ts
interface Role {
  id: string;
  name: string;
  scopeType: "platform" | "workspace" | "project";
  permissions: readonly string[];
}

interface RoleGrant {
  id: string;
  principalId: string;
  roleId: string;
  scopeType: "platform" | "workspace" | "project";
  scopeId: string;
  status: "active" | "revoked" | "expired";
  expiresAt?: string;
  grantedByPrincipalId: string;
  createdAt: string;
}
```

规则：

1. 人类和 AI 使用同一 Grant 模型。
2. 权限来自显式 Grant、项目角色和 Runtime Policy 的交集。
3. Persona、岗位名称和 Owner 身份都不授予权限。
4. 项目范围授权只有一个可写事实来源。
5. 敏感动作审计记录 Principal ID、Grant ID 和 Run/Ticket ID。

### 3.5 AI Runtime

Runtime Profile 和 Action Ticket 按 Principal 归属：

```text
AI Principal
  ├─ AI Companion
  ├─ Runtime Profile(workspaceId)
  ├─ Action Ticket(contextId)
  └─ AI Run
```

Runtime 规则：

1. Runtime Profile 只限制执行方式，不授予业务权限。
2. Action Ticket 绑定 Principal、工作区、上下文和有效期。
3. AI 运行不得使用人类 Bearer Token。
4. AI 最终审批仍走专用 runtime decision path。

### 3.6 External HRM Link

未来接入 HRM 时新增映射，而不是新增平台 Employee 主数据：

```ts
interface ExternalIdentityLink {
  provider: "hrm";
  externalEmployeeId: string;
  principalId: string;
  syncVersion: string;
  syncedAt: string;
}
```

HRM 负责：

1. 员工编号。
2. 部门和岗位。
3. 直属经理。
4. 入职、转岗、离职。
5. 企业员工目录和组织架构。

平台负责：

1. Human Principal。
2. 登录账号或邀请状态。
3. 平台、工作区和项目角色。
4. 项目成员关系。
5. 平台安全审计。

## 4. 权限计算

### 4.1 Human Principal

```text
人类有效访问 =
  人类 Principal 为 active
  AND 登录 Credential 为 active
  AND 对应范围存在有效 Role Grant
```

若 HRM 已完成接入：

```text
人类可登录 =
  Principal 为 active
  AND Credential 为 active
  AND HRM employment status 允许访问
```

离职由 HRM 事件触发 Principal 归档和 Credential 停用，而不是在平台维护第二套“员工状态”。

### 4.2 AI Principal

```text
AI 可派发 =
  AI Principal 为 active
  AND AI Companion 为 active
  AND 目标范围存在有效 Role Grant
  AND 存在有效 Runtime Profile
  AND Action Ticket 校验通过
```

### 4.3 Human Avatar

Human Avatar 不是 Principal。

```text
Avatar 有效权限 =
  主人 Principal 有效权限
  ∩ Delegation Allow
  - Delegation Deny
  - 上下文限制
```

## 5. 产品信息架构

### 5.1 平台设置

不再提供「企业员工」页签。

```text
平台设置
└─ 账号与权限
   ├─ 登录账号
   ├─ 角色
   ├─ 授权
   └─ 审计
```

登录账号页：

1. 登录 ID。
2. Principal 名称。
3. 登录状态。
4. 平台角色摘要。
5. 最近登录。
6. 会话和密码管理。

角色页：

1. 平台角色。
2. 工作区成员角色。
3. 项目角色目录。
4. 权限目录。

授权页：

1. Principal。
2. Principal 类型。
3. 范围。
4. 角色。
5. 生效和失效时间。
6. 授权人与审计。

### 5.2 AI 伙伴

AI 伙伴页面负责：

1. 创建和管理 AI Companion。
2. 选择模版和运行方式。
3. 维护 Persona、工具和预算。
4. 查看当前工作、计划、日报和历史。
5. 查看项目角色和有效授权。
6. 暂停、归档和恢复。

AI 伙伴不负责：

1. 创建可登录账号。
2. 继承 Owner 平台角色。
3. 维护组织汇报关系。
4. 管理员工目录。

### 5.3 项目管理

项目成员页同时支持：

1. Human Principal。
2. AI Principal。
3. 项目角色 Grant。

项目内只读显示平台角色和 Principal 类型，不允许修改登录凭据。

## 6. 当前代码的过渡边界

当前代码仍存在：

1. `collab_team.users` 同时承载人类 Principal 和 Credential。
2. `collab_employee.employees` 作为隐藏兼容层承载 human / digital 两种主体。
3. AI Companion 通过 `employeeId` 绑定数字员工。
4. 工作流继续使用 `employee:<id>`。
5. 员工工作区授权与项目角色授权仍有两套来源。
6. Phase 1.5 已撤下企业员工产品面，设置只保留账号与权限。

这些不是目标模型，只是迁移基线。

过渡规则：

1. 不再新增 Employee 领域能力。
2. 不再建设员工目录、员工治理和 HR 字段。
3. 现有 Employee 记录只作为 Principal 迁移来源。
4. `employeeId` 只作为兼容字段，不再作为新产品主标识。
5. 新能力优先使用 `principalId` 概念和接口。

## 7. 分阶段迁移

### Phase 1.5：撤下员工产品面

目标：产品立即回到「账号与权限 + AI 伙伴」。

实施状态：已完成 2026-10-17。

1. 设置页从「身份与权限」改为「账号与权限」。
2. 已移除「企业员工」页签。
3. 保留登录账号、角色、审计，默认进入登录账号。
4. AI 伙伴创建入口已回到 AI 伙伴页面，并要求选择关联项目。
5. AI 伙伴创建后由后台自动建立隐藏运行身份、Runtime Profile 和项目成员授权。
6. 登录账号与内部运行身份的映射继续保留，但不再作为人员目录展示。
7. 不再展示数字员工创建表单和员工平台说明。

### Phase 2：Principal 基础层

目标：建立唯一主体抽象，不立即删除 Employee 数据。

实施状态：已完成 2026-10-17；业务消费者已在 Phase 3 完成迁移期接入。

1. 新增 Principal 服务。
2. 把人类账号映射为 Human Principal。
3. 把数字员工映射为 AI Principal。
4. AI Companion 绑定 AI Principal。
5. 新 Role Grant 写入 Principal。
6. Employee API 增加 Principal 适配层。

实施说明：

1. 新存储域为 `collab_principal`，包含 `principals`、`principal_links`、`role_grants`。
2. 平台账号启动和创建/更新时自动同步 Human Principal。
3. Human Employee 优先复用 `auth-user` 映射，不重复创建 Principal；同一账号存在历史 Employee 记录时，只投影当前有效记录。
4. Digital Employee 映射为 AI Principal，AI Companion 通过 `teammate` 关联同一 Principal。
5. Employee 的创建、资料更新和状态变化会同步 Principal。
6. AI Principal 禁止绑定登录账号。
7. 新增 Principal 查询、主体解析和基础 Grant API。
8. 登录账号停用会投影为 Human Principal `suspended`；凭据同步不会复活已归档 Principal。
9. Employee 兼容 DTO 返回 `principalId`，业务侧无需提前理解 Principal 存储。
10. 基础 Grant API 拒绝给已归档 Principal 新增授权。
11. 现有任务、工作流、会议、项目和 UI 尚未改用 `principalId`，继续走 Employee 兼容路径。

基础 API：

| 方法 | 路径                                   | 说明                                      |
| ---- | -------------------------------------- | ----------------------------------------- |
| GET  | `/api/collab/principals`               | 管理员查看 Principal 目录                 |
| GET  | `/api/collab/principals/resolve`       | 按 subjectType + subjectId 解析 Principal |
| GET  | `/api/collab/principals/grants`        | 管理员查看基础 Grant                      |
| POST | `/api/collab/principals/grants/assign` | 管理员创建基础 Grant                      |
| POST | `/api/collab/principals/grants/revoke` | 管理员撤销基础 Grant                      |

当前 Grant 是基础存储，尚未替代项目角色席位和员工工作区授权；统一消费在 Phase 3 完成。

### Phase 3：统一 RBAC 与运行主体

目标：新授权只使用 Principal。

实施状态：已完成（迁移期双写）2026-10-17。

1. 平台角色 Grant 指向 Principal。
2. 项目角色 Grant 指向 Principal。
3. Runtime Profile 和 Action Ticket 使用 Principal ID。
4. 任务、工作流和会议接受 `principal:<id>`。
5. `employee:<id>` 作为兼容别名。
6. 项目成员页使用 Principal 候选。
7. 审计统一记录 Principal ID。

实施说明：

1. Principal 服务新增 `resolveReference`：`principal:<id>` 是规范引用，`employee:<id>`、`teammate:<id>`、`auth-user:<id>` 与裸 ID 作为迁移别名。
2. 平台账号角色同步为 `platform/platform` Grant；角色变化时旧 Grant 自动撤销。
3. 工作区成员角色同步为 `workspace/<workspaceId>` Grant；项目角色席位同步为 `project/<workspaceId>` Grant。
4. Employee 工作区授权同步为 Principal Grant；历史 Runtime Profile、Action Ticket、Delegation 在启动同步时补齐 `principalId`。
5. Task 接受 `principal:<id>` / `employee:<id>`，内部仍保存兼容执行人 ID，同时写入 `receiverPrincipalId`。
6. Workflow 在解析前把 `principal:<id>` 归一化为 `user:<id>` 或 `employee:<id>`；Run 与事件记录 Principal ID。
7. Meeting 的 AI 参与者和参会代表接受 Principal 引用，并归一化到当前 Teammate / Employee 别名。
8. 项目成员目录返回 `principalId`，前端以 Principal 作为添加成员时的规范提交值。
9. Task Event、Workflow Event、Employee Audit 和 Project Audit 新增 `actorPrincipalId`。
10. 为兼容历史调用，底层 `userId` / `employeeId` / `teammateId` 字段继续保留；Phase 4 再完成移除。

### Phase 4：下线 Employee 兼容层

目标：删除产品概念，再删除技术兼容。

实施状态：4A、4B、4C 已完成 2026-10-17；新 AI 伙伴使用 Principal Runtime，历史 AI 伙伴启动时迁移到 Principal-first，Employee 表仅保留历史回查。

#### Phase 4A：冻结产品写入

1. Employee 产品创建、资料更新、状态变更、角色写入、Runtime Profile 写入和 Ticket 写入接口返回 `410 gone`。
2. Employee 列表、详情、角色、Runtime Profile、Delegation、Ticket 和 Audit 继续只读兼容。
3. 新增管理员数据导出接口 `GET /api/collab/employee/export`。
4. 新增管理员一致性报告 `GET /api/collab/employee/compatibility`，检查 Employee/Principal 映射、类型、状态、Grant、Runtime Profile、Ticket 和 Delegation 的迁移缺口。
5. 4A 阶段 AI 伙伴仍通过内部 Employee 兼容适配器写入；Phase 4B 已将新实例迁移到 Principal Runtime。

#### Phase 4B：Principal Runtime

1. 新建 Principal-owned Runtime Profile 与 Action Ticket。
2. AI Companion 首次派发不再创建 Employee 记录。
3. Task / Workflow / Meeting 优先读取 Principal Runtime，Employee 仅作历史回查。
4. 完成 Run、Ticket、Delegation 的双读校验。

实施说明：

1. 新存储域 `collab_principal_runtime` 保存 `profiles` 与 `action_tickets`。
2. Teammate 增加 `principalId`；首次派发直接创建 AI Principal、Runtime Profile 和 workspace Grant。
3. 新建 AI伙伴不再调用 `createDigital`，不再生成 Employee / Runtime Profile / Role Assignment 兼容记录。
4. 已绑定 `employeeId` 的历史实例继续走 Employee 兼容分支，不迁移或删除历史运行数据。
5. Task 与 Workflow 在 Principal Runtime 派发前签发 Action Ticket；完成回写时校验 Ticket、上下文和资源范围。
6. Agent Run 增加 `principal-runtime` 类型，并记录 `principalId`。
7. Meeting 的 Runtime 身份优先读取 Principal Runtime Profile；历史会议仍可按 Employee ID 回查。

#### Phase 4C：清理

实施说明：

1. 启动时扫描带 `employeeId` 的历史 AI 伙伴，将 Employee Runtime Profile 映射为 Principal Runtime Profile。
2. 迁移保留原 `employeeId` 作为历史别名，不回写或删除 Employee 数据。
3. 已完成迁移的实例优先走 Principal 路径；即使仍有 `employeeId`，新项目也创建 Principal Runtime Profile。
4. 增加管理员接口 `POST /api/collab/teammates/migrate-principals`，可重复执行并返回扫描、迁移、已迁移、跳过和失败数量。
5. AI Principal 为暂停或归档状态时，不允许回退到 Employee 运行路径。
6. Employee 产品入口保持隐藏，所有 Employee 写接口维持 `410 gone`。

下线验收：

1. 停止新增 Employee 记录。
2. 完成历史数据迁移。
3. Employee 读取接口转入只读兼容。
4. Task / Workflow / Meeting / Project 全部改用 Principal。
5. 隐藏并最终删除 `dsh-collab-employee` 产品入口。
6. 删除前保留数据导出与审计查询。

### Phase 5：HRM 对接

目标：企业员工主数据由 HRM 提供。

1. 配置 HRM connector。
2. 同步员工到 `ExternalIdentityLink → Principal`。
3. 新员工可选发送平台邀请。
4. 离职事件归档 Principal 并停用 Credential。
5. 组织信息仅在 HRM 或 HRM 视图展示。
6. 平台不复制 HRM 作为第二事实来源。

## 8. 数据迁移映射

| 当前数据                                  | 目标数据                      |
| ----------------------------------------- | ----------------------------- |
| `collab_team.users.id`                    | Human Principal ID 或兼容别名 |
| `collab_team.users.passwordHash`          | Account Credential            |
| `collab_team.users.status`                | Credential status             |
| `collab_employee.employees(kind=human)`   | Human Principal               |
| `collab_employee.employees(kind=digital)` | AI Principal                  |
| `teammate.employeeId`                     | `teammate.principalId`        |
| `employee.role_assignments`               | Principal Role Grant          |
| `employee.runtime_profiles`               | AI Principal Runtime Profile  |
| `employee.action_tickets`                 | Principal Action Ticket       |
| `employee.delegations.ownerId`            | owner Principal ID            |
| `employee.audit_events.actorEmployeeId`   | actor Principal ID            |
| `workspace_members.userId`                | Principal ID 或账号兼容映射   |

迁移期必须保留：

1. 原 Employee ID 作为兼容别名。
2. `employee:<id>` 工作流语法。
3. 历史 Run、Ticket、Meeting 和 Audit 的查询能力。
4. 双读校验和冲突报告。

## 9. 下线清单

### 9.1 产品层下线

1. 企业员工目录。
2. 员工详情中的 HR 资料。
3. 人类员工创建流程。
4. 数字员工独立创建页。
5. 员工治理中心。
6. 员工生命周期作为独立产品模块。
7. “员工数量”与其他 HR 型统计。

### 9.2 领域层迁移后下线

1. `collab_employee.employees` 的产品职责。
2. 员工工作区授权作为独立 Grant 来源。
3. 员工专属 Principal DTO。
4. `employeeId` 对外主标识。
5. 数字员工与 AI Companion 的双状态机。

### 9.3 必须保留的能力

1. Principal 稳定 ID。
2. 人类登录、会话和安全限制。
3. AI Companion 创建、暂停、归档和恢复。
4. AI Runtime Profile、工具边界、预算和 Action Ticket。
5. 平台、工作区和项目角色授权。
6. Human Avatar / Delegation。
7. 任务、工作流、会议、项目和审计的主体关联。

## 10. HRM 接入原则

1. HRM 是员工、组织和雇佣状态的事实来源。
2. 平台是 Principal、Credential、Role Grant 和审计的事实来源。
3. HRM 不直接编辑平台角色和凭据。
4. 平台不提供第二套企业员工主数据编辑页。
5. HRM 外部员工 ID 不进入认证 Token。
6. 平台邀请和账号状态可以与 HRM 状态联动，但必须保留独立安全停用能力。
7. AI Principal 不进入 HRM 员工目录。

## 11. 验收标准

### 11.1 主体

1. 任一任务执行者都能解析为唯一 Principal。
2. Human Principal 可以绑定一个登录账号。
3. AI Principal 没有密码登录。
4. AI Companion 与 AI Principal 双向可追溯。
5. HRM 员工可通过 ExternalIdentityLink 定位到 Human Principal。

### 11.2 权限

1. 人类与 AI 使用同一 Grant 结构。
2. 项目权限只有一个可写事实来源。
3. Owner 不产生权限继承。
4. 撤销 Grant 后任务、工作流和 AI 运行立即按新权限校验。
5. 非管理员不能枚举其他 Principal 的授权详情。

### 11.3 产品

1. 平台设置不存在企业员工目录。
2. 账号与权限支持登录账号、角色、授权和审计。
3. AI 伙伴是 AI Principal 的唯一产品入口。
4. 项目成员页可以选择 Human Principal 和 AI Principal。
5. Human Avatar 不出现在 Principal 选择器中。

### 11.4 兼容

1. `employee:<id>` 在迁移期可解析到 Principal。
2. 历史任务、工作流、会议、Run 和审计不丢失。
3. 旧 Employee 数据可导出。
4. Employee 插件下线不影响账号登录和 AI 伙伴运行。

## 12. 非目标

当前阶段不做：

1. 自建 HRM。
2. 自建企业组织架构。
3. 员工绩效、薪酬、合同和假勤。
4. 把 AI Companion 放进 HRM 员工名册。
5. AI 自动继承 Owner 平台角色。
6. Human Avatar 成为独立 Principal。

## 13. 最终判断

先不引入 Employee 产品概念是正确的。

平台现在需要的是：

```text
Principal 负责“谁”
Credential 负责“如何登录”
AI Companion 负责“AI 是谁、如何协作”
Role Grant 负责“能做什么”
HRM 负责“企业雇佣关系与组织信息”
```

这五个边界清晰后，平台可以先用账号与 AI 伙伴完成闭环，未来再独立接入 HRM，而不需要推翻现有权限与审计体系。
