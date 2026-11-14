# dsh-pluginmax 升级迁移 M6 实施记录

> 阶段：Project PM、AI PM 幂等初始化、项目日报/周报/进度报告
> 日期：2026-11-13
> 仓库：`pluginmax-platform`
> 实施基线：`main@5b7f7f5bc179ca0435c96126a950e7b3605847f4`
> Migration：41 -> 42

## 1. 范围与边界

本轮只实施 M6，未实施 M7-M8，也未回头扩展 M5。

- 复用 Project Role、Project Member、Principal/Grant，不建立第二套权限。
- 复用 AI Teammate、Agent、Skill Installation/Binding、Run Skill Snapshot。
- 复用项目、任务、Workflow、交付物、风险等现有事实表。
- 复用 `project_reports` 作为报告唯一事实源，不新增 QueryRun、Task 或 Report 副本。
- 默认关闭 `project.ai_pm`；Skill 依赖仍受 `skills.platform` 控制。
- 未修改外部 `dsh-pluginmax` 仓库和迁移前只读备份。

## 2. Contract

新增：

- `packages/contracts/src/project-operations.ts`
  - `project.ai_pm` Feature Flag。
  - `ProjectAiPmStatus = provisioning | ready | failed`。
  - `ProjectAiPm` 引用 Project Role、Project Member、Agent、AI Principal、
    Teammate、Template、Skill Installation/Binding 和 Runtime Profile。
  - `ProvisionProjectAiPmInput` 与幂等初始化结果。

扩展：

- `packages/contracts/src/workbench-reports.ts`
  - `reportKind = daily | weekly | progress`。
  - `triggerSource = manual | schedule | api | system | legacy`。
  - Report period、generated principal、Run、Skill version/digest、
    trigger source、source digest、source cutoff。
  - 结构化事实包：
    - Project 状态、Owner、开始时间和目标结束时间。
    - 进度百分比、任务总数、完成数、状态分布。
    - Task、Workflow、交付物、风险。
    - 每个 source ref 的 cutoff。
- `packages/contracts/src/platform.ts`
  - Run Input Snapshot 增加 `projectReport` 上下文。

## 3. Migration 42

文件：

- `packages/database/src/schema.ts`
- `packages/database/src/migrate.ts`

Migration 42 严格按 expand -> backfill/validate -> enforce -> enable：

1. Expand
   - 新增 `project_ai_pms`。
   - 扩展 `project_reports`：
     `report_kind`、`period_start`、`period_end`、
     `generated_by_principal_id`、`run_id`、`skill_id`、`skill_version`、
     `skill_digest`、`trigger_source`、`source_digest`、
     `source_cutoff_at`。
   - 扩展 `project_report_sources.cutoff_at`。
2. Backfill
   - 存量 Report 默认 `report_kind=daily`。
   - 按上海时区回填当日 period。
   - `generated_by_principal_id` 按存量 `generated_by` 回填。
   - 存量 `source_digest=content_hash`、`trigger_source=legacy`。
   - 存量 source cutoff 回填为 Report `generated_at`。
3. Validate
   - 校验 `(project_id, report_kind, report_date, version)` 无冲突。
   - 校验 `(project_id, report_kind, report_date, content_hash)` 无冲突。
4. Enforce
   - 新唯一约束：
     `(project_id, report_kind, report_date, version)`。
   - 新唯一约束：
     `(project_id, report_kind, report_date, content_hash)`。
   - `project_ai_pms.project_id` 主键、Agent Principal、Agent、Teammate、
     Template 和 Runtime Profile 唯一。
   - 重建 `project_reports_immutable` trigger。
5. Enable
   - `project.ai_pm=off`，不随 Migration 自动开启。

`project_ai_pms` 保存 provisioning / ready / failed、失败原因、revision 和各资源引用，
用于 projectId 稳定幂等键与可重试状态，不承载额外授权事实。

## 4. AI PM 初始化

实现：`packages/database/src/project-ai-pm-repository.ts`

初始化在单个事务内按 projectId advisory lock 串行化，并创建或复用：

- Project Role `PROJECT_PM`，权限固定只允许 `read`、`write`。
- Project Member，复用 Project Role 和 Grant 同步。
- 唯一 AI Agent Principal、Agent、Project-scoped Teammate。
- protected Teammate Template 与固定版本。
- `project-reporting` protected official Skill。
- Skill Installation 与 required Template Binding。
- 唯一 Runtime Profile 引用；支持 builtin Fake Profile 或显式 external Runtime。

失败处理：

- 核心 Project 创建事务先提交。
- AI PM 初始化在独立事务进行，失败不回滚 Project。
- 失败写入 `project_ai_pms.status=failed`、`last_error` 和
  `project.manager.provision_failed` 审计。
- 同一 projectId 重试成功后转为 `ready`。
- `project.ai_pm=off` 时不创建 PM 状态或写失败审计。

## 5. 报告生成

实现：

- `packages/database/src/workbench-reports-repository.ts`
- `packages/application/src/index.ts`

生成链路：

```text
trigger
  -> 校验 project.ai_pm / Project 权限
  -> ensure AI PM
  -> 构建项目事实包
  -> 在现有 runs 创建无 Task 的 completed Run
  -> captureRunSkillSnapshotWithClient 固化 Project Reporting Skill 版本
  -> 从 Run Skill Snapshot 提取 skill version/digest
  -> 写不可变 project_reports
  -> 写 project_report_sources
  -> 写 project.report.generated 审计
```

约束：

- daily / weekly / progress 使用相同事实源，但唯一键包含 `report_kind`。
- 同一 project + kind + date 使用 advisory lock 和唯一约束收敛版本。
- Report 固化 `run_id`、`skill_id`、`skill_version`、`skill_digest`、
  `source_digest` 和 `source_cutoff_at`。
- 历史 Report 不按新 Skill、Policy 或事实重写。
- Feature Flag 关闭时 Report 保留旧兼容路径，不自动创建 AI PM 或 Run。

## 6. API、UI、Feature Flag 与审计

API：

```http
GET  /api/v1/projects/:projectId/ai-pm
POST /api/v1/projects/:projectId/ai-pm
GET  /api/v1/projects/:projectId/reports?reportKind=daily
POST /api/v1/projects/:projectId/reports/generate
```

Report 生成输入兼容原 `reportDate`，新增：

```text
reportKind
periodStart
periodEnd
triggerSource
```

Web：

- Project Report 面板支持日报、周报、进度报告选择。
- 展示 AI PM ready/failed 状态。
- failed 状态提供图标重试入口。

Feature Flag：

```text
project.ai_pm=off
skills.platform=off
```

AI PM 初始化要求 M6 Flag 开启，同时遵守 M4 `skills.platform` 依赖。

审计事件：

```text
project.manager.provisioned
project.manager.provision_failed
project.report.generated
```

## 7. 测试结果

M6 Migration：

```text
./scripts/m6-migration-vitest.sh
fresh_migration=0->42
upgrade_migration=41->42
flag=project.ai_pm=off
legacy_backfill=daily|true|true|local-admin|legacy|true|true
old_app_read=2026-11-12|1|local-admin
old_app_write=daily|manual|true|true
constraint_conflicts=0
```

M6 Project PM / Report PostgreSQL：

```text
./scripts/m6-project-operations-vitest.sh
Test Files  1 passed
Tests       7 passed
```

覆盖：

- PM Role 不扩大成员管理权限。
- AI PM 并发/重复初始化只创建一个实例。
- AI PM 失败不回滚 Project，审计后可重试。
- daily / weekly / progress 并存。
- Report 版本并发只生成一个版本。
- Report 挂接 Run 与 Skill Snapshot。
- Skill v1 -> v2 后旧 Report 保持 v1。
- source refs 与 cutoff 可追溯。
- 历史 Report UPDATE 被数据库拒绝。

全仓门禁：

```text
CI=true pnpm typecheck  pass
CI=true pnpm test       pass
CI=true pnpm lint       pass
CI=true pnpm build      pass
```

全仓 Vitest（无 `TEST_DATABASE_URL`）：

```text
Test Files  39 passed | 48 skipped (87)
Tests       201 passed | 207 skipped (408)
```

Teammates PostgreSQL 既有失败已实际复跑，仍然存在：

```text
./scripts/teammate-vitest.sh
apps/api/src/teammates.test.ts:442
expected statistics.runCount=1, received 0
Test Files  1 failed | 13 passed
Tests       1 failed | 46 passed
```

该失败未在 M6 修改，也未声明为 M6 已修复。

## 8. 未执行项与剩余风险

- 未实施 M7 Data Fabric/Data Agent 和 M8 Workbench V2/Market。
- M6 Report 使用同步事实包生成和已完成 Run 固化 Skill 追溯；尚未把报告生成
  切到 Worker 中的真实模型调用。
- external Runtime Profile 初始化已接入，但 M6 未提供完整 Runtime 配置页面。
- Project PM 只有状态查看和失败重试入口，未新增完整 PM 管理页面。
- `project.ai_pm` 开启前仍需目标环境显式开启 `skills.platform`，并记录发布
  actor、revision、观察窗口和回滚计划。
- Teammates 既有统计失败仍需修复或由负责人正式豁免。

## 9. 进入 M7 条件

- 保持 Migration 42 只读，不在后续阶段改写 42。
- 先在目标环境关闭 `project.ai_pm` 发布，再按项目显式开启。
- 确认 AI PM 初始化审计、失败重试和 Skill Snapshot 观察结果。
- 明确 Report 生成是否需要从同步事实包升级为 Worker 模型执行。
- 处理或正式豁免 Teammates 既有周报统计失败。
- M7 不得复用 Project Report 作为 QueryRun/QueryResult 或 Data Fabric 事实源。
