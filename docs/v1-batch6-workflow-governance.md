# V1 批次 6：工作流治理与可靠性增强

> 状态：已实现

## 1. 可靠性语义

- Worker 每轮先回收过期 Job 租约，再将对应 Run 标记为 `interrupted`、Task 置回
  `queued`，随后由工作流 sweep 收敛节点状态。
- 工作流 sweep 使用 `sweep_lease_owner` / `sweep_lease_expires_at` 做多 Worker
  互斥，重复执行只产生一次状态推进。
- 失败节点记录 `failureCount` 和 `nextRetryAt`。默认按 5 秒、10 秒、20 秒指数
  退避，单次上限 1 小时；Markdown 的 `retry-backoff` 可覆盖首轮间隔。
- `maxAttempts` 是最大执行次数。达到上限后 `nextRetryAt` 清空，实例进入
  `failed`。
- 暂停期间 sweep 不推进节点；恢复时按暂停时长平移节点 `timeoutAt`、
  `nextRetryAt` 和关联 Run 的 `timeout_at`。手动 owner 重试保留为即时恢复入口。

## 2. 审批治理

- 审批轮次由节点 `visits` 唯一标识，新轮次不会复用旧裁决。
- 转交会把原审批标记为 `transferred`，再为目标人类成员创建当前轮待审批记录。
- 加签只接受项目负责人或当前待审批人发起，目标必须是活跃人类成员。
- 角色审批在创建轮次时展开为成员快照；成员后续角色变化不会改写历史审批人。
- 审批更新使用条件更新保证单行幂等；并发最后一人审批发生 revision 冲突时，
  服务端会重新读取并完成该轮，而不是把已完成裁决返回为失败。
- 已转交记录不参与 `all` 策略完成判定。

## 3. 幂等与冲突

所有工作流写接口接受 `Idempotency-Key`。回执存储在
`workflow_idempotency_keys`，作用域为工作流定义或实例。请求哈希由操作名、
操作者和规范化 JSON 请求体计算：

- 同 key、同请求：返回首次 HTTP 状态和响应体。
- 同 key、不同请求：稳定返回 `409 idempotency_key_conflict`。
- 同 key 并发且首次请求未完成：返回
  `409 idempotency_request_in_progress`。

## 4. API

```text
POST /api/v1/workflow-instances/:id/approvals/transfer
POST /api/v1/workflow-instances/:id/approvals/cosign
GET  /api/v1/workflow-audit?projectId=&instanceId=&nodeId=&kind=&actorId=
     &query=&failuresOnly=&page=&pageSize=
```

审计分页默认 20 条、最大 100 条。`failuresOnly=true` 筛选阻塞、失败、超时和
Run 中断；`query` 同时搜索摘要、事件 JSON 和实例失败原因。

## 5. Migration 11

- 实例增加 sweep 租约和 `last_reconciled_at`。
- 审批增加 `kind`、转交来源/目标和 revision。
- Job 增加最近尝试时间及过期租约索引。
- 幂等回执增加请求哈希、状态和原响应。
- 新建 `workflow_idempotency_keys`。

升级 smoke 会创建真实 v10 临时数据库，写入旧实例和旧回执，再应用 v11 并验证
旧数据、回填字段和迁移版本。

## 6. 验证

```sh
pnpm check
pnpm test:smoke:workflow-governance
pnpm test:smoke:workflow-postgres
pnpm test:e2e:browser
```

模型相关路径只使用 Fake Runtime。正式 Profile、正式数据库和原 DSH 工作树不参与
批次 6 验证。
