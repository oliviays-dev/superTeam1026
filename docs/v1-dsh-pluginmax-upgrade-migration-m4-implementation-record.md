# dsh-pluginmax 升级迁移 M4 实施记录

> 阶段：M4 Skill 能力资产
> 日期：2026-11-13
> 仓库：`pluginmax-platform`
> 实施基线：`main@5b7f7f5bc179ca0435c96126a950e7b3605847f4`
> 迁移基线：M3 最高版本 39

## 1. 实施前核对

```text
branch: main
HEAD:   5b7f7f5bc179ca0435c96126a950e7b3605847f4
Migration max before M4: 39
Migration used by M4: 40
```

工作树包含 Shared Space、Human Avatar Delegation、Identity Hardening、
M1-M3 等既有未提交修改和未跟踪文件。本轮未执行 `git reset --hard`、
`git checkout --`、`git clean`，未清理未跟踪文件，也未修改外部
`dsh-pluginmax` 仓库或迁移前只读备份。

## 2. Contract

新增 `packages/contracts/src/skill.ts`：

- `SkillDefinition`
- `SkillVersion`
- `SkillInstallation`
- `TeammateTemplateSkillBinding`
- `TeammateInstanceSkillExtension`
- `EffectiveSkill`
- `EffectiveSkillsProjection`
- `RunSkillSnapshot`
- `SkillAuditEvent`
- `SKILLS_PLATFORM_FLAG = "skills.platform"`
- `PLATFORM_SKILL_SAFETY_RULES`
- `canonicalSkillJson`
- `skillVersionDigestPayload`

Skill Version 固定包含：

```text
publisherPrincipalId
trustLevel: official | verified | private
instructions
manifest
permissions
triggers
status: published | deprecated | revoked
protected
digest
```

版本 digest 使用规范化 JSON 的 SHA-256。对象键顺序不影响 digest；版本号、
publisher、trust、正文、manifest、permissions、triggers、status 和
protected 任一变化都会产生不同 digest。

## 3. Migration 40

Migration 40 位于 `packages/database/src/schema.ts` 的
`M4_SKILL_PLATFORM_SCHEMA_SQL`，由 `packages/database/src/migrate.ts`
注册为最高版本 40。

新增表：

```text
skill_definitions
skill_versions
skill_installations
teammate_template_skill_bindings
teammate_instance_skill_extensions
run_skill_snapshots
skill_audit_events
```

关键唯一约束：

- `UNIQUE(skill_id, version)`、`UNIQUE(skill_id, digest)`。
- `UNIQUE(principal_id, skill_id)` on installations。
- `UNIQUE(template_id, skill_id)` on template bindings。
- `UNIQUE(teammate_id, skill_id)` on instance extensions。
- `run_skill_snapshots.run_id` 主键。
- Skill Audit 使用 identity `seq`，资源历史 append-only。

不可变与保护约束：

- `skill_versions` trigger 禁止 UPDATE / DELETE。
- `run_skill_snapshots` trigger 禁止 UPDATE / DELETE。
- required template binding 禁止删除，禁止改为 disabled、变更 Skill ID
  或变更 Template ID。
- required binding 对应的 installation 禁止 disabled / DELETE。
- instance extension trigger 禁止与 required template Skill 同 ID。
- `skill_audit_events` trigger 禁止 UPDATE / DELETE。

Migration 顺序：

1. Expand：创建表、索引和默认 Flag。
2. Backfill / validate：不伪造历史 Run Snapshot，只校验 Definition
   current version 一致性。
3. Enforce：创建不可变、required 和 append-only trigger。
4. Enable：`skills.platform=off`，由独立发布操作开启。

## 4. Feature Flag

```text
skills.platform=off
```

关闭时：

- 停止新 Definition/Version/Installation/Binding/Extension 写操作。
- 已存在 Binding 仍可用于新 Run 的 Snapshot 固化。
- 已有 Run Skill Snapshot 保持可读且不可变。
- 不删除表、Binding、Installation 或历史 Snapshot。

## 5. Application 与 API

新增 `packages/application/src/skills.ts` 和
`packages/database/src/skill-repository.ts`。

新增 API：

```http
GET    /api/v1/skills
POST   /api/v1/skills
GET    /api/v1/skills/:skillId
POST   /api/v1/skills/:skillId/versions
GET    /api/v1/skills/:skillId/audit
GET    /api/v1/skill-installations
POST   /api/v1/skill-installations
DELETE /api/v1/skill-installations/:installationId
GET    /api/v1/teammate-templates/:templateId/skills
POST   /api/v1/teammate-templates/:templateId/skills
DELETE /api/v1/teammate-templates/:templateId/skills/:bindingId
GET    /api/v1/teammates/:teammateId/skills
POST   /api/v1/teammates/:teammateId/skills
DELETE /api/v1/teammates/:teammateId/skills/:extensionId
GET    /api/v1/runs/:runId/skills
```

授权规则：

- Installation 必须由活跃 human Principal 完成。
- Official / verified / protected Skill 只能由平台管理员发布。
- Private Skill 只有 publisher 或平台管理员可发现、安装和读取正文。
- Template Binding 要求目标 Template `write` 管理权，以及 Binding
  actor 对精确 Skill Version 的 active Installation。
- Instance Extension 要求目标 Teammate `write` 管理权，并要求 actor
  对精确 Skill Version 的 active Installation。
- Skill 不扩大 Project、Workspace、Runtime 或 Tool 授权。

## 6. Effective Skills

解析顺序：

```text
required template skills
  -> enabled default template skills
  -> enabled instance extension skills
```

规则：

- 按 Skill ID 去重。
- 同一 Skill ID 保留最高来源优先级。
- Snapshot Entry 保留来源层、Version ID、version、digest 和 protected。
- 每个 Effective Skill 固定输出 `grantsAuthorization=false`。
- revoked Version 不进入新的 Effective Snapshot。
- required Binding 不受 Instance Extension 停用或影子替换影响。

平台安全规则固定写入 Snapshot：

```text
skill.no_secret
skill.no_authorization
skill.append_only
```

Application 拒绝：

- `apiKey`、`token`、`password`、private key 等凭证字段或明显 secret 值。
- manifest 中 `safetyRules`、`systemPrompt`、`authorization`、
  `permissionsOverride` 等保留字段。
- required binding 使用 `enabled=false`。

## 7. Run Skill Snapshot

Run 创建事务内写 `run_skill_snapshots`：

- Task / AI Teammate Run。
- Direct Chat Run。
- Meeting AI Run。

Snapshot 固化：

```text
runId
teammateId
templateId
templateVersionId
platformSafetyRules
effective skills
snapshotDigest
capturedAt
```

历史 Run 不按最新 Skill 重新解析。Skill 升级只影响之后创建的 Run。
Migration 40 不为 M4 之前的 Run 回填伪造 Snapshot。

## 8. 审计

新增 `skill_audit_events`：

```text
skill.definition.created
skill.version.published
skill.installed
skill.uninstalled
skills.bound
skills.unbound
skills.extension.added
skills.extension.removed
run.skills.snapshot
```

Audit 记录 actor Principal、resource、kind、summary、data 和创建时间。
Run Snapshot 的 actor 从 Run initiated / Agent Principal 反查，不接受
客户端自报 system actor。

## 9. 测试结果

M4 Migration：

```text
./scripts/m4-migration-vitest.sh
fresh_migration=0->40
upgrade_migration=39->40
skills_flag=off
historical_run_snapshots=0
legacy_read=completed|{}
```

M4 Skill Resolution：

```text
./scripts/m4-skill-resolution-vitest.sh
Test Files  2 passed
Tests       8 passed
```

覆盖：

- Version digest 稳定与 UPDATE/DELETE 不可变。
- 未安装 Skill 无法绑定。
- Private Skill 无权安装、读取正文或出现在 Catalog。
- Skill 安装不授予 Project 访问权。
- required Binding 无法删除、禁用或被 Extension 影子替换。
- Extension 不能携带安全覆盖字段。
- required / default / extension 多来源按 Skill ID 去重和优先级解析。
- 并发 Installation 与 Binding 幂等。
- Audit 可查询。

M4 Run Snapshot：

```text
./scripts/m4-run-snapshot-vitest.sh
Test Files  1 passed
Tests       3 passed
```

覆盖：

- Run 创建事务内固化 Effective Skills。
- Skill v1 -> v2 后新 Run 使用 v2。
- 历史 Run 仍保持 v1 instructions/digest。
- Snapshot UPDATE / DELETE 被数据库拒绝。

历史 Migration 回归：

```text
./scripts/m1a-migration-vitest.sh  pass 34->40
./scripts/m1b-migration-vitest.sh  pass 36->40
./scripts/m2-migration-vitest.sh   pass 37->40
./scripts/m3-migration-vitest.sh   pass 38->40
```

M3 行为回归：

```text
./scripts/m3-plan-materialization-vitest.sh
Test Files  2 passed
Tests       15 passed

./scripts/m3-router-reconciler-vitest.sh
Test Files  1 passed
Tests       1 passed
```

Run 创建旁路回归：

```text
Direct Chat focused: 1 file / 7 tests passed
Meeting AI focused: 1 file / 5 tests passed
```

全仓门禁（无 `TEST_DATABASE_URL`）：

```text
CI=true pnpm typecheck  pass
CI=true pnpm test       pass
CI=true pnpm lint       pass
CI=true pnpm build      pass
```

全仓 Vitest：

```text
Test Files  39 passed | 44 skipped (83)
Tests       201 passed | 191 skipped (392)
```

Teammates PostgreSQL 既有失败已实际复跑，仍然存在：

```text
./scripts/teammate-vitest.sh
apps/api/src/teammates.test.ts:442
expected statistics.runCount=1, received 0
Test Files  1 failed | 13 passed
Tests       1 failed | 46 passed
```

该失败未在 M4 修改，也未声明为 M4 已修复。

## 10. 剩余风险

- `skills.platform` 默认关闭；开启前仍需完成目标环境观察和发布审计。
- M4 只固化并暴露 Effective Skills，Runtime Prompt 消费 Snapshot 的接入
  属于后续执行层集成，不在本轮伪造为已实现。
- M4 之前创建的 Run 没有 Snapshot，按历史兼容策略保持为空，不事后猜测
  当时加载的 Skill。
- Skill secret 检测是结构化字段和明显 token/private-key 模式的保守拦截，
  不能替代发布方人工安全审查。
- Private Skill 当前以 publisher 和平台管理员为可见范围；Workspace/Team
  级共享需要后续独立 entitlement 评审。
- Project Report 的 Skill/version/digest 字段属于 M6 路线，本轮不扩展。
- M3 Router 既有风险仍保留；M4 未扩展 M3 Plan/Reconciler。

## 11. 进入 M5 条件

- `skills.platform=off` 的发布迁移和 N/N-1 应用启动验证完成。
- 目标环境显式开启 Flag，并记录启用 actor、revision 和回滚计划。
- Runtime/Worker 明确从 `run_skill_snapshots` 读取 Skill，而不是重新解析
  最新 Binding。
- Private Skill 的可见范围和 Workspace 共享策略完成产品确认。
- Teammates 既有周报统计失败修复，或由负责人正式豁免。
- 不修改 Migration 37/38/39/40，不把 Skill Version、Installation 或
  Snapshot 复用到 M5-M8 的其他事实域。
