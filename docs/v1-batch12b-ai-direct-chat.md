# V1 Batch 12B: AI Direct Chat

> 分支：`feat/v1-batch12b-ai-direct-chat`
>
> 基线：`499c48746f2fec146016a1bdcfe3ff17c98ae965`
>
> Migration：20

Batch 12B 在现有「沟通」工作区中增加当前账号与自有活跃 AI 伙伴的一对一私聊。
`(owner_id, agent_id)` 唯一确定一条稳定会话；停用 Agent 或运行时不可用时不再派发新
Run，已有消息与运行记录保持只读可查。

## 会话与消息

每个私聊线程保存 owner、Agent 和创建/更新时间。消息按线程内单调序号排序，并完整保存：

- 发送者类型、ID 和名称；
- 原始文本与客户端消息 ID；
- Turn / Run / Trace；
- `sent | failed | cancelled` 状态；
- 失败代码与失败信息。

发送接口要求 `clientMessageId`。同一线程内该 ID 唯一；重复或并发提交会复用同一条用户
消息、同一个 Turn、Run、Job 和 Outbox，不产生重复 Agent 回复。显式 `Idempotency-Key`
仍由现有 API 幂等中间件处理。

## 执行边界

`POST /api/v1/direct-chats/:threadId/messages` 只写业务数据、Run、Job 和
`domain_outbox` 主题 `direct.chat.reply`。Route 和 Application Service 均不调用模型，
Worker 才通过 Runtime Adapter 执行。

私聊 Run 的 `project_id`、`task_id` 和 `meeting_turn_id` 为空，只通过
`direct_chat_turn_id` 关联私聊。ContextPack 同样只包含：

- 当前 Agent 身份；
- 当前 owner-agent 私聊线程；
- 当前线程最近的消息；
- 当前 Turn 的输入。

它不会读取其他线程、其他 Agent、会议消息、项目 Memory 或未授权项目上下文。

Worker 启动前再次校验线程、Agent 状态和 Runtime Adapter。Agent 停用时当前 Turn 被
取消；运行中失败优先复用 Runtime effect 回执，最终失败由 Job 死信路径写回单条失败
消息。Worker 重试、租约过期恢复和 effect replay 都由唯一 Turn 回写保证幂等。

## API

```text
GET  /api/v1/direct-chats
POST /api/v1/direct-chats
GET  /api/v1/direct-chats/:threadId
POST /api/v1/direct-chats/:threadId/messages
POST /api/v1/direct-chats/:threadId/turns/:turnId/retry
POST /api/v1/direct-chats/:threadId/turns/:turnId/cancel
```

列表同时返回已有线程和为当前账号活跃 Agent 生成的待创建项；只有打开待创建项时才写入
线程。读取、发送、重试和取消都要求当前 actor 是线程 owner。通用 Run 读取、Context、
Artifact、SSE 与取消接口也会检查私聊 Run 的 owner。

## Database

Migration 20 新增：

- `direct_chat_threads`；
- `direct_chat_messages`；
- `direct_chat_turns`；
- `runs.direct_chat_turn_id`，并允许 `runs.project_id` 为空；
- `context_packs.direct_chat_turn_id`，并允许 `context_packs.project_id` 为空；
- 线程消息序号、客户端消息、Turn 回写和单活跃回复唯一索引。

既有 Task Run、Workflow Run、Meeting AI Run、ContextPack、Batch 9 trace、Batch 10A/10B
会议与 Memory、Batch 11A 日报、Batch 11B 模板、Batch 12A 会议 AI 契约保持不变。

## GUI

「沟通」页的单一会话列表提供「全部会话 / AI 对话 / 会议」切换、搜索、AI 私聊列表、
聊天流和输入区。私聊流展示 Agent 身份、发送者、时间、Run / Trace、运行状态、失败重试
和取消操作；停用 Agent 的历史会话仍可打开，输入区只读。

大屏继续使用会话列表与主工作区双栏，会议原有 AI 策略、概要和纪要面板保留。900px 以下
切换为单列，390px 视口已验证无横向溢出。

## Validation

```bash
pnpm check
pnpm test:integration:ai-direct-chat
pnpm test:smoke:ai-direct-chat-postgres
pnpm test:smoke:ai-direct-chat
git diff --check
```

定向测试覆盖跨账号越权、跨 Agent 与私聊/会议隔离、重复与并发发送、Worker replay、
租约与重试幂等、Run 取消、Agent 停用、不可用 Runtime、Runtime 失败消息、空消息、
旧会议/旧 Run 兼容和移动端无横向溢出。
