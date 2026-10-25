# 三层员工体系产品路线图

> 2026-10-17 方向调整：本路线图暂停，不再作为目标产品模型。平台不再建设 Employee 产品域，统一改为 Principal；人类使用 Account / Credential，AI 使用 AI Principal + AI Companion。未来企业员工和组织信息由独立 HRM 管理。当前 `collab_employee` 仅保留为迁移期兼容层。新方案见 `docs/platform-principal-rbac-design.md`。

## 1. 结论

Pluginmax 的企业协作模型固定为三层：

| 层级     | 英文概念                  | 定位                                                   | 是否平台授权主体 |
| -------- | ------------------------- | ------------------------------------------------------ | ---------------- |
| 真人员工 | Human Employee            | 企业中的真人，可登录、可授权、可追责                   | 是               |
| 数字员工 | Digital Employee          | 管理员创建的正式数字员工，有岗位、职责、授权和运行配置 | 是               |
| 人类分身 | Human Avatar / Delegation | 真人在特定任务或会议中派出的受限数字代表               | 否               |

这三层不能混用。

Persona 只是“人设资产”，不是员工。  
Agent Profile / Runtime Profile 只是“运行配置”，不是员工。  
Agent Run 是“一次运行记录”，也不是员工。

企业平台必须先回答“这是谁”，再回答“它怎么运行”。

## 2. 当前差异

当前系统已经有可用的基础：

1. Identity 插件提供真人账号、登录、工作区成员和审计。
2. Roles 插件提供 Persona、工作区类型、席位和认领。
3. Meeting 插件提供会议、真人参与者、Agent 分身、@定向和会议记录。
4. Workflow 与 Phase X 插件提供工作流执行、Agent Profile、Agent Run、交付物门禁和人工兜底。

但当前模型还没有形成企业员工目录：

1. `UserRecord` 本质上是可登录账号，没有 `employeeType: human | digital`。
2. Digital Employee 还不是一等员工主体。
3. 会议分身只有 `ownerId / ownerName / personaId`，没有结构化委托单。
4. 会议分身不能继承主人权限，也不能安全访问授权材料。
5. Agent Profile 与 Digital Employee 的关系还没有定义。
6. 会后报告、审批委托、权限边界和审计事件仍分散在不同插件中。

因此，现有 Phase X 更像“过渡期 Task Worker 执行能力”，还不是完整的 Digital Employee 执行能力。

## 3. 产品语言

### Human Employee

真人员工是企业目录中的第一类主体。

它有：

1. 员工 ID；
2. 显示名；
3. 部门、职务、标签；
4. 登录身份；
5. 工作区成员角色；
6. 可创建分身的授权。

界面上不应该把 Human Employee 叫作 Agent。

### Digital Employee

Digital Employee 是正式数字员工，不是临时分身。

它有：

1. 稳定员工 ID；
2. 显示名和岗位；
3. 所属部门和负责人；
4. Persona 或人设模板；
5. Runtime Profile：模型、工具、预算、并发和执行形态；
6. 工作区角色和权限；
7. 状态：草稿、启用、暂停、归档；
8. 独立运行历史和审计。

它可以像 Human Employee 一样被指派任务、审批或成为工作流负责人。实际配置时可以给予远低于真人员工的权限，但模型上必须支持同等颗粒度。

### Human Avatar / Delegation

Human Avatar 是 Human Employee 派出的受限代表。

它有：

1. 明确主人；
2. 明确任务上下文，例如会议、评审或审批；
3. Persona；
4. 任务简报；
5. 允许动作；
6. 禁止动作；
7. 可见资料范围；
8. 到期时间；
9. 会后报告要求；
10. 独立审计轨迹。

它不进入员工目录，不拥有独立岗位，不继承主人的全部权限。

## 4. 核心用户旅程

### 旅程 A：管理员创建 Digital Employee

1. 管理员进入「设置 > 员工」。
2. 选择「新增数字员工」。
3. 填写姓名、岗位、部门、负责人。
4. 选择 Persona 或导入 SOUL。
5. 配置 Runtime Profile：默认模型、可用工具、预算、并发、超时。
6. 按工作区分配角色。
7. 保存后员工目录出现该 Digital Employee。
8. 后续工作流、会议、任务可以直接选择该员工。

### 旅程 B：真人创建会议分身

1. Alice 打开会议侧边栏。
2. 进入目标会议。
3. 点击「派分身」。
4. 选择 Persona 和会议任务简报。
5. 设置允许动作：阅读议程、发言、记录风险、提出建议。
6. 设置禁止动作：不能审批，不能代表 Alice 同意结论。
7. 选择资料范围和有效期。
8. 派遣后，参与者列表显示“Olivia 的分身”。
9. 分身发言有 AI 标识。
10. 会议结束或分身退出后，自动生成给 Alice 的分身报告。

### 旅程 C：工作流指派 Digital Employee

1. 管理员导入工作流模板。
2. 开发节点写 `executor: employee:backend-engineer-01`。
3. 实例启动后，节点显示执行者是 `Backend Engineer 01`。
4. 节点 ready 后按模板策略手动或自动派发。
5. Digital Employee 运行，产生 Employee Run / Agent Run。
6. 输出进入交付物候选区。
7. 必交交付物不满足时，节点不能完成。
8. 责任人或审批人确认后流程推进。

### 旅程 D：治理与审计

管理员可以回答四个问题：

1. 这是谁在操作？
2. 它的权限来自哪里？
3. 它看过什么、做过什么？
4. 最终责任归属是谁？

## 5. 页面信息架构

### 左侧栏

左侧栏继续以真人会话为主。

1. 真人会话保持在「工作区 / 会话」中；
2. Human Avatar 不自动产生左侧 home session；
3. Digital Employee 只有显式开启 home session 后才出现在独立分组；
4. 默认不把 Task Worker 显示成左侧会话。

### 设置

设置中新增一级概念：

```text
员工
  目录
  数字员工
  分身与委托
  权限矩阵
  审计

角色与人设
  Persona
  工作区类型
  席位
```

「员工」成为企业身份入口。Persona、Runtime Profile 和席位是被员工引用的资产或授权，不应再承担员工目录职责。

### 会议

会议参与者列表必须区分：

```text
Olivia                    Human Employee
李工                      Human Employee
Backend Engineer 01       Digital Employee
Olivia 的评审分身          Human Avatar
```

Human Avatar 必须显示主人和委托范围。

### 工作流

工作流节点执行者统一显示为：

```text
执行者：Backend Engineer 01 · Digital Employee
责任人：Olivia · Human Employee
审批人：李工 · Human Employee
```

不再把所有执行者笼统显示成 Agent。

## 6. 阶段规划

### E0：冻结并收尾当前 Phase X

目标：先把已经完成的过渡能力稳定住，不再扩散旧模型。

范围：

1. 收敛当前工作流 Agent 输出契约；
2. 强制输出 `# 交付报告` 和 `## 交付说明`；
3. 校验失败时保留原始输出并触发一次修复重试；
4. 明确当前 `dsh-collab-agent` 是 transitional Task Worker，不是正式员工模型；
5. 跑全量 check；
6. commit 当前已验证改动。

验收：

1. Agent 输出能稳定进入交付物校验；
2. 校验失败有明确用户反馈；
3. 自动修复重试不超过定义的 `max-attempts`；
4. 现有 GUI 测试方案可执行；
5. 不引入新的员工模型破坏性变更。

### E1：Employee Identity Foundation

目标：建立员工目录和统一员工 ID，不立即重写所有插件。

范围：

1. 新增 `collab_employee` 数据域；
2. Employee 记录支持 `human | digital`；
3. 现有真人用户迁移或映射为 Human Employee；
4. 新增 `dsh-collab-employee` 插件；
5. 提供 `/api/collab/employee` 查询接口；
6. 设置页增加「员工 > 目录」；
7. 所有现有登录账号在 UI 中显示为 Human Employee。

硬性规则：

1. Human Employee 继续使用 Identity 登录；
2. Digital Employee 没有密码登录；
3. 员工 ID 是后续授权、运行和审计的主标识；
4. 旧 `userId` 保留兼容映射。

验收：

1. 员工目录能显示真人和数字员工；
2. 每个真人账号都有稳定 Employee ID；
3. 旧功能不受影响；
4. API 不能把 Digital Employee 当作可登录用户返回。

### E2：Digital Employee 生命周期

目标：让 Digital Employee 成为可管理的正式主体。

范围：

1. 新增 Digital Employee 创建向导；
2. 生命周期：草稿、启用、暂停、归档；
3. 管理部门、岗位、负责人和标签；
4. 绑定 Persona；
5. 创建 Runtime Profile；
6. 工作区角色授权；
7. 查看员工详情和运行历史；
8. 管理员操作全部进入审计。

产品规则：

1. 只有平台管理员或被授权的 HR/IT 角色能创建 Digital Employee；
2. 工作区 owner 可以申请或启用，但不能隐式创建全公司员工；
3. Runtime Profile 默认没有工具权限；
4. 权限必须显式授予；
5. 归档后不能再派发新任务。

验收：

1. 管理员能创建一个 Digital Employee；
2. 能配置 Persona、模型、工具白名单和预算；
3. 能暂停和恢复；
4. 禁用后所有派发入口不可用；
5. 创建、更新、启停、归档都有审计。

### E3：统一授权与 Action Ticket

目标：把权限从“隐式继承”改成“显式授权 + 受限票据”。

范围：

1. 定义 Employee Principal；
2. 定义 Action Ticket；
3. Digital Employee 权限由角色、工具策略和资源范围共同决定；
4. Human Avatar 权限由主人权限、委托允许项和显式禁止项共同决定；
5. 所有敏感动作记录权限来源；
6. 事件中同时写入 `employeeId`、`userId`、`delegationId`、`runId`。

权限计算：

```text
Digital Employee 有效权限 =
  员工岗位授权
  ∩ 工作区角色权限
  ∩ Runtime Tool Policy
  - 显式 Deny

Human Avatar 有效权限 =
  主人有效权限
  ∩ Delegation Allow
  - Delegation Deny
  - 任务上下文限制
```

验收：

1. Digital Employee 不能因为 Persona 获得权限；
2. Avatar 不能继承主人全部权限；
3. 越权读取、越权审批、跨工作区操作被拒绝；
4. 每个敏感操作可以追溯授权链。

### E4：Human Avatar / Delegation

目标：把当前会议分身升级为结构化委托。

范围：

1. 新增 Delegation 创建流程；
2. 支持会议、任务、评审三类上下文；
3. 任务简报结构化；
4. 配置允许动作和禁止动作；
5. 配置资料可见范围；
6. 配置发言策略；
7. 配置审批策略；
8. 支持召回、暂停、延期；
9. 分身退出或会议结束后生成报告。

页面：

1. 会议侧边栏「派分身」；
2. 委托详情；
3. 参与者详情；
4. 分身报告；
5. 我的委托列表。

验收：

1. Avatar 不能进入员工目录；
2. Avatar 显示“某某的分身”；
3. 未授权资料不可读取；
4. 未授权审批不能提交；
5. 会议结束后每个分身有独立报告；
6. 主人能看到分身结论、风险、待确认事项和完整依据。

### E5：Workflow 与 Phase X 收敛

目标：把现有 Task Worker 执行能力迁移到 Digital Employee 模型。

范围：

1. 工作流执行者支持 `employee:<employeeId>`；
2. 旧 `agent:<profileId>` 保留兼容解析；
3. Agent Profile 迁移或映射为 Digital Employee Runtime Profile；
4. Agent Run 增加 `employeeId` 和 `principalType`；
5. 节点执行者、责任人、审批人使用员工目录；
6. Digital Employee 输出仍必须通过交付物门禁；
7. 审批节点支持 Human Employee 和 Digital Employee；
8. Human Avatar 默认只能建议，不能最终审批。

兼容策略：

```text
旧定义
executor: agent:backend-agent

兼容解析
backend-agent -> transitional Agent Profile -> runtime profile

新定义
executor: employee:backend-engineer-01
```

验收：

1. 旧模板仍可导入；
2. 新模板能选择正式 Digital Employee；
3. 运行记录显示员工身份；
4. 失败、重试、取消、超时和人工兜底不回退；
5. 必交交付物门禁不能被绕过。

### E6：治理、审计与报告中心

目标：让管理员和企业用户可以持续监督数字员工。

范围：

1. 员工活动时间线；
2. 委托活动时间线；
3. 权限矩阵；
4. 工具调用审计；
5. 预算和并发；
6. 风险动作审批；
7. Avatar 报告中心；
8. 异常和失败中心。

验收：

1. 管理员能按员工、委托、工作区、时间过滤；
2. 每个操作能定位权限来源；
3. Avatar 报告可搜索；
4. 超预算、越权和失败有显性告警。

### E7：Workstation 集成

目标：把员工体系接入中间主操作区。

范围：

1. 工作台面板组合；
2. 员工详情面板；
3. 委托详情面板；
4. 工作流节点面板；
5. 审批面板；
6. Avatar 报告面板；
7. 管理员权限面板。

原则：

1. Workstation 只组合已有服务能力；
2. 不在工作台里隐式创建员工；
3. 不在工作台里绕过服务端权限；
4. 面板显示必须可追溯到员工和委托。

当前实现边界：

1. 主操作区新增「工作台」；员工详情、委托详情、工作流节点、审批、Avatar 报告和管理员权限面板已接入；
2. 面板操作仍调用各域服务端 API，权限校验不放在浏览器；
3. by-role 面板组合只保留 `version/status/baseModules/roleProfiles` 预留 schema，并在页面明确标记未启用；
4. 角色定制编排、自定义模块注册、拖拽布局和持久化配置延后到独立迭代。

验收：

1. 普通成员能看到自己可读的员工、委托、工作流、审批和报告面板；
2. 管理员面板只对全局管理员展示数据；
3. 委托、节点派发/完成和人工审批仍走原服务端校验；
4. 预留面板组合不可编辑，也不会伪装成已生效配置。

## 7. 依赖顺序

```text
E0 当前 Phase X 收尾
   |
E1 Employee Identity Foundation
   |
E2 Digital Employee 生命周期
   |
   +----------------+
   |                |
E3 Action Ticket   E4 Human Avatar / Delegation
   |                |
   +-------+--------+
           |
E5 Workflow / Phase X 收敛
           |
E6 治理、审计与报告中心
           |
E7 Workstation 集成
```

E3 与 E4 可以小范围并行，但必须共享同一套 Delegation 与 Ticket schema。

## 8. 不做事项

首版不做：

1. Digital Employee 自动登录；
2. Digital Employee 自动获得创建者全部权限；
3. Human Avatar 自动成为工作区成员；
4. 无规则自动审批；
5. 所有 Persona 自动升级成 Digital Employee；
6. 一次性迁移全部历史会议分身；
7. 多 Agent 自主协商排程。

## 9. 成功指标

1. 用户看到任意参与者或执行者时，能在 3 秒内回答“这是谁、代表谁、能做什么”。
2. 管理员能在一个页面看到员工、权限、运行和异常。
3. 任意敏感操作都能追溯到 Employee ID、权限来源、Ticket、Run 和最终责任人。
4. Human Avatar 不再被误解成独立员工。
5. Digital Employee 可以进入工作流、会议和任务，而不需要为每个场景复制一套 Agent 概念。

## 10. 当前实现状态

E0-E4 已交付第一版闭环：

1. 每个登录账号自动映射为 Human Employee，并获得稳定 Employee ID。
2. Digital Employee 支持创建、资料编辑、Persona 软依赖、工作区授权、Runtime Profile、启用、暂停和归档。
3. Runtime 授权使用角色、工具 allow/deny、资源范围和上下文绑定 Ticket 计算；显式 deny 优先。
4. Human Avatar 使用结构化 Delegation，不进入员工目录；支持暂停、延期、召回、过期和报告。
5. 会议派遣分身会自动创建受限 Delegation，离会或会议关闭会生成分身报告。

E5 / E6 已交付第一版收敛：

1. Workflow 任务节点支持 `employee:<employeeId>`；旧 `agent:<profileId>` 继续兼容。
2. Digital Employee 派发前校验显式授权、Runtime Profile 和 Task Worker Profile 映射。
3. 派发和输出结算使用 workflow context Action Ticket；运行记录保留 Employee Principal。
4. 治理中心提供活动、权限来源、预算、风险、异常和分身报告过滤视图。

仍待收敛的部分是 Digital Employee 审批：语法和引用校验已存在，但最终审批必须等待专用 runtime decision path；当前不会让浏览器用户代签。
