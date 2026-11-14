# dsh-pluginmax 升级迁移 M7 实施记录

> 阶段：只读 Data Fabric、Data Agent、QueryRun/QueryResult
> 日期：2026-11-13
> 仓库：`pluginmax-platform`
> 实施基线：`main@5b7f7f5bc179ca0435c96126a950e7b3605847f4`
> Migration：42 -> 43

## 1. 实施前核对

```text
branch: main
HEAD:   5b7f7f5bc179ca0435c96126a950e7b3605847f4
Migration max before M7: 42
Migration used by M7: 43
```

工作树包含 M0-M6、Shared Space、Human Avatar Delegation、Identity Hardening
等既有未提交修改和未跟踪文件。本轮未执行 `git reset --hard`、
`git checkout --`、`git clean`，未清理未跟踪文件，也未修改外部
`dsh-pluginmax` 仓库或迁移前只读备份。

## 2. Contract

新增 `packages/contracts/src/data-fabric.ts`：

- `DATA_FABRIC_FLAG = "data_fabric"`。
- `DataConnection`、`Dataset`、`DatasetColumn`。
- `SemanticMetric`、`SemanticMetricVersion`。
- `DataPolicy`、`DataPolicyVersion`、结构化 `DataRowFilter`。
- `ExecuteDataQueryInput`、`QueryRun`、`QueryResult`。
- `QueryPermissionSummary`。
- `DataAgentConversation`、`DataAgentMessage`、`DataAgentContextRef`。
- `DataAgentAnswer`、`DataAgentConversationDetail`。

写请求使用 strict schema，不接受：

- `userId` / `projectId` / `agentId` / `requesterPrincipalId`。
- 自由 SQL、`where`、任意 row filter。
- 多数据集 Join。
- 任意 MCP 或写入模式。

Conversation 创建只接受现有 `runId`。Project、Agent、Agent Principal、
Runtime Profile、ContextPack、Skill Snapshot 和 Run initiator 均由服务端
从 Run 反查。

## 3. Migration 43

文件：

- `packages/database/src/schema.ts`
- `packages/database/src/migrate.ts`

新增表：

```text
data_connections
datasets
dataset_columns
semantic_metrics
semantic_metric_versions
data_policies
data_policy_versions
dataset_rows
data_agent_conversations
query_runs
query_results
data_agent_messages
data_agent_context_refs
data_agent_answers
data_agent_answer_query_runs
data_agent_answer_context_refs
```

顺序：

1. Expand：新增数据域表、索引、默认关闭 Flag。
2. Backfill / Validate：该域无历史数据；校验 Metric/Policy 当前版本一致，
   completed QueryRun 必须带完整结果元数据。
3. Enforce：Metric Version、Policy Version、QueryResult、Message、
   Context Ref、Answer 和 Answer join 均为不可变事实；终态 QueryRun
   不可改写。
4. Enable：`data_fabric=off`，不随 Migration 自动开启。

关键约束：

- `UNIQUE(dataset_id, dataset_key)`。
- `UNIQUE(metric_id, version)`、`UNIQUE(metric_id, digest)`。
- `UNIQUE(policy_id, version)`、`UNIQUE(policy_id, digest)`。
- `query_runs.policy_snapshot` 至少包含一个 policy version。
- completed QueryRun 必须同时具备 `scan_count`、`row_count`、
  `result_digest`；失败、取消、超时不得写 `result_digest` 或 `row_count`。
- `query_results` 最多 1000 行，每行只包含策略过滤后的投影列。
- Data Agent Answer 的 Project Report 外键指向现有 `project_reports`。

## 4. 权限求交集

实现：`packages/application/src/data-fabric.ts`。

查询前重新求值：

```text
Project read
  ∩ Workspace read
  ∩ active Agent Principal
  ∩ active Agent
  ∩ Runtime Profile connection allowlist
  ∩ dataset/connection scope
  ∩ dataset policy scope
  ∩ row policies
  ∩ column policies
  ∩ maxRows
  ∩ timeoutMs
```

规则：

- Guest 只要存在 active `GUEST` role grant 就默认拒绝，即使同时拥有
  Project/Workspace 普通 read grant。
- 只有 Run initiator 或平台管理员可以从该 Run 创建 Conversation。
- Runtime Profile 只能收窄 connection 范围，不能扩大。
- 至少存在一个匹配 Project/Workspace 的 active data policy 才能发现和查询。
- 多个 row policy 使用 AND；column deny 取并集，allowed columns 取交集。
- request limit 只能进一步收紧 connection、dataset、policy 和硬上限。
- Project/Workspace/Grant/Agent/Runtime/Policy 变化在下一次查询重新校验。

## 5. API

新增：

```http
GET  /api/v1/data-fabric/connections
POST /api/v1/data-fabric/connections
GET  /api/v1/data-fabric/datasets
POST /api/v1/data-fabric/datasets
GET  /api/v1/data-fabric/datasets/:datasetId
POST /api/v1/data-fabric/datasets/:datasetId/columns
POST /api/v1/data-fabric/datasets/:datasetId/metrics
POST /api/v1/data-fabric/metrics/:metricId/versions
GET  /api/v1/data-fabric/datasets/:datasetId/policies
POST /api/v1/data-fabric/datasets/:datasetId/policies
POST /api/v1/data-fabric/datasets/:datasetId/policies/:policyId/versions
POST /api/v1/data-agent/conversations
GET  /api/v1/data-agent/conversations/:conversationId
POST /api/v1/data-agent/conversations/:conversationId/messages
POST /api/v1/data-agent/conversations/:conversationId/queries
POST /api/v1/data-agent/conversations/:conversationId/answers
POST /api/v1/data-agent/conversations/:conversationId/reports
GET  /api/v1/data-agent/query-runs/:queryRunId
GET  /api/v1/data-agent/query-runs/:queryRunId/result
POST /api/v1/data-agent/query-runs/:queryRunId/cancel
```

Catalog、Column、Metric、Policy 写操作只允许平台管理员。通用路由授权对
Data Fabric/Data Agent 前缀不提前放行，而是由 Application Service 按
上述交集逐次判定。

Query 模式固定为：

```text
explain | metric | dataset
```

不提供自由 SQL、生产写入、多数据集 Join 或任意 MCP 路由。

## 6. QueryRun / QueryResult 追溯

`query_runs` 固化：

- Conversation、Run、ContextPack、Skill Snapshot digest。
- requester Principal、Agent Principal、Runtime Profile。
- connection/dataset/metric version。
- mode、安全 query spec、policy version snapshot。
- row filters、allowed/denied columns。
- maxRows、timeout、data cutoff。
- permission summary。
- scan count、row count、result digest、terminal status。

失败、超时和取消路径：

- 先写 running QueryRun，再调用只读 Adapter。
- Adapter 超时由 `AbortController` 中止。
- 取消接口可在运行中原子更新为 `cancelled`。
- 失败/取消/超时都不写 QueryResult，也不伪造 rowCount。
- 若首个并发终态已写入，后到的完成路径不会覆盖。

历史 QueryRun 保存 policy/filter/limit snapshot。后续 Policy 升级只影响
新查询，不回写旧 QueryRun 或 QueryResult。

## 7. Data Agent Answer / Report

Answer 复用既有事实：

- Run `run_id`。
- Run `context_pack_id`。
- `run_skill_snapshots.snapshot_digest`。
- completed QueryRun/QueryResult。
- M6 `project_reports.id`。

`/reports` 要求必须引用现有 Project Report。M7 不新增 Project Report
第二事实表，也不创建 Task 或 Report 副本。Answer 只保存引用和
conversation answer digest。

## 8. Feature Flag

```text
data_fabric=off
```

关闭时：

- 拒绝新 Conversation message、Query、Answer/Report。
- 保留既有 Conversation、QueryRun、QueryResult、Context Ref 和 Answer。
- 不删除表、版本或历史事实。
- 不自动恢复查询。

Catalog 可继续由平台管理员维护，以便开启前完成配置和安全评审。

## 9. 审计

使用 append-only `identity_audit_events`：

```text
data.connection.created
data.dataset.created
data.column.created
data.metric.created
data.metric.version.created
data.policy.created
data.policy.version.created
data.agent.conversation.created
data.agent.message.created
data.agent.answer.created
query.executed
query.failed
query.cancelled
```

审计包含资源 ID、Project/Workspace、Runtime Profile、Agent Principal、
QueryRun、dataset/metric/policy version、row/scan count 和 digest；不记录
完整未脱敏数据集。

## 10. 测试结果

M7 Migration：

```text
./scripts/m7-migration-vitest.sh
fresh_migration=0->43
upgrade_migration=42->43
flag=data_fabric=off
tables=13
immutable_triggers=7
old_app_read=2026-11-12|1|M7 snapshot task|completed
old_app_write=legacy app write
constraint_conflicts=0
```

M7 Data Fabric / Data Agent PostgreSQL：

```text
./scripts/m7-data-fabric-vitest.sh
Test Files  1 passed (1)
Tests       12 passed (12)
```

覆盖：

- Flag 关闭拒绝新查询。
- 无 Project/Workspace 权限不可发现数据集。
- Guest 即使有普通 membership/Grant 仍拒绝。
- Runtime Profile connection scope 不匹配拒绝。
- 列策略拒绝，QueryRun failed 且无 QueryResult。
- 行过滤、maxRows、scan/row count、data cutoff 和 result digest。
- 固定语义 Metric，无自由 SQL。
- 超时不产生结果。
- 运行中取消不产生伪结果。
- Adapter 失败不产生伪结果。
- Policy v1 -> v2 后历史 QueryRun snapshot 不变。
- M6 Report、Run、ContextPack、Skill Snapshot 引用复用。

全仓门禁：

```text
CI=true pnpm typecheck  pass
CI=true pnpm test       pass
CI=true pnpm lint       pass
CI=true pnpm build      pass
```

全仓 Vitest（无 `TEST_DATABASE_URL`）：

```text
Test Files  40 passed | 49 skipped (89)
Tests       204 passed | 219 skipped (423)
```

Teammates PostgreSQL 既有失败已实际复跑，仍然存在且未由 M7 修复：

```text
./scripts/teammate-vitest.sh
apps/api/src/teammates.test.ts:442
expected statistics.runCount=1, received 0
Test Files  1 failed | 13 passed (14)
Tests       1 failed | 46 passed (47)
```

## 11. 剩余风险与安全门

- 当前 Connector 仅实现 `fixture` Adapter；生产 Connector、凭据、SSRF、
  服务端 ACL 和真实行/列过滤尚未进入 M7，需要独立安全评审。
- 尚未接入 Runtime Tool RPC；当前 Query 通过受认证 API 和 server-owned
  Conversation 调用 Application Service，未开放模型可自报身份的执行入口。
- 尚未新增 Data Fabric/Data Agent Web 页面。
- Query 执行为应用内同步 Adapter 调用；未增加独立 Worker 队列。
- 低基数 fixture 在应用内过滤；大结果集的生产扫描、超时和分页仍需由
  真实 Connector 在服务端执行。
- `data_fabric` 必须保持 off，直到独立安全评审、目标环境观察和回滚演练通过。
- Teammates 周报统计夹具失败仍需修复或由负责人正式豁免。
