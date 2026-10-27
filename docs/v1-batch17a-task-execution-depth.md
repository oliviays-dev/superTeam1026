# V1 Batch 17A：Task Execution Depth

> 状态：Batch 17A 已完成；Batch 13.1B 已由后续独立批次完成。Batch 17B、
> Shared Space、sandbox、Lane 级路径写权限和 Global Write 仍未实现。

## 1. 基线

- 基线 worktree：`.tmp/pluginmax-platform-batch13.1a-runtime-compatibility`
- 基线分支：`feat/v1-batch13.1a-runtime-compatibility`
- 基线 HEAD：`f65f6745bbd30eb897f7bce3670f79717c992c96`
- 工作 worktree：`.tmp/pluginmax-platform-batch17a-task-execution-depth`
- 工作分支：`feat/v1-batch17a-task-execution-depth`
- 独立 PostgreSQL：`127.0.0.1:54429`

开始前已只读确认基线 worktree、分支、HEAD 和干净 status。所有 `DSH_HOME`、
FileStore、Agent Workspace、日志、截图和 fixture 均位于当前 worktree `.tmp`。
本批未读取正式数据库、正式 Session/Profile、原始 `dsh-pluginmax` 或历史业务数据。

## 2. 持久化模型

Migration 28 为 additive migration，扩展：

- `tasks`
  - `priority`：`low` / `medium` / `high` / `urgent`
  - `auto_submit`、`auto_accept`、`auto_redispatch_on_return`
  - `revision`
  - `needs_input_prompt`、`blocked_reason`、`paused_reason`
  - execution claim token、owner、lease expiry
  - 状态新增 `paused` / `blocked` / `needs_input`
- `runs`
  - `task_execution_kind`：`owner` / `collaborator`
  - `task_trigger_message_id`
- `task_messages`
  - `delivery_target`：`receiver` / `collaborators` / `broadcast`
  - mention Agent IDs 与 trigger Run IDs
- `task_attachments`
  - 项目内 task-scoped `document_path`
- `scene_sessions`
  - reset reason、actor 和 timestamp
- `task_events`
  - claim、control、input、session 事件类型

Queue 排序固定为 priority 降序、createdAt 升序、id 升序。依赖未完成、项目归档、
暂停、阻断、needsInput、活动 Run 或有效 Claim 都会阻止 queue Claim。

### Migration 与回滚

- fresh：`0 -> 28` 通过。
- upgrade：`27 -> 28` 通过。
- backfill：
  - 历史 Task 默认 `medium` priority、自动提交开启、自动验收关闭；
  - 历史 Run 默认 `owner`；
  - 历史 Task Message 的 deliveryTarget 为空，mention/run IDs 为空；
  - 历史 Task Attachment 回填为 `documents/<attachmentId>/content`。
- 历史已启动 Run 的 Envelope、Ticket、Scene Session 和 Receipt 内容不变。
- rollback 删除新增列、索引、约束并将 task event kind 约束恢复为 Migration 27。
  rollback 前若已有 `paused` / `blocked` / `needs_input` Task 行，必须先归档或迁回
  `queued`；否则禁止 rollback，避免旧约束失败时静默丢状态。

## 3. 队列、Claim 与控制

- `GET /api/v1/projects/:projectId/task-queue`
  - 返回稳定位置、`eligible` 和 blocked reasons。
- `POST /api/v1/projects/:projectId/task-queue/claim`
  - 使用 `FOR UPDATE SKIP LOCKED` 原子领取；
  - 并发 Claim 不会重复领取同一 Task；
  - 过期 Claim 在后续 Claim 时释放并可恢复。
- `POST /api/v1/tasks/:id/claim/release`
  - Claim token 不匹配返回 conflict。

控制动作：

```text
POST /api/v1/tasks/:id/pause
POST /api/v1/tasks/:id/block
POST /api/v1/tasks/:id/request-input
POST /api/v1/tasks/:id/input
POST /api/v1/tasks/:id/resume
POST /api/v1/tasks/:id/submit
POST /api/v1/tasks/:id/session-reset
```

- 控制动作要求 active Project `write`。
- revision 冲突返回 `task_execution_revision_conflict`。
- 有活动 Run 时 pause/block/needsInput/resume 拒绝，避免外部进程已启动后伪造暂停。
- 重复 resume 已 queued 的 Task 按幂等成功处理。
- needsInput 会写入系统 Task Message；补充输入写回 human Task Message 并恢复 queued。
- `auto_submit=false` 时，成功 Run 保持 in_progress；负责人可显式 submit 到 review。

## 4. 自动提交、自动验收与 Review

- owner Run 成功：
  - `auto_submit=false`：保持 in_progress，等待人工提交；
  - `auto_submit=true`、`auto_accept=false`：进入 review；
  - `auto_submit=true`、`auto_accept=true`：写入系统验收记录、进入 done，并发布项目产出。
- `auto_accept=true` 必须同时允许 `auto_submit`。
- 自动验收以 owner Run 成功完成、非空输出和已保存交付物为条件，不新增 AI 判定器；
  验收标准文本仍作为执行证据和人工 Review 依据。
- Review 退回要求说明，写入 Task Message 且 `deliveryTarget=receiver`，Task 回到 queued。
- `review.redispatch=true` 或 `autoRedispatchOnReturn=true` 时，退回后立即重新 Preflight。
- Review 和自动验收继续复用既有 `task_reviews`、Task Event、Memory 和 Workflow status sync。

## 5. deliveryTarget 与协作 Run

消息请求显式 deliveryTarget 优先于 mentions 推断：

- 无 mention 或只 mention 责任人：`receiver`；
- 只 mention 非责任人：`collaborators`；
- 同时 mention 责任人与协作方：`broadcast`。

无 mention 且无显式 deliveryTarget 的普通评论只记录，不派发。协作 Agent 使用同一 Task
和各自独立 Scene Session 创建 `task_execution_kind=collaborator` Run；协作 Run 输出
写回 Task Message，但不把 Task 推进到 review。责任人 Run 仍负责最终提交和验收。

## 6. Session Reset

- Task Session Reset 只作用于同一 Task Scene，不跨 Scene、Project 或 Agent 复用。
- 旧 Scene Session 标记 reset，新 Session generation +1，并使用新 Session Handle。
- 旧 Run 的 Receipt 继续指向旧 Session，可按原 cursor 和 digest 重放。
- 后续 Run 使用最新 active generation；Contribution、Cursor 和 Receipt 不跨 generation 共享。
- 有活动 Run 时拒绝 Reset。

## 7. 文档与项目路径权限

- `GET /api/v1/tasks/:id/documents`
- `POST /api/v1/tasks/:id/documents/:attachmentId/reveal`
- 既有 Attachment upload/download/archive 继续复用。
- 文档路径必须位于 `documents/<taskId>/`，拒绝绝对路径、反斜杠、`.`、`..`、空段和跨 Task 路径。
- 上传前校验路径，非法路径不会先写入 FileStore。
- discovery/reveal/download 要求 Project `read`；upload/archive 要求 active Project `write`。
- reveal 只返回 task-scoped logical path，不对外开放 Shared Space 写能力。

## 8. Worker 与安全边界

- Job Claim 额外复核 Task 状态、Project active 和依赖完成。
- Worker 启动前继续执行 15A Envelope / Policy / Runtime revision 复核和 15B Ticket/Gate 门禁。
- 无 Ticket/Gate、Gate pending/denied、Scene 不匹配、Cursor 冲突和重试冲突均 fail closed。
- 未修改 Ticket Token 字段、Gate 决策语义、Envelope digest 或 policy revision 含义。
- WorkBuddy 仍只使用通用 `plain-text`、stdin Prompt 和 final-only stdout。

## 9. 验证

- Migration：fresh `0 -> 28`、upgrade `27 -> 28` 通过。
- Backfill：历史 Task/Run/Message 内容保持，Attachment path 回填通过。
- Batch 17A 定向 Vitest：14 files / 75 tests 通过。
- 完整 Vitest（fresh DB）：52 files / 254 tests 通过。
- Playwright：Task 控制、文档归档、自动提交到 Review、Session generation 1；
  覆盖 1440px、900px、390px，无水平溢出；1 test 通过。
- `pnpm run typecheck`、`pnpm run lint`、根级构建和 Web production build 通过。
- `git diff --check`、脚本 `bash -n` 与新增文件 Prettier 检查通过。

已知非阻断告警：

- Web production bundle 单 chunk 超过 500 kB。
- 仓库级 `pnpm run format:check` 仍报告历史文件格式漂移；这些文件未纳入本批重构，
  仅迁移版本断言相关测试保持最小差异。
- `tsdown` 的 `external` deprecation 与 API/Worker d.ts sourcemap 告警。

## 10. 本批边界

未实现：

- Batch 17B AI Teammate；
- Batch 13.1B 已由后续独立批次完成：
  [v1-batch13.1b-runtime-economics.md](./v1-batch13.1b-runtime-economics.md)；
- Shared Space、Lane 级路径写权限、Locks、Global Write；
- sandbox 扩展；
- Provider Session resume；
- Runtime 级 `maxTurns` / `maxToolCalls` / `maxCost` 强制执行。
