# dsh-pluginmax 增量升级 M11 项目业务链路与项目概览实施记录

> 阶段：M11 项目业务链路
> 日期：2026-11-21
> 前置基线：M10b Planning Runtime 执行面，Migration 46
> Migration：47
> 目标方案：`docs/v2-dsh-pluginmax-upgrade-delta-architecture-and-migration-plan.md`

## 1. 完成范围

M11 已完成项目业务链路的定义、模板策略、项目绑定、外部来源快照、稳定
Alert 和服务端项目概览 Read Model，未实现 M12 Market 治理，也未回头扩展
M10 Planning Review UI。

本批包含：

- Workflow Definition 的业务链路元数据与节点元数据。
- Project Template 业务链路策略与固定版本 Definition 引用。
- Project Business Chain Binding 当前事实与不可变 Revision 历史。
- 项目创建时按模板固定 Definition version。
- 可注入的 Project Source Adapter 端口、超时、取消、局部 stale 与失败记录。
- 不可变、版本化的 Project Source Snapshot。
- Project Alert 当前投影与 append-only Event。
- 每次请求从权威事实计算的 Project Progress Overview。
- `project.business_chain=off`、`project.source.mock=off` 默认关闭。
- 项目概览中的业务链路配置、来源新鲜度、Alert 和工作流/任务摘要。

## 2. Migration 47

文件：

- `packages/database/src/schema.ts`
- `packages/database/src/migrate.ts`

### 2.1 Expand

- `workflow_definitions`
  - `kind=workflow | business-chain`
  - `chain_key`
  - `business_chain_metadata`
  - `business_chain_nodes`
- `project_templates.business_chain_policy`
- `project_template_business_chain_refs`
- `project_business_chain_bindings`
- `project_business_chain_binding_revisions`
- `project_source_snapshots`
- `project_alerts`
- `project_alert_events`

### 2.2 Backfill 与兼容

- 旧 Workflow Definition 默认回填为 `kind=workflow`、`chain_key=NULL`、
  `business_chain_nodes=[]`。
- 旧 Project Template 默认回填为：

```json
{
  "mode": "none",
  "defaultBusinessChainKey": null,
  "allowedBusinessChainKeys": [],
  "versionPolicy": "latest-active"
}
```

- 不伪造历史 Binding、Alert 或 Snapshot。
- 不修改 Migration 45/46 的已验收业务语义。

### 2.3 Enforce

- Business Chain Definition 必须有稳定 `chainKey`，节点 `sequence` 与
  `stageCode` 唯一。
- Template 只能引用 active、published 的 platform Business Chain。
- Template 引用固化 `definition_snapshot`、version 和 chain key。
- Binding 的 Project、Template、Definition scope 与 version 必须一致。
- Binding 首次写入、升级和解绑必须递增 revision；历史不可修改或删除。
- Binding 当前行必须通过 Revision 解绑，不允许直接删除。
- Source Snapshot 数据库内分配单调 version，更新和删除均被拒绝。
- Source error Snapshot 不携带 payload，因此不会覆盖之前有效 Snapshot。
- Alert 使用 `UNIQUE(project_id, condition_key)`；Alert 只能解决，不能直接删除。
- Alert Event 的 seq 由数据库分配，UPDATE/DELETE 均被拒绝。
- `project.business_chain`、`project.source.mock` 默认 `off`。

### 2.4 定义版本固定

现有 `workflow_definitions.revision` 是当前行版本，没有独立 Definition
历史表。为避免后续编辑静默改变项目绑定，M11 在 Template 引用、Binding
Revision 和当前 Binding 中固化 `definition_snapshot`：

- id
- version
- name
- description
- business-chain metadata
- business-chain nodes

运行中的 Workflow Instance 继续使用其既有 `definition_snapshot`。M11 没有
新增第二套 Workflow Runtime，也没有把 Project Overview 保存为事实表。

## 3. Contracts

文件：

- `packages/contracts/src/project-business-chain.ts`
- `packages/contracts/src/collaboration.ts`
- `packages/contracts/src/project-templates.ts`

主要契约：

- `BusinessChainMetadata`
- `BusinessChainNodeMetadata`
- `BusinessChainDefinitionSnapshot`
- `ProjectTemplateBusinessChainPolicy`
- `ProjectTemplateBusinessChainRef`
- `ProjectBusinessChainBinding`
- `ProjectBusinessChainBindingRevision`
- `BusinessChainSourceRef`
- `ProjectSourceFetchResult`
- `ProjectSourceSnapshot`
- `ProjectAlert`
- `ProjectAlertEvent`
- `ProjectProgressOverview`

兼容字段：

- Workflow Definition 新增字段均带默认值，旧 API 响应可解释为普通工作流。
- Project Template 旧 Revision 快照没有业务链路字段时，回退为 `mode=none`。
- 所有绑定、Alert 和来源输入使用 strict schema 或服务端生成身份字段。

## 4. Repository

文件：

- `packages/database/src/project-business-chain-repository.ts`
- `packages/database/src/project-templates-repository.ts`
- `packages/database/src/repositories.ts`

关键规则：

- Binding 依赖项目 Row Lock 和当前 Binding Row Lock 执行 Revision CAS。
- 首次绑定使用 `expectedRevision=0`；升级要求现有 active Binding。
- Project 自有 Business Chain 只能绑定到同项目。
- Template Project 只能绑定 Template 允许的 fixed-version Definition。
- Definition 更新不会改变已有 Binding Snapshot。
- Source Snapshot 由 PostgreSQL advisory lock 分配每个
  `project + refKey` 的单调 version。
- Alert 由 advisory lock、唯一约束和当前行锁完成并发去重。
- Alert 生命周期更新全部使用 `expectedRevision` CAS。
- Template 创建项目时，仅在 `project.business_chain` 开启时自动写入所需
  Binding；Flag 关闭时不产生业务链路副作用。

## 5. Source Adapter

文件：

- `packages/application/src/project-business-chain.ts`

端口：

```ts
interface ProjectSourceAdapter {
  readonly kind: string;
  inspect(input: {
    projectId: string;
    refs: readonly BusinessChainSourceRef[];
    signal: AbortSignal;
    now: Date;
  }): Promise<readonly ProjectSourceFetchResult[]>;
}
```

规则：

- Adapter 只读，不向浏览器暴露凭证、MCP 对象或连接细节。
- Application 为每个 Adapter kind 设置 timeout 与 AbortSignal。
- 单个来源失败只产生局部 error Snapshot，其他来源仍可刷新。
- `stale` Snapshot 保留 payload 与 source revision，Read Model 明确标记过期。
- `error` Snapshot 不携带 payload，已有有效 Snapshot 继续作为最后已知值。
- Mock Adapter 的 `isMock=true`，并且 `project.source.mock=off` 时在任何写入前
  返回 `project_source_mock_disabled`。

## 6. Project Alert

稳定条件键：

```text
sha256(
  lower(sourceSystem) + NUL + sourceObjectId + NUL + upper(conditionCode)
)
```

数据库唯一范围：

```text
UNIQUE(project_id, condition_key)
```

生命周期：

```text
open -> acknowledged
open | acknowledged -> suppressed
open | acknowledged | suppressed -> resolved
resolved + new observation -> open
```

每次打开、观察、确认、抑制、指派、解决、重开和严重度变化都写独立 Event。
来源事实消失不会被自动当作 resolved；解决必须是显式写操作。

## 7. Project Overview

Read Model：

```text
schemaVersion = project-progress-overview-v1
generatedAt
projectStatus
enabled
businessChain
coverage
nodes
alerts
workflowSummary
taskSummary
blockedReasons
```

每次 API 请求重新读取：

- Project 当前状态。
- Project Business Chain Binding Snapshot。
- Project Source Snapshot。
- Project Alert。
- Workflow Definition / Instance / Plan / Approval 摘要。
- Task 状态摘要。

不存在 `project_overview_truth` 或等价持久化表。浏览器只渲染服务端结果。

明确 blocked reason：

- `feature-disabled`
- `project-archived`
- `business-chain-unbound`
- `template-policy-required`
- `source-refs-missing`
- `source-stale`
- `source-error`

## 8. Application 与 API

新增 API：

```http
GET   /api/v1/projects/:projectId/business-chain
PATCH /api/v1/projects/:projectId/business-chain/flags
POST  /api/v1/projects/:projectId/business-chain/bind
POST  /api/v1/projects/:projectId/business-chain/unbind
POST  /api/v1/projects/:projectId/business-chain/refresh
GET   /api/v1/projects/:projectId/overview
POST  /api/v1/workflows/:workflowId/business-chain
GET   /api/v1/project-alerts/:alertId
POST  /api/v1/project-alerts/:alertId/acknowledge
POST  /api/v1/project-alerts/:alertId/suppress
POST  /api/v1/project-alerts/:alertId/resolve
POST  /api/v1/project-alerts/:alertId/assign
```

权限：

- Settings、Overview、Alert Detail 要求项目读权限。
- Binding、Source Refresh、Alert 生命周期要求项目写权限且项目未归档。
- Workflow Business Chain 配置遵守 Project/Platform scope；平台定义要求管理员。
- Feature Flag 更新要求平台管理员。

## 9. Web

项目“概览”新增：

- 业务链路状态与 blocked reasons。
- 业务链路候选、绑定、升级和解绑。
- 将项目工作流配置为 Business Chain。
- 平台管理员项目级 Feature Flag 开关。
- 来源覆盖率、最后有效版本、fresh/stale/error 标识。
- 业务阶段字段与来源新鲜度。
- Alert 确认、抑制和解决。
- Workflow/Plan/Approval 与 Task 摘要。

Project Template 管理新增：

- `none | optional | required` 业务链路策略。
- 已发布平台 Business Chain 的固定 revision 引用。
- 默认业务链路选择。

## 10. 验证结果

### 10.1 Migration 隔离

```text
./scripts/m11-migration-vitest.sh

m11_migration_vitest=ok
fresh_migration=0->47
upgrade_migration=45->47,46->47
idempotent_migration=47->47
flags=project.business_chain=off,project.source.mock=off
tables=6
columns=4
triggers=12
legacy_read=workflow:true:0,workflow:true:0
old_app_write=Old app workflow write|workflow
legacy_rows=0|0
```

### 10.2 M11 PostgreSQL 集成

```text
./scripts/m11-project-business-chain-vitest.sh

Test Files  1 passed
Tests       7 passed
```

覆盖：

- Binding Revision CAS 与跨项目 Definition scope。
- Template-pinned definition 自动绑定与后续升级隔离。
- Source Snapshot 不可变、最后有效值保留、局部 stale/error。
- Alert 16 路并发去重、确认、抑制、解决和 append-only event。
- Overview 每次读取重新计算 Task/Source 事实。
- 无 Binding 与 archived Project 的 blocked reason。
- Mock Source Flag 关闭时不可刷新且不产生 Snapshot。

### 10.3 Migration 47 回归

```text
./scripts/m11-project-business-chain-vitest.sh \
  apps/api/src/project-templates.test.ts \
  apps/api/src/planning-runtime.test.ts \
  apps/api/src/workflow-plan.test.ts

Test Files  3 passed
Tests       32 passed
```

### 10.4 全仓检查

```text
pnpm typecheck  pass
pnpm lint       pass
pnpm test       pass（无数据库模式下 208 passed / 254 skipped）
pnpm build      pass
```

构建保留既有 Web bundle 体积和 sourcemap 警告，没有新增构建失败。

### 10.5 浏览器验证

```text
./scripts/m11-project-business-chain-e2e.sh

1 passed
```

覆盖真实 API 配置、绑定、Mock Source 刷新与 Overview 渲染，并在
`1440x1000` 与 `390x844` 视口验证：

- 业务链路名称、chain key 与固定 revision 可见。
- 来源状态明确显示“最新”。
- 业务阶段值可见。
- 项目概览中的任务事实同步更新。
- 移动视口没有页面级横向溢出。

截图：

- `.tmp/m11-project-overview-desktop.png`
- `.tmp/m11-project-overview-mobile.png`

## 11. 当前边界

未包含：

- M12 Market 治理与资源绑定。
- 生产 MCP Provider 与凭证托管。
- 外部数据源冲突合并策略。
- Overview 性能缓存；当前按要求每次请求实时聚合。
- Planning Review UI。

剩余风险：

- Definition Snapshot 解决了固定版本读取，但 Workflow Definition 本身仍没有
  独立、可遍历的版本历史表；完整历史审计可在后续独立迁移补充。
- 真实 Source Adapter 的延迟、限流和错误分类需按具体 Provider 校准。
- 项目模板策略只引用已发布平台 Business Chain；需要先在该工作流所属项目开启
  Flag、配置并发布定义。
- 当前项目概览为实时多查询聚合；数据量增长后若增加缓存，必须保存
  `sourceCutoff`、`policyVersion` 与 digest，并保持可撤销。
