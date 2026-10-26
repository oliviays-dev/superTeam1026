# V1 Batch 10A: Meeting Decisions to Tasks

> 分支：`feat/v1-batch10a-meeting-decisions`
>
> 基线：`bb61af6df79f5241cc1b6c5a5348b11bb75110c2`
>
> 子批次：10A1 纪要版本与发布、10A2 行动项与任务闭环。
>
> Migration：15

Batch 10A 只扩展平台会议、任务和 Memory 的关联数据面。旧会议、任务、Run、Review、
Memory、备份和 trace 契约保持可读；Batch 9 的 source/PostgreSQL 备份格式、manifest
字段和 W3C trace 关联字段未改动。

## 10A1. Minutes Draft and Immutable Publication

### Data Model

- `meeting_minutes_drafts`：每场会议一条可变草稿，保存正文、结构化决策、来源消息、
  optimistic revision 和最后编辑人。
- `meeting_minutes_versions`：发布会追加不可变版本，版本号按会议单调递增，保存完整
  正文、决策、来源消息、发布人和发布时间。
- 数据库触发器拒绝更新已发布版本；应用不提供修改或覆盖历史版本的 API。
- Migration 15 为既有会议补齐草稿；非空历史 `summary` 回填为版本 1。

### API

```text
GET  /api/v1/meetings/:meetingId/minutes
PUT  /api/v1/meetings/:meetingId/minutes/draft
POST /api/v1/meetings/:meetingId/minutes/publish
```

保存和发布都必须携带 `expectedRevision`。并发写入只有一个请求成功；旧 revision 返回
`409 meeting_minutes_revision_conflict`，并在 `details.currentRevision` 暴露最新游标。
发布后草稿 revision 继续递增，避免重放旧发布请求生成重复版本。

来源消息必须属于当前会议。发布时把草稿正文、决策和来源消息完整复制到版本行，之后
修改草稿不会改变历史版本。

## 10A2. Action Items and Task Closure

### Action Item Contract

行动项保存：

- 标题、说明、负责人和负责人类型。
- 截止时间与优先级 `low|medium|high|urgent`。
- 来源类型 `manual|message|minutes_version`、来源 ID、已发布版本和来源消息。
- 状态 `open|in_progress|done|cancelled`。
- 会议内唯一去重键；未提供时根据标题、负责人和截止时间生成稳定摘要。
- 转换后的 `taskId`、执行 AI、转换人和转换时间。

负责人必须是当前项目活跃成员。来源消息必须属于会议；`minutes_version` 来源必须指向
该会议已发布版本。

### Idempotent Conversion

```text
POST /api/v1/meetings/:meetingId/action-items/:actionItemId/convert
```

转换在数据库事务中锁定行动项，并在同一事务创建 `queued` 任务和 `task_events.created`
审计行。并发或重复转换返回同一个任务，第二个请求标记 `reused=true`。行动项状态随后
由关联任务驱动：转换或退回时为 `in_progress`，验收通过为 `done`，任务取消为
`cancelled`。

转换会拒绝：

- 非项目 owner 的 Actor。
- 已归档项目。
- 已停用或不可执行的 AI。
- 非活跃 AI 项目成员。
- 已取消行动项。
- 跨会议或跨项目 action item ID。

### Association Query

```text
GET /api/v1/meetings/:meetingId/traceability
```

返回会议已发布版本、行动项、关联任务状态、全部 Run、Review 决策和由任务验收写入的
Memory Truth。来源链为：

```text
Meeting
  -> Minutes Version / Source Messages
  -> Action Item
  -> Task
  -> Run
  -> Review
  -> Memory
```

GUI 在会议工作面内提供“纪要 / 行动项 / 闭环”三个页签。冲突会显示服务端稳定错误文案
并提供“载入最新修订”；无发布版本、无行动项、无活跃 AI、无 Run/Review/Memory 时显示
对应空状态。

## Database and Compatibility

Migration 15 只新增会议决策表、索引和版本不可变触发器，并回填既有会议纪要。它不修改：

- `runs`、`run_events`、`jobs`、`job_attempts` 的 trace 列或约束。
- `runtime_effect_receipts`、`runtime_maintenance_runs` 的 trace 契约。
- `scripts/backup.sh`、备份目录结构、manifest 或 SHA256 清单。
- 正式 Profile、正式数据库或 DSH Session。

## Validation

```bash
pnpm check
TEST_DATABASE_URL=postgres://127.0.0.1:54400/pluginmax pnpm test
./scripts/meeting-decisions-postgres-smoke.sh
./scripts/meeting-decisions-smoke.sh
```

`meeting-decisions-smoke.sh` 使用 Compose 项目 `pluginmax-batch10a`、端口 `54400`、
临时数据库、独立 `DSH_HOME`，启动 API、Worker 和 Web 后：

- 完成两版纪要发布和来源消息关联。
- 从已发布纪要创建行动项并转换、派发。
- 等待 Run 完成、执行 Review、确认 Memory 写入。
- 只运行 `e2e/meeting-decisions.spec.ts`。

独立 Vitest PostgreSQL 集成覆盖并发发布冲突、不可变历史、越权会议、跨项目行动项、
归档项目、停用 AI 和并发重复转换。
