# V1 Batch 14B: Authentication 与登录 Session

> 状态：Bearer Session、登录、改密、账号启停、Session 撤销、审计和 Web 登录入口已完成。
> Migration 24 身份表保持不变；本批未执行旧数据 backfill。

## 1. 认证模式

`AUTH_MODE` 支持：

| 模式 | 用途 | 行为 |
| --- | --- | --- |
| `bearer` | 默认、生产 | 只接受有效 Bearer Session；不信任任何客户端 actor Header。 |
| `local-development` | Vitest、本机调试 | 允许显式 `x-pluginmax-actor`；未提供时使用 `LOCAL_ACTOR_ID`。 |

未配置 `AUTH_MODE` 时默认 `bearer`。只有 `NODE_ENV=test` 默认使用
`local-development`。`local-development` 不得用于对外部署。

认证中间件在业务路由前执行：

```text
Bearer Token
  -> SHA-256 Token Hash
  -> auth_sessions
  -> Account active
  -> Credential active
  -> Human Principal active
  -> Session active 且未过期
  -> trusted request Principal
```

客户端伪造 `x-pluginmax-authenticated-*` Header 会在 `onRequest` 被删除，不能绕过
认证。

## 2. 账号与 Session

Migration 24 继续作为唯一身份表结构：

- `principals`
- `accounts`
- `account_credentials`
- `auth_sessions`
- `role_grants`
- `identity_audit_events`

密码使用 scrypt，数据库只保存 Hash。Bearer Token 使用 32 字节随机值，数据库只保存
SHA-256 Hash。登录失败对不存在账号和错误密码使用同一响应，并执行 dummy Hash 校验，
降低账号枚举时序差异。

已实现：

- 登录：`POST /api/v1/auth/login`
- 当前 Principal：`GET /api/v1/auth/me`
- 注销：`POST /api/v1/auth/logout`
- 修改密码：`POST /api/v1/auth/change-password`
- 平台管理员启停账号：`POST /api/v1/accounts/:accountId/status`

修改密码保留当前 Session，撤销该 Principal 的其他 Session。停用账号会同时停用
Credential、投影 Principal 状态并立即撤销全部 Session。AI Principal 不能拥有
Account，数据库触发器继续作为最终约束。

## 3. 管理员引导

Bearer 模式首次启动可配置：

```text
BOOTSTRAP_ADMIN_LOGIN_ID=admin
BOOTSTRAP_ADMIN_PASSWORD=replace-with-a-strong-password
BOOTSTRAP_ADMIN_PRINCIPAL_ID=principal-human-admin
BOOTSTRAP_ADMIN_ACCOUNT_ID=account-admin
BOOTSTRAP_ADMIN_DISPLAY_NAME=Platform Admin
```

登录 ID 和密码必须同时提供。引导过程幂等：Principal、Account、Credential 和
Platform `ADMIN` Grant 只在缺失时创建；已存在的 Credential 不会因重启被密码覆盖。
已存在的同 ID 非 Human Principal 会 fail closed。

引导密码不得写入仓库、日志或报告。

## 4. Web

Web 请求自动读取当前标签页的 Bearer Token 并附加 `Authorization` Header。Token
保存在 `sessionStorage`，不写入长期 `localStorage`。

无会话时显示登录页；登录成功后重新加载 viewer、项目与 Agent 查询。注销会撤销服务端
Session 并清理本地 Token。本地开发模式不显示退出动作。

## 5. 测试

本批使用独立 PostgreSQL：

```bash
docker-compose -p pluginmax-batch14b-auth \
  -f docker-compose.batch14b-auth.yml up -d postgres
```

默认宿主机端口为 `54419`；占用时应通过
`BATCH14B_AUTH_POSTGRES_PORT` 选择空闲端口，不修改其他批次容器。

覆盖：

- scrypt Hash 验证，明文不落库。
- 登录、Token Hash、Session 解析和过期/撤销 fail closed。
- 改密保留当前 Session 并撤销其他 Session。
- 账号停用即时拒绝原 Token，重新启用后可重新登录。
- 无 Bearer、伪造 trusted Header、AI 登录失败。
- 完整 API 回归和 Web production build。

## 6. 已知限制

- 尚未实现登录 Rate Limit、账号锁定和分布式防暴力破解。
- 当前 Bearer Token 由 `sessionStorage` 持有；生产 CSP 和 XSS 防护仍需部署评审。
- 未实现 SSO、MFA、密码找回和强制改密。
- 平台管理员目前由 active Platform `ADMIN` Grant 决定；更细的 Platform Grant 消费属于
  Batch 14C。
- 旧 Session 不迁移；认证切换后用户必须重新登录。
- 本批不执行旧数据 backfill。
