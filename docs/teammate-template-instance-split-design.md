# AI Teammate 模版 / 实例模型拆分技术设计（含评审）

状态：设计稿 v2（已按评审意见修订，未实现代码）
范围：`dsh-collab-teammate` 为主；涉及 `dsh-collab-task` / `dsh-collab-workflow` / `dsh-collab-roles` / `dsh-collab-employee` 的契约不变更
目标：把「平台归属 / 个人归属」收敛到模版上，实例只保留 owner（创建人）与对模版的引用；修掉实例被显示成「平台」的问题

---

## 1. 结论先行

1. **模版（Template）承载定义**：`name / role / description / soul / scenarios / goals / tools`、`source(platform|personal)`、`state`、`version`、以及个人模版的 owner。
2. **实例（Instance）承载归属与执行**：`ownerUserId`（创建人，唯一归属口径）、`templateId`、实例级覆盖（`name / description / avatar`）、执行绑定（`employeeId / personaId / execution / externalRuntimeId`）、实例状态。
3. **不改主键、不改表名、不改跨模块契约**：`teammates` 表继续作为实例表（历史 id 被 Task.receiverId、AgentRun.employeeId、WorkReport.teammateId、follows/events 引用），`assignable()` / `ownerOf()` 的对外投影字段集保持不变，`source` / `ownerName` 由投影层从模版与 owner 解析。
4. **实例不再被写成「平台」**：实例只持久化 `ownerUserId`，`ownerName` 在读取时按 identity 解析；`PLATFORM_OWNER_NAME` 只保留给「无人类归属的历史数据」。
5. **一次性幂等迁移**：把现有「以实例记录充当定义」的分组关系物化成模版记录（含 `persona-<id>` 别名），迁移后 `templateId` 必填。

---

## 2. 现状（As-Is）

### 2.1 数据模型

- 表 `collab_teammate.teammates`（`teammateSchema`）：一条记录同时扮演「实例」和「定义」。
  - 归属：`source(platform|personal)`、`ownerUserId`、`ownerName`、`createdBy`
  - 定义：`name`、`role`、`description`、`soul`、`scenarios`、`goals`、`avatar`、`state`、`version`
  - 绑定：`personaId`、`employeeId`、`profileTemplateId`、`execution`、`externalRuntimeId`
- 表 `collab_teammate_profiles.profile_templates`（`ProfileTemplateService`）：平台管理员维护的「Profile 模版」资产，`applyProfile()` 是**拷贝**语义（把字段抄进实例，之后两者无关联）。
- 遗留：`collab_teammate` 域里也声明了一张 `profile_templates`，`apply()` 已不再读取它（`collab_teammate.json` 里仍留有历史数据），属于本次要收敛的重复定义之一。
- 定义态列表（客户端）按 `profileTemplateId ?? personaId ?? instance:<id>` 分组，取同组**最早创建的实例**作为「这份定义」的代表（`groupTeammateTemplates()`）。

### 2.2 权限现状（已经跑偏）

| 判定函数 | 口径 | 用在哪 |
| --- | --- | --- |
| `canManageTeammate` | personal → owner；platform → 仅管理员 | 定义编辑、状态流转（`update/changeState/applyProfile/bindEmployee`） |
| `canManageInstance`（本次新增） | 实例 owner 或管理员 | 实例资料、退出项目/角色、执行身份启停、工作日报、归档实例 |

问题：`canManageTeammate` 把「模版的平台归属」用在「实例」上——同一个字段被两种语义共用，正是这次口径混乱的根因。

### 2.3 跨模块契约（不能破）

- `collabTeammateRuntime.assignable(actor)`：返回 `{ id, name, ownerUserId, ownerName, source, avatar, employeeId }`，被 task 目录（候选人列表、任务指派）与 workflow 选人复用；task 客户端按 `source === "personal" && ownerName` 决定是否显示「名字（Owner）」。
- `collabTeammateRuntime.ownerOf(ref)`：任务回写时按 `teammate.id` 或 `employeeId` 解析实例 owner，返回 `{ userId, name }`。
- `TeammateRuntime.ensureRuntime()`：数字员工 + Agent Profile + 工作区角色 + Runtime Profile 的开通；`visibility` 与 manager 目前取自 `source`。
- roles 插件：席位 persona 采用 `persona-<teammateId>` 派生（`persona-meeting-facilitator`）。
- employee 插件：`teammate.employeeId` 指向数字员工；`role_assignments` 描述实例在项目里的角色（本次已接「角色权限」tab）。

### 2.4 问题清单（本次要解决的）

1. 实例被判成「平台归属」：列表显示「产品经理 · 平台」、平台来源实例只有管理员能动、个人 owner 无法自助。
2. 定义态拿实例当模版：多实例共享一份 persona 时，模版名是「最早创建的那个实例」，语义含糊（实测「Backend Engineer 01 → 模版：Archive Test 01（平台模版）」）。
3. `personaId` 一身兼三职：共享 persona 资产 id、`persona-<instanceId>` 别名、Profile 模版 id 的替代品。
4. `Profile 模版` 与「平台/个人模版」两套模版概念并存，定义态会出现两种来源。

---

## 3. 目标模型（To-Be）

### 3.1 实体

`TeammateTemplate`（模版，新表 `teammate_templates`）

| 字段 | 说明 |
| --- | --- |
| `id` | 稳定 id；迁移时对已有分组生成（见 5.1） |
| `source` | `platform` / `personal`，**归属只在这一层** |
| `ownerUserId` | 个人模版归属人；平台模版为空（由管理员治理） |
| `name / role / description / soul / scenarios / goals / tools` | 定义内容 |
| `state` | `active` / `disabled` / `archived` |
| `version / createdBy / createdAt / updatedAt` | 版本与审计 |
| `personaAlias` | 历史 `persona-<id>` 别名，用于 roles / employee 兼容（可空） |

`TeammateInstance`（实例，沿用 `teammates` 表与主键）

| 字段 | 说明 |
| --- | --- |
| `id` | **不变**（外部引用锚点） |
| `templateId` | 必填，指向模版 |
| `ownerUserId / ownerName` | owner = 创建人；`ownerName` 仅在读时解析，不再写入「平台」 |
| `name / description / avatar` | 实例级覆盖，缺省时取模版值 |
| `state` | `active` / `paused` / `inactive` / `archived`（实例自己的生命周期） |
| `employeeId / personaId / execution / externalRuntimeId` | 执行绑定（`personaId` 保留为对外兼容 id） |
| `createdBy / createdAt / updatedAt` | 审计 |

### 3.2 解析与覆盖规则

- 有效定义：`实例覆盖值 ?? 模版值`（`name`、`description`、`avatar` 三级覆盖；`role/soul/scenarios/goals` 只读模版）。
- 模版更新：只写模版；**不覆盖**实例已有覆盖；实例端提供「恢复为模版值」。
- 模版停用/归档：不自动改实例状态，但实例在「生效」前置校验中会因模版不可用而拒绝派发（返回明确文案）。
- 命名唯一性：模版名在 `同一 source 空间` 内唯一；实例名不做强制唯一（实例以 id 区分，展示可带 owner 后缀）。

### 3.3 权限矩阵（双层，服务端单点判定）

| 层 | 操作 | 允许者 |
| --- | --- | --- |
| 模版 | 新建 / 编辑 / 生效 / 停用 / 归档 `platform` 模版 | 平台管理员 |
| 模版 | 新建 / 编辑 / 生效 / 停用 / 归档 `personal` 模版 | 模版 owner |
| 实例 | 查看 | 现有可见性规则不变 |
| 实例 | 实例资料、归档、执行身份启停、工作日报、退出项目/角色 | **实例 owner（创建人）或平台管理员** |
| 实例 | 指派任务（`assignable`） | 模版为平台模版：全员可指派；模版为个人模版：仅实例 owner（保持现网行为，判定依据从实例 `source` 换成模版 `source`） |

---

## 4. 模块边界与接口（高内聚低耦合）

### 4.1 领域服务划分（都在 `dsh-collab-teammate` 内，同一个 bounded context）

- `TeammateTemplateService`（新）：模版 CRUD / 状态机 / 版本 / 唯一性 / `personaAlias` 解析。
- `TeammateService`（改）：实例 CRUD（创建、改名/描述、归档）、`templateId` 解析、实例状态机；**不含定义编辑**。
- `TeammateRuntime`（改）：执行身份开通、可指派投影、owner 解析、任务改派；对外接口保持不变。

### 4.2 对外投影：契约冻结（关键的低耦合手段）

其他插件只允许依赖下面两个“扁平化投影”，不得接触模版对象：

```
assignable(actor) -> { id, name, ownerUserId, ownerName, source, avatar, employeeId }[]
                      // name = 实例覆盖 ?? 模版；source/ownerName 由模版与 owner 解析
ownerOf(ref)      -> { userId, name } | undefined
```

- `source` 语义固定为「该实例所用模版的归属」，因此 task / workflow 客户端**零改动**。
- `ownerName` 语义固定为「实例创建人显示名」，由投影层用 identity 的 users 列表解析（单次请求复用一个 Map，避免 N+1）。
- 新增字段（`templateId`、`templateName`、`templateSource`）只新增不修改，供 teammate 自己的 UI 使用。
- 解析 owner 名需要一个 identity 只读端口：`TeammateRuntimeDeps` 新增**可选** `users?: () => { id, name }[]`（插件侧由 `ctx.get("collabTeam")` 注入，identity 缺席时回落 `ownerUserId`）。端口保持同步调用，因为 task 的 `directory()` 是同步拼装的——`assignable()` 不能变成 async。

### 4.3 明确不做的耦合

- 不在 task / workflow / meeting 里新增模版概念；
- 不把模版状态写回任务状态；
- 不让客户端自行推导 `source`（客户端只渲染服务端给的投影）。

---

## 5. 存储与迁移

> 存储层约束（已核对 `packages/storage` 实现与文档）：
> 1. `collab_teammate` 是 **single 布局**：整个 unit 文件头部的 `version` 必须**等于** spec 的 `version`，否则 `open()` 直接抛 `version-mismatch`（`compatibleVersions` 只对 per-record 布局生效）。
> 2. `open()` 会逐条按 `valueSchema` 校验已存记录，失败即 `invalid-record` 整体拒绝；`invalidRecords: backup-and-skip` 只对 per-record 后端可用。
> 3. 只有 spec 里声明的表会被读取，未声明的表在下次写入时被丢弃。
>
> 因此**不能用「升 domain.version + 迁移钩子」做这次改造**——插件根本没机会跑到迁移代码。

### 5.1 迁移策略（保持 domain version = 1，数据驱动、可重入）

1. 新增表 `teammate_templates`，**声明在 `collab_teammate` 域内**（与实例同文件）：迁移要「先建模版、再回填实例 templateId」，同域可让两次写入落在同一份 unit 文件里，避免跨域撕裂。
2. 实例 schema 的新字段全部声明为 `.optional()`（`templateId`、`ownerDisplayName` 等），保证旧记录仍能通过 `open()` 校验；**本版本不做任何「required 化」**。
3. 迁移逻辑放在 `apply()` 里、`open()` 之后，按数据幂等判定：所有实例都已有 `templateId` → 直接短路返回。
4. 单条处理顺序：先 `teammate_templates.put()`，再 `teammates.put(…, templateId)`；中途崩溃后重跑会跳过已迁移实例，最终收敛（不依赖全局迁移标记）。
5. 迁移前按存储层 `KvUnit.backupRecord`/既有 `.bak-*` 约定备份 `collab_teammate.json`。

### 5.2 字段清理（下一个版本再做，且必须证明升级路径）

- 本版本旧字段（`source/role/soul/scenarios/goals/version/profileTemplateId`）**只读保留**，服务端不再写入。
- 后续版本做两件事，且必须分开：(a) 从 schema 里删除废弃字段——未知字段会被 zod 剥离，不影响读取旧记录；(b) 把 `templateId` 收紧为必填——必须在确认所有记录都已迁移之后，并按仓库存储约定附带一份「上一版磁盘格式」的 fixture + 用例，证明升级路径（读兼容 / 当前版本重写 / backup-and-skip 三选一）。

### 5.3 分组物化规则

1. 读取全部实例，按 `profileTemplateId ?? personaId ?? instance:<id>` 分组。
2. 每组物化一个模版：
   - `profileTemplateId` 命中 `profile_templates` → 直接用该资产（`source="platform"`）。
   - `personaId` 形如 `persona-<instanceId>` → 模版内容取该实例当前值；`source` 取该实例现有 `source`。
   - 其它分组（共享 persona、无关联）→ 取组内最早实例的值，`source` 取该实例现有 `source`。
3. 逐实例写 `templateId`；把 `name / description / avatar` 原值保留为实例覆盖，`role/soul/scenarios/goals` 不再从实例读取。
4. 修正实例归属显示：`ownerName` 若为 `平台` 且 `ownerUserId` 是真实用户 → 以 identity 解析出的名字写入；`ownerUserId === platform` 的历史数据保持平台托管。
5. `personaId` 继续写（外部仍引用），模版侧新增 `personaAlias` 映射；roles 插件常量 `persona-meeting-facilitator` 不变。
6. 回滚：恢复备份文件即可（domain 版本未变，旧代码忽略新表）。

---

## 6. API 变更

| 方法 | 路径 | 变更 |
| --- | --- | --- |
| GET | `/api/collab/teammates` | 实例列表新增 `templateId/templateName/templateSource`，`ownerName` 改为创建人显示名 |
| POST | `/api/collab/teammates/create` | 入参改为 `{ templateId, name?, ownerUserId? }`（兼容旧 `source+name`：自动找/建对应模版） |
| POST | `/api/collab/teammates/update` | 拆成「模版更新」与「实例覆盖更新」两条语义（旧入参按字段路由） |
| POST | `/api/collab/teammates/switch-template` | 切换实例引用的模版；只更新 `templateId`，不复制定义字段 |
| GET/POST | `/api/collab/teammate-templates[/create\|update\|state]` | 新增：模版列表 / 详情 / 新建 / 编辑 / 状态流转 |
| GET/POST | `/api/collab/profile-templates*` | 删除管理接口；历史 Profile 资产只在启动迁移时转入 `source=platform` 的 AI Teammate 模版 |
| GET | `/api/collab/teammates/identity` 等 | 不变 |

---

## 7. 客户端改动

- 运行态列表：不分组（已实现）；实例名下方显示 `角色 · 创建人`（不再出现「平台」）。
- 运行态详情：显示「模版：<模版名>（平台/个人模版）」（已实现，改为直接读 `templateName/templateSource`，删掉客户端推导）。
- 定义态列表：只列模版（平台模版 / 个人模版两组），行内容为模版字段与实例数；「编辑定义」写模版。
- 实例详情新增「实例覆盖」区：名称/描述/头像 + 「恢复为模版值」。

---

## 8. 分阶段实施

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| P0 | 模版实体 + 幂等迁移 + 投影层解析 + owner 显示修复 | 迁移前后定义态分组一致；`assignable` 字段集不变；实例不再显示「平台」 |
| P1 | 定义态 CRUD 切到模版服务；实例资料/归档等全部走实例口径 | 权限矩阵用例全绿（含跨插件契约测试） |
| P2 | 实例覆盖与「恢复为模版值」；模版更新传播策略 | 覆盖优先级用例；模版改动不抹实例覆盖 |
| P3 | 清理实例上的定义字段与 `profile_templates` 双表，收敛 `personaId` 别名 | 存储表结构收敛；无遗留读取路径 |

---

## 9. 自评审（Review）

审视角：边界与契约 / 数据一致性 / 权限 / 迁移与回滚 / 可测试性。以下为发现与修订（v1 → v2）。

| # | 严重度 | 发现（v1 的问题） | 修订（v2） |
| --- | --- | --- | --- |
| R1 | 高 | v1 计划把 `teammates` 重命名为 `instances` 并改主键 | 表名与主键保持不变，只改语义；避免破坏 Task.receiverId / AgentRun.employeeId / WorkReport / follows / events 引用 |
| R2 | 高 | v1 允许 `templateId` 可空并在读取时回退 `personaId/source`，等于长期保留双口径 | 迁移期一次性物化成模版，迁移后 `templateId` 必填；旧字段只读一个版本后清理 |
| R3 | 高 | v1 在实例上持久化 `ownerName`（含「平台」），改名/离职后会陈旧 | 只存 `ownerUserId`；`ownerName` 在读投影/接口层按 identity 解析并复用 Map；修掉「平台」误显示 |
| R4 | 中 | v1 保留「Profile 模版」「平台/个人模版」两套模版 | 合并为一个模版实体（`source` 区分）；历史 Profile 资产仅由启动迁移转成 `source=platform` 的 AI Teammate 模版，Profile 管理入口、接口和独立服务全部删除 |
| R5 | 中 | v1 认为「改模版即改所有实例」，会抹掉实例级名称/描述 | 实例覆盖优先；模版更新不动覆盖项；提供「恢复为模版值」 |
| R6 | 中 | v1 只在若干路由里判权限，容易出现「某入口忘了判」 | 权限判定下沉到两个服务方法（模版层/实例层各一个），路由只做参数校验；客户端只做镜像 |
| R7 | 中 | 跨模块仍可能有人直接读 `teammate.source`（如 task 客户端） | 契约冻结：`source` 只经投影输出；为 `assignable()/ownerOf()` 增加字段集与语义契约测试 |
| R8 | 低 | `persona-<id>` 别名在模版化后断裂（roles 席位、employee persona） | 模版新增 `personaAlias` 并在迁移时补齐历史别名；`persona-meeting-facilitator` 常量保持不变 |
| R9 | 低 | 实例重名约束迁移后语义不明 | 唯一性上移到模版（同 source 空间）；实例名不强制唯一，展示带 owner 区分 |
| R10 | 低 | 迁移不可回滚 | 迁移前自动备份 + 保持 domain version 不变 + 旧字段只读保留，可整文件回滚 |
| R11 | **高** | v1 的迁移方案写「`collab_teammate` domain version 1 → 2 + 启动迁移」——实际 single 布局下 `open()` 会先抛 `version-mismatch`，迁移代码永远跑不到 | 保持 `version = 1`；新增 `teammate_templates` 表 + 实例新字段一律 optional；迁移在 `open()` 之后按数据幂等判定 |
| R12 | 高 | v1 打算把 `templateId` 直接设为必填——`open()` 逐条校验 schema，旧记录会 `invalid-record` 整体拒绝 | 本版本全部新字段 optional，迁移后再在后续版本收紧，并附旧格式 fixture 证明升级路径 |
| R13 | 中 | v1 把模版放在独立的 `profile_templates` 域——跨域写入会出现「实例指向不存在模版」的窗口 | 模版表声明在 `collab_teammate` 域内；单条迁移先写模版再回填实例，重入可收敛 |
| R14 | 中 | v1 用「迁移完成标记」判定是否重跑——标记与数据可能不一致 | 改为数据驱动幂等（全部实例都有 `templateId` 即短路），不引入全局标记 |
| R15 | 中 | v1 没说 owner 名从哪来，容易被做成 `assignable()` 里查一次 identity 的 async 调用——而 task 的 `directory()` 是同步拼装，会把契约改坏 | 通过**可选同步端口** `users()` 注入 identity，`assignable()` 保持同步；identity 缺席时回落 `ownerUserId` |

### 9.1 仍需产品确认

1. **平台模版实例的创建权限**：是否任何活跃用户都能基于平台模版创建「自己的实例」（推荐），还是延续「只有管理员能新建平台来源实例」？
2. **模版停用/归档对实例的影响**：仅阻止新派发（推荐），还是自动把实例置为 `paused`？
3. **实例名是否允许与模版名不同**：当前已支持实例改名（覆盖），确认这与「模版名唯一」不冲突。

### 9.2 已知代价

- 迁移是一次性的结构变更，需要停机窗口（本地单机约 < 1s / 20 条记录，生产按数据量评估）。
- `personaId` 双重语义只能逐步收敛，P3 之前仍需保留别名映射。
- 实例覆盖策略引入「有效值 = 覆盖 ?? 模版」的解析点，必须只在服务端投影层实现一次，避免散落到各客户端。
