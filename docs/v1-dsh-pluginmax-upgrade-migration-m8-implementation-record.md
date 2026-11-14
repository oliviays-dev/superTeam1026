# dsh-pluginmax 升级迁移 M8 实施记录

> 阶段：Workbench V2、Resource Market、静态面板注册表、entitlement
> 日期：2026-11-13
> 仓库：`pluginmax-platform`
> 实施基线：`main@5b7f7f5bc179ca0435c96126a950e7b3605847f4`
> Migration：43 -> 44

## 1. 实施前核对

```text
branch: main
HEAD:   5b7f7f5bc179ca0435c96126a950e7b3605847f4
M8 max before: 43
M8 migration:  44
```

开始前实际核对 `packages/database/src/migrate.ts`，Migration 43 为
M7 Data Fabric，44 未被占用。工作树包含用户原有改动、M0-M7 改动和大量
未跟踪文件。本轮未执行 `git reset --hard`、`git checkout --`、
`git clean`，未清理未跟踪文件，未修改外部 `dsh-pluginmax` 仓库、
迁移前只读备份或 M0-M7 历史 Migration。

M7 的 `data_fabric` 保持默认关闭；生产 Data Connector 独立安全评审门未改动。

## 2. 范围与边界

本轮实现：

- Workbench 实例、工作台版本、布局、布局版本、面板实例。
- 服务端布局 revision CAS、每 Principal 唯一默认布局、跨设备刷新。
- 仅随平台构建的受信任静态 React 面板注册表。
- 市场面板 entitlement；安装和 entitlement 不写入任何授权事实。
- Resource Market asset/version/digest/publisher/trust/visibility/
  entitlement、下架/归档。
- Market template、版本化 dependencies、安装/复制/卸载/回滚幂等。
- 撤权后面板返回 `forbidden` 且 `data=null`，不返回旧业务数据。
- 未知/禁用面板局部降级，不影响其他面板。
- `workbench.v2=off`、`market=off` 默认关闭。
- 空库、43 快照升级和旧应用读取新 Schema 验证。

未实施：

- 动态下载、解释或执行远程 JavaScript。
- Market entitlement 对 Project、Workspace、Data、Tool 或 Runtime 授权。
- 修改 `data_fabric`、QueryRun/QueryResult、Project Report 或 M7 事实源。
- 生产 Data Connector、外部仓库和迁移前备份变更。

## 3. Contract

新增 `packages/contracts/src/workbench-market.ts`：

- `WORKBENCH_V2_FLAG = "workbench.v2"`
- `MARKET_FLAG = "market"`
- `TRUSTED_WORKBENCH_PANELS`
- `Workbench`、`WorkbenchLayout`、`WorkbenchLayoutVersion`、
  `WorkbenchVersion`、`WorkbenchPanelResolution`
- `WorkbenchBootstrap`、`WorkbenchDetail`、`WorkbenchPanelData`
- `MarketAsset`、`MarketAssetVersion`、`MarketTemplate`
- `MarketEntitlement`、`MarketInstallation`、`MarketTemplateCopy`
- 严格 Market manifest：`panelPluginId`、Workbench template、
  dependencies、permissions、capabilities
- 所有 entitlement / installation 响应固定 `grantsAuthorization=false`

面板注册表只在代码中声明静态模块。Market manifest 使用 strict Zod schema，
拒绝 `remoteScript`、远程 URL、任意模块入口和未注册面板。Asset digest
由服务端基于 immutable payload 规范化 JSON 计算。

## 4. Migration 44

文件：

- `packages/database/src/schema.ts`
- `packages/database/src/migrate.ts`

新增表：

```text
market_assets
market_asset_versions
market_templates
market_template_dependencies
market_entitlements
market_installations
market_template_copies
workbenches
workbench_layouts
workbench_panels
workbench_panel_instances
workbench_layout_versions
workbench_versions
```

Migration 顺序：

1. Expand：创建市场与 Workbench 表、索引和默认关闭 Flag。
2. Backfill：写入 10 个受信任静态面板元数据；为每个 active human
   Principal 建一个幂等 factory Workbench、Default 布局、面板实例、
   Layout Version 1 和 Workbench Version 1。
3. Validate：校验每 Principal 默认布局唯一、布局 owner、布局/工作台
   版本头和 Market asset version head。
4. Enforce：创建默认布局唯一索引、owner guard、不可变版本、
   asset digest guard、entitlement/installation scope guard 和
   template dependency append-only trigger。
5. Enable：`workbench.v2=off`、`market=off`，Migration 不自动开启。

关键约束：

- `UNIQUE(owner_principal_id) WHERE is_default AND status='active'`
- `UNIQUE(layout_id, revision)`
- `UNIQUE(workbench_id, version)`
- `UNIQUE(asset_id, version)`、`UNIQUE(asset_id, digest)`
- `UNIQUE(principal_id, asset_id)` on entitlement / installation
- entitlement/installation 的 Principal、asset 与 version 由数据库 trigger
  再做交叉校验。
- Market asset version identity、digest、publisher、manifest、
  compatibility 不可改写；revoked 版本不可恢复。
- `workbench_layout_versions` 与 `workbench_versions` 不可 UPDATE/DELETE。

## 5. Database Repository

新增：

- `packages/database/src/workbench-configuration-repository.ts`
- `packages/database/src/market-repository.ts`

Workbench Repository：

- 首次访问或 Migration 回填后读取唯一默认布局。
- 创建 Workbench/Layout 时生成新的 panel instance ID，不复用其他布局 ID。
- 保存布局使用 `expectedRevision` + row lock + advisory lock。
- 每次保存同时写不可变 Layout Version 和 Workbench Version。
- 默认布局切换在事务内先清旧默认，再设置新默认。
- 读取时返回布局自身 revision 对应的 Layout Version，不混用其他布局快照。

Market Repository：

- Asset 创建、版本发布、状态变更、entitlement grant/revoke。
- 安装要求 active entitlement、active asset、published version、
  host compatibility。
- 安装账本按 Principal + asset 唯一；重复安装同版本返回 deduplicated。
- 回滚复用安装账本并恢复指定 published version。
- Template dependency 按 asset version 固化，不按最新版本回读。
- 复制模板写 `market_template_copies`；卸载只改变复制状态，不删除底层
  Workbench 或业务数据。

Repository 容器已在 `PlatformRepositories` 中注册：

```text
workbenchConfiguration
market
```

## 6. Application 与授权

新增 `packages/application/src/workbench-market.ts`：

- `WorkbenchConfigurationApplication`
- `MarketApplication`

Workbench：

- Flag 关闭时旧固定 Dashboard 保持不变。
- 保存/新建布局只允许 Workbench owner。
- 静态面板必须存在于受信任代码注册表。
- 需要 entitlement 的面板在布局保存和读取时重新检查 active entitlement。
- 每次 Panel Data 读取都重新求值 Project `read` 或 entitlement。
- 撤权后返回 `forbidden` / `needs_entitlement`，`data` 固定为 `null`。

Market：

- official / verified asset 只允许平台管理员创建。
- 平台管理员或 publisher 可发布版本、变更状态和授予 entitlement。
- 安装只要求 active human Principal，不写 `role_grants`、
  `project_members`、Runtime 或 Tool 授权。
- Template copy 要求 asset entitlement，并逐项检查 required dependency
  的 active installation。
- All entitlement/installation results carry `grantsAuthorization=false`.

授权事实仍只来自：

```text
Principal
RoleGrant
ProjectMember / ProjectRole
Runtime Profile
Execution Gate
```

## 7. API

Workbench：

```http
GET    /api/v1/workbenches
POST   /api/v1/workbenches
GET    /api/v1/workbenches/:workbenchId
PATCH  /api/v1/workbenches/:workbenchId
POST   /api/v1/workbenches/:workbenchId/layouts
PUT    /api/v1/workbenches/:workbenchId/layouts/:layoutId
POST   /api/v1/workbenches/:workbenchId/layouts/:layoutId/default
GET    /api/v1/workbenches/:workbenchId/versions
GET    /api/v1/workbenches/:workbenchId/layouts/:layoutId/versions
GET    /api/v1/workbenches/:workbenchId/panels/:panelInstanceId/data
```

Market：

```http
GET    /api/v1/market/assets
POST   /api/v1/market/assets
GET    /api/v1/market/assets/:assetId
POST   /api/v1/market/assets/:assetId/versions
POST   /api/v1/market/assets/:assetId/versions/:version/status
POST   /api/v1/market/assets/:assetId/status
GET    /api/v1/market/entitlements
POST   /api/v1/market/entitlements
DELETE /api/v1/market/entitlements/:entitlementId
GET    /api/v1/market/installations
POST   /api/v1/market/installations
POST   /api/v1/market/installations/rollback
DELETE /api/v1/market/installations/:assetId
GET    /api/v1/market/templates
GET    /api/v1/market/templates/:templateId
POST   /api/v1/market/templates/:templateId/copy
DELETE /api/v1/market/templates/:templateId/copy
```

安装、回滚和模板复制要求 `Idempotency-Key`，同时复用
`workflow_idempotency_keys` 与数据库业务唯一约束。

## 8. Web UI

新增：

- `apps/web/src/WorkbenchConfigurationPanel.tsx`
- `apps/web/src/api.ts` M8 Workbench/Market client
- `apps/web/src/OperationsViews.tsx` Flag 开启后的布局应用
- `apps/web/src/styles.css` 三视口布局与市场样式

UI 能力：

- 切换 Workbench。
- 修改布局名称、保存、设为默认、另存布局。
- 六档宽度、键盘上移/下移、revision/version 展示。
- 未知/禁用/缺 entitlement 面板显示局部降级状态。
- 市场资产浏览、install/uninstall。
- Workbench template 浏览与复制。

Flag 关闭时 `WorkbenchConfigurationPanel` 返回 `null`，保留原固定 Dashboard
和市场入口隐藏。

## 9. Feature Flags

Migration 44 默认：

```text
workbench.v2=off
market=off
```

关闭行为：

- Workbench V2 写接口返回 `workbench_v2_disabled`。
- Market 读写接口返回 `market_disabled`。
- UI 不显示布局管理或市场入口。
- 不删除已保存实例、布局、版本、asset、entitlement、installation 或审计。

## 10. 审计与追溯

继续使用 append-only `identity_audit_events`：

```text
workbench.created
workbench.updated
workbench.layout.created
workbench.layout.saved
workbench.layout.default_set
market.asset.created
market.asset.version.published
market.asset.status.changed
market.asset.version.status.changed
market.entitlement.granted
market.entitlement.revoked
market.asset.installed
market.asset.version.changed
market.asset.uninstalled
market.template.copied
market.template.uninstalled
```

布局追溯包含 workbench/layout ID、revision、version、digest 和 panel count。
Market 追溯包含 asset/version/digest、entitlement/installation ID、
trust/visibility 或 lifecycle 结果；始终记录 `grantsAuthorization=false`。

## 11. 测试结果

Contract 聚焦：

```text
CI=true pnpm exec vitest run packages/contracts/src/workbench-market.test.ts
Test Files 1 passed
Tests      4 passed
```

M8 Migration：

```text
./scripts/m8-migration-vitest.sh
fresh_migration=0->44
upgrade_migration=43->44
flags=market=off,workbench.v2=off
tables=13
triggers=7
factory_counts=1|1|1|1
old_app_read=M8 snapshot task|completed|local-admin|true
old_app_write=legacy app write
constraint_conflicts=0
```

M8 Workbench/Market PostgreSQL：

```text
./scripts/m8-workbench-market-vitest.sh
Test Files 1 passed
Tests      8 passed
```

覆盖：

- 布局 revision CAS 并发冲突。
- 每 Principal 默认布局唯一。
- 跨设备重新读取同一服务端布局。
- 未知和禁用面板局部降级。
- 动态面板注册与 manifest 远程代码拒绝。
- entitlement / installation 不创建 Project Grant。
- entitlement 撤销后不返回旧面板数据。
- Project read 撤销后面板返回 forbidden + null。
- asset version / digest UPDATE、DELETE 被数据库拒绝。
- install 与 template copy idempotency replay。
- required template dependency 未安装时拒绝复制。
- template copy 卸载与 asset version rollback。

全仓门禁：

```text
CI=true pnpm typecheck  pass
CI=true pnpm test       pass
CI=true pnpm lint       pass
CI=true pnpm build      pass
```

全仓 Vitest（无 `TEST_DATABASE_URL`）：

```text
Test Files  41 passed | 50 skipped (91)
Tests      208 passed | 227 skipped (435)
```

Teammates PostgreSQL 既有失败已实际复跑，仍存在：

```text
./scripts/teammate-vitest.sh
apps/api/src/teammates.test.ts:442
expected statistics.runCount=1, received 0
Test Files  1 failed | 13 passed (14)
Tests       1 failed | 46 passed (47)
```

M8 未修改该周报统计夹具或日期归属逻辑，也未声明该失败已修复。

## 12. 剩余风险

- 市场 UI 已补齐平台管理员上架、版本发布/弃用/撤销、delist/archive、
  entitlement grant/revoke；非管理员仍只看到浏览、安装和模板复制。
- Workbench 布局使用键盘上移/下移和宽度选择，未引入拖拽库。
- 静态面板注册信息同时存在代码注册表和数据库 seed；代码注册表是加载
  allowlist，数据库只提供 FK/禁用状态，不能单独注册可执行模块。
- Template copy 的 Workbench 创建与 copy receipt 分属两个事务；应用层在
  后续复制前扫描超过 60 秒且没有 receipt 的 Workbench，归档孤儿并写
  `market.template.copy.compensated` 审计。补偿扫描不自动恢复业务复制。
- Market entitlement 只控制市场资源和面板可见性；如果未来接入 MCP 或真实
  Connector，仍必须独立完成凭据、SSRF、allowlist 和外部 ACL 评审。
- `workbench.v2`、`market` 必须先关闭发布，再按目标环境显式开启并观察，
  不得由 Migration 自动切换。

## 13. 2026-11-14 收口复核

本轮仅做 M8 收口，不新增 Migration，不改写 Migration 37-44。

关闭项：

- Web 市场管理 UI：资产创建、版本发布、版本弃用/撤销、
  上架/下架/归档、跨 Principal entitlement grant/revoke。
- Workbench 卡片逐面板调用 `GET /api/v1/workbenches/:workbenchId/panels/:panelInstanceId/data`，
  独立刷新真实 module state；未知/禁用/缺 entitlement/forbidden 局部降级。
- Template copy 补偿扫描：过期 Workbench 孤儿归档 + append-only 审计。
- Feature Flag fencing 回归：关闭时 Workbench/Market 写路径 503，
  bootstrap 只返回安全关闭态；重开读取历史数据但不自动补做写操作。
- 修复 Market 资产列表 SQL 中未引用 `$1` 导致 `GET /market/assets` 500。
- 修复 Migration 44 的 pgcrypto 函数解析：受信任面板 digest 改为
  `public.digest(...)`，使隔离 schema 下 Core Regression 可以完成 0->44。

新增 Web E2E：

```text
./scripts/m8-workbench-market-e2e.sh
3 passed (1440 / 900 / 390)
```

覆盖布局宽度、上下移动、保存、默认布局、刷新恢复，未知/禁用/缺
entitlement 局部降级，市场浏览/安装/卸载/模板复制，管理员生命周期操作，
以及 revoke Project read 后单面板返回 forbidden 且不展示旧数据。

M8 PostgreSQL 集成收口后为 9/9 通过。Teammates 既有失败作为独立测试夹具
问题修复：历史固定周报日期改为按当前周动态生成，避免新 attribution 落在
目标周之外。该项不计入 M8 功能修复。

Core Regression 补充结果：

```text
technical: 91 files passed
           436 tests passed
browser bearer: 8 passed
browser local:  6 passed
```

Migration 44 修复后，Core Technical 中原先由
`function digest(unknown, unknown) does not exist` 引起的 8 个文件失败已消失。
Identity Grant 扩展语义、M1a 授权撤销夹具、Project AI PM Flag 隔离、
Delegation Binding Flag 与报告重试竞态、Teammates 周报日期夹具已修正。
Core Browser 合计 14/14，Core Technical 合计 436/436。

隔离发布演练：

```text
source migration:        0->43, 2.84s
backup/restore:          version=43, Task/Run preserved
restored migration:      43->44, 0.39s
restored version:        44
M8 tables:               13
flags:                   data_fabric=off,market=off,workbench.v2=off
factory workbenches:     1
post-upgrade read:       M8 rehearsal task|completed|local-admin|true
```
