# V1 Batch 13.1B：Runtime 经济与可见性

> 状态：Batch 13.1B 已完成。Batch 17B 已由后续独立批次完成；Shared Space、
> sandbox、Lane 级路径写权限和 Global Write 仍未实现。

## 1. 基线

- 基线 worktree：`.tmp/pluginmax-platform-batch17a-task-execution-depth`
- 基线分支：`feat/v1-batch17a-task-execution-depth`
- 基线 HEAD：`4cd0f75d35fd550834dce090675c4a1176a18a70`
- 工作 worktree：`.tmp/pluginmax-platform-batch13.1b-runtime-economics`
- 工作分支：`feat/v1-batch13.1b-runtime-economics`
- 独立 PostgreSQL：`127.0.0.1:54430`

开始前已只读确认基线 worktree、分支、HEAD 和干净 status。所有 `DSH_HOME`、
FileStore、Agent Workspace、日志、截图和 fixture 均位于当前 worktree `.tmp`。
本批未读取正式数据库、正式 Session/Profile、原始 `dsh-pluginmax` 或历史业务数据。

## 2. 持久化模型

Migration 29 为 additive migration，扩展：

- `external_runtimes`
  - `workspace_id`：Workspace Runtime 的可见范围键
  - `visibility` 新增 `workspace`
  - Workspace 可见 Runtime 必须有 `workspace_id`
- `run_runtime_usage_receipts`
  - Run、Run attempt、Job、Job attempt 与执行上下文身份
  - Runtime、revision、Provider、Model
  - input/output/total/cached/reasoning Token
  - cost amount/currency
  - usage source、unknown fields、耗时、payload digest 和记录时间
  - `(run_id, run_attempt)` 唯一
- `domain_outbox`
  - `runtime.usage.recorded` 按 `(runId, runAttempt)` 幂等
- `runs`
  - 增加 execution workspace、创建时间和 ID 的统计查询索引

Usage receipt 不可更新或删除。相同 payload 重放返回已有 receipt；相同 Run attempt
提交不同 payload 时返回 `conflict`，不会覆盖原回执。

### 历史与 backfill

- 历史 Runtime 保持原 `owner` / `platform` 可见范围，`workspace_id` 回填为 `null`。
- 不为历史 Run 伪造 Token、成本、Provider、模型或 usage receipt。
- 历史缺失信息读取为 `unknown`，通过 reconciliation 显示为待补证而非伪造为 `0`。
- WorkBuddy `plain-text` 仍只产生 final-only stdout；未上报的 Token、模型、成本和认证
  信息保持 `unknown`。

### Rollback

Migration 29 不修改既有 Run Envelope、policy revision、Ticket/Gate 或 Run 快照。
回滚删除 `run_runtime_usage_receipts`、对应 trigger/index、统计索引和
`external_runtimes.workspace_id`，并把 visibility 约束恢复为
`platform` / `owner`。执行回滚前必须把 visibility=`workspace` 的 Runtime 转回
`owner` 或 `platform`，避免旧约束失败或静默改写。

## 3. Workspace 可见范围

Runtime 可见范围：

| 范围 | 可读 | 管理 |
| --- | --- | --- |
| `platform` | 已认证平台成员 | Runtime Owner / Platform Admin |
| `workspace` | 对目标执行 Workspace 有 `read` Grant 的成员 | Runtime Owner / Platform Admin |
| `owner` | Runtime Owner / Platform Admin | Runtime Owner / Platform Admin |

当前 V1 的 Project ID 可同时作为执行 Workspace 键使用。Workspace 授权投影按以下
兼容规则判断：

- Workspace ID 命中现有 Project 时，使用该 Project 的 active membership 与 `read`
  Grant；
- 其他 Workspace ID 使用 `workspace_members` 与 Workspace `read` Grant；
- 非成员、Grant 撤销、跨 Workspace 和 Workspace 不匹配均拒绝；
- Runtime Owner 和 Platform Admin 不因产品名称或 Runtime 注册获得 Workspace 读权限。

API 返回 `RuntimeAccessProjection`，包含 `canRead`、`canManage`、授权来源、
membership ID、Grant IDs、有效权限和拒绝原因。

## 4. 经济采集与归一化

Worker 在 Run attempt 结算时写入 immutable usage receipt：

- 进程耗时来自 Runtime adapter diagnostics 的实测 `durationMs`；
- Codex JSONL 只有在事件明确包含 usage 时才记录 Token；`turn.completed` 的已知
  `usage` 字段会被归一化；
- input 与 output 已知但 total 缺失时可派生 total；
- cost 只有 Runtime 明确上报时才记录，并按明确 currency 保存；
- 缺失字段写入 `unknownFields`，不会被 `0` 替代；
- 同一 Run attempt 重复提交按 payload digest 判定 replay/conflict；
- 每次 usage receipt 同时写入 `runtime.usage_recorded` Run Event 与 durable Outbox。

统计汇总同时返回已知值之和与 unknown 样本数，避免把未知成本或 Token 误报成零。

## 5. 时间口径与对账

统计时间线按稳定时间边界切分：

| 阶段 | 口径 |
| --- | --- |
| `queued` | Run 创建到首次 Claim，以及 Gate 决策后重新排队 |
| `claimed` | Job Attempt 已 Claim 到 Run/Runtime 开始执行 |
| `waiting_approval` | blocking Gate requested 到 decision |
| `running` | Run 开始或 Runtime Effect 开始到 Effect 完成 |
| `needs_input` | Task 进入 needsInput 到补充输入恢复 |
| `retry_wait` | `job.retry_scheduled` 到下一次 Claim |
| `recovery` | `run.interrupted` 到恢复完成 |
| `settlement` | Runtime Effect 完成到 Run 终态 |

Reconciliation 对照：

- Run 状态、`started_at` / `ended_at`
- Run Event 终态、重试、恢复与 usage receipt 事件
- Job Attempt 与 lease token 历史
- Runtime Effect started/completed
- Task Event 的 needsInput 与控制事件
- Execution Gate request/decision
- usage Outbox
- immutable usage receipt

输出 `reconciled` / `unknown` / `incomplete` / `inconsistent`，并保留逐项 issue
与各来源计数。历史 Run 没有 usage 时为 `unknown`，不会阻断历史业务读取。

## 6. API 与查询边界

```text
GET /api/v1/runtimes/:runtimeId/access
GET /api/v1/workspaces/:workspaceId/runtimes
GET /api/v1/workspaces/:workspaceId/runtime-economics
GET /api/v1/workspaces/:workspaceId/execution-history
GET /api/v1/runs/:runId/economics
```

Execution history：

- 固定按 `created_at DESC, id DESC` 分页；
- Cursor 绑定 Workspace 与全部过滤条件 fingerprint；
- Cursor 无法解析、跨 Workspace 或过滤条件变化返回
  `409 execution_history_cursor_conflict`；
- 单页上限 100，供 Batch 17B 复用执行历史和统计查询，不包含 Teammate 语义。

## 7. Web

- Runtime 页展示 Workspace Runtime 目录投影、Token/成本/阶段统计和 Runtime 分组。
- Run 页展示 usage receipt、unknown 字段、Claim 延迟、阶段耗时和 reconciliation。
- 未知 Token/成本统一显示 `unknown`，不依据 Provider 或产品名推测。
- Runtime 创建/编辑支持 `workspace` 可见范围和 Workspace ID。

## 8. 验证结果

- Migration：fresh `0 -> 29`、upgrade `28 -> 29` 通过。
- Upgrade fixture：历史 Run 输出保持；历史 Runtime 保持
  `workbuddy | plain-text | owner` 且 `workspace_id IS NULL`；usage receipt backfill 为 `0`。
- Batch 13.1B 定向 Vitest：13 files / 58 tests 通过。
- 完整 Vitest（fresh DB）：56 files / 268 tests 通过。
- 四入口回归：Task、Workflow Task、Meeting AI、Direct Chat 全部通过。
- Gate/Scene/Depth 回归：无 Ticket、Gate pending/reject、Scene mismatch、Cursor
  conflict 与重试冲突继续 fail closed。
- Playwright：Workspace Runtime 可见性、Token unknown、Run 阶段与结算通过；
  覆盖 1440px、900px、390px，无水平溢出。
- 全部分包 typecheck、oxlint、packages/API/Worker build 和 Web production build 通过。
- `git diff --check`、脚本 `bash -n` 通过。

已知非阻断告警：

- Web production bundle 单 chunk 超过 500 kB。
- `tsdown` 的 `external` deprecation、d.ts sourcemap 告警。

## 9. 本批边界

未实现：

- Batch 17B AI Teammate；
- Shared Space、Lane 级路径写权限、Locks、Global Write；
- sandbox 扩展；
- Provider Session resume；
- Runtime 级 `maxTurns` / `maxToolCalls` / `maxCost` 强制执行。

本批没有修改 15A Execution Envelope、policy revision、Run 快照语义，也没有修改
15B Ticket/Gate Token 或安全语义。
