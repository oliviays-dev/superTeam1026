# DE 任务执行与任务会话设计

## 目标

任务指派给 DE 或人的数字分身后，不再要求用户额外点击“发送”触发执行。

执行必须产生一条归属于该任务的顶层 Session：同一个「任务 + DE」复用同一条会话，
不同任务各自独立。用户在左侧项目树中可以直接看到每个任务的 DE 执行会话、过程事件
和最终回复，而不是只能在任务详情里等待最终结果。

## 触发规则

- 新建任务时接收方是数字员工：创建成功后自动派发一次 Agent Run。
- 已有任务被改派给数字员工：接收方发生变化后自动派发一次 Agent Run。
- 重复确认同一接收方：不重复派发。
- 指令输入框（发送给执行人）的消息：默认就是给执行人的指令，**直接派发一次 Agent Run**，不需要 @。
- 评论区 / 回复：属于讨论区，默认只记录、**不触发执行**；评论里 @ 执行人才派发一次。
- 人类之间的讨论：写入任务时间线并进入下一次执行的上下文，但不触发执行。
- Agent 自己的回复、系统事件、执行失败信息：不触发执行。
- 工作流 Task Worker：保持原有一次性 subagent 执行方式。

## 上下文投递

- 首次执行（同一任务 + 同一执行人的第一轮）：投递任务头部（编号、标题、类型、优先级、项目、
  描述、验收标准、关联对象）加上当前完整时间线（人类讨论、Agent 回复；系统事件与失败信息不投递）。
- 后续执行：只投递**增量**——上一轮投递之后新增的消息；任务头部不重复发送，因为会话历史里已经有了。
- 投递游标记录在 Agent Run 的 `payload.context.deliveredThroughMessageId`，同时记录
  `taskReceiverId`、`triggerMessageId`、`firstDelivery`，便于审计与幂等。
- 系统消息与执行失败信息永远不参与上下文，也不会被当成指令。
- Session 命名：新任务会话 id 为 `de-task-<taskId>-<employeeId>`（重置会话后追加 `-r<代数>`），
  标题为 `TSK-任务名称-任务号后4位-执行人`（去掉空白字符，例如 `TSK-正在测试05-0089-DE测小白`）；
  旧 `de-home-*` 会话保留原样、只读，不再复用，也不改写标题。

## 任务会话身份

- 一个「任务 + AI Teammate」只对应一条会话，即任务 + DE 是会话身份。
- Session ID 由 `taskId + employeeId` 固定派生（`de-task-<taskId>-<employeeId>`），不随追问轮次变化。
- Session 标题为 `TSK-任务名称-任务号后4位-执行人`，左侧项目树里能直接分辨是哪个任务、哪个执行人。
- 同一任务的追问复用同一条会话，多轮 user message 依次写入。
- 不同任务各自独立会话，互不排队；并发仍受全局与工作区 worker 上限约束。
- 服务重启后优先 resume 既有家会话；首次不存在时才创建。
- 同一任务并发追问共享同一个 Agent handle，创建过程使用 promise 去重，
  避免并发创建同一 Session。

## 执行链路

1. 任务服务校验数字员工、项目授权、Runtime Profile 和 Task Worker Profile。
2. Agent Run 记录 `workspaceId`、`workspacePath`、`employeeId`、`runSeq` 和 `dispatchKey`。
3. 任务型 Run 定位到该任务专属的会话（`taskId + employeeId` 派生）。
4. Session 以项目路径作为 `cwd`，绑定到对应的 Workspace。
5. 用户追加的 @ 消息直接作为原文发送，不再外包一层 Task Worker Prompt。
6. 首次派发没有用户消息时，只使用任务描述和验收标准作为初始消息。
7. Runtime 记录本轮开始前的 Session event offset，结束后只截取本轮 assistant
   message，保证回复和任务一一对应。
8. Agent 的最终 assistant message 写回 Agent Run 的 `output.summary`。
9. 任务服务把执行中状态和最终反馈写入任务消息时间线。

## Session 生命周期

- Session 首次执行时创建并绑定 Workspace；同一任务再次执行时 resume。
- 执行结束后保留 Agent handle 与 live Session，避免左侧家会话闪烁消失。
- 服务退出时统一释放 handle，持久化日志仍可在重启后 resume。
- 每次任务的 Run 记录同一个 Session ID，便于审计多个任务如何回流家会话。

## 失败边界

- 数字员工缺少项目授权或 Runtime Profile：任务记录系统失败消息，不创建 Run。
- Workspace 路径缺失：任务仍可执行，但不创建项目 Session。
- Session 绑定或标题失败：不阻断任务执行，最终结果仍写回任务。
- Agent 执行失败：Run 和任务消息都记录失败状态。

## 数据约束

- `AgentRun.workspacePath` 和 `AgentRun.sessionId` 为可选字段，兼容历史 Run。
- 家会话本体是顶层 Session，不设置 `parentSession`。
- 多个任务在同一家会话中串行执行，不额外创建 subagent。
