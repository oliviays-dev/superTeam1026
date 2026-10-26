# V1 Batch 13C: External Runtime Binding & Preflight

> 状态：已实现
>
> 分支：`feat/v1-batch13-external-agent-runtime`
>
> Migration：22

## 交付范围

- PostgreSQL 新增 `agent_runtime_bindings`，保留不可覆盖的绑定历史。
- 每个 Agent 通过 partial unique index 最多拥有一条 `active` 外部绑定。
- 绑定与解绑使用 `expectedRevision`，写接口支持 `Idempotency-Key` 重放。
- Runtime `disable`/`archive` 在同一个事务内把活动绑定转为 `disabled`，
  并写入 `unbound` 审计事件；重新启用 Runtime 不自动恢复绑定。
- `external_runtime_events` 增加 nullable `agent_id` 与 `bound`/`unbound` 事件类型。
- 新增只读 Preflight Service，复用 `RuntimeCapabilityProfile`、
  `ExecutionEnvelope` 和 `ExecutionPreflightResult`。
- Preflight 输出绑定 revision、Runtime revision、Capability snapshot 和
  Execution Envelope preview，不持久化 Run、Task、Meeting、Direct Chat 或 Job。

## API

```text
GET    /api/v1/agents/:agentId/runtime-binding
PUT    /api/v1/agents/:agentId/runtime-binding
DELETE /api/v1/agents/:agentId/runtime-binding
POST   /api/v1/agents/:agentId/runtime-preflight
```

`PUT` 输入：

```json
{
  "runtimeId": "uuid",
  "expectedRevision": 0
}
```

`DELETE` 输入：

```json
{
  "expectedRevision": 1
}
```

Preflight 输入包含 `expectedRevision`、受控 `workspaceId`、可选模型、推理强度、
所需 Capability、sandbox 和 network 要求。Preflight 是只读操作，不写幂等收据；
绑定写接口使用现有 Idempotency-Key 收据。

绑定写权限限于 Runtime Owner 或平台管理员。普通成员可读取平台可见 Runtime 的
绑定并执行只读 Preflight；私有 Runtime 返回 `runtime_forbidden`。

## Preflight 校验

Preflight 依次校验：

1. Agent 存在且 active；
2. 绑定存在且 active；
3. Runtime 存在、active、非 archived；
4. 当前 Probe 由 Runtime 引用、通过，且 command/args digest 匹配；
5. 协议、模型池和默认模型；
6. Effective Capability、sandbox 和 network；
7. 相对工作区标识未越界；
8. Actor 可读取绑定 Runtime。

失败返回稳定错误码，并在 `details.remediation` 提供可操作修复建议。成功结果包含
不可变快照内容与可复用的 Execution Envelope preview。

## 明确未包含

- `RunExecutor` 外部 Adapter 派发。
- 真实 Codex、外部模型或 Provider Session 执行。
- Task、Meeting、Direct Chat 的外部执行回写。
- Agent Binding GUI。
- 项目成员、会议或私聊的完整业务授权推导。

因此任务派发中的 `codex-jsonl` 和 `plain-text` 仍返回
`runtime_adapter_unavailable`。显式 Binding 不会改变 Worker 已实现 Runtime 集合，
`Agent.runtime_kind` 也不会被当作绑定或执行许可。

## 已知限制

- Preflight 的 workspace 校验是数据库侧的相对标识校验，不读取文件系统；实际
  cwd 仍应由未来 Worker 在本机 Workspace Root 内生成。
- 权限沿用 V1 的 `x-pluginmax-actor` 开发身份边界，不等价于正式认证。
- Preflight 只校验 Runtime 能力上限，本轮任务策略和项目范围的细粒度推导留给
  RunExecutor/Worker 接入阶段。
