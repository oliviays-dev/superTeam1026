# V1 Batch 12A: Meeting AI Participation

> 分支：`feat/v1-batch12a-meeting-ai-participation`
>
> 基线：`adc45179fb86237b77e94a4a1f7b3881607721f5`
>
> Migration：19

Batch 12A 让活跃项目成员 AI 伙伴以独立 Agent 身份参加平台会议。自动发言只能由
显式、确定性的会议事件触发，不通过 Agent 回复继续触发下一轮，因此不会形成无限自动对话。

## 参与者与策略

每个会议都有独立 AI 策略，默认暂停。创建会议时，`agentIds` 必须同时满足：

- Agent 自身启用；
- Agent 是当前项目活跃成员；
- Agent 只可加入当前会议，不能被其它会议的消息或轮次触发。

会议参与者状态独立保存，迁移会把既有会议 `participants` 中的 Agent 回填为参与者。
旧会议没有策略时仍可发送普通消息和发布纪要，但不会自动调用 Agent。

```text
GET  /api/v1/meetings/:meetingId/ai-policy
PUT  /api/v1/meetings/:meetingId/ai-policy
POST /api/v1/meetings/:meetingId/ai-policy/pause
POST /api/v1/meetings/:meetingId/ai-policy/resume
POST /api/v1/meetings/:meetingId/ai-policy/terminate
POST /api/v1/meetings/:meetingId/ai-triggers
```

策略字段包括：

- `status`：`active | paused | terminated`；
- `triggerKinds`：`mention | round | agenda | summary`；
- `cooldownSeconds`；
- `maxRounds`；
- `maxMessages`；
- `runBudgetMs`：每次 Agent Run 的超时预算；
- `revision`：策略乐观锁版本；
- `stats`：已用轮次、成功/失败消息、剩余轮次与剩余消息；
- `lastErrorCode` / `lastErrorMessage` / `lastErrorAt`。

`terminated` 不可恢复；`paused` 可以恢复。暂停、终止、关闭会议或归档项目会取消该会议
仍处于 `queued/running` 的 Agent Run。Worker 在启动 Runtime 前再次校验 Agent、项目成员、
项目、会议和策略状态。

## 确定性触发

普通会议消息携带 `mentions`，或正文包含 `@AI 伙伴名称` 时，只触发被点名的会议参与者。
同一消息只生成一个 mention 轮次。

```json
{
  "kind": "round",
  "agentIds": [],
  "roundNumber": 2,
  "agendaItem": "风险复核",
  "reason": "会议主持人发起固定轮次",
  "sourceMessageId": "optional-message-id"
}
```

触发语义：

- `mention`：消息级唯一轮次；
- `round`：固定 `roundNumber` 唯一轮次；
- `agenda`：同一议程节点只投递一次；
- `summary`：同一来源消息只生成一次总结请求。

`agentIds` 为空表示当前会议全部活跃 AI 参与者。冷却、最大轮次和最大消息数在同一会议
事务中通过 advisory lock 计算，重复与并发请求返回已存在的轮次；相同
`Idempotency-Key` 由现有幂等中间件重放。

## 执行与写回

API 不调用模型。每个允许的触发在同一事务中写入：

1. `meeting_ai_rounds` 与 `meeting_ai_turns`；
2. 关联 `meeting_turn_id` 的 Run；
3. 现有 `jobs` 记录；
4. `domain_outbox` 主题 `meeting.ai.speak`；
5. `run.queued` 事件与 root trace。

Worker 通过现有 Job lease 和 Runtime Adapter 执行。Meeting Run 的 `task_id` 为空，
ContextPack 保存 `meeting_turn_id`、策略触发原因和最近会议消息。成功时在事务内写回一条
Agent 会议消息；最终失败时写回一条 `failed` Agent 消息。两种消息都保存：

- Agent ID / 名称；
- policy ID / revision；
- trigger kind / reason；
- run ID / trace ID；
- turn ID / status / error code / error message。

`meeting_messages.turn_id` 唯一。Runtime effect replay、Job 重试、Worker 租约过期恢复
只会复用同一条 turn 与消息，不产生重复发言。

## Database

Migration 19 新增：

- `meeting_ai_policies`；
- `meeting_ai_participants`；
- `meeting_ai_rounds`；
- `meeting_ai_turns`；
- `meeting_messages` 的自动发言审计字段；
- `runs.meeting_turn_id` 与可空 `runs.task_id`；
- `context_packs.meeting_turn_id` 与可空 `context_packs.task_id`。

旧 Task Run、Workflow Run、ContextPack、Batch 9 trace、Batch 10A/10B 会议、Memory、
Handoff、Episode、Batch 11A 日报与 Batch 11B 模板契约保持兼容。

## Validation

```bash
pnpm check
pnpm test:integration:meeting-ai
pnpm test:smoke:meeting-ai-postgres
pnpm test:smoke:meeting-ai
pnpm exec playwright test e2e/meeting-ai-participation.spec.ts
git diff --check
```

定向覆盖越权控制、非项目成员 Agent、跨会议来源隔离、四种触发、冷却、最大轮次/消息、
并发与重复触发、Runtime 失败恢复、Worker 重试/租约幂等、暂停/关闭/归档、空消息、
旧会议兼容和 Mobile 无横向溢出。
