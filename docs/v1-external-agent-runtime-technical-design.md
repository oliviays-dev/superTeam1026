# Pluginmax V1 External Agent Runtime Technical Design

> 状态：Batch 13 技术设计草案，尚未实现
>
> 基线：Batch 12B `d39a11bec0eadd4ed4f542837f85c9e701f94049`
>
> 预计 Migration：21

## 1. 设计结论

V1 当前已有统一的 Agent、Run、Job、Outbox、Worker、Runtime Effect、Trace、Task、
Meeting 和 Direct Chat 执行面。Batch 13 不复制旧 DSH 插件的外部 Agent 服务，而是：

1. 从旧实现复用协议解析、argv 构造、进程终止和探测经验；
2. 在 V1 PostgreSQL 中重新建立 Runtime 注册、Probe、Capability、Binding 和审计；
3. 在 `@pluginmax/agent-runtime` 中实现 V1 Adapter；
4. 在现有 `RunExecutor` 中接入 Adapter，不绕过 Worker；
5. 让任务、会议和私聊继续使用各自现有业务回写与幂等规则。

`packages/contracts/src/runtime-execution.ts` 已存在
`RuntimeCapabilityProfile`、`ExecutionEnvelope`、`RunEvent` 等基础契约，但当前没有
接入 V1 Runtime 管理或 `RunExecutor`。这些契约是 Batch 13 的输入，不是完成证明。

## 2. 架构

```text
Runtime Management API
  -> Runtime Application Service
  -> Runtime / Probe / Binding / Event tables
  -> Probe Outbox
  -> Worker Probe Queue
  -> controlled argv probe
  -> immutable Probe result + Capability snapshot

Task / Meeting / Direct Chat
  -> Agent Runtime Binding
  -> Preflight
  -> Run + ContextPack + Job + Outbox
  -> Worker lease
  -> Execution Envelope
  -> External Runtime Adapter
  -> normalized Runtime Events
  -> RunEvent / Run result / Trace
  -> existing Task / Meeting / Direct Chat settlement
```

边界：

- API 不启动外部进程。
- Application Service 不直接执行 `spawn`。
- Adapter 不访问数据库、不修改 Task/Meeting/Direct Chat 状态。
- Worker 负责 Job、Run、Trace、Effect 和 Runtime 终态。
- 业务回写仍由现有 Application/Repository 事务完成。

## 3. 领域对象

### 3.1 External Runtime

```ts
interface ExternalRuntime {
  id: string;
  name: string;
  provider: "codex" | "workbuddy" | "command";
  protocol: "codex-jsonl" | "plain-text";
  command: string;
  managedArgs: string[];
  customArgs: string[];
  supportedModels: string[];
  defaultModel: string | null;
  contextWindowTokens: number | null;
  supportedTools: RuntimeTool[];
  networkMode: "none" | "restricted" | "public" | "unknown";
  sandboxMode: string;
  status: "active" | "disabled" | "archived";
  visibility: "platform" | "owner";
  ownerId: string;
  revision: number;
  lastProbe: RuntimeProbeSummary | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}
```

规则：

- 新 Runtime 创建为 `disabled`，成功 Probe 后才能启用。
- `active` 不自动等于可用；Preflight 还要求 Probe 与当前 revision 匹配且未过期。
- Command 或 argv 变化后清空 Probe、Capability 并回到 `disabled`。
- `active ↔ disabled`；`active | disabled → archived`；`archived → disabled`。
- 归档不删除绑定历史；绑定转为不可用。

### 3.2 Probe

Probe 是由 Worker 执行的受控管理任务，不在 HTTP Route 内执行：

```text
POST probe
  -> runtime_probes(row: requested)
  -> runtime_probe_jobs(row: queued)
  -> domain_outbox(topic: runtime.probe)
  -> Worker claim + lease
  -> spawn(command, probeArgs, shell=false)
  -> runtime_probes(row: passed|failed)
  -> runtime capability snapshot
  -> runtime event
```

Probe 默认只使用 `--version`。Provider 适配器可以定义等价白名单 Probe，但不能从
请求体接收任意 probe argv。

### 3.3 Capability

Capability 分三类来源：

- Adapter：平台已知协议能力；
- Config：管理员声明的上限；
- Probe：实际探测结果。

```ts
interface RuntimeCapability {
  search: "supported" | "unsupported" | "unknown";
  network: "supported" | "unsupported" | "unknown";
  fileRead: "supported" | "unsupported" | "unknown";
  fileWrite: "supported" | "unsupported" | "unknown";
  shell: "supported" | "unsupported" | "unknown";
  sessionResume: "supported" | "unsupported" | "unknown";
  structuredPlan: "supported" | "unsupported" | "unknown";
  structuredToolEvents: "supported" | "unsupported" | "unknown";
}
```

Capability 是执行上限，不是本轮授权。任务策略、项目权限和 Agent 绑定仍需独立校验。

### 3.4 Binding

```ts
interface AgentRuntimeBinding {
  id: string;
  agentId: string;
  runtimeId: string;
  executionMode: "external";
  status: "active" | "disabled";
  revision: number;
  boundBy: string;
  createdAt: string;
  updatedAt: string;
}
```

同一 Agent 最多一条 active 外部绑定。内置 `fake`/`dsh-sdk` 不创建 Runtime 表记录。
已有 `agents.runtime_kind = codex-jsonl | plain-text` 但没有绑定的 Agent 必须继续
被拒绝，并返回 `runtime_binding_missing` 或等价错误，不能假装已经配置完成。

## 4. 数据模型

Migration 21 预计新增或修改：

### `external_runtimes`

- identity、provider、protocol、status、visibility、owner、revision
- command、managed_args JSONB、custom_args JSONB
- supported_models、default_model、context_window_tokens
- supported_tools、network_mode、sandbox_mode
- command_digest、args_digest
- last_probe_id、last_probe_at、last_probe_ok、last_probe_message
- created/updated/archived timestamps

### `external_runtime_probes`

- runtime_id、runtime_revision、requested_by
- status、command_digest、args_digest
- started/ended/duration
- exit_code、timed_out、stdout_excerpt、stderr_excerpt
- capability_snapshot JSONB、error_code、error_message
- immutable created_at

### `external_runtime_capabilities`

- runtime_id、runtime_revision
- adapter_profile JSONB、declared_profile JSONB、probe_profile JSONB
- effective_profile JSONB
- captured_at
- 每个 revision 的能力快照不可变

### `external_runtime_events`

- runtime_id、agent_id nullable、kind、actor_id
- previous_status、next_status、changed_fields JSONB
- message、created_at
- append-only trigger

### `agent_runtime_bindings`

- agent_id、runtime_id、status、revision
- bound_by、created/updated
- partial unique index：每个 Agent 一条 active binding

### `runtime_probe_jobs`

- id、probe_id、status、attempts、available_at
- lease_owner、lease_token、lease_expires_at
- last_error、created/updated

### `runs`

新增 nullable：

- external_runtime_id
- external_runtime_revision
- external_runtime_provider
- external_runtime_protocol
- external_session_id
- execution_snapshot JSONB

不改变既有 Task Run、Meeting AI Run、Direct Chat Run 的 nullable 语义。非外部 Run
保持这些字段为空。

## 5. Preflight

Preflight 在创建 Run/Job/Outbox 前执行：

1. Agent 存在且状态 active；
2. external binding 存在且 active；
3. Runtime 存在、状态 active、revision 匹配；
4. 最新 Probe 成功，且 command/args digest 与当前 revision 一致；
5. Adapter 支持 protocol；
6. Command 通过 argv/安全校验；
7. 工作目录位于允许的 Workspace Root；
8. Runtime Capability 满足任务策略；
9. 模型属于 supportedModels；
10. 项目/会议/私聊权限允许当前 Actor 触发。

Preflight 失败时：

- 不启动进程；
- 不创建外部 Job；
- 任务派发返回可操作错误；
- 已有历史 Run、会议消息和私聊消息保持只读可查。

Preflight 成功时保存不可变 Execution Envelope，包含 runtime revision、command/argv
digest、resolved capability、模型、沙箱和权限结果。

## 6. Adapter

### 6.1 通用接口

现有 `AgentRuntimeAdapter.execute(input, signal)` 继续作为统一入口。Adapter Factory
根据 Protocol 构造：

```ts
type ExternalAdapterFactory = (input: {
  runtime: ExternalRuntimeSnapshot;
  model?: string;
  reasoningEffort?: string;
}) => AgentRuntimeAdapter;
```

`RuntimeTaskInput` 扩展 Runtime Snapshot、Execution Envelope 摘要和受控 Runtime
选项。Adapter 只能写 stdout/stderr 相关事件，不能访问 Repository。

### 6.2 进程执行

```ts
spawn(command, [...managedArgs, ...customArgs], {
  cwd: workspacePath,
  env: allowlistedEnvironment(),
  shell: false,
  detached: process.platform !== "win32",
  stdio: ["pipe", "pipe", "pipe"],
});
```

约束：

- 禁止把整条 shell 命令作为字符串执行；
- 禁止 `shell: true`；
- 禁止管道、重定向、命令替换和 shell 展开；
- Command 必须是可执行文件；相对路径不得脱离受控 Workspace/Bin Root；
- argv token 单独校验和保存；
- stdin 只传递完整 Prompt，不拼接 shell；
- cwd 由 Worker 根据项目或私聊隔离目录生成，不能由客户端任意指定。

### 6.3 Codex JSONL

平台托管的协议 argv 由 Adapter 生成，注册数据不能覆盖关键参数：

```text
codex [managed base args] exec --json --cd <workspace>
  --sandbox <policy> --output-last-message <temp-file> -
```

映射：

- spawn/start -> `progress.summary`
- reasoning item -> 固定“推理阶段”摘要，不保存正文
- assistant message -> `delta` 或最终输出
- command/file change -> `tool.call` / `tool.result`
- session metadata -> Provider Session、模型、版本、认证和沙箱快照
- nonzero/parse error/empty final -> Run failed
- final message -> `completed`

### 6.4 Plain Text

契约：

```text
stdin: UTF-8 完整 Prompt
stdout: UTF-8 最终文本
stderr: 诊断
exit 0 + stdout non-empty: completed
exit 0 + stdout empty: failed
exit non-zero: failed
signal/abort: cancelled
```

plain-text 默认：

- `planVisibility = opaque`
- `toolEventCompleteness = none`
- `textStreaming = final-only` 或受限 message
- `subagentVisibility = none`

UI 必须显示“当前 Runtime 不提供结构化进度”，不能生成伪计划或伪工具事件。

## 7. Worker、Run 与幂等

### 7.1 正常执行

1. Worker claim Job。
2. 校验 Job/Lease 和 Run。
3. 执行 Preflight 二次校验。
4. 生成 ContextPack 和 Execution Envelope。
5. 标记 Run running，启动 Adapter。
6. 归一化事件写 RunEvent；Delta 可合并。
7. 最终输出写 Run，完成业务回写。
8. Job 完成，Effect 完成。

### 7.2 取消与超时

- API 只设置 Run/Job/Runtime Effect 的取消意图。
- Worker 检测到 cancel 后向进程组发送 SIGTERM，宽限期后 SIGKILL。
- 超时使用同一 AbortController 路径。
- Run 最终为 cancelled/timeout，业务消息和 Turn 使用既有单次回写规则。

### 7.3 重试

- Pre-spawn 的临时失败可安全重试。
- 进程已经 spawn 后，不允许自动 replay 或盲目重试，防止重复外部副作用。
- Worker 在 spawn 前持久化 `started` marker；租约丢失后若 marker 已存在，标记
  interrupted，并要求用户显式重新派发。
- 显式重试创建新的 Run/Effect，同时保留旧 Run 与失败信息。
- Job 重试、租约恢复和 Effect replay 不改变“每个 Task 消息/会议 Turn/私聊 Turn
  最多一条最终业务回写”的既有唯一约束。

### 7.4 事件归一化

RunEvent 是事实源。原始 stdout/stderr 只作为受限诊断，不替代归一化事件。
平台不保存私有推理正文；Provider Session ID 只用于诊断，不能替代平台授权。

## 8. API 与权限

Runtime 写操作当前要求平台管理员或显式 Runtime Owner；项目成员只能读取可用于当前
Agent 的安全投影。V1 的 `x-pluginmax-actor` 仍不是正式认证，Batch 13 不得把它包装成
更强的安全承诺。

所有写接口：

- 使用 expectedRevision；
- 使用 `Idempotency-Key`；
- 写 outbox/audit；
- 返回稳定错误码；
- 不返回敏感环境变量或完整进程日志。

停止或归档 Runtime：

- 立即阻止新 Preflight；
- 将绑定转 disabled；
- 是否取消在途 Run 按显式策略执行，默认取消；
- 历史 Run 和 Agent 输出保留。

## 9. GUI

新增 Runtime 管理视图：

- 列表：名称、Provider、Protocol、状态、可用性、Probe 时间、绑定数量。
- 表单：Command、argv token、模型池、默认模型、工具能力、网络/沙箱。
- Command preview 只读，不允许直接编辑 shell 字符串。
- Probe 按钮创建异步 Job，并显示 queued/running/passed/failed。
- 停用、归档、复原显示影响和二次确认。
- 审计时间线展示 Actor、changed fields 和结果。

AI 伙伴：

- 执行方式：内置 / 外部 Runtime；
- 外部 Runtime 只列 active、Probe 成功且兼容的项；
- 当前不可用绑定显示不可用原因；
- 停用或归档后不可新建派发。

Run 详情：

- Runtime、Provider、Protocol、模型、revision、Session、Trace；
- Capability 和降级说明；
- 进程启动/结束时间和退出码；
- 失败重试、取消和历史证据。

## 10. Migration 与兼容

Migration 21：

- 新增 Runtime、Probe、Capability、Binding、Event、Probe Job 表；
- Run 增加 nullable 外部执行字段；
- 不为旧 DSH 插件 KV 自动导入配置，因为无法安全推断命令权限和所有者；
- 不自动把 `runtime_kind = codex-jsonl | plain-text` 的 Agent 视为已绑定；
- 旧外部 Agent 数据保持原样，V1 只读取自己的 PostgreSQL 表。

兼容要求：

- Batch 8 维护/effect safety 不变；
- Batch 9 trace/backup 不变；
- Batch 10A 会议决策、10B Memory/Handoff/Episode 不变；
- Batch 11A 日报、11B 模板不变；
- Batch 12A 会议 AI 和 12B 私聊原有 Fake/DSH 路径不变；
- 旧 Run 缺新字段时按 null 读取。

## 11. 测试

- Adapter 单元测试：codex JSONL、plain-text、stderr、空输出、session、事件归一化。
- 安全测试：shell 元字符、管道、重定向、命令替换、非法 cwd、环境变量泄漏。
- Repository：状态机、revision、binding 唯一性、append-only audit。
- API：管理员权限、owner 权限、Probe 异步、绑定、Preflight。
- Worker：任务/会议/私聊三条链路、取消、超时、租约、interrupted、显式重试。
- Migration：20→21 和 0→21，旧 Run/会议/私聊/内存/模板可读。
- Playwright：注册、探测、绑定、不可用和 Run 降级；使用假 CLI，不依赖真实凭证。
- 全量 Vitest：独立 PostgreSQL，覆盖 Batch 8 至 12B。

## 12. 风险

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 外部 CLI 非沙箱 | 可读写宿主权限内文件 | OS 用户隔离、默认只读、显式授权 |
| 命令注入 | 执行任意指令 | argv 数组、shell=false、元字符拒绝、管理员权限 |
| Worker 崩溃后子进程遗留 | 重复副作用或资源泄漏 | 进程组、spawn marker、租约、人工重试 |
| Provider JSONL 变化 | 解析失败 | Protocol adapter 版本化、fixture 测试 |
| 凭据泄漏 | 账号风险 | 只依赖 CLI 登录态、环境白名单、日志截断 |
| 自动重试重复模型调用 | 重复外部动作 | spawn 后禁止自动 replay |
| Runtime 能力夸大 | 越权工具使用 | Capability 上限 + 任务策略 + Preflight |
| 本地 actor 非正式认证 | 权限边界有限 | 明确 V1 边界，后续统一身份授权 |

## 13. 回滚

1. 停用/归档外部 Runtime，Agent 切回内置；
2. 代码回滚 Batch 13 提交，不影响 Batch 12B；
3. Migration 新增表可保留，nullable Run 字段不影响旧读取；
4. 历史外部 Run 和审计保持只读；
5. 不删除旧 DSH 插件数据或正式 Session。
