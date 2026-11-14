# dsh-pluginmax 升级迁移启动 Prompt

> 用途：在新 Codex 窗口中直接启动 M0 + M1a 迁移
>
> 提示：以下“提示词正文”整体复制到新窗口，不要只复制标题或摘要。

## 提示词正文

你现在是 `pluginmax-platform` 的迁移实施负责人。请直接开始本轮迁移，不要停留在泛泛建议或重新做产品调研。

### 一、先阅读上下文

工作目录：

```text
/Users/oliviayang/Codex/pluginmax-platform
```

开始实施前必须完整阅读：

```text
docs/v1-dsh-pluginmax-upgrade-migration-technical-plan.md
docs/v1-dsh-pluginmax-upgrade-migration-technical-plan-review.md
```

需要查阅现有代码时，优先从以下模块开始：

```text
packages/contracts
packages/domain
packages/application
packages/database
apps/api
apps/worker
apps/web
```

外部仓库只作为行为参考，不作为实现落点：

```text
/Users/oliviayang/Codex/一切皆插件/dsh-pluginmax
```

不要修改外部仓库，不要把 DSH JSON Storage、Cordis Slot 或宿主插件安装机制复制进当前平台。

### 二、先验证迁移前备份

备份位置：

```text
/Users/oliviayang/Codex/backups/dsh-migration-preflight-20261113-105957
```

第一步执行：

```sh
cd /Users/oliviayang/Codex/backups/dsh-migration-preflight-20261113-105957
LC_ALL=C LANG=C shasum -a 256 -c SHA256SUMS
```

要求：

- 所有校验项必须为 `OK`。
- 备份目录是只读迁移前快照，严禁修改、解冻、重写或删除。
- 如果校验失败，立即停止实施并报告，不得继续写代码。
- 备份中存在两个项目的完整工作区、未提交修改、未跟踪文件和 Git bundle；需要核对恢复方法时阅读备份目录中的 `RESTORE.md`。

### 三、保护当前工作区

当前仓库可能包含用户已有未提交改动。开始前执行：

```sh
git status --short
git branch --show-current
git rev-parse HEAD
git diff --stat
```

严格要求：

- 不得执行 `git reset --hard`、`git checkout --`、清理未跟踪文件或其他回退用户改动的命令。
- 不得为了让实现方便而覆盖、删除或重写已有未提交内容。
- 遇到与迁移直接冲突的用户改动时，先理解并兼容；只有确实无法安全继续时才向用户说明具体冲突。
- Migration 编号必须基于当前实际最高版本顺延，先检查工作区中是否已有 33/34 或其他未提交 Migration。

### 四、本轮范围

本轮只实施：

```text
M0  契约冻结与实施清单
M1a 分层执行判定、异常生命周期、验收证据闭环、autoSubmit/autoAccept 兼容
```

本轮不要实施：

```text
M1b 工作区文件写工具，除非 M1a 完成且所有退出门已通过
M2 模板作用域与实例绑定
M3 Router 动态计划
M4-M8 所有路线图能力
```

不要新增 `abnormal` TaskStatus。异常使用独立活动记录和派生 `executionHealth`。

不要引入第二套 Router DAG、Skill、Data Agent 或 Workbench 存储。

### 五、M0 必须产出

在开始业务代码前，先完成并记录：

1. 当前 Contracts、Database、Application、API、Worker 的相关事实源和调用链。
2. M1a 的精确变更清单，包括文件、表、接口、事件和 Feature Flag。
3. 需要新增的 Contract、错误码、兼容字段和状态投影。
4. 必须覆盖的负向用例，至少包括：
   - 预检后撤权；
   - 派发前角色或 Runtime 变化；
   - A 资源 Ticket 用于 B 资源；
   - 验收项只确认一部分；
   - 使用旧 Run 或旧 acceptance revision 证据；
   - Agent 尝试批准自己的任务；
   - `autoSubmit=true` 但证据不完整；
   - `autoAccept=true` 绕过 Review。

如果发现现有代码与方案假设不一致，以仓库事实为准，先修正方案中的局部设计和 Migration 顺序，再实施。

### 六、M1a 实施要求

#### 1. 分层执行判定

不要把授权、派发适配性和单次动作门禁压缩成一个可缓存布尔值。至少区分：

- `Authorization`
- `DispatchEligibility`
- `ActionDecision`

Gate 结论只对当次 action、resourceId、Run 和 Principal 有效，不得跨请求复用。

预检结果是候选结论。实例启动、节点派发和每次受保护动作前必须重新校验。

#### 2. 执行异常

- 保持现有 TaskStatus 不变。
- 一个 Task 可同时有多个活动异常。
- 活动异常按 task + run + code 唯一。
- 清除异常保留历史，不物理删除。
- `executionHealth` 必须由活动异常和验收状态投影，不作为独立可编辑事实。
- 恢复执行按 Run attempt 清理对应异常，不能一键清空全部历史。

#### 3. 验收证据

- 所有 required 验收项都必须有有效确认。
- 为 acceptance item 建立稳定 ID、position、revision、contentDigest 和 required 标记。
- 验收内容或 revision 变化后，旧 confirmation 失效并 superseded。
- evidenceRefs 必须类型化并由服务端验证归属：artifact、tool-event、run-output、external-resource。
- 只接受当前有效 owner Run；collaborator Run、旧 Run、失败 Run 和 superseded Run 不能作为当前证据。
- Agent 执行确认不等于 Review 批准。
- Agent 不能批准自己的任务。

#### 4. 自动提交与自动验收兼容

- `autoSubmit=true` 且 required 证据完整时，才允许进入 Review。
- required 证据不完整时，保持 `in_progress` 并记录 anomaly。
- `autoAccept=true` 不得绕过证据和独立 Review。
- 如保留自动通过例外，必须由独立项目策略授权、指定不同主体并写审计。
- `task.evidence_review=observe` 只做影子判定，不写确认事实、不改变状态。

#### 5. Migration 与 Feature Flag

- 使用 additive migration。
- 顺序必须是 expand -> backfill / validate -> enforce constraints -> enable。
- 新列先 nullable 或安全默认值。
- 新唯一约束前先做存量冲突预检。
- 验证空库升级、当前工作区实际 Migration 快照升级、旧应用读取新 Schema。
- 所有 Feature Flag 默认关闭；`task.evidence_review` 默认 observe。
- 关闭 Flag 时必须停止新副作用，不能只隐藏 UI。

### 七、测试与验收

必须补充 Contract、PostgreSQL integration、Application、API 和必要的 GUI/E2E 测试。

最低通过场景：

```text
G1 预检后撤权，派发拒绝
G2 Runtime 降级，安全停点
G3 跨资源 Ticket，拒绝
G4 required 验收项不完整，不进入 Review
G5 旧 Run 或旧 revision 证据，拒绝
G6 Agent 自批，拒绝并审计
G7 autoSubmit 无完整证据，保持 in_progress 并记录 anomaly
G8 autoAccept 无证据，不允许 Done
G12 空库升级、当前快照升级、旧应用兼容
```

实施后至少运行：

```sh
pnpm typecheck
pnpm test
pnpm lint
pnpm build
```

如全量门禁耗时或受环境阻塞，先运行最相关的聚焦测试，再如实报告未执行项和原因，不能宣称未运行的测试已通过。

### 八、交付方式

完成后输出：

1. 实际完成范围和非目标。
2. 修改的文件、Contract、Migration、API 和 Feature Flag。
3. 每个 G 门禁场景的测试结果。
4. 与方案不一致或需要用户确认的工程决策。
5. 当前 Git 状态和未触碰的用户改动。
6. 可继续进入 M1b/M2/M3 的条件。

现在开始执行：先验证只读备份和当前 Git 状态，再完成 M0 实施清单并直接进入 M1a。
