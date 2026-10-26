# V1 Batch 13: External Agent Runtime Integration

> 状态：Batch 13A、13B、13C、13D 已实现；GUI 与发布门禁待后续阶段
>
> 分支：`feat/v1-batch13-external-agent-runtime`
>
> 基线：`7e85bc8b1faa89ee6e016928b191353dc14715a7`
>
> Migration：23

## 1. 当前结论

旧 DSH 插件层的外部 Agent 和 Runtime 代码仍在仓库中：

- `plugins/dsh-collab-agent/src/external.ts` 已有
  `ExternalAgentProcessRunner`、`codex-jsonl`、`plain-text`、stdin/stdout、
  进度、取消、Runtime 探测和终端 trace；
- 旧插件已经有外部 Runtime 注册、编辑、启停、归档、复原、探测和 Agent Profile
  绑定逻辑；
- 这些能力通过插件 KV 表 `external_runtimes` 和 `/api/collab/agent/...` 暴露，
  执行结果写回旧 AgentRun 与旧任务执行历史。

Pluginmax Platform V1 已完成 Batch 13A-D：

- PostgreSQL 具备 Runtime、Probe、Capability、治理事件和 Agent Binding；
- `/api/v1/runtimes` 与 Agent Binding/Preflight API 已交付；
- Task、Workflow Task、Meeting AI 和 AI Direct Chat 可持久化外部执行快照；
- Worker 可按快照启动 `codex-jsonl` 或 `plain-text` Adapter；
- 取消、超时、失败、Session 诊断和既有业务回写使用统一 Run/Effect/Job 链路；
- spawn marker 阻止启动后的自动重放，reasoning 正文不持久化。

剩余工作集中在 GUI、TaskExecutionPolicy 深化、发布门禁和全量兼容验收。

## 2. 目标

1. 在 V1 Platform 内建立独立的外部 Runtime 管理域。
2. 支持受控的 `codex-jsonl` 和 `plain-text` 外部 Runtime Adapter。
3. AI 伙伴可以绑定外部 Runtime，并继续作为任务、会议和私聊的统一 Agent 身份。
4. 所有派发先经过 Runtime 状态、探测结果、能力、绑定和权限 Preflight。
5. API 只写业务数据、Run、Job 和 Outbox；模型或 CLI 子进程只由 Worker 启动。
6. 外部输出归一化为平台 RunEvent，并明确声明结构化进度能力边界。
7. 取消、超时、失败、Session、Trace 和幂等回写继续使用 V1 统一执行面。
8. 管理动作和 Runtime 变更具备权限控制与不可变审计。

## 3. 非目标

- 不直接复用旧插件的 `/api/collab/agent/...` API 或插件 KV 存储。
- 不把旧 AgentRun 表、插件 Session 或旧任务执行投影复制进 V1。
- 不允许浏览器、API Route 或 Application Service 直接启动外部进程。
- 不支持任意 shell 字符串、管道、重定向、命令替换或 shell 展开。
- 第一版不提供远程 Daemon、跨机器调度、容器编排或 MCP 配置注入。
- 第一版不自动恢复已经启动后因 Worker 崩溃而中断的外部进程。
- 第一版不保存 Provider 凭据，继续依赖执行机器上的 CLI 登录态。
- 不默认开放写文件、公开网络或危险沙箱；能力声明不代表本轮授权。
- 不改变 Batch 12A/12B 的会议发言或私聊会话语义；外部 Runtime 只是新的执行通道。

## 4. 现状与目标边界

| 能力 | 旧 DSH 插件 | V1 当前 | Batch 13 目标 |
| --- | --- | --- | --- |
| Runtime 定义 | 插件 KV `external_runtimes` | 无 | Migration 21 PostgreSQL 表 |
| Provider / Protocol | codex、workbuddy、command；两种协议 | 契约/UI 占位 | V1 Provider + Protocol 受控枚举 |
| 注册和管理 API | `/api/collab/agent/...` | 无 | `/api/v1/runtimes` |
| 探测 | `--version` 进程探测 | 无 | Worker/管理服务异步探测与结果审计 |
| Agent 绑定 | 旧 Profile `externalRuntimeId` | Agent 只有 `runtime_kind` | 独立绑定表与 revision |
| Preflight | 旧 Agent 服务内校验 | Fake/DSH 固定集合校验 | Runtime 能力、状态、探测、权限统一校验 |
| CLI Adapter | `ExternalAgentProcessRunner` | 仅 fake/dsh-sdk | V1 Worker Adapter |
| 事件 | 旧执行事件/终端 trace | 平台 RunEvent | JSONL/plain-text 归一化 RunEvent |
| 取消 | 子进程 signal + 旧 cancel | Runtime effect 控制 | AbortSignal + 进程组终止 + Run 结算 |
| Session | Provider session ID | DSH SDK 内部 Session | Runtime Session 快照与诊断字段 |
| 存储 | 插件 KV | 无 | PostgreSQL + Outbox + Job |

旧实现可以复用协议解析、参数生成、进程终止和安全经验，但 Runner、存储、API、
权限、Run 结算和 UI 必须重新实现和验证，不能直接搬运旧服务。

## 5. 分阶段实施

### Phase 0: 契约与安全基线

依赖：Batch 12B 完成。

- 冻结 Runtime Provider、Protocol、状态和 Capability 枚举。
- 定义 Command/argv 校验、允许的环境变量、工作目录和输出上限。
- 定义 Runtime 不可用、探测失败、能力不足和命令不合规的统一错误码。
- 明确“能力声明上限”和“本轮策略授权”是两层校验。
- 完成 Migration 21 设计评审。

退出条件：安全边界、数据模型和 API 契约评审通过。

### Phase 1: Runtime 注册、探测与审计（Batch 13A 已完成）

依赖：Phase 0。

- 新增 Runtime Repository 与 Migration 21。
- 实现创建、编辑、启停、归档、复原、探测和治理事件。
- Command 变化后清空旧 Probe，防止旧探测结论被复用。
- Runtime 停用或归档时阻止新派发；已运行 Run 按策略取消或允许收敛。
- 探测只能使用受控 argv，不允许 shell。

退出条件：API/Repository 测试通过，审计与状态机可回放。

### Phase 2: V1 Runtime Adapter（Batch 13B 已完成）

依赖：Phase 0、Phase 1。

- 在 `@pluginmax/agent-runtime` 增加 `CodexJsonlAdapter` 与 `PlainTextAdapter`。
- 使用 `spawn(command, argv, { shell: false })`，stdin 投递完整 Prompt。
- Codex JSONL 归一化为 progress、tool、assistant、warning、completed/error。
- plain-text 归一化为开始、最终文本、stderr 诊断和终态。
- 记录 Provider Session、模型、版本、认证模式、沙箱、耗时和退出信息。
- AbortSignal 触发进程组终止；超时和取消沿用 Worker Run 状态机。

退出条件：适配器单元测试、假 CLI 测试、取消和超时测试通过。

### Phase 3: Agent 绑定与 Preflight（Batch 13C 已完成）

依赖：Phase 1、Phase 2。

- AI 伙伴可显式绑定一个外部 Runtime；未绑定时保持现有内置行为。
- Agent 绑定改为独立记录并保留 revision。
- 派发前校验 Agent 状态、Runtime 状态、Probe、命令、协议、Capability、
  项目权限和任务策略。
- Preflight 结果进入 Run 输入/执行快照，失败不创建外部进程。
- Runtime 不可用原因必须可操作：未绑定、停用、归档、探测失败、能力不足。

退出条件：任务、会议和私聊派发均使用同一 Preflight。

### Phase 4: Worker/Run/Outbox 执行闭环（Batch 13D 已完成）

依赖：Phase 2、Phase 3。

- `RunExecutor` 根据绑定解析对应 Adapter。
- API 只创建 Run、Job 和 Outbox；Worker 持有进程生命周期。
- RunEvent 保存归一化过程，Run 保存最终输出、错误和执行快照。
- 外部 Session ID 只作诊断；第一版不自动 resume。
- 已启动后 Worker 崩溃或租约丢失标记 interrupted，不盲目重放外部模型调用。
- Job 重试和 Runtime effect replay 不得产生重复任务消息、会议发言或私聊回复。

退出条件：任务、会议、私聊三条 Worker 链路均通过外部假 CLI 集成测试。

### Phase 5: API 与 GUI

依赖：Phase 1、Phase 3、Phase 4。

- 增加 `/api/v1/runtimes` 管理和探测接口。
- AI 伙伴页面增加“外部 Runtime”绑定与不可用原因。
- 增加运行时管理视图：Provider、Protocol、受控 command preview、argv、模型池、
  工具能力、状态、Probe、绑定数量、审计。
- Run 详情展示 Runtime、Provider、Protocol、模型、Session、能力降级和诊断。
- plain-text 明确显示 final-only，不渲染伪造的 plan/tool 步骤。

退出条件：桌面和 900px 以下无横向溢出，API 错误可指导修复。

### Phase 6: 兼容与发布门禁

依赖：Phase 1 至 Phase 5。

- 验证 Batch 8、9、10A、10B、11A、11B、12A、12B 回归。
- Migration 20→21 smoke、全新 `0→21` smoke。
- 只运行外部 Runtime 场景的 Playwright，同时保留全量回归。
- 验证 Agent 停用、Runtime 归档、Probe 失败和历史 Run 可读。
- 验证 Fake/DSH SDK/外部 Runtime 混用不会改变既有派发语义。

退出条件：验收标准全部满足，无 P0/P1 缺陷。

## 6. 数据模型

### 6.1 `external_runtimes`

- `id`、`name`、`provider`、`protocol`
- `command`、`managed_args`、`custom_args`
- `supported_models`、`default_model`、`context_window_tokens`
- `supported_tools`、`network_mode`、`sandbox_mode`
- `status`：`active | disabled | archived`
- `owner_id`、`visibility`、`revision`
- `last_probe_id`、`last_probe_at`、`last_probe_ok`、`last_probe_message`
- `created_at`、`updated_at`、`archived_at`

### 6.2 `external_runtime_probes`

- Runtime ID / revision / command digest / argv digest
- 探测开始、结束、耗时和结果
- 退出码、stdout/stderr 截断摘要
- Actor、错误码和不可变时间

### 6.3 `external_runtime_capabilities`

- Runtime ID / revision
- Adapter 能力、配置声明能力、Probe 观测能力
- 合并后的 Effective Capability
- captured_at 和来源版本
- 每个 Runtime revision 至少一条不可变快照

### 6.4 `external_runtime_events`

- `registered | updated | probed | enabled | disabled | archived | restored | bound | unbound`
- 前后状态、changed fields、Actor、关联 Runtime / Agent 和创建时间
- 只追加，不更新或删除

### 6.5 `agent_runtime_bindings`

- Agent ID、Runtime ID、`execution_mode`
- `active | disabled`、revision、绑定人和时间
- 同一 Agent 同时只有一条有效外部绑定
- 停用/归档 Runtime 时绑定转 disabled，不删除历史

### 6.6 `runtime_probe_jobs`

- Probe ID、状态、attempts、available_at
- Worker lease owner/token/expiry
- 最后错误、创建和更新时间
- 与 `domain_outbox` 的 `runtime.probe` 消息配合，由 Worker 领取

### 6.7 Run / Event

- Run 保存 Runtime ID、revision、Provider、Protocol、Capability snapshot 和执行快照。
- Run 保存 Provider Session ID、command/argv digest 和 auth/sandbox 观测值。
- RunEvent 保存归一化事件来源与能力降级信息。
- 原始 stdout/stderr 只保存受限长度或受限引用，不默认对所有角色公开。

## 7. API 规划

```text
GET    /api/v1/runtimes
POST   /api/v1/runtimes
GET    /api/v1/runtimes/:runtimeId
PATCH  /api/v1/runtimes/:runtimeId
POST   /api/v1/runtimes/:runtimeId/probe
POST   /api/v1/runtimes/:runtimeId/enable
POST   /api/v1/runtimes/:runtimeId/disable
POST   /api/v1/runtimes/:runtimeId/archive
POST   /api/v1/runtimes/:runtimeId/restore
GET    /api/v1/runtimes/:runtimeId/events
GET    /api/v1/runtimes/:runtimeId/capabilities

GET    /api/v1/agents/:agentId/runtime-binding
PUT    /api/v1/agents/:agentId/runtime-binding
DELETE /api/v1/agents/:agentId/runtime-binding
POST   /api/v1/agents/:agentId/runtime-preflight
```

写接口使用 revision/expectedRevision 与 `Idempotency-Key`。Probe 是异步 Job，不在
HTTP Route 内直接执行命令。普通项目成员只能读取可用 Runtime 投影；注册、编辑、
探测、启停和归档要求平台管理员或受信 Runtime Owner。

## 8. 模块改动

- `packages/contracts`: Runtime、Probe、Binding、Capability、执行快照和 API schema。
- `packages/database`: Migration 21、Runtime/Binding/Probe/Event Repository。
- `packages/application`: Runtime 管理、Preflight、绑定和派发门禁。
- `packages/agent-runtime`: Codex JSONL 与 plain-text Adapter、事件归一化。
- `packages/application/src/run-executor.ts`: Adapter 解析、Execute、取消和回写。
- `apps/worker`: Probe Job 与外部 Runtime Job 生命周期。
- `apps/api`: `/api/v1/runtimes` 和 Agent Binding 路由。
- `apps/web`: Runtime 管理视图、AI 伙伴绑定、Run 能力降级展示。

## 9. 安全边界

1. Command 和 args 分开保存；执行使用 argv 数组与 `shell: false`。
2. 拒绝 shell 元字符、管道、重定向、命令替换和 NUL；不调用 shell 解释器。
3. Command 必须由管理员配置，Preflight 校验可执行文件、权限和工作目录。
4. 工作目录必须位于隔离 Workspace Root；禁止任意 cwd。
5. 环境变量使用白名单，不把密钥写入数据库、RunEvent 或日志。
6. 默认只读沙箱；文件写、公开网络和工具体系必须显式授权。
7. Runtime 声明的工具能力是上限，不是本轮授权。
8. 不持久化私有推理正文；reasoning 只记录“发生推理阶段”的摘要。
9. stdout/stderr、诊断和 Prompt 设置长度上限与访问级别。
10. Probe 只能执行受控的 `--version` 或等价探测 argv。
11. 已启动外部进程后不自动 replay，避免重复外部副作用。
12. 所有管理动作和外部执行保留 Actor、Trace、Run 和审计链。

## 10. 验收标准

- 管理员可注册、探测、启停、归档和复原 `codex` 与通用命令 Runtime。
- 非管理员不能修改 Runtime 或绑定其他账号的 Agent。
- 含 shell 拼接或非法 argv 的定义被拒绝，API 不产生任何外部进程。
- AI 伙伴可绑定 active 且 Probe 通过的 Runtime。
- Runtime 停用、归档、Probe 失败、能力不足时派发前返回稳定错误码和修复建议。
- 任务、会议 AI 发言和 AI 私聊均可由 Worker 通过外部假 CLI 执行。
- API 在 POST 阶段不启动模型或子进程，只写业务数据、Run、Job 和 Outbox。
- codex-jsonl 产生可用 progress/tool/final 事件，不泄漏 reasoning 正文。
- plain-text 明确显示 final-only，不生成虚假结构化步骤。
- 取消、超时、非零退出、空 stdout、Worker 崩溃和重试均有明确 Run/消息状态。
- Job 重试、租约恢复和 Runtime effect replay 不产生重复 Task 消息、会议发言或私聊回复。
- Runtime Capability、Execution Envelope、Provider Session 和 Run/Trace 可在详情中追溯。
- Migration 20→21 保留旧 Agent、Run、Trace、ContextPack、会议和内存数据。
- Batch 8、9、10A、10B、11A、11B、12A、12B 全量回归通过。
- 900px 以下 Runtime 管理页和 AI 伙伴绑定 UI 无横向溢出。

## 11. 测试规划

- Contracts：Command/argv、状态机、Capability、Probe、绑定 schema。
- Database：Runtime CRUD、revision、审计、迁移、绑定唯一性。
- Runtime Adapter：假 codex JSONL、plain-text、stderr、空输出、取消、超时、能力降级。
- API：权限、命令注入拒绝、探测 Job、绑定、Preflight、停用/归档。
- Worker：任务、会议、私聊三条链路；取消、租约、重试和幂等回写。
- GUI：注册、探测、启停、绑定、不可用原因、Run 降级展示。
- Playwright：只跑外部 Runtime 场景，使用假 CLI；不得依赖真实模型凭证。
- 兼容：独立 PostgreSQL 全量 Vitest、Migration 20→21、旧会议/旧 Run/旧私聊读取。

## 12. 排期与依赖

Batch 12B 已在 `d39a11bec0eadd4ed4f542837f85c9e701f94049` 收口。Batch 13 从该
提交创建独立 worktree 和分支，不改写 Batch 12B 的代码、Migration、测试或提交。

执行顺序固定为：

```text
Batch 12B（已完成）
  -> Batch 13 Phase 0/1：契约、Migration 21、Runtime 管理
  -> Batch 13 Phase 2/3：Adapter、Agent 绑定、Preflight
  -> Batch 13 Phase 4：Worker/Run/Outbox 执行
  -> Batch 13 Phase 5/6：GUI、迁移、全量兼容和 Playwright
```

Phase 1 与 Phase 2 可并行，但 Phase 3 必须在两者后开始；Phase 4 不得先于统一
Preflight；Phase 5 可以在 Phase 3 后先行开发，但发布门禁必须等待 Phase 4/6。
