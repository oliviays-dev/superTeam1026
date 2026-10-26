# V1 Batch 11A: Workbench and Project Reports

> 分支：`feat/v1-batch11a-workbench-reports`
>
> 基线：`50be1714aa87261115213c0ef6a74241453d7829`
>
> Migration：17

Batch 11A 在 Batch 10B 的会议、Memory、Handoff 和 Episode 契约之上增加项目日报与
工作台聚合。Migration 17 只新增表、索引和不可变触发器，不改写 Batch 9 的备份、trace
关联列，也不修改 Batch 10A/10B 的既有表结构。

## 11A1. Project Reports

项目日报按项目、日期和稳定内容哈希持久化：

- 同一项目、日期和内容只产生一个版本。
- 数据变化后再次刷新会生成递增的新版本，旧版本不可修改或删除。
- 生成事务使用项目/日期 advisory lock，并由
  `(project_id, report_date, content_hash)` 唯一约束兜底并发刷新和 Worker 重试。
- 日报汇总任务、Run、Review、工作流、已发布会议纪要、会议行动项、Memory Topic 和
  Current Truth。
- 每个事项保留来源引用；读取时重新检查来源是否存在，已删除来源标记为不可用。
- 已读状态按 `(report_id, actor_id)` 独立保存。
- 归档项目仍可由活动成员读取历史，但禁止生成新版本。

```text
GET  /api/v1/projects/:projectId/reports
POST /api/v1/projects/:projectId/reports/generate
GET  /api/v1/projects/:projectId/reports/:reportId
POST /api/v1/projects/:projectId/reports/:reportId/read
```

项目详情新增“项目日报”页签，提供日期、关键词、版本历史、已读、生成时间、来源回查、
loading、empty、error 和归档只读状态。

## 11A2. Workbench

每日简报按读者、日期和稳定内容哈希持久化。简报聚合：

- 项目日报结论、风险和下一步；
- 当前待办；
- 会议结论；
- 运行异常；
- 持久化供给例外；
- 持久化供应商风险。

刷新失败不会删除历史简报；前端保留 React Query 上一次成功数据。更新频次按读者保存，
支持每天 08:00、每天 08:00/13:00、每 4 小时和每周一 08:00。

```text
GET   /api/v1/workbench/dashboard
GET   /api/v1/workbench/brief
POST  /api/v1/workbench/brief/refresh
POST  /api/v1/workbench/brief/:briefId/read
GET   /api/v1/workbench/brief/settings
PATCH /api/v1/workbench/brief/settings
GET   /api/v1/workbench/follows
POST  /api/v1/workbench/follows
GET   /api/v1/workbench/supply-exceptions
POST  /api/v1/workbench/supply-exceptions
GET   /api/v1/workbench/supplier-risks
POST  /api/v1/workbench/supplier-risks
```

关注覆盖优先级为：

1. 直接关注任务；
2. 直接关注工作流；
3. 工作流覆盖其派发任务；
4. 项目覆盖其任务和工作流；
5. 不关注。

同一对象只展示最高优先级来源。任务和工作流详情均提供星标关注/取消关注。

## Database

Migration 17 新增：

- `project_reports`、`project_report_sources`、`project_report_reads`；
- `workbench_briefs`、`workbench_brief_reads`、`workbench_brief_settings`；
- `workbench_follows`；
- `supply_exceptions`、`supplier_risks`。

项目日报和工作台简报均由触发器拒绝更新和删除，历史不可变。

## Validation

```bash
pnpm check
TEST_DATABASE_URL=... pnpm test
pnpm test:smoke:workbench-reports-postgres
pnpm test:smoke:workbench-reports
pnpm exec playwright test e2e/workbench-reports.spec.ts
git diff --check
```

定向集成测试覆盖重复生成、并发刷新、跨项目、越权、归档项目、空数据、删除来源、
关注覆盖、已读状态和真实供给/供应商风险数据。
