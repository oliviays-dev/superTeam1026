# V1 Batch 13D: External Runtime Run Execution

> 状态：已实现
>
> 分支：`feat/v1-batch13-external-agent-runtime`
>
> Migration：23

## 交付范围

- Task、Workflow Task、Meeting AI 和 AI Direct Chat 在创建 Run 前执行 13C
  Binding + Preflight。
- Run 持久化不可变外部执行快照，包括 Runtime/Binding revision、受控 command/argv、
  command/args digest、模型、Capability 和 Execution Envelope preview。
- Run 增加外部 Runtime 投影、Provider Session、Runtime version 和 spawn marker。
- RunExecutor 根据持久化快照构造 `CodexJsonlAdapter` 或 `PlainTextAdapter`，
  不依赖 `Agent.runtime_kind` 作为绑定证明。
- Worker 在启动外部进程前重新执行只读 Preflight，并核对 Binding revision、
  Runtime revision、Capability snapshot 和 digest。
- spawn marker 一旦存在，后续 Worker 尝试直接进入不可重试失败路径，避免自动
  重放可能产生外部副作用的任务。
- 外部 Run 沿用既有 Effect、Job lease、cancel、timeout、Task/Meeting/Direct Chat
  单次回写和 Trace 语义。
- Provider Session、版本和元数据只作为诊断持久化；reasoning 正文不进入数据库、
  RunEvent 或输出。

## 执行边界

```text
API / Application
  -> Binding + Preflight
  -> Run.execution_snapshot
  -> Job
  -> Worker claim
  -> Preflight revalidation
  -> mark external_started_at
  -> Adapter spawn
  -> normalized RunEvent
  -> existing business settlement
```

API 进程不执行 `spawn`。外部进程只由 Worker 的 Adapter 创建，使用
`shell: false` 和固定 argv。

## 协议行为

- `codex-jsonl`：持久化 Provider Session、版本、Provider、sandbox 和工具事件；
  reasoning 只保留固定阶段摘要。
- `plain-text`：Run observability 为 final-only；不伪造 plan 或 tool 事件。
- 取消：Runtime Effect 请求通过现有控制轮询传播到 Adapter AbortSignal。
- 超时：Run timeout 使用同一 AbortSignal 路径，最终 Run 为 `timeout`。
- 启动后失败或 Worker 中断：`external_started_at` 阻止自动第二次 spawn；
  不自动 resume Provider Session。

## 明确未包含

- Agent Binding GUI、Runtime 管理 GUI 扩展和 Run 详情 UI。
- Provider Session resume。
- 远程 Daemon、跨机器调度、容器编排和凭据存储。
- 细粒度 TaskExecutionPolicy 到 Preflight 的完整推导；当前外部派发使用 Runtime
  Capability 上限，不额外扩大项目或任务授权。
- 已启动进程的跨 Worker 恢复；按安全原则要求人工显式重新派发。

## 测试

- Migration 22→23 和 Run 外部字段兼容。
- Codex JSONL Task 成功执行、Session/Version 持久化和 reasoning 不泄漏。
- plain-text Direct Chat 成功回写。
- Codex Meeting AI 成功回写。
- Direct Chat 外部进程取消、Task 外部进程超时。
- spawn marker 存在时结算为 failed Effect，不再次启动 Adapter。
- 非重试外部错误立即 dead-letter，不由 Job 退避策略再次 spawn。
- 未绑定或无效外部 Binding 在 Run 创建前返回 13C 稳定错误码。
