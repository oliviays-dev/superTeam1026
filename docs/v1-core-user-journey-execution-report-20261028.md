# Pluginmax V1 核心用户历程回归执行报告

> 执行日期：2026-10-28
>
> 执行方式：Playwright 浏览器自动化 + 独立 PostgreSQL + 独立 API/Worker/Web
>
> 用户历程设计：[v1-core-regression-user-journey-design.md](./v1-core-regression-user-journey-design.md)
>
> 证据根目录：`.tmp/core-regression/user-journey-20261028-final`

## 1. 执行结论

本轮核心用户历程回归通过。

| 结果项 | 结果 |
| --- | --- |
| Bearer 浏览器旅程 | 7 / 7 通过 |
| local-development 浏览器旅程 | 5 / 5 通过 |
| 浏览器旅程合计 | 12 / 12 通过 |
| 三视口证据 | 43 张截图 |
| 最终定向 API/Integration | 4 文件 / 20 用例通过 |
| TypeScript | `pnpm run typecheck` 通过 |
| Lint | 通过，保留 5 条已知 warning |
| Build | 通过 |
| Secret 文本扫描 | fixture、日志、manifest 无密码、Bearer Token、Authorization Header 命中 |
| 隔离容器和临时数据库 | 本轮使用的环境已清理 |

结论：

- U1 邀请、激活、首次登录和身份管理核心路径通过。
- U2 Project、Task、Workflow、Meeting 和基础 Workbench 核心入口通过。
- U3 Task 评论、附件、活动时间线和普通成员权限路径通过。
- U4 AI Teammate、Runtime、Preflight、Action Ticket、Gate、Run 和产物通过。
- U5 Meeting 私密嘱咐、Minutes、行动项、文件和归档通过。
- U6 多 Principal、跨项目、Grant 撤销和权限变化通过。
- U7 刷新、Gate 恢复、Run 恢复和最后管理员保护通过。

仍不能宣称完整覆盖 DSH：

- Project Governance 和 Role Draft/Confirm 仍为 `BLOCKED`。
- Workbench 自定义布局、模块级状态和 Brief SSE 仍为 `BLOCKED`。
- Shared Space 当前处于并行开发中，不属于本轮 U1-U7 通过证据。
- 通用 Human Avatar Delegation 仍为 `BLOCKED`。

## 2. 基线与环境

### 2.1 开始基线

| 对象 | 值 |
| --- | --- |
| 平台分支 | `main` |
| 平台 HEAD | `5b7f7f5bc179ca0435c96126a950e7b3605847f4` |
| 平台初始 Migration | 32 |
| DSH 分支 | `feat/external-agent-teammates` |
| DSH HEAD | `a702267abfc6baebc7cab7b3045e71c204079e10` |
| DSH 初始工作树 | 干净 |

### 2.2 测试环境

- PostgreSQL：Docker 独立实例，隔离数据库。
- API：Fastify。
- Worker：Fake/受控 External Runtime。
- Web：Vite。
- 浏览器：Playwright Chromium。
- Bearer API/Web：`4540` / `4541`。
- local-development API/Web：`4560` / `4561`。
- 所有测试文件、日志和截图位于平台 `.tmp`。

### 2.3 并发工作区说明

执行期间，当前工作区被另一个并行 session 加入了 Shared Space 实现、Migration 33
和 Shared Space 测试。本轮没有回退这些改动，只以下列方式兼容：

- 新增 Migration 失败时的版本号上下文。
- 引入 `LATEST_MIGRATION_VERSION`，消除测试和 API readiness 的版本硬编码。
- 修复 Shared Space repository 的 lint 错误。
- 将数据库测试全局超时统一到 30 秒。

另外，DSH 工作树在本轮开始后出现了外部修改：

- `plugins/dsh-collab-meeting/client/index.js`
- `plugins/dsh-collab-meeting/src/client-smoke.test.ts`

这些文件不是本 session 修改的。本轮没有回退或覆盖。由于 DSH 工作树在结束时不再与
开始状态一致，本报告不能声称“整个工作区运行期间 DSH 完全未变化”；只能确认本 session
的所有命令和测试产物都在 pluginmax-platform 内。

## 3. 浏览器执行结果

### 3.1 Bearer 阶段

命令入口：

```bash
COMPOSE_PROJECT=pluginmax-user-journey-final \
CORE_REGRESSION_RUN_ID=user-journey-20261028-final \
./scripts/core-regression-e2e.sh
```

结果：

| 用例 | 用户旅程 | 结果 |
| --- | --- | --- |
| Identity Administration | U1 团队初始化 | 通过 |
| 非管理员可见性 | U1、U6 | 通过 |
| RBAC 多 Principal 与 Grant 撤销 | U2、U6 | 通过 |
| Action Ticket blocking Gate | U4、U7 | 通过 |
| Meeting Collaboration | U5 | 通过 |
| AI Teammate | U4 | 通过 |
| Scene Context 与 Replay | U4、U7 | 通过 |

合计：`7 passed (32.5s)`。

新增覆盖：

- 管理员创建邀请账号。
- 一次性激活凭据只显示一次。
- 被邀请用户通过激活接口设置密码。
- 被邀请用户在新浏览器 Context 中首次登录成功。
- 页面显示正确账号名称。
- 管理员仍可继续完成平台 Grant、Workspace 和审计操作。

### 3.2 local-development 阶段

结果：

| 用例 | 用户旅程 | 结果 |
| --- | --- | --- |
| Task 评论、回复、附件和活动时间线 | U3 | 通过 |
| AI Direct Chat | U3、U4 | 通过 |
| Workbench Reports 与风险聚合 | U2、U5 | 通过 |
| External Runtime Binding/Preflight | U4 | 通过 |
| plain-text final-only 与 codex-jsonl Run | U4 | 通过 |

合计：`5 passed (40.7s)`。

### 3.3 三视口与证据

截图覆盖：

- Identity Administration：1440、900、390。
- RBAC：1440、900、390。
- Action Gate：1440、900、390。
- Meeting Collaboration：1440、900、390。
- AI Teammate：1440、900、390。
- Scene Context：1440、900、390。
- Task Collaboration：桌面、390。
- AI Direct Chat：桌面、390。
- Workbench Reports：桌面、390。
- External Runtime：桌面、900、390，以及不同协议状态。

自动检查包括：

- `document.documentElement.scrollWidth <= window.innerWidth + 1`。
- 关键按钮、标题、状态和表单可见。
- 刷新后状态恢复。
- 权限撤销后 API 拒绝。
- 私密嘱咐和 Minutes 状态可见。

人工抽查：

- Identity Admin 1440：身份审计列表和主操作区布局正常。
- Meeting Collaboration 390：消息、AI 控制和结束会议按钮可操作。
- Action Gate 900：Ticket、Gate 和 Run 信息可读。
- Workbench 390：Brief 和待办堆叠正常，无页面级横向溢出。

## 4. 用户旅程明细

| 旅程 | 结果 | 说明 |
| --- | --- | --- |
| U1 团队初始化 | PASS | 邀请、激活、首次登录、Workspace、Grant、审计均通过 |
| U2 项目执行 | PASS 核心链路 | Project、Task、Workflow、Meeting、基础 Workbench 通过；Governance 仍为业务缺口 |
| U3 成员协作 | PASS | 评论、回复、附件、时间线和跨项目授权通过 |
| U4 AI 执行 | PASS | Teammate、Runtime、Preflight、Gate、Run、未知 usage 通过 |
| U5 会议闭环 | PASS | 私密嘱咐、Minutes、行动项、文件、归档通过 |
| U6 权限负向 | PASS | 多 Principal、跨项目、Grant 撤销和账号状态通过 |
| U7 恢复与并发 | PASS 核心链路 | 刷新、Gate 恢复、Run 恢复和管理员并发保护通过 |

## 5. 发现与修复

### 5.1 U1 浏览器测试缺少激活后首次登录

问题：

- 原用例只验证了一次性激活凭据生成，没有走通激活和首次登录。

修复：

- 在 Identity Administration Playwright 用例中调用激活 API。
- 使用独立 Browser Context 以新账号登录。
- 验证 Session 建立和账号名称显示。

结果：通过。

### 5.2 Migration 版本硬编码

问题：

- 并行加入 Migration 33 后，部分测试和 readiness 默认值仍固定为 32。
- 全量测试出现 `migrationVersion 33` 与预期 32 不一致。

修复：

- 导出 `LATEST_MIGRATION_VERSION`。
- API readiness 默认使用最新 Migration 常量。
- Repository/API 测试改用该常量。
- 技术回归脚本自动执行 `N-1 -> N`，不再固定 31->32。

结果：类型检查通过，定向集成测试通过。

### 5.3 数据库集成测试超时过低

问题：

- Task、Meeting 和 Workbench 集成用例在并行开发负载下多次超过 5 秒。
- 单独设置的 15 秒仍不足以覆盖最慢的 Meeting 场景。

修复：

- Vitest 全局 `testTimeout` 和 `hookTimeout` 调整为 30 秒。

验证：

- 全新数据库上 App、Task、Workbench、Meeting 共 4 文件 / 20 用例通过。

### 5.4 Shared Space repository lint 错误

问题：

- `input.runId == null` 不符合 lint 规则。
- `ActionTicket` 类型导入未使用。

修复：

- 改为严格的 null/undefined 判断。
- 移除未使用导入。

结果：lint 不再报 error，仅保留 control-character regex warning。

### 5.5 Migration 错误缺少版本上下文

问题：

- Migration 失败时只返回 PostgreSQL 原始错误，无法直接知道失败版本。

修复：

- Migration 异常包装为 `Migration <version> failed`，保留原始 cause。

结果：通过类型检查。

### 5.6 测试数据库复用造成 trace 污染

问题：

- 在同一数据库重复运行 App trace 测试时，会看到上一次运行留下的同 trace ID 数据。
- 这不是产品 bug，是测试隔离不足。

本轮处理：

- 用户历程采用每次新建隔离数据库。
- 最终定向回归使用全新临时数据库，20/20 通过。

后续建议：

- `app.test.ts` 改为独立 Schema，与 Identity Administration 测试一致。
- 所有写 public schema 的集成测试必须使用唯一 Schema 或 Fresh Database。

## 6. 当前失败与风险

### 6.1 并行 Shared Space 测试

并行加入的 Shared Space 仍有 3 个 API 测试失败：

- 路径父目录存在性。
- Global Write 过期成员边界。
- Agent directory creation 返回异常状态。

这些失败属于正在并行开发的 Shared Space，不属于本轮 U1-U7 浏览器通过证据。
本轮没有掩盖或回退它们。

### 6.2 全量测试

当前工作树在一次全量测试中为：

```text
68 files: 63 passed, 5 failed
323 tests: 303 passed, 12 failed, 8 skipped
```

失败来源：

- Shared Space API 3 个。
- Meeting AI 与 Workbench 的超时，已通过 30 秒测试基线处理。
- App 测试数据库复用污染，已通过 fresh Database 验证。

因此本报告只声称：

- 用户历程相关浏览器回归通过。
- U1-U7 对应定向集成回归通过。
- 不声称当前整个工作树的全量 Vitest 已全绿。

### 6.3 DSH 工作树变化

本轮开始时 DSH 干净，结束时出现外部修改。由于不是本 session 写入且不能擅自回退，
最终必须在并行 session 完成后重新确认 DSH 工作树。

## 7. 证据位置

```text
.tmp/core-regression/user-journey-20261028-final/
├── manifest.json
├── summary.txt
├── bearer-fixture.json
├── screenshots/
├── bearer/
│   └── playwright-results/
├── local/
│   └── playwright-results/
└── logs/
```

关键日志：

- `logs/bearer-playwright.log`
- `logs/local-playwright.log`
- `logs/bearer-api.log`
- `logs/bearer-worker.log`
- `logs/local-api.log`
- `logs/local-worker.log`

## 8. 最终判定

核心用户历程 U1-U7 的浏览器主链路通过，管理员安全缺陷已关闭。

发布判断：

- 若发布范围是当前核心协作能力，用户历程回归没有新增阻断。
- 若发布承诺 Project Governance、Workbench 可配置布局、Shared Space 或通用
  Human Avatar，这些能力仍未完成，不能计入通过。
- 当前工作树由于并行开发存在非用户历程测试失败，正式发布前必须在并行变更收敛后
  再跑一次全量 Vitest。
