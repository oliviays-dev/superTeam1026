# V1 Batch 18：Meeting Collaboration

> 状态：Batch 18 已完成。Shared Space、sandbox、Lane 级路径写权限和 Global
> Write 均未实现。

## 1. 基线

- 基线 worktree：`.tmp/pluginmax-platform-batch17b-ai-teammate`
- 基线分支：`feat/v1-batch17b-ai-teammate`
- 基线 HEAD：`1d8a027c2c84c4efd378886bafc6b3f39ae1fbfa`
- 工作 worktree：`.tmp/pluginmax-platform-batch18-meeting-collaboration`
- 工作分支：`feat/v1-batch18-meeting-collaboration`
- 独立 PostgreSQL：`127.0.0.1:54432`

开始前已只读确认基线 worktree、分支、HEAD 和干净 status。所有 `DSH_HOME`、
FileStore、Agent Workspace、日志、fixture 和截图均位于当前 worktree `.tmp`。
未读取正式数据库、正式 Session/Profile、原始 `dsh-pluginmax` 或历史业务数据。

## 2. 代码事实与取舍

`meeting-sidebar-design.md` 中的 DSH Slot、`/api/collab/...` 路由和旧会议 KV
只作为协作产品语义输入。本批以 V1 已落地事实为准：

- Meeting 继续复用既有 Principal、Project RBAC、Batch 12A AI 参与、Batch 16
  Scene Session/Cursor/Receipt、Batch 15 Preflight/Ticket/Gate 和既有
  Task/Run/Worker。
- Facilitator、Delegate、私密嘱咐、投递、文件和归档属于会议协作子域，不新增
  第二套 Run、Job、Worker 或 Runtime。
- Minutes 自动生成是确定性摘要，不调用模型；确认复用既有不可变 Minutes
  Version，并追加 Confirmation。
- Meeting Task 是普通 Task 的会议来源关联，不绕过 TaskExecutionPolicy、
  Action Ticket、Execution Gate 或 Worker 复核。
- 私密嘱咐只作为匹配 Principal/Agent Scene Session 的私有 Contribution 进入
  Context，不进入 Minutes、公共消息或其他 Principal 的 Context。
- WorkBuddy 继续只使用通用 `plain-text`、stdin Prompt 和 final-only stdout。

## 3. Migration 31

Migration 31 是 additive migration，新增 10 张表：

- `meeting_collaboration_states`：当前 Facilitator、生命周期和 revision。
- `meeting_facilitator_handoffs`：只追加转交历史。
- `meeting_delegates`：会议级 Human/AI 代表、动作范围、有效期和 revoke。
- `meeting_private_briefings`：Owner、Audience Principal、可选 Agent、revision
  和归档状态；没有公共 visibility。
- `meeting_message_deliveries`：按消息和 recipient Principal 唯一的投递状态。
- `meeting_read_positions`：每 Meeting/Principal 的最后已读消息。
- `meeting_files`：受控 FileStore 元数据、SHA-256 和归档状态。
- `meeting_minutes_confirmations`：不可变 Minutes Version 的确认记录。
- `meeting_tasks`：Meeting 到普通 Task 的只追加来源关联。
- `meeting_collaboration_events`：协作事件的只追加序列。

`meeting_messages` 只新增 nullable `client_message_id`、`delegate_id` 和
`sender_principal_id`。唯一索引保证同一会议 `client_message_id` 不生成第二条
消息。

Migration 31 没有修改 Run Envelope、policy revision、Run 快照、Action Ticket、
Gate、Ticket Token、Scene Session、Cursor、Receipt 或 usage receipt 的既有列和
触发器。

### Backfill

- 每个历史 Meeting 回填一条 active Collaboration State。
- Facilitator 优先取 `participants` 中第一个合法 Human ID；没有时使用
  `local-admin`。
- 为每个 State 回填 revision 1 的初始 Facilitator History 和事件。
- 已转换 Meeting Action Item 按 `action-item:<id>` 回填 `meeting_tasks`。
- 历史消息不伪造逐 Principal 投递记录，delivery backfill 为 `0`。
- 历史 Meeting、Message、Minutes、Action Item、Task、Run、Ticket、Gate 和
  Scene Receipt 内容不变。

### 兼容读取

- 旧 Meeting、Messages、Minutes、Action Item 和 Traceability 契约继续可用。
- 新增 Message 字段由数据库 nullable 保持历史行可读，DTO 以 `null` 兼容。
- 旧 Meeting 没有新协作数据时返回空集合。
- 旧 Action Item conversion 仍返回普通 Task，同时追加 Meeting Task 关联。
- 未知 Provider、模型、Runtime、Token 和成本语义不变。

### 回滚

1. 停止 API、Worker 和 Web。
2. 删除 `meeting_messages` 上的 delivery seed trigger、相关索引和外键。
3. 按依赖逆序删除 10 张新表和对应 trigger function/index。
4. 删除 `meeting_messages.client_message_id`、`delegate_id`、
   `sender_principal_id`。
5. 删除 `platform_migrations.version=31`。

回滚不删除 Meeting、Message、Minutes、Task、Run、Ticket、Gate、Scene Session、
Context Receipt、usage receipt 或 audit；回滚前应导出新增协作数据。

## 4. Facilitator 与生命周期

- 新 Meeting 创建时，创建者自动成为 Facilitator；历史 Meeting 由 Migration 31
  记录初始 Facilitator。
- 转交必须提交 `expectedRevision`；当前 Facilitator 或 Project
  `manage_members` 才能转交。
- 目标必须是 active Human Principal 且为 active Project member。
- 转交以单事务更新当前投影并追加不可变 history/event；旧 revision 返回
  `409 meeting_facilitator_revision_conflict`。
- Archive 保留 Meeting、Minutes、Task 和 Scene 历史，但协作写入、消息和 AI 触发
  fail closed。
- Archive 会暂停 active AI policy 并取消 open AI Run；Restore 不自动恢复 AI
  policy，避免恢复即重新开放自动执行。
- Restore 只恢复 Collaboration lifecycle；Meeting 自身 `open|closed` 状态保持
  原值。

## 5. Delegate 边界

- Delegate 只属于一个 Meeting，不产生 Workspace/Project 权限。
- Delegator 默认是当前 Principal；Facilitator 或 `manage_members` 可代建。
- AI Delegate 必须引用 active Agent、active AI Principal 和 active Project
  member；Human Delegate 同样必须是 active Principal/Project member。
- 动作范围仅允许 `speak|read_private|attach_file|summarize`。
- 代表发言必须由 Delegator 或 Facilitator 提交；检查 active、未过期和 `speak`
  action 后才写入消息。
- Delegate 不能转交 Facilitator、Archive/Restore 或提升为 Project Grant。

## 6. 私密嘱咐、已读位置与 Context

- 私密嘱咐仅 Owner 与 Audience Principal 可通过 API 读取。
- Audience 是 active Project member；若是 AI Delegate，会绑定 Audience Agent。
- Scene Context 只选择同时匹配当前 Run Principal、Agent Principal 和 Agent 的
  嘱咐。
- Scene Contribution 使用 `private` visibility，不成为项目可见内容。
- 私密嘱咐不进入自动生成 Minutes、公共 Meeting Context 或其他 Scene Session。
- 已读位置按 Meeting/Principal 独立保存；读取消息可推进已读位置并将对应投递从
  `delivered` 推进为 `read`。
- AI Delegate 没有 Bearer 登录；其 Delegator 或 Facilitator 只能代行推进该
  Delegate 已获授权投递的已读状态。

## 7. 消息投递、重试与幂等

- 每条 Meeting Message 插入后，为该 Meeting active Human participants、
  Facilitator 和 active Delegates 生成 recipient Principal 投递记录。
- `(message_id, recipient_principal_id)` 唯一；同一 recipient 不会重复投递。
- `client_message_id` 在 Meeting 内唯一；相同 ID 和相同内容返回原消息，不重复
  触发 AI mention。
- 相同 client ID 配不同内容返回
  `409 meeting_message_idempotency_conflict`。
- 只有 `failed` Delivery 可以重试；`pending|delivered|read` 重试返回
  `409 meeting_delivery_not_retryable`。
- `read` 是终态；数据库 trigger 锁定 Delivery identity。

## 8. 文件、Minutes 与 Meeting Task

### 文件

- Meeting 文件只经受控 FileStore 写入，不使用任意路径或 Shared Space。
- 上传、下载和归档要求 Meeting Project read/write；Archived Meeting 禁止新上传。
- 文件元数据保存 SHA-256、MIME、大小、storage key 和归档审计。

### Minutes

- `POST /minutes/generate` 从 Meeting agenda 和 sent public messages 确定性生成
  草稿与来源消息 ID。
- 私密嘱咐不参与生成。
- `POST /minutes/confirm` 使用 `expectedRevision` 发布不可变版本，并追加不可变
  Confirmation。
- 旧 draft/publish API 继续兼容；Close Meeting 带 summary 时仍发布 Minutes，并
  追加 close confirmation。

### Meeting Task

- Meeting Task 创建普通 queued Task，指定 active AI Project member 为 assignee。
- `(meeting_id, idempotency_key)` 唯一；重复请求返回原任务并标记 `reused=true`。
- 来源只允许 manual/message/minutes_version；Action Item 必须走既有 conversion。
- `dispatch=true` 继续走 TaskExecutionPreflight 和既有 dispatch，不绕过
  Ticket/Gate/Scene。

## 9. API

```text
GET    /api/v1/meetings?projectId=&includeArchived=
GET    /api/v1/meetings/:meetingId/collaboration
POST   /api/v1/meetings/:meetingId/facilitator/handoff
GET    /api/v1/meetings/:meetingId/facilitator/history

GET    /api/v1/meetings/:meetingId/delegates
POST   /api/v1/meetings/:meetingId/delegates
POST   /api/v1/meetings/:meetingId/delegates/:delegateId/revoke
POST   /api/v1/meetings/:meetingId/delegates/:delegateId/messages

GET    /api/v1/meetings/:meetingId/private-briefings
POST   /api/v1/meetings/:meetingId/private-briefings
PATCH  /api/v1/meetings/:meetingId/private-briefings/:briefingId
POST   /api/v1/meetings/:meetingId/private-briefings/:briefingId/archive
GET    /api/v1/meetings/:meetingId/read-position
PUT    /api/v1/meetings/:meetingId/read-position

GET    /api/v1/meetings/:meetingId/messages/:messageId/deliveries
POST   /api/v1/meetings/:meetingId/messages/:messageId/deliveries/:deliveryId/retry
POST   /api/v1/meetings/:meetingId/messages/:messageId/deliveries/:deliveryId/read

GET    /api/v1/meetings/:meetingId/files
POST   /api/v1/meetings/:meetingId/files
GET    /api/v1/meetings/:meetingId/files/:fileId/download
POST   /api/v1/meetings/:meetingId/files/:fileId/archive

POST   /api/v1/meetings/:meetingId/minutes/generate
POST   /api/v1/meetings/:meetingId/minutes/confirm
GET    /api/v1/meetings/:meetingId/minutes/confirmations

GET    /api/v1/meetings/:meetingId/tasks
POST   /api/v1/meetings/:meetingId/tasks
POST   /api/v1/meetings/:meetingId/archive
POST   /api/v1/meetings/:meetingId/restore
```

Web Meeting 工作面新增「协作」页签，覆盖 Facilitator、Delegate、私密嘱咐、
文件、Minutes 生成/确认、Meeting Task 和 Archive/Restore。

## 10. 安全与 fail-closed

- 无 Project Grant 或 archived Project 继续拒绝。
- Archived Meeting 拒绝消息、AI 策略、AI trigger、Minutes、Task、File 和 Delegate
  写入。
- Meeting AI trigger 与 Worker `prepareRun` 都复核 Collaboration lifecycle。
- Delegate 过期、revoke、动作不足或代表类型不匹配时拒绝。
- 私密嘱咐跨 Principal/Agent Scene、跨 Meeting 或跨 Project 时不可见。
- 无 Ticket/Gate、pending/reject Gate、Scene mismatch、Cursor conflict、重复
  投递、非 failed retry 和陈旧 revision 继续 fail closed。
- 未修改 15A Execution Envelope/policy revision/Run 快照语义。
- 未修改 15B Ticket/Gate 安全语义或 Token 含义。
- 未绕过 16 Scene Session、Cursor 或 Context Receipt。

## 11. 验证

- Migration：fresh `0 -> 31`、upgrade `30 -> 31` 通过。
- Upgrade fixture：历史 Meeting 保留；Facilitator 回填成功；Delivery backfill 为
  `0`。
- Fresh schema：10 张 Batch 18 协作表。
- 定向 Vitest：8 files / 33 tests 通过，包括并发事件、并发私密嘱咐、幂等消息、
  非 failed retry、Minutes 陈旧 revision 和 immutable confirmation。
- 四入口回归：Task、Workflow Task、Meeting AI、Direct Chat 通过。
- Fail-closed 回归：无 Ticket/Gate、Scene mismatch、Cursor conflict、重复投递、
  retry 和 archive 阻断通过。
- Playwright：Facilitator、AI Delegate、私密嘱咐、文件、Minutes 确认、Meeting
  Task、Archive/Restore 通过；1440x960、900x900、390x844 无水平溢出。
- 完整 Vitest：62 files / 284 tests 通过。
- `pnpm run typecheck`、`pnpm run lint`、根级构建、packages/API/Worker build 和
  Web production build 通过。
- `git diff --check` 和三个测试脚本 `bash -n` 通过。

已知非阻断告警：

- Web production bundle 单 chunk 超过 500 kB。
- `tsdown` 的 `external` deprecation、d.ts sourcemap 和既有 chunk warning。
- Scene Context 的 blocking Gate + Worker 集成用例在完整套件下使用 15 秒成本
  合理超时；业务断言未放宽。

## 12. 本批边界

未实现：

- Shared Space、Workspace 共享路径、路径级 Grant、Locks 和 Global Write；
- sandbox 或危险工具权限扩展；
- Lane 级路径写权限；
- Provider Session resume；
- 通用 Scheduler、模型推断型 Minutes 或 Meeting 专用 Run/Job/Worker。

本批没有宣称 Batch 19、Shared Space、sandbox 或 Global Write 已完成。
