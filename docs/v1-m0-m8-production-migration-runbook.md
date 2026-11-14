# M0-M8 生产迁移与回滚 Runbook

## 1. 适用范围

- 迁移范围：Migration 43 -> 44。
- 当前最高版本：44。
- 默认关闭：
  - `workbench.v2=off`
  - `market=off`
  - `data_fabric=off`
- 生产 Data Connector 安全评审继续独立阻断，不由 M8 解除。

## 2. 发布前门禁

以下条件必须全部满足：

1. 预发环境已使用接近生产规模的数据完成 `43 -> 44`，并记录耗时、锁和回填数量。
2. 已创建可恢复的生产数据库备份，并完成一次独立恢复验证。
3. 当前生产 `platform_migrations.MAX(version) = 43`。
4. 三个 Flags 均为关闭。
5. 应用部署版本与 Migration 44 对应。
6. 回滚负责人、观察负责人和数据库负责人均在线。
7. 已确认无长事务、批量导入或高写入后台任务。

若基线 GitHub Actions 仍为失败状态，必须由仓库所有者明确接受该已知基线风险；
不得把云端 CI failure 误报为已通过。

## 3. 迁移前快照

执行并保存：

```sql
SELECT MAX(version) AS migration_version
FROM platform_migrations;

SELECT flag_key, mode, revision
FROM feature_flag_settings
WHERE flag_key IN ('workbench.v2', 'market', 'data_fabric')
ORDER BY flag_key;

SELECT COUNT(*) AS active_human_principals
FROM principals
WHERE kind = 'human' AND status = 'active';

SELECT COUNT(*) AS workbenches
FROM workbenches;
```

在 43 基线中，Workbench 表可能尚不存在；对应查询应返回
`relation does not exist`，且不得被误判为迁移失败。

备份要求：

- 使用与生产恢复方案一致的 `pg_dump` 或快照方式。
- 记录备份大小、校验和、开始/结束时间和对应 Migration 版本。
- 至少抽取一张恢复库执行完整恢复验证。

## 4. 部署顺序

推荐顺序：

1. 将应用代码部署到支持 Migration 44、但三个 Flags 仍为关闭的版本。
2. 确认应用健康检查、旧 Workbench Dashboard、Task、Workflow、Meeting
   和生产 Connector 状态正常。
3. 执行 Migration：

```bash
DATABASE_URL="$PRODUCTION_DATABASE_URL" \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts
```

4. 迁移成功输出应为 `database migrations applied`；出现
   `Migration 44 failed` 时立即停止发布。
5. 立即执行第 5 节验证。
6. 保持 Flags 关闭观察至少一个稳定窗口。

## 5. 迁移后验证

```sql
SELECT MAX(version) FROM platform_migrations;

SELECT flag_key, mode
FROM feature_flag_settings
WHERE flag_key IN ('workbench.v2', 'market', 'data_fabric')
ORDER BY flag_key;

SELECT COUNT(*) FROM workbenches;
SELECT COUNT(*) FROM workbench_layouts WHERE is_factory_default;
```

通过标准：

```text
max migration = 44
data_fabric=off
market=off
workbench.v2=off
active human Principal = factory Workbench count
factory default layouts = active human Principal count
```

业务只读验证：

- Task 列表和详情可读取。
- Workflow / Task Plan 状态可读取。
- Meeting 和 Shared Space 可读取。
- 旧 Workbench Dashboard 正常。
- 生产 Connector 保持原有安全门状态。

## 6. Flag 灰度

Workbench 先于 Market：

1. 开启 `workbench.v2` 给内部管理员或小范围 Principal。
2. 验证布局保存、跨设备刷新、未知/禁用面板降级。
3. 扩大范围并观察 API 错误率、布局冲突和前端异常。
4. 单独开启 `market`。
5. 验证资产浏览、安装/卸载、entitlement 撤销和模板复制。
6. 保持 `data_fabric=off`，除非 M7 独立安全评审另行批准。

Market entitlement 不得被解释为 Project、Workspace、Data、Tool 或 Runtime 授权。

## 7. 立即止血

出现以下情况时立即关闭 Flags：

- 布局 CAS 冲突异常升高。
- Market 读写持续 5xx。
- 撤权后仍能读取旧面板数据。
- 模板复制产生持续增长的无 receipt Workbench。
- 生产业务只读路径出现回归。

Flag 关闭后：

- Workbench 写路径应返回 `workbench_v2_disabled`。
- Market 读写路径应返回 `market_disabled`。
- UI 回退到固定 Dashboard。
- 已保存配置、资产和审计数据保留。
- 不自动恢复暂停的复制或安装操作。

## 8. 回滚策略

优先级：

1. Flags 关闭。
2. 应用回退到支持 Schema 44 的上一发布版本。
3. 若 Schema 44 本身导致阻断，恢复迁移前备份。

Migration 44 没有破坏性 down migration。禁止手工删除 M8 表、版本或审计记录。
需要回退 Schema 时，必须从已验证备份恢复到新实例或隔离恢复库，再切换流量。

## 9. 发布后观察

至少观察：

- API 5xx 和延迟。
- `workbench_v2_disabled`、`market_disabled`。
- 布局 revision conflict。
- 面板 forbidden / needs_entitlement 比例。
- Market install/template-copy dedup 和失败。
- Template copy compensation audit。
- PostgreSQL 锁等待、连接数和慢查询。

## 10. 记录模板

```text
release:
operator:
started_at:
finished_at:
source_version: 43
target_version: 44
backup_id:
backup_checksum:
migration_duration:
lock_observation:
factory_workbenches:
flags_before: workbench.v2=off,market=off,data_fabric=off
flags_after:
rollback_required: no
incidents:
```
