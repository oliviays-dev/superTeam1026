# dsh-pluginmax 增量升级 M13a MCP Provider 控制面实施记录

> 阶段：M13a MCP Provider 控制面
> 日期：2026-11-21
> 前置基线：M12 Market 治理与资源绑定，Migration 48
> Migration：49
> 目标方案：`docs/v2-dsh-pluginmax-upgrade-delta-architecture-and-migration-plan.md`

## 1. 完成范围

M13a 已建立 MCP Provider 控制面，但没有实现 M13 Tool 执行面。

本批包含：

- Provider 注册、Owner 归属和不可变版本。
- 服务端连接配置、安全凭证引用和 Revision CAS。
- Worker 异步连接探测、超时、错误分类、健康状态和最近错误。
- Streamable HTTP MCP `initialize` 与 `tools/list` 能力发现。
- Tool Schema 只读展示与摘要，明确不提供 Tool 调用或执行授权。
- `mcp.provider_control_plane=off` 默认关闭。
- append-only Provider 审计。
- M12 `mcp_provider` Resource Binding 对接 Provider 身份。
- Owner/Admin API 和最小 Web 管理入口。

本批明确未实现：

- `tools/call`、Tool 执行授权、Action Ticket 连接或 Execution Gate 扩展。
- 远程 JavaScript、stdio MCP、动态插件加载或浏览器直连 MCP。
- 项目业务链路读取真实 MCP。
- Vault/KMS/托管 Secret Store 的生产 Resolver。
- ProjectMember、RoleGrant 或通用授权模型扩展。

## 2. Migration 49

文件：

- `packages/database/src/schema.ts`
- `packages/database/src/migrate.ts`

### 2.1 新增表

`mcp_providers`：

```text
id
provider_key
owner_principal_id
name
description
status
current_version
current_version_id
health_status
health_checked_at
health_version_id
discovery_status
tool_count
last_error_category
last_error_code
last_error_message
revision
created_at
updated_at
```

`mcp_provider_versions`，不可变：

```text
id
provider_id
version
transport
endpoint_url
auth_kind
credential_ref
credential_header_name
request_timeout_ms
config_digest
created_by_principal_id
created_at
```

`mcp_provider_probes`：

```text
id
provider_id
provider_version_id
status
trigger_source
requested_by_principal_id
error_category
error_code
error_message
duration_ms
tool_count
lease_owner
lease_token
lease_expires_at
requested_at
started_at
completed_at
```

`mcp_provider_tools`：

```text
id
provider_id
provider_version_id
probe_id
tool_name
description
input_schema
output_schema
schema_digest
discovered_at
```

`mcp_provider_audit_events`：

```text
id
provider_id
seq
action
actor_principal_id
actor_role
reason
from_state
to_state
revision
created_at
```

### 2.2 Enforce

- Provider Revision 每次精确 `+1`。
- Provider Key、Owner 不可变。
- Provider Version 和 Tool Schema 不可变。
- 同一 Provider 最多一个 `queued/running` 探测。
- `archived` 不可恢复。
- 启用当前版本前必须同时满足：
  - `health_status=healthy`
  - `discovery_status=ready`
  - `health_version_id=current_version_id`
- Provider 审计 UPDATE/DELETE 由 Trigger 拒绝。

### 2.3 M12 兼容

Migration 49 重新定义 Market 资源绑定校验函数，增加 `mcp_provider` 到
`mcp_providers` 的分支。

- 原 M12 MCP Catalogue 身份绑定继续有效。
- 新 Provider 绑定仅引用 `provider.id/provider_key` 和 Version ID。
- 不复制 Endpoint、凭证引用、Tool Schema 或执行权限。
- 不修改 Migration 48 已验收字段和旧 Market 读写协议。

### 2.4 默认关闭

```text
mcp.provider_control_plane=off
```

Flag 关闭时：

- Provider API 返回 503。
- 不写 Provider、Version、Probe 或 Audit。
- Worker 不 claim Probe Job。

## 3. Contracts

文件：

- `packages/contracts/src/mcp-provider.ts`
- `packages/contracts/src/index.ts`

新增契约：

- `MCP_PROVIDER_CONTROL_PLANE_FLAG`
- `McpProviderStatus`
- `McpProviderHealthStatus`
- `McpProviderDiscoveryStatus`
- `McpProviderTransport`
- `McpProviderAuthKind`
- `McpProviderErrorCategory`
- `McpProviderProbeStatus`
- `McpProviderProbeTrigger`
- `CreateMcpProviderInput`
- `CreateMcpProviderVersionInput`
- `McpProviderRevisionInput`
- `McpProviderProbeInput`
- `McpProviderHealthCheckInput`
- `McpProvider`
- `McpProviderVersion`
- `McpProviderProbe`
- `McpProviderTool`
- `McpProviderAudit`
- `McpProviderDetail`
- `McpProviderProbeRequestResult`
- `McpProviderHealthCheckResult`
- `McpProviderToolList`

公开 Provider、Version、Probe 和 Tool 契约不包含 `credentialRef`、原始
Endpoint、请求头或访问令牌。

## 4. 数据与状态机

Provider 生命周期：

```text
draft -> active
draft/active -> disabled
draft/active/disabled -> archived
active -> draft    # 新增版本时
disabled -> active # 当前版本重新探测成功后
```

健康状态：

```text
unknown -> probing -> healthy
                   -> unhealthy
```

探测状态：

```text
queued -> running -> passed
                  -> failed
```

规则：

- 新版本重置健康、Tool 发现和最近错误。
- 激活必须由当前版本的成功探测支撑。
- Worker 完成探测时校验目标 Version 仍是当前 Version。
- 陈旧探测结果只写 Probe 和系统审计，不覆盖当前健康状态。

## 5. 权限矩阵

| 操作 | Owner | Platform Admin | 其他用户 |
| --- | --- | --- | --- |
| 查看自己的 Provider | 允许 | 允许 | 不允许 |
| 查看全部 Provider | 不允许 | 允许 | 不允许 |
| 创建 Provider | 允许，Owner 固定为自己 | 允许 | 允许，Owner 固定为自己 |
| 修改/探测本人 Provider | 允许 | 允许 | 不允许 |
| 修改/探测他人 Provider | 不允许 | 允许 | 不允许 |
| 平台级健康检查 | 不允许 | 允许 | 不允许 |
| Market 绑定 Provider 身份 | 按 Market Owner/Admin 规则 | 按 Market 规则 | 不允许 |
| 获得 Tool 执行权限 | 不产生 | 不产生 | 不产生 |

没有新增 ProjectMember、RoleGrant、WorkspaceGrant 或 PlatformPermission。

## 6. API

新增：

```text
GET  /api/v1/mcp-providers
POST /api/v1/mcp-providers
GET  /api/v1/mcp-providers/:providerId
POST /api/v1/mcp-providers/:providerId/versions
POST /api/v1/mcp-providers/:providerId/activate
POST /api/v1/mcp-providers/:providerId/disable
POST /api/v1/mcp-providers/:providerId/archive
POST /api/v1/mcp-providers/:providerId/probes
GET  /api/v1/mcp-providers/:providerId/tools
GET  /api/v1/mcp-providers/:providerId/audit
POST /api/v1/admin/mcp-providers/health-check
```

所有写操作使用 `expectedRevision`。并发相同 Revision 只有一个请求成功，
其余返回 `409 mcp_provider_revision_conflict`。

Provider API 由 Provider Application 层判断 Owner/Admin，不经过
平台管理员全局放行。平台级健康检查仍经过 `/api/v1/admin/` 路由保护。

## 7. Worker 与凭证边界

文件：

- `apps/worker/src/mcp-provider-probe-service.ts`
- `apps/worker/src/worker-runtime.ts`
- `apps/worker/src/index.ts`

Worker 只执行以下 MCP 控制面操作：

```text
initialize
notifications/initialized
tools/list
```

不执行 `tools/call`。

安全约束：

- 仅允许 HTTP/HTTPS Streamable MCP。
- 默认要求 HTTPS。
- 默认拒绝私有地址和回环地址。
- 支持 Host allowlist。
- 禁止 URL 内嵌用户名/密码。
- 禁止重定向、Cookie 和浏览器凭据。
- 请求和响应均有硬超时。
- 响应按 2 MiB 上限流式截断。
- 日志只记录 Provider/Probe ID、Version、耗时和错误分类。
- 错误分类覆盖 Timeout、DNS、TLS、Authentication、Authorization、
  HTTP Status、Protocol、Schema、Network、Credential 和 Unknown。

凭证：

- DB 只保存 `env://...` 或 `secret://...` 引用。
- API 输入一次引用，响应只返回 `credentialConfigured`。
- Worker 通过 Resolver 在服务端解析。
- 默认 Resolver 支持 `env://`。
- `secret://` 已保留 Resolver 端口，但生产 Secret Store 尚未接入。

## 8. M12 Resource Binding

M13a Provider 激活后可被 Market 以 `mcp_provider` 资源类型引用：

```text
resourceKind = mcp_provider
resourceId = provider.id 或 provider.providerKey
resourceVersionId = current provider version id
```

Binding：

- 只保存身份引用。
- 不保存 Endpoint、凭证引用、Tool Schema 或 Manifest 正文。
- 不创建 ProjectMember 或 RoleGrant。
- 不产生 Action Ticket 或 Tool 执行权限。
- 原 M12 MCP Catalogue 引用路径继续兼容。

## 9. Web

文件：

- `apps/web/src/McpProvidersView.tsx`
- `apps/web/src/App.tsx`
- `apps/web/src/api.ts`
- `apps/web/src/styles.css`

最小入口支持：

- 列出 Owner 可见 Provider；管理员可看到全部。
- 注册 Provider。
- 创建新版本。
- 发起探测、启用、停用和归档。
- 管理员平台健康检查。
- 查看健康状态、最近错误、Tool 数量和 Tool Schema。
- 查看 append-only 审计。

页面不显示已有完整 Endpoint、凭证引用或凭证值。桌面、900px 和移动端使用
响应式布局，无横向溢出。

## 10. 验证结果

### 10.1 Migration 49 隔离

```text
./scripts/m13a-mcp-provider-migration-vitest.sh

m13a_migration_vitest=ok
fresh_migration=0->49
upgrade_migration=47->49,48->49
idempotent_migration=49->49
flag=mcp.provider_control_plane=off
tables=5
columns=9
triggers=5
existing_market=platform|platform|published|active|public|active
mcp_bindings=2
old_app_read=private|active|private
old_app_projection=user|private|published|active
```

### 10.2 M13a PostgreSQL 集成

```text
./scripts/m13a-mcp-provider-vitest.sh

Test Files  1 passed
Tests       7 passed
```

覆盖：

- Flag 关闭无 Provider/Probe/Audit 副作用。
- 凭证引用和凭证值不出现在 API、审计和 Market 响应。
- Owner 不能修改他人 Provider。
- 非管理员不能执行平台级健康检查。
- Revision 同值并发一个成功、一个冲突。
- 探测超时分类、失败健康状态和成功恢复。
- 陈旧版本探测结果不覆盖当前版本。
- Tool Schema 只读且无调用端点。
- Market Provider Binding 不复制连接、不授予执行权限。
- Provider 审计 append-only。

### 10.3 Worker 与 Contracts

```text
pnpm vitest run \
  packages/contracts/src/mcp-provider.test.ts \
  apps/worker/src/mcp-provider-probe-service.test.ts

Test Files  2 passed
Tests       7 passed
```

覆盖凭证引用校验、URL 安全、Streamable HTTP Tool 发现、Timeout/DNS/TLS/
Authentication 分类、日志脱敏和 Flag 关闭不 claim。

### 10.4 M12 回归

```text
./scripts/m12-market-governance-migration-vitest.sh
m12_migration_vitest=ok

./scripts/m12-market-governance-vitest.sh
Test Files  1 passed
Tests       8 passed
```

### 10.5 Web E2E

```text
./scripts/m13a-mcp-provider-e2e.sh

1 passed
```

浏览器验证：

- 管理员可见“MCP 连接”和平台健康检查。
- 可注册 Provider 并看到安全摘要。
- 完整 Endpoint 和凭证引用不回显。
- Tool Schema 区域明确只读。
- `1440x1000` 与 `390x844` 无横向溢出。

截图：

- `.tmp/m13a-mcp-provider-desktop.png`
- `.tmp/m13a-mcp-provider-mobile.png`

### 10.6 全仓检查

```text
pnpm typecheck  pass
pnpm lint       pass
pnpm test       pass（215 passed / 269 skipped）
pnpm build      pass
```

## 11. 剩余风险与未完成项

- 生产 Secret Store Resolver 未接入；当前默认只解析 `env://`。
- `secret://` 可安全存储，但默认 Worker 会返回 `credential_unavailable`。
- 真实外部 MCP Server 的厂商差异需要继续通过 Fixture 和灰度探测观察。
- Tool 调用、Action Ticket、Execution Gate 和项目来源读取仍属于后续 M13 批次。
- Host allowlist、私有地址拒绝和证书策略需要按部署网络环境配置。
- Provider 与 Probe 表会持续增长，需要观察索引、锁等待和探测频率。
