# AI Teammate 任务队列与自动执行 技术设计

> 文档状态：v1.1（按「队列是产品本体、夜班只是使用场景」重写）
> 对应产品文档：[teammate-work-queue-prd.md](./teammate-work-queue-prd.md)
> 关联实现：
> - `plugins/dsh-collab-task`（任务、run 投影、派发入口）
> - `plugins/dsh-collab-teammate`（实例、定义、工作计划、日报、审计）
> - `plugins/dsh-collab-agent`（Agent Run 生命周期）
> - `plugins/dsh-collab-employee`（数字员工、Action Ticket）
> - `plugins/dsh-collab-workbench`（工作台待办 / 关注 / 简报）
> 说明：本期只输出设计，不写实现代码。

## 1. 现状盘点

### 1.1 已具备的能力

| 能力 | 位置 | 说明 |
| --- | --- | --- |
| 任务实体与状态机 | `dsh-collab-task` `service.ts` | todo / progress / review / done / cancelled；`autoSubmitReview`；`agentRunIds`；messages / events / comments |
| 派发链路 | `dsh-collab-task` `index.ts` | `createTaskDispatcher()`：开通执行身份 → 唤起 Agent → 回写 run；通过 `collabTaskDispatch` 供其它插件复用 |
| Run 生命周期 | `dsh-collab-agent` | queued / running / waiting_input / succeeded / failed / timeout / cancelled / interrupted；`bindTask({ onSettled })` |
| 执行回写 | `task/service.ts` `attachAgentRun()` | 写 Agent 消息、追加 runId、状态流转、失败原因回写 |
| 实例与 owner | `dsh-collab-teammate` `runtime.ts` | 实例 owner = 实例创建人（`ownerUserId`）；`ownerOf(ref)` 支持 teammate id 与员工身份 id |
| 工作计划（队列） | `dsh-collab-teammate` `index.ts` | 计划项 = 指派给实例且 `status=todo` 的常规任务；创建即派发 |
| Action Ticket | `dsh-collab-employee` | principal / workspaceId / contextType / contextId / allowedActions / deniedActions / resourceScopes / expiresAt；deny-wins |
| 进程内受控队列 | `agent-workflow-execution-phase-x.md` | 每工作区 2 并发、全局 4 并发、同节点串行、重启可重入队 |
| 工作台待办 | `dsh-collab-workbench` `service.ts` | `ownsTask()` + `myAgentIds()` 判定「我的」 |

### 1.2 本轮已修复的缺陷（设计前提）

1. 归属判定不一致：任务看板依赖目录里的 `ownerAuthUserId`，而目录的 teammate 分支既没给该字段、也没有 `employeeId` 别名；工作台只认员工身份 id。已修：目录补 `ownerUserId`（实例创建人）+ `employeeId`，客户端两种 id 都匹配，工作台改为「实例 owner 优先」。
2. 执行完成没有交回 owner：已修，新增 `resolveOwnerHandoff()`，在 `createTaskDispatcher()` 与 `bindTask.onSettled()` 两处共用；非工作流任务且开启自动提交 review 时，把 receiver 从 Agent 改为实例 owner，并写「已提交 YY 确认」事件。

### 1.3 仍然缺失的能力

| 缺口 | 影响 |
| --- | --- |
| 队列顺序仅按「优先级 + 创建时间」，不支持人工排序 / 依赖 / 暂停 | 自动执行顺序不可控 |
| 没有自动执行时段配置与轮次记录 | 无法定时按序执行、无法幂等、无法汇总 |
| 没有「待补充 / 反馈项」的显式状态 | 需要人工输入的任务只能靠自然语言说明，容易卡死或编造结论 |
| 没有预扫描与预授权流程 | 无人值守时段因缺工具/缺权限空跑 |
| 没有平台级定时器 | 只能人工点击启动；由独立插件 `dsh-collab-scheduler` 承载（见 §9） |

> 设计取舍：**不引入「班次 / 批次」业务对象**。队列本身就是任务集合，时段是队列的执行配置，轮次只是运行记录（用于幂等与统计）。

## 2. 领域模型

### 2.1 复用而非新建

延续「计划项 = 常规任务」的原则，不新增队列项实体：队列是任务的视图，避免双写与状态漂移。

| 实体 | 载体 | 变更 |
| --- | --- | --- |
| 任务（队列元素） | `collab_task.tasks` | 新增队列字段（见 2.2） |
| 执行记录 | `collab_agent.runs` | 不变 |
| 待确认 / 反馈 | 任务状态 + 消息 + 事件 | 新增消息/事件类型（见 5.2） |
| 自动执行配置 | `collab_teammate.teammates`（实例记录） | 新增 `autoRun` 字段（见 2.3） |
| 平台默认值 | 新表 `collab_teammate.settings`（单行 `queueDefaults`） | 新建；同时注册 `settings.section` 设置界面 |
| 自动执行轮次 | 新表 `collab_teammate.auto_run_passes` | 新建（内部运行记录，不面向用户管理） |
| 预授权 | `collab_employee.action_tickets` | `contextType="task"` + `contextId=taskId` 复用 |
| 预扫描结果 | 新表 `collab_teammate.task_preflights` | 新建（可重算的派生数据） |

### 2.2 任务记录新增字段

```ts
queueSeq?: number;                            // 队列顺序（越小越先）
queueState?: "idle" | "blocked" | "paused";   // 队列级状态（与任务 status 正交）
dependsOn?: string[];                         // 前置任务 id
autoRunEligible?: boolean;                    // 是否参与自动执行（默认 true）
preflight?: { status: "pending" | "ready" | "stale" | "failed"; gaps: number; scannedAt?: string };
passId?: string;                              // 所属自动执行轮次（运行时写入）
```

说明：优先用「同表可选字段」而不是新表；`queueSeq` 用稀疏整数（步长 1000）便于拖拽插入；老任务缺省按排序规则推导。

### 2.3 自动执行配置（工作区模板 + 实例覆盖）

两级配置：工作区级作为默认模板，实例可覆盖或退出；`windows` 只是「什么时候执行」的声明，实际触发由 `dsh-collab-scheduler` 负责（见第 9 节）。

```ts
export const autoRunConfigSchema = z.object({
  enabled: z.boolean().default(false),
  timezone: z.string().min(1).max(64),
  windows: z.array(z.object({
    kind: z.enum(["daily", "weekly", "weekday", "once"]),
    at: z.string().min(1).max(40),      // "20:00" / "1,3,5 20:00" / ISO 时间
    durationMinutes: z.number().int().positive().max(1_440),
  })).max(10).default([]),
  budgetMinutes: z.number().int().positive().max(1_440).optional(),   // 缺省取平台设置（默认 600）
  taskTimeoutMinutes: z.number().int().positive().max(1_440).optional(), // 缺省取平台设置（默认 30）
  requireAllAuthorized: z.boolean().default(false), // true=缺口未决则不启动
  autoPreflight: z.boolean().default(false),        // 是否在时段开始前自动预扫描（默认关闭，消耗 token）
});

// 存储：工作区级放工作区配置（collab_config），实例级放 teammate 记录上的 autoRun 字段；
// 解析顺序：实例覆盖 → 工作区模板 → 默认关闭。
```

#### 平台默认值（设置模块）

平台级默认值放在本插件新增的 `collab_teammate.settings` 表（单行 `queueDefaults`），并在宿主设置对话框注册一个 section：

```ts
export const queueDefaultsSchema = z.object({
  taskTimeoutMinutes: z.number().int().positive().max(1_440).default(30),
  budgetMinutes: z.number().int().positive().max(1_440).default(600),
  retryLimit: z.number().int().min(0).max(5).default(2),
  autoPreflight: z.boolean().default(false),
  windowsTemplate: z.array(/* 同 autoRunConfig.windows */).default([]),
});

// 客户端：ctx.slots.inject("settings.section", () => ctx.slots.register({ name: "settings.section", id: "pluginmax-teammate-queue", ... }))
// 与 identity / space / employee 插件现有做法一致（见 plugins/dsh-collab-space/client/index.js:1256）。
```

解析顺序：`平台设置 queueDefaults → 工作区配置 → 实例 autoRun`；校验时工作区/实例值不得突破平台安全上限（超时 ≥1 分钟、预算 ≤ 24 小时等）。

### 2.4 自动执行轮次（内部运行记录）

```ts
export const autoRunPassSchema = z.object({
  id: idSchema,
  teammateId: idSchema,
  workspaceId: idSchema,
  passKey: z.string().min(1).max(200),   // 幂等键：teammate + 窗口 + 日期
  startedAt: isoTimeSchema,
  endedAt: isoTimeSchema.optional(),
  trigger: z.enum(["schedule", "manual"]),
  endedReason: z.enum(["drained", "budget", "paused", "cancelled", "error"]).optional(),
  stats: z.object({
    total: z.number().int().nonnegative(),
    done: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    pendingConfirm: z.number().int().nonnegative(),
    pendingInput: z.number().int().nonnegative(),
    skippedNoAuth: z.number().int().nonnegative(),
  }).partial().optional(),
});
```

### 2.5 预扫描表（`task_preflights`）

```ts
export const taskPreflightSchema = z.object({
  taskId: idSchema,                            // 主键
  teammateId: idSchema,
  requiredTools: z.array(z.string().max(120)).max(50),
  requiredResources: z.array(z.string().max(300)).max(50),
  risks: z.array(z.string().max(200)).max(50),
  gaps: z.array(z.object({
    kind: z.enum(["tool_not_allowed", "resource_scope", "needs_human_approval", "no_tool"]),
    detail: z.string().max(500),
    resolved: z.boolean().default(false),
  })).max(50),
  confidence: z.number().min(0).max(1),
  scannedAt: isoTimeSchema,
  source: z.enum(["llm", "rules", "fallback"]),
});
```

## 3. 状态机与不变量

### 3.1 任务状态

```text
todo ──出队──▶ progress ──成功+review──▶ review ──通过──▶ done
  ▲                │                        │
  │                │ 失败/超时               │ 退回并补充
  └────重新入队────┴────────────────────────┘
                   │
                   └─ 需要人工输入 → 保持 progress + pendingInput 标记（反馈项）
```

### 3.2 不变量

1. 同一实例同一时刻最多 1 个 `progress` 且 run 为 active；
2. 任何 run 结束必须产生任务更新（消息 + runId + 状态 + 责任人），不允许静默结束；
3. `review` 状态的任务，接收方必须是人类（实例 owner；owner 不可用时工作区 owner）；
4. 依赖未完成的任务不得出队；
5. 无有效 Action Ticket 的工具调用必须被服务端拒绝（deny-wins）；
6. 同一实例同一时段同一日期只产生一个 `auto_run_passes`（`passKey` 唯一）；
7. 队列顺序变更必须写入审计事件。

## 4. 调度器设计

### 4.1 触发点（事件驱动，不做轮询式扫描）

| 事件 | 动作 |
| --- | --- |
| 任务创建 / 退回 / 催办 | 入队（写 queueSeq），尝试出队 |
| run settled | 回写结果 → 出队下一个 |
| 自动执行时段到点 | 创建 `auto_run_pass` → 按序出队 |
| 人工操作（暂停/跳过/上移/立即开始一轮） | 变更 queueState / queueSeq / 触发轮次 |
| 实例状态变化（生效/暂停/归档） | 暂停或恢复队列 |

### 4.2 出队判定（纯函数，便于单测）

```ts
function pickNextTask(input: {
  tasks: TaskRecord[];          // 该实例、非归档
  running: boolean;             // 该实例是否有 active run
  pass?: AutoRunPass;           // 当前轮次（人工触发时为空）
  now: Date;
}): TaskRecord | undefined
```

规则顺序：

1. 实例可执行（active 且无 active run）；
2. 若在轮次中：要求任务 `autoRunEligible`、已预扫描且缺口已决策（未预扫描的任务不参与自动轮次）；
3. 过滤 blocked / paused / 依赖未满足；
4. 排序：**人工 queueSeq 为准**；没有人工顺序时用 draft 顺序（优先级 → 截止 → id）。

> 优先级不参与运行时强制排序：它只用于新队列的 draft 初始化与人工调整时的参考；新任务默认入队尾（`queueSeq = max + 1000`）。

### 4.3 并发与公平

1. 单实例串行；
2. 复用既有的进程内队列语义（每工作区 2、全局 4），不引入分布式锁；
3. 队列积压时按实例轮转，避免单实例饿死其它实例（RR）；
4. 实例之间可并行启动各自的轮次；同一实例内严格串行。

### 4.4 幂等与恢复

1. 派发幂等键沿用 `dispatchKey = taskId:runSeq`；
2. 服务重启：`queued` 可重入队；`running` 先标 `interrupted`，由 owner 决定重试或转人工（与既有队列一致）；
3. 轮次幂等键 `passKey`（teammate + 窗口 + 日期），重复触发只生效一次；轮次中断后恢复时沿用同一个 `passId` 继续跑剩余任务。

## 5. 执行回写与待确认链路

### 5.1 run settled 处理链（已有 + 扩展）

```text
run settled
  → attachAgentRun(taskId, run, receiverName, ownerHandoff)
       ├─ 写 Agent 消息（摘要 + runId + state）
       ├─ 追加 agentRunIds
       └─ 状态流转
            ├─ 成功 + autoSubmitReview → review，receiver = 实例 owner（已实现）
            ├─ 成功 + 不提交 review → done
            └─ 失败 → progress + 失败原因（新增：可选自动重试）
  → 累加 pass 统计（若在轮次中）
  → 出队下一个（新增）
  → 写审计（扩展事件类型）
```

### 5.2 消息与事件扩展

| 类型 | 用途 |
| --- | --- |
| `task.messages.kind = "agent"`（已有） | Agent 输出摘要 |
| `task.messages.kind = "system"`（已有） | 派发失败、系统提示 |
| 新增 `task.messages.kind = "handoff"` | 「已提交 XX 确认」/「已退回，原因…」 |
| 新增事件 kind `retry` / `requeue` / `confirm` / `auto-run` | 队列、轮次与确认动作留痕 |

### 5.3 待确认动作的契约

```http
POST /api/collab/tasks/confirm
{ "taskId": "TSK-…", "action": "approve" | "reject" | "handoff",
  "note": "可选说明", "assigneeId": "可选，转人工时指定" }
```

语义：`approve` → done 并记录验收人；`reject` → 追加人类指令消息、任务回 todo 并重新入队、由队列触发新 run；`handoff` → receiver 改为指定人类成员并离开该实例队列。

**验收人解析**（`resolveReviewer(task)`）：

```text
实例 owner（teammate.ownerUserId）
  └─ 若该用户不存在 / 已停用 → 工作区 owner（members 中 role=owner）
       └─ 再兜底 → 平台管理员
```

### 5.4 历史数据兼容

1. 老任务 receiver 为员工身份 id：判定与筛选已兼容（保留 `employeeId` 别名匹配）；
2. 已 `review` 但仍挂在 Agent 名下的任务：一次性迁移把 receiver 改为实例 owner 并补一条 handoff 事件；
3. 新字段全部可选，老任务按默认值（queueSeq 按排序规则推导、autoRunEligible=true）。

## 6. 预扫描与预授权

### 6.1 预扫描管线（按需触发，默认不做）

触发方式（两条，都默认关闭/不自动）：

1. 用户批量勾选待办任务 → `POST /api/collab/teammates/:id/work-queue/preflight`（body 为 `{ taskIds: string[] }`）→ 逐任务扫描；单任务详情也可单独发起；
2. 实例配置 `autoPreflight=true`（默认 false）时，才在进入自动执行时段前自动扫描「本轮将出队的任务」。

```text
用户发起 preflight（批量）
  → 逐任务异步执行（不阻塞界面，进度可轮询）
     1. 规则层：关键词 → 工具候选表（shell / 文件写 / HTTP / 检索 / 子代理 / 会议 / 工作流）
     2. 模型层（可选）：用实例默认模型做一次「工具需求推断」，输出结构化 JSON
        （requiredTools / requiredResources / risks / confidence）
     3. 能力对比：与 (a) 实例 Agent Profile 的 allowedTools、(b) 员工 Runtime Profile 工具策略、
        (c) 工作区与成员权限 求交，得到 gaps
     4. 写 task_preflights，并在任务上更新 preflight 摘要
```

约束：

1. 预扫描不产生任何授权副作用，也不自动执行任务；
2. **模型不可用或推断失败时 `source="fallback"`、`confidence=0`、gaps 记 `needs_human_approval`**（按「未知需求」要求人工确认，不猜）；
3. **未预扫描的任务视为「未知需求」**：不参与自动执行时段的自动出队，只等人工触发；
4. 任务描述变化时 `preflight.status="stale"`；`stale` 同样不参与自动出队。

### 6.2 预授权（复用 Action Ticket）

```http
POST /api/collab/employee/ticket           # 已存在
{ "employeeId": "digital-…", "workspaceId": "…",
  "contextType": "task", "contextId": "TSK-…",
  "requestedActions": ["shell.exec", "fs.write"],
  "resourceScopes": ["workspace:.tmp/smoke-workspace"],
  "runId": "可选", "durationMinutes": 600 }
```

新增要求：

1. 批量签发 `POST /api/collab/teammates/:id/work-queue/authorize`，body 为 `{ decisions: [{ taskId, gapIndex, decision: "allow"|"deny"|"narrow", actions?, scopes? }] }`，服务端逐项校验后签发/拒绝并回写 `task_preflights.gaps[].resolved`；
2. 校验规则：签发者权限 ⊇ 请求动作（deny-wins）、资源范围必须落在工作区内、有效期覆盖即将到来的自动执行时段；
3. 被拒绝的缺口 → 对应任务本轮自动跳过（`skippedNoAuth`），不空跑；
4. 运行期复用现有 ticket 校验与审计（ticketId + 校验结果，失败也留痕）；
5. 执行动作允许范围：**白名单 ∩ ticket ∩ 工作区权限**，落在交集内的高风险动作允许执行（产品决策：白名单内允许）。

### 6.3 自动执行前的就绪检查

```text
T-30min:
  实例 active?
  队列有可执行任务（autoRunEligible、已预扫描、依赖满足）?
  缺口是否全部决策（allow / deny）?
→ requireAllAuthorized=true 且未决：不启动，通知 owner
→ 默认策略：按已授权任务启动；未预扫描 / 未授权 / stale 的任务跳过并计入 pass.stats.skippedNoAuth
```

实例之间可并行启动各自的轮次（工作区并发上限 2、全局 4）；同一实例内严格串行。

## 7. 自动执行轮次执行器（设计）

```text
时段到点（或人工「立即开始一轮」）
  创建 auto_run_pass（passKey 幂等）
  loop:
    pickNextTask(...)
    if none → endedReason = "drained"
    if now > windowEnd 或超出 budget → 剩余任务保持待启动且保持原顺序（下一轮优先），endedReason = "budget"
    dispatch(task)                       # 复用 createTaskDispatcher
    await run settled
    attachAgentRun(...) + ownerHandoff   # 已实现
    累加 pass 统计（done / failed / pendingConfirm / pendingInput）
  结束后：
    写审计
    自动执行小结并入当日工作日报（见 7.1）
```

异常策略：

| 情况 | 处理 |
| --- | --- |
| run 失败/超时 | 单任务超时默认 30 分钟（平台设置可调）；最多重试 2 次（退避），仍失败标「待确认 · 失败」并继续 |
| 需要人工输入 | 任务挂起为「待补充」，本轮继续，不阻塞 |
| 缺 ticket / ticket 过期 | 立即失败并标「缺授权」，本轮跳过，不重试 |
| 实例被暂停/归档 | 本轮暂停，未开始任务保持待启动 |

### 7.1 结果呈现（并入工作日报）

不产出独立的「晨间交接卡」。轮次结束后，把小结写入当日工作日报快照：

1. 复用 `WorkReportService`（`work_reports` 表）与 `report-runtime.ts` 的生成管线；
2. 生成提示词新增「无人值守执行小结」输入：`pass.stats` + 每个任务的最终状态与结论；
3. 日报仍是「同日期一份快照」，手动更新覆盖（沿用既有规则）；
4. 需要人类当班处理的事项按优先级与截止时间排序输出在日报中。

## 8. API 契约汇总（新增 / 调整）

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/collab/teammates/:id/work-queue` | 队列四分组 + 顺序 + 预扫描摘要 |
| POST | `/api/collab/teammates/:id/work-queue/reorder` | 调整 queueSeq |
| POST | `/api/collab/teammates/:id/work-queue/preflight` | 批量预扫描（body: `taskIds[]`；默认不自动扫描） |
| POST | `/api/collab/teammates/:id/work-queue/tasks/:taskId/preflight` | 单任务触发 / 重算预扫描 |
| POST | `/api/collab/teammates/:id/work-queue/authorize` | 批量预授权（签发 Action Ticket） |
| GET/PUT | `/api/collab/teammates/:id/auto-run` | 读取/更新自动执行配置（实例覆盖工作区模板） |
| POST | `/api/collab/teammates/:id/auto-run/start` | 立即开始一轮（`passKey` 幂等；由人工或调度器调用） |
| POST | `/api/collab/tasks/confirm` | 待确认：通过 / 退回 / 转人工 |

现有接口保持不变：`/api/collab/teammates/work-plans`（创建计划项）、`/api/collab/tasks/*`、`/api/collab/workbench/*`。

## 9. 定时触发：与 `dsh-collab-scheduler` 的契约（通用调度器）

Teammate 侧**不内置定时器**，只提供「立即开始一轮」的能力；到点触发由独立插件 `dsh-collab-scheduler` 负责。该插件未来还要支撑用户自建定时任务，因此按通用模型设计。

### 9.1 调度域模型（通用）

**时间规则与触发目标分离**：

```ts
export const scheduleRuleSchema = z.object({
  kind: z.enum(["once", "interval", "daily", "weekly", "weekday", "cron"]),
  expression: z.string().min(1).max(120),  // "2026-10-13T20:00:00+08:00" / "20:00" / "1,3,5 20:00" / "*/15 * * * *"
  timezone: z.string().min(1).max(64),
  startAt: isoTimeSchema.optional(),
  endAt: isoTimeSchema.optional(),
  catchUp: z.enum(["skip", "run-once", "run-all"]).default("skip"),
});

export const scheduledJobSchema = z.object({
  id: idSchema,
  scope: z.enum(["user", "workspace", "platform"]),
  ownerUserId: idSchema,
  workspaceId: idSchema.optional(),
  title: z.string().min(1).max(120),
  enabled: z.boolean().default(true),
  rule: scheduleRuleSchema,
  target: z.object({
    type: z.enum(["teammate.auto-run", "work-report.generate", "brief.generate", "workflow.start", "http.callback"]),
    params: z.record(z.string(), z.string()).default({}),
  }),
  concurrency: z.enum(["skip", "queue", "parallel"]).default("skip"), // 上一次未结束时如何处理
  idempotencyKey: z.string().min(1).max(200),
  createdAt: isoTimeSchema,
  updatedAt: isoTimeSchema,
  lastRunAt: isoTimeSchema.optional(),
  nextRunAt: isoTimeSchema.optional(),
});

export const scheduledJobRunSchema = z.object({
  id: idSchema,
  jobId: idSchema,
  triggeredAt: isoTimeSchema,
  finishedAt: isoTimeSchema.optional(),
  status: z.enum(["running", "succeeded", "failed", "skipped"]),
  detail: z.string().max(2_000).optional(),
});
```

要点：

1. 触发目标用 `target.type + params` 表达，新增目标类型不改调度核心；
2. `idempotencyKey`（job + 触发时刻）保证同一时刻只触发一次；
3. `concurrency` 决定「上一次还没跑完时」的处理（跳过 / 排队 / 并行）；
4. `nextRunAt` 由规则推导并落库，重启后可恢复；
5. 每次触发写一条 `scheduled_job_runs`，失败原因可查、可手动重跑。

### 9.2 Teammate 侧要暴露的能力（target 契约）

```http
POST /api/collab/teammates/:id/auto-run/start
{ "trigger": "schedule" | "manual", "passKey": "tm-…:2026-10-13:daily-2000" }
→ { "passId": "…", "started": true, "reason": "started" | "already-running" | "no-eligible-task" | "instance-inactive" }
```

约定：

1. `passKey` 由调度器生成并透传，Teammate 侧用它做幂等（同一 key 只产生一个轮次）；
2. 返回 `no-eligible-task` / `instance-inactive` 时调度器记 `skipped` 并说明原因，不重试；
3. Teammate 侧不感知「时段」，只负责「开始一轮 → 按队列顺序跑到没有可执行任务或预算用尽」；
4. 轮次的开始/结束通过审计事件回写，调度器历史里可跳转到 Teammate 的历史记录。

### 9.3 部署与订阅方式

1. 两个插件通过 `ctx.inject(["collabScheduler"], …)` 建立**进程内服务调用**（首选），或通过 `inject` 后调用其服务方法注册目标处理器；
2. 不采用 HTTP 回调自调用，避免同进程绕一圈；
3. 调度器与 Teammate 的依赖方向：调度器 → Teammate（调度器依赖 target 注册表，Teammate 注册自己的 target 实现），避免 Teammate 反向依赖调度器。

### 9.4 实施顺序建议

| 顺序 | 内容 | 理由 |
| --- | --- | --- |
| 1 | Teammate 队列 P1/P2（排序、待确认、反馈项、预扫描/预授权）+ 「立即开始一轮」入口 | 产品本体，不依赖调度器即可交付 |
| 2 | `dsh-collab-scheduler` 领域模型 + 规则引擎 + `scheduled_job_runs` + 手动执行 | 抽象先定，避免过度设计；此时已有真实 target 可联调 |
| 3 | 把 `teammate.auto-run` 接成调度器的第一个 target | 用真实场景验证调度器 |
| 4 | 上线「用户自建定时任务」管理面（第二个 target 生态） | 通用能力对外 |

若团队可并行：第 2 步的领域模型可与第 1 步同期开发，但**不要在 Teammate 侧写任何临时定时器**（否则后续要迁移）。

## 10. 前端交互要点

1. 工作计划页签演进为「任务队列」：四个分组 + 拖拽排序 + 队列头部一条自动执行设置条（「今天 20:00 自动开始 · 队列 8 项 · 3 项缺授权」）；
2. 任务卡徽标：预扫描中 / 缺授权(N) / 待确认 / 待补充；
3. 预授权清单：按风险分组，支持「范围内全部允许」与逐项拒绝，显示每个决定的动作与范围；
4. 待确认操作区：通过 / 退回并补充（必填原因）/ 转人工；
5. 无人值守结果只出现在工作日报的「无人值守执行小结」章节（不新增独立页面）；
6. 所有「我的」筛选旁标注口径（本人 + 我的实例 + 我的席位），避免再次出现「对不上」的困惑。

## 11. 权限矩阵

| 动作 | 实例 owner | 工作区 owner | 平台管理员 | 其它成员 |
| --- | --- | --- | --- | --- |
| 查看队列 | ✓ | ✓ | ✓ | 仅可见范围 |
| 调整顺序 / 取消 | ✓ | ✓ | ✓ | ✗ |
| 待确认（通过 / 退回） | ✓ | ✓（owner 不可用时兜底） | ✓ | ✗ |
| 配置自动执行时段 | ✓ | 可配置 | ✓ | ✗ |
| 预授权签发 | ✓ | ✗ | ✓ | ✗ |
| 立即开始一轮 | ✓ | ✗ | ✓ | ✗ |
| 平台默认值（超时 / 预算 / 重试 / 时段模板） | ✗ | ✗ | ✓ | ✗ |
| 工作区级默认值覆盖 | ✗ | ✓（不突破平台上限） | ✓ | ✗ |

## 12. 测试策略

1. 纯函数单测：`pickNextTask` 排序与过滤、依赖与阻塞、queueSeq 插入、`resolveReviewer` 兜底链；
2. 服务层单测：run settled → 回写 + 交回 owner（已有用例）、退回重排、轮次幂等（passKey）、缺授权跳过；
3. 契约测试：新增接口的鉴权与错误码、ticket 校验 deny-wins；
4. GUI 用例（沿用现有 gui-test-plan 结构）：
   - 计划项 → 执行 → 待确认出现在 owner 待办；
   - 退回并补充 → 回到队列 → 新一轮 run；
   - 预扫描缺口 → 预授权 → 到时自动执行 → 按序推进；
   - 未授权任务被跳过，不空跑；
   - 轮次结束后的当日工作日报包含「无人值守执行小结」；
5. 回归：本轮修复的两条口径用例必须保留（工作台两形态、目录 owner / employeeId）。

## 13. 分期实施

| 期 | 内容 | 依赖 |
| --- | --- | --- |
| P0（已完成） | 归属口径统一 + 执行完成交回 owner | — |
| P1 | 队列视图（四分组 + 排序 + 依赖 + 暂停）、待确认动作 `/tasks/confirm`、反馈项状态、`resolveReviewer` 兜底 | 任务表新增可选字段 |
| P2 | 批量预扫描（按需触发，默认关闭）与批量预授权（复用 Action Ticket）、自动执行配置、**平台设置 section（默认超时/预算/重试）** | P1、employee ticket API |
| P3 | 自动执行轮次执行器（串行出队、失败重试、预算与顺延）、日报「无人值守执行小结」 | P2 |
| P4 | 独立插件 `dsh-collab-scheduler`：通用定时任务域模型 + 规则引擎 + 触发记录 + 手动执行 | 见 §9.4 顺序建议 |
| P5 | 把 `teammate.auto-run` 接成调度器第一个 target；随后开放「用户自建定时任务」 | P4 |

## 14. 已决策与待确认

已决策（2026-10-12 评审）：

1. 定时触发落在独立插件 `dsh-collab-scheduler`，按通用定时任务管理设计（目标类型可扩展，见 §9.1）；Teammate 侧不写临时 timer；
2. 实施顺序：先队列（P1/P2）与「立即开始一轮」，再做调度器（P4），最后对接（P5）；可并行但不要先在 Teammate 里实现定时；
3. 预扫描默认关闭，由用户批量勾选任务发起；仅在实例配置 `autoPreflight=true` 时才自动扫描；
4. 未预扫描 / stale 的任务不参与自动出队；
5. 允许工作区级统一时段 + 实例覆盖；多实例并行开始，同一实例内串行；
6. 人工排序为准，优先级只用于 draft 与人工参考；新任务入队尾；
7. 预算未跑完的任务下一时段优先（保持原顺序）；
8. 验收人只认实例 owner，不可用时转工作区 owner；
9. 自动执行允许「白名单 ∩ 预授权」内的动作（含高风险）；
10. 无 LLM 时预扫描按「未知需求」要求人工确认；
11. 不产出独立「晨间交接卡」，结果并入当日工作日报。
12. 单任务默认超时 30 分钟、队列单轮时长预算 10 小时，作为**平台设置**中的默认值（`settings.section` → queueDefaults），支持「平台 → 工作区 → 实例」逐级覆盖；
13. 待确认超时的自动处理（提醒 / 转重点关注 / 降优先级）**本期不做**。

仍待确认：

1. 平台设置里除了超时 / 预算 / 重试 / 时段模板，是否还要放开「并发上限」等参数？
2. 调度器的存储与作用域细化：工作区级定时任务是否允许跨工作区触发（当前设计为不允许）。
