# dsh-pluginmax 升级能力迁移技术方案

> 文档类型：迁移技术方案
> 文档状态：方案稿 v1.1，已吸收测试评审意见
> 日期：2026-11-13
> 评审输入：`docs/v1-dsh-pluginmax-upgrade-migration-technical-plan-review.md`
> 目标项目：`pluginmax-platform`
> 外部事实来源：`/Users/oliviayang/Codex/一切皆插件/dsh-pluginmax`
> 外部提交基线：`1acb51dec2d283e7918ebb6ea1f924c22cd21adc`
> 外部工作区：另有 89 个已跟踪文件修改，新增行 15,927、删除行 2,977，并包含 30 个未跟踪文件
> 当前项目审计时点：`main@5b7f7f5`，工作区包含 `codex/v1-batch20a-identity-hardening` 相关未提交改动
> 约束：本次只新增本方案文档，不修改任何代码、Migration、配置或测试

---

## 0. 结论

### 0.1 这次迁移的本质

`dsh-pluginmax` 近期升级不是一次简单的插件版本升级，也不是把 DSH 插件目录逐项复制到当前平台。实际变化集中在以下六个方向：

1. **执行语义升级**：从“任务结束即可自动验收”升级为“证据驱动验收”，并引入执行异常。
2. **执行计划升级**：从固定工作流模板升级为“模板实例 + Router 动态 DAG”的统一执行计划。
3. **责任绑定升级**：模板只声明角色槽位，实例创建时解析为具体 Project Role、人和 AI Principal。
4. **能力资产升级**：Skill 从提示词附属物升级为可版本化、可安装、可绑定、可追溯的独立资源。
5. **上下文升级**：多人多 AI 场景按参会者隔离 Scene Session，并引入上下文边界、增量提交和平台级预算策略。
6. **产品面扩展**：任务捕获、项目 PM 汇报、Data Agent、Data Fabric、Resource Market 和可编排工作台。

这些能力不能按外部插件的包边界迁移。当前平台应继续坚持：

```text
PostgreSQL + Fastify + React + Worker
Principal / Grant / Project Role 为唯一授权事实
Run / Job / Outbox / Worker 为唯一执行链路
Action Ticket / Execution Gate 为高风险动作门禁
```

### 0.2 推荐迁移顺序

本方案将范围收敛为“本轮主干 + 后续路线”：

- **本轮主干**：M0 契约冻结、M1a 执行判定、M1b 受控工具、M2 模板责任绑定、M3 Router 动态计划。
- **后续路线**：M4-M8 只保留能力边界、依赖和决策门，需逐阶段重新立项或评审。

| 阶段 | 目标 | 核心范围 | 优先级 |
| --- | --- | --- | --- |
| M0 | 事实封存 | 固化外部提交、工作区差异、契约清单和验收基线 | P0 |
| M1a | 执行判定 | 分层授权、异常维度、证据验收、自动提交兼容 | P0 |
| M1b | 受控工具 | Agent Task Tools、工作区文件沙箱、Gate 接入 | P0 |
| M2 | 模板可复用 | 模板作用域、角色槽位、实例绑定预检、原子认领 | P0 |
| M3 | 动态计划 | Router Agent、Plan Version、任务物化、Reconciler | P1 |
| M4 | 能力资产路线图 | Skill 定义、安装、模板绑定、实例扩展、运行快照 | 待立项 |
| M5 | 协作入口路线图 | 任务捕获、多人多 AI 上下文、上下文策略、Meeting 群聊增强 | 待立项 |
| M6 | 项目运营路线图 | 项目 PM、角色映射预设、日报/周报/进度报告 | 待立项 |
| M7 | 数据产品路线图 | Data Fabric、Data Agent、只读查询、报告证据 | 待立项 |
| M8 | 工作台产品路线图 | 多工作台、布局版本、面板授权、Resource Market | 待立项 |

M1a 必须先于 M2/M3。M1b 可并行推进，但涉及 Agent 写文件或外部动作前必须完成。否则模板绑定和 Router 计划只能在旧的“负责人写权限”假设上运行，后续需要整体返工。

### 0.3 五个不可直接照搬的决定

1. **不把 `abnormal` 直接加入当前 TaskStatus。**
   当前平台已有 `queued / in_progress / review / paused / blocked / needs_input / done / cancelled`。外部 `abnormal` 的产品含义是“执行有问题但仍需负责人处理”，更适合建模为 `execution_anomaly` 维度，而不是破坏现有状态机。

2. **不按外部 `workspaceId` 语义迁移模板。**
   外部历史模板默认升级为 `platform` 是为了保留原全局可见性；当前平台的历史模板本来就是项目可见，因此存量默认必须是 `project`。

3. **不复制 DSH JSON Storage 表。**
   外部 `collab_*` storage domain 只作为业务对象和状态语义来源，目标实现统一使用 PostgreSQL additive migration。

4. **不引入第二套 Router DAG 存储和页面。**
   Router 计划应进入现有 Workflow Definition/Instance/Runtime 体系，或至少共享同一 Graph Snapshot 和节点状态，不新建平行的 `TaskDagInstance`。

5. **不允许第三方面板或 Skill 即时执行任意代码。**
   首版市场只安装元数据、entitlement 和受信任构建产物，不动态下载并执行远程 JavaScript。

### 0.4 测试评审意见落实

| 评审要求 | 本版处理 |
| --- | --- |
| 分离授权、派发适配性和单次动作门禁 | §4.1 改为 `ExecutionDecision` 三层决策，Gate 不缓存、不跨动作复用 |
| 所有 required 验收项都要有证据 | §4.3 改为全量 required 门禁，并补 acceptance item ID/revision |
| 自动提交与自动验收兼容 | §4.3 新增 `autoSubmit` / `autoAccept` 兼容矩阵 |
| 平台模板三条授权路径 | §5.1.1 分离读取、管理、目标项目实例化授权 |
| Plan 物化与 Reconciler 幂等 | §6.6-§6.8 新增稳定幂等键、物化账本、CAS、租约和 Gate fencing |
| 当前状态与不可变历史分层 | §12.3 明确 assignment、anomaly、acceptance、Plan 的当前表和历史表 |
| Migration 兼容与冲突预检 | §12.2、§17.7 改为 `expand -> backfill -> enforce -> enable` |
| 测试从清单升级为阶段退出门 | §17 改为固定测试层级、G1-G12 门禁和 Feature Flag 开启条件 |
| 收敛本轮范围 | §0.2、§18 将 M4-M8 标为路线图，不再作为本轮实施承诺 |

---

## 1. 审计范围与事实基线

### 1.1 外部仓库审计范围

外部仓库自当前 V1 对照基线 `a702267` 之后共有四个提交：

| 提交 | 日期 | 升级主题 |
| --- | --- | --- |
| `688c868` | 2026-10-29 | Data Agent、Data Fabric、Resource Market、Workbench V2 |
| `0f75579` | 2026-10-31 | Data Orders、Task Capture、Task Tools、任务详情重构 |
| `469f2cd` | 2026-11-04 | 任务详情、订单 Demo、Meeting 与工作台体验收敛 |
| `1acb51d` | 2026-11-05 | Skill 体系、项目报告 Skill、任务文档工作流、外部 Runtime 工具安全 |

当前未提交工作区继续增加了以下能力：

- Workflow Definition `scope`、`role-code`、`portability`、`dispatch-mode`。
- Workflow Instance 执行人绑定、审批人绑定、实例预检、角色映射预设。
- `dsh-collab-router-worker` 新插件。
- Task Capture 与 Agent Task Tools。
- Permission Scope 交集解析。
- Context Policy、Group Scene、Participant Binding、Context Commit。
- Skill 安装与 AI 伙伴实例扩展。
- 项目 PM、项目汇报 Skill、日报/周报/进度报告。
- Meeting 群聊多 AI、定向停止、触发深度和上下文边界。
- Agent 工作区 `read_file / write_file / list_files` 工具及执行门禁。

### 1.2 外部工作区不是稳定发布物

外部最新行为大量存在于未提交工作区中，不能在当前平台直接视为冻结契约。本方案对这些内容采取以下原则：

- 吸收稳定业务语义和安全边界。
- 不依赖外部字段名、路由名、storage table 名或客户端 slot。
- 对外部未提交实现先做契约固化，再进入目标项目实现。
- 不迁移外部测试数据、Demo 数据、Session、Workspace 或 JSON Storage。

### 1.3 当前项目已有基础

当前平台已经具备以下基础，迁移必须复用：

- Human/AI Principal、Account、Credential、AuthSession、WorkspaceMember、RoleGrant。
- Project Role、Project Member、Project Template、Workflow Template。
- Workflow Markdown、Graph Runtime、审批、分支、循环、子流程、超时、恢复和审计。
- Task 队列、Claim、needsInput、Review、依赖、附件、文档和协作动态。
- Run/Job/Outbox/Worker、外部 Runtime、Runtime Binding、Execution Envelope。
- TaskExecutionPolicy、Action Ticket、Execution Gate、Scene Session、Context Receipt。
- AI Teammate 模板、实例、工作队列、自动执行、统计和周报。
- Meeting Facilitator、Delegate、私密嘱咐、投递、纪要和会议 Task。
- Project Report、Workbench Brief、Follow、Supply Exception 和 Supplier Risk。

当前工作区已占用 Migration 33（Shared Space）和 34（Human Avatar Delegation）。本方案的 Migration 编号属于预留，不得在 33/34 最终编号确认前直接实现。

---

## 2. 升级能力清单与迁移判定

状态说明：

- `ADOPT`：应迁移业务语义和契约。
- `ADAPT`：能力应迁移，但实现模型必须按当前平台调整。
- `DEFER`：有价值，但依赖较深或风险较高。
- `NON_TARGET`：不建议迁移宿主实现或产品形态。

| 外部升级 | 事实内容 | 当前目标 | 判定 |
| --- | --- | --- | --- |
| Workflow scope | 项目模板与平台模板分离 | 增加 Definition scope 和可见性 | ADAPT |
| Role code | 跨项目稳定的角色编码引用 | 支持 `roleCode` 和 Project Role 解析 | ADOPT |
| Portability | 固定人/AI 可 required 或 suggested | 增加模板可迁移性 | ADOPT |
| Dispatch mode | assigned / claim | 复用 Task claim，补 Workflow 回调 | ADOPT |
| Instance bindings | 节点级执行人/审批人快照 | 解析后固化到 Instance | ADOPT |
| Preflight | 创建前解析阻塞风险 | 新增只读预检 API | ADOPT |
| Role preset | 项目角色映射预设 | Project 级映射表 | ADOPT |
| Router Worker | 动态 DAG、Plan Version、物化 Task | 统一 Workflow 实例承载 | ADAPT |
| Router Agent | 独立 Agent、工具提交 Plan | 受保护 Teammate Template | ADOPT |
| Reconciler | 依赖推进、失败恢复、最终汇总 | 复用 Worker 定时任务 | ADOPT |
| Task anomaly | abnormal 状态和异常原因 | execution anomaly 维度 | ADAPT |
| Evidence review | Agent 必须显式确认验收项 | 结构化验收证据 | ADOPT |
| Task Tools | 查询、草稿、交付、澄清、评论 | 受控 Agent Tool Facade | ADOPT |
| Task Capture | 从对话/会议整理草稿 | 独立草稿域 | ADOPT |
| Skill platform | 定义、安装、绑定、实例扩展 | 独立版本化能力资产 | ADOPT |
| Project PM | 项目 AI 负责人和汇报 | 项目运营增强 | DEFER |
| Context policy | 全平台阈值与场景覆盖 | 版本化 Context Policy | ADOPT |
| Group scene | 群聊多 AI、参与者隔离 | 新 Scene 和 participant binding | ADAPT |
| Workspace tools | read/write/list 安全工具 | Worker 侧路径沙箱 | ADOPT |
| Data Fabric | 数据目录、指标、只读查询 | 独立数据基础域 | DEFER |
| Data Agent | 数据问答、QueryRun、报告 | 复用 Agent Run 与 Context | DEFER |
| Workbench V2 | 多实例、布局、面板 | 服务端布局 + 受控组件注册表 | ADAPT |
| Resource Market | Skill/MCP/模板/插件市场 | 版本化资产与 entitlement | ADAPT |
| DSH Slot / Client Module | DSH 客户端装载机制 | 当前 React 自有路由 | NON_TARGET |
| DSH JSON Storage | KV 表、插件本地 Domain | PostgreSQL | NON_TARGET |
| DSH Shell / Workspace Browser | 宿主导航和会话 | 当前 Web Shell | NON_TARGET |
| 动态远程 JS | 第三方面板即时装载 | 受信任构建产物 | NON_TARGET |

---

## 3. 目标架构

### 3.1 分层落点

```text
apps/web
  WorkflowPlanView / TaskCaptureView / SkillMarketView
  DataAgentSidePanel / WorkbenchLayoutView / ProjectReportView
        |
apps/api
  Workflow Assignment / Router Plan / Task Capture / Skill
  Data Fabric / Data Agent / Workbench / Resource Market
        |
packages/application
  业务用例、授权、幂等、事务边界、事件发布
        |
packages/domain
  Workflow Graph、Router Graph、Task Transition、Evidence Rule
        |
packages/database
  PostgreSQL Repository、不可变版本、Outbox、审计
        |
apps/worker
  Router Cycle、Plan Reconciler、Report Generator、Data Query
        |
packages/agent-runtime
  Runtime Adapter、Tool Policy、Workspace Tool Sandbox
```

### 3.2 新增应用服务

| 服务 | 职责 |
| --- | --- |
| `WorkflowAssignmentService` | 模板槽位解析、实例绑定、预检、改派和审计 |
| `WorkflowPlanService` | Plan Version、动态 Graph、预览、确认、物化 |
| `RouterCycleService` | Router Agent 选择、受信 Session、Plan Draft 工具 |
| `ExecutionAnomalyService` | 运行异常判定、原因归档、恢复清理 |
| `TaskAcceptanceService` | 验收项证据确认、Review 前置门禁 |
| `TaskCaptureService` | 草稿会话、候选、批次、转换和来源 |
| `SkillCatalogService` | Skill 定义、版本、安装、绑定、有效集合 |
| `ExecutionDecisionService` | 分层解析授权、派发适配性和单次动作门禁 |
| `ContextPolicyService` | 平台阈值、场景覆盖、版本和重置 |
| `ProjectReportingService` | PM 汇报事实包、Skill 快照和不可变报告 |
| `DataFabricService` | 连接、数据集、指标、策略和只读查询 |
| `DataAgentService` | 会话、上下文选择、QueryRun、报告 |
| `WorkbenchConfigurationService` | 工作台实例、布局、面板和 entitlement |

### 3.3 核心事实源

| 业务事实 | 唯一事实源 |
| --- | --- |
| 身份与授权 | Principal、RoleGrant、ProjectMember、ProjectRole |
| 执行策略 | TaskExecutionPolicy revision |
| 高风险动作 | Action Ticket、Execution Gate |
| Workflow 定义 | Workflow Definition version |
| Workflow 实例 | Workflow Instance revision |
| Router Plan | 不可变 Plan Version |
| 子任务 | 正式 Task |
| 执行 | Run / Job / Runtime Effect |
| 上下文 | Scene Session、ContextPack、Context Receipt |
| Skill | Skill Definition Version + Run Skill Snapshot |
| 数据答案 | QueryRun + QueryResult + Metric/Policy version |

任何 UI local state、Prompt 文本、Agent 输出或 DSH storage 都不得成为上述事实的第二来源。

---

## 4. M1a/M1b：执行可信基础

### 4.0 实施拆分

| 批次 | 范围 | 可独立退出门 |
| --- | --- | --- |
| M1a | 分层执行判定、异常维度、验收证据、自动提交兼容 | 可以启动 M2/M3，但只开放验收和澄清所需的最小 Task 写入 Tool，不开放文件和外部动作 |
| M1b | Agent Task Tools、工作区文件工具、Execution Gate | 可以开启 Agent 写文件和外部动作类 Tool |

M1a 是 M2/M3 的前置依赖。M1b 不阻塞模板绑定预检和 Router 计划读取，但在任何写文件、外部发送或审批动作开放前必须完成。

### 4.1 有效执行范围

当前平台已经具备统一授权服务，但不能再把“主体是否有权限”“当前是否适合派发”和“本次动作是否获准”压缩为一个可缓存的 `allowed` 布尔值。三者的事实来源、失效时机和审计粒度不同。

```text
Authorization
  = Project Capability
  ∩ Principal Grant
  ∩ Project Role / Seat

DispatchEligibility
  = Authorization
  ∩ Runtime / Tool Capability
  ∩ Node Constraint
  ∩ TaskExecutionPolicy

ActionDecision
  = 当次动作的 Ticket / Gate
  ∩ 当次资源范围
  ∩ 当次主体
```

数据策略只在数据读取、数据 Tool 或数据写入动作中参与，不进入普通任务派发的固定 Scope。Action Gate 是单次动作决策，不得生成长期 Scope，也不得跨资源复用。

建议新增统一返回：

```ts
type ExecutionDecision = {
  projectId: string;
  principalId: string;
  authorization: {
    allowed: boolean;
    permission: "read" | "write" | "approve" | "manage_members" | "manage_roles";
    grantIds: string[];
    membershipId?: string;
    reasons: DecisionReason[];
  };
  dispatchEligibility: {
    allowed: boolean;
    runtimeRevision?: number;
    policyRevision?: number;
    bindingRevision?: number;
    reasons: DecisionReason[];
  };
  actionDecision?: {
    allowed: boolean;
    action: string;
    resourceId: string;
    ticketId?: string;
    gateId?: string;
    reasons: DecisionReason[];
  };
  decidedAt: string;
  cacheable: boolean;
};

type DecisionReason = {
  code: string;
  message: string;
  source: string;
};
```

一致性规则：

- deny wins。
- Root Task 不作为子节点的权限继承来源。
- AI Principal 不使用 Owner、任务创建人或 Root Task 负责人权限。
- 预检只返回候选结论，不能作为实例启动或节点派发的最终凭证。
- 实例启动前重新检查目标项目 `write`、角色解析、绑定 revision 和 Runtime 条件。
- 节点派发前使用数据库权威状态再次检查，不能只依赖前端、事件负载或缓存。
- 每次写文件、外部发送、审批和其他受保护动作都单独检查 Gate；A 资源的 Ticket 不能用于 B 资源。
- 已启动 Run 继续使用不可变 Execution Envelope，但 Run 内后续高风险动作仍需复核。
- 项目角色、Grant、Runtime、绑定或策略变化后，尚未产生副作用的工作必须停止。
- 不假设存在天然一致的 `grantRevision`、`roleRevision` 和 `runtimeRevision`。如使用缓存，必须使用明确的授权纪元、组合摘要或短 TTL，并在副作用前重新校验。
- 授权事实可以短时缓存；ActionDecision 不得跨动作、跨资源或跨时间复用。

### 4.2 执行异常维度

不在 `taskStatusSchema` 中新增 `abnormal`。

一个任务可能同时存在多个异常，例如 Tool 失败、依赖未满足和缺少验收证据。因此异常必须是记录集合，`executionHealth` 只能作为派生投影。

```ts
type TaskExecutionHealth = "healthy" | "attention" | "anomaly";

type TaskExecutionAnomaly = {
  id: string;
  taskId: string;
  code:
    | "run_failed"
    | "run_timeout"
    | "run_interrupted"
    | "tool_failed"
    | "plan_failed"
    | "dependency_unmet"
    | "missing_acceptance"
    | "missing_execution_evidence";
  message: string;
  runId: string | null;
  runAttempt: number | null;
  eventId: string | null;
  status: "active" | "cleared";
  occurrence: number;
  detectedAt: string;
  clearedAt: string | null;
  clearedReason: string | null;
};
```

约束：

- 活动异常唯一键为 `(task_id, run_id, code) WHERE status='active'`。
- 清除异常只更新活动记录并保留历史审计，不物理删除。
- `executionHealth` 从活动异常和验收状态计算；不得成为与异常表并列且可独立编辑的第二事实源。
- 恢复执行时按 Run attempt 清除对应异常，不能无条件清空任务上的所有历史异常。
- 同一 Run 再次出现同类异常时复用活动记录并累加 occurrence，不重复制造多条当前记录。

产品映射：

| 外部状态 | 当前平台投影 |
| --- | --- |
| `todo` | `queued` |
| `progress` | `in_progress` |
| `abnormal` | `in_progress` + `executionHealth=anomaly` |
| `review` | `review` |
| `done` | `done` |
| `cancelled` | `cancelled` |
| 等待用户补充 | `needs_input` |
| 主动暂停 | `paused` |
| 不可继续 | `blocked` |

好处：

- 不破坏现有状态迁移矩阵。
- 异常任务仍进入“进行中”列。
- 恢复执行时可只关闭对应异常，不需做非法状态回退。
- 未来的质量、SLA 和运营统计可以直接按 anomaly code 聚合。

### 4.3 证据驱动自动验收

外部升级的核心不是新增异常标签，而是停止系统代勾验收项。

目标规则：

```text
自动提交 Review
  = Run completed
  ∩ dependencies satisfied
  ∩ no failed tool event
  ∩ no denied gate
  ∩ execution plan has no failed step
  ∩ every required acceptance item is confirmed with valid evidence
  ∩ the current owner Run is selected as execution evidence
  ∩ evidence belongs to the current task and acceptance revision
```

当前 `tasks.acceptance` 是字符串数组，无法稳定回答“确认的是哪一项”。迁移时增加规范化验收项：

```ts
type TaskAcceptanceItem = {
  id: string;
  taskId: string;
  position: number;
  requirement: string;
  required: boolean;
  revision: number;
  contentDigest: string;
  deprecatedAt: string | null;
};
```

存量字符串在首次启用证据规则时按顺序回填为稳定 ID、`required=true`、`revision=1` 和内容摘要。兼容期内 API 继续返回原 `string[]`，同时可返回带 ID/revision 的扩展投影；新写入以规范化表为事实源，避免长期双写。

新增结构化验收确认：

```ts
type AcceptanceEvidenceRef = {
  kind: "artifact" | "tool-event" | "run-output" | "external-resource";
  refId: string;
  version?: string;
  digest?: string;
};

type AcceptanceConfirmation = {
  id: string;
  acceptanceItemId: string;
  acceptanceItemRevision: number;
  taskId: string;
  runId: string;
  runAttempt: number;
  confirmedByPrincipalId: string;
  confirmationTool: "task_submit_deliverable";
  evidenceRefs: AcceptanceEvidenceRef[];
  confirmedAt: string;
  supersededAt: string | null;
};
```

门禁：

- Agent 不能通过普通文本声明“已完成”来满足验收。
- 所有 required 验收项必须有有效确认；optional 项必须显式标记，不能因空值默认 optional。
- 验收项内容、顺序或 required 标记修改后，旧 confirmation 失效并标记 superseded。
- `evidenceRefs` 必须由服务端验证属于当前 task、当前 Run 和当前 acceptance item revision，不能只存自由字符串。
- 当前证据 Run 只接受最新有效的 owner Run；collaborator Run、旧 Run、失败 Run 或已 superseded Run 不能作为当前验收证据。
- Agent 不能批准自己的任务。
- 人工 Review 仍由具有 `approve` 能力的主体完成。
- 退回时保留旧证据，但标记 superseded，不覆盖历史。
- 缺少证据时进入 anomaly，而不是伪造完成。

与现有自动提交/自动验收路径的兼容矩阵：

| 配置 | 证据状态 | enforce 行为 |
| --- | --- | --- |
| `autoSubmit=true` | 所有 required 有有效证据 | 允许提交 Review |
| `autoSubmit=true` | 任一 required 缺证据 | 保持 `in_progress`，记录 anomaly，不提交 |
| `autoSubmit=false` | 任意 | 由负责人显式提交，服务端仍校验证据 |
| `autoAccept=true` | 证据未完成 | 不允许 Done |
| `autoAccept=true` | 证据已完成 | 仍不能绕过独立 Review/approve；若保留自动通过，必须由独立项目策略授权、指定不同主体并写审计 |

`task.evidence_review=observe` 只计算新旧判定差异和统计，不写“已确认”事实、不改变 Task 状态、不触发自动 Review。差异稳定后才能进入 `enforce`。

### 4.4 Agent Task Tools

新增受控 Tool Facade。M1a 只开放验收和澄清闭环必需的最小集合，其余在 M1b 或后续 Task Capture 阶段开放：

| Tool | 批次 | 能力 | 禁止 |
| --- | --- | --- | --- |
| `task_query` | M1a | 读取当前任务、验收项、Run、依赖和文档清单 | 任意跨项目搜索 |
| `task_submit_deliverable` | M1a | 提交结果并确认已实际检查的验收项 | 自我批准 Review |
| `task_request_input` | M1a | 请求补充信息 | 修改优先级或负责人 |
| `task_comment` | M1b | 写入执行反馈或评论 | 修改系统策略 |
| `task_capture_draft` | M5 | 从当前上下文创建草稿 | 直接创建正式 Task |

Tool 身份从当前 Run Session、Scene Binding 和 Agent Principal 服务端反查，绝不接受模型自报 userId 或 projectId。

### 4.5 工作区文件工具

外部最新实现新增 `read_file / write_file / list_files`。当前平台应迁移安全语义，不照搬 DSH 工具注册方式。

必须满足：

- 工具根目录只能是当前 Run 的隔离工作区。
- 只接受工作区相对路径。
- 拒绝绝对路径、`..`、NUL、反斜杠和路径穿越。
- 每一级路径拒绝符号链接。
- 读取有字节上限。
- 列表有深度、条目数和输出字节上限。
- 写入必须映射到 `fs.write` 工具类别，并经过 Execution Envelope。
- 高风险写入仍受 Action Ticket/Gate 约束。
- 临时文件 + rename，避免部分写入。
- 工具事件写入 Run Event，包含路径摘要、字节数和结果，不记录敏感正文。

没有 Execution Envelope 时必须 deny，不允许默认 allow。

### 4.6 M1a 退出条件

- `executionHealth=anomaly` 不影响 Task 状态机合法性。
- 不存在 required 验收项未全部确认却自动进入 Review 的路径。
- 工具失败、超时、中断、依赖未满足都能落到明确 anomaly code。
- `autoSubmit` / `autoAccept` 的新旧行为差异已完成清点。
- 预检后撤权、派发前角色变化、Runtime 降级和跨资源 Ticket 都有负向测试。
- 模板、Router、Task Tool、Data Agent 可以共享分层 ExecutionDecision，但 Gate 决策不复用。

### 4.7 M1b 退出条件

- 工作区文件工具通过路径穿越、符号链接、超限和 Gate 拒绝测试。
- Task Tool 和文件工具的身份只能从当前 Run/Scene 反查。
- 没有 Execution Envelope 时默认拒绝。
- Gate 拒绝后无法通过重试或普通文本绕过。

---

## 5. M2：模板作用域、责任槽位与实例绑定

### 5.1 Definition 作用域

当前 `workflow_definitions.project_id` 继续表示“来源项目/管理项目”，不改为可空。

新增语义：

```ts
type WorkflowDefinitionScope = "project" | "platform";

type WorkflowDefinition = {
  scope: WorkflowDefinitionScope;
  ownerProjectId: string;
  publishedByPrincipalId?: string;
  publishedAt?: string;
  origin: "template" | "router" | "manual";
};
```

迁移规则：

- 当前所有存量 Definition 默认 `scope=project`。
- 平台管理员显式发布后才变为 `scope=platform`。
- 平台模板仍保留 ownerProjectId，用于责任追踪和后续下线。
- 普通项目成员不能发布、编辑或下线平台模板。
- 平台模板版本链按 `key + version` 管理；Instance 始终绑定固定 Definition ID/version。

#### 5.1.1 平台模板授权路径

`scope=platform` 只解决可见性分类，不能复用 owner project 的成员关系作为跨项目授权。必须分离三个动作：

| 动作 | 授权原则 | 审计要求 |
| --- | --- | --- |
| 发现和读取平台模板 | 活跃 Principal 可读取已发布 active 版本；未发布草稿仅管理者可见 | 记录 scope、version、读取入口 |
| 编辑、发布、下线平台模板 | 平台管理员或显式 `manage_workflow_templates` Platform Grant；owner project 普通成员不自动获得 | 记录发布者、ownerProjectId、变更前后版本 |
| 在目标项目创建实例 | 调用方在目标项目具有 `write`，并重新执行目标项目节点绑定预检 | 记录 target project、binding snapshot、来源平台模板 |

约束：

- `ownerProjectId` 只用于归属、责任和下线，不构成其他项目实例的运行授权。
- 平台模板中的固定人员默认使用 `suggested`，除非产品明确允许 required。
- 目标项目绑定解析后，所有节点继续按目标项目、目标负责人和 Runtime 重新授权。
- 现有 `GET /api/v1/workflows` 的项目过滤语义保持兼容；新增组合查询时必须显式返回平台模板，不能让旧客户端意外看到跨项目数据。
- 平台模板详情、实例预检和实例创建分别鉴权，不能因为能读模板就推导出能启动实例。

### 5.2 节点绑定模型

保留现有 executor/approver 语义，增加：

```ts
type TemplatePortability = "required" | "suggested";
type DispatchMode = "assigned" | "claim";

type RoleSlot = {
  kind: "role";
  roleId?: string;
  roleCode: string;
  label?: string;
};

type FixedSlot = {
  kind: "user" | "agent" | "employee";
  id: string;
  label?: string;
  portability: TemplatePortability;
};
```

默认：

- Role Slot 使用 `claim`。
- User/Agent/Employee 使用 `assigned`。
- Approval 节点必须 `assigned`。
- 平台模板优先使用稳定 `roleCode`。
- `required` 固定人员缺失时阻塞。
- `suggested` 固定人员缺失时允许在预检中重映射。

### 5.3 实例绑定

建议使用结构化表而不是仅存一个超大 JSON：

```text
workflow_instance_assignments
  instance_id
  node_id
  source_kind
  source_id
  source_role_code
  dispatch_mode
  status              resolved | unresolved | overridden
  primary_principal_id
  candidate_pool      JSONB
  resolved_by
  resolved_at
  source_change_reason
  revision

workflow_instance_approvers
  instance_id
  node_id
  principal_id
  source_kind
  source_id
  status
  resolved_by
  resolved_at
  revision
```

同时保存一个不可变 `binding_snapshot` 到 Workflow Audit，用于回答“启动时为什么是这个执行人”。

约束：

- `workflow_instance_assignments` 对 `(instance_id, node_id)` 唯一。
- `workflow_instance_approvers` 对 `(instance_id, node_id, principal_id)` 唯一。
- `assigned` 必须有且仅有一个 primary assignee。
- `claim` 至少有一个 candidate。
- AI 默认只允许 assigned；未来若要 AI claim，需单独 Agent Claim Policy。
- 审批人与执行人独立解析，不因角色相似自动复用。
- 模板修改不影响已启动实例。
- 绑定失效时节点 blocked，不自动猜人。

### 5.4 预检 API

建议路径：

```http
POST /api/v1/workflows/:workflowId/instances/preflight
```

输入包括 `title`、`context`、节点绑定覆盖和 `expectedDefinitionVersion`。

输出：

```ts
type WorkflowInstancePreflight = {
  definitionId: string;
  definitionVersion: number;
  scope: "project" | "platform";
  nodes: Array<{
    nodeId: string;
    nodeName: string;
    source: unknown;
    dispatchMode: "assigned" | "claim";
    status: "resolved" | "unresolved" | "overridden";
    primaryAssignee?: unknown;
    candidatePool?: unknown[];
    blockingRisks: Array<{
      code: string;
      message: string;
      actions: string[];
    }>;
  }>;
  canStart: boolean;
  decisionContext: {
    computedAt: string;
    authorizationEvidence: string[];
    runtimeRevisions: number[];
    policyRevisions: number[];
  };
};
```

预检必须只读：

- 不创建 Instance。
- 不创建 Task。
- 不创建 Run。
- 不写正式授权。

正式创建时服务端重新执行预检，不信任前端结果。

预检结果不是授权缓存。即使 `canStart=true`，创建事务仍要在目标项目、绑定 revision、Runtime 和 Feature Gate 围栏下重新解析。

### 5.5 Assigned 与 Claim

`assigned`：

```text
node ready
  -> 读取 Instance Binding
  -> 校验 Authorization 与 DispatchEligibility
  -> 创建/复用 Task
  -> 人或 AI 按既有 Task 链路继续
```

`claim`：

```text
node ready
  -> 创建候选池 Task
  -> 候选成员可见
  -> Task Queue 原子 claim
  -> Workflow 回调 node.claimed
  -> 失败者收到 node.claim_rejected
```

必须复用当前 Task Queue 的 `execution_claim_token`、`execution_claim_owner` 和 `execution_claim_expires_at`，不新增第二套抢单机制。

### 5.6 项目角色映射预设

新增：

```text
project_role_mapping_presets
  project_id
  role_id
  assignees JSONB
  revision
  updated_by_principal_id
  updated_at
```

规则：

- 预检时作为建议值预填。
- 创建者必须确认。
- 预设不是 Instance 启动依据。
- 每次启动都解析成 Instance Binding Snapshot。
- 删除 Project Role 时同时删除对应预设并写审计。

### 5.7 M2 退出条件

- 项目模板只在本项目可见。
- 平台模板跨项目可见但不能被普通成员编辑。
- 非 owner project 成员可读取平台模板，但不能管理。
- 目标项目无 `write` 时不能实例化平台模板。
- 固定人员缺失时返回可操作 blocking risk。
- 任一必填节点未解析时不能创建 Instance。
- 同一候选池并发 claim 只有一个成功。
- 映射、改派、认领和拒绝都有不可变审计事件。

---

## 6. M3：Router / Worker 动态计划

### 6.1 统一计划容器

目标不是复制 `dsh-collab-router-worker` 的独立 storage domain，而是让 Router Plan 进入当前 Workflow 体系。

建议复用：

```text
Workflow Definition Version -> Plan Version / Graph Snapshot
Workflow Instance           -> 计划实例和节点运行状态
Task                        -> 物化节点
Run / Job / Outbox          -> AI Worker 执行
```

为区分来源，Workflow Definition 增加：

```ts
type WorkflowPlanSource = "template" | "router" | "manual";
```

Router 计划的 Definition：

- `origin=router`。
- 不出现在普通模板目录。
- 每个 Root Task 使用稳定 key，版本仍按 key + version。
- 每次编辑/重规划形成新的 Plan Version。
- 已确认 Instance 固定 Definition Version。

这是当前代码下改动最小、且能复用 Workflow Runtime 的方案。若后续认为 Definition 不应承载 Router Plan，可再演进为独立 `execution_plans` 表；第一阶段不做双轨存储。

### 6.2 Root Task 与节点 Task

新增 `task_origins`：

```text
task_origins
  task_id UNIQUE
  source_kind           manual | workflow | router | meeting | capture
  source_id
  parent_task_id
  root_task_id
  created_by_principal_id
  idempotency_key
  metadata JSONB
  created_at
```

规定：

- `idempotency_key` 唯一；同一来源节点不能产生两条 origin。
- Root Task 是业务承诺和最终 Review 载体。
- Plan Node 物化为正式 Task。
- 子任务创建人和 Run 归属继承“计划确认人”，而不是物化操作人或 Router。
- 完成子节点不改写 Root Task 状态机。
- Plan 全部 required 节点 accepted 后才进入最终汇总。
- 人工 Root Task 只收到交付草稿，保持业务状态不变。
- AI Root Task 最多进入 Review，不能自动 Done。

### 6.3 Router Agent

Router 是 Agent 类型，不是显示名称。

需要：

- 受保护 Teammate Template。
- 必装工具 `router_worker_submit_plan`、`router_worker_submit_final_draft`。
- 绑定唯一 AI Principal、Agent Profile 和 Runtime Profile。
- 默认关闭，Workspace 首次启用时可幂等初始化。
- 只能登记声明 Router Tool Contract 的 AI Teammate。
- Data Agent、Meeting Facilitator 等普通 Agent 不能被选为 Router。
- Plan 创建时固化 Router Agent；修改 Workspace 默认值不影响已有计划。

### 6.4 Plan Version

不可变字段：

- graph。
- settings。
- source。
- reason。
- createdBy。
- createdAt。
- routerAgentId。

可变状态只在 Plan 记录：

- currentVersion。
- status。
- confirmedBy / confirmedByRole / confirmedAt。
- revision。

Plan 状态建议：

```text
draft -> proposed -> approved -> active -> finalizing -> completed
                  \-> cancelled / failed / paused / resume_required
```

人工编辑必须使用 `expectedRevision`。已 active 的计划非显式替换不能覆盖。

### 6.5 Graph Validator

必须校验：

- 节点 ID 唯一。
- 依赖存在。
- 无自依赖。
- 无环。
- 至少一个 start。
- 所有节点从 start 可达。
- 只允许 AND-join。
- 节点标题、描述、验收非空。
- receiver 合法且属于可用 Worker 类型。
- Router 不能提交、缓存或覆盖权限范围。
- 多个弱连通分量拒绝。
- 节点数、深度、出度和并发受计划设置限制。

### 6.6 物化与派发

Task 物化幂等键必须由服务端稳定生成：

```text
router-worker:{planId}:v{planVersion}:{nodeId}
```

不能包含客户端重试次数、Worker attempt、时间戳或可变化的物化操作人。节点执行重试复用同一个 Task，并增加 Run attempt，而不是重新物化 Task。

新增物化账本：

```text
plan_materializations
  id
  plan_id
  plan_version
  node_id
  creation_key
  status              pending | materializing | materialized | failed
  task_id
  last_error
  lease_owner
  lease_expires_at
  revision
  created_at
  updated_at
  UNIQUE(plan_id, plan_version, node_id)
```

恢复规则：

1. 先以唯一键插入 `pending` 账本。
2. 通过可幂等的 Task Application Command 创建或复用 Task，creationKey 与账本一致。
3. Task 成功后在同一事务写 `task_origins` 并把账本置为 `materialized`。
4. 若 Task 已创建但 origin 未写，按 creationKey 反查并补齐，不重复创建。
5. 若账本停留在 `materializing` 且租约过期，允许接管恢复。

流程：

```text
Plan approved
  -> CAS 确认 Plan revision 和 Feature Gate epoch
  -> 获取每个 node 的物化租约
  -> 幂等 create-or-reuse Task
  -> 写 task_origins + materialization ledger
  -> 创建 dispatch binding
  -> ready + agent 节点派发
  -> Reconciler 推进 waiting -> ready
```

Task 创建继续走 Application Service 和正式 Task 用例，不直接写 Repository。优先在一个数据库事务完成 Task、origin 和 ledger；若现有 Task 服务无法加入事务，则必须以持久 creationKey 和补偿命令保证可恢复。

### 6.7 Reconciler

同一 Plan 的 approve、materialize、finalize 和 Reconciler 必须保证单写：

- Plan 命令使用 `expectedRevision` / CAS。
- Reconciler 候选使用租约或 `FOR UPDATE SKIP LOCKED`。
- Outbox / Job 按 message ID 幂等。
- 已发布的命令不会因进程崩溃丢失。
- 重复消息不会重复创建 Task、Run 或最终报告。

Reconciler 只做：

- 基于数据库权威状态推进依赖。
- 恢复丢失的 Task/Run 事件。
- 对可派发 AI 节点执行幂等派发。
- 检测全部 required 节点完成。
- 触发最终 Router Cycle。
- 对失败、needsInput、Review 退回设置安全停点。

Reconciler 不：

- 代签审批。
- 直接完成 Root Task。
- 修改 Plan 权限。
- 无限重试。
- 在 Feature Gate 关闭后继续调度或产生副作用。

### 6.8 Feature Gate 与关闭态

- 默认关闭。
- 关闭后提交的新命令必须被拒绝。
- 已有在途命令在产生 Task、Run、外部发送或其他副作用前再次检查开关和 Plan 状态。
- 关闭事务递增 Gate epoch；派发命令携带 expected epoch，epoch 不一致时进入安全停点。
- 关闭后停止 Plan 调度、Reconciler、新派发和 Router 唤醒。
- Active Plan 进入 `resume_required`。
- 运行中的 Agent Run 请求安全暂停或取消，不做无确认的破坏性终止。
- 已物化 Task 作为普通 Task 保留。
- 重新开启不自动恢复，必须用户明确继续。
- 关闭态控制面仍可读取 Router 状态，以便展示 `resume_required`、安全停点和审计；但不得产生执行副作用。
- “关闭态不读取 Router Domain 数据”修正为“不得调度、派发或写业务副作用”。

### 6.9 M3 退出条件

- 人工、Router、模板三种计划可在同一 UI 渲染。
- 计划版本不可变且可 diff。
- 非法 DAG 无法确认或派发。
- 并发确认、物化和 Reconciler 不会重复创建 Task/Run，账本唯一约束有效。
- Task 创建后崩溃可通过 creationKey 恢复 origin，不产生孤儿或重复 Task。
- 计划确认人正确继承到子任务创建和 Run 归属。
- 关闭后无新派发；在途命令在副作用前被 fence；重开不自动执行。

---

## 7. M4：Skill 能力资产（路线图）

> 本节只保留能力边界和依赖，不构成本轮实施承诺。进入 M4 前需单独评审数据模型、安装权限和运行快照。

### 7.1 四个对象必须分离

| 对象 | 含义 |
| --- | --- |
| Skill Definition | 指令、输出契约、触发场景、权限声明 |
| Skill Installation | 某账号是否有权发现和启用 |
| Skill Binding | 哪个 Template/Instance 使用它 |
| Effective Skill Snapshot | 本次 Run 实际加载的 ID、版本和摘要 |

### 7.2 数据模型

建议新增：

```text
skill_definitions
skill_versions
skill_installations
teammate_template_skill_bindings
teammate_instance_skill_extensions
run_skill_snapshots
```

关键字段：

- `skill_versions.digest`。
- `publisher_principal_id`。
- `trust_level`：official / verified / private。
- `status`。
- `instructions`。
- `manifest`。
- `permissions`。
- `triggers`。
- `version`。
- `protected`。
- `created_at`。

### 7.3 有效 Skill 解析

```text
EffectiveSkills
  = requiredTemplateSkills
  ∪ enabledDefaultTemplateSkills
  ∪ allowedInstanceExtensionSkills
```

规则：

- 按 Skill ID 去重。
- 保留版本、层来源和 digest。
- Required Skill 不可被用户停用或影子替换。
- 用户扩展只能追加，不能覆盖平台安全规则。
- Skill 只能使用调用方已有权限。
- Skill 不得携带密钥。
- Skill 指令是业务数据，不是系统授权。
- 历史 Run 和报告不按最新 Skill 重写。

### 7.4 初始官方 Skill

建议第一批只迁移：

- `project-reporting`：项目日报、周报、进度汇报。
- `work-report`：AI 伙伴个人工作日报。
- `competitive-analysis`：竞品分析。

官方 Skill：

- 普通用户可以安装和绑定到自己的 AI 伙伴。
- 只有平台管理员可以编辑官方正文。
- 编辑形成新版本，不覆盖已使用版本。

### 7.5 M4 路线图门禁

- 未安装或无权使用的 Skill 无法绑定。
- 平台强制 Skill 无法被实例扩展停用。
- Run 可追溯实际 Skill 版本和 digest。
- Skill 不影响项目、数据或工具授权。
- 历史报告和 Run 不受 Skill 升级影响。

---

## 8. M5：任务捕获、上下文与会议协作（路线图）

> 本节只保留协作语义，不在本轮冻结全部 API 和页面细节。

### 8.1 Task Capture 独立域

Task Draft 不复用 TaskStatus，不写入正式 Task 的 acceptance 和负责人语义。

建议表：

```text
task_capture_sessions
task_capture_candidates
task_draft_batches
task_drafts
task_origins
task_draft_conversions
```

来源 Adapter：

- direct-chat。
- meeting。
- workbench。
- workflow。
- manual。

转换规则：

- 只有 `commit` 创建正式 Task。
- `creationKey` 保证幂等。
- 正式创建前重新校验 Workspace/Project 权限。
- 草稿来源保存 source ID、版本、摘录 hash 和失效状态。
- 部分失败保留逐项结果，不假整体成功。

### 8.2 Group Scene 与 Participant Binding

当前 Scene 已有 task、workflow-node、meeting、direct-chat、delegation。建议新增：

```text
sceneType = group
```

Scene Session 唯一键从：

```text
scene + object + agent + generation
```

升级为：

```text
scene + object + participantBindingId + agent + generation
```

原因：

- 同一个 Meeting/Group 中可能有多个 AI 参与者。
- 每个 AI 必须拥有独立 Session 和上下文游标。
- 参与者离会、重入、停止、恢复不能串上下文。
- 同名 Agent 不能共享 Session。

### 8.3 Context 边界与提交

新增 Session 字段：

```text
participant_binding_id
revision
status               preparing | active | archived | reset
last_context_seq
context_usage_ratio
compaction_count
```

新增 ContextPack/Receipt：

```text
context_boundary_seq
context_policy_version
context_usage_ratio
```

规则：

- `preparing` Session 不代表已提交。
- Runtime 成功接受上下文后，才提交 `last_context_seq`。
- 下次只读取 `lastContextSeq < seq <= boundarySeq` 的增量。
- 历史 Pack 不可变。
- 权限撤销后 Context 立即不可读。
- 超预算时只保留索引和工具入口，不伪造摘要。

### 8.4 Context Policy

新增版本化平台策略：

```text
warning_ratio                 0.70
compact_ratio                 0.85
rollover_ratio                0.95
preserve_recent_messages      12
max_trigger_depth             3
max_concurrent_agents_per_scene 3
```

支持：

- 平台默认值。
- direct-chat / group / meeting 场景覆盖。
- `expectedVersion` 乐观锁。
- 重置到默认值。
- 管理员权限。
- 历史 ContextPack 不受新策略覆盖。

### 8.5 Meeting 多 AI 协作

当前平台已有 Meeting AI、Facilitator、Delegate、私密嘱咐和投递。建议只补充外部升级中的缺失语义：

- 会议内多个 AI 参与者独立响应。
- `@AI` 定向触发。
- `autoSpeak=all | mentions | manual`。
- AI 参与者级停用/恢复。
- 整场 AI Runtime 停用/恢复。
- 群聊消息 sequence 作为 Context Boundary。
- 触发链深度限制。
- 同一消息的 delivery 幂等。
- AI 回复归属具体 participant、principal、run。

不迁移：

- 外部巨型单文件 Meeting UI。
- Meeting 与 AI 单聊共用“meeting.kind=ai”的存储捷径。
- 用 Meeting 表承载所有直接对话。

当前平台继续保留 Direct Chat 独立域。

### 8.6 M5 路线图门禁

- 从对话或会议创建的草稿不会提前进入 Task。
- commit 重试不重复创建任务。
- 同群多个 AI Session 完全隔离。
- 上下文只提交成功消费的边界。
- 群聊 390/1024/1440 视口无布局和上下文串线。

---

## 9. M6：项目 PM、映射预设与项目汇报（路线图）

> 本节依赖 M2 角色映射和 M4 Skill 治理，需重新立项后展开。

### 9.1 项目 PM 角色

外部新增内置 `role-pm`：

- 默认只拥有 `read`、`write`。
- 不默认拥有成员或角色管理权。
- 由项目模板自动带入。

当前平台迁移时：

- 先作为可选 Project Role 库新增，不强制所有存量项目加入。
- 新建项目是否自动放置 PM 角色需产品确认。
- AI PM 不得通过创建者权限获得隐式越权。

### 9.2 AI PM 幂等初始化

若启用：

- 为 Project 创建一个 Project-scoped AI Teammate。
- 绑定受保护 PM Template。
- 自动绑定 Project Reporting Skill。
- 绑定唯一 AI Principal、Agent Profile、Runtime Profile。
- 分配 PM Project Role。
- 使用项目 ID 作为幂等键。
- 存量项目只在详情或首次生成报告时按需补齐。

失败处理：

- 创建 Project 不能因 AI PM 失败而回滚核心 Project。
- 写 `project.manager.provision_failed` 审计。
- UI 展示可重试状态。

### 9.3 报表模型迁移

当前 `project_reports` 已有不可变版本，迁移时只做 additive 扩展：

```text
report_kind             daily | weekly | progress
period_start
period_end
generated_by_principal_id
run_id
skill_id
skill_version
skill_digest
trigger_source
source_digest
```

唯一约束从：

```text
project_id + report_date + version
```

调整为：

```text
project_id + report_kind + report_date + version
```

存量记录默认 `report_kind=daily`。

### 9.4 汇报生成链路

```text
trigger
  -> 构建授权事实包
  -> 解析 Effective Skills
  -> 创建 Run
  -> Skill 生成报告
  -> 校验 source refs 和数字
  -> 写不可变 Project Report
  -> 写审计和通知事件
```

事实包至少包含：

- 项目 owner、状态、健康度、进度。
- 开始/目标日期和计划偏差。
- 已完成、待验收、异常任务。
- Workflow blocked、approval、run terminal。
- 已确认交付物。
- 风险和待决策。
- 每个事实的 source ref 和 cutoff。

禁止：

- 把任务活动直接写成业务成果。
- 编造负责人、日期、数字和结论。
- 用最新 Skill 重写历史报告。
- AI PM 代签审批。

### 9.5 M6 路线图门禁

- PM 角色不扩大成员管理权限。
- PM 初始化幂等，可重试。
- daily/weekly/progress 可共存且版本不可变。
- 报告带 Skill 版本、Run 和 source refs。
- 历史报告在 Skill 升级后保持一致。

---

## 10. M7：Data Fabric 与 Data Agent（路线图）

> 数据 Connector、ACL、凭据和真实生产数据范围必须独立安全评审，本轮不进入实施。

### 10.1 范围

该阶段产品价值高，但数据权限和真实 Connector 风险大，放在 P2。首版只做：

- 只读数据连接。
- 数据集目录。
- 语义指标。
- 数据策略。
- Query Explain。
- Metric Query。
- Dataset Query Readonly。
- QueryRun / QueryResult。
- Data Agent 会话和报告。

不做：

- 自由 SQL。
- 生产数据库写。
- 多数据集 Join。
- 任意 MCP 授权。
- 让模型直接读取未授权行。

### 10.2 数据模型

```text
data_connections
datasets
dataset_columns
semantic_metrics
data_policies
query_runs
query_results
data_agent_conversations
data_agent_messages
data_agent_context_refs
data_agent_reports
```

每个 QueryRun 必须持久化：

- connection / dataset / metric version。
- query mode。
- requester principal。
- agent principal。
- row filter。
- column deny。
- maxRows。
- timeout。
- data cutoff。
- permission summary。
- scan/row count。
- result digest。

### 10.3 权限

```text
数据可见范围
  = Workspace/Project access
  ∩ Runtime Profile connection scope
  ∩ Dataset project scope
  ∩ Row policy
  ∩ Column policy
  ∩ Query limit
```

规则：

- Guest 默认拒绝。
- Runtime Profile 只能收窄连接范围。
- 模型不能声明 userId、projectId 或 row filter。
- 工具调用必须从 Run/Scene 反查 Data Agent conversation。
- 数据策略变化后下一次查询重新校验。
- QueryRun 不保存未脱敏的全量结果。

### 10.4 Data Agent Context

复用当前 Context Service：

- SOUL、模板版本和场景策略进入 mandatory system context。
- 当前对象只放 ID、版本、摘要、历史索引。
- 完整历史通过 `entity.read`、`task.runs`、`meeting.history` 等工具渐进读取。
- 普通对话和报告共用同一 ContextPack。
- 报告模式不能偷偷重新查询；需复用已存在的 QueryRun，除非用户明确重新查询。

### 10.5 M7 路线图门禁

- 无权限用户无法发现或查询数据集。
- 每次回答能追溯 QueryRun、指标版本、数据截止时间和权限摘要。
- 取消、超时和失败不会返回伪造结果。
- 真实 Connector 必须由其服务端 ACL 执行行/列过滤。

---

## 11. M8：Workbench V2 与 Resource Market（路线图）

> 当前只冻结“受信任静态构建产物、服务端布局、entitlement 不扩权”的边界。

### 11.1 迁移边界

当前平台已有固定 Workbench Dashboard 和 Brief。迁移目标不是复制 DSH typed slot，而是建立：

- 多 Workbench 实例。
- 服务端保存布局。
- 受信任 React 面板注册表。
- 面板 entitlement。
- 市场方案和功能插件资产。
- Skill / MCP / 工作台方案市场。

### 11.2 数据模型

```text
workbenches
workbench_versions
workbench_layouts
workbench_layout_versions
workbench_panels
workbench_panel_instances
market_assets
market_asset_versions
market_entitlements
market_templates
market_template_dependencies
```

关键约束：

- layout revision。
- 每个用户最多一个默认布局。
- 面板宽度 1/6 到 6/6。
- 不存在的 pluginId 显示降级占位。
- pluginId 版本兼容性检查。
- template copy / panel add 使用 Idempotency-Key。
- 删除 Workbench 不删除底层业务数据。

### 11.3 前端注册表

```ts
type WorkbenchPanelDefinition = {
  pluginId: string;
  version: string;
  title: string;
  load: () => Promise<React.ComponentType<PanelProps>>;
  compatibility: { minHostVersion: string; maxHostVersion?: string };
};
```

注册表只接受随平台构建的静态模块。市场安装只写 entitlement 和 panel instance，不加载远程代码。

### 11.4 市场治理

- official / verified / private 信任级。
- publisher Principal。
- asset version 和 digest。
- permissions 声明。
- compatibility。
- private/team visibility。
- 下架和归档。
- 安装不等于数据授权。
- MCP 连接需要独立凭据、SSRF 防护和 allowlist。
- Skill 安装与 Skill 绑定分离。

### 11.5 M8 路线图门禁

- 布局刷新、跨设备、跳转后保持。
- 权限撤销后模块不返回旧业务数据。
- 第三方代码不会动态执行。
- 市场安装幂等、可下架、可回滚。
- 未知/禁用面板不影响整页。

---

## 12. 数据模型与 Migration 计划

### 12.1 Migration 编号策略

当前工作区 33/34 尚未最终合入，后续 Migration 编号以合入时实际最大值为准。建议逻辑分组如下，不直接占用固定编号：

| 组 | 内容 |
| --- | --- |
| DB-M1a | 执行决策审计、Task acceptance item/confirmation、Task anomaly、task origins |
| DB-M1b | Tool invocation evidence、workspace tool audit |
| DB-M2 | Workflow scope、instance assignments、approvers、role presets |
| DB-M3 | Workflow plan source、router settings、router cycles、plan versions |
| DB-M4 | Skill definitions/versions/installations/bindings/run snapshots |
| DB-M5 | Task capture、group scene、context policy、context commit |
| DB-M6 | Report kind/period/skill/run、PM role preset |
| DB-M7 | Data Fabric、Data Agent、QueryRun |
| DB-M8 | Workbench V2、Market、entitlements |

每组必须独立 additive migration，不把多个高风险域塞入同一事务迁移。M4-M8 的 DB 分组只是路线图占位，未完成独立评审前不进入 Migration 排期。

### 12.2 迁移原则

所有主干 Migration 按以下顺序：

```text
expand
  -> backfill / validate
  -> enforce constraints
  -> enable feature
```

每个步骤都可独立观察和停止。不得在同一个发布窗口里既修改 Schema、回填大表又立即开启 enforce。

- 新列先 nullable 或带安全默认值。
- 新 enum 先兼容旧值。
- 新表不要求历史数据回填。
- 历史记录保持原语义。
- 运行中的 Instance/Run 不重写快照。
- 旧 API 响应保持字段兼容。
- 新字段默认关闭，由 Feature Flag 控制。
- 不可变表使用数据库 trigger 保护。
- 所有版本表唯一约束明确。
- 存量数据无法准确判断时记录冲突，不自动猜值。
- 新增唯一约束前先运行冲突预检；发现冲突时生成可审计清单，不自动删除或合并。
- 大表加列、回填和建索引必须明确锁范围、批大小、超时和执行窗口。
- N/N-1 应用兼容：新 Schema 下旧应用至少能启动并完成核心读取；旧应用不得写坏新增约束。
- Feature Flag 关闭必须停止新副作用，而不只是隐藏 UI。
- Group Scene 等唯一键升级先保留旧键，回填规范化字段，双读验证后再 enforce。

### 12.3 Task 状态兼容

不修改 `tasks_status_check` 为外部六状态集合。

当前状态与不可变历史按对象分层：

| 对象 | 当前状态 | 不可变历史 | 关键约束 |
| --- | --- | --- | --- |
| Instance assignment | 每个 instance/node 一条当前绑定 | Workflow Audit / binding snapshot | `UNIQUE(instance_id, node_id)` |
| Anomaly | `task_execution_anomalies` 中的 active 记录 | anomaly lifecycle event / Run Event | active `(task_id, run_id, code)` 唯一 |
| Acceptance item | 当前规范化的验收项及 revision | task acceptance revision history | `(task_id, position, revision)` 唯一；内容修改生成新 revision |
| Acceptance confirmation | 每项验收、每个有效 Run 的当前确认 | superseded confirmation 仍保留 | 当前确认唯一，旧确认只能 supersede |
| Router Plan | Plan 表保存 `currentVersion/status/revision` | Plan Version 表不可变 | `UNIQUE(plan_id, version)` |
| Materialization | 每个 Plan node 一条当前账本 | Plan audit / Outbox | `UNIQUE(plan_id, plan_version, node_id)` |

异常表建议：

```text
task_execution_anomalies
  id
  task_id
  run_id
  run_attempt
  code
  message
  status              active | cleared
  occurrence
  detected_at
  cleared_at
  cleared_reason
  revision
```

这样迁移风险显著低于修改 Task 核心状态枚举。

`executionHealth` 由 active anomaly、验收完整度和 Review 状态投影得到，不单独持久化为可随意修改的事实。恢复执行时只关闭当前 Run attempt 对应的活动异常。

### 12.4 Workflow 存量兼容

- 存量 Definition 默认 project scope。
- 存量 Instance 没有 bindings 时按旧 executor、roleSnapshot 和 runtime node 继续。
- 新 Instance 必须通过预检。
- 不从外部 DSH Workspace 导入 Definition。
- 历史 Workflow Audit 不改写。

### 12.5 典型约束冲突预检

| 变更 | 预检 | 冲突处理 |
| --- | --- | --- |
| Report 唯一键增加 `report_kind` | 检查 `project_id + kind + date + version` 是否重复 | 输出冲突 ID；人工决定保留或新版本，不删除历史 |
| Assignment 增加 `UNIQUE(instance_id,node_id)` | 检查旧数据是否一个节点多绑定 | 只保留明确当前绑定；其余写入历史冲突报告 |
| Acceptance item 规范化 | 检查同 task 内位置和内容重复 | 保留原顺序；重复内容仍生成独立 item |
| Group Scene Session 唯一键增加 participant binding | 对 `principal_scope IS NULL` 使用明确空值语义预检 | 先回填 `''` 或默认 binding，再建新唯一索引 |
| Plan materialization 唯一约束 | 检查同 plan/version/node 重复账本 | 保留有 Task 的账本；其余标记 conflict，不自动合并 |

### 12.6 不迁移的数据

- DSH JSON Storage 表。
- DSH Workspace、Session、Profile。
- 外部 Demo 订单数据。
- Data Agent 旧会话。
- Workbench localStorage。
- Router Plan 的 DSH 私有 ID。
- 外部 Skill ZIP 原始安装状态。

---

## 13. API 迁移面

### 13.1 保留现有 API

以下现有 API 不应被新 Router 或 Market API 取代：

- `/api/v1/tasks/*`
- `/api/v1/workflows/*`
- `/api/v1/workflow-instances/*`
- `/api/v1/meetings/*`
- `/api/v1/teammates/*`
- `/api/v1/runs/*`

新增 API 只补充契约和投影，不复制正式 Task/Workflow 动作。

### 13.2 建议新增或扩展

| 能力 | 建议 API |
| --- | --- |
| 模板作用域 | `GET/POST /api/v1/workflows/definitions/scope` |
| 实例预检 | `POST /api/v1/workflows/:workflowId/instances/preflight` |
| 实例绑定 | `PUT /api/v1/workflow-instances/:instanceId/bindings` |
| 角色预设 | `/api/v1/projects/:projectId/role-mapping-presets` |
| Router 设置 | `/api/v1/projects/:projectId/router-settings` |
| Router 候选 | `GET /api/v1/projects/:projectId/router-agents` |
| Plan Draft | `POST /api/v1/tasks/:taskId/plans/draft` |
| Plan 版本 | `GET/POST /api/v1/task-plans/:planId/versions` |
| Plan 确认 | `POST /api/v1/task-plans/:planId/approve` |
| Plan 物化 | `POST /api/v1/task-plans/:planId/materialize` |
| Task 证据 | `GET /api/v1/tasks/:id/acceptance-evidence` |
| Task 异常 | `GET /api/v1/tasks/:id/execution-health` |
| Task Capture | `/api/v1/task-capture/*` |
| Skills | `/api/v1/skills/*` |
| Teammate Skill | `/api/v1/teammates/:id/skills` |
| Context Policy | `/api/v1/context-policy`、`/reset` |
| Project Reports | 扩展现有 `/api/v1/projects/:projectId/reports` |
| Data Fabric | `/api/v1/data-fabric/*` |
| Data Agent | `/api/v1/data-agent/*` |
| Workbench V2 | `/api/v1/workbenches/*` |
| Market | `/api/v1/market/*` |

### 13.3 幂等与版本头

所有创建、物化、安装、复制和报告生成接口使用：

```http
Idempotency-Key: <stable-client-key>
If-Match: <revision-or-version>
X-Execution-Gate-Epoch: <current-project-gate-epoch>
```

服务端返回：

```json
{
  "ok": true,
  "data": {},
  "deduplicated": false,
  "revision": 4
}
```

`Idempotency-Key` 只用于客户端请求去重；服务端内部 Task 物化仍必须使用稳定 creationKey 和数据库唯一约束，不能把客户端 key 当作唯一防重机制。

---

## 14. 安全与治理

### 14.1 身份

- 只使用 Principal。
- 不接受客户端自报 actor。
- AI 不能登录。
- Browser 请求使用 Bearer Session。
- Worker 使用 Run/Attempt/Ticket 身份。

### 14.2 授权

- deny wins。
- Project ADMIN 不绕过 Project Grant。
- Platform ADMIN 不自动获得项目业务数据。
- Skill 安装不增加权限。
- Market entitlement 不增加项目权限。
- Meeting/Group 参与者不自动获得项目权限。
- Router 只推荐负责人，不能产生权限。
- 授权结论可以短时缓存，但必须使用明确纪元或组合摘要，并在副作用前复核。
- DispatchEligibility 与 Authorization 分开记录原因，不能用 Runtime 缺失掩盖授权拒绝。

### 14.3 高风险动作

- 文件写入、外部发送、审批和不可逆动作受 Tool Policy / Ticket / Gate。
- 缺少 Execution Envelope 默认拒绝。
- Kernel Runtime 不能阻断时必须拒绝，不能 observe-only 放行。
- Gate 拒绝后不得通过重试自动绕过。
- ActionDecision 必须绑定当次 action、resourceId、Run 和 Principal，不得跨请求复用。
- 预检后撤权、派发前角色变化和 Runtime 降级视为正常安全事件，必须留下审计而不是静默失败。

### 14.4 Prompt Injection

- 任务评论、会议录、Skill、数据指标说明都是数据，不是系统指令。
- Router 输入中的用户文本不能修改权限或系统策略。
- Data Agent 不能把数据集内容提升为工具授权。
- Skill 不能指示 Agent 上传未授权数据。

### 14.5 文件与网络

- 工作区路径沙箱。
- 符号链接拒绝。
- MCP URL allowlist 和 SSRF 防护。
- 下载大小和 MIME 校验。
- 数据 Connector 由服务端执行 ACL。
- 日志不记录 Prompt 全量、密钥或未脱敏数据。

---

## 15. 可观测性

### 15.1 必须新增的指标

- `execution_decision_denied_total{layer,reason}`
- `execution_decision_cache_stale_total`
- `workflow_assignment_unresolved_total`
- `workflow_instance_start_blocked_total`
- `workflow_claim_conflict_total`
- `router_cycle_total{status}`
- `router_plan_validation_failed_total{code}`
- `router_plan_materialize_dedup_total`
- `router_plan_materialize_recovery_total`
- `feature_gate_fenced_total{flag}`
- `task_anomaly_total{code}`
- `task_auto_submit_blocked_total{reason}`
- `task_evidence_shadow_diff_total`
- `context_commit_failed_total`
- `context_compaction_total`
- `skill_resolution_missing_total`
- `skill_install_total{trust_level}`
- `query_run_total{status}`
- `query_duration_ms`
- `query_rows_scanned`
- `market_install_dedup_total`

### 15.2 审计事件

```text
assignment.resolved
assignment.unresolved
assignment.remapped
assignment.member_added
node.claimed
node.claim_rejected
plan.created
plan.updated
plan.approved
plan.materialized
plan.reconciled
plan.finalized
task.anomaly.detected
task.anomaly.cleared
skills.bound
skills.unbound
context.policy.updated
context.committed
report.generated
query.executed
workbench.layout.saved
market.installed
```

每条事件至少包含 actor Principal、资源 ID、revision、结果和来源。

---

## 16. Feature Flag 与回滚

建议开关：

| Flag | 默认 | 范围 | 开启条件 | 关闭时运行时行为 |
| --- | --- | --- | --- | --- |
| `workflow.assignment_bindings` | off | Project | M1a + M2 退出门通过 | 拒绝新绑定实例；已启动旧实例继续 |
| `workflow.router_worker` | off | Project | M1a + M2 + M3 退出门通过 | 递增 Gate epoch，停止调度/派发/Router，Plan 转 `resume_required` |
| `task.evidence_review` | observe | Platform | 差异统计和负向门禁通过 | 回 observe，只观察不写确认；历史保留 |
| `task.anomaly` | off | Project | M1a 异常生命周期测试通过 | 隐藏异常投影，不删除异常和 Run Event |
| `skills.platform` | off | Platform | M4 独立立项 | 停止新绑定；已启动 Run 使用原 Skill Snapshot |
| `task.capture` | off | Project | M5 独立立项 | 隐藏入口；草稿只读保留 |
| `context.group_policy` | off | Platform | M5 独立立项 | 新 Pack 使用默认策略，历史 Pack 不变 |
| `project.ai_pm` | off | Project | M6 独立立项 | 停止创建新 PM；已有 PM 保留但不自动生成 |
| `data_fabric` | off | Workspace | M7 独立安全评审 | 拒绝新查询；保留 QueryRun 和报告 |
| `workbench.v2` | off | User/Project | M8 独立立项 | 回退固定 Dashboard，配置只读保留 |
| `market` | off | Platform | M8 独立立项 | 隐藏安装入口，不执行新 entitlement |

回滚原则：

- 不删表。
- 不删版本。
- 不重写历史。
- 不自动恢复暂停工作。
- 不将失败写入伪装成功。

### 16.1 关闭态 fencing

- Feature Gate 更新使用数据库 revision/epoch，不只依赖进程内变量。
- 关闭事务先递增 gate epoch，再写入关闭状态。
- 新命令在开始和产生副作用前各检查一次 gate epoch。
- Reconciler 领取计划时记录 epoch；执行前 epoch 变化则释放租约并安全停止。
- 已通过检查但尚未派发的节点不得“带病完成”，必须回到可重试的安全停点。
- 关闭后控制面仍可读取 Plan 和 Task 状态用于展示和审计。

### 16.2 observe 到 enforce 门槛

`task.evidence_review` 从 observe 切到 enforce 前，至少满足：

- 新旧判定差异已有稳定时间窗口和分母。
- 所有 required 验收项缺失、旧 Run 证据、acceptance revision 失效、失败 Tool 和 denied Gate 均被拦截。
- 现有 `autoSubmit` / `autoAccept` 任务行为差异已按项目完成清点。
- 授权允许但应拒绝的反例为 0。
- 回退 observe 不改写已有 Task、Run、confirmation 或 anomaly 历史。
- Feature Flag 开启与回退均完成演练。

---

## 17. 阶段退出门与测试矩阵

测试结果必须回答“该阶段是否允许开启对应 Feature Flag”，而不是只回答“测试数量是否增加”。

### 17.1 固定测试层级

| 层级 | 本轮主干必须覆盖 |
| --- | --- |
| Contract | Schema、状态枚举、错误码、兼容字段、事件负载 |
| PostgreSQL integration | 唯一约束、CAS、事务、租约、Migration、并发 |
| Application | 分层授权、幂等、Workflow 命令、关闭态、自动提交兼容 |
| Worker | 崩溃恢复、租约过期、消息重放、Gate fencing、停止新派发 |
| API / E2E | 关键用户路径、阻塞提示、状态投影、回滚 |
| Security negative | 越权、自批、路径穿越、跨项目读取、Gate 绕过 |

### 17.2 M1a 退出门

- Contract：Anomaly、acceptance item、acceptance confirmation、failure tool evidence。
- PostgreSQL：活动异常唯一；acceptance revision 修改使旧 confirmation 失效；历史不被覆盖。
- Application：分层 ExecutionDecision；Gate 不跨动作复用；所有 required 验收项必须确认。
- API：预检后撤权、派发前角色变化、Runtime 降级返回明确拒绝原因。
- Security：Agent 自批被拒绝；旧 Run/旧 acceptance revision 证据被拒绝。
- `task.evidence_review` observe 不改变 Task 状态和确认事实。

### 17.3 M1b 退出门

- Application：Task Tool 身份只能从 Run/Scene 反查。
- Worker：无 Execution Envelope 默认拒绝；Gate 拒绝不可绕过。
- Security：路径穿越、符号链接、绝对路径、超限文件、跨资源 Ticket 全部拒绝。
- Audit：工具调用包含路径摘要、结果和拒绝原因，不记录敏感正文。

### 17.4 M2 退出门

- Contract：workflow scope、role slot、portability、dispatch mode、preflight。
- PostgreSQL：assignment `UNIQUE(instance_id,node_id)`；角色预设 revision；平台模板可见范围。
- Application：读取平台模板、管理平台模板、在目标项目实例化三条授权路径分别测试。
- Concurrency：同一候选池并发 claim 只有一个成功。
- Security：非 owner project 成员可读但不可管理；目标项目无 `write` 不可实例化。

### 17.5 M3 退出门

- Contract：Plan Version、materialization ledger、Router Cycle、Feature Gate epoch。
- PostgreSQL：Plan version 唯一；materialization `UNIQUE(plan_id,plan_version,node_id)`；CAS 冲突可观察。
- Worker：同一 Plan 的并发 approve/materialize 不重复创建 Task；崩溃后可按 creationKey 恢复。
- Application：Outbox 消息按 message ID 幂等；关闭 Gate 后在副作用前 fence。
- API / E2E：人工、Router、模板三入口共享同一计划投影；重开不自动恢复。

### 17.6 P0 主干门禁场景

| 编号 | 场景 | 必须结果 |
| --- | --- | --- |
| G1 | 预检后、派发前撤销项目 Grant | 派发拒绝，记录明确拒绝原因 |
| G2 | 预检后 Runtime 能力降级 | 节点不派发，进入可解释安全停点 |
| G3 | 使用 A 资源 Ticket 执行 B 资源动作 | 拒绝，Gate 结论不可复用 |
| G4 | 多个 required 验收项仅一项有证据 | 不进入 Review，记录 missing evidence anomaly |
| G5 | 使用旧 Run 或旧 acceptance revision 的证据 | 拒绝，保留历史但不作为当前证据 |
| G6 | Agent 提交执行确认后批准自己的任务 | 最终批准拒绝并写审计 |
| G7 | `autoSubmit=true` 且无完整证据 | enforce 下停留 `in_progress` 并标记异常 |
| G8 | `autoAccept=true` 且证据未完成 | 不允许自动 Done |
| G9 | 同一 Plan 并发 approve/materialize | 每节点只创建一个 Task，账本只有一条 |
| G10 | Task 创建后、origin 写入前 Worker 崩溃 | 恢复后补齐 origin，不重复创建 Task |
| G11 | Plan active 时关闭 Router Feature Flag | 无新派发；在途命令被 fence；重开不自动执行 |
| G12 | 空库升级、33/34 快照升级、旧应用读取新 Schema | 均成功；唯一约束冲突在升级前可发现 |

### 17.7 Migration 退出门

每组 Migration 必须提供以下证据：

1. 空库从 1 升到最新版本成功。
2. 从当前 33/34 真实结构快照升级成功。
3. 旧应用在新 Schema 上启动并完成核心读操作。
4. 唯一约束冲突预检脚本在升级前可执行并输出稳定报告。
5. Feature Flag 关闭后旧链路恢复，已有数据不删除，未完成任务不自动恢复。
6. 大表回填有批次、耗时、锁等待和失败重试记录。
7. 回滚演练不会删除已写入的不可变历史。

### 17.8 后续路线

M4-M8 的 Contract、E2E 和负向用例不作为本轮主干门禁。进入对应阶段时，必须重新建立输入输出、错误码、数据模型和独立退出门。

---

## 18. 推荐交付拆分

### Phase A：契约冻结（仅文档和测试夹具）

- 固化外部基线提交、工作区差异摘要和样本输入输出。
- 冻结 `ADOPT / ADAPT / DEFER / NON_TARGET` 判定表。
- 冻结 M1-M3 的 Schema、错误码、状态迁移、幂等键和负向用例。
- 明确 anomaly 维度、Router Plan 承载和平台模板三条授权路径。
- 形成 M1-M3 的 API、数据库变更和冲突预检清单。
- M4-M8 只记录依赖和决策门，不冻结全部字段名和页面细节。

### Phase B1：M1a 执行判定

- 分层 ExecutionDecision。
- Task anomaly。
- Acceptance item / confirmation / evidence。
- `autoSubmit` / `autoAccept` 兼容。

### Phase B2：M1b 受控工具

- Agent Task Tools。
- Workspace tools。
- Tool Gate 与工作区路径沙箱。

### Phase C：M2 + M3

- Workflow scope。
- Role slot / assigned / claim。
- Instance preflight。
- Router Agent、Plan Version、Reconciler。

以下阶段仅为后续路线：

### Phase D：M4 + M5（待立项）

- Skill 体系。
- Task Capture。
- Group Scene / Context Policy。
- Meeting 多 AI。

### Phase E：M6 + M7（待独立评审）

- Project PM。
- Report type/Skill 版本。
- Data Fabric。
- Data Agent。

### Phase F：M8（待独立评审）

- Workbench V2。
- Resource Market。
- 治理和下线。

每一阶段都必须独立 Feature Flag、独立 Migration、独立回滚和独立验收，不以“外部已实现”为由跳过当前平台的门禁。

---

## 19. 风险与待确认事项

### 19.1 高风险

| 风险 | 影响 | 控制 |
| --- | --- | --- |
| 外部工作区未提交 | 契约可能变化 | 先冻结语义和测试，不按文件直接移植 |
| 修改 TaskStatus | 破坏现有队列/控制/Review | 使用 anomaly 维度 |
| Router 双存储 | 状态分叉、重复派发 | 复用 Workflow Plan Version 和 Task |
| 权限缓存过期 | 越权执行 | 授权纪元/短 TTL + 副作用前重新校验；Gate 不缓存 |
| 验收证据不完整 | 未完成工作进入 Review | 所有 required 项 + acceptance revision + 类型化证据 |
| Plan 部分物化 | 孤儿 Task 或重复 Task | 稳定 creationKey + 账本唯一约束 + 恢复流程 |
| 平台模板 owner 不清 | 无法下线追责 | 保留 ownerProjectId/publisher |
| Skill 被当作权限 | 提权 | Skill 只作指令，权限单独求交集 |
| QueryRun 信息不足 | 数据结论不可追溯 | 强制 Metric/Policy version 和 cutoff |
| 市场动态代码 | 供应链风险 | 只允许受信任构建产物 |
| Migration 冲突或锁表 | 升级失败/停机 | expand/backfill/enforce + 冲突预检 + 旧应用兼容验证 |
| 关闭 Flag 仍有在途副作用 | 关闭不彻底 | Gate epoch fencing + 副作用前复核 |

### 19.2 待产品确认

1. 平台模板发布是否必须平台管理员审批。
2. 项目角色映射预设由谁维护。
3. AI 是否允许未来进入 Claim 候选池。
4. Router Plan 是否长期保留在 Workflow Definition Version，还是后续拆 `execution_plans`。
5. 新建项目是否自动创建 PM Role 和 AI PM。
6. 异常任务是否需要独立筛选，还是只作为进行中卡片标签。
7. Group Scene 是否只用于 Meeting，还是覆盖其他多 Agent 对话。
8. Data Agent 首版是否只接 Fixture，生产 Connector 何时开放。
9. 官方 Skill 是否允许工作区覆盖版本范围。
10. Workbench 市场是否允许 Team 共享布局。
11. 是否保留 `autoAccept=true` 的自动通过例外；若保留，由哪个独立主体授权和审计。
12. 现有 acceptance 字符串是否允许在 M1a 后由普通任务更新触发增量规范化。

### 19.3 待工程确认

1. `workflow_definitions` 哪些 join 默认假设 project scope。
2. `workflow_instances.workflow_id` 是否在第一阶段继续保持 NOT NULL。
3. `task_origins` 如何回填既有 Meeting Task、Workflow Task 和人工 Task。
4. Context Session 唯一键升级是否需要在线回填和双读。
5. Workbench 面板 registry 的静态构建清单如何暴露给市场。
6. Data Fabric Connector 的凭据、ACL 和 SSRF 由哪个基础设施负责。
7. 当前未提交 Shared Space/Delegation Migration 的最终编号和发布顺序。
8. Feature Gate epoch 存储在 Platform、Project 还是独立的 runtime feature-gate 表。

---

## 20. 完成定义

本轮 M1a/M1b/M2/M3 进入实施并完成时，应满足：

1. 所有新增能力使用 Principal、Grant、Project Role 和 Ticket/Gate，不形成第二套权限事实。
2. Task 状态机保持兼容，异常、验收项 revision 和证据作为独立事实。
3. 模板可跨项目复用，但启动前必须完成实例绑定预检。
4. 所有 required 验收项均有当前有效证据；`autoSubmit` / `autoAccept` 不能绕过。
5. Router 动态计划和模板实例共享 Graph、Task、Run 和 Reconciler 语义。
6. Plan 物化有账本、唯一约束、CAS 和崩溃恢复。
7. 每个 Migration 完成空库、33/34 快照和旧应用兼容验证。
8. Feature Flag 关闭能 fence 新副作用，重开不自动恢复。
9. 关闭新能力后，已有 Task、Workflow、Meeting、Project 和 Run 仍可正常使用。
10. 当前项目不依赖 `dsh-pluginmax` 的 JSON Storage、DSH Slot 或运行时插件安装。

M4-M8 是后续路线。只有完成对应独立评审、数据模型、Migration、退出门和回滚设计后，才能纳入实施承诺。

---

## 21. 本次只读约束记录

本次工作只执行了以下内容：

- 阅读外部仓库提交、工作区 diff、设计文档、源码、测试和 README。
- 阅读当前项目 Contracts、Domain、Database、Application、API、Worker、Web 和既有迁移文档。
- 阅读测试专家评审意见，并按 P0/P1 反馈修订迁移方案。
- 梳理能力、冲突、依赖、迁移顺序、阶段退出门和回滚标准。
- 新增并修订本 Markdown 方案文件。

未执行：

- 修改任何业务代码。
- 修改任何 Migration 或数据库。
- 修改任何配置。
- 生成或改写测试。
- 安装依赖。
- 部署或启动服务。
- 修改外部 `dsh-pluginmax` 工作区。

最终实施必须另行评审和授权，不应把本方案视为自动实施指令。
