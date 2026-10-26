# V1 Batch 7: Runtime Reliability 2.0

批次 7 将本地单循环 Worker 升级为可停止、可恢复、可观测的运行面。实现仍以 PostgreSQL
作为唯一协调源，不依赖进程内锁或正式 Profile。

## Job 生命周期

- 并发 Worker 使用 `FOR UPDATE SKIP LOCKED` 领取 Job，同一 Job 只有一个有效租约。
- 每次领取产生独立 `job_attempts` 记录和租约令牌；完成、失败和续租都校验令牌。
- 长任务按 `WORKER_LEASE_RENEW_INTERVAL_MS` 续租，并持续校验租约。
- Worker 异常退出后，过期租约由其他进程回收。未耗尽尝试的 Run 标记
  `interrupted`，下一次领取恢复为 `queued/running` 并记录 `run.recovered`。
- 失败使用指数退避。达到 `max_attempts` 后进入 `dead_letter`，人工恢复保留尝试
  历史并扩展尝试上限。
- SIGINT/SIGTERM 停止领取新 Job；在宽限期内等待在途 Job。超时后通过 AbortSignal
  中断，并将未完成 Job 安全释放。

状态：

```text
queued -> running -> completed
                  -> queued (retry)
                  -> dead_letter
running -> queued (lease expired or safe shutdown)
        -> dead_letter (attempts exhausted)
dead_letter -> queued (manual recovery)
```

## 审批 SLA

审批节点支持以下 Markdown 元数据：

```markdown
- approval-due: 30m
- approval-remind: 10m
- approval-escalate-after: 40m
- approval-escalation-role: 00000000-0000-4000-8000-000000000101
- approval-expire-after: 2h
- approval-expire-action: block
```

- `approval-due` 写入审批行的 `due_at`。
- `approval-remind` 到期后只提醒一次。
- `approval-escalate-after` 到期后为指定项目角色中的活跃人工成员创建升级审批。
- `approval-expire-after` 到期后把待处理审批标记为 `expired`。
- `approval-expire-action` 支持 `reject`（按拒绝分支继续）和 `block`（阻塞流程）。
- 提醒、升级和过期都通过行锁与唯一约束实现并发幂等。

未显式配置 SLA 的新审批默认 1 小时到期、30 分钟提醒、2 小时过期。v11 中已有的
待处理审批在 Migration 12 中按创建时间补齐相同默认值。

## 保留策略

- 完成或失败的幂等回执超过保留期后，先写入
  `workflow_idempotency_archive`，再从在线表删除。
- Worker 按 `IDEMPOTENCY_CLEANUP_INTERVAL_MS` 周期执行清理。
- 管理员 API 可手动触发清理并读取归档数量与占用字节。

## 健康与运维 API

```text
GET  /api/v1/health
GET  /api/v1/ready
GET  /api/v1/operations
GET  /api/v1/jobs?status=dead_letter
POST /api/v1/jobs/:jobId/recover
POST /api/v1/operations/approval-sla/sweep
POST /api/v1/operations/idempotency/cleanup
```

- `/health` 只表示 API 进程存活，不访问数据库。
- `/ready` 分别检查数据库、最近心跳的 Worker 和 `platform_migrations` 版本。
- `/operations` 返回 Worker 心跳、并发、队列深度、Job 失败率、Run 超时率、审批
  积压、SLA 超时、死信、幂等归档和维护记录。
- 运维写操作要求 `x-pluginmax-actor` 等于 `LOCAL_ACTOR_ID`。

## Worker 配置

```text
WORKER_CONCURRENCY
WORKER_POLL_INTERVAL_MS
WORKER_LEASE_SECONDS
WORKER_LEASE_RENEW_INTERVAL_MS
WORKER_SHUTDOWN_GRACE_MS
WORKER_RETRY_BASE_DELAY_MS
WORKER_RETRY_MAX_DELAY_MS
WORKER_HEARTBEAT_INTERVAL_MS
WORKER_HEARTBEAT_STALE_AFTER_SECONDS
IDEMPOTENCY_RETENTION_SECONDS
IDEMPOTENCY_CLEANUP_BATCH_SIZE
IDEMPOTENCY_CLEANUP_INTERVAL_MS
```

## Migration 12

Migration 12 增加：

- Job 租约令牌、尝试上限、心跳、死信和人工恢复计数字段。
- `job_attempts`、`runtime_workers`、`runtime_maintenance_runs`。
- 审批 SLA 字段、`expired` 状态和 `escalation` 类型。
- `workflow_idempotency_archive`。

迁移兼容验证会先建 v11 数据库和旧数据，再升级到 v12，并检查 Job、审批 SLA、
死信约束和升级审批类型。

## 验证

```bash
pnpm check
TEST_DATABASE_URL=postgres://pluginmax:pluginmax@127.0.0.1:54379/pluginmax pnpm test
./scripts/runtime-postgres-smoke.sh
./scripts/e2e-smoke.sh
./scripts/runtime-reliability-smoke.sh
pnpm playwright test e2e/runtime-reliability.spec.ts
```

真实进程 smoke 会启动多个 Worker，使用 SIGKILL 制造过期租约，验证恢复、死信、
人工恢复、SIGTERM 等待、超时中断和 SIGINT 停机；全程仅使用 Fake Runtime。
