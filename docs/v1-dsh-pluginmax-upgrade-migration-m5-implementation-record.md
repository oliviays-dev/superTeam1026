# dsh-pluginmax 升级迁移 M5 实施记录

> 阶段：Task Capture、Group Scene、Context Policy/Commit、Meeting 多 AI
> 日期：2026-11-13
> 仓库：`pluginmax-platform`
> 实施基线：`main@5b7f7f5bc179ca0435c96126a950e7b3605847f4`
> Migration：40 -> 41

## 1. 实施前核对

```text
branch: main
HEAD:   5b7f7f5bc179ca0435c96126a950e7b3605847f4
M5 max before: 40
M5 migration:  41
```

工作树包含 Shared Space、Human Avatar Delegation、Identity Hardening、
M1-M4 等既有未提交修改和未跟踪文件。本轮未执行 `git reset --hard`、
`git checkout --`、`git clean`，未清理未跟踪文件，未修改外部
`dsh-pluginmax` 仓库或迁移前只读备份。

## 2. 完成范围

- Task Capture 独立草稿域。
- Task Capture 稳定 creationKey、并发提交幂等、逐项部分失败。
- Group Scene participant binding 与 Participant-bound Scene Session。
- Session revision/status/lastContextSeq/usage ratio/compaction count。
- Context Policy 版本、场景覆盖、CAS、reset 与管理员权限。
- Context Pack/Receipt/Commit Receipt 与 Runtime-success-only boundary commit。
- 增量 Context 读取、历史 Pack 不可变、撤权后不可读、超预算索引降级。
- Meeting `autoSpeak=all|mentions|manual`。
- Meeting participant 级暂停/恢复、触发深度、场景并发限制。
- Meeting delivery 幂等与 AI 回复 participant/principal/run 归属。
- 默认关闭的 Feature Flags。

本轮未实施 M6-M8，未扩展现有 M4 Skill 能力，也未新增第二套 Task、
Scene、Meeting、Context 或 Run 事实源。

## 3. Contract

新增：

- `packages/contracts/src/task-capture.ts`
- `packages/contracts/src/context-policy.ts`

扩展：

- `sceneType=group`
- `SceneParticipantBinding`
- `SceneSessionBinding`
  - `participantBindingId`
  - `revision`
  - `status=preparing|active|archived|reset`
  - `lastContextSeq`
  - `contextUsageRatio`
  - `compactionCount`
- `SceneContextCommitReceipt`
- `ContextPack/ContextReceipt`
  - `contextBoundarySeq`
  - `contextPolicyVersion`
  - `contextUsageRatio`
- `MeetingMessage.sequence`
- `MeetingMessage.participantBindingId`
- `MeetingMessage.triggerDepth`
- `MeetingAiPolicy.autoSpeak`
- `MeetingAiPolicy.maxTriggerDepth`
- `MeetingAiPolicy.maxConcurrentAgentsPerScene`
- `MeetingAiParticipant` 与 participant CAS 输入。

## 4. Migration 41

Migration 41 位于 `packages/database/src/schema.ts` 的
`M5_COLLABORATION_CONTEXT_SCHEMA_SQL`，由
`packages/database/src/migrate.ts` 注册。

新增表：

```text
scene_participant_bindings
context_policy_heads
context_policy_versions
scene_context_commit_receipts
task_capture_sessions
task_capture_candidates
task_draft_batches
task_drafts
task_draft_conversions
```

扩展表：

```text
scene_sessions
context_packs
scene_context_receipts
meeting_ai_policies
meeting_ai_participants
meeting_ai_turns
meeting_messages
```

关键唯一约束：

- `scene_participant_bindings(scene_type, scene_id, agent_id, principal_id)`。
- participant-bound Session generation 唯一。
- legacy Session generation 继续保留独立唯一索引。
- `context_policy_versions(scope_type, scope_id, scene_type, revision)`。
- `scene_context_commit_receipts.run_id` 与 `context_pack_id` 唯一。
- Task Capture session source 唯一。
- Task Candidate `(session_id, source_id, source_version, excerpt_hash)` 唯一。
- Task Draft `creation_key` 唯一，`(batch_id, candidate_id)` 唯一。
- Task Conversion `draft_id` 与 `creation_key` 唯一。
- Meeting Message `(meeting_id, sequence)` 唯一。

不可变保护：

- Context Policy Version 禁止 UPDATE/DELETE。
- Scene Context Commit Receipt 禁止 UPDATE/DELETE。
- 既有 ContextPack、Scene Context Contribution、Scene Context Receipt
  不可变保护保留。
- Task Capture source identity 禁止删除，source ID/version/excerpt hash
  禁止改写。
- Task Origin 继续复用 M3 不可变保护。
- Meeting delivery identity 与唯一键继续复用 M3/M4 既有保护。

Migration 顺序：

1. Expand：新增表、列、索引、约束与默认关闭 Flags。
2. Backfill：回填 participant binding、Session context seq、legacy
   Meeting sequence、policy seed。
3. Validate：检查 participant binding 与 Policy 版本重复。
4. Enforce：建立不可变 trigger、唯一索引与场景类型约束。
5. Enable：`task.capture=off`、`context.group_policy=off`。

## 5. Task Capture

新增：

- `packages/database/src/task-capture-repository.ts`
- `apps/api/src/task-capture.test.ts`
- `scripts/m5-task-capture-vitest.sh`

规则：

- Session、Candidate、Batch、Draft 不写入正式 `tasks`。
- 仅 `commit` 创建正式 Task。
- Draft creationKey：

```text
task-capture-draft:{draftId}:v1
```

- 同一 creationKey 并发提交通过 `tasks.creation_key` 唯一索引收敛。
- Task Origin 使用 `source_kind=capture`。
- commit 前重新校验 Project active/write、candidate 当前 source version、
  excerpt hash、assignee 活跃项目成员。
- 每个 draft 使用独立 SAVEPOINT 处理，部分失败不回滚成功项。
- Batch 结果保存 `created|reused|failed` 逐项结果。
- 重复 commit 返回持久化结果，不重复创建 Task。

## 6. Scene 与 Context

### 6.1 Group Scene

- 新增 participant binding API 与 Session API。
- 同一群多个 AI 分别拥有独立 participant binding、Session、Context cursor。
- 离会、暂停、移除会将活动 Session 重置。
- 重入创建新 generation，旧 Session 和 cursor 保留历史但不复用。

### 6.2 Runtime-success-only commit

执行顺序调整为：

```text
prepare ContextPack/Receipt
  -> runtime consumes
  -> runtime completed
  -> insert Context Commit Receipt
  -> update Session.last_context_seq
```

Runtime 失败时：

- Context Receipt 可存在，用于审计准备事实。
- 不写 Context Commit Receipt。
- Session 保持 `preparing`。
- `lastContextSeq=0` 或保持上一个成功边界。

### 6.3 增量读取

- 下一次只向 Runtime 提供 `lastContextSeq < contribution.sequence`。
- 已提交 contribution 只进入 `reused` 投影。
- Context Pack 保存自身 Policy version、boundary seq 和 usage ratio。

### 6.4 撤权

- Run Context、Scene Context、Replay 读取前重新检查 Project read 权限。
- 权限撤销后即使历史 Pack 仍存在，也不可读取上下文。

### 6.5 超预算

- 达到 `rolloverRatio` 后不注入完整 source text。
- 仅注入 source index、安全标签和 `entity.read`、`task.runs`、
  `meeting.history` 工具入口。
- Receipt 记录 `reason=budget`。

## 7. Context Policy

新增：

- `packages/database/src/context-policy-repository.ts`

默认值：

```text
warningRatio                    0.70
compactRatio                    0.85
rolloverRatio                   0.95
preserveRecentMessages          12
maxTriggerDepth                 3
maxConcurrentAgentsPerScene     3
maxContextChars                 32000
```

支持：

- Platform default。
- direct-chat/group/meeting 场景覆盖。
- expectedVersion CAS。
- reset 到上层默认值。
- Platform admin 或 Project `manage_roles` 管理权限。
- 每个版本写 `context_policy_versions`。
- 历史 ContextPack 保留原 policy version，不随新 Policy 改写。

## 8. Meeting 多 AI

- `autoSpeak=all`：human 消息自动唤醒全部 active AI 参与者。
- `autoSpeak=mentions`：仅 @AI 或显式 mention 触发。
- `autoSpeak=manual`：消息不自动触发，必须显式 trigger。
- 多 AI 各自创建独立 Turn、Run 和 Session。
- AI 回复写入 `participant_binding_id`、`sender_principal_id`、`run_id`。
- Meeting Message 使用每会议稳定 `sequence`。
- 消息 `trigger_depth` 进入 Trigger 校验，超过 Policy 上限拒绝。
- 并发限制只统计正在 `running` 的 Meeting AI Turn。
- participant 暂停/恢复使用 revision CAS。
- 同一 round/source 重复 trigger 返回 `reused`。
- Message Delivery 沿用 `(message_id, recipient_principal_id)` 和
  `(message_id, idempotency_key)` 唯一约束。

## 9. Feature Flags

```text
task.capture=off
context.group_policy=off
```

关闭时：

- 拒绝新的 Task Capture 写操作。
- 拒绝 Group Scene participant/session 管理写操作。
- 已有草稿、Session、Pack、Commit Receipt 和 Meeting 数据保留。
- 不删除事实，不自动恢复。

## 10. API

Task Capture：

```http
POST  /api/v1/task-capture/sessions
GET   /api/v1/task-capture/sessions/:sessionId
GET   /api/v1/task-capture/sessions/:sessionId/candidates
POST  /api/v1/task-capture/sessions/:sessionId/candidates
POST  /api/v1/task-capture/candidates/:candidateId/invalidate
POST  /api/v1/task-capture/sessions/:sessionId/batches
PATCH /api/v1/task-capture/drafts/:draftId
GET   /api/v1/task-capture/batches/:batchId
POST  /api/v1/task-capture/batches/:batchId/commit
```

Context / Group Scene：

```http
GET   /api/v1/context-policy
PUT   /api/v1/context-policy
POST  /api/v1/context-policy/reset
POST  /api/v1/group-scenes/:sceneId/participants
GET   /api/v1/group-scenes/:sceneId/participants
PATCH /api/v1/group-scenes/:sceneId/participants/:participantBindingId
POST  /api/v1/group-scenes/:sceneId/sessions
```

Meeting：

```http
GET /api/v1/meetings/:meetingId/ai-participants
PUT /api/v1/meetings/:meetingId/ai-participants/:agentId
```

既有 Meeting AI Policy、Trigger、Delivery、Run 和直接对话 API 保持独立。

## 11. Audit

统一写入 append-only `identity_audit_events`：

```text
task.capture.session.created
task.capture.candidate.created
task.capture.candidate.invalidated
task.capture.batch.created
task.capture.batch.committed
context.policy.updated
context.policy.reset
context.committed
group.scene.participant.updated
group.scene.session.ensured
meeting.ai.participant.updated
```

事件包含 actor、资源 ID、revision/status、结果和来源 metadata。

## 12. 测试结果

M5 Migration：

```text
./scripts/m5-migration-vitest.sh
fresh_migration=0->41
upgrade_migration=40->41
flags=context.group_policy=off,task.capture=off
context_policy_platform_versions=4
legacy_read=Legacy task before M5|queued
old_app_write=2|0
```

Task Capture：

```text
./scripts/m5-task-capture-vitest.sh
Test Files  1 passed
Tests       3 passed
```

覆盖：

- 草稿 commit 前不创建正式 Task。
- 重复 commit 与并发 commit 不重复创建 Task。
- 逐项 partial failure。
- invalidated candidate 不可转换。
- Flag 关闭拒绝新写操作。
- Audit event。

Group Scene / Context：

```text
./scripts/m5-group-context-vitest.sh
Test Files  2 passed
Tests       8 passed
```

覆盖：

- 同群多个 AI Session 与 Context 不共享。
- 暂停/恢复与 generation 隔离。
- Policy CAS、场景覆盖与 reset。
- Runtime 失败不提交 lastContextSeq。
- Runtime 成功后 boundary commit。
- 撤权后 Context 403。
- 历史 Pack 不按新 Policy 改写且 UPDATE 被拒绝。
- 超预算只保留索引和工具入口。
- Audit events。

Meeting 多 AI：

```text
./scripts/m5-meeting-multi-ai-vitest.sh
Test Files  1 passed
Tests       2 passed
```

覆盖：

- directed mention。
- autoSpeak all/mentions/manual。
- participant pause/resume。
- trigger depth。
- running concurrency limit。
- 重复 delivery/trigger 幂等。
- 多 AI 独立 Run、participant binding、principal 与回复归属。
- Audit event。

既有回归：

```text
./scripts/meeting-ai-participation-vitest.sh \
  apps/api/src/meeting-ai-participation.test.ts
Test Files  1 passed
Tests       5 passed

./scripts/meeting-ai-participation-vitest.sh \
  apps/api/src/scene-context.test.ts \
  apps/api/src/ai-direct-chat.test.ts \
  apps/api/src/task-execution-depth.test.ts \
  apps/api/src/run-skill-snapshot.test.ts \
  apps/api/src/task-execution-evidence.test.ts
Test Files  5 passed
Tests       24 passed
```

全仓门禁：

```text
CI=true pnpm typecheck  pass
CI=true pnpm test       pass
CI=true pnpm lint       pass
CI=true pnpm build      pass
```

全仓 Vitest（无 `TEST_DATABASE_URL`）：

```text
Test Files  39 passed | 47 skipped (86)
Tests       201 passed | 200 skipped (401)
```

Teammates PostgreSQL 既有失败已实际复跑，仍存在：

```text
apps/api/src/teammates.test.ts:442
expected statistics.runCount=1, received 0
Test Files  1 failed
Tests       1 failed
```

本轮未修改该既有统计夹具，也未声明为 M5 已修复。

## 13. 未执行项与风险

- 本轮未新增 Task Capture/Context Policy/Group Scene 的 Web 页面；
  当前交付为 Contract + Application + API。
- Context usage ratio 以 contribution 文本字符数估算，不是 Runtime
  精确 token 计费。
- 超预算工具入口依赖后续 Runtime 实际支持 `entity.read` 等 Tool RPC；
  当前保证 Prompt 中不泄露完整 source 正文并提供受控入口索引。
- Meeting 并发限制只统计 `running` Turn；排队 Turn 不计入并发。
- Context commit 与 Runtime completed event 之间仍有一个极短事务窗口，
  通过 Run 状态、Session 行锁和 cursor CAS 收敛重复提交。
- Teammates 周报统计既有失败仍需修复或正式豁免。

## 14. 进入 M6 条件

- 保持 Migration 41 之上 additive 演进，禁止改写 37-41。
- 目标环境先关闭新 Flags 发布，再分别开启并记录 actor/revision。
- 完成 Task Capture 与 Context Policy 的 UI/产品入口评审。
- 明确 Runtime Tool RPC 对超预算索引读取的实际协议。
- 处理 Teammates 周报统计失败或由负责人正式豁免。
- M6 继续复用 Project/Task/Report 既有事实源，不得复用 M5
  Capture Draft、Scene Session 或 ContextPack 作为第二套项目/报告事实。
