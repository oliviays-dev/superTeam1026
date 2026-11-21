# dsh-pluginmax 增量升级架构评估与迁移方案

> 文档类型：架构评估、目标设计与迁移方案
> 文档状态：已评审，M9 已实施
> 日期：2026-11-21
> 目标项目：`pluginmax-platform`
> 项目基线：`main` / `codex/m0-m8-migration`，`8db80a2`，Migration 44
> 外部事实来源：`/Users/oliviayang/Codex/一切皆插件/dsh-pluginmax`
> 外部稳定基线：`4548bac8030f0e7b947644f540fcbcf48aa0c90d`
> 外部工作区：62 个已跟踪文件修改，新增 27,311 行、删除 8,999 行；
> 另有 81 个未跟踪文件，主要位于业务链路、项目概览、案例包和 Mock Provider 目录
> 工作区指纹：tracked diff `17dbbdd532b9fc54934799a5a1e2a328a61ede86c15b37220cd2d9c66920a1e7`；
> untracked files `8377fd5ff07672351756d0216a3ed134370f17057e50ae97b63dde164efa39ba`
> 上一轮迁移基线：`1acb51dec2d283e7918ebb6ea1f924c22cd21adc`

---

## 0. 结论

### 0.1 一句话判断

上一轮 M0-M8 的总体方向仍然成立：复用 PostgreSQL、Fastify、React、
Run/Job/Outbox、Principal/Grant、Workflow/Task 和 Execution Gate，不复制 DSH
Slot、JSON Storage 与宿主运行时。

但上一轮对 Router 和项目运营能力的“实现完整性”判断偏乐观。当前平台已经能
保存、审核、物化动态计划，却没有一个可追溯的 AI 规划运行态；已经能把工作流
用于执行，却还没有把“业务链路”作为项目运营语义接入；已经能管理动态任务，
却还没有正式的一层主任务/子任务关系。

因此本轮不应继续增加新的平行系统，而应做五项收敛：

1. **把 Router 从“一个计划来源标签”升级为受治理的 Planning Runtime。**
2. **把业务链路继续承载在 Workflow Definition 中，项目域只保存绑定快照与读模型。**
3. **把主任务/子任务作为 Task 的一层正式关系，不新建任务树引擎。**
4. **把平台级 Teammate Template 从项目局部资产修正为真正的跨项目资产。**
5. **把 Resource Market 的发布、可用性和安装状态拆开，避免“下架、卸载、停用”混用。**

### 0.2 当前是否存在立即生产阻断

在以下开关保持关闭时，没有发现新的代码级生产 P0：

```text
workflow.router_worker=off
skills.platform=off
task.capture=off
context.group_policy=off
project.ai_pm=off
data_fabric=off
workbench.v2=off
market=off
```

但如果准备开启 Router、项目业务链路或资源市场，以下问题会成为发布阻断：

| 编号 | 级别 | 问题 | 触发条件 |
| --- | --- | --- | --- |
| GAP-PLN-01 | P1 | `source=router` 的计划没有可验证的 Planning Run 来源 | 开启 `workflow.router_worker` |
| GAP-PLN-02 | P1 | 缺少触发幂等、规划状态机、Critic、质量门和人工审核闭环 | 开启自动规划 |
| GAP-PLN-03 | P1 | 任务派发没有统一接入“计划确认后才能执行”的 readiness gate | Agent 负责人任务执行 |
| GAP-PRJ-01 | P1 | 项目业务链路没有正式绑定、来源新鲜度和稳定 Alert | 开启项目概览 |
| GAP-TSK-01 | P2 | 只有 `task_origins` 历史血缘，没有产品级主任务/子任务关系 | 使用一层任务树 |
| GAP-TPL-01 | P1 | `scope=platform` 的 Teammate Template 仍绑定单一项目，不能真正跨项目复用 | Router/Skill 复用平台模板 |
| GAP-MKT-01 | P1 | 市场可见性、发布状态、安装状态和运行可用性仍有混用 | 开放用户共享资源 |
| GAP-MCP-01 | P2 | Market 中的 MCP 仍主要是元数据，缺少 Provider 连接与凭证边界 | 业务链路读取真实 MCP |
| GAP-UI-01 | P2 | 项目概览仍有客户端聚合倾向，未形成稳定服务端 Read Model | 多来源、多端复用 |

### 0.3 推荐迁移顺序

```text
M9  基线与兼容底座
    - 外部事实冻结
    - Task 一层层级关系
    - 平台 Teammate Template 作用域修正
       │
       ├──────────────┐
       ▼              ▼
M10 Planning Runtime  M11 项目业务链路与概览
    - Planning Run          - Definition kind
    - Trigger Receipt       - Project Binding
    - Brief / Facts         - Source Snapshot
    - Critic / Quality      - Stable Alert
    - Dispatch Readiness    - Server Read Model
       │              │
       └──────┬───────┘
              ▼
M12 资源市场治理与资源绑定
    - Origin / Sharing / Publication
    - Delist / Relist / Suspend
    - Skill/MCP/Template binding
              │
              ▼
M13 产品面与连接器收敛
    - MCP Provider
    - Project Artifact
    - Workbench push / incremental Brief
```

M10 和 M11 可以在契约冻结后并行设计，但 Migration 必须串行落地。M12 不应早于
M9 的模板作用域修正，否则“谁拥有平台资源”和“资源属于哪个项目”仍会混淆。

---

## 1. 审计边界与事实基线

### 1.1 外部稳定增量

上一轮技术方案的外部基线是 `1acb51d`。此后稳定提交如下：

| 提交 | 日期 | 事实内容 | 与本项目的关系 |
| --- | --- | --- | --- |
| `2fa27dd` | 2026-11-13 | Router Worker、模板责任绑定、权限 Scope | M2/M3 已有部分迁移 |
| `15c892b` | 2026-11-17 | Router Planning、资源 Skill、市场下架、任务详情 | M3/M4/M8 需要补强 |
| `4d88f8b` | 2026-11-17 | 构建顺序调整 | 工具链事项，不迁移 |
| `4548bac` | 2026-11-17 | Smoke 对齐项目角色初始化 | 测试事项，不迁移 |

稳定提交中真正影响架构的是：

- `dsh-collab-router-worker/src/planning/` 下的 Planning Run、Requirement Brief、
  Facts Ledger、Plan Critic、Quality Gate、Trigger Policy、Receipt Store、
  Context Builder 和 Skill Context。
- `dsh-collab-teammate/src/skill-resolution.ts` 的场景化 Skill 解析。
- Resource Market 的下架、重新上架、运行停用和权限边界。
- Task readiness gate 与任务详情中的执行前检查。

### 1.2 外部未提交增量

当前工作区继续增加了大量未冻结实现：

- 项目业务链路、项目类型/模版策略、来源绑定、项目概览 Read Model。
- 稳定 Alert 投影、来源新鲜度和外部变更事件。
- Task 一层主任务/子任务关系。
- Teammate Template 与实例归属边界修正。
- 市场资源来源、共享范围、发布状态和运行可用性拆分。
- Mock MCP Provider、AI Server 订单决策案例和项目进度场景包。
- 客户化工作台、项目产出物和更多 Meeting/Project 交互。

这些内容不能直接视为稳定契约。尤其要注意：

1. 未提交代码中的 `MockScenarioSourceRegistry` 会直接读取 Markdown Snapshot，
   这适合 Demo，不应成为生产 Adapter 架构。
2. 业务链路的“工作流定义 + 项目绑定 + 外部事实”方向合理，但其字段和 API
   仍在快速变化。
3. 任务树只支持一层，不能按多层树设计数据库与交互。
4. 市场下架权限不能只依赖 `ownerId` 字符串或前端 `canDelist`。

### 1.3 本文采用的目标边界

本文只基于源码、Migration、Contracts、测试与文档进行静态审计；不读取正式
数据库、生产 Session、Profile 或真实业务数据。

本文不直接修改外部仓库，也不把外部未提交文件复制到当前项目。

---

## 2. 对现有 M0-M8 方案的客观评估

### 2.1 适配度结论

| 阶段 | 当前适配度 | 结论 |
| --- | --- | --- |
| M0 事实封存 | 高 | 方法论正确，本轮必须再做一次新基线封存 |
| M1a 执行判定与验收证据 | 高 | 仍应作为所有计划物化和任务完成的前置事实 |
| M1b Agent Task Tools | 高 | 继续复用现有 Tool Facade、沙箱和单次 Gate |
| M2 模板作用域与责任绑定 | 中高 | 方向正确，但平台 Teammate Template 尚未真正跨项目 |
| M3 Router 动态计划 | 中低 | 有 Plan、Version、物化和 Reconciler，缺少规划运行态与来源证明 |
| M4 Skill 平台 | 中 | 安装、版本和 Run Snapshot 完整，绑定模式与场景解析仍不足 |
| M5 协作上下文 | 高 | Group Scene、Context Policy、Meeting 多 AI 已基本对齐 |
| M6 项目运营 | 中高 | Project AI PM 与报告可用，业务链路和来源事实尚未接入 |
| M7 Data Fabric | 中 | 独立只读查询域合理，但与 MCP Provider、项目概览仍分离 |
| M8 Workbench/Market | 中 | Workbench 版本化合理，Market 治理状态仍有语义混用 |

### 2.2 应保留的正确决定

1. 不把外部 `abnormal` 直接加入 TaskStatus。
2. 不复制 DSH JSON Storage 与 Slot。
3. 不建立第二套 Router DAG 事实源。
4. 不让 Skill 或 Market Entitlement 扩大项目、数据、Runtime 或 Tool 授权。
5. 不让前端或模型提交可信 `projectId`、`runId`、`agentPrincipalId`。
6. 所有高风险动作继续走 Action Ticket / Execution Gate。
7. 所有版本化事实继续采用不可变表或不可变快照。
8. 继续使用 feature flag 与 additive migration，不使用破坏性 down migration。

### 2.3 需要修正的判断

#### 修正一：M3 完成的是“计划承载”，不是“Router 规划”

当前平台提供：

- `WorkflowPlan`、Plan Version、Diff。
- Router Agent 注册与 protected template 校验。
- `source=router` 计划。
- 人工 Approve、Materialize、Reconcile。
- Task 物化、Outbox、Gate fencing 和稳定幂等键。

但这些代码并不证明计划由 AI 在受控、可审计的规划过程中生成。实际 API 允许
有项目写权限的调用方直接提交任意 DAG，并把 `source` 标为 `router`。

当前 `ROUTER_SUBMIT_PLAN_TOOL` 与 `ROUTER_SUBMIT_FINAL_DRAFT_TOOL` 主要作为
Contract 常量存在，没有形成“模型调用 Tool 提交计划、服务端验证并绑定 Run”
的完整链路。

**结论：** Plan 物化链路可以保留；必须新增 Planning Runtime，而不是继续给
`WorkflowPlanApplicationService` 堆叠 AI 协调逻辑。

#### 修正二：M2 的“平台模板”实际仍是项目模板

当前 `teammate_templates` 表中 `project_id` 与 `workspace_id` 均为
`NOT NULL`。即使 `scope=platform`，模板仍属于单一项目；查询和管理权限也先走
该项目授权。

这与外部新模型冲突：

- 平台模版应由平台管理员维护，可被多个项目引用。
- 个人模版属于创建人，不应属于某个项目的公共资产。
- 实例才属于项目、Owner 和执行绑定。

**结论：** 保留 Template/Instance 拆分，但需要修正 Template 的归属语义。

#### 修正三：M4 的 Skill 解析缺少规划场景所需维度

当前 Skill Binding 已有 `required` 与 `enabled`，已能表达必需 Skill 和默认
Skill。但 Planning Runtime 还需要：

- `bindingMode`: `required | default | additive | primary`。
- `scenes`: 例如 `task-planning`、`task-execution`、`meeting`。
- `instructionsHash` 与版本化解析证据。
- 规划 Run 的 Effective Skill Snapshot。

这些能力应在 M4 Skill 域内扩展，不建立第二套 Planning Skill 目录。

#### 修正四：M6 的“项目报告”不等于“项目业务事实”

Project Report 适合作为阶段汇报事实，不应被用来承载订单、库存、计划或产能
实时事实。项目概览需要独立的来源 Snapshot、新鲜度和 Alert 投影。

#### 修正五：M8 的 Market 状态还没有完成治理拆分

当前 `market_assets.status` 能表达 `active | delisted | archived`，但还没有
完整区分：

- 资源来源：平台或用户。
- 共享范围：私有、项目、工作区或平台。
- 发布状态：草稿、已发布、已下架、归档。
- 运行可用性：正常或安全停用。
- 用户安装状态：已安装或已卸载。
- 管理员锁定：所有者是否可自行重新上架。

只要 Market 仍默认关闭，这不是当前生产漏洞；一旦开放用户共享资源，就会成为
权限和运营语义问题。

---

## 3. 外部新增能力的迁移判定

状态说明：

- `ADOPT`：业务语义和契约应迁移。
- `ADAPT`：能力应迁移，但实现模型必须按当前平台调整。
- `DEFER`：有价值，但依赖更深或当前不是主路径。
- `NON_TARGET`：不迁移宿主实现、Demo 实现或产品形态。

| 外部新增能力 | 判定 | 目标落点 |
| --- | --- | --- |
| Planning Run 状态机 | ADOPT | 新增 Planning Runtime |
| Planning Trigger Receipt | ADOPT | 独立幂等收据表 |
| Requirement Brief / Facts Ledger | ADOPT | Planning 不可变 Artifact |
| Plan Critic / Quality Gate | ADOPT | 规划审核门禁 |
| Planning Skill Snapshot | ADAPT | 扩展现有 Skill Domain 与 Run Snapshot |
| Planning Knowledge Receipt | ADOPT | 规划知识来源证据 |
| Task Dispatch Readiness | ADOPT | Application 层统一派发前置门 |
| 业务链路 Definition | ADAPT | Workflow Definition `kind=business-chain` |
| 项目类型/模版业务链路策略 | ADAPT | Project Template Policy |
| 项目业务链路绑定 | ADOPT | Project 域快照表 |
| 外部来源 Snapshot | ADAPT | Server-side Source Adapter + Snapshot |
| 项目概览 Read Model | ADOPT | API 服务端聚合，不持久化为事实 |
| Alert 稳定投影 | ADOPT | 当前状态表 + 不可变事件表 |
| 一层主任务/子任务 | ADAPT | `tasks.parent_task_id` |
| Template/Instance 归属修正 | ADAPT | 修正 Teammate Template Scope |
| 市场资源来源与共享范围 | ADOPT | Market 治理模型 |
| 市场下架/重新上架/停用 | ADOPT | 发布生命周期与可用性分离 |
| MCP Provider / Mock Provider | DEFER | 先做真实 Provider 端口和测试 Fixture |
| 业务链路 JSON 上传转 Markdown | ADAPT | 导入器可做，但服务端负责校验和快照 |
| 项目产出物 | DEFER | 复用 Run Artifact，增加项目级引用 |
| Workbench Brief 推送 | DEFER | 现有 Brief 增量推送能力增强 |
| DSH Slot / Client Module | NON_TARGET | React 自有路由 |
| DSH JSON Storage | NON_TARGET | PostgreSQL |
| 浏览器直接读 MCP / Markdown | NON_TARGET | 必须服务端 Adapter |
| 任意远程 JS 面板 | NON_TARGET | 静态受信面板注册表 |
| Demo 数据与案例包 | NON_TARGET | 只作为测试 Fixture |

---

## 4. 目标架构

### 4.1 分层落点

```text
apps/web
  ProjectOverviewView / BusinessChainSettingsView / PlanningReviewView
  MarketGovernanceView
        |
apps/api
  PlanningRuntimeApplication / ProjectOperationsApplication
  MarketGovernanceApplication
        |
packages/application
  业务用例、授权、幂等、事务、Readiness Gate、事件发布
        |
packages/domain
  Workflow Graph、Planning State、Quality Gate、Task Transition
        |
packages/database
  PostgreSQL Repository、不可变 Artifact、Outbox、审计
        |
apps/worker
  Planner Run / Critic / Reconciler / Source Refresh / Alert Projection
        |
packages/agent-runtime
  Runtime Adapter、Tool Contract、Sandbox、Context Consumption
```

### 4.2 新增应用服务

| 服务 | 职责 | 明确不负责 |
| --- | --- | --- |
| `PlanningRuntimeApplication` | Trigger、Run 状态、Brief/Facts/Critic、质量门、人工审核 | 不直接物化 Task |
| `PlanningContextService` | 构造规划 ContextPack、Skill 与知识证据 | 不替代 Scene Context |
| `TaskDispatchReadinessService` | 判断任务能否派发、返回结构化 blocked reason | 不缓存长期授权 |
| `ProjectBusinessChainApplication` | 模版候选、项目绑定、快照、校验 | 不复制工作流运行时 |
| `ProjectSourceApplication` | 读取外部来源、新鲜度、快照与权限 | 不改变工作流状态 |
| `ProjectOverviewApplication` | 合并业务链路与来源事实为 Read Model | 不把 Read Model 当事实源 |
| `ProjectAlertApplication` | 稳定条件键、生命周期、关注与指派 | 不从页面状态推导事实 |
| `MarketGovernanceApplication` | 来源、共享、发布、下架、停用、审计 | 不授予业务授权 |

### 4.3 事实源边界

| 业务事实 | 唯一事实源 |
| --- | --- |
| 身份与授权 | Principal、RoleGrant、ProjectMember、ProjectRole |
| 执行策略 | TaskExecutionPolicy revision |
| 高风险动作 | Action Ticket、Execution Gate |
| 工作流定义 | Workflow Definition version |
| 工作流实例 | Workflow Instance revision |
| 规划状态 | Planning Run revision |
| 规划产物 | 不可变 Planning Artifact version |
| 已批准执行计划 | Workflow Plan Version |
| 子任务 | Task |
| 执行 | Run / Job / Runtime Effect |
| 项目业务链路 | Project Business Chain Binding revision |
| 外部业务事实 | Project Source Snapshot revision |
| 项目 Alert | Project Alert current row + immutable event history |
| Skill | Skill Definition Version + Run Skill Snapshot |
| 市场发布 | Market Asset Version + Publication Event |

任何前端状态、Prompt 文本、模型输出、JSON 展示对象或缓存都不能成为上述事实
的第二来源。

---

## 5. Planning Runtime 设计

### 5.1 为什么不能把 Planning 塞进 Workflow Plan

`Workflow Plan` 是“可执行图”的版本化事实；Planning Run 是“AI 如何理解问题、
提出计划、被 Critic 检查并等待审核”的过程事实。两者生命周期不同：

- Planning Run 可以失败、取消、澄清或重试。
- 一个 Planning Run 可以产生一个或多个 Plan Version。
- Plan 被人工编辑后，新的 Plan Version 不一定由同一次 Planning Run 生成。
- Plan Critic 失败不代表 Plan 结构非法；Plan 合法也不代表业务质量足够。

因此采用：

```text
Task
  -> Planning Run
      -> Requirement Brief
      -> Facts Ledger
      -> Plan Draft
      -> Critic Report
      -> Quality Gate
  -> Workflow Plan
      -> Immutable Plan Version
      -> Human / Risk-based Approval
  -> Workflow Instance
      -> Task Materialization
      -> Run / Job
```

### 5.2 Planning 状态机

```text
queued
  -> preparing
  -> understanding
      -> clarifying
      -> drafting
  -> critiquing
  -> validating
      -> review_required
      -> succeeded
      -> failed
      -> cancelled
```

规则：

- `clarifying` 只能由结构化问题或缺失输入进入，不能把普通失败当澄清。
- `review_required` 可以进入人工编辑、重新规划或取消。
- `succeeded` 必须绑定一个已生成的 Plan Version。
- `failed`、`cancelled`、`succeeded` 为终态；恢复执行必须新建 Planning Run。
- 同一 Root Task 同时只允许一个活动 Planning Run。
- 新 Trigger 到达活动 Run 时合并为 receipt，不能启动第二条并行规划。

### 5.3 触发与幂等

支持的 Trigger：

| Trigger | 默认行为 |
| --- | --- |
| `human-manual` | 人工发起；默认必须人工审核 |
| `agent-assigned` | Agent 成为根任务负责人时自动规划 |
| `task-spec-changed` | 描述、验收、优先级或截止时间变化时重规划 |
| `agent-requested` | Agent 在执行前请求补充规划 |
| `replan-requested` | 人工要求重规划 |

Trigger Receipt 的唯一键使用服务端稳定字段：

```text
workspaceId
rootTaskId
taskRevision
triggerIdentity
eventKey / taskDefinitionDigest
```

不得使用前端请求 ID、时间戳、随机 UUID 或客户端重试次数作为幂等键。

规则：

- 同一事件重复到达只消费一次。
- 活动 Run 存在时合并到当前 Run。
- 较旧 Receipt 在 Run 结束后丢弃并留审计。
- Planner 自己写入 Task 产生的变化不能再次触发自身规划。

### 5.4 规划上下文与 Skill

Planning Context 必须从以下事实构建：

- Root Task 当前 revision。
- 项目成员、角色和 Agent 候选。
- 相关 Meeting、Workflow、Document 和 Memory Source。
- 有效 Skill Snapshot。
- Knowledge Provider 的结构化贡献。
- 平台安全规则与场景策略。

Skill 解析建议扩展现有绑定，而不是新增 Planning Skill 表：

```text
SkillBindingMode =
  required | default | additive | primary

SkillBindingScene =
  task-planning | task-execution | meeting | project-report
```

每个 Planning Run 固化：

- Skill Version、digest、instructionsHash。
- 来源层：平台或用户。
- 入选或排除原因。
- ContextPack 与 Context Receipt。
- Knowledge Provider、贡献版本与排除项。

Skill 仍然固定 `grantsAuthorization=false`。

### 5.5 质量门

质量门至少检查：

1. 图结构与依赖合法。
2. 每个 Root Acceptance 至少被一个节点覆盖。
3. 每个节点有可检查的证据要求。
4. 高风险或不可逆节点有人工 Gate。
5. Critic verdict 为 `pass`。
6. 质量分达到策略阈值。
7. 人工发起或策略要求时强制人工审核。
8. Validator 错误为零。

建议不把阈值写死在代码：

```text
planning.quality.minScore
planning.quality.autoApprove
planning.review.highRisk
planning.maxNodes
planning.maxDepth
```

默认仍保持人工审核。分阶段开启：

1. 人工发起、人工审核。
2. 人工发起、风险分层审核。
3. Agent 自动触发、人工审核。
4. 仅低风险、完整证据计划允许自动批准。

### 5.6 派发 readiness

新增统一决策：

```ts
type TaskDispatchReadiness =
  | { ready: true }
  | {
      ready: false;
      code:
        | "planning-required"
        | "planning-running"
        | "planning-review-required"
        | "planning-blocked";
      message: string;
      retryToken?: string;
    };
```

接入点：

- Task Execution Preflight。
- Task Queue 派发。
- 依赖满足后的自动派发。
- Workflow Node 派发。
- Agent Task Tool 的提交交付物前置检查。

规则：

- 只对 Agent 负责的根任务启用“先规划”。
- Router 物化出的子任务不再次触发规划。
- 人工负责人默认不强制计划。
- readiness 不缓存；派发前使用数据库权威事实重新检查。
- Planning Gate 关闭时必须先回到一致状态，不能把中断中的 Run 当作已批准计划。

### 5.7 与现有 Workflow Plan 的集成

在 `workflow_plans` 增加：

```text
planning_run_id UUID UNIQUE
```

约束：

- `source=router` 的 Plan 必须有 `planning_run_id`。
- 人工 Plan 和模板 Plan 可以为空。
- Planning Run 终态与 Plan Version 的生成必须在同一事务或可靠 Outbox 中收敛。
- Plan 被人工编辑后记录来源：`router-generated | human-edited`。
- Planning Run 快照、Plan Version 和审核记录不能相互覆盖。

### 5.8 目标数据模型

建议 Migration 46 新增：

| 表 | 职责 |
| --- | --- |
| `planning_policies` | 项目/平台规划设置与策略 revision |
| `planning_runs` | 活动状态、Root Task、Trigger、Planner、Plan 绑定 |
| `planning_trigger_receipts` | Trigger 幂等、合并、消费与丢弃 |
| `planning_artifacts` | Brief、Facts、Critic、Skill、Knowledge 等不可变产物 |
| `planning_events` | Append-only 状态与审计事件 |
| `planning_quality_metrics` | 审核结果、覆盖率和质量指标 |

`planning_artifacts` 建议使用：

```text
run_id
kind
version
content_digest
payload JSONB
created_at
UNIQUE(run_id, kind, version)
```

原因：

- Brief、Facts、Critic、Knowledge 都具有“按 Run 版本化且不可变”的共同生命周期。
- 每类 payload 由独立 Zod Contract 校验，不会因为共用表而失去类型安全。
- 避免为每个短期产物建立一张结构高度相似的表。

---

## 6. 项目业务链路与项目概览

### 6.1 总体判断

外部方案“项目类型/模版治理 + 业务链路工作流 + 外部事实 + 项目读模型”的方向
合理，应采纳。

不应：

- 新建第二套 `ProjectTrunk` 执行引擎。
- 把订单、库存、产能等业务数字写进 Workflow Definition。
- 把任意工作流自动视为业务链路。
- 让浏览器直接调用 MCP。
- 把项目概览 Read Model 保存成新的事实源。

### 6.2 业务链路定义

业务链路继续由 `WorkflowDefinition` 承载，但增加明确语义：

```text
kind = workflow | business-chain
origin = template | router | manual
scope = project | platform
```

Definition 级元数据：

```ts
type BusinessChainDefinition = {
  chainKey: string;
  templateKey: string;
  displayName: string;
  projectTypeCodes: string[];
  snapshotPolicy: "pin-at-project-create" | "latest-active";
  allowUnboundSources: boolean;
};
```

节点级元数据：

```ts
type BusinessChainNode = {
  sequence: number;
  stageCode: string;
  summaryMetric?: string;
  fields: Array<{
    key: string;
    label: string;
    bindings: Array<{
      system: string;
      objectType: string;
      objectId: string;
      path: string;
      required: boolean;
    }>;
  }>;
};
```

约束：

- `kind=business-chain` 的定义必须有 `chainKey`。
- `stageCode` 在一个定义内唯一。
- `sequence` 必须唯一，但拓扑仍由 Graph Edge 决定。
- required 字段必须绑定合法来源。
- 普通执行工作流不能进入业务链路候选列表。

### 6.3 项目模版策略

暂不新增完整的 Project Type 实体。第一阶段复用
`project_templates.type` 字符串，避免为了场景分类引入不必要的治理层。

Project Template 增加：

```ts
type ProjectTemplateBusinessChainPolicy = {
  mode: "required" | "optional" | "none";
  defaultBusinessChainKey?: string;
  allowedBusinessChainKeys: string[];
  versionPolicy: "pin-at-project-create" | "latest-active";
};
```

建议新增：

```text
project_template_business_chain_refs
  template_id
  workflow_definition_key
  workflow_definition_version
  required
```

模版只保存对业务链路定义的引用，不复制 Graph。

### 6.4 项目绑定快照

每个项目最多一个当前业务链路：

```text
project_business_chain_bindings
  project_id PRIMARY KEY
  project_template_id
  source_template_revision
  workflow_definition_id
  workflow_definition_version
  chain_key
  binding_mode
  node_bindings JSONB
  binding_digest
  revision
  bound_by_principal_id
  bound_at
```

不可变历史：

```text
project_business_chain_binding_revisions
```

规则：

- 项目创建时按模版策略固定版本。
- 后续模版更新不静默覆盖项目。
- 项目负责人显式应用更新时写新 revision。
- 运行中的 Workflow Instance 继续使用启动时 definition snapshot。
- 更换绑定不迁移运行中实例，只影响后续实例和项目概览。

### 6.5 外部来源 Adapter

新增服务端端口：

```ts
interface ProjectSourceAdapter {
  inspect(input: {
    projectId: string;
    refs: BusinessChainSourceRef[];
    signal?: AbortSignal;
  }): Promise<ProjectSourceResult[]>;
}
```

要求：

- Adapter 只读。
- 不向浏览器暴露凭据或 MCP 内部对象。
- 每次读取同时校验项目 read 权限和来源策略。
- 支持超时、取消、Schema 校验和来源归属校验。
- 真实 MCP 连接由 Provider 提供，Markdown Snapshot 只作为测试 Fixture。
- Mock 数据必须显式标记 `isMock=true`，默认禁止在生产 Flag 下使用。

数据落点建议：

```text
project_source_snapshots
  project_id
  source_system
  source_object_type
  source_object_id
  source_revision
  observed_at
  effective_at
  status
  payload_digest
  payload
  is_mock
  expires_at
```

唯一键不使用权 `latest` 覆盖，而是按来源 revision 保存；读取时选择符合策略的
最新已确认版本。

### 6.6 Alert 投影

Alert 不能每次由页面临时拼接 ID。使用稳定条件键：

```text
projectId + sourceSystem + sourceObjectId + conditionKey
```

当前表：

```text
project_alerts
  id
  project_id
  condition_key
  severity
  lifecycle
  source_revision
  first_seen_at
  last_seen_at
  resolved_at
  assignee_principal_id
  linked_node_ids
  linked_task_ids
  follow_target_id
  revision
  UNIQUE(project_id, condition_key)
```

历史：

```text
project_alert_events
```

规则：

- 事实消失不等于已解决。
- 来源过期进入 `stale`，保留最后快照。
- Alert 指派、确认、解决和抑制写独立事件。
- Workbench 关注继续使用 `follow_target_id`，但目标必须稳定。
- 普通任务备注不能直接生成业务 Alert。

### 6.7 项目概览 Read Model

Read Model 由服务端生成：

```ts
type ProjectProgressOverview = {
  schemaVersion: "project-progress-overview-v1";
  generatedAt: string;
  projectId: string;
  businessChain: {
    chainKey: string;
    definitionId: string;
    definitionVersion: number;
    instanceId?: string;
    bindingMode: string;
  } | null;
  coverage: {
    status: "complete" | "partial" | "stale" | "error";
    sources: SourceCoverage[];
  };
  nodes: ProgressNode[];
  changeEvents: ChangeEvent[];
  alerts: ProjectAlert[];
};
```

原则：

- 浏览器只渲染，不直接读取外部来源。
- 多个来源必须分区展示，冲突进入证据区。
- 工作流状态决定执行状态，外部系统决定业务状态。
- 默认按请求聚合；只有实测性能不足时才增加短期缓存。
- 缓存必须带 `sourceCutoff`、`policyVersion` 和 `digest`，且可随时撤销。

### 6.8 目标数据模型

建议 Migration 47 新增或扩展：

```text
workflow_definitions
  + kind
  + chain_key
  + business_chain_metadata

project_template_business_chain_refs
project_business_chain_bindings
project_business_chain_binding_revisions
project_source_snapshots
project_alerts
project_alert_events
```

不需要新增：

```text
project_trunk_runtime
business_chain_tasks
business_chain_instance
project_overview_truth
```

---

## 7. Task 一层层级设计

### 7.1 保留两个不同概念

| 概念 | 表 | 含义 |
| --- | --- | --- |
| 产品层级 | `tasks.parent_task_id` | 用户看到的主任务/子任务关系，可显式关联和解除 |
| 来源血缘 | `task_origins` | 任务从 Plan、Workflow、Meeting 或 Capture 产生的不可变来源 |

不能用 `task_origins` 替代产品层级，也不能因为解除任务关联而修改来源血缘。

### 7.2 数据约束

建议 Migration 45 增加：

```text
tasks.parent_task_id UUID REFERENCES tasks(id)
```

索引：

```text
(project_id, parent_task_id, status)
```

规则：

- 子任务必须与主任务同项目。
- 任务不能关联自身。
- 子任务不能再次作为主任务，第一版严格一层。
- 已完成或已取消的任务不能新增子任务，但历史子任务保留。
- 归档任务不能被设为父任务。
- Router 物化任务同时写 `parent_task_id=rootTaskId` 和
  `task_origins.parent_task_id=rootTaskId`。
- 解绑只影响产品层级，不修改任务来源。

数据库建议增加 Trigger 校验跨项目与深度，因为只靠应用校验无法阻止批处理或未来
Repository 绕过。

---

## 8. Teammate Template 作用域修正

### 8.1 当前问题

平台模板仍有单一 `project_id`，导致：

- 平台模板不能跨项目复用。
- 平台模板的管理权限受来源项目影响。
- Router Agent 在项目 A 创建的 protected template 不能安全用于项目 B。
- `scope=platform` 的名义语义与数据事实不一致。

### 8.2 目标模型

Template：

- `scope=platform`: 平台资产，`project_id=NULL`，`owner_principal_id=NULL`。
- `scope=personal`: 个人资产，`project_id=NULL`，`owner_principal_id` 必填。
- Template 由管理员或 Owner 管理，不由某个项目成员身份决定。

Instance：

- 仍属于具体项目。
- 仍引用不可变 Template Version。
- 仍保存项目 Owner、Agent、AI Principal、Runtime 和 Skill Extension。

### 8.3 约束

```text
platform template name globally unique
personal template name unique per owner
instance pins template version
template archive does not mutate instance status
dispatch preflight rejects inactive template
```

### 8.4 兼容迁移

M9 迁移建议：

1. 保留旧 `project_id` 为 nullable。
2. 对现有平台模板先记录 `legacy_project_id`。
3. 增加 `platform template` 唯一性与管理权限。
4. 实例继续保留项目作用域。
5. 先只允许平台管理员读取跨项目模板，再按 Flag 开放项目引用。

现有 `source=router` protected template 需要单独处理：

- 由项目级 protected template 升级为平台 protected template，或
- 继续项目级，但标记为 `router-local`，不能宣称平台复用。

建议选前者，避免 Router 长期被单项目模板锁死。

---

## 9. Skill 绑定扩展

当前 Skill Domain 不需要重写。建议增加：

```text
teammate_template_skill_bindings
  + mode
  + scenes

teammate_instance_skill_extensions
  + mode
  + scenes

skill_versions
  + instructions_hash
```

解析优先级：

```text
required template skills
  -> default template skills
  -> primary planning skill
  -> additive instance skills
```

规则：

- required 不可被实例覆盖或禁用。
- primary 每个场景最多一个。
- scene 不匹配时不进入 Effective Skill。
- Run Skill Snapshot 保存解析后的结果，不保存解析规则猜测。
- Skill revoke 影响新 Run，不回写历史 Snapshot。
- Skill 仍不授予任何业务授权。

---

## 10. Resource Market 治理设计

### 10.1 语义拆分

建议把当前混在 `visibility` 和 `status` 中的语义拆为：

```text
origin = platform | user
sharingScope = private | project | workspace | platform
publicationStatus = draft | published | delisted | archived
availabilityStatus = active | suspended
installationStatus = active | uninstalled
```

其中：

- `delisted`：市场不可发现，禁止新安装；已安装资源默认继续可用。
- `suspended`：平台管理员安全停用，新安装和已有运行均阻断。
- `uninstalled`：当前用户卸载，不影响资源发布状态。
- `adminLocked`：管理员禁止 Owner 自行重新上架。

### 10.2 权限

| 操作 | 平台资源 | 用户私有 | 用户共享 |
| --- | --- | --- | --- |
| 查看已下架 | 管理员 | Owner | 管理员、Owner |
| 下架 | 管理员 | 不适用 | 管理员、Owner |
| 重新上架 | 管理员 | 不适用 | 未锁定时的管理员、Owner |
| 安全停用 | 管理员 | 不适用 | 管理员 |
| 删除记录 | 不允许 | Owner | 不允许 |

平台管理员不能因为治理身份读取用户私有资源内容，也不能借 Market 权限读取
业务数据。

### 10.3 资源绑定，而不是复制资源

Market 是目录与分发层，不应成为 Skill、MCP、Workflow Template 或 Workbench
Template 的第二事实源。

建议新增：

```text
market_asset_resource_bindings
  asset_id
  asset_version_id
  resource_kind
  resource_id
  resource_version_id
```

`resource_kind` 可包括：

```text
skill_version
mcp_provider
workflow_template_version
workbench_template_version
trusted_panel
```

绑定只回答“市场条目对应哪个平台资产”，不复制正文，不授予执行权限。

### 10.4 兼容迁移

建议 Migration 48：

1. 新增 `origin`、`sharing_scope`、`sharing_scope_id`、
   `publication_status`、`availability_status`、`admin_locked_*`。
2. 从现有 `trustLevel`、`visibility`、`publisherPrincipalId` 和 `status`
   回填。
3. 保留旧 `visibility` 与 `status` 一个发布周期，API 双读但只写新字段。
4. 增加 Owner 与管理员操作审计。
5. 增加 `market_asset_resource_bindings`，先只回填可确定的平台 Seed。
6. 默认关闭 `market.governance_v2`。

不得在第一批迁移中删除旧列或旧状态，避免 N-1 应用无法读取。

---

## 11. 架构决策记录

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| Planning 与 Plan 是否合并 | 不合并 | 过程事实与可执行图生命周期不同 |
| 业务链路是否新建执行引擎 | 不新建 | 执行语义已由 Workflow 完整承载 |
| 项目概览是否持久化 Truth | 不持久化 | 外部事实和快照才是 Truth |
| Alert 是否临时推导 | 不临时推导 | 关注、指派、解决需要稳定身份 |
| Task 树是否多层 | 第一版一层 | 外部实现与当前用例均为一层 |
| 平台 Template 是否属于项目 | 不属于 | 平台资产跨项目复用 |
| Market 是否直接存 Skill 正文 | 不存 | 避免双事实源 |
| MCP 是否允许浏览器直连 | 不允许 | 凭据、权限、审计必须服务端控制 |
| 是否远程加载 Market JS | 不允许 | 继续使用受信静态面板注册表 |

---

## 12. 迁移方案

### 12.1 总体策略

所有迁移继续遵循：

```text
expand
  -> backfill / validate
  -> enforce constraints
  -> enable feature
```

每个阶段必须满足：

- 默认关闭新行为。
- 空库从 0 升级成功。
- 从 Migration 44 的隔离快照升级成功。
- 旧应用在新 Schema 上可启动并完成核心读操作。
- 新应用在旧数据上不伪造历史事实。
- Flag 关闭后不继续产生副作用。
- 不使用破坏性 down migration。

### 12.2 M9：基线与兼容底座

目标：冻结事实，补齐后续阶段共同依赖，不开启产品行为。

范围：

- 固化外部 `4548bac` 与未提交工作区差异。
- 形成 `ADOPT / ADAPT / DEFER / NON_TARGET` 契约清单。
- Migration 45：
  - `tasks.parent_task_id`
  - Template Scope 兼容字段与索引
  - Skill Binding `mode/scenes/instructions_hash` 的可空扩展

交付物：

- 外部 diff 与未跟踪文件 checksum。
- 契约样例与错误码。
- 旧应用兼容报告。
- 冲突预检脚本。

退出门：

- 一层任务约束通过。
- 平台 Template 跨项目读取只读验证通过。
- 现有 M1-M8 核心测试无回归。

### 12.3 M10：Planning Runtime

目标：把 AI 规划变成可追溯、可审核、可恢复的正式运行态。

范围：

- Migration 46：
  - Planning policy、Run、Receipt、Artifact、Event、Quality Metric。
  - `workflow_plans.planning_run_id`。
- Planning Application 与 Worker。
- Trigger Policy 与 Receipt 幂等。
- Brief、Facts、Critic、Quality Gate。
- Skill 与 Knowledge Snapshot。
- Task Dispatch Readiness。
- Plan Audit 与质量指标。

开关：

```text
planning.manual=off
planning.autopilot=off
workflow.router_worker=off
```

退出门：

- 重复 Trigger 只创建或合并一次。
- Planner 不能自触发。
- 无有效 Planning Run 的 `source=router` 被拒绝。
- Critic 不通过不能自动批准。
- 计划未确认不能派发 Agent 根任务。
- Gate 关闭后无新 Task、Run 或外部副作用。
- 同一 Root Task 无并发活动 Planning Run。

### 12.4 M11：项目业务链路与概览

目标：正式承载业务链路绑定、外部来源、新鲜度、Alert 和项目概览。

范围：

- Migration 47：
  - Workflow Definition business-chain 元数据。
  - Project Template business-chain policy。
  - Project Binding 与 revision history。
  - Project Source Snapshot。
  - Project Alert 与事件。
- Project Business Chain Application。
- Source Adapter 端口与测试 Fixture。
- 项目概览服务端 Read Model。
- Mock Provider 仅用于测试和演示 Flag。

开关：

```text
project.business_chain=off
project.source.mock=off
```

退出门：

- 候选只来自当前项目模版允许范围。
- 非 owner/负责人不能修改绑定。
- 项目创建时固定定义版本。
- 模版更新不静默修改项目。
- 来源过期显示 stale，不伪装实时。
- 浏览器请求中不出现 MCP 凭据或原始连接。
- 同一 `conditionKey` 不重复生成 Alert。

### 12.5 M12：市场治理与资源绑定

目标：开放用户共享资源前完成发布生命周期、权限和资源绑定。

范围：

- Migration 48：
  - Market Origin、Sharing、Publication、Availability、Lock。
  - Market Resource Binding。
- 下架、重新上架、安全停用、恢复。
- Owner/Admin 权限与审计。
- 已安装资源兼容策略。
- Skill/MCP/Template/Panel 绑定。

开关：

```text
market.governance_v2=off
market.shared_supply=off
```

退出门：

- 下架与卸载、停用、删除不可混用。
- Owner 只能操作自己的共享资源。
- 管理员不能读取用户私有资源内容。
- 下架后不能新安装，已有安装按类型兼容。
- 安全停用阻断已有运行。
- Market entitlement 仍不产生任何业务授权。

### 12.6 M13：体验与连接器收敛

目标：在不改变核心事实源的前提下补齐产品面。

候选范围：

- MCP Provider 注册、健康检查、稳定 Tool 身份和服务端 Tool 调用端口。
- Project Artifact 与 Run Artifact 的来源关联。
- Workbench Brief 增量推送。
- 项目概览缓存与多端查询优化。
- 多场景业务链路测试包。

本阶段不预设 Migration，除非出现新的持久化事实。

---

## 13. Migration 与兼容细节

### 13.1 编号与顺序

| Migration | 阶段 | 内容 | 默认行为 |
| --- | --- | --- | --- |
| 45 | M9 | Task hierarchy、Template scope、Skill binding 扩展 | 结构生效，行为关闭 |
| 46 | M10 | Planning Runtime | 全部关闭 |
| 47 | M11 | Business Chain、Source、Alert | 全部关闭 |
| 48 | M12 | Market Governance、Resource Binding | 全部关闭 |
| 49 | M13a | MCP Provider 控制面、健康探测、Tool Schema | 全部关闭 |
| 50 | M13b | MCP Tool 调用授权、Receipt、Worker-only 调用端口 | 全部关闭 |
| 51 | M13c | Agent Runtime Tool Request 到 Worker Tool Call Port 桥接 | 全部关闭 |
| 52 | M13d | Production Secret Resolver、只读 MCP Project Source | 全部关闭 |
| 53 | M13e | Project Artifact Source、Workbench Brief 增量推送 | 兼容旧数据 |

不得在 M11/M12 中回头修改 45-46 的语义。发现冲突时新增 Migration。

### 13.2 冲突预检

至少检查：

- 同项目任务已存在多层父子关系。
- 平台 Template 同名冲突。
- Personal Template Owner 为空。
- 旧 Market 资产 visibility/status 组合无法映射。
- Workflow Definition `kind=business-chain` 的 stageCode 重复。
- Project Binding 指向不存在的 Definition Version。
- 同一 Project + Alert conditionKey 重复。

预检失败时迁移停止，不自动猜测修复。

### 13.3 N-1 应用兼容

新 Schema 发布时旧应用必须能：

- 读取 Project、Task、Run、Workflow、Meeting。
- 读取旧 Market Asset。
- 忽略新增 nullable 列。
- 不写入新 Planning、Business Chain、Governance 表。

新应用在旧数据上必须：

- 不伪造 Planning Run。
- 不伪造 Business Chain Binding。
- 不伪造 Alert。
- 不为历史 Run 回填 Skill Snapshot。

### 13.4 回滚

优先顺序：

1. 关闭新 Feature Flag。
2. 回退到支持新 Schema 的上一应用版本。
3. 若 Schema 本身阻断，恢复迁移前备份到隔离实例。

禁止：

- 手工删除新表。
- 删除不可变 Artifact。
- 通过修改历史 task origin 回滚任务树。
- 通过覆盖旧 Market 状态“撤销”发布事件。

---

## 14. 测试与发布门

### 14.1 测试层级

| 层级 | 重点 |
| --- | --- |
| Contract | Zod 边界、状态机、幂等键、拒绝伪造字段 |
| Domain | Graph、Quality Gate、Task 层级、Alert 条件键 |
| Database | Expand/backfill/enforce、唯一约束、不可变 Trigger |
| Application | 权限交集、CAS、事务边界、Readiness |
| API | 404/403/409、revision conflict、Flag off |
| Worker | Trigger 消费、Critic、Plan 生成、Source refresh、Alert projection |
| E2E | 人工规划、计划审核、物化、项目概览、下架与重新上架 |
| Migration | 0->45-48、44->45-48、N-1 读取、冲突预检 |

### 14.2 固定发布门

#### G1：Planning 来源可信

- 直接提交 `source=router` 但无 Planning Run，返回拒绝。
- 跨 Project、跨 Agent、跨 Run 的 Submission 被拒绝。
- 模型不能自报 Principal、Project、Run 或 Plan ID。

#### G2：规划幂等

- 同一 Trigger 重放不重复创建 Run。
- 活动 Run 存在时新 Trigger 合并。
- 并发 Trigger 只有一个消费。

#### G3：质量门

- required acceptance 未覆盖不能进入自动批准。
- Critic 错误不能自动批准。
- 高风险节点必须人工审核。
- Validator 失败不能物化。

#### G4：计划先行

- Agent 根任务未确认计划不能派发。
- Planning Run 等待输入或审核时返回明确 blocked reason。
- Router 子任务不被再次规划。

#### G5：业务链路快照

- 项目绑定固定 Definition Version。
- 模版更新不影响现有项目。
- 运行中实例不因项目重新绑定而变化。

#### G6：来源与 Alert

- 来源错误、过期、缺失有不同状态。
- 过期显示最后值但标记 stale。
- 同一 conditionKey 只保留一个当前 Alert。
- 撤权后历史快照和 Alert 不可读。

#### G7：市场治理

- Owner 不能下架他人资源。
- 管理员不能读取用户私有资源。
- 下架不卸载已有安装。
- 安全停用阻断已有运行。
- Market 操作不修改 RoleGrant、ProjectMember 或 Runtime。

#### G8：Migration

- 空库升级。
- `44 -> latest` 升级。
- 老应用读取。
- Flag 关闭无副作用。
- 失败后可恢复备份。

### 14.3 灰度顺序

```text
内部管理员
  -> 单个非生产项目
  -> 单个项目模版下的项目组
  -> 10% 项目
  -> 全量
```

每个阶段至少观察：

- Planning Run 创建、合并、失败和取消。
- Plan 审核率、自动批准率和人工退回原因。
- 派发 blocked 数量与等待时长。
- 项目来源错误、stale 和 Schema 失败。
- Alert 重复率、解决率和指派率。
- Market 下架、重新上架、停用和安装残留。
- PostgreSQL 锁等待、慢查询和 Outbox 积压。

---

## 15. 风险与缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 把未提交外部实现当稳定契约 | 返工与不兼容 | M9 先冻结差异与样例 |
| Planning 与 Plan 状态双写漂移 | 无法解释计划来源 | 单事务或可靠 Outbox，且以 Run/Version 互链 |
| 业务链路变成第二执行引擎 | 双事实源 | 只扩展 Workflow Definition，不建 Runtime |
| 外部来源拖慢项目概览 | 页面不可用 | Adapter 超时、并行读取、局部 stale |
| Alert 爆发 | 运营噪声 | 稳定条件键、去重、严重度和抑制期 |
| Task 层级被扩展成多层树 | 查询与权限复杂 | 第一版数据库和 API 强制一层 |
| Market 治理继续混用状态 | 误操作与权限争议 | 四组状态显式拆分 |
| MCP 凭据进入浏览器或日志 | 安全事件 | 服务端 Provider、脱敏、审计 |
| Template Scope 迁移破坏现有 Router | 现有项目不可用 | 双读、legacy_project_id、分阶段切换 |
| Planning Gate 关闭留下悬挂 Run | 状态不一致 | 安全停点、显式 resume、不可自动恢复 |

---

## 16. 不做事项

本轮明确不做：

1. 不复制 DSH Slot、Workspace Browser、JSON Storage 或插件装载机制。
2. 不把所有案例 Demo 数据迁入正式数据库。
3. 不把 Markdown Mock Provider 当生产 MCP。
4. 不允许第三方面板动态下载和执行 JavaScript。
5. 不把 Market Entitlement 当项目或数据授权。
6. 不为业务链路创建独立任务、状态和审批模型。
7. 不为 Planning 再造一套 Workflow Runtime。
8. 不提供多层任务树。
9. 不允许模型自行批准、恢复或物化计划。
10. 不通过删除历史数据实现回滚。

---

## 17. 推荐实施拆分

### 17.1 第一批

- M9 事实冻结。
- Task 一层层级。
- Teammate Template Scope 修正。
- Skill Binding 扩展契约。

### 17.2 第二批

- Planning Run 持久化与人工发起。
- Brief、Facts、Critic、Quality Gate。
- Plan 来源绑定与 Dispatch Readiness。

### 17.3 第三批

- 项目业务链路策略与绑定。
- Source Adapter 与 Snapshot。
- Alert 与项目概览 Read Model。

### 17.4 第四批

- Market 发布生命周期与权限。
- Resource Binding。
- MCP Provider 与示例场景接入。

### 17.5 第五批

- Project Artifact。
- Workbench Brief 增量推送。
- 完整案例 E2E 与运营手册。

---

## 18. 最终建议

建议批准的方向是“在现有平台上补运行态、读模型和治理边界”，而不是再迁移一套
外部实现。

优先级应从高到低保持：

```text
Planning 来源可信与计划先行
  > 项目业务链路快照与来源可解释
  > Market 发布治理
  > 任务层级与产品体验
  > MCP Provider 与案例扩展
```

最需要保持克制的三点：

1. 不要为每个外部功能新增一张表或一个运行时。
2. 不要让展示层 Read Model 变成业务事实。
3. 不要用 Flag、Entitlement、Skill 或前端状态替代授权与执行门禁。

如果只能先做一件事，应先完成 M9 事实冻结和 M10 Planning Runtime。因为 Router
和业务链路的后续价值都依赖“计划来源可信、计划可审核、执行前有明确 readiness”
这条主链路；缺少它，后面的项目概览和市场能力只会放大不可解释的状态。
