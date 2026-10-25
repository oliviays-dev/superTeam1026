# 会议 AI 参会：任务与会话衔接设计

> 关联：`agent-task-home-session-design.md`（`de-task-*` 会话、增量上下文投递、触发规则）。

## 1. 需求

1. 拉 AI teammate 进会议时，为它创建一条**「会议」类型任务**指派给该 agent，并创建对应会话，
   使 agent 处于运行/监听状态。
2. 左侧项目树能看到该会话，能看 agent 的思考与回答过程。
3. **被动**：AI 被 `@` 时等同定向任务指令，携带会议上下文调用它，反馈写回会议聊天并记入 task。
4. **主动**：agent 依 owner 的会议嘱咐（`delegate_instructions`）持续监控，在需要处主动发言。
5. 同一 agent + 同一会议**复用同一条 task**，经 task 路径创建/复用会话。

## 2. 现状（代码事实）

- 会议 AI 参与者两类：`ai_teammate`（`addAiTeammate`）、`ai_representative`（`addAiRepresentative`，
  绑定 `delegateId` + 私有嘱咐 + `speechMode`）。
- 触发链路：`POST /meeting/message` → `MeetingRuntime.dispatch()` → `runWorker()` →
  `subagents.start(...)`。这是**一次性 worker**（`toolFilter:{allow:[]}`），不建 task、
  不建持久会话、不出现在左侧项目树（`plugins/dsh-collab-meeting/src/index.ts`）。
- 任务域已具备全部原语：`TaskRecord.links:[{type:"meeting"|"workflow",id,label}]`（客户端已渲染
  「会议 / 打开会议」）、任务时间线 + `deliveredThroughMessageId` 增量投递、
  `TaskDispatchService.dispatch(task, actor)` → `de-task-<taskId>-<employeeId>` 会话、
  `TaskService.create/update/message` 与 `collab/task-changed` 事件。
- 因此需求要的原语都在，缺的是**会议 ↔ 任务域桥接**。

## 3. 方案

会议 AI 参与从一次性 worker 改为任务会话链路：

```
会议事件（入会 / @ / 新消息）
  → 会议侧编排器 MeetingAgentSessionService
  → 任务域：find-or-create 会议任务 + 追加 task message + dispatch
  → Agent Run / de-task-* 会话（左侧可见，可看思考）
  → 回复回写会议 transcript + 记入 task
```

### 3.1 复用键

`(meetingId, teammateInstanceId)` → 唯一 taskId：反查
`links.some(l => l.type === "meeting" && l.id === meetingId)` 且
`receiverId === teammateInstanceId` 且任务未终态；命中即复用。

### 3.2 入会

`/meeting/participant/ai`、`/meeting/delegate/assign` 成功后：ensure task
（`type:"会议"`、`receiverType:"agent"`、`receiverId:teammateInstanceId`、
`links:[{type:"meeting",id,label}]`、description 含议程/嘱咐）→ `dispatch` 首次派发建会话。

### 3.3 被动（@）

`POST /meeting/message` 中对被 @ 命中的 AI 参与者：追加一条 task message（原文）→ `dispatch`
（任务域按游标只投增量，`triggerContent` = 被 @ 的消息）→ 回复回写 transcript
（`senderKind=ai`、`provenance.role=representative`、带 `delegateId`/`teammateInstanceId`/`runId`）+ 记入 task。

### 3.4 主动

| speechMode | 投递范围 |
| --- | --- |
| observer | 不投递，仅人工显式 `trigger()` |
| mention | 仅被 @ 的消息 |
| key_topic | 命中 `focusPoints` 的消息 |
| active | 每条人类消息（频控：最小间隔 + 每会议上限） |

投递与「是否真的发言」解耦：agent 可判定「无需插话」而不产生会议消息。

### 3.5 回复回写

- **A（推荐）**：`dispatch` 返回的 execution 取 `runId`，会议侧订阅 agent run 结束 /
  `collab/task-changed`，成功后取 run 的 `output.summary` 写 transcript（复用
  `MeetingService.postWorkerReply()`）。
- **B**：任务域新增可选 `onAgentReply(task, runId, text)` 回调，会议侧注册。

### 3.6 兜底

任务域不可用时保留现 `MeetingRuntime` 一次性 worker；两条路径以「该参与者是否已绑定 task」
互斥，避免重复发言。

## 4. 变更清单

| 模块 | 变更 |
| --- | --- |
| meeting | 新增 `src/agent-sessions.ts` 编排器；routes 注入可选 `collabTasks`/`collabTaskDispatch`；`/participant/ai`、`/delegate/assign`、`/message` 接线；`MeetingRuntime` 降级兜底；参与者投影补 `taskId` |
| task | 选 B 才需改（加回复回调）；选 A 只需确认 `dispatch` 暴露 `runId` |
| client | 会议成员卡片显示运行态与「查看会话」入口（跳任务详情，已支持会议链接） |
| 测试 | 复用同一 task、@ 触发一次派发、active 逐条投递、回复回写 transcript+task、任务域缺失兜底 |

## 5. 分期

1. **P0**：入会建「会议」任务 + 派发会话 + 成员卡片可见运行态（需求 1/2/5）。
2. **P1 被动**：@ 触发定向指令 + 回复回写（需求 3）。
3. **P1 主动**：按 speechMode/嘱咐投递 + 频控（需求 4）。
4. **P2**：会后结论回流行动项、会话归档。

## 6. 待确认

1. 「持续监听」= 复用同一 `de-task-*` 会话、按会议事件增量投递（DSH 的 run 是请求/响应，
   无常驻阻塞进程）。是否接受？
2. 回复回写走 A（会议侧订阅 run 结果）还是 B（任务域加回调）？
3. 主动交互口径：`active` 是否只投递人类发言？`key_topic` 的关注点取自
   `delegate_instructions.focusPoints`？频控阈值取多少？
