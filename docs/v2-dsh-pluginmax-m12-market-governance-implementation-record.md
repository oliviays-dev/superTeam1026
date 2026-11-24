# dsh-pluginmax 增量升级 M12 Market 治理与资源绑定实施记录

> 阶段：M12 Market 治理与资源绑定
> 日期：2026-11-21
> 前置基线：M11 项目业务链路与项目概览，Migration 47
> Migration：48
> 目标方案：`docs/v2-dsh-pluginmax-upgrade-delta-architecture-and-migration-plan.md`

## 1. 完成范围

M12 已将 Market 的来源、共享范围、发布状态、运行可用性和用户安装状态拆分，
并补齐 Owner/Admin 治理、append-only 审计、安装兼容和资源引用绑定。

本批包含：

- Market Origin：`platform | user`。
- Sharing Scope：`private | project | workspace | platform`。
- Publication Status：`draft | published | delisted | archived`。
- Availability Status：`active | suspended`。
- Administrator Lock、停用原因和治理审计。
- `market_asset_resource_bindings`。
- 旧 `visibility/status/trust_level` 的双读和兼容投影。
- `market.governance_v2=off`、`market.shared_supply=off`。
- 下架、首次发布、重新上架、安全停用、恢复、归档、锁定与解锁。
- Owner/Admin 权限边界和并发 Revision CAS。
- 下架、卸载、停用、归档和 entitlement 的独立语义。
- 管理端与 Owner 可操作的必要 Web。

未实现：

- M13 MCP Provider 注册、连接、健康检查和 Tool 调用。
- Workflow Definition 独立版本历史。
- Planning Review UI 扩展。
- 与 M12 无关的前端重构。

## 2. Migration 48

文件：

- `packages/database/src/schema.ts`
- `packages/database/src/migrate.ts`

### 2.1 Expand

`market_assets` 新增：

```text
origin
sharing_scope
sharing_scope_id
publication_status
availability_status
admin_locked
admin_locked_at
admin_locked_by_principal_id
admin_lock_reason
published_at
delisted_at
archived_at
suspended_at
suspended_reason
publication_changed_at
availability_changed_at
```

新增表：

```text
market_governance_audit_events
market_asset_resource_bindings
```

### 2.2 Backfill

- `official | verified` 旧信任级回填为 `platform` Origin。
- 其他旧资产回填为 `user` Origin。
- `visibility=public` 回填为 `sharing_scope=platform`。
- 其他旧可见性直接映射为对应 Sharing Scope。
- `status=active | delisted | archived` 回填为对应 Publication Status。
- 所有旧资产 Availability 初始化为 `active`。
- 旧 `visibility/status/trust_level` 不删除，继续供 N-1 应用读取。
- 仅对能够证明目标存在的平台 Seed 回填资源绑定，不伪造 Skill、Workflow
  或 MCP Provider。

### 2.3 Compatibility

`market_assets_governance_projection`：

- 新应用只写新字段，由兼容投影生成旧字段。
- 旧应用写旧字段时，投影生成新字段。
- `draft | delisted | suspended` 投影为旧 `status=delisted`，避免旧应用把
  不可运行状态误判为可安装。
- `platform` Sharing 投影为旧 `visibility=public`。
- 旧应用尝试用 `status=active` 写入不能解除已经存在的安全停用。

### 2.4 Enforce

- Origin、Sharing、Publication、Availability 均受 CHECK 约束。
- `project/workspace` 共享必须有 Scope ID，`private/platform` 不得携带 Scope。
- Admin Lock 必须同时记录 Actor、时间与原因。
- 治理审计 UPDATE/DELETE 被 Trigger 拒绝。
- 资源绑定 UPDATE/DELETE 被 Trigger 拒绝。
- 资源绑定必须匹配 Market Asset Version。
- Skill Version、Workflow Template、Workbench Template、Trusted Panel 和
  MCP 目录资源绑定在数据库内验证目标存在。
- `mcp_provider` 只引用现有 MCP Catalogue 身份；Provider 连接、健康检查和
  Tool 调用仍由 M13 实现，M12 不伪造未知 Provider。

### 2.5 Enable

```text
market.governance_v2=off
market.shared_supply=off
```

Flag 关闭时：

- 旧 Market API 继续可用。
- 新治理动作返回 503。
- 新治理动作不写审计或业务状态。
- 用户共享供给保持关闭。

## 3. Contracts

文件：

- `packages/contracts/src/workbench-market.ts`

新增契约：

- `MarketOrigin`
- `MarketSharingScope`
- `MarketPublicationStatus`
- `MarketAvailabilityStatus`
- `MarketResourceKind`
- `MarketGovernanceActionInput`
- `MarketSuspendInput`
- `MarketAdminLockInput`
- `MarketResourceBindingInput`
- `MarketGovernanceAudit`
- `MarketAssetResourceBinding`
- `MarketInstallationImpact`
- `MarketGovernanceView`

`MarketAsset` 同时返回：

- 新治理字段。
- 旧 `trustLevel/visibility/visibilityScopeId/status`。
- `legacyVisibility/legacyStatus` 兼容结果。
- `newInstallAllowed/existingRunsAllowed`。

`MarketInstallation` 增加：

- `publicationStatus`
- `availabilityStatus`
- `runtimeAvailable`
- `blockedReason`

Entitlement 与 Installation 继续固定：

```text
grantsAuthorization=false
```

## 4. Repository 与 Application

文件：

- `packages/database/src/market-repository.ts`
- `packages/application/src/workbench-market.ts`
- `packages/application/src/authorization.ts`

关键规则：

- 治理动作先锁定 `market_assets` 行，再校验 `expectedRevision`。
- 同一 Revision 的并发治理只有一个成功，其余返回 409。
- Owner 只能治理自己的资源。
- 管理员只能治理非 Private 的共享资源。
- 管理员读取其他 Principal 的 Private 资源返回不可见，不泄露内容或审计。
- Admin Lock 阻止 Owner 自行重新上架或恢复，管理员可覆盖。
- 所有治理动作在同一事务内写：
  - 当前资产状态；
  - `market_governance_audit_events`；
  - 既有 `identity_audit_events`。
- Entitlement、安装、卸载和治理不写 ProjectMember、RoleGrant 或 Runtime
  授权。

安装与运行判定：

```text
newInstallAllowed =
  publicationStatus = published
  AND availabilityStatus = active

existingRunsAllowed =
  publicationStatus <> draft
  AND availabilityStatus = active
```

因此：

- `delisted` 禁止新安装，已有安装仍可运行。
- `suspended` 同时禁止新安装并阻断已有运行。
- `archived` 只表示发布历史归档，不自动等于安全停用。
- `uninstalled` 只修改 `market_installations.status`。

## 5. API

新增：

```http
GET  /api/v1/market/assets/:assetId/governance
POST /api/v1/market/assets/:assetId/governance/publish
POST /api/v1/market/assets/:assetId/governance/delist
POST /api/v1/market/assets/:assetId/governance/relist
POST /api/v1/market/assets/:assetId/governance/suspend
POST /api/v1/market/assets/:assetId/governance/resume
POST /api/v1/market/assets/:assetId/governance/archive
POST /api/v1/market/assets/:assetId/governance/lock
POST /api/v1/market/assets/:assetId/governance/unlock
GET  /api/v1/market/assets/:assetId/bindings
POST /api/v1/market/assets/:assetId/bindings
```

旧入口保留：

```http
POST /api/v1/market/assets
POST /api/v1/market/assets/:assetId/status
DELETE /api/v1/market/installations/:assetId
```

旧入口由服务端归一化为新字段写入；响应同时包含新旧字段。

## 6. Web

文件：

- `apps/web/src/WorkbenchConfigurationPanel.tsx`
- `apps/web/src/api.ts`
- `apps/web/src/styles.css`

Market 资源卡和管理面板新增：

- Origin、Sharing、Publication、Availability 展示。
- 旧状态兼容结果。
- 新安装与已有运行影响。
- 安全停用原因。
- Owner/Admin 治理原因输入。
- 发布、下架、重新上架、安全停用、恢复和归档。
- 平台管理员锁定与解锁。
- Admin Lock 时 Owner 的重上架/恢复按钮禁用。

保留现有静态面板、受信 Workbench 布局和响应式栅格。

## 7. 资源绑定

```text
market_asset_resource_bindings
  asset_id
  asset_version_id
  resource_kind
  resource_id
  resource_version_id
  created_by_principal_id
  created_at
```

支持：

```text
skill_version
mcp_provider
workflow_template_version
workbench_template_version
trusted_panel
```

绑定表不包含 instructions、manifest payload、正文或执行权限。
M12 自动回填：

- Panel Asset 当前版本引用 `workbench_panels`。
- Workbench Template 当前版本引用 `market_templates`。

其余资源必须由已有资源 ID 显式绑定。`mcp_provider` 可引用已发布、可用的
MCP Catalogue Asset/Version，但不建立连接、健康状态或 Tool 执行权限。

## 8. 验证结果

### 8.1 Migration 48 隔离

```text
./scripts/m12-market-governance-migration-vitest.sh

m12_migration_vitest=ok
fresh_migration=0->48
upgrade_migration=46->48,47->48
idempotent_migration=48->48
flags=market.governance_v2=off,market.shared_supply=off
tables=2
columns=16
triggers=4
backfill=platform|platform|published|active|public|active
binding_seed=1
old_app_read=private|active|private
old_app_write=user|private|published|active
```

### 8.2 M12 PostgreSQL 集成

```text
./scripts/m12-market-governance-vitest.sh

Test Files  1 passed
Tests       8 passed
```

覆盖：

- Feature Flag 关闭无新治理副作用。
- shared supply 关闭阻断用户共享。
- 旧 visibility/status/trustLevel 双读。
- Owner 不能操作他人资源。
- 管理员不能读取他人 Private 资源。
- 下架禁止新安装但已有安装兼容。
- 安全停用阻断已有运行。
- 卸载不改变发布状态。
- 归档不等于停用。
- Entitlement 不产生项目/工作区授权。
- Admin Lock 阻止 Owner 重新上架。
- 资源绑定不复制 Skill 正文。
- `mcp_provider` 可绑定已发布、可用的 MCP Catalogue 身份。
- 同 Revision 并发生成一个成功和一个 CAS 冲突。
- 治理审计 append-only。

### 8.3 回归

```text
./scripts/m8-workbench-market-vitest.sh
Test Files  1 passed
Tests       9 passed

./scripts/m11-project-business-chain-vitest.sh \
  apps/api/src/project-business-chain.test.ts \
  apps/api/src/planning-runtime.test.ts \
  apps/api/src/workflow-plan.test.ts
Test Files  3 passed
Tests       30 passed

./scripts/m8-workbench-market-e2e.sh
3 passed
```

浏览器在 `1440x1000`、`900x1000` 和 `390x844` 视口验证 Market 创建、版本、
entitlement、安装、方案复制、卸载、下架和归档流程。

### 8.4 全仓检查

```text
pnpm typecheck  pass
pnpm lint       pass
pnpm test       pass（208 passed / 262 skipped）
pnpm build      pass
```

## 9. 当前边界与风险

- MCP Provider 连接与 Tool 调用仍属于 M13；M12 只允许绑定现有 MCP Catalogue
  身份，不伪造未知 Provider。
- Workflow Template 当前没有独立 Version 表，绑定使用现有
  `workflow_templates.id/version` 事实。
- Workbench Template 绑定引用现有 `market_templates` 当前版本。
- 旧列至少保留一个发布周期；删除旧列前需要单独确认所有 N-1 应用退出。
- 旧应用写路径仍保留旧列协议；启用治理 Flag 后由服务端归一化并执行共享供给
  Provider 校验。
- 所有治理动作都有数据库行锁与 CAS；大批量运营时应观察锁等待和审计表增长。
