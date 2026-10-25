# 技术设计：阶段一 Runtime Agent Execution Plan 闭环

> 版本：v1.0  
> 日期：2026-10-25  
> 实现状态：核心链路已落地（Execution Domain、Plan/Event/Gate/Snapshot、Task Policy、Context Policy、Task 详情 UI）  
> 上游架构：[Agent 任务控制与动态 AI 团队总体架构](./technical-design-agent-task-control-overall.md)  
> 产品依据：[任务管理作为 Agent Runtime 的超级遥控器](../../产品设计-任务管理作为Agent运行时超级遥控器.md)

## 0. 阶段目标

阶段一不建设 Task Team、Task Delivery Plan 或 Work Item，只完成：

```text
Task Contract
  → Runtime Preflight
  → Agent Run
  → Agent Execution Plan
  → Tool / Gate / Evidence
  → Review / Reject / Rerun
  → Archive
```

用户通过现有任务创建、人工拆任务、负责人、协作方和依赖控制复杂工作。

Agent Execution Plan / Run Event / Gate 放在 Agent 能力层，因此工作流 Agent、未来会议 Agent 或其他 Run Source 也能复用；阶段一只是先由 Task 提供最完整的控制 UI。

阶段一必须同时满足：

- `dsh-collab-task` 单独安装时仍可完成人工任务闭环；
- `dsh-collab-agent` 单独安装时可管理 Runtime、执行受控 Run 并查看执行计划；
- 二者组合时任务详情展示完整执行闭环；
- Context / Memory / Teammate 缺失时，不崩溃且有明确降级；
- 不要求 Delivery 插件存在。

## 1. 现状与改造点

### 1.1 现有能力

- `dsh-collab-task` 已有任务契约、负责人、验收、Review、退回、Run 引用和归档。
- `dsh-collab-agent` 已有 Profile、内置/外部 Runtime、Run、状态机、取消、恢复和基础执行元数据。
- 外部 Runtime 已能回传 stdout/stderr、CodeBuddy 风格 thinking/tool 事件和 Codex JSONL。
- `dsh-collab-context` 已有 ContextPack、Receipt、场景 Session。
- `dsh-collab-teammate` 已有 AI伙伴、Principal Runtime Profile 和 Action Ticket。

### 1.2 主要缺口

1. 没有标准 Agent Execution Plan 数据模型。
2. 没有持久化工具/子 Agent 事件的标准表。
3. Run 元数据不足以区分“支持搜索、已授权、已启用、实际使用”。
4. Context 中硬编码“不得读取 ContextPack 之外来源”，会与任务授权的联网研究冲突。
5. Execution Gate 没有独立状态和决策记录。
6. Task 和 Agent 的跨域执行契约仍以松散 payload 为主。

## 2. 组件与职责

| 组件                           | 阶段一职责                                                | 不负责                            |
| ------------------------------ | --------------------------------------------------------- | --------------------------------- |
| `dsh-collab-task`              | 任务契约、执行策略、派发意图、Review、退回、归档          | Runtime 协议、工具执行、Plan 解析 |
| `dsh-collab-agent`             | 能力预检、Execution Envelope、Run、Plan、事件、Gate、快照 | Task 业务状态、Lead Agent、Team   |
| `dsh-collab-context`           | ContextPack、Source Policy 渲染、Receipt                  | 判断 Runtime 是否支持搜索         |
| `dsh-collab-teammate`          | AI伙伴身份、Runtime 绑定、Owner、Action Ticket            | Execution Plan                    |
| `dsh-collab-identity`          | Principal / Grant / 审计主体                              | Runtime 执行                      |
| `dsh-collab-memory`            | 项目真相、Agent 记忆、Handoff                             | Run 事件                          |
| `dsh-collab-shell/task client` | 任务详情中的运行、计划、Gate 和证据展示                   | 直接调用 Runtime CLI              |

## 3. 插件结构与新增模块

### 3.1 `dsh-collab-agent`

建议新增模块：

```text
plugins/dsh-collab-agent/src/
  execution/
    capabilities.ts        # RuntimeCapabilityProfile
    resolver.ts            # 5 层能力/授权/参数解析
    envelope.ts            # ExecutionEnvelope
    plan.ts                # AgentExecutionPlan / Step
    events.ts              # RunEvent 归一化与持久化
    gates.ts               # ExecutionGate 生命周期
    snapshot.ts            # RunExecutionSnapshot
    adapters/
      builtin.ts
      codex.ts
      plain-text.ts
```

新数据域：

```yaml
name: collab_agent_execution
version: 1
tables:
  capabilities: RuntimeCapabilitySnapshot
  envelopes: ExecutionEnvelopeRecord
  plans: AgentExecutionPlanRecord
  run_events: RunEventRecord
  gates: ExecutionGateRecord
  snapshots: RunExecutionSnapshot
  outbox: DomainOutboxRecord
```

独立 domain 的理由：

- 不改变 `collab_agent` 的 single-layout version；
- Plan / Event / Gate 为高增长 Append-only 数据，可独立备份、清理和回滚；
- Agent 插件仍同时拥有两个 domain，领域责任不被拆散。

### 3.2 `dsh-collab-task`

不新增 Plan 或 Gate domain，只增加：

- `TaskExecutionPolicy` optional 字段；
- 执行前预检 API；
- 对 Agent Execution Projection 的只读聚合；
- 任务详情运行区域。

Task 仍是任务业务状态的唯一权威。

### 3.3 `dsh-collab-context`

增量支持：

- `execution-policy` context section；
- `source-policy` context section；
- 将策略摘要写入 ContextPack；
- SourceRef 增加 Runtime Event、Evidence、Artifact 引用。

不增加 Team / Work Item Scene；这些属于阶段二 Delivery 插件注册。

## 4. 核心数据契约

### 4.1 TaskExecutionPolicyV1

```ts
interface TaskExecutionPolicyV1 {
  schemaVersion: 1;
  runtime: {
    selection: "user-selected" | "recommended";
    allowedRuntimeIds: string[];
    requiredCapabilities: RuntimeRequirement[];
  };
  sourcePolicy: {
    allow: SourceClass[];
    deny: SourceClass[];
    citation: "none" | "required-for-factual-claims";
    requirePublishedAt: boolean;
    requireAccessedAt: boolean;
  };
  toolPolicy: {
    allow: ToolCategory[];
    deny: ToolCategory[];
    requireApproval: ToolCategory[];
  };
  evidence: {
    requirePlan: boolean;
    requireToolEvents: boolean;
    requireCitations: boolean;
    requireStructuredSubagents: boolean;
  };
  humanGates: ExecutionGateRule[];
  budget: {
    timeoutMs?: number;
    maxTurns?: number;
    maxToolCalls?: number;
    maxCost?: number;
  };
}
```

任务目标、范围和验收仍只存放在 Task 聚合中，执行策略不得复制这些字段。

`SourceClass`：

```ts
type SourceClass =
  | "workspace"
  | "task-attachments"
  | "meeting-context"
  | "project-memory"
  | "enterprise-knowledge"
  | "public-web"
  | "regulatory-filing"
  | "private-local-data"
  | "connector-data";
```

`ToolCategory` 使用总体架构中的稳定类别，例如 `web.search`、`fs.write`、`mcp.<connector>`。

```ts
interface RuntimeRequirement {
  key:
    | "search"
    | "network"
    | "file-read"
    | "file-write"
    | "shell"
    | "browser"
    | "mcp"
    | "structured-plan"
    | "blocking-gate";
  necessity: "required" | "preferred";
  value?: string | boolean;
}

interface CapabilityGap {
  code:
    | "runtime-capability-missing"
    | "policy-not-authorized"
    | "launch-parameter-disabled"
    | "principal-grant-missing"
    | "runtime-unavailable";
  key: string;
  necessity: "required" | "preferred";
  message: string;
  remediation?: string;
}
```

约束：

- Work Item 引入前，契约直接属于 Task。
- 任务执行策略只缩小权限，不能扩大 Principal Grant 或 Runtime 能力。
- `allowedRuntimeIds` 为空表示允许平台在兼容 Runtime 中推荐；非空表示显式白名单。
- 策略修改生成新版本；已启动 Run 使用不可变快照。

### 4.2 RuntimeCapabilityProfileV1

```ts
interface RuntimeCapabilityProfileV1 {
  schemaVersion: 1;
  runtimeId: string;
  runtimeRevision: string;
  adapterId: string;
  provider: string;
  protocol: "builtin" | "codex-jsonl" | "plain-text" | "future";
  capabilities: {
    search: CapabilityState;
    network: CapabilityState;
    fileRead: CapabilityState;
    fileWrite: CapabilityState;
    shell: CapabilityState;
    browser: CapabilityState;
    mcp: CapabilityState;
    sessionResume: CapabilityState;
    structuredPlan: CapabilityState;
    structuredToolEvents: CapabilityState;
    structuredSubagent: CapabilityState;
  };
  toolCategories: ToolCategory[];
  networkModes: ("none" | "restricted" | "public")[];
  gateEnforcement: "blocking" | "cooperative" | "observe-only";
  limits: {
    maxDurationMs?: number;
    contextWindowTokens?: number;
    maxOutputTokens?: number;
    maxParallelSubagents?: number;
  };
  provenance: {
    adapter: boolean;
    probe: boolean;
    config: boolean;
    observedInRuns: boolean;
  };
  capturedAt: string;
}
```

`CapabilityState`：

```ts
type CapabilityState = "supported" | "unsupported" | "unknown";
```

不能从 Runtime 名称推断能力。

### 4.3 ExecutionEnvelopeV1

```ts
interface ExecutionEnvelopeV1 {
  schemaVersion: 1;
  id: string;
  taskId: string;
  runId?: string;
  workspaceId: string;
  principalId: string;
  teammateId?: string;
  runtimeId: string;
  adapterId: string;
  runtimeRevision: string;
  policyVersion: string;
  ticketId?: string;
  resolved: {
    searchEnabled: boolean | null;
    networkAccess: "none" | "restricted" | "public" | "unknown";
    allowedToolCategories: ToolCategory[];
    approvalToolCategories: ToolCategory[];
    deniedToolCategories: ToolCategory[];
    sandbox: string;
    gateEnforcement: "blocking" | "cooperative" | "observe-only";
    planVisibility: "structured" | "summary" | "opaque";
  };
  launch: {
    provider: string;
    model?: string;
    argsDigest?: string;
    commandDigest?: string;
    authMode: string;
  };
  unresolved: CapabilityGap[];
  createdAt: string;
}
```

约束：

- 只保存命令和参数摘要 / hash，不保存凭据正文。
- `unresolved` 中的 `required` gap 必须阻止派发。
- Run 启动后 envelope 不可修改。

### 4.4 AgentExecutionPlanRecordV1

```ts
interface AgentExecutionPlanRecordV1 {
  schemaVersion: 1;
  id: string;
  runId: string;
  workspaceId: string;
  source: "explicit" | "derived" | "unavailable";
  visibility: "structured" | "summary" | "opaque";
  revision: number;
  status: "pending" | "active" | "completed" | "failed" | "cancelled";
  summary?: string;
  steps: ExecutionPlanStep[];
  subagents: ExecutionSubagent[];
  lastEventSeq: number;
  createdAt: string;
  updatedAt: string;
}

interface ExecutionPlanStep {
  id: string;
  ordinal: number;
  title: string;
  status: "pending" | "active" | "completed" | "failed" | "skipped";
  detail?: string;
  startedAt?: string;
  endedAt?: string;
  evidenceRefs: string[];
}

interface ExecutionSubagent {
  id: string;
  role: string;
  status: "pending" | "active" | "completed" | "failed";
  inputSummary?: string;
  outputSummary?: string;
  startedAt?: string;
  endedAt?: string;
  evidenceRefs: string[];
}
```

Plan 是由事件投影出的当前视图，不是唯一事实。事件事实存储在 `run_events`。

### 4.5 RunEventRecordV1

```ts
interface RunEventRecordV1 {
  schemaVersion: 1;
  id: string;
  runId: string;
  seq: number;
  type:
    | "plan.snapshot"
    | "step.started"
    | "step.completed"
    | "step.failed"
    | "tool.call"
    | "tool.result"
    | "subagent.started"
    | "subagent.completed"
    | "gate.requested"
    | "gate.decided"
    | "progress.summary"
    | "artifact"
    | "warning"
    | "error";
  source: "builtin-session" | "external-jsonl" | "external-trace" | "derived";
  sourceEventId?: string;
  visibility: "public" | "restricted" | "admin-only";
  summary: string;
  data?: Record<string, unknown>;
  rawRef?: string;
  createdAt: string;
}
```

事件要求：

- 按 `runId + seq` 串行。
- `sourceEventId` 用于幂等。
- 默认不持久化原始 thinking/chain-of-thought，只保留允许展示的摘要。
- 工具参数和结果按大小上限截断，完整原文写受控 artifact / session ref。

### 4.6 ExecutionGateRecordV1

```ts
interface ExecutionGateRecordV1 {
  schemaVersion: 1;
  id: string;
  runId: string;
  taskId: string;
  workspaceId: string;
  kind:
    | "preflight"
    | "tool-approval"
    | "data-source"
    | "external-send"
    | "budget"
    | "runtime-switch";
  status: "pending" | "approved" | "denied" | "expired" | "cancelled";
  reason: string;
  requestedToolCategory?: ToolCategory;
  requestedScope: string[];
  enforcement: "blocking" | "cooperative" | "observe-only";
  requestedByPrincipalId?: string;
  decidedByPrincipalId?: string;
  decisionNote?: string;
  requestedAt: string;
  expiresAt?: string;
  decidedAt?: string;
}
```

## 5. 有效能力解析

### 5.1 五层事实

```text
L1 Runtime Capability
L2 Agent / Task Authorization
L3 Launch Parameters
L4 Observed Tool Event
L5 Run Execution Snapshot
```

搜索示例：

```ts
searchEnabled =
  runtime.capabilities.search === "unsupported" ||
  task.sourcePolicy.deny.includes("public-web") ||
  envelope.launch.searchEnabled === false
    ? false
    : runtime.capabilities.search === "supported" &&
        task.sourcePolicy.allow.includes("public-web") &&
        envelope.launch.searchEnabled === true
      ? true
      : null;

searchUsed = runEvents.some(
  (event) =>
    event.type === "tool.call" &&
    (event.data?.toolName === "web_search" ||
      event.data?.toolName === "web_fetch"),
)
  ? true
  : runIsTerminal && snapshot.toolEventCompleteness === "complete"
    ? false
    : null;
```

UI 必须区分：

- Runtime 不支持；
- 支持但任务未授权；
- 已授权但本轮未启用；
- 已启用且实际发生；
- 未知。

### 5.2 权限交集

```text
allowed =
  Runtime supported
  ∩ Agent Profile allowed
  ∩ Principal Grant
  ∩ Task policy allowed
  − Task deny
  − 用户本轮拒绝
```

`unknown` 不能视为允许。

## 6. Runtime Adapter

### 6.1 公共接口

```ts
interface RuntimeAdapter {
  readonly id: string;

  describe(input: {
    runtime: ExternalAgentRuntime | BuiltinRuntimeDescriptor;
    probe?: ProbeResult;
  }): Promise<RuntimeCapabilityProfileV1>;

  resolve(input: {
    task: TaskExecutionPolicyV1;
    profile: AgentProfile;
    runtime: ExternalAgentRuntime | BuiltinRuntimeDescriptor;
    principalGrants: readonly GrantProjection[];
    ticket?: ActionTicketProjection;
  }): Promise<ExecutionEnvelopeV1>;

  execute(input: RuntimeExecuteInput): Promise<RuntimeExecutionResult>;
}

interface RuntimeExecutionResult {
  stopReason: "completed" | "failed" | "cancelled";
  output: string;
  sessionId?: string;
  diagnostic?: string;
  execution: Partial<RunExecutionSnapshotV1>;
}

type RuntimeEventDraft = Omit<
  RunEventRecordV1,
  "id" | "runId" | "seq" | "createdAt"
>;

interface GateRequestDraft {
  kind: ExecutionGateRecordV1["kind"];
  reason: string;
  requestedToolCategory?: ToolCategory;
  requestedScope: string[];
}

type GateDecision = "approved" | "denied" | "expired";

interface RuntimeExecuteInput {
  run: AgentRun;
  taskId: string;
  envelope: ExecutionEnvelopeV1;
  prompt: string;
  workspacePath: string;
  signal: AbortSignal;
  emit(event: RuntimeEventDraft): void;
  requestGate?(request: GateRequestDraft): Promise<GateDecision>;
}
```

`requestGate` 只对声明 `blocking` 或 `cooperative` 的 Adapter 注入。`observe-only` Adapter 不获得可调用的阻断接口，只能 emit 观察事件；高风险任务不能选择该 Adapter 自动执行。

### 6.2 内置 Session / Subagent Adapter

能力来源：

- Agent Profile 工具白名单；
- 当前 DSH preset / tools registry；
- 当前 default model；
- 当前 sandbox / network policy；
- session event vocabulary；
- `todo/write`、`tool/call`、`tool/result` 和子 Session 事件。

Plan 来源：

- 若有显式 Plan 工具或 `todo/write`，映射为 structured；
- 若只有 session/tool 进程事件，映射为 summary；
- 若都不可用，标记 unavailable。

Built-in Adapter 记录每个 active Run 的 `lastSessionEventIndex`，在运行期间和结束时读取新增的 `snapshotEvents()`，把 `tool/call`、`tool/result`、`todo/write` 等映射为 Run Event；`sessionId + eventIndex + eventType` 作为 `sourceEventId` 去重。现有 `agent/assistant-stream` 仍用于低延迟文本进度，不作为工具事实来源。

Gate：

- 优先使用 DSH `tools/pre-execute` 做 blocking Gate；
- Agent 插件维护 live `sessionId → runId` 映射；
- 未命中 Run 的事件不拦截。

### 6.3 Codex JSONL Adapter

能力来源：

- Adapter 固定协议参数；
- Runtime 启动参数；
- Codex session metadata；
- probe 输出的 login 状态；
- JSONL item / tool 事件。

事件映射：

- command/tool 调用 → `tool.call`
- command/tool 结果 → `tool.result`
- agent/reasoning 可展示摘要 → `progress.summary`，不保存原始思维链
- subagent 事件若协议不提供，标记 `structuredSubagent = unknown`

Gate：

- 若 CLI 提供审批回调或可暂停协议，标记 `cooperative/blocking`；
- 当前仅观察 stdout/stderr 的 JSONL 模式默认 `observe-only`；
- 高风险任务不能只依赖 CLI 内部“可能会停下来”。

### 6.4 Plain-text Adapter

能力：

- 启动、stdout/stderr、退出状态；
- 可解析 debug trace 中的 tool/thinking 行作为 derived summary；
- 无结构化 Plan 时显示 opaque。

该 Adapter 默认：

- `structuredPlan = unknown/unsupported`
- `gateEnforcement = observe-only`
- `searchUsed = unknown`，除非 trace 明确给出工具调用。

即使没有内部结构化事件，Agent 插件仍应根据 Run 生命周期生成一个 `source=derived` 的摘要级执行记录（启动、运行、等待、结束、输出）。`opaque` 只用于连可靠生命周期投影都无法形成的失败场景。

## 7. Plan 与事件投影

### 7.1 写入顺序

```text
Runtime event
  → normalize
  → dedupe by sourceEventId
  → append RunEvent(seq)
  → update Plan projection
  → update Run snapshot metadata
  → emit best-effort domain event
```

### 7.2 Derived Plan

没有显式 Plan 时：

- 按 Step / Tool call 分组生成“已观察到的执行阶段”；
- 标题使用工具摘要，不推断模型意图；
- 标记 `source: derived`；
- UI 文案使用“执行记录”而非“Agent 制定的计划”。

### 7.3 事件批量与背压

- 进程内缓冲 100ms-250ms；
- 单次最多写 100 个事件；
- 事件表每 Run 最多保留配置上限；
- 超出后保留关键事件 + artifact 引用；
- 不允许阻塞主模型 turn 等待浏览器消费。

## 8. Execution Gate

### 8.1 Gate 类型

- Preflight：Runtime / 工具 / 来源不足；
- Tool approval：写文件、外部发送、生产命令；
- Data source：新增企业知识库或私有数据；
- Budget：超出工具次数、时长或成本；
- Runtime switch：切换 Runtime 或恢复 Session。

### 8.2 Blocking Gate

```text
tool/pre-execute
  → resolve runId by session
  → evaluate policy
  → create Gate(pending)
  → pause tool execution
  → wait decision / expiry
  → allow: continue
  → deny: return structured tool error to Agent
```

### 8.3 Cooperative Gate

Runtime Adapter 通过 `requestGate()` 主动请求；Agent 进程保持挂起或可恢复状态。

### 8.4 Observe-only

- 不能阻断已执行动作；
- 平台记录 `policy-violation-observed`；
- 可按策略取消后续 Run；
- UI 必须显示“已发现动作，但 Runtime 不支持执行前阻断”。

### 8.5 Run 状态

阶段一不新增 `waiting_gate` Run 主状态，继续使用 `waiting_input`：

- Gate 表表达具体等待项；
- UI 显示“等待授权”；
- 取消 / 超时 Gate 后 Run 按原状态机处理。

这样避免影响现有所有 `ACTIVE_RUN_STATUSES` / Task 投影逻辑。

## 9. Run Execution Snapshot

```ts
interface RunExecutionSnapshotV1 {
  schemaVersion: 1;
  runId: string;
  taskId: string;
  provider: string;
  model: string;
  runtimeId: string;
  runtimeName: string;
  runtimeVersion: string;
  adapterId: string;
  authMode: string;
  sandbox: string;
  networkAccess: "none" | "restricted" | "public" | "unknown";
  gateEnforcement?: "blocking" | "cooperative" | "observe-only";
  searchEnabled: boolean | null;
  searchUsed: boolean | null;
  planVisibility: "structured" | "summary" | "opaque";
  toolEventCompleteness: "complete" | "partial" | "none";
  allowedToolCategories: string[];
  usedTools: string[];
  ticketId?: string;
  contextPackId?: string;
  envelopeId: string;
  policyVersion: string;
  unknownFields: string[];
  capturedAt: string;
  finalizedAt?: string;
}
```

该快照由 Agent 插件写入，Task 只消费投影。

## 10. Task 插件改造

### 10.1 Task 数据

`TaskRecord` 增加 optional：

```ts
executionPolicy?: TaskExecutionPolicyV1;
executionSnapshotVersion?: 1;
```

兼容策略：

- 老任务没有契约时，在读取时生成 `legacy-default`；
- 新字段不 required 化，避免存量记录 invalid；
- 修改契约写 Task event 并递增 `updatedAt`。

### 10.2 预检 API

```http
POST /api/collab/tasks/execution/preflight
{
  "workspaceId": "ws-1",
  "taskDraft": {...},
  "receiverId": "teammate-1",
  "runtimeId": "codex-standard"
}
```

返回：

```ts
interface TaskExecutionPreflight {
  compatible: boolean;
  runtime: RuntimeCapabilityProfileV1;
  envelopePreview: ExecutionEnvelopeV1;
  gaps: CapabilityGap[];
  suggestedRuntimeIds: string[];
  warnings: string[];
}
```

预检不创建 Run。

### 10.3 派发

`createTaskDispatcher()` 修改为：

1. 读取 Task Execution Policy；
2. 解析 AI伙伴 / Principal / Runtime；
3. 请求 ContextPack；
4. 调用 Agent `preflight()` + `dispatch()`；
5. 将 Run ID、Envelope ID、Snapshot 投影写入 Task message；
6. Agent settle 后继续现有 Review / Handoff 逻辑。

Agent 不可用时：

- Task 创建成功；
- 记录明确系统消息；
- 不伪造 Run；
- 保留人工处理路径。

### 10.4 Task 详情聚合

新增只读 endpoint：

```http
GET /api/collab/tasks/execution?taskId=...
```

返回：

```ts
interface TaskExecutionView {
  taskId: string;
  runs: AgentRunProjection[];
  selectedRunId?: string;
  plan?: AgentExecutionPlanProjection;
  events: RunEventProjection[];
  gates: ExecutionGateProjection[];
  snapshot?: RunExecutionSnapshotProjection;
  contextReceipt?: ContextReceiptProjection;
  capabilities: {
    planAvailable: boolean;
    contextAvailable: boolean;
    gateAvailable: boolean;
    memoryAvailable: boolean;
  };
}
```

由 Task 插件调用 Agent / Context service 组装，而不是前端分别猜状态。

## 11. Context 插件改造

### 11.1 修正来源策略

将现有笼统指令：

```text
Never read sources outside the current ContextPack.
```

改为策略化表达：

```text
Only use sources authorized by the execution source policy.
If public-web is allowed, cite URL, publishedAt and accessedAt.
Never access private sources that are not explicitly included or authorized.
```

原因：

- ContextPack 表达本轮已知上下文；
- 联网调研任务还需要允许 Agent 主动检索新的公开来源；
- “ContextPack 外一律禁止”会使 Runtime 支持搜索也无法完成研究任务。

### 11.2 新增 Section

```ts
type ContextSectionType =
  | ...existing
  | "execution-policy"
  | "source-policy";
```

Section 内容：

- 允许和禁止来源；
- 引用要求；
- 工具类别；
- 网络/沙箱；
- Gate 规则；
- 不得将缺失来源伪装为已读取。

`SourceRef.type` 增量允许：

```text
run
run-event
artifact
evidence
runtime-session
```

这些值只扩展枚举，不改变旧记录。阶段二再增加 `task-team` / `work-item` / `handoff`。

为公开研究引用，`SourceRef` 增加 optional：

```ts
publisher?: string;
publishedAt?: string;
accessedAt?: string;
```

旧记录缺省为未知，不自动回填。

### 11.3 ContextReceipt

增加 optional：

```ts
executionEnvelopeId?: string;
sourcePolicyVersion?: string;
runtimePlanVisibility?: PlanVisibility;
```

老 Receipt 默认可读。

## 12. Teammate / Identity 改造

### 12.1 Teammate

增加只读投影：

```ts
resolveExecutionBinding(input: {
  teammateId: string;
  workspaceId: string;
}): Promise<{
  principalId: string;
  ownerPrincipalId?: string;
  runtimePool: string[];
  profileName: string;
  allowedToolCategories: string[];
  status: "active" | "paused" | "archived";
}>
```

保留既有 `assignable()` / `ownerOf()` 契约，不把 Runtime 执行计划写入 SOUL。

### 12.2 Principal Action Ticket

Task / Agent 请求 Ticket 时使用更细的动作类别：

```text
task.read
task.write
source.workspace.read
source.web.search
tool.fs.write
tool.shell.execute
mcp.<connector>.read
```

兼容旧 `read/write`：

- 旧值继续可解析；
- 新执行优先使用带命名空间的动作；
- deny 始终优先。

## 13. API 与事件

### 13.1 HTTP

Agent：

```text
GET  /api/collab/agent/execution/preflight?...
POST /api/collab/agent/execution/preflight
GET  /api/collab/agent/execution?runId=...
GET  /api/collab/agent/execution/events?runId=...&afterSeq=...
POST /api/collab/agent/execution/gates/decide
POST /api/collab/agent/execution/gates/cancel
```

Task：

```text
POST /api/collab/tasks/execution/preflight
GET  /api/collab/tasks/execution?taskId=...
```

所有浏览器请求：

- same-origin；
- Bearer token；
- workspace membership / Grant 校验；
- Gate decision 必须核对当前用户审批权限。

### 13.2 事件

```text
agent.execution-plan.changed.v1
agent.run-event.appended.v1
agent.execution-gate.requested.v1
agent.execution-gate.decided.v1
agent.run-snapshot.finalized.v1
```

Task 可通过事件快速刷新，但也可以按 `taskId` 重新拉取执行投影。

## 14. UI

### 14.1 任务详情

阶段一任务详情保持：

```text
[执行] [交付物] [Discussion] [历史]
```

不显示 Team / Delivery Plan。

执行页：

- 顶部：Run 选择器、Agent、Runtime、模型、状态；
- 中部：Agent Execution Plan / 执行记录；
- 右侧或下方：工具事件、子 Agent、Gate、产出；
- 底部：运行信息快照；
- 等待授权时：顶部警告条 + 明确入口。

### 14.2 Plan 可见性

| 状态         | UI                                                 |
| ------------ | -------------------------------------------------- |
| `structured` | 步骤、工具、子 Agent、状态                         |
| `summary`    | 当前阶段、主要工具、阶段结果                       |
| `opaque`     | 连可靠生命周期摘要都无法形成；只显示错误和原始结果 |
| `derived`    | 标注“根据运行事件整理”，不写成 Agent 原始计划      |

### 14.3 独立插件体验

- Agent 未安装：不显示执行区块；
- Context 未安装：显示运行时输出，但没有上下文回执入口；
- Teammate 未安装：可直接对 Agent Profile 派发，或只做人工任务；
- Memory 未安装：不显示记忆来源，不影响任务闭环。

## 15. 存储与迁移

### 15.1 新 Domain

`collab_agent_execution` 首次创建 version 1，不需要迁移旧 domain。

### 15.2 `collab_agent`

- `external_runtimes` 可以增加 optional capability hint 字段；
- `runs` 不要求新增 required 字段；
- 历史 Run 通过 `runId` 懒生成 derived snapshot / plan。

### 15.3 `collab_task`

- `executionPolicy` optional；
- 旧 Task 读取时使用 legacy default；
- schema 不使用 required 收紧直到全量回填验证完成；
- 增加旧格式 fixture。

### 15.4 Context

- 新 section 和 SourceRef 类型向后兼容；
- 老 Pack 不重新渲染；
- 新 Receipt 字段 optional。

## 16. 错误处理与幂等

| 场景                                 | 行为                                              |
| ------------------------------------ | ------------------------------------------------- |
| preflight 不可用                     | 不创建 Run，Task 记录明确缺口                     |
| Agent dispatch 成功但 Task bind 失败 | 用 dispatchKey 对账补绑                           |
| 外部进程中断                         | Run `interrupted`，保留已有事件                   |
| Plan 解析失败                        | Plan `unavailable`，Run 继续                      |
| Gate 决策重复提交                    | 按 gateId 幂等                                    |
| 事件 source ID 重复                  | 不重复 append                                     |
| Context 缺失                         | 使用 legacy prompt；标记 `contextAvailable=false` |
| Runtime 不支持搜索但任务要求         | preflight blocked 或要求换 Runtime                |
| 已观察禁止动作但无法阻断             | 记录 policy violation，按策略终止后续执行         |

## 17. 测试计划

### 17.1 单元

- Capability tri-state；
- 五层 search 解析；
- Policy deny-wins；
- Gate 状态机；
- Plan event projection；
- event dedupe / seq；
- legacy Task 读取。

### 17.2 Adapter fixtures

- Codex JSONL tool events；
- CodeBuddy thinking/tool trace；
- plain-text 无事件；
- stderr + zero exit；
- process timeout / cancel；
- subagent event。

### 17.3 集成

- Task create → preflight → dispatch → plan → review；
- search policy 允许/禁止；
- blocking / cooperative / observe-only Gate；
- Task 无 Agent 的人工闭环；
- Context 缺失；
- 重启恢复与对账。

### 17.4 GUI

- right-side metadata；
- plan unavailable 文案；
- Gate 等待授权；
- 多 Run 切换；
- 插件卸载后 UI 消失；
- 窄屏布局。

## 18. 灰度与观测

建议配置：

```yaml
executionPlan:
  enabled: true
  retainEventsPerRun: 500
  persistProgressSummary: true
gate:
  defaultMode: observe
  highRiskRequiresBlocking: true
runtimeCapability:
  probeOnRegister: true
  probeOnRun: true
```

指标：

- preflight 失败原因分布；
- `unknown` 能力比例；
- Plan 可见性分布；
- Gate 等待/批准/拒绝/超时；
- Runtime 中断率；
- ContextReceipt 覆盖；
- Task first-pass review rate。

## 19. 验收

1. 阶段一不创建 Task Team、Task Delivery Plan 或 Work Item。
2. Task 无 Agent 插件时可独立完成人工任务闭环。
3. Agent 插件可独立管理 Runtime 和 Run。
4. Task + Agent 组合可显示 Agent Execution Plan 和运行信息。
5. Runtime 不提供计划时明确显示 opaque，不生成虚假步骤。
6. `searchEnabled` / `networkAccess` / `searchUsed` 分层计算。
7. Context 来源策略允许合法联网研究，并保留引用要求。
8. Gate 按 Runtime 实际 enforcement 展示。
9. 退回生成新 Run，恢复原提交执行负责人。
10. 所有新增 domain / schema 可回滚，存量 fixture 通过。

## 20. 后续演进

阶段二只新增：

- Delivery domain；
- Task Team；
- Task Delivery Plan；
- Work Item；
- Lead Agent 编排；
- Team / Work Item Context Adapter；
- 多 Agent Interaction。

阶段一的 Run、Plan、Gate、Snapshot、Context Receipt 和 Task Review 保持原协议。
