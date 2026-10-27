# V1 Batch 17B：AI Teammate

> 状态：Batch 17B 已完成。Batch 18 Meeting Collaboration、Shared Space、
> sandbox、Lane 级路径写权限和 Global Write 均未实现。

## 1. 基线

- 基线 worktree：`.tmp/pluginmax-platform-batch13.1b-runtime-economics`
- 基线分支：`feat/v1-batch13.1b-runtime-economics`
- 基线 HEAD：`222c01c1474cdab3845e1c0d6c4b9fb643b3fc22`
- 工作 worktree：`.tmp/pluginmax-platform-batch17b-ai-teammate`
- 工作分支：`feat/v1-batch17b-ai-teammate`
- 独立 PostgreSQL：`127.0.0.1:54431`

开始前已只读确认基线 worktree、分支、HEAD 和干净 status。所有 `DSH_HOME`、
FileStore、Agent Workspace、日志、fixture 和截图均位于当前 worktree `.tmp`。
未读取正式数据库、正式 Session/Profile、原始 `dsh-pluginmax` 或历史业务数据。

## 2. 范围取舍

PRD 与技术设计中的旧 `collab_teammate` KV 表、`/api/collab/...` 路由、独立
`dsh-collab-scheduler` 和模型推断型预扫描只作为输入，不直接平移到 V1。

本批以已落地的 Contracts 和代码事实为准：

- Principal、Workspace/Project Grant、15A Execution Envelope、15B Ticket/Gate、
  Batch 16 Scene Session 和 Batch 13.1B execution history/economics 是执行事实来源；
- 工作计划项继续生成普通 Task，不新增 Teammate 专用 Run、Job、Worker；
- 自动执行只复用现有 Task Preflight 与 dispatch，不绕过 Ticket/Gate；
- 定时器与独立调度器不在本批实现，Worker maintenance 只提供内部自动执行轮询；
- WorkBuddy 继续只使用通用 `plain-text`、stdin Prompt 和 final-only stdout。

## 3. 持久化模型

Migration 30 为 additive migration，新增 9 张表：

- `teammate_templates`
  - Workspace/Project 范围、个人/平台归属、当前版本、定义和生命周期；
  - 同一 Workspace 内未归档模板按归属与名称唯一。
- `teammate_template_versions`
  - 每次定义更新追加不可变版本和 SHA-256 content digest；
  - 实例固定引用创建时的 `template_version_id`。
- `teammates`
  - 绑定模板版本、执行 Agent、AI Principal、实例 owner Principal；
  - `agent_id` 唯一，实例归属与模板归属分离；
  - 状态为 `active` / `paused` / `inactive` / `archived`。
- `teammate_transfers`
  - 只追加记录旧 owner、新 owner、操作者、原因和时间。
- `teammate_events`
  - 只追加生命周期、队列、自动执行和周报事件。
- `teammate_work_plans`
  - 保存原始工作计划指令和 revision。
- `teammate_work_items`
  - Task 与实例的唯一绑定、稳定 `queue_seq`、自动执行资格和计划元数据。
- `teammate_run_attributions`
  - 将既有 Run 归属到实例、模板版本、AI Principal 和 owner Principal；
  - Scene Session commit 后只允许一次 `scene_session_id: null -> value`，其余字段不可变。
- `teammate_weekly_reports`
  - 周起始/结束、任务状态摘要、Batch 13.1B 统计快照和生成者。

新增 `teammate_queue` Runtime maintenance schedule。Migration 30 不修改 Task、Run、
Policy、Envelope、Ticket、Gate、Scene Session、Context Receipt 或 usage receipt 的原有列。

## 4. Backfill 与兼容读取

- 不把旧 KV Teammate 自动回填为 V1 实例。
- 第一批 V1 实例创建时从模板版本 1 开始，不伪造历史版本。
- 历史 Run 不生成 `teammate_run_attributions`，不伪装成 Teammate 执行。
- 历史任务仍可直接读取，但只有显式进入 V1 工作队列后才有 Teammate 队列语义。
- `employeeId`、`teammate:` alias 和旧 KV 运行面继续只读兼容，不写入本批新表。
- 未知 Provider、模型、Token、成本和耗时继续按 unknown 样本统计，不推导为 0。
- 旧 execution-history 查询指纹不包含 teammate filter；只有 AI Teammate 查询增加
  `teammateId` fingerprint 字段，原 API cursor 行为保持不变。

## 5. 模板与实例

- 模板创建、更新、归档要求 active Project `write`。
- 平台模板要求平台管理员；个人模板要求模板 owner。
- 更新必须传 `expectedVersion`；冲突返回
  `409 teammate_template_version_conflict`。
- 模板版本不可更新或删除；已归档模板不能创建实例。
- 创建实例必须提供现有执行 Agent：
  - Agent 必须 active；
  - 绑定 Principal 必须是 active AI Principal；
  - 该 AI Principal 必须有目标 Project 的 active membership 和 `write` Grant；
  - 模板 Project 必须与实例 Project 一致。
- 实例 owner 是创建者；只有 owner 或平台管理员可暂停、归档、恢复、转派和修改
  自动执行设置，平台管理员仍不能绕过 Project Grant。
- 归档实例可恢复为 `inactive`，不会恢复自动执行。

## 6. 工作计划与队列

- 确定性解析按换行、句号和分号拆分，最多 20 项。
- P0/P1/P2/P3 映射到 Task `urgent/high/medium/low`，未知优先级使用 medium。
- 支持“今天/明天/后天”和显式 `yyyy-mm-dd` 截止日期。
- 生成任务是受限普通 Task：
  - assignee 固定为该实例的执行 Agent；
  - Project 固定为实例 Project；
  - `autoAccept=false`；
  - 不接收任意 assignee、跨 Project 或 Actor 覆盖。
- 队列顺序使用稳定正整数 `queue_seq`；重排必须提交完整活动队列，部分或陈旧队列
  返回 conflict。
- 自动执行资格要求实例、Project、AI Principal 和 Grant 均 active，Task 为 queued，
  依赖完成，无 active Run/Claim，并允许自动执行。
- `TaskExecutionPolicy` 含 blocking human gate 或审批工具时，队列显示
  `approval-required`，自动执行跳过，不签发绕过 Gate 的执行。

## 7. 执行身份、Scene 与统计

创建 Run 时继续调用既有 TaskExecutionPreflight：

```text
AI Principal
  ∩ Project Grant
  ∩ Runtime Binding / Capability
  ∩ TaskExecutionPolicy
  -> Execution Envelope + Action Ticket + Gates
```

Run 创建事务只在存在 Teammate work item 时追加独立 attribution，不改 Run Envelope
或 Run 快照。Worker 生成/复用 Scene Context 后，把实际 Scene Session ID 一次性绑定到
attribution。四类入口原有 Four-entry 回归保持通过。

统计复用 Batch 13.1B：

- Run 状态、阶段耗时、usage receipt、Runtime Effect、Outbox 和 reconciliation；
- Token/成本仅汇总明确已知值；
- 缺失 Provider、模型、Token、成本或耗时返回 unknown 样本数；
- execution history 固定 `created_at DESC, id DESC`，cursor 绑定 Workspace 与 teammate
  过滤条件；跨条件 cursor 返回 `409 teammate_execution_history_cursor_conflict`。

## 8. 自动执行、周报与转派

- Worker `teammate_queue` maintenance 只挑选每个实例队首的可执行任务；
- 实例级 60 秒 auto-run lease 与 Task claim 跨 dispatch 全程持有；并发“立即执行”
  只能有一个请求成功出队，同一实例一次只派发一个 Task；
- 执行能力继续受既有 Worker 并发和 Task active Run 约束；
- 需要审批的任务跳过并写 `teammate_events`，不创建 Run；
- 人工“立即执行一轮”走同一 `runAutoQueue` 逻辑，只处理指定实例。

周报是确定性快照，不调用模型：

- 按 UTC Monday-Sunday 归一；
- 汇总 queued / running / review / done / failed / needsInput；
- 内嵌同一周的 Run 时长、Token、成本、unknown 和 reconciliation；
- 同一实例同一周覆盖当前报告快照，不生成伪造的历史 Run。

安全转派：

- 目标必须是 active Human Principal 和 active Project member；
- 有 active Run 时拒绝；
- 只修改 owner，不改变 AI Principal、Agent、模板版本或既有 Run attribution；
- 追加不可变 transfer 与 event。

## 9. API

```text
GET    /api/v1/teammate-templates?projectId=
POST   /api/v1/teammate-templates
GET    /api/v1/teammate-templates/:templateId
PATCH  /api/v1/teammate-templates/:templateId
POST   /api/v1/teammate-templates/:templateId/archive

GET    /api/v1/teammates?projectId=
POST   /api/v1/teammates
GET    /api/v1/teammates/:teammateId
POST   /api/v1/teammates/:teammateId/status
POST   /api/v1/teammates/:teammateId/auto-execute
POST   /api/v1/teammates/:teammateId/transfer

GET    /api/v1/teammates/:teammateId/work-queue
POST   /api/v1/teammates/:teammateId/work-queue/reorder
POST   /api/v1/teammates/:teammateId/work-plans/parse
POST   /api/v1/teammates/:teammateId/work-plans
POST   /api/v1/teammates/:teammateId/auto-run

GET    /api/v1/teammates/:teammateId/economics
GET    /api/v1/teammates/:teammateId/execution-history
GET    /api/v1/teammates/:teammateId/weekly-reports
POST   /api/v1/teammates/:teammateId/weekly-reports/generate
```

Web 新增 AI Teammate 操作页，覆盖模板版本、实例、队列、自动执行、统计、历史、
周报、暂停/恢复/归档和安全转派。桌面、900px 和 390px 三视口无水平溢出。

## 10. 回滚

Migration 30 只新增表和 maintenance schedule，可用以下顺序回滚：

1. 停止 Worker 和 API。
2. 删除 `runtime_maintenance_schedules` 中 `kind='teammate_queue'` 的行。
3. 将 `runtime_maintenance_runs` / `runtime_maintenance_schedules` kind 约束恢复为
   `idempotency_cleanup`、`approval_sla`、`lease_recovery`、`effect_recovery`。
4. 按依赖逆序删除：
   - `teammate_weekly_reports`
   - `teammate_run_attributions`
   - `teammate_work_items`
   - `teammate_work_plans`
   - `teammate_events`
   - `teammate_transfers`
   - `teammates`
   - `teammate_template_versions`
   - `teammate_templates`
5. 删除本批 trigger functions、indexes 和 `platform_migrations.version=30`。

回滚前应先导出新 Teammate 数据；回滚不删除 Task、Run、Ticket、Gate、Scene Session、
Context Receipt、usage receipt 或 audit，因此既有执行历史仍可按原边界读取。

## 11. 验证

- Migration：fresh `0 -> 30`、upgrade `29 -> 30` 通过。
- Upgrade fixture：历史 Task 保留；attribution backfill 为 `0`。
- 表检查：9 张 `teammate_*` 表；`teammate_queue` schedule 为 1。
- Batch 17B 定向 Vitest：14 files / 47 tests 通过。
- 完整 Vitest：60 files / 277 tests 通过。
- Playwright：模板/实例、工作计划、队列、自动执行、生命周期、周报通过；
  `1440x960`、`900x900`、`390x844` 无水平溢出。
- 四入口回归：Task、Workflow Task、Meeting AI、Direct Chat 通过。
- Fail-closed 回归：无 Ticket/Gate、pending/reject Gate、Scene mismatch、Cursor
  conflict、重试冲突均继续拒绝。
- Typecheck、lint、packages/API/Worker build、Web production build、
  `git diff --check` 和脚本语法检查通过。

已知非阻断告警：

- Web production bundle 单 chunk 超过 500 kB。
- `tsdown` 的 `external` deprecation、d.ts sourcemap 和既有 chunk warning。
- Worker 的 `teammate_queue` 是固定 interval maintenance，不是通用 scheduler；
  独立 `dsh-collab-scheduler` 不在本批。

## 12. 本批边界

未实现：

- Batch 18 Meeting Collaboration：Facilitator 生命周期、Delegate、私密嘱咐、
  会议文件与归档增强；
- Shared Space、Lane 级路径写权限、Locks、Global Write；
- sandbox 扩展；
- Provider Session resume；
- Runtime 级 `maxTurns` / `maxToolCalls` / `maxCost` 强制执行；
- 旧 KV Teammate 的自动数据迁移和双写。

本批没有修改 15A Execution Envelope、policy revision、Run 快照语义，没有修改
15B Ticket/Gate/Ticket Token 语义，也没有绕过 Batch 16 Scene Session、Cursor 或
Context Receipt。
