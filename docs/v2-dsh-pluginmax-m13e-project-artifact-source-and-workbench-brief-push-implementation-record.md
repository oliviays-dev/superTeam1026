# dsh-pluginmax 增量升级 M13e Project Artifact Source + Workbench Brief Push 实施记录

> 阶段：M13e Project Artifact Source + Workbench Brief Push
> 日期：2026-11-21
> 前置基线：M13d Production Secret Resolver + Read-only MCP ProjectSourceAdapter，Migration 52
> Migration：53
> 目标方案：`docs/v2-dsh-pluginmax-upgrade-delta-architecture-and-migration-plan.md`

## 1. 完成范围

M13e 收口了 M13 剩余的两个体验能力：

1. Run Artifact 在创建时保存当前 Project Source 引用。
2. Workbench Brief 增加服务端 SSE 增量推送，浏览器收到新版本后刷新 Dashboard。

本批包含：

- Artifact `sourceRefs` 契约。
- `project-source` Workbench Source Kind。
- Migration 53 `artifacts.source_refs`。
- RunExecutor 在 Artifact 落库时固化当前 Project Source Snapshot 引用。
- 旧 Artifact 默认空来源并保持可读。
- `/api/v1/workbench/brief/stream` SSE。
- 浏览器自动重连、服务端 2 秒版本检查、15 秒 Keepalive。
- 现有 15 秒 Dashboard 轮询保留为 SSE 断线兜底。
- Run 页显示 Artifact 来源数量。

本批不包含：

- 对 Artifact 来源的人工编辑。
- Artifact 创建后的来源持续追踪。来源引用是创建时快照。
- 跨进程 Event Bus、LISTEN/NOTIFY 或 Outbox 驱动的 Brief 推送。
- Project Artifact 全文版本治理。

## 2. Migration 53

文件：

- `packages/database/src/m13e-artifact-source.ts`
- `packages/database/src/migrate.ts`

变更：

```sql
ALTER TABLE artifacts
  ADD COLUMN IF NOT EXISTS source_refs JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE artifacts
  ADD CONSTRAINT artifacts_source_refs_array_check
  CHECK (jsonb_typeof(source_refs) = 'array');

CREATE INDEX artifacts_source_refs_idx
  ON artifacts USING GIN (source_refs);
```

兼容：

- 旧应用 INSERT 省略 `source_refs` 时使用默认空数组。
- 旧 Artifact 读取结果为 `sourceRefs=[]`。
- 不修改 Artifact 原字段、下载路径或授权规则。

## 3. Artifact Source 契约

文件：

- `packages/contracts/src/collaboration.ts`
- `packages/contracts/src/workbench-reports.ts`

`Artifact` 新增：

```ts
sourceRefs: WorkbenchSourceRef[];
```

新来源类型：

```text
kind = project-source
route = project
id = snapshot.refKey
targetId = projectId
cutoffAt = snapshot.observedAt
available = snapshot.status !== "error"
```

来源引用最多 50 个。

## 4. Run Artifact 关联

文件：

- `packages/application/src/run-executor.ts`
- `packages/database/src/collaboration-repositories.ts`

Run 完成并生成 Markdown Artifact 时：

1. 查询 Project 的 Source Snapshot。
2. 按 `refKey` 取最新版本。
3. 生成稳定的 `project-source` Workbench Source Ref。
4. 与 Artifact 同一 INSERT 落库。

规则：

- Artifact 不保存 Credential、Endpoint 或原始 Tool Response。
- 引用只包含来源身份、可用性和观测截止时间。
- 来源后续变化不会重写历史 Artifact 来源。
- 错误 Snapshot 对应来源仍保留身份，但 `available=false`。

## 5. Workbench Brief SSE

文件：

- `apps/api/src/app.ts`
- `apps/web/src/api.ts`
- `apps/web/src/OperationsViews.tsx`

服务端：

```text
GET /api/v1/workbench/brief/stream
```

行为：

- 使用现有 Actor/Session 授权。
- 每 2 秒读取当前 Actor 最新 Brief。
- Brief ID 或 Version 变化时发送：

```text
event: workbench.brief
data: <WorkbenchBrief JSON>
```

- 每 15 秒发送 SSE Keepalive。
- 客户端断开后停止数据库读取。
- 读取失败发送 `workbench.error` 后关闭连接。

浏览器：

- 收到新 Brief 后失效 `workbench-dashboard` Query。
- 断线 2 秒后自动重连。
- 原有 15 秒轮询继续作为兜底。
- 未读状态仍通过现有 Read API 维护。

## 6. Web

Run 页 Artifact 列表：

- 保留下载入口。
- 有来源时显示来源数量徽标。
- Tooltip 显示来源数量。
- 不展示来源凭据、Endpoint 或 Tool Key。

## 7. 验证

### 7.1 Migration 53 隔离

```text
./scripts/m13e-artifact-source-migration-vitest.sh

m13e_migration_vitest=ok
fresh_migration=0->53
idempotent_migration=53->53
upgrade_migration=52->53
column=jsonb:NO:'[]'::jsonb
source_refs_index=1
```

### 7.2 M13d/M13e PostgreSQL 集成

```text
./scripts/m13d-project-source-vitest.sh

Test Files  7 passed
Tests       39 passed
```

新增覆盖：

- Artifact 契约默认空来源。
- `project-source` 来源解析。
- RunExecutor 创建 Artifact 时保存最新 Project Source 引用。
- 既有 Secret Resolver、MCP Source、M13b/M13c 和 M11 回归。

### 7.3 Workbench Browser E2E

```text
CI=true ./scripts/workbench-reports-e2e.sh

1 passed
```

覆盖：

- 页面打开后新建 Supply Exception 并刷新 Brief。
- 新 Brief 在 8 秒内通过 SSE 到达并更新页面。
- 原有项目日报、风险、Follow、Settings、桌面和移动端布局回归。

### 7.4 全仓检查

```text
pnpm typecheck  pass
pnpm lint       pass
pnpm test       pass（227 passed / 295 skipped）
pnpm build      pass
```

### 7.5 历史批次最终回归

```text
M13c Integration  pass（4 files / 20 tests）
M13b Integration  pass（4 files / 15 tests）
M13a Integration  pass（1 file / 7 tests）
M12 Integration   pass（1 file / 8 tests）
M11 Integration   pass（1 file / 8 tests）

M13c Migration 51 pass
M13d Migration 52 pass
M13e Migration 53 pass

M13d Source E2E   pass（1 test）
Workbench E2E     pass（1 test）
```

## 8. 剩余风险

- SSE 当前按连接轮询数据库。多实例大规模使用时应改为 PostgreSQL
  `LISTEN/NOTIFY`、Outbox 或专用事件总线。
- SSE 依赖反向代理允许长连接并正确关闭 Buffering。
- Artifact 来源是创建时快照，不提供自动连续追踪。
- Artifact 来源引用不可人工修订；如需纠正应生成新 Artifact。
- GIN 索引支持后续按来源反查，但当前没有新增反查 API。
