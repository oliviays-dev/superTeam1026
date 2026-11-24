# dsh-pluginmax M13 收口与生产发布门

> 日期：2026-11-21
> 覆盖：M13a、M13b、M13c、M13d、M13e
> Migration：49-53

## 1. 收口状态

| 阶段 | 能力 | 状态 |
| --- | --- | --- |
| M13a | MCP Provider 控制面、Probe、Tool Discovery | 已完成 |
| M13b | Worker-only Tool Call、Action Ticket、Gate、Receipt | 已完成 |
| M13c | Agent Runtime Tool Request Bridge | 已完成 |
| M13d | Secret Resolver、Project Source MCP、Source Alert | 已完成 |
| M13e | Artifact Source、Workbench Brief SSE | 已完成 |

Migration：

```text
49 M13a
50 M13b
51 M13c
52 M13d
53 M13e
```

## 2. 默认 Flag

```text
mcp.provider_control_plane=off
mcp.tool_invocation=off
mcp.runtime_tool_bridge=off
project.business_chain=off
project.source.mock=off
project.source.mcp=off
```

Flag 关闭时：

- 不解析 Secret Store。
- 不访问 MCP Provider。
- 不创建 Tool Call、Runtime Request 或 Project Source Read。
- 不写 Snapshot、Receipt、Audit 或 Alert。

## 3. 生产部署前置

### Secret Store

部署方必须二选一：

1. 由 Vault Agent、Kubernetes Secret 或云 Secret Manager 同步生成 JSON
   文件，配置 `MCP_SECRET_STORE_FILE`，文件权限为 `0600`。
2. 在 Worker 组装代码注入实现 `SecretStoreAdapter` 的部署 Adapter。

未配置时所有 `secret://` 必须 fail closed。

### 网络

- MCP Endpoint 默认必须 HTTPS。
- 私网地址默认拒绝。
- 如部署确有内网 MCP，需显式配置 Host allowlist 和私网开关。
- 反向代理必须支持 SSE 长连接并关闭响应 Buffering。

### 数据库

- 发布应用前完成 Migration 49-53。
- 确认 Migration 版本与 API `expectedMigrationVersion` 一致。
- 备份 `mcp_*`、`runtime_tool_*`、`project_source_*` 和 `artifacts`。

## 4. 发布门

### G9 Provider 控制面

- Provider Owner 与 Admin 权限边界。
- Endpoint、Credential Ref 和凭证值不回流。
- 探测超时、DNS、TLS、Auth、HTTP 和 Schema 分类。

### G10 Tool Call

- 缺 Run、Ticket、Gate、Policy 或 Envelope 拒绝。
- Gate 只能消费一次。
- 终态幂等重放不重复调用 Provider。
- Receipt 和 Audit append-only。

### G11 Runtime Bridge

- Adapter 显式声明 `structured-v1`。
- `tool.request` 只携带意图。
- 取消、超时、租约丢失和乱序完成收敛。

### G12 Project Source

- `secret://` 未配置 fail closed。
- 来源只能通过 Worker Bridge 读取。
- 浏览器直连或通用 invoke 返回 404。
- Provider Version、Tool Key、健康状态和执行授权缺一不可。
- Source Snapshot、Stale/Error、Alert 和 Prometheus 指标一致。

### G13 Artifact 与 Brief

- Artifact 来源引用是创建时快照。
- 旧 Artifact 来源为空但可读。
- Brief SSE 新版本 8 秒内可见。
- SSE 断开后自动重连，轮询兜底仍有效。

## 5. 灰度顺序

```text
内部管理员
  -> 单个非生产项目
  -> 单个项目模板下项目组
  -> 10% 项目
  -> 全量
```

每阶段观察：

- Provider Probe 成功率与延迟。
- Tool Call 授权拒绝原因。
- Runtime Tool Request 错误率和 Stale。
- Project Source Fresh/Stale/Error 与 Alert。
- Secret Store 文件权限与轮换。
- Workbench SSE 连接数、重连率和代理断开。
- Artifact 来源覆盖率和无法点击来源。

## 6. 回滚

优先顺序：

1. 关闭 `project.source.mcp`。
2. 关闭 `mcp.runtime_tool_bridge`。
3. 关闭 `mcp.tool_invocation`。
4. 关闭 `mcp.provider_control_plane`。
5. 回退到支持 Migration 53 的上一应用版本。
6. Schema 阻断时恢复迁移前备份到隔离实例。

禁止：

- 手工删除 Provider Audit、Tool Receipt 或 Source Read Event。
- 修改历史 Artifact `source_refs` 以“修正”来源。
- 通过手工 SQL 绕过 Gate 或 Ticket。

## 7. 仍需部署方决策

- Secret Store 最终选型。
- Project Source Read 的正式业务触发点。
- Source Read/Snapshot/Event 的归档和物理保留周期。
- SSE 是否经专用网关和连接上限。
- 内网 MCP 的 Host allowlist 与证书策略。

## 8. 一键验证

```sh
CI=true pnpm typecheck
CI=true pnpm lint
CI=true pnpm test
CI=true pnpm build

./scripts/m13a-mcp-provider-migration-vitest.sh
./scripts/m13a-mcp-provider-vitest.sh
./scripts/m13a-mcp-provider-e2e.sh

./scripts/m13b-mcp-tool-call-migration-vitest.sh
./scripts/m13b-mcp-tool-call-vitest.sh
./scripts/m13b-mcp-tool-call-e2e.sh

./scripts/m13c-runtime-tool-migration-vitest.sh
./scripts/m13c-runtime-tool-vitest.sh
./scripts/m13c-runtime-tool-e2e.sh

./scripts/m13d-project-source-migration-vitest.sh
./scripts/m13d-project-source-vitest.sh
./scripts/m13d-project-source-e2e.sh

./scripts/m13e-artifact-source-migration-vitest.sh
CI=true ./scripts/workbench-reports-e2e.sh
```
