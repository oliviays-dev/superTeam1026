# V1 Batch 9: Production Readiness

> 分支：`feat/v1-batch9-production-readiness`
>
> 基线：`2b69b806b55554d76b8d3ee3234542aa0520f9bf`
>
> 拆分：Batch 9A 备份与恢复、Batch 9B Run 追踪与安全负向验收。

Batch 9 不修改原 DSH、正式 Profile、正式数据库、正式 Session 或 Batch 8 发布存档。
新验证数据库使用独立 Compose 项目 `pluginmax-batch9`、端口 `54399` 和数据卷
`pluginmax-batch9-postgres-data`。

## 9A. Source and PostgreSQL Backup

### Artifact Contract

`scripts/backup.sh` 每个备份集包含：

```text
sets/<UTC timestamp>/
  source.tar.gz
  postgres.dump
  manifest.json
  SHA256SUMS
```

备份通过 staging 目录写完后再原子改名，避免留下看似成功的半份备份。同一时间只允许
一个备份进程运行；异常退出遗留的锁超过
`PLUGINMAX_BACKUP_LOCK_STALE_SECONDS` 后才能被下一次运行接管。

源码归档排除：

- `node_modules`、`.git`、`.tmp`、`lib`、`dist`、`coverage`。
- `.env`、`.env.*`、`.aws`、`.ssh`。
- `*.pem`、`*.key`、`*.p12`。

`manifest.json` 记录 Git SHA、脏文件数量、数据库 migration 版本、文件大小和
SHA-256，不记录数据库 URL、Token 或 API key。

### Modes and Configuration

```text
PLUGINMAX_BACKUP_ROOT
PLUGINMAX_BACKUP_RETENTION_DAYS
PLUGINMAX_BACKUP_RETENTION_COUNT
PLUGINMAX_BACKUP_DATABASE_MODE=auto|local|docker
PLUGINMAX_BACKUP_DATABASE_URL
PLUGINMAX_BACKUP_COMPOSE_PROJECT
PLUGINMAX_BACKUP_COMPOSE_FILE
PLUGINMAX_BACKUP_VERIFY=1|0
PLUGINMAX_BACKUP_ALERT_WEBHOOK
PLUGINMAX_BACKUP_METRICS_FILE
```

- `local` 使用 `pg_dump`/`psql`；连接串通过 `PGDATABASE` 环境变量传递，不写入日志。
- `docker` 通过独立 Compose 项目执行 `pg_dump`，默认 Batch 9 文件与容器。
- `auto` 在存在数据库 URL 且本机有 `pg_dump` 时选 `local`，否则选 `docker`。

先验证计划，不创建文件或数据库：

```bash
PLUGINMAX_BACKUP_DATABASE_MODE=docker \
  ./scripts/backup.sh --dry-run
```

完整备份默认执行临时数据库恢复验证：

```bash
PLUGINMAX_BACKUP_ROOT=/var/backups/pluginmax \
PLUGINMAX_BACKUP_METRICS_FILE=/var/lib/node_exporter/textfile/pluginmax-backup.prom \
PLUGINMAX_BACKUP_ALERT_WEBHOOK=https://alerts.example.invalid/pluginmax-backup \
  ./scripts/backup.sh
```

### Retention

保留同时受两个条件约束：

- 最近 `PLUGINMAX_BACKUP_RETENTION_COUNT` 份。
- 最近 `PLUGINMAX_BACKUP_RETENTION_DAYS` 天。

只扫描 `sets/20*` 目录并删除整份备份集；不会删除未由本脚本创建的任意文件。删除在
新备份完整落盘且恢复验证通过后执行。

### Periodic Schedule and Alerts

`ops/backup/pluginmax-backup.cron.example` 提供主机 cron 模板。每次运行都会：

- 失败时返回非零退出码并写入 `status.json`。
- 配置 Webhook 时发送不含凭据的固定 JSON 失败事件。
- 配置 `PLUGINMAX_BACKUP_METRICS_FILE` 时写入 node_exporter textfile 指标。

新增告警：

- `PluginmaxBackupFailed`：最近一次备份失败。
- `PluginmaxBackupStale`：36 小时没有成功备份。

### Restore Verification

验证脚本只创建名称前缀为 `pluginmax_restore_verify_` 的临时数据库，并在退出时强制删除：

```bash
./scripts/backup-restore-smoke.sh /path/to/sets/20261026T022557Z
```

验证内容：

- `SHA256SUMS`。
- manifest 格式和 migration 版本不低于 14。
- 源码包不包含 `.env`、`.git`、`node_modules`、`.aws` 或 `.ssh`。
- `pg_restore --exit-on-error` 可完整恢复到临时数据库。
- `platform_migrations`、`runs`、`run_events`、`jobs` 存在。
- `run_events` 有 3 个追踪列。
- Job、Runtime effect、maintenance run 各有 trace 关联列。

### Disaster Restore Runbook

1. 冻结写入：停止 API 和 Worker，保留当前 PostgreSQL 容器和 volume 快照。
2. 在独立目标数据库先做一次恢复验证，不直接覆盖正式数据库。
3. 校验 `SHA256SUMS` 和 `manifest.json`，确认 Git SHA、migration 版本及备份时间。
4. 对正式数据库执行恢复前快照，并记录操作人、时间窗和待恢复备份路径。
5. 仅在明确维护窗口和授权下恢复正式数据库；不得在此步骤复用 DSH Profile、Session
   或 `DSH_HOME`。
6. 恢复后运行：

```bash
pnpm db:migrate
```

7. 启动 API/Worker，检查 `/api/v1/ready`、`/api/v1/operations` 和关键 Run 历史。
8. 使用新的临时数据库再次验证下一次备份，确认备份链路没有被恢复操作破坏。

## 9B. Local Run Tracing

### Trace Model

Batch 9 使用 W3C `traceparent` 兼容的 128-bit trace id 和 64-bit span id，不依赖外部
collector。API 接受格式正确的入站 `traceparent`；格式错误、全零或伪造值不会被信任，
而会创建新的本地 trace，并返回 `x-pluginmax-trace-invalid: 1`。

响应头：

```text
traceparent
x-pluginmax-trace-id
```

持久化关联：

```text
runs.trace_id
run_events.trace_id / span_id / parent_span_id
jobs.trace_id
job_attempts.trace_id / span_id
runtime_effect_receipts.trace_id
runtime_maintenance_runs.trace_id / span_id
```

Run dispatch 在 API 请求 trace 下创建 Run；Job attempt、Runtime effect、Run Event 继承
同一 trace。维护调度在 claim 时创建独立 trace，执行有结果的维护任务时写入 maintenance
run。API、Worker 结构化日志同时输出 `traceId` 和 `traceparent`。

查询聚合：

```text
GET /api/v1/traces/:traceId
```

返回：

- `runs`
- `runEvents`
- `jobs`
- `jobAttempts`
- `runtimeEffects`
- `maintenanceRuns`

无外部 collector 时，本地 PostgreSQL 和 Run Event 仍是事实源。未来接入
OpenTelemetry Collector 时，可直接复用同一 `traceparent`，不需要重新生成关联 ID。

### Dispatch and Transfer Guards

新增强制规则：

- 归档项目不能创建任务、派发任务或转移任务。
- 停用 AI 不能派发或接收任务。
- 当前 Worker 未实现的外部 Runtime kind 在派发时返回
  `runtime_adapter_unavailable`，不会先创建 Run 再静默失败。
- 任务转移只允许活跃 AI 项目成员，且任务不能完成/取消，不能存在活跃或可恢复 Run。
- 任务转移写 `task_events(kind=transfer)` 审计记录。

API：

```text
POST /api/v1/tasks/:id/transfer
{
  "agentId": "<uuid>"
}
```

也可传 `roleId`，但 `agentId` 与 `roleId` 必须且只能有一个。
该接口仅允许本地管理员 Actor 调用。

## Negative Acceptance

### Automated

| 场景 | 自动化位置 | 断言 |
| --- | --- | --- |
| 伪造 trace header | `packages/contracts/src/trace.test.ts`、`apps/api/src/app.test.ts` | 不信任全零/畸形值，生成新 trace 并标记拒绝 |
| 归档项目派发 | `apps/api/src/app.test.ts` | `409 project_archived`，不创建 Run |
| 停用 AI 派发 | `apps/api/src/app.test.ts` | `409 agent_unavailable` |
| 未实现外部 Runtime | `apps/api/src/app.test.ts` | `409 runtime_adapter_unavailable` |
| 任务转移 | `apps/api/src/app.test.ts` | 仅活跃 AI 项目成员可接收；终态/归档拒绝 |
| API 响应缓存隔离 | `apps/api/src/app.test.ts` | `/api/v1/*` 返回 `cache-control: no-store` |
| Run/Job/effect/maintenance 关联 | `packages/database/src/runtime-trace.test.ts` | 六类记录可由同一 trace 聚合 |
| v13→v14 数据升级 | `scripts/production-readiness-postgres-smoke.sh` | 旧数据回填 trace，约束和 transfer 审计可用 |

### Executable Manual Acceptance

以下场景属于 DSH Principal GUI 或双账号边界，当前平台 V1 是本地单 Actor、无正式 Token
认证，不能用平台 API 冒充已经完成。

#### SEC-01 伪造或清空 Token

1. 使用独立且空的临时 `DSH_HOME` 启动被测 DSH，不使用正式 Profile/Session。
2. 登录有效测试账号，打开受保护页面。
3. 在浏览器开发者工具中删除 `Authorization`，或替换为随机等长字符串；不得记录真实
   Token。
4. 执行项目列表、任务详情、Agent 管理和设置读取请求。
5. 期望所有受保护请求返回 `401` 或 `403`，页面清空敏感数据并回到未登录状态。
6. 恢复有效测试会话，确认需要重新认证且不会复用伪造请求缓存。

结论标准：无敏感数据留在 DOM、React Query cache、localStorage 或网络响应缓存。

#### SEC-02 跨账号缓存隔离

1. 准备两个独立浏览器 Profile，分别登录账号 A、B，不共享 localStorage。
2. A 打开项目、任务、Run、Agent 和工作流详情。
3. B 登录后依次打开相同路径和相同对象 ID。
4. 期望 B 看不到 A 的项目或对象；越权 API 返回 `401/403`。
5. 回到 A，确认 A 的列表和筛选条件没有被 B 的查询键污染。
6. 检查刷新、前进后退和重新登录后不存在上一账号的瞬态数据。

平台 API 已通过 `cache-control: no-store` 防止共享 HTTP 缓存。完整账号级 React Query
隔离仍依赖未来正式认证 Provider，当前不作为 Batch 9 已完成项。

#### EXT-FAIL-01 外部 Runtime 进程失败

1. 在隔离 DSH 测试环境绑定命令不存在的 plain-text Runtime。
2. 派发任务并等待执行。
3. 期望 Run 失败并出现 ENOENT/命令不存在诊断，不进入 Review 或成功状态。
4. 绑定输出为空的 Runtime，期望出现“外部 Agent 未返回可用的文本输出”。
5. 停用 Runtime 后派发新任务，期望新 Run 被拒绝；历史 Run 保持原状态。

平台 Batch 9 自动覆盖“未实现 Runtime kind 在派发时拒绝”。真实外部进程的 ENOENT 和空
输出仍由隔离 DSH 环境专项验证，不修改原 DSH。

## Migration 14

Migration 14 增加：

- Run 和 Run Event 的 trace/span/parent 字段及索引。
- Job、Job attempt、Runtime effect、maintenance run 的 trace/span 字段及索引。
- v13 以前数据的确定性 trace 回填。
- `task_events.kind` 增加 `transfer`。

旧数据回填使用 `md5` 生成合法 32 位 trace id 和 16 位 span id，不依赖外部服务。

## Validation

```bash
pnpm check
TEST_DATABASE_URL=postgres://pluginmax:pluginmax@127.0.0.1:54399/pluginmax pnpm test
./scripts/production-readiness-postgres-smoke.sh
PLUGINMAX_BACKUP_DATABASE_MODE=docker ./scripts/backup.sh --dry-run
PLUGINMAX_BACKUP_DATABASE_MODE=docker ./scripts/backup.sh
./scripts/backup-restore-smoke.sh
```

API/Worker 定向 smoke 应验证 Run dispatch、trace 聚合、任务转移拒绝路径和 Worker
`job.claimed` 日志中的 trace 关联。本批不重复完整 Playwright，因为改动集中在数据库、
后台 API、Worker 和运维脚本，没有修改主页面交互；既有浏览器回归不提供备份恢复或
trace 关联覆盖。

## Remaining Risks

- 当前没有正式认证和远端对象存储；备份目录需要由部署方挂载到受控持久盘。
- 本地 PostgreSQL trace 没有自动过期策略，需要随 Run Event 保留策略一并规划。
- Webhook 只保证尽力投递；Prometheus 指标和 `status.json` 是第二观测面。
- 恢复验证证明备份可恢复，不证明 RPO/RTO；需要部署方根据调度频率定义目标。
- 真实 DSH 外部 Runtime 的 ENOENT、空输出、停用路径仍需在隔离 DSH 环境专项执行。
- 平台 API 仍必须只绑定 loopback；Batch 9 没有引入正式 Token 认证。
