# V1 Batch 10B: Context and Memory Closure

> 分支：`feat/v1-batch10b-memory-closure`
>
> 基线：`b46ec43c09b08ca3c29261a368c87c47f7987b86`
>
> 子批次：10B1 会议摄入与 Memory Review、10B2 Handoff Card 与 Episode。
>
> Migration：16

Batch 10B 在既有 PostgreSQL Memory 数据面上做向后兼容扩展。Batch 10A 的纪要版本、
行动项转换和任务闭环契约不变；Batch 9 的备份、trace 和 Worker effect 契约不变。

## 10B1. Meeting Ingestion and Memory Review

### Idempotent Ingestion

会议纪要发布后，同一已发布版本会生成待确认 Claim：

- 每场会议映射到稳定的项目 Memory Topic。
- Claim 的稳定去重键由纪要版本和有顺序的决策摘要组成。
- `(project_id, dedupe_key)` 唯一索引保证发布重放、并发请求和 Worker 重试不会重复生成。
- 来源快照保存会议、纪要版本、来源消息、行动项、任务、Run 和 Review 引用。
- 读取 Claim 时会再次解析当前来源，新增的行动项、任务、Run 和 Review 可进入来源链；
  被删除或跨项目的来源标记为不可用。

```text
POST /api/v1/meetings/:meetingId/memory/ingest
```

该入口用于幂等重试或刷新来源链，不追加新的纪要版本。

### Review Queue

```text
GET  /api/v1/projects/:projectId/memory/reviews
POST /api/v1/projects/:projectId/memory/reviews
GET  /api/v1/projects/:projectId/memory/claims/:claimId
```

Review 请求携带每个 Claim 的 `expectedVersion`：

- 数据库行锁和版本比较保证并发 Review 只有一个请求成功。
- 批量接受或拒绝在同一事务完成。
- 接受后，该 Topic 的已确认 Claim 形成新的 Current Truth 版本。
- 每条 Review 追加不可变记录，保存决定、原因、操作者、状态迁移、Claim 版本和来源快照。
- 拒绝必须提供原因；历史 Claim 和 Review 记录不被覆盖。
- 项目归档、越权项目、跨项目 Claim 和不存在的来源均被拒绝。

## 10B2. Handoff and Episode

### Handoff Card

`handoff_cards` 保存草稿、来源引用、乐观版本和确认状态。确认时追加
`handoff_confirmations` 快照：

- 草稿可编辑，确认后卡内容和确认记录不可变。
- 来源可关联 Task、Run、Review、Memory Claim、会议和会议行动项。
- 每个来源只保存稳定 ID、项目和必要标签；读取时解析可用性。
- 来源项目必须与 Handoff 项目一致。

```text
GET   /api/v1/projects/:projectId/handoffs
POST  /api/v1/projects/:projectId/handoffs
GET   /api/v1/projects/:projectId/handoffs/:handoffId
PATCH /api/v1/projects/:projectId/handoffs/:handoffId
POST  /api/v1/projects/:projectId/handoffs/:handoffId/confirm
```

### Agent Episode

`agent_episodes` 按项目、Agent 和可见性持久化：

- `private` 只对目标 Agent 读取；项目负责人也不能把它带入自己的视图。
- `project` 对项目成员可见。
- Worker 组装 ContextPack 时只读取当前项目和当前 Agent 的 Episode，不跨 Agent 或跨项目。

```text
GET  /api/v1/projects/:projectId/agent-episodes?agentId=...
POST /api/v1/projects/:projectId/agent-episodes
```

## GUI

项目记忆工作面提供四个分区：

- `Review 队列`：批量选择、接受、拒绝、原因、冲突恢复、加载/空/错误和只读状态。
- `Handoff`：草稿创建、关联 Task/Memory、确认和来源回查。
- `Agent Episode`：项目可见 Episode 和按 Agent 的空状态。
- `Topic 与 Truth`：既有 Topic、Claim 和 Current Truth 时间线。

来源按钮使用平台深链返回会议或任务；移动端不产生横向溢出。

## Database

Migration 16：

- 扩展 `memory_topics` 和 `memory_claims`，旧记录获得安全默认值。
- 新增 `memory_claim_reviews`、`handoff_cards`、`handoff_confirmations` 和 `agent_episodes`。
- 为 Review、确认记录和已确认 Handoff 增加不可变触发器。
- 不修改 `runs`、`run_events`、`jobs`、`job_attempts`、备份脚本或 trace 关联列。

## Validation

```bash
pnpm check
TEST_DATABASE_URL=postgres://127.0.0.1:54410/pluginmax pnpm test
./scripts/memory-closure-postgres-smoke.sh
./scripts/memory-closure-smoke.sh
git diff --check
```

定向 Playwright 只运行 `e2e/memory-closure.spec.ts`。API/Worker smoke 同时验证：

- 发布纪要自动生成 Review Claim。
- 接受后生成 Current Truth。
- Worker Run 的 ContextPack 带入当前项目 Agent Episode。
- Handoff 草稿确认和不可变确认记录。
- 来源跳转、加载/空态和移动端布局。
