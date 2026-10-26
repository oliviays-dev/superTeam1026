# V1 Batch 13A: External Runtime Registry, Probe & Audit

> 状态：已实现
>
> 分支：`feat/v1-batch13-external-agent-runtime`
>
> 基线：`7e85bc8b1faa89ee6e016928b191353dc14715a7`
>
> Migration：21

## 交付范围

- PostgreSQL 新增 `external_runtimes`、`external_runtime_probes`、
  `external_runtime_capabilities`、`external_runtime_events` 和
  `runtime_probe_jobs`。
- Runtime 注册、编辑、启停、归档和复原；所有变更使用 revision 乐观锁。
- Command 与 argv 分离。HTTP 输入拒绝 shell 字符串、管道、重定向、命令替换、
  控制字符和 shell 解释器。
- 新 Runtime 默认为 `disabled`。启用前必须有当前 revision、当前 command/argv
  digest 对应的成功 Probe。
- Command、managed argv 或 custom argv 变化时删除旧 Probe、Probe Job 和
  Capability，Runtime 回到 `disabled`。
- `POST /api/v1/runtimes/:runtimeId/probe` 只写 Probe、Probe Job 和 Outbox，
  返回 `202`，不执行子进程。
- Worker 使用固定 `--version` argv、`shell: false`、受限环境和工作区执行 Probe。
- Probe 终态不可更新；治理事件只追加；Capability 快照不可更新。
- Adapter、Config、Probe 三类能力来源合并为 Effective Capability。
- Runtime Owner 或平台管理员可写；其他账号只能读取明确标记为 `platform`
  的 Runtime。
- Runtime 管理 GUI 支持列表、表单、argv token 编辑、Probe 状态、不可用原因、
  状态操作和治理事件。

## 明确未包含

- 外部 Runtime Adapter。
- AI 伙伴外部 Runtime 绑定与 Preflight。
- 外部 Runtime Run/Worker 执行、取消、Session 和输出归一化。
- 旧 DSH 插件 KV Runtime 自动导入。

因此 `codex-jsonl` 和 `plain-text` 任务派发在本批之后仍返回
`runtime_adapter_unavailable`，直到后续 Batch 13 阶段完成 Adapter 与绑定。

## API

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
```

## 验证

- Contracts：Command/argv 安全、Provider/Protocol、状态机、Capability 合并。
- PostgreSQL Vitest：CRUD、revision、状态机、Probe Job、审计、跨账号权限。
- Worker：真实受控 `--version` Probe、成功/失败回写、Capability、Outbox。
- Migration 20→21：五张新表、触发器、索引、旧数据保留、旧 Runtime 导入数为零。
- 独立 API/Worker/Web smoke：`4479/4420`、PostgreSQL `54422`。
- Playwright：Runtime 管理场景与 390px 无横向溢出检查。
