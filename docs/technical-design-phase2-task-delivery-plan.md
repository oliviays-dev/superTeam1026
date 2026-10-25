# 技术设计：阶段二 Task Delivery Plan 与动态 AI 团队

> 版本：v1.0  
> 日期：2026-10-25  
> 上游架构：[Agent 任务控制与动态 AI 团队总体架构](./technical-design-agent-task-control-overall.md)  
> 前置阶段：[阶段一 Runtime Agent Execution Plan 闭环](./technical-design-phase1-agent-execution-plan.md)  
> 产品依据：[任务管理作为 Agent Runtime 的超级遥控器](../../产品设计-任务管理作为Agent运行时超级遥控器.md)

## 0. 阶段目标

阶段二在阶段一稳定后新增任务级动态 AI 团队：

```text
Task
  → Lead Agent
  → Team Draft
  → Task Team
  → Task Delivery Plan
  → Work Item
  → AI Partner + Runtime
  → Agent Run / Agent Execution Plan
  → Collaboration / Handoff
  → Review
```

Lead Agent 负责：

- 任务拆解；
- 团队提议与动态搭建；
- Work Item 分工和依赖；
- 成员上下文协调；
- 过程交互、冲突和异常处理；
- 动态重排、成员替换和最终汇总。

平台负责：

- 团队、计划、Work Item、Run 的状态与合法性；
- Principal / Grant / Action Ticket；
- Runtime 和工具能力校验；
- 预算、并发、人工门禁和审计；
- 上下文隔离、Receipt 和 Handoff；
- 防止 Lead Agent 越权或团队失控。

## 1. 阶段边界

### 1.1 必须依赖的阶段一能力

- Task / Run / Review / Archive；
- Runtime Capability 与 Execution Envelope；
- Agent Execution Plan / Event / Gate / Snapshot；
- ContextPack / Receipt；
- Principal Action Ticket。

阶段二不复制这些能力。

### 1.2 阶段二新增对象

- Task Team；
- Team Draft；
- Team Membership；
- Task Delivery Plan；
- Plan Revision；
- Work Item；
- Work Item Run Binding；
- Lead Orchestration Cycle；
- Collaboration Event；
- Delivery Outbox。

### 1.3 非目标

- 不替代 Workflow 状态机；
- 不让 Lead Agent 任意创建 Principal 或登录账号；
- 不允许团队跨项目自动共享；
- 不把每次工具调用升级为 Work Item；
- Runtime 内生子 Agent 仍是 Work Item 内部执行细节，不自动成为 Task Team 成员；
- 不要求所有团队计划一次性完整生成；
- 不允许 Worker 直接修改 Task 主状态；
- 不实现永久自主扩张的 Agent 组织。

## 2. 插件拓扑

### 2.1 新增 `dsh-collab-delivery`

目录建议：

```text
plugins/dsh-collab-delivery/
  src/
    index.ts
    models.ts
    service.ts
    team-assembler.ts
    plan-service.ts
    work-item-service.ts
    lead-orchestrator.ts
    context-coordinator.ts
    interaction-service.ts
    run-bindings.ts
    reconciler.ts
    routes.ts
  client/index.js
  src/index.test.ts
  src/integration.test.ts
  cordis.patch.yml
  package.json
```

`dsh-collab-delivery` 是阶段二唯一新增的业务插件。

### 2.2 对存量插件的增量

| 插件                   | 增量                                                                                         |
| ---------------------- | -------------------------------------------------------------------------------------------- |
| `dsh-collab-agent`     | 通用 Run Source Handler；`delivery-lead` / `delivery-work-item` source；Runtime Catalog 投影 |
| `dsh-collab-task`      | 可选的 Delivery Summary 投影；Review 不变；不存储 Team                                       |
| `dsh-collab-teammate`  | Team Candidate 投影、Runtime Pool、容量/能力摘要                                             |
| `dsh-collab-context`   | 支持 `task-team` / `work-item` Scene Adapter；场景隔离不变                                   |
| `dsh-collab-memory`    | Work Item Handoff、Team 结论和来源引用                                                       |
| `dsh-collab-shell`     | 任务详情扩展 Slot、AI Team 全局入口、readiness 展示                                          |
| `dsh-collab-workbench` | 聚合待批准团队、计划、Work Item 异常和 Gate                                                  |
| `dsh-collab-workflow`  | 无硬依赖；Work Item 可引用 Workflow，但不复制其状态机                                        |
| `dsh-collab-meeting`   | 无硬依赖；任务简报和会议 Handoff 通过 Memory / Context                                       |
| `dsh-collab-project`   | 提供项目成员和 Workspace 边界；Delivery 不修改项目角色                                       |
| `dsh-collab-employee`  | 不新增能力                                                                                   |

### 2.3 依赖类型

完整激活必须至少有：

- `collabTeam`（身份和工作区成员）；
- `collabPrincipal`（授权主体）；
- `collabTeammates` / `collabTeammateRuntime`；
- `collabAgent` 与阶段一 Execution Control；
- `collabContext`；
- `collabTasks`。

可选增强：

- `collabMemory`：交接卡、当前真相；
- `collabAssignment`：项目角色席位候选；
- `collabMeeting`：会议引用；
- `collabWorkflow`：正式工作流引用。

## 3. 独立安装与降级模式

### 3.1 Delivery 模式

| 模式            | 条件                                           | 可用能力                                                     |
| --------------- | ---------------------------------------------- | ------------------------------------------------------------ |
| `full`          | Task + Agent + Teammate + Context + Identity   | 提案、审批、派发、动态重排完整闭环                           |
| `planning-only` | Task + Identity，缺 Agent / Teammate / Context | 手工创建 Team Draft / Plan / Work Item，可导出或等待依赖补齐 |
| `read-only`     | 只读权限或关键依赖不可用                       | 查看团队、计划和历史；不可派发                               |
| `blocked`       | Task / Identity 缺失                           | 只显示安装与授权诊断                                         |

插件对用户明确显示模式，不静默禁用按钮。

`planning-only` 可以保存 Team Draft、Plan Draft 以及嵌套在 Plan Revision 中的 Work Item 草案，但不能把 Team / Plan 置为 active，也不能派发 Run；依赖补齐后必须重新执行完整校验。

### 3.2 其他插件独立行为

- Task 不依赖 Delivery。
- Agent 不依赖 Delivery。
- Teammate 不依赖 Delivery。
- Context 不依赖 Delivery。
- Workflow 不依赖 Delivery。
- Memory 不是 Task/Agent 的硬依赖。

### 3.3 组合安装

建议提供：

```text
pluginmax-task-runtime.profile.yml
  shell + identity + roles + teammate + agent + context + task

pluginmax-ai-team.profile.yml
  task-runtime profile + delivery + memory
```

单个插件仍可 `dsh plugin add`。组合 profile 只负责完整安装和升级顺序。

## 4. 数据模型

### 4.1 TaskTeamRecordV1

```ts
interface TaskTeamRecordV1 {
  schemaVersion: 1;
  id: string;
  taskId: string;
  workspaceId: string;
  revision: number;
  status: "draft" | "active" | "paused" | "completed" | "archived";
  lead: TeamMemberV1;
  humanSponsorPrincipalId: string;
  members: TeamMemberV1[];
  constraints: TeamConstraintsV1;
  source: "lead-proposed" | "human-created" | "template";
  sourceRunId?: string;
  approvedByPrincipalId?: string;
  approvedAt?: string;
  createdAt: string;
  updatedAt: string;
}
```

### 4.2 TeamMemberV1

```ts
interface TeamMemberV1 {
  id: string;
  principalId: string;
  teammateId?: string;
  displayName: string;
  role: "lead" | "worker" | "reviewer" | "observer";
  status: "candidate" | "active" | "paused" | "left" | "failed";
  runtimePool: string[];
  requiredCapabilities: string[];
  workItemIds: string[];
  joinedAt?: string;
  leftAt?: string;
  replacementForMemberId?: string;
}
```

AI伙伴身份使用 `teammateId + principalId`。`principalId` 是授权主体；`teammateId` 是产品身份。

### 4.3 TeamConstraintsV1

```ts
interface TeamConstraintsV1 {
  maxMembers: number;
  maxConcurrentRuns: number;
  maxLeadCycles: number;
  maxTotalRuntimeMs: number;
  maxCost?: number;
  allowedRuntimeIds?: string[];
  forbiddenPrincipalIds?: string[];
  dataBoundary: "task" | "project";
  memberChangePolicy: "within-approved-pool" | "human-approval";
}
```

### 4.4 TeamMemberCandidateV1

```ts
interface TeamMemberCandidateV1 {
  id: string;
  role: "lead" | "worker" | "reviewer" | "observer";
  candidate:
    | {
        kind: "existing";
        principalId: string;
        teammateId?: string;
      }
    | {
        kind: "template";
        templateId: string;
        proposedOwnerPrincipalId: string;
        instanceName: string;
      };
  runtimePool: string[];
  requiredCapabilities: string[];
  reason: string;
}
```

模板候选必须来自已批准的平台/个人 AI伙伴模板。Lead Agent 只能提议模板和实例名；平台在批准阶段调用 Teammate 服务校验owner、配额、版本和 Runtime，再实例化 AI Principal / Companion。Lead 不能直接创建 Principal、编写 SOUL 或生成凭据。

Team 的 `lead` 必须指向已经存在且 active 的 AI伙伴，不能使用 `kind: template`；模板候选只允许用于 Worker 或 Reviewer，避免“尚未实例化的 Lead 自己先运行并组织团队”的循环。

### 4.5 TeamDraftRecordV1

```ts
interface TeamDraftRecordV1 {
  schemaVersion: 1;
  id: string;
  taskId: string;
  workspaceId: string;
  revision: number;
  status: "pending" | "approved" | "rejected" | "superseded";
  proposedByRunId?: string;
  rationale: string;
  lead: TeamMemberCandidateV1;
  members: TeamMemberCandidateV1[];
  constraints: TeamConstraintsV1;
  validation: TeamValidationResult;
  createdAt: string;
  decidedAt?: string;
  decidedByPrincipalId?: string;
}
```

### 4.6 TeamValidationResultV1

```ts
interface TeamValidationResult {
  ok: boolean;
  hardFailures: TeamValidationIssue[];
  softWarnings: TeamValidationIssue[];
  missingCapabilities: CapabilityGap[];
  alternativeCandidates: CandidateProjection[];
  estimatedBudget?: {
    members: number;
    parallelRuns: number;
    estimatedCost?: number;
  };
}
```

### 4.7 TaskDeliveryPlanHeadV1 与 TaskDeliveryPlanVersionV1

```ts
interface TaskDeliveryPlanHeadV1 {
  schemaVersion: 1;
  id: string;
  taskId: string;
  teamId?: string;
  teamDraftId?: string;
  currentRevision: number;
  status:
    | "draft"
    | "pending-approval"
    | "approved"
    | "active"
    | "superseded"
    | "completed"
    | "cancelled";
  updatedAt: string;
}
```

```ts
interface TaskDeliveryPlanVersionV1 {
  schemaVersion: 1;
  id: string;
  headId: string;
  taskId: string;
  teamId?: string;
  teamDraftId?: string;
  teamRevision?: number;
  revision: number;
  status:
    | "draft"
    | "pending-approval"
    | "approved"
    | "active"
    | "superseded"
    | "completed"
    | "cancelled";
  objective: string;
  assumptions: string[];
  constraints: string[];
  workItems: WorkItemProjection[];
  source: "lead" | "human" | "template";
  plannedByLeadRunId?: string;
  approvedByPrincipalId?: string;
  approvedAt?: string;
  createdAt: string;
}
```

`plans` 表保存 Head；`plan_versions` 保存不可变 Revision。界面通过 Head 定位 currentRevision，再读取对应 Version，不从可变 Work Item 状态反推历史计划。

### 4.8 WorkItemRecordV1

`WorkItemRecord` 只在该 Work Item 随已批准 Plan 一起激活时物化。Team / Plan 尚处 draft 时，Work Item 只作为 Plan Revision 内的嵌套草案存在，不产生独立运行记录。

```ts
interface WorkItemRecordV1 {
  schemaVersion: 1;
  id: string;
  taskId: string;
  teamId: string;
  planId: string;
  planRevision: number;
  parentWorkItemId?: string;
  materializedTaskId?: string;
  title: string;
  objective: string;
  status:
    | "proposed"
    | "approved"
    | "blocked"
    | "ready"
    | "dispatching"
    | "running"
    | "submitted"
    | "accepted"
    | "failed"
    | "cancelled";
  owner: {
    principalId: string;
    teammateId?: string;
    runtimePool: string[];
  };
  dependencyIds: string[];
  inputRefs: SourceRef[];
  expectedOutput: string;
  acceptance: string[];
  acceptanceMode: "rule" | "lead" | "reviewer" | "human";
  policy: WorkItemPolicyV1;
  currentRunId?: string;
  runIds: string[];
  latestHandoffId?: string;
  dueAt?: string;
  attempt: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
}
```

### 4.9 WorkItemPolicyV1

Work Item 只能收窄 Task 策略：

```ts
interface WorkItemPolicyV1 {
  sourcePolicy: Partial<TaskExecutionPolicyV1["sourcePolicy"]>;
  toolPolicy: Partial<TaskExecutionPolicyV1["toolPolicy"]>;
  requiredCapabilities: RuntimeRequirement[];
  humanGates: ExecutionGateRule[];
  maxRuntimeMs?: number;
  maxToolCalls?: number;
}
```

Policy 合并算法：

| 字段                            | 合并方式                                      |
| ------------------------------- | --------------------------------------------- |
| `sourcePolicy.allow`            | Task allow ∩ Team constraint ∩ WorkItem allow |
| `sourcePolicy.deny`             | Task deny ∪ Team deny ∪ WorkItem deny         |
| `toolPolicy.allow`              | Runtime ∩ Profile ∩ Task ∩ WorkItem           |
| `toolPolicy.deny`               | 并集，deny wins                               |
| `toolPolicy.requireApproval`    | 并集                                          |
| `humanGates`                    | 并集                                          |
| `runtimePool`                   | 交集                                          |
| `maxRuntimeMs` / `maxToolCalls` | 取更小值                                      |

任何 Work Item 配置只能收窄父级策略。

### 4.10 WorkItemRunBindingV1

```ts
interface WorkItemRunBindingV1 {
  schemaVersion: 1;
  id: string;
  workItemId: string;
  runId: string;
  dispatchKey: string;
  teammateId?: string;
  principalId: string;
  runtimeId: string;
  status: "dispatching" | "bound" | "settled" | "failed";
  createdAt: string;
  updatedAt: string;
}
```

### 4.11 LeadOrchestrationCycleV1

```ts
interface LeadOrchestrationCycleV1 {
  schemaVersion: 1;
  id: string;
  teamId: string;
  trigger:
    | "team-activation"
    | "plan-request"
    | "work-item-settled"
    | "blocker"
    | "user-message"
    | "reconcile";
  leadRunId?: string;
  status: "queued" | "running" | "waiting" | "completed" | "failed";
  startedAt: string;
  endedAt?: string;
  budgetUsed: {
    cycles: number;
    runtimeMs: number;
    cost?: number;
  };
  error?: string;
}
```

同一 Team 默认只允许一个 active Lead Cycle。

### 4.12 CollaborationEventV1

```ts
interface CollaborationEventV1 {
  schemaVersion: 1;
  id: string;
  teamId: string;
  workItemId?: string;
  seq: number;
  kind:
    | "member-proposed"
    | "member-joined"
    | "member-left"
    | "work-item-assigned"
    | "work-item-started"
    | "work-item-blocked"
    | "work-item-submitted"
    | "work-item-failed"
    | "question"
    | "answer"
    | "handoff"
    | "conflict"
    | "decision-requested"
    | "decision-made"
    | "replan-requested"
    | "replan-applied"
    | "lead-summary";
  fromPrincipalId?: string;
  toPrincipalId?: string;
  runId?: string;
  summary: string;
  data?: Record<string, unknown>;
  createdAt: string;
}
```

聊天正文不能直接改变状态；只有对应 command service 能改变 Team/Plan/WorkItem。

## 5. Storage Domain

```yaml
name: collab_delivery
version: 1
tables: teams
  team_versions
  team_drafts
  plans
  plan_versions
  work_items
  work_item_runs
  lead_cycles
  events
  outbox
```

设计：

- `teams` 保存当前 Team 指针与状态；
- `team_versions` 保存每个 roster revision；
- `plans` 保存当前 Delivery Plan 指针；
- `plan_versions` 保存不可变计划快照；
- `work_items` 保存当前状态；
- `work_item_runs` 保存 Work Item ↔ Run 绑定；
- `events` Append-only；
- `outbox` 保存待发布事件。

`collab_delivery` 是全新 domain，不影响 `collab_task` / `collab_agent` 的 single-layout version。

## 6. 对外服务

### 6.1 `ctx.collabDelivery`

```ts
interface DeliveryService {
  bootstrap(input: {
    workspaceId: string;
    taskId?: string;
  }): Promise<DeliveryBootstrapProjection>;

  proposeTeam(input: {
    taskId: string;
    leadPrincipalId: string;
    constraints: TeamConstraintsV1;
    candidateHints?: string[];
  }): Promise<TeamDraftProjection>;

  validateTeamDraft(input: { draftId: string }): Promise<TeamValidationResult>;

  approveTeam(input: {
    draftId: string;
    actorPrincipalId: string;
  }): Promise<TaskTeamProjection>;

  requestPlan(input: {
    teamId: string;
    trigger: "team-activation" | "user-request" | "replan";
  }): Promise<DeliveryPlanProjection>;

  approvePlan(input: {
    planId: string;
    revision: number;
    actorPrincipalId: string;
  }): Promise<DeliveryPlanProjection>;

  listWorkItems(input: { teamId: string }): readonly WorkItemProjection[];

  dispatchReadyWorkItems(input: {
    teamId: string;
    actorPrincipalId?: string;
  }): Promise<DispatchCycleResult>;

  updateTeam(input: {
    teamId: string;
    command: TeamChangeCommand;
    actorPrincipalId: string;
  }): Promise<TaskTeamProjection>;

  requestReplan(input: {
    teamId: string;
    reason: string;
    actorPrincipalId?: string;
  }): Promise<void>;

  events(input: {
    teamId: string;
    afterSeq?: number;
    limit?: number;
  }): readonly CollaborationEvent[];
}
```

### 6.2 `ctx.collabTeammateCandidates`

在 Teammate 插件中增加新服务，不改现有 `assignable()` 契约：

```ts
interface TeammateCandidateProjection {
  teammateId: string;
  principalId: string;
  name: string;
  source: "personal" | "platform";
  ownerPrincipalId?: string;
  status: "active" | "paused" | "archived";
  role: string;
  capabilities: string[];
  runtimePool: string[];
  allowedToolCategories: string[];
}

interface TeammateCandidateService {
  candidates(input: {
    workspaceId: string;
    actorPrincipalId: string;
    requiredCapabilities?: string[];
    runtimeIds?: string[];
  }): readonly TeammateCandidateProjection[];
}
```

能力摘要来自 AI伙伴定义、模板和 Runtime 绑定，不读取 SOUL 全文。`currentWorkItemCount`、历史成功率和当前 Team 负载由 Delivery 用自己的 domain 与 Agent Run 投影补充，不能让 Teammate 反向依赖 Delivery。

模板实例化通过独立 trusted port 完成：

```ts
interface TeammateProvisioningPort {
  previewInstance(input: {
    templateId: string;
    workspaceId: string;
    proposedOwnerPrincipalId: string;
    instanceName: string;
  }): Promise<{
    valid: boolean;
    templateVersion?: string;
    estimatedRuntimePool?: string[];
    issues: string[];
  }>;

  instantiateForTeam(input: {
    templateId: string;
    workspaceId: string;
    proposedOwnerPrincipalId: string;
    instanceName: string;
    idempotencyKey: string;
  }): Promise<{
    teammateId: string;
    principalId: string;
    runtimePool: string[];
    compensationToken: string;
  }>;

  compensateInstantiation(input: { compensationToken: string }): Promise<void>;
}
```

该端口只允许 Delivery 的可信服务路径调用，不暴露给浏览器或普通 Agent Tool。

### 6.3 Agent 通用 Run Source

当前 `bindTask()` / `bindWorkflow()` 只支持固定 source。阶段二新增：

```ts
interface AgentRunSourceHandler {
  onSettled(run: AgentRun): Promise<void> | void;
}

interface AgentRegistryService {
  bindRunSource(source: AgentRunSource, handler: AgentRunSourceHandler): void;
}
```

`bindRunSource` 必须复用现有 `bindTask` / `bindWorkflow` 的重放语义：注册 handler 时扫描该 source 下 `settleDelivered=false` 的终态 Run 并补投。Delivery handler 必须按 `runId` 幂等。

阶段二的 source：

```ts
type AgentRunSource =
  | "workflow"
  | "task"
  | "meeting"
  | "chat"
  | "delivery-lead"
  | "delivery-work-item";
```

Task / Workflow 继续使用兼容包装，不改变现有行为。

## 7. Team 动态组装

### 7.1 输入

- Task Contract；
- 用户预算、数据边界和人员偏好；
- Lead Agent 选择；
- Teammate Candidate 投影；
- Runtime Catalog；
- Principal Grants；
- 当前 Work Item 负载；
- 历史 Run 成功率和成本；
- 项目角色 / 席位；
- 用户显式指定成员。

### 7.2 硬过滤

候选必须：

- AI Principal / Companion active；
- 有当前项目访问权；
- Runtime Pool 至少一个 active；
- 满足 Task 必需能力；
- 工具类别与 Task / WorkItem Policy 兼容；
- 不跨项目或跨数据边界；
- 未超过用户黑名单。

### 7.3 软评分

建议默认权重：

| 因素               | 权重 |
| ------------------ | ---- |
| 专业能力匹配       | 35%  |
| 历史验收通过率     | 20%  |
| Runtime / 工具适配 | 15%  |
| 当前工作负载       | 10%  |
| 成本 / 时延        | 10%  |
| 任务连续性         | 10%  |

权重可配置；首期以可解释排序为主，不做不可解释的黑盒自动招募。

### 7.4 Team Draft

Lead Agent 或用户提交：

```ts
interface TeamDraftCommand {
  taskId: string;
  rationale: string;
  lead: TeamMemberCandidateV1;
  members: TeamMemberCandidateV1[];
  constraints: TeamConstraintsV1;
}
```

Delivery Service：

1. schema 校验；
2. 检查 Lead 身份；
3. 检查成员和 Runtime；
4. 检查预算；
5. 对模板候选生成实例化预览，不在 draft 阶段创建 Principal；
6. 生成 TeamValidationResult；
7. 保存 draft；
8. 按风险决定自动批准或等待人工。

### 7.5 Team Version

激活时：

- 预生成 `teamId`；
- 对模板候选调用 Teammate 服务完成实例化或返回可补偿的创建结果；
- 用实例化后的 Principal / Runtime 重新校验完整 roster；
- 校验通过后写入 `TaskTeamRecord` 和不可变 `team_versions`；
- 若持久化失败，补偿归档本次仅用于该 Draft 的模板实例；
- 生成 `member-joined` 事件；
- 建立 Lead Session；
- 启动第一个 Lead Orchestration Cycle。

## 8. Lead Agent 运行模型

### 8.1 Lead 身份

- 必须是 active AI Principal；
- 必须绑定 active AI Companion；
- 必须有一个可用 Runtime；
- 必须通过 Task Team Lead 角色校验；
- 不能是人类或匿名 Profile。

### 8.2 Lead Session

Session Binding：

```text
scene: task-team
objectId: teamId
agentPrincipalId: lead.principalId
sessionId: de-team-<teamId>-<leadPrincipalId>
```

同一 Team 的 Lead 多轮协调复用该 Session。团队更换 Lead 时生成新 Session generation。

### 8.3 Orchestration Cycle

触发：

- 团队激活；
- 用户要求计划；
- Work Item settled/failed；
- Worker blocker；
- 收到 Gate 决策；
- 定时对账发现异常；
- 用户消息。

规则：

- 同一 Team 同时最多 1 个 active Lead Cycle；
- 同一触发批次去重；
- Lead 无动作时可结束 cycle；
- 超预算必须升级给人类。

### 8.4 Lead 上下文

Lead 获取：

- Task Contract；
- Team Roster；
- 当前 Delivery Plan；
- Work Item 摘要、状态、依赖；
- 关键 Handoff、决策、风险和冲突；
- 预算和运行摘要；
- 成员能力与 Runtime 缺口。

Lead 不获取：

- Worker 完整私有 Session；
- Worker 私有记忆全文；
- 跨项目上下文；
- 未授权文件。

### 8.5 Lead Control Tools

Delivery 插件注册带输出契约的工具：

```text
delivery_submit_team_draft
delivery_submit_plan
delivery_request_member_change
delivery_update_work_items
delivery_dispatch_work_item
delivery_request_context
delivery_accept_work_item
delivery_report_blocker
delivery_resolve_conflict
delivery_submit_summary
```

每个工具执行前校验：

- 当前 Agent Session 是否为该 Team 的当前 Lead；
- Team 是否 active；
- 当前 Cycle 是否未超预算；
- 请求是否只修改当前 Team；
- 成员/Work Item 是否在允许范围；
- Policy 是否只能收窄。

工具注册安全要求：

- Lead Profile 的 `allowedTools` 必须显式包含对应 Delivery Tool；Team 激活前校验，否则不能成为 Lead。
- Worker / Reviewer 的 Tool Filter 默认不包含 Delivery 控制工具。
- 如果当前 DSH 版本只能全局注册工具 schema，handler 必须对非当前 Team Lead 一律 fail closed，不能依赖前端隐藏。
- Tool 名称、输入 schema 和输出契约由 Delivery 插件拥有，Agent / Task 插件不硬编码。

Lead 不能通过工具：

- 创建 Principal / Account；
- 修改 Task acceptance 或项目范围；
- 直接通过 Task Review；
- 跨项目读取或招募；
- 绕过 Gate；
- 修改 Runtime 定义。

### 8.6 Lead Run 结束语义

Lead Run 成功：

- 要么提交计划/变更；
- 要么给出“当前无需动作”的结构化结论；
- 不自动等于 Team 完成。

Lead Run 失败：

- 当前 Cycle failed；
- Team 进入 waiting-human；
- 用户可以重试、换 Runtime 或改派 Lead。

## 9. Task Delivery Plan

### 9.1 计划状态机

```text
draft
  → pending-approval
  → approved
  → active
  → completed

draft / pending-approval → superseded
active → cancelled（仅任务取消）
```

### 9.2 滚动计划

- 首版只要求前 1-2 波 Work Item 明确；
- 后续 Work Item 可标记 `proposed`；
- Lead 在前置结果明确后补齐 owner、acceptance、policy；
- 未 approved 的 Work Item 不得派发。

### 9.3 计划 Diff

新 revision 必须包含：

```ts
interface DeliveryPlanDiff {
  addedWorkItemIds: string[];
  removedWorkItemIds: string[];
  changedWorkItemIds: string[];
  dependencyChanges: Array<{
    workItemId: string;
    before: string[];
    after: string[];
  }>;
  ownerChanges: Array<{
    workItemId: string;
    beforePrincipalId: string;
    afterPrincipalId: string;
  }>;
}
```

已有 `accepted` Work Item 不因新 revision 自动重跑。

### 9.4 计划激活

激活前校验：

- Team active；
- Plan approved；
- 所有 active Work Item owner 仍在 Team；
- 依赖无环；
- 每个 Work Item policy 不宽于 Task；
- 至少一个 ready Work Item 或有效阻塞原因。

Team 只有在所有 required Work Item accepted 且 Lead 提交汇总后才能转 `completed`。此时 Task 只进入 Review，不自动完成。

## 10. Work Item 执行

### 10.1 状态机

```text
proposed
  → approved
  → blocked / ready
  → dispatching
  → running
  → submitted
  → accepted

running → failed
approved / blocked / ready / failed → cancelled
```

`accepted` 是 Work Item 级验收，不等于 Task 完成。

### 10.2 Ready 判断

Work Item ready 当：

- 自身 approved；
- 所有依赖 Work Item accepted；
- owner active；
- Runtime Pool 至少一个可用；
- Task / Team 未暂停；
- 没有未决 blocking Gate；
- 未超预算。

### 10.3 执行策略

```ts
type WorkItemExecutionMode =
  "platform-auto" | "lead-authorize" | "human-approve";
```

- `platform-auto`：ready 后自动派发；
- `lead-authorize`：Lead 明确 dispatch；
- `human-approve`：等待用户。

默认：

- 低风险 Work Item `platform-auto`；
- 中风险 `lead-authorize`；
- 高风险或不可逆 `human-approve`。

### 10.4 派发步骤

1. Work Item 转 `dispatching`，写 `dispatchKey`；
2. 选择 Runtime；
3. 构建 Work Item Context；
4. 申请 Action Ticket；
5. 调用 `collabAgent.dispatch()`；
6. 保存 WorkItemRunBinding；
7. Work Item 转 `running`；
8. 启动 reconciler 看护超时。

`dispatchKey`：

```text
delivery:<workspaceId>:<teamId>:<workItemId>:<planRevision>:<attempt>
```

### 10.5 Run Settled

Delivery 插件在加载时通过 `collabAgent.bindRunSource("delivery-work-item", handler)` 注册回调。Agent 插件在 Run settled 时调用已注册 handler，方向始终是 Agent → handler，不让 Agent import Delivery：

1. 根据 runId 找到 binding；
2. active Run 更新 running；
3. `succeeded` → Work Item `submitted`；
4. `waiting_input` → Work Item `blocked`；
5. failed/timeout/cancelled/interrupted → Work Item `failed` 或可重试；
6. 写 CollaborationEvent；
7. 触发 Lead Cycle；
8. 不直接改 Task 状态。

Work Item `submitted` 后按 `acceptanceMode` 处理：

- `rule`：交付物和证据检查通过后自动 accepted；
- `lead`：Lead 通过结构化工具确认；
- `reviewer`：指定 Reviewer 给出结论；
- `human`：等待用户。

Reviewer 不得同时是该 Work Item 的 owner；高风险 Work Item 必须使用独立 Reviewer 或 human acceptance。

任何 acceptance mode 都不改变 Task Review；它只决定 Work Item 是否可供后续依赖使用。

### 10.6 Work Item 升级为子 Task

默认不创建子 Task。

只有以下情况物化：

- 需要进入其他团队或任务队列；
- 需要独立的人类验收；
- 需要长期跨会话跟踪；
- 需要与当前 Team 生命周期解耦。

物化时：

- 保存 `materializedTaskId`；
- 原 Work Item 保留；
- 子 Task 完成后回写 Work Item；
- 父 Task 仍需最终验收。

## 11. 上下文协调

### 11.1 新 Scene

`collab_context` 增加：

```ts
type SceneType =
  | "project"
  | "task"
  | "meeting"
  | "chat"
  | "workflow-node"
  | "task-team"
  | "work-item";
```

Delivery 插件注册对应 Adapter。

### 11.2 Team Adapter

`resolve()`：

- Lead / 成员是否属于 Team；
- Team 是否 active；
- Task 是否同 Workspace。

`loadFacts()`：

- Task Contract；
- Team Roster；
- Delivery Plan；
- Work Item 状态摘要；
- 当前风险、冲突和待决事项；
- Handoff IDs。

`policy()`：

- Team 只能读取当前项目；
- Lead 可以读取全 Team 摘要；
- Worker 只能读取自身 Work Item 和明确共享的依赖产出。

### 11.3 Work Item Adapter

Worker 获取：

- Task objective / non-goals / acceptance；
- 自身 Work Item；
- 依赖 Work Item 的 Handoff / accepted output；
- 相关项目当前真相；
- Task / WorkItem Policy；
- 可写回证据范围。

Worker 不获取：

- 其他 Worker 完整 transcript；
- Lead 私有 Session；
- 无关任务；
- 其他项目。

### 11.4 Handoff

优先使用 `dsh-collab-memory` HandoffCard：

- 一段结论；
- 当前真相；
- 产出引用；
- 未决问题；
- 风险；
- source refs。

Memory 缺失时：

- Delivery 在 `CollaborationEvent(kind=handoff)` 保存最小交接摘要；
- 不复制完整上下文；
- UI 提示“结构化交接历史可用，项目记忆不可用”。

### 11.5 Receipt

每个 Lead / Worker Run 都记录 ContextReceipt。用户可查看：

- 使用了哪些来源；
- 排除了哪些；
- 继承了哪些 Handoff；
- 上下文是否截断；
- 该成员实际可见范围。

## 12. 交互控制

### 12.1 结构化交互

Lead / Worker 交互通过 `CollaborationService`：

```ts
interface CollaborationCommand {
  id: string;
  teamId: string;
  workItemId?: string;
  kind:
    | "assign"
    | "question"
    | "answer"
    | "handoff"
    | "blocker"
    | "conflict"
    | "decision-request"
    | "rework"
    | "cancel";
  fromPrincipalId: string;
  toPrincipalId?: string;
  summary: string;
  payload: Record<string, unknown>;
}
```

### 12.2 状态权限

只有：

- Delivery Service；
- 具备 Team/WorkItem 权限的人类；
- 当前 Lead 的结构化控制工具；

可以改变 Work Item 状态。

普通消息、会议聊天或评论只能形成讨论或 Decision Request，不能直接改状态。

### 12.3 冲突处理

Lead 可以：

- 要求双方补充证据；
- 指定 Reviewer；
- 将冲突升级给人类；
- 创建一个仲裁 Work Item；
- 标记 Plan revision。

平台记录冲突和决策，不把“聊天里说了算”当权威。

## 13. 动态成员与重排

### 13.1 成员变更

```ts
type TeamChangeCommand =
  | { type: "add"; member: TeamMemberDraft; reason: string }
  | { type: "remove"; memberId: string; reason: string }
  | {
      type: "replace";
      memberId: string;
      member: TeamMemberDraft;
      reason: string;
    }
  | { type: "pause"; memberId: string; reason: string }
  | { type: "resume"; memberId: string; reason: string };
```

### 13.2 自动权限

Lead 可以在预批准成员池、预算和权限范围内：

- 暂停/恢复成员；
- 替换同能力 Worker；
- 调整未开始 Work Item 的 owner。

必须用户确认：

- 更换 Lead；
- 引入新的数据域或工具；
- 增加预算 / 并发；
- 引入项目外成员；
- 改变 Task acceptance。

### 13.3 Team Version

每次变更：

- revision + 1；
- 写 Team Version 快照；
- 写 CollaborationEvent；
- 传输 Handoff；
- 旧成员历史保留；
- 不自动删除其已提交证据。

## 14. Agent / Task / Context 集成

### 14.1 Agent

- 新增 source 与 generic settlement handler；
- 复用阶段一 ContextPack → Run → Plan / Event / Gate；
- Work Item Run 的 `payload.context` 增加 `teamId`、`workItemId`、`planRevision`；
- Agent Execution Plan 仍属于每个 Run。

### 14.2 Task

- Task 不保存 Team/Plan/WorkItem；
- Task Execution View 可通过可选 `collabDelivery` 投影聚合 Delivery Summary，不得 import Delivery 源码；
- Team 激活成功后，Delivery 通过 Task 服务把当前负责人显式切到 Lead Agent，并写任务事件与 Lead Principal 引用；
- Team 执行期间当前负责人为 Lead Agent；Worker 只是 Task Team 成员，不成为 Task 负责人；
- 进入 Review 时沿用 Task 现有 `reviewSubmitter` 快照，把当前负责人切到人类验收人；
- 退回后恢复实际提交 Review 的执行负责人（通常是 Lead Agent）；
- 更换 Lead 必须先更新 Task Team，再通过 Task 服务同步负责人，不能只改 Delivery 数据；
- Task 时间线只写团队级关键事件、Gate、阻塞和 Lead 汇总摘要；Worker 的逐步事件留在 Delivery / Run 详情，避免任务时间线被多 Agent 日志淹没；
- Task 完成仍以交付物、验收和 Review 为准。

### 14.3 Context

- Delivery 只注册 Adapter；
- Context 插件不 import Delivery 类型；
- Scene Adapter 通过 contracts DTO 交互；
- Team 上下文策略仍遵循场景隔离和 Receipt。

### 14.4 Memory

- Work Item 产出的 accepted Handoff 可进入项目记忆；
- Worker 私有过程仍写 Agent Episode；
- 任务 Review 通过后才进入项目共享产出；
- Memory Review 状态不阻塞阶段二基本运行，但会降低当前真相质量。

## 15. APIs

### 15.1 Browser

```text
GET  /api/collab/delivery/bootstrap?workspaceId=...
GET  /api/collab/delivery/teams?taskId=...
POST /api/collab/delivery/team/propose
POST /api/collab/delivery/team/validate
POST /api/collab/delivery/team/approve
POST /api/collab/delivery/team/change
POST /api/collab/delivery/team/pause
POST /api/collab/delivery/team/archive

GET  /api/collab/delivery/plans?teamId=...
POST /api/collab/delivery/plan/request
POST /api/collab/delivery/plan/approve
POST /api/collab/delivery/plan/replan

GET  /api/collab/delivery/work-items?teamId=...
POST /api/collab/delivery/work-item/dispatch
POST /api/collab/delivery/work-item/cancel
POST /api/collab/delivery/work-item/retry
GET  /api/collab/delivery/events?teamId=...&afterSeq=...
```

所有写路由：

- same-origin；
- Bearer；
- workspace member；
- 具体权限根据 TaskTeam / Task / Principal 校验。

### 15.2 Agent Tools

见 §8.5。所有 Tool 必须：

- 声明 Zod input/output；
- 获取调用 Agent 的 Session / Principal；
- 从 Session 反查绑定 Team；
- 不接受客户端自报 actor；
- 限制输出大小；
- 返回结构化错误。

### 15.3 Domain Events

```text
delivery.team.draft-created.v1
delivery.team.activated.v1
delivery.team.changed.v1
delivery.plan.created.v1
delivery.plan.activated.v1
delivery.plan.replanned.v1
delivery.work-item.changed.v1
delivery.work-item.run-bound.v1
delivery.work-item.settled.v1
delivery.interaction.appended.v1
delivery.lead-cycle.started.v1
delivery.lead-cycle.settled.v1
```

## 16. UI

### 16.1 全局 AI 团队页

路由建议：`delivery` 或 `ai-team`。

页面：

- 当前 Team；
- 团队状态；
- Lead；
- Work Item 看板；
- 计划 revision；
- 成员负载；
- 预算；
- 待人工处理；
- 交互和 Handoff 时间线。

### 16.2 任务详情扩展页签

通过 `pluginmax.task.detail.tabs` 注册：

- `团队`
- `交付计划`

团队页：

- Lead / Worker / Reviewer；
- Runtime Pool；
- 当前状态；
- 能力缺口；
- 变更历史。

交付计划页：

- Work Item 分组；
- 依赖和负责人；
- 状态；
- Plan Diff；
- 人工批准入口。

执行页继续由 Task 插件展示选中 Run 的 Agent Execution Plan。

### 16.3 独立体验

- Delivery blocked：显示安装 checklist；
- planning-only：允许手工草稿但不提供“立即派发”；
- full：完整操作；
- delivery 卸载：任务详情自动少两个扩展页签，Task / Agent 不受影响。

## 17. 权限

### 17.1 操作权限

| 操作                 | 权限                                              |
| -------------------- | ------------------------------------------------- |
| 查看 Team            | 项目成员或任务可见者                              |
| 提议 Team            | Lead 候选、任务创建人、项目 Owner/Admin           |
| 批准 Team / Plan     | 任务创建人、项目 Owner、指定审批人                |
| Lead 自动变更成员    | Team Constraint 和 Action Ticket                  |
| 修改 Work Item       | 当前 Lead、任务负责人、项目 Owner                 |
| 取消 Team            | 任务创建人、项目 Owner/Admin                      |
| 查看 Worker 私有记忆 | Worker Owner / 平台管理员，受既有 Memory 规则限制 |

### 17.2 Action Ticket Scope

建议：

```text
task/<taskId>
team/<teamId>
work-item/<workItemId>
context/task-team/<teamId>
context/work-item/<workItemId>
```

Lead 的 Ticket 不能自动扩展到所有项目文件；成员 Ticket 只允许自己的 Work Item 范围。

## 18. 失败与恢复

| 场景                                   | 处理                                             |
| -------------------------------------- | ------------------------------------------------ |
| Lead Run 失败                          | Cycle failed，Team waiting-human，可重试/换 Lead |
| Worker Run 失败                        | WorkItem failed；Lead 可重试/换人/重排           |
| 成员 Runtime 失效                      | 成员 candidate unavailable；暂停相关 Work Item   |
| Delivery dispatch 后绑定失败           | 按 dispatchKey 对账补绑                          |
| Run settled 事件丢失                   | reconciler 扫描 Work Item dispatching/running    |
| Plan 激活一半失败                      | plan pending；不派发，重试幂等                   |
| Team 成员变更与 WorkItem dispatch 竞态 | 单 Team command queue                            |
| Receipt 缺失                           | Run 可继续，但标记上下文不可审计                 |
| Delivery 插件卸载                      | 数据保留；Team inactive；Task/Agent 继续可用     |

## 19. 并发模型

- 一个 Task 同时最多一个 active Team revision；
- 一个 Team 同时最多一个 active Lead Cycle；
- 一个 Team 可并行多个 ready Work Item，受 `maxConcurrentRuns` 限制；
- 一个 Work Item 同时最多一个 active Run；
- 同一 Team 的 Team/Plan 变更串行；
- Work Item 状态更新按 WorkItem 串行；
- 跨 Team 可并行。

实现上使用插件内 per-team / per-work-item promise queue，不引入外部分布式锁。

## 20. 数据迁移与回滚

### 20.1 新 Domain

`collab_delivery` 从 version 1 开始，无旧数据迁移。

### 20.2 Task / Agent

- Task 不新增 required 字段；
- Agent Run source 枚举扩展只新增值；
- 旧 Run 不参与 Delivery settlement；
- Agent generic handler 绑定后在恢复时只处理新 source。

### 20.3 Context

- Scene 枚举新增 `task-team` / `work-item`；
- 旧 Pack / Receipt 保持可读；
- 新 Scene Adapter 不存在时，仅 Delivery 功能不可派发。

### 20.4 回滚

- 禁用 Delivery 插件：Task / Agent / Context 继续运行；
- 恢复 Delivery domain 备份可还原所有 Team / Plan / Work Item；
- 已创建的 Agent Run 保留；
- 不删除 Task 的 Review 和证据。

## 21. 测试计划

### 21.1 单元

- Team 候选硬过滤 / 评分；
- Team/Plan/WorkItem 状态机；
- dependency ready；
- policy 收窄；
- Plan diff；
- Lead tool scope；
- 幂等 dispatchKey；
- 成员替换；
- CollaborationEvent 序列。

### 21.2 契约

- Delivery → Agent generic source；
- Delivery → Teammate candidate；
- Delivery → Context adapter；
- Delivery → Memory handoff；
- Delivery → Task summary/review；
- Agent Execution Envelope 继承。

### 21.3 集成

- Task → Lead → Team Draft → Plan → Work Items → Runs → Review；
- 两个及以上 Runtime；
- 团队成员失败后替换；
- Work Item 精准返工；
- 用户修改 Team/Plan；
- Delivery 插件缺失时 Task/Agent 正常；
- 重启恢复和对账。

### 21.4 GUI

- Team 列表与状态；
- Task 详情扩展页签；
- Work Item 依赖和状态；
- Run/Agent Execution Plan 切换；
- Gate 和人工确认；
- 窄屏、长文本、多成员；
- 插件卸载后页签消失。

## 22. 监控指标

- Team Draft 生成/批准时延；
- Lead Cycle 数量、时长和成本；
- Work Item 首轮成功率；
- 成员替换率；
- 因 Runtime 能力不足失败率；
- Plan revision 次数；
- Context Receipt 覆盖率；
- 跨域 pending 对账恢复率；
- Lead 越权请求拒绝数；
- Task 首次 Review 通过率。

## 23. 验收

1. Delivery 插件独立加载不导致其他插件启动失败。
2. 完整组合可从 Task 创建走到 Team、Plan、WorkItem、Run 和 Review。
3. Lead Agent 可以提议团队和计划，但平台拒绝不合规模板/权限/Runtime。
4. 团队成员可以混合使用内置与外部 Runtime。
5. Work Item Policy 不得宽于 Task Policy。
6. Worker 只获得自身 Work Item 所需上下文。
7. Lead 不读取 Worker 完整私有 Session。
8. 普通聊天不能改变 Work Item 状态。
9. 成员失败可以替换，已完成证据和 Handoff 保留。
10. Review 退回能定位 Work Item 并只重跑受影响部分。
11. Task 进入 Review 时负责人切到验收人，退回恢复原提交执行负责人。
12. Team 完成后可归档，不改变 AI伙伴永久身份。
13. Delivery 卸载后 Task / Agent / Context 数据不受破坏。
14. `collab_delivery` domain 可整域备份和回滚。

## 24. 后续扩展

- Team Template / 行业角色包；
- 基于历史成功率和成本的路由评分；
- 更强的冲突仲裁策略；
- Work Item 自动物化为子 Task；
- 跨 Runtime 的 Handoff 协议；
- Team 级预算与审批中心；
- 更细粒度的 Lead / Worker / Reviewer 权限；
- 未来跨项目人工授权协作，但不做默认自动共享。
