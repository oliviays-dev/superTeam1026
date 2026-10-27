# V1 Batch 16：Scene Context / Scene Session

> 状态：Batch 16 已完成。Batch 17A、17B 已在后续独立批次完成；
> Shared Space 和 sandbox 扩展仍未实现。

## 1. 基线

- 基线 worktree：`.tmp/pluginmax-platform-batch15b-action-ticket-gate`
- 基线分支：`feat/v1-batch15b-action-ticket-gate`
- 基线 HEAD：`492c88e5c9aebc10865757ababe18c02a80be3ad`
- 工作 worktree：`.tmp/pluginmax-platform-batch16-scene-context`
- 工作分支：`feat/v1-batch16-scene-context`
- 独立 PostgreSQL：`127.0.0.1:54428`

开始前基线 worktree、分支、HEAD 和干净 status 均已核对。所有 DSH_HOME、
FileStore、工作目录、日志、截图和 fixture 均位于当前 worktree `.tmp`。
本批未读取正式数据库、正式 Session/Profile、原始 `dsh-pluginmax` 或历史业务数据。

## 2. 持久化模型

Migration 27 为 additive migration，新增：

- `scene_sessions`
  - Scene 类型：`task` / `workflow-node` / `meeting` / `direct-chat`
  - Scene ID、Project、Agent、Agent Principal、Owner Principal
  - 稳定 Session Handle、generation、status
  - `(sceneType, sceneId, agentId, principalScope, generation)` 唯一
- `scene_chat_channels`
  - Direct Chat 的 owner/agent/channel 唯一绑定
  - Channel key、Scene ID、Agent Principal 和状态
- `scene_context_contributions`
  - 只追加、版本化 Contribution
  - kind、authority、visibility、text、SourceRef、delivery sequence
  - 复合外键绑定 `(sceneSessionId, sceneType, sceneId)`
  - `(sceneSessionId, sourceKey, version)` 唯一
- `scene_context_receipts`
  - 记录实际投递/复用 Contribution、SourceRef、排除项、cursor 和 digest
  - 每个 Run 最多一份不可变 Receipt
- `scene_context_delivery_cursors`
  - 每 Session 的增量游标、已投递 Contribution ID 和最后 Run
- `context_packs` 新增可空 Scene 关联列
  - `scene_session_id` / `scene_type` / `scene_id`
  - `agent_principal_id` / `logical_digest` / `renderer_version` / `as_of`
- `task_messages.is_key_consensus`
  - 默认 `false`，旧评论保持普通讨论语义

数据库约束保证：

- Contribution 只能属于一个 Scene Session。
- Session Handle 全局唯一，不同 Scene 不能共享。
- 新 Scene ContextPack 和 Receipt 不可变。
- Contribution 不可更新或删除。
- Session 的 Scene 身份、Agent、owner、channel、handle 和 generation 不可改写。

### Migration 与回滚

- fresh：`0 -> 27` 通过。
- upgrade：`26 -> 27` 通过，既有 Project、Task、Run、Task Message 和
  ContextPack 内容保持不变。
- backfill：不自动为历史 Run 伪造 Scene Session、Contribution 或 Receipt；
  upgrade fixture 的 Session backfill 数为 `0`。
- rollback：删除 `scene_context_delivery_cursors`、`scene_context_receipts`、
  `scene_context_contributions`、`scene_sessions`、`scene_chat_channels` 和
  对应 trigger/index，删除 `context_packs` 新增的 Scene 列，并删除
  `task_messages.is_key_consensus`。Migration 27 不修改既有业务行内容。

## 3. Scene Binding

四类入口统一绑定：

| 入口 | Scene 类型 | Scene 身份 |
| --- | --- | --- |
| Task | `task` | task ID |
| Workflow Task | `workflow-node` | workflow instance ID + node ID |
| Meeting AI | `meeting` | meeting ID |
| Direct Chat | `direct-chat` | thread ID，并绑定 Chat Channel |

同一 Scene + Agent 复用稳定 Session；不同 Scene、Project、Agent 或 owner
不会复用 Session Handle、Contribution 或 ContextPack。

## 4. Contribution 与增量投递

Context 可纳入：

- Task 关键共识评论
- Task 依赖
- Task 附件/文档引用
- Workflow Node 信息
- Meeting Minutes
- Agent private/project Episode
- Direct Chat 私有 Contribution

选择规则：

- Contribution 按 delivery sequence、ID 稳定排序。
- 持久 Runtime 复用上一份 Receipt，只投递新增或版本变化的 Contribution。
- 无状态 Runtime 每轮重放当前全部有效 Contribution，避免失忆。
- Receipt 记录本轮实际 delivered/reused、SourceRef、排除原因和 cursor。
- 相同 Run 输入派生相同 Pack/Receipt ID 和 logical digest。
- 同一 Run 恢复读取已提交快照，不重新读取变化后的业务状态覆盖历史。

## 5. 权限与隔离

- Run 仍必须先通过 15A Execution Envelope 和 15B Action Ticket / Gate。
- Scene Context 只消费已生成 Envelope 的 Principal、Project、Policy 和
  Runtime Capability 投影，不扩大授权。
- API 读取 Run Scene Context 要求 Run 可读；写 Contribution 要求 Project
  `write`，Direct Chat 只允许 Thread owner。
- private Contribution 只有匹配的 owner Principal 和 Agent Principal 可读。
- Contribution SourceRef 的 project/scene 必须与当前 Scene 一致。
- 跨项目 Contribution 和 Episode 不进入当前 Scene 查询。
- 不同 Meeting、Task、Workflow Node 或 Direct Chat 不共享 Session 或 Pack。

## 6. API 与 Web

```text
GET  /api/v1/runs/:runId/scene-context
GET  /api/v1/runs/:runId/scene-context/replay
POST /api/v1/runs/:runId/scene-context/contributions
```

旧 `GET /api/v1/runs/:runId/context` 保持兼容，继续返回 `pack` / `receipt`；
新字段以可选方式扩展，历史记录无需回写。

Web Run 视图展示：

- Scene 类型和短 ID
- Session Handle
- Receipt cursor before/after
- Contribution 数量、类型、visibility、版本和 SourceRef
- Replay 确定性校验结果

## 7. 验证结果

- Migration：fresh `0 -> 27`、upgrade `26 -> 27` 通过。
- Migration 27：5 张新增表；历史 ContextPack 保留且 `scene_session_id` 为
  `null`；Session/Contribution backfill 为 `0`。
- Batch 16 定向 Vitest：8 files / 34 tests 通过。
- 完整 Vitest（fresh DB）：51 files / 245 tests 通过。
- Playwright：Task 关键共识进入 Scene Context、Receipt 显示、Replay
  `deterministic`；覆盖 1440px、900px、390px，均无水平溢出。
- `pnpm run typecheck` 等价分包 typecheck、oxlint、根级构建和 Web production
  build 通过。
- `git diff --check` 与测试脚本 `bash -n` 通过。

已知非阻断告警：

- Web production bundle 单 chunk 超过 500 kB。
- `tsdown` 的 `external` deprecation 和 API/Worker d.ts sourcemap 告警。

## 8. 本批边界

未实现：

- Batch 17 Task Execution Depth、队列深度、Claim、needsInput 和 Session Reset
- Shared Space、Lane 级路径写权限、Locks、Global Write
- sandbox 扩展
- Provider Session resume
- Runtime 级 `maxTurns` / `maxToolCalls` / `maxCost` 强制执行

本批没有修改 Batch 17、Shared Space、sandbox 或 Batch 18 的完成状态。
