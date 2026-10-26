# V1 Batch 8: Persistent Maintenance and Runtime Effect Safety

批次 8 将审批 SLA、幂等回执清理、租约回收和 Runtime effect 回收统一纳入
PostgreSQL 持久化调度。Worker 的普通业务 sweep 不再触发审批 SLA 和回执清理。

## Persistent Maintenance

`runtime_maintenance_schedules` 为每类维护任务保存周期、下一次执行时间、租约、
最近执行结果和连续失败次数。任一 Worker 都可以通过
`FOR UPDATE SKIP LOCKED` 抢占到期任务；执行结束必须使用同一租约令牌提交结果。

- `approval_sla`：默认每 60 秒运行一次。
- `idempotency_cleanup`：默认每 3600 秒运行一次。
- `lease_recovery`：默认每 5 秒回收过期 Job 租约。
- `effect_recovery`：默认每 5 秒回收过期 Runtime effect。

失败调度按 `5s * 2^连续失败次数` 退避，并以正常周期为上限。维护运行记录包含
`trigger_source`、`scheduled_for` 和 `duration_ms`，用于计算调度延迟和执行时长。

## Runtime Effect Safety

每次 `agent.execute` 都使用稳定的 effect key：

```text
run:<runId>:agent.execute:v1
```

`runtime_effect_receipts` 记录 effect 状态、租约和最终结果。Worker 重试同一 Run
时先读取回执：

- `completed`：直接复用持久化输出，并补齐 Run、事件和交付物。
- `running` 且租约仍有效：拒绝并发 Worker 重复执行。
- `cancelled` 或存在取消意图：不再启动外部 Runtime。
- `failed` 或租约过期：允许下一次 Job attempt 重新领取。

DSH SDK session id 由 effect key 的 SHA-256 派生，保证跨 Worker 重试使用同一逻辑
执行身份。取消请求先写入 PostgreSQL；持有 effect 的进程轮询取消意图并关闭 Runtime。
如果进程已经退出，`effect_recovery` 会根据过期租约和取消意图完成状态收敛。

这不承诺外部系统本身具备 exactly-once 能力。它保证平台在可观测边界内不会因普通
重试重复启动已完成的 effect，并在崩溃后优先复用已持久化结果。

## Metrics and Alarms

`GET /api/v1/metrics` 输出 Prometheus 文本指标：

- Worker、队列、活跃 Job、死信和失败率。
- 队列等待 P50/P95、租约续租抖动 P95。
- 审批 SLA 燃尽率、最老超时审批年龄。
- 维护成功率、调度延迟 P95、执行时长 P95和下一次计划时间。
- Runtime effect 活跃数、过期租约数、取消数和回放数。

告警规则位于 `ops/alerts/pluginmax-runtime.yml`。规则覆盖 Worker 离线、迁移漂移、
队列等待、租约抖动、SLA 燃尽、维护失败、维护延迟、过期 effect 和回放突增。

## Configuration

```text
MAINTENANCE_POLL_INTERVAL_MS
MAINTENANCE_LEASE_SECONDS
APPROVAL_SLA_BATCH_SIZE
RUNTIME_EFFECT_POLL_INTERVAL_MS
```

调度周期存储在数据库中，修改周期应通过数据库变更，而不是只修改环境变量。

## Migration 13

Migration 13 增加：

- `runtime_maintenance_schedules` 及四类默认调度。
- `runtime_maintenance_runs` 的触发来源、计划时间和执行时长。
- `runtime_effect_receipts` 及 effect 状态、取消和回放计数。
- `job_attempts.lease_renew_interval_ms` 与 `lease_jitter_ms`。

兼容 smoke 从 v12 创建旧式维护记录、Run 和 Job，再升级到 v13，验证旧记录保留、
新表/列存在以及取消状态可持久化。

## Validation

```bash
pnpm check
TEST_DATABASE_URL=postgres://pluginmax:pluginmax@127.0.0.1:54389/pluginmax pnpm test
./scripts/maintenance-effects-postgres-smoke.sh
./scripts/runtime-postgres-smoke.sh
./scripts/runtime-reliability-smoke.sh
pnpm playwright test
```

Fake Runtime smoke 覆盖已持久化 effect 回放和跨进程取消。真实 DSH smoke 只在显式
提供环境变量时运行：

```bash
DEEPSEEK_API_KEY=... pnpm test:smoke:dsh-real
```

密钥不得写入 `.env`、仓库、日志或测试产物。没有运行真实 DSH smoke 时，不得将真实
模型验证标记为通过。

## Runbooks

### worker-unavailable

检查 Worker 进程、数据库连接和 `pluginmax_runtime_workers_active`。健康 Worker
应持续刷新心跳。

### migration-drift

对比 `pluginmax_runtime_migration_version` 与
`pluginmax_runtime_migration_expected_version`，然后运行 `pnpm db:migrate`。

### queue-wait

检查队列深度、Worker 并发和 Job 领取错误；必要时提高 Worker 数量或并发槽。

### lease-jitter

检查数据库延迟、事件循环阻塞和 Worker 主机负载。抖动持续升高会缩短有效恢复窗口。

### approval-sla

检查 `pluginmax_runtime_approval_oldest_overdue_seconds`、审批积压和 SLA 升级配置。

### maintenance-failure

查看 `/api/v1/operations` 的 `maintenanceSchedules`、连续失败次数和 `lastError`。

### runtime-effect-recovery

检查 stale effect、取消确认和对应 Run 的 `runtime.effect_replayed` /
`runtime.effect_cancelled` 事件。
