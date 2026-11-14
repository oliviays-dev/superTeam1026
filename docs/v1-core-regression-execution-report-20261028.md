# Pluginmax V1 核心回归执行与修复报告

> 执行日期：2026-10-28
>
> 平台基线：`main` / `5b7f7f5bc179ca0435c96126a950e7b3605847f4`
>
> DSH 基线：`feat/external-agent-teammates` / `a702267abfc6baebc7cab7b3045e71c204079e10`
>
> Migration：32
>
> 技术设计：[v1-core-regression-technical-test-design.md](./v1-core-regression-technical-test-design.md)
>
> 用户历程：[v1-core-regression-user-journey-design.md](./v1-core-regression-user-journey-design.md)

## 1. 结论

本轮完成技术回归和两阶段 GUI 核心回归，并修复执行过程中确认的发布阻断缺陷。

| 项目 | 结果 |
| --- | --- |
| 核心管理员安全 | `P0-REG-01` 已修复并关闭 |
| fresh Migration | `0 -> 32` 通过 |
| upgrade Migration | `31 -> 32` 通过，Workspace 回填正确 |
| 完整 Vitest | 64 文件 / 299 用例通过 |
| Bearer GUI | 7 / 7 通过 |
| local-development GUI | 5 / 5 通过 |
| TypeScript | `pnpm run typecheck` 通过 |
| Lint | `pnpm run lint` 通过 |
| Build | `pnpm run build` 通过 |
| Format | 相关文件 Prettier 检查通过 |
| Secret 文本扫描 | fixture、日志和摘要无密码、Bearer Token、Authorization Header 命中 |
| 容器清理 | 默认清理流程已补齐，最终无残留核心回归容器 |

本轮没有继续实现 Batch 19/20/21，也没有改变 15A、15B、16 的执行语义。

## 2. 交付物

### 2.1 测试与 Runbook

- `scripts/core-regression-technical.sh`
  - 独立 PostgreSQL。
  - fresh `0 -> 32`。
  - upgrade `31 -> 32`。
  - Workspace 和成员版本回填断言。
  - 含数据库的完整 Vitest。
  - `manifest.json`、`summary.txt`、服务日志。
- `scripts/core-regression-e2e.sh`
  - bearer 与 local-development 分阶段运行。
  - 独立数据库、端口、API、Worker、Web 和 `.tmp`。
  - `CORE_E2E_PHASE=all|bearer|local`。
  - 自动归档三视口截图和失败 trace。
  - 默认回收进程、数据库、容器和网络。
- `scripts/core-regression-seed.ts`
  - 两个可登录 Platform ADMIN。
  - Human/AI Principal、Workspace ADMIN、pending、disabled、archived。
  - revoked/expired Workspace Grant。
  - 两个隔离 Workspace。
  - fixture 不含密码，密码通过环境变量注入。
- `docker-compose.core-regression.yml`
  - 独立 PostgreSQL 端口，默认 `54440`。

### 2.2 产品修复

- `packages/database/src/identity-admin-guards.ts`
  - 只统计 active Human Principal、active Account、active scrypt Credential 和
    active Grant 的可用管理员。
  - Platform 与 Workspace 管理员变更使用事务锁。
- `packages/database/src/identity-administration-repository.ts`
  - Credential 重置、Platform Grant 撤销、Workspace 成员停用和 Workspace
    Grant 撤销消费统一管理员保护。
- `packages/database/src/identity-repository.ts`
  - Account 停用消费统一管理员保护。

### 2.3 测试修复

- 新增 `identity-administration-guards.test.ts`，覆盖 5 个管理员边界场景。
- Workbench 集成用例超时从默认 5 秒提高到 15 秒，消除负载敏感偶发失败。
- 身份测试使用确定时间 fixture，并在失败时输出响应体。
- Bearer Playwright 密码改为运行时环境变量，兼容旧 fixture fallback。
- 会议测试不再硬编码 `owner E2E Principal`，改为读取 fixture 显示名。

## 3. 执行命令与结果

### 3.1 技术回归

```bash
CORE_REGRESSION_RUN_ID=report-technical-20261028 \
  pnpm test:core:technical
```

结果：

```text
upgrade_migration=32
upgrade_workspace=workspace-core-upgrade|workspace-core-upgrade|active
fresh_migration=32
Test Files  64 passed (64)
Tests       299 passed (299)
full_vitest_exit=0
```

证据：

```text
.tmp/core-regression/report-technical-20261028/
├── manifest.json
├── summary.txt
└── logs/
```

### 3.2 GUI 核心回归

```bash
CORE_REGRESSION_RUN_ID=report-e2e-20261028-final \
  pnpm test:core:e2e
```

Bearer 阶段：

- Identity Administration：2 用例。
- RBAC 多 Principal 与即时 Grant 撤销：1 用例。
- Action Ticket blocking Gate：1 用例。
- Meeting Collaboration：1 用例。
- AI Teammate：1 用例。
- Scene Context 与 Replay：1 用例。

结果：

```text
7 passed (31.9s)
bearer_phase=passed
```

local-development 阶段：

- Task 评论、附件和时间线：1 用例。
- AI Direct Chat：1 用例。
- Workbench Reports：1 用例。
- External Runtime GUI：2 用例。

结果：

```text
5 passed (22.7s)
local_phase=passed
```

合计：`12 passed`，三视口截图 32 张。

证据：

```text
.tmp/core-regression/report-e2e-20261028-final/
├── bearer-fixture.json
├── manifest.json
├── summary.txt
├── screenshots/
├── bearer/
│   └── playwright-results/
├── local/
│   └── playwright-results/
└── logs/
```

人工抽查：

- Identity Administration 1440：账号、平台 Grant、Workspace、审计布局正常。
- Meeting Collaboration 390：主内容与 AI 发言控制可用，无页面级水平溢出。
- Action Ticket 900：Ticket、Envelope、usage 和审批状态可读。
- Workbench 390：Brief、待办和来源入口堆叠正常。

### 3.3 工程门禁

```bash
pnpm run typecheck
pnpm run lint
pnpm run build
bash -n scripts/core-regression-technical.sh scripts/core-regression-e2e.sh
git diff --check
pnpm exec prettier --check <changed files>
```

全部通过。

保留的非阻断构建警告：

- `tsdown` 的 `external` 配置已计划迁移到 `deps.neverBundle`。
- `rolldown-plugin-dts:fake-js` sourcemap 警告为既有 P3。
- Web production bundle 仍有大于 500 kB 的 chunk 警告，属于既有 P2 路由级代码分割项。

## 4. 发现与修复

### 4.1 P0：最后可登录管理员保护不足

原始问题：

- 可用管理员计数把 AI Principal 当成可继续管理主体。
- pending、disabled Credential 或缺失 Credential 的 Human Account 可能被当成
  可继续管理主体。
- 并发撤销或停用没有统一锁，两个管理员可同时通过检查。

修复：

- 统一使用 `isUsablePlatformAdmin` 和 `isUsableWorkspaceAdmin`。
- 查询必须同时命中 active Human Principal、active Account、active scrypt
  Credential、active 未过期 ADMIN Grant。
- Platform 和 Workspace 管理员变更先锁定 Grant 集合，再锁定目标主体。

验证：

- AI ADMIN 不计为可用管理员。
- pending Account ADMIN 不计为可用管理员。
- disabled Credential 不计为可用管理员。
- 并发撤销两个 Platform ADMIN Grant 时只允许一个成功。
- 并发停用两个 Platform ADMIN Account 时保留一个可登录管理员。
- Workspace ADMIN 使用同样保护。

状态：`CLOSED`。

### 4.2 P1：完整测试默认跳过数据库

原始问题：

- `pnpm test` 未设置 `TEST_DATABASE_URL` 时跳过 138 个数据库和 API 用例。

修复：

- 新增 `pnpm test:core:technical`，总是创建独立数据库并执行完整 Vitest。
- manifest 记录 Migration、退出码、SHA 和证据目录。

状态：`CLOSED`。

### 4.3 P1：Workbench 测试负载敏感超时

原始问题：

- 全量运行时一个 Workbench 集成用例超过 5 秒，单独运行 4.82 秒通过。

修复：

- 将该用例超时提高到 15 秒。
- 最终全量运行通过。

状态：`CLOSED`。

### 4.4 Runbook 问题：容器未回收

原始问题：

- 技术阶段只删除数据库，Compose 容器继续占用 `54440`，GUI 阶段首次启动失败。

修复：

- 技术脚本和 E2E 脚本默认执行 `compose down -v`。
- `CORE_REGRESSION_KEEP_ENV=1` 可显式保留环境用于诊断。

状态：`CLOSED`。

### 4.5 Fixture 问题：过期 Grant 违反数据库约束

原始问题：

- 直接把 active Grant 的 `expires_at` 改到过去，违反
  `expires_at > granted_at`。

修复：

- 同时把 `granted_at` 调整到过去，写入 `status = expired`，保持数据库事实自洽。

状态：`CLOSED`。

### 4.6 测试耦合：会议显示名硬编码

原始问题：

- 会议 Playwright 依赖 `owner E2E Principal`，无法复用统一 seed。

修复：

- fixture 增加 `displayName`，测试读取 fixture，不再绑定某个批次的命名。

状态：`CLOSED`。

## 5. 用户旅程覆盖

| 旅程 | 覆盖结果 | 核心证据 |
| --- | --- | --- |
| U1 团队初始化 | 通过 | Identity Administration GUI、账号/Workspace/API 测试 |
| U2 项目执行 | 通过核心链路 | RBAC、Task、Workflow Gate、Workbench 测试 |
| U3 成员协作 | 通过 | Task 评论、附件、时间线、跨项目拒绝 |
| U4 AI 执行 | 通过 | AI Teammate、Gate、External Runtime、Run 证据 |
| U5 会议闭环 | 通过 | 私密嘱咐、Minutes、文件、任务、归档 |
| U6 权限负向 | 通过 | 多 Principal、跨项目、Grant 撤销、disabled/archived |
| U7 恢复与并发 | 通过 | 并发管理员、Gate 恢复、刷新、取消和重试 |

本次 GUI 未直接覆盖的 DSH 对等产品能力：

- Shared Space 路径权限、Global Write、Locks 和 Digest。
- Project Governance 完整字段与项目历史审计。
- Project Role Draft/Confirm 和实例角色快照。
- Workbench 拖拽布局、命名布局、模块级 stale/partial 和 Brief SSE。
- 通用 Human Avatar Delegation。

这些能力仍是业务缺口，不能因为核心回归通过而标记为已覆盖。

## 6. 安全与隔离

- 所有测试使用独立 PostgreSQL 数据库。
- bearer 和 local-development 使用不同数据库、端口和 `.tmp`。
- fixture 只含 Principal、Account、登录名和资源 ID，不含密码。
- 密码通过 `CORE_REGRESSION_PASSWORD` 运行时注入。
- 文本扫描未在 fixture、日志、summary 或 manifest 中发现密码、Bearer Token 或
  Authorization Header。
- 默认清理数据库、API、Worker、Web、Compose 容器和网络。
- 未读取正式数据库、正式 Session/Profile 或生产业务数据。

## 7. 剩余风险

### P1

- Shared Space 未实现。
- Project Governance 和 Role Draft/Confirm 未实现。
- Workbench 自定义布局和 Brief SSE 未实现。
- 通用 Human Avatar Delegation 未实现。

### P2

- Teammate Avatar、模板切换、离开 Workspace、聚合审计详情。
- Persona 独立资产库、Workspace Type、Seat Claim、Leader election。
- Task 通用 external links 和统一来源 UI。
- Web 路由级代码分割。

### 测试边界

- GUI 回归复用现有批次 Playwright 用例，而不是完全重写为一套单文件旅程。
- 成功用例默认不留 trace，仅失败保留；截图、日志和 manifest 始终归档。
- 截图敏感信息检查本轮为文本扫描加人工抽查，不是完整 OCR。
- 真实外部 Provider/WorkBuddy 连通不在本轮范围内，使用 Fake 或受控 Runtime。

## 8. 最终判断

核心管理员发布阻断已关闭，技术测试和 GUI 核心回归达到可重复执行、可定位证据、
可清理环境的状态。

V1 仍不能宣称完整覆盖 DSH 核心用户链路。是否发布取决于产品是否接受 Shared
Space、Project Governance、Workbench 配置和 Human Avatar 作为明确降级项。若这些
能力属于首发承诺，则它们仍是 P1 发布阻断项。
