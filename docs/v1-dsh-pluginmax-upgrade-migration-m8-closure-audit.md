# M8 后续收口审计与提交拆分建议

> 日期：2026-11-14
> 基线：`main@5b7f7f5bc179ca0435c96126a950e7b3605847f4`
> 状态：未创建 commit；未清理未跟踪文件

## 1. 基线事实

```text
branch: main
HEAD:   5b7f7f5bc179ca0435c96126a950e7b3605847f4
Migration max: 44
```

初始 `git diff --check` 无输出。工作树同时包含用户原有修改、
Shared Space、Human Avatar Delegation、Identity Hardening、Core Regression、
M0-M7、M8 和未跟踪文件，不能按当前文件状态直接把整文件归入单一提交。

`packages/database/src/schema.ts`、`migrate.ts`、`apps/api/src/app.ts`、
`apps/web/src/api.ts`、`styles.css`、各 `index.ts`、`package.json` 等为跨阶段
共享文件，必须按 SQL block、route block、export、测试和样式 hunk 拆分。

## 2. 用户原有改动

以下文件可从记录和功能边界识别为用户先行工作，不属于 M8：

- Shared Space：
  `packages/contracts/src/shared-space.ts`、
  `packages/contracts/src/shared-space.test.ts`、
  `packages/application/src/shared-space.ts`、
  `packages/database/src/shared-space-repository.ts`、
  `packages/database/src/shared-space-repository.test.ts`、
  `apps/web/src/SharedSpaceView.tsx`、
  `e2e/shared-space.spec.ts`、
  `apps/api/src/shared-space.test.ts`、
  `apps/worker/src/shared-space-worker.test.ts`、
  `docs/v1-shared-space-product-technical-design.md`。
- Human Avatar Delegation：
  `packages/contracts/src/delegation.ts`、
  `packages/contracts/src/delegation.test.ts`、
  `packages/application/src/delegation.ts`、
  `packages/database/src/delegation-repository.ts`、
  `apps/web/src/DelegationsView.tsx`、
  `e2e/delegation.spec.ts`、
  `apps/api/src/delegation.test.ts`、
  `docs/v1-human-avatar-delegation-product-technical-design.md`。
- Identity Hardening / Identity Administration：
  `packages/database/src/identity-admin-guards.ts`、
  `packages/database/src/identity-administration-guards.test.ts`、
  `packages/database/src/identity-administration-repository.ts`、
  `packages/database/src/identity-repository.ts`、
  `packages/contracts/src/identity.ts`、
  `packages/contracts/src/identity.test.ts`、
  `apps/web/src/IdentityAdministrationView.tsx`、
  `apps/api/src/identity-administration.test.ts`、
  `e2e/identity-administration.spec.ts`、
  `scripts/identity-administration-vitest.sh`。
- Core Regression：
  `docker-compose.core-regression.yml`、
  `scripts/core-regression-e2e.sh`、
  `scripts/core-regression-seed.ts`、
  `scripts/core-regression-technical.sh`、
  `docs/v1-core-regression-*`、
  `docs/v1-core-user-journey-*`。
- 既有 Workbench / Report / RBAC / Meeting 修改：
  `packages/contracts/src/workbench-reports.ts`、
  `packages/database/src/workbench-reports-repository.ts`、
  `apps/web/src/ProjectReportsPanel.tsx`、
  `apps/api/src/workbench-reports.test.ts`、
  `packages/application/src/authorization.ts`、
  `packages/database/src/authorization-repository.ts`、
  以及对应 RBAC / Meeting 测试修改。

这些边界来自实施记录与现有文件，不能替代逐 hunk 的作者确认。提交前应由
用户确认其原始修改范围。

## 3. M0-M8 文件边界

下表只列各阶段新增的独立文件；共享文件在下一节列出。

| 阶段 | Migration | 独立文件 / 脚本 / 文档 |
| --- | --- | --- |
| M0 + M1a | 35-36 | `contracts/execution-decision.ts`、`contracts/task-execution-evidence.ts`、`application/execution-decision.ts`、`application/task-acceptance.ts`、`database/task-execution-evidence-repository.ts`、`apps/api/task-execution-evidence.test.ts`、`contracts/task-execution-evidence.test.ts`、`scripts/m1a-migration-vitest.sh`、M0+M1a 实施记录 |
| M1b | 37 | `contracts/agent-task-tools.ts`、`application/agent-task-tools.ts`、`application/agent-task-tools.test.ts`、`files/workspace-sandbox.ts`、`files/workspace-sandbox.test.ts`、`database/agent-tool-repository.ts`、`apps/api/agent-task-tools.test.ts`、`scripts/agent-task-tools-vitest.sh`、`scripts/m1b-migration-vitest.sh`、M1b 实施记录 |
| M2 | 38 | `contracts/workflow-assignment.ts`、`application/workflow-assignment.ts`、`database/workflow-assignment-repository.ts`、`apps/api/workflow-assignment.test.ts`、`scripts/m2-migration-vitest.sh`、`scripts/m2-workflow-assignment-vitest.sh`、M2 实施记录 |
| M3 | 39 | `contracts/workflow-plan.ts`、`domain/workflow-plan.ts`、`domain/workflow-plan.test.ts`、`application/workflow-plan.ts`、`database/workflow-plan-repository.ts`、`apps/api/workflow-plan.test.ts`、`apps/worker/workflow-plan-reconciler.test.ts`、M3 三个脚本、M3 实施记录 |
| M4 | 40 | `contracts/skill.ts`、`contracts/skill.test.ts`、`application/skills.ts`、`database/skill-repository.ts`、`apps/api/skill-resolution.test.ts`、`apps/api/run-skill-snapshot.test.ts`、M4 三个脚本、M4 实施记录 |
| M5 | 41 | `contracts/context-policy.ts`、`contracts/task-capture.ts`、`database/context-policy-repository.ts`、`database/task-capture-repository.ts`、`apps/api/task-capture.test.ts`、`apps/api/group-scene-context.test.ts`、`apps/api/meeting-multi-ai.test.ts`、M5 四个脚本、M5 实施记录 |
| M6 | 42 | `contracts/project-operations.ts`、`database/project-ai-pm-repository.ts`、`apps/api/project-operations.test.ts`、`scripts/m6-migration-vitest.sh`、`scripts/m6-project-operations-vitest.sh`、M6 实施记录 |
| M7 | 43 | `contracts/data-fabric.ts`、`contracts/data-fabric.test.ts`、`application/data-fabric.ts`、`database/data-fabric-repository.ts`、`apps/api/data-fabric.test.ts`、`scripts/m7-migration-vitest.sh`、`scripts/m7-data-fabric-vitest.sh`、M7 实施记录 |
| M8 | 44 | `contracts/workbench-market.ts`、`contracts/workbench-market.test.ts`、`application/workbench-market.ts`、`database/workbench-configuration-repository.ts`、`database/market-repository.ts`、`apps/api/workbench-market.test.ts`、`apps/web/WorkbenchConfigurationPanel.tsx`、`e2e/workbench-market.spec.ts`、`scripts/m8-migration-vitest.sh`、`scripts/m8-workbench-market-vitest.sh`、`scripts/m8-workbench-market-e2e.sh`、`scripts/m8-workbench-market-e2e-seed.ts`、M8 实施记录、本审计 |

## 4. 跨阶段共享文件

以下文件包含多个阶段或多个功能的 hunk，不能整文件一次性归入 M8：

- Contract / Application / Database exports：
  `packages/contracts/src/index.ts`、
  `packages/application/src/index.ts`、
  `packages/database/src/index.ts`、
  `packages/database/src/repositories.ts`。
- Migration：
  `packages/database/src/schema.ts`、
  `packages/database/src/migrate.ts`。
- API：
  `apps/api/src/app.ts`、
  `apps/api/src/app.test.ts`。
- Web：
  `apps/web/src/App.tsx`、
  `apps/web/src/OperationsViews.tsx`、
  `apps/web/src/api.ts`、
  `apps/web/src/styles.css`。
- Root/config：
  `package.json`、`pnpm-lock.yaml`、`vitest.config.ts`。
- Existing models touched by multiple stages：
  `packages/contracts/src/platform.ts`、
  `packages/contracts/src/collaboration.ts`、
  `packages/contracts/src/scene-context.ts`、
  `packages/application/src/run-executor.ts`、
  `packages/application/src/task-execution-preflight.ts`、
  `packages/application/src/scene-context.ts`、
  `packages/database/src/scene-context-repository.ts`、
  `packages/database/src/workflow-runtime-repository.ts`、
  `packages/database/src/meeting-ai-repository.ts`、
  `packages/database/src/teammate-repository.ts`。

## 5. 安全提交拆分建议

1. 先由用户确认并提交用户原有基线：Shared Space、Delegation、
   Identity Hardening、Core Regression、既有 Workbench/Report/RBAC 修改。
2. M0 + M1a：Migration 35-36，执行判定、验收证据、异常、API、测试。
3. M1b：Migration 37，Agent Task Tools 与 workspace sandbox。
4. M2：Migration 38，模板作用域、assignment binding、preflight。
5. M3：Migration 39，Router、Plan Version、materialization、reconciler。
6. M4：Migration 40，Skill、installation、binding、Run snapshot。
7. M5：Migration 41，Task Capture、Group Scene、Context Policy、Meeting AI。
8. M6：Migration 42，Project PM、Report provenance。
9. M7：Migration 43，Data Fabric、Data Agent、QueryRun；保持默认关闭。
10. M8：Migration 44，Workbench V2、Market、管理员 UI、单面板 module state、
    补偿扫描、三视口 E2E。
11. 最后单独提交闭合文档和测试报告。

执行方式：共享文件使用 `git add -p` 或生成精确 patch 后分阶段暂存；每阶段
提交前至少跑该阶段聚焦测试与 `git diff --cached --check`。不得用
`git reset --hard`、`git checkout --`、`git clean` 或删除未跟踪文件来“整理”
工作树。`.pnpm-store/` 是本地未跟踪缓存，不应进入上述提交。

## 6. 当前风险

- 用户原始修改与 M0-M8 在共享文件中交错，未经作者确认不能可靠自动归属。
- M8 布局仍是键盘上移/下移和宽度选择，不含拖拽交互。
- M8 entitlement 只控制市场资源/静态面板可见性，不构成项目、Workspace、
  Data、Tool 或 Runtime 授权。
- Template copy 补偿扫描只归档无 receipt 的过期 Workbench，不自动补做复制。
- `workbench.v2`、`market` 仍默认关闭，不走 Migration 自动开启。
- Teammates 原失败已作为独立测试夹具问题修复，不属于 M8 功能：
  历史固定周报日期改为当前周动态生成，避免新 attribution 落在目标周外。

## 7. 2026-11-14 补充回归

Core Regression Technical：

```text
Test Files  91 passed (91)
Tests       436 passed (436)
```

首轮发现 Migration 44 在隔离 schema 下使用未限定 `digest(...)` 失败，已改为
`public.digest(...)`；修复后 Migration 相关 8 个文件失败消失。

已修正：

- Platform Grant 重复请求按现有设计扩展同一 Grant；顺序和并发测试均验证
  同一 Grant ID、版本递增。
- M1a G1 测试改为通过项目成员角色替换撤销授权，不再绕过业务同步直接改
  `role_grants`。
- archived Principal 夹具使用 `GREATEST(updated_at, created_at, NOW())`。
- Project Template 测试固定 `project.ai_pm=off`，消除跨用例 Flag 污染。
- Core local E2E 显式开启 `workflow.assignment_bindings`。
- Delegation 失败报告夹具使用 `attempt_count=5`，避免 worker 抢占后与
  显式重试用例竞争。
- Teammates 周报测试改为按当前周动态生成，不再使用过期固定日期。

已无剩余技术失败。

Core Browser E2E：

```text
bearer: 8 passed
local:  6 passed
```

完整 Core Browser 合计 14/14 通过。Identity、RBAC、Shared Space、
Workbench Reports、Meeting、Scene Context、Action Ticket、Delegation 和
External Runtime 均通过。

## 8. M8 暂存检查清单

本节只描述选择规则，不代表已经执行 `git add`。明确授权提交后，按以下边界
暂存 M8：

- 整文件加入：
  `packages/contracts/src/workbench-market.ts`、
  `packages/contracts/src/workbench-market.test.ts`、
  `packages/application/src/workbench-market.ts`、
  `packages/database/src/workbench-configuration-repository.ts`、
  `packages/database/src/market-repository.ts`、
  `apps/api/src/workbench-market.test.ts`、
  `apps/web/src/WorkbenchConfigurationPanel.tsx`、
  `e2e/workbench-market.spec.ts`、
  `scripts/m8-*`、M8 实施记录和本审计。
- `packages/database/src/migrate.ts`：只选择 M8 import、`version: 44`
  和 M8 Migration 所需的事务包装 hunk。
- `packages/database/src/schema.ts`：选择从
  `-- M8 expand:` 开始的完整 M8 SQL block，包括 `public.digest(...)` 修复；
  不选择 35-43 的历史 block。
- `packages/contracts/src/index.ts`：只选择 `workbench-market.js` export。
- `packages/database/src/index.ts`：只选择
  `WorkbenchConfigurationRepository`、`MarketRepository`、related types。
- `packages/database/src/repositories.ts`：只选择 Workbench/Market imports、
  fields 和 constructor wiring。
- `apps/api/src/app.ts`：选择 M8 imports、workbench/market params schemas、
  application instances、error mapping、全部 `/workbenches` 与 `/market`
  routes。
- `apps/web/src/api.ts`：选择 M8 imports 和 Workbench/Market client exports。
- `apps/web/src/App.tsx`：只选择 WorkbenchView 的
  `platformAdministrator` / `viewerPrincipalId` props。
- `apps/web/src/OperationsViews.tsx`：选择 WorkbenchCard panel-data query、
  独立刷新、动态未知面板和 WorkbenchConfigurationPanel callback 适配。
- `apps/web/src/styles.css`：选择 `.workbench-*` / `.market-*` 的 M8 UI
  block及对应三档响应式规则，不选择 Shared Space、Delegation 或项目报告样式。
- `package.json`：只选择 M8 integration/E2E scripts。

以下修复属于 Core Regression / 用户原有模块，应独立提交，不并入 M8：

- `apps/api/src/identity-administration.test.ts`
- `apps/api/src/task-execution-evidence.test.ts`
- `apps/api/src/project-templates.test.ts`
- `packages/database/src/identity-administration-guards.test.ts`
- `e2e/delegation.spec.ts`
- `scripts/core-regression-e2e.sh`
- `apps/api/src/teammates.test.ts`

提交前静态审计结果：

- `git diff --check`：通过。
- 私钥/云密钥/常见 API key 扫描：只命中测试或文档中的假值，无生产凭据。
- `.pnpm-store/` 为本地依赖缓存，必须排除。
- `node_modules/`、`packages/*/lib/`、`apps/*/lib/`、`apps/web/dist/` 为生成
  产物，不应进入提交。

## 9. 隔离发布演练

使用一次性 PostgreSQL 容器完成：

1. 空库迁移 `0 -> 43`，耗时 `2.84s`。
2. 写入 Principal、Workspace、Project、Task、Run 代表性数据。
3. 创建 `pg_dump` 逻辑备份并恢复到第二个数据库。
4. 验证恢复库仍为版本 43，Task/Run 数据一致。
5. 恢复库执行 `43 -> 44`，耗时 `0.39s`。
6. 验证结果：

```text
max migration:      44
M8 tables:          13
flags:              data_fabric=off,market=off,workbench.v2=off
factory workbenches: 1
post-upgrade read:  M8 rehearsal task|completed|local-admin|true
```

该演练是本地隔离环境结果，不替代预发/生产快照上的锁时间、连接数和真实数据量
测量。
