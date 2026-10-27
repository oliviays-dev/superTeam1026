# Pluginmax Platform V1：Batch 13 后续迁移路线图

> 状态：Batch 13.1A、13.1B、14A-18 已完成；下一正式批次为 Batch 19
>
> Batch 15B 基线（15A HEAD）：`7a2643ec78ceca768ec25893e353f77c62aa1ed0`
>
> 分支：`feat/v1-batch15b-action-ticket-gate`
>
> 初始路线图基线：`bc7f55b651737c34ea288b8ad2adf3c51bf3a6ea`
>
> 最后更新：2026-10-27

## 1. 文档目的

本文统一后续迁移范围、依赖顺序、技术边界、迁移策略和发布门禁，作为 Batch 14
以后的工作清单。原则是迁移能力与契约，不按旧插件目录做 1:1 平移，尤其不迁移
DSH Shell、Slot、JSON Storage 和旧 Employee 页面。

Batch 13 已通过发布门禁，当前没有已知 P0/P1 缺陷。详细证据见
[v1-batch13-release-gate.md](./v1-batch13-release-gate.md)。

## 2. 当前 V1 事实与缺口

### 2.1 已有能力

- Task、Workflow Task、Meeting AI、Direct Chat 共用 Run、Job、Outbox、Worker、
  Runtime Effect、Trace 和 ContextPack 执行面。
- Fake、DSH SDK、`codex-jsonl`、`plain-text` Runtime 均通过 Worker 执行。
- Runtime 注册、Probe、Capability、Binding、Preflight、取消、超时和审计已落地。
- 项目成员、项目角色、Memory、Handoff、Episode、Meeting Minutes、Direct Chat、
  项目模板、日报和 Workbench Brief 已落地。
- Migration 23、完整 Vitest、完整 Playwright、`pnpm check` 已通过。
- Batch 14A-14D 已完成 Principal、Bearer Session、Project RBAC、读授权闭环
  和 Project Capability；Migration 24 已落地。
- Batch 15A 已完成版本化 TaskExecutionPolicy、统一 Preflight、Run Execution
  Envelope 与 Worker 快照复核；Migration 25 已落地。
- Batch 15B 已完成版本化 Action Ticket、blocking/non-blocking Execution Gate、
  approve/reject/timeout/cancel、Worker 复核与幂等 usage；Migration 26 已落地。
- Batch 16 已完成 Task、Workflow Node、Meeting、Direct Chat 的统一 Scene
  Session Binding、Contribution、Chat Channel、增量 Cursor、确定性 Receipt
  和重放；Migration 27 已落地。
- Batch 13.1A 已冻结 Runtime 兼容契约：WorkBuddy 只使用通用 `plain-text`，
  Prompt 走 stdin，不实现专用 stream-json、Provider Session 或工具流解析。
- Batch 18 已完成 Meeting Facilitator、Delegate、私密嘱咐、投递、文件、
  Minutes 确认、Meeting Task、归档与恢复；Migration 31 已落地。

### 2.2 主要缺口

| 缺口 | 当前状态 | 影响 |
| --- | --- | --- |
| 身份认证 | 已完成 14B：Bearer Session；Bearer 模式不接受客户端 actor Header 回退 | 生产认证边界已建立 |
| Principal 统一 | 已完成 14A/14C/14D：Human/AI Principal、alias、Grant、读授权和 Capability 已统一消费 | 后续迁移主要是历史字段 backfill 和执行授权 |
| RBAC 消费 | 已完成 14C/14D 的主门禁和读授权；进入 15A 前审计 Application 残留 owner-only 二次门禁 | 防止 Route Grant 与 Application 门禁语义不一致 |
| TaskExecutionPolicy | 已完成 15A：持久化 revision、统一 Preflight 和不可变 Run Envelope | 任务级 Runtime、工具、来源和预算已进入执行快照 |
| Action Ticket / Gate | 已完成 15B：持久化 Ticket、Gate、不可变决策与 Worker 门禁 | 高风险动作具备可校验、可过期和可审计的执行边界 |
| Scene Context | 已完成 16：四类 Scene Session、Contribution、Channel、Cursor 和 Receipt 已统一 | 场景隔离、确定性重放和来源追溯已建立 |
| Task / Teammate 深度 | 基础任务、AI 伙伴和 Worker 已有，工作队列、输入等待和自动执行深度不足 | 无法承接旧 Teammate 的完整工作流 |
| Meeting Collaboration | Batch 18 已完成 Facilitator、Delegate、私密嘱咐、投递、文件、Minutes 确认、Meeting Task、归档与恢复 | 会议协作闭环已建立 |
| Shared Space | 尚无工作区共享路径、写审批、Locks 和文件审计 | 不能安全开放 Agent 文件写 |
| Legacy Closeout | 尚无统一迁移台账、dry-run 和 alias 清理计划 | 后续容易出现双主体和旧存储依赖 |

## 3. 迁移原则

1. **先身份与授权，再执行安全，再上下文与协作体验，最后治理和兼容收口。**
2. V1 PostgreSQL 是业务事实来源；旧 JSON Storage 只作迁移来源，不作为运行时依赖。
3. Principal 是授权和追责主体；Employee、Teammate、Auth User 只作产品入口或兼容别名。
4. 默认拒绝，deny-wins；Task Policy、Runtime Capability、Principal Grant 和项目权限取交集。
5. 已启动 Run 使用不可变策略、身份和上下文快照，后续修改不能扩大既有运行权限。
6. 已启动外部进程后不自动 replay；Provider Session resume 单独设计。
7. 不开放任意 shell、`danger-full-access`、远程 Daemon 或凭据持久化。
8. 每批独立 worktree、分支、PostgreSQL、`.tmp` 和 DSH_HOME。
9. 文档只记录实际完成状态，规划内容不得冒充完成。
10. 旧 API、旧表名、裸 ID 和 Employee alias 在迁移期可读，但新写入必须使用规范模型。

## 4. 目标依赖顺序

```text
Batch 13：External Runtime 发布门禁
  |
  v
Batch 14A：身份清点与 Principal 映射
  |
  v
Batch 14B：认证、登录 Session、账号状态
  |
  v
Batch 14C：Workspace / Project RBAC 与审计
  |
  v
Batch 14D：RBAC 读授权闭环与 Project Capability
  |
  v
Batch 15A：TaskExecutionPolicy + Execution Envelope
  |
  v
Batch 15B：Action Ticket + Execution Gate
  |
  v
Batch 16：Scene Context / Session Binding
  |
  v
Batch 13.1A：Runtime 兼容承诺收口
  |
  +----> Batch 17A：Task Execution Depth
  |          |
  |          v
  |       Batch 13.1B：Runtime 经济与可见性
  |          |
  |          v
  |       Batch 17B：AI Teammate
  |
  +----> Batch 18：Meeting Collaboration
  |
  +----> Batch 19：Shared Space（需独立安全评审）
  |
  v
Batch 20：Project Governance + Workbench
  |
  v
Batch 21：Legacy Compatibility Closeout
```

Batch 17、18、19 在 Batch 16 完成后可分别规划和排期，但不要同时修改 Task/Run/Worker
核心语义。Batch 19 的设计可以提前开始，写能力实现必须等 Ticket、Gate 和 Scene
Binding 完成。

## 5. 批次总表

| 批次 | 优先级 | 依赖 | 核心范围 | 退出条件 |
| --- | --- | --- | --- | --- |
| 13.1A Runtime 兼容收口 | P1 | Batch 13 | WorkBuddy 通用 plain-text 决策；文档承诺纠偏 | 已完成：契约、回归和文档一致 |
| 13.1B Runtime 经济与可见性 | P2 | 14C、15A、17A | Workspace Runtime 可见范围、Token/耗时统计 | 已完成：权限可见性、Token 对账和 Run 遥测测试通过 |
| 14A Principal 清点与模型 | P0 | Batch 13 | Human/AI Principal、Account、Alias、Grant 映射 | 旧数据来源和映射报告完整，模型/Migration 评审通过 |
| 14B 认证与登录 Session | P0 | 14A | Bearer Session、登录、改密、启停、Credential | 无认证拒绝，账号状态与 Principal 状态同步 |
| 14C RBAC 消费与审计 | P0 | 14B | Platform/Workspace/Project Grant、项目角色授权 | 越权写入拒绝，Grant 撤销立即生效，审计可追溯 |
| 14D RBAC 读授权闭环 | P0 | 14C | Project Capability；项目、Task、Run、Workflow、Meeting、Memory、Report、Handoff、Attachment、Trace、SSE 和批量的读隔离 | 非成员/跨项目读取拒绝，列表、搜索、Trace、事件流和文件下载无泄露 |
| 15A Policy / Envelope | P0 | 14D | 版本化 TaskExecutionPolicy、Preflight、快照 | 四类执行入口共用策略，策略不能扩权 |
| 15B Ticket / Gate | P0 | 15A | Action Ticket、阻塞 Gate、决策和恢复 | 无 Ticket 或 Gate 不放行，重试无重复副作用 |
| 16 Scene Context | P1 | 14C、15B | Scene Session、Contribution、Receipt、Channel | 场景隔离、确定性重放、来源可追溯 |
| 17A Task Execution Depth | P1 | 13.1A、15B、16 | 队列、暂停、Claim、needsInput、文档、自动验收 | 队列、依赖、恢复、Review 和文档权限通过 |
| 17B AI Teammate | P1 | 14C、16、17A、13.1B | 模板、生命周期、工作计划、周报、统计 | 已完成：模板/实例可追溯、受限任务、转派和统计对账通过 |
| 18 Meeting Collaboration | P1 | 14C、16 | Facilitator、Delegate、私密嘱咐、文件、归档 | 已完成：委托、投递、纪要、归档和敏感信息边界通过 |
| 19 Shared Space | P1 | 14C、15B、16 | 路径权限、Global Write、Locks、文件审计 | 路径穿越、越权写、锁竞争和写审批通过 |
| 20 Governance + Workbench | P2 | 14C、17B | 项目健康度、角色确认、审计、SSE、可配置布局 | 并发保护、只追加审计、三视口无溢出 |
| 21 Legacy Closeout | P2 | 14-20 | import dry-run、alias 清理、Session/Workspace 映射 | 旧数据报告完整，废弃能力有明确处置 |

## 6. 分批技术方案

### Batch 13.1A：Runtime 兼容承诺收口

状态：已完成。决策记录见
[v1-batch13.1a-runtime-compatibility.md](./v1-batch13.1a-runtime-compatibility.md)。

结论：

- WorkBuddy 只使用通用 `plain-text`；
- Prompt 走 stdin，stdout 是最终结果；
- 平台不自动追加协议参数，也不解析 `stream-json`；
- 不实现 WorkBuddy/CodeBuddy 专用 Parser、Provider Session 或工具流；
- Token、成本和 Workspace Runtime 可见性延后到 13.1B。

### Batch 13.1B：Runtime 经济与可见性

状态：已完成。交付记录见
[v1-batch13.1b-runtime-economics.md](./v1-batch13.1b-runtime-economics.md)。

依赖：Batch 14C、15A、17A。

- 收口 Workspace 级 Runtime 可见范围。
- 建立 Token、时长和成本遥测口径，并覆盖队列、Claim、等待与恢复。
- 与 17A 的 Task Event / Run 时间线对账。
- 必须早于 17B，避免 Teammate 统计和 Workspace 归属返工。

交付：

- Migration 29：Workspace Runtime scope、immutable usage receipt、执行历史索引与
  usage Outbox 幂等边界。
- Token、耗时、成本缺失、unknown、重复回执、重试、恢复与结算时间口径。
- Task Event、Run Event、Job Attempt、Runtime Effect、Outbox 与 usage receipt 对账。
- Workspace Runtime catalog、Runtime access projection、Run economics、Workspace
  经济统计和 Cursor-bound execution history API。
- 历史 Run 不伪造 usage；Batch 17B 可直接复用执行历史和统计查询边界。

### Batch 14A：身份、Principal 与迁移清点

目标模型：

- `Principal`：稳定主体，类型为 Human 或 AI。
- `Account`：Human Principal 的可选认证能力，不保存 HR 身份。
- `ExternalIdentityLink`：账号、Employee、Teammate 等历史来源到 Principal 的映射。
- `WorkspaceMember`：Principal 在工作区中的成员关系。
- `RoleGrant`：`platform`、`workspace`、`project` 范围内的显式授权。
- `Alias`：`employee:`、`teammate:`、`auth-user:` 和裸 ID 的解析入口。

清点范围：

- V1 Agent、Project Member、Owner、Task Assignee、Run Actor、Approver、Meeting
  Participant、Audit Actor。
- 旧 Employee、Teammate、账号、Runtime Profile、Action Ticket 和 Delegation 的文档契约。
- 每个字段的“当前来源、目标字段、兼容策略、迁移优先级”。

约束：

- Principal 不保存密码、HR 资料或 Runtime 凭据。
- AI Principal 永远没有密码登录。
- 一个 AI Companion/Teammate 绑定唯一 AI Principal。
- 一个 Human Principal 最多一个主登录账号。
- archived Principal 不能参与新任务、新工作流或新授权。

交付：

- Principal 映射报告。
- 数据模型和 Migration 设计。
- 旧数据 dry-run 方案与回滚策略。
- 过期技术设计状态修正。

### Batch 14B：认证与登录 Session

目标：

- 新增认证中间件，替换 API 对 `x-pluginmax-actor` 的信任。
- 支持登录、Bearer Session、改密、账号启停和 Session 撤销。
- 将 Account 状态投影到 Human Principal。
- 保持测试环境可控的本地认证夹具，但不能默认信任任意 Header。

退出条件：

- 无凭证请求被拒绝。
- 停用账号不能登录，已撤销 Session 立即失效。
- AI Principal 不能登录。
- 账号状态变化、Principal 状态和审计一致。

### Batch 14C：RBAC 与授权消费

目标：

- Platform、Workspace、Project 三层 Grant 进入统一授权服务。
- 项目角色 permissions 实际控制写操作。
- 项目 owner 是 Project Grant 的特例，不是绕过 RBAC 的隐式全局权限。
- 所有写操作审计记录 actor Principal、Grant、资源和结果。

默认权限流：

```text
Authenticated Account
  -> Human Principal
  -> Workspace Membership
  -> Project Membership / Role Grant
  -> Required Permission
  -> Application Use Case
```

AI 权限流：

```text
AI Companion / Teammate
  -> AI Principal
  -> Workspace / Project Grant
  -> Runtime Binding
  -> Task Policy
  -> Action Ticket
```

退出条件：

- 非成员、无 Grant、停用账号和归档 Principal 的写入全部拒绝。
- 项目角色变更和 Grant 撤销即时影响后续请求。
- 越权、跨项目和 Header 伪造测试通过。

### Batch 14D：RBAC 读授权闭环与 Project Capability

目标：

- 复用 14C 的 Authorization Service/Repository 补齐读授权。
- 覆盖 Project、Task、Run、Workflow、Meeting、Memory、Report、Handoff、
  Attachment、Artifact、Trace、SSE 和跨项目聚合入口。
- 项目列表与批量列表只返回 Principal 可读 Project 数据。
- 提供 Project Capability 投影，包含 read/write/approve/manage_members/
  manage_roles 和 owner 来源一致性。

约束：

- Platform ADMIN 不绕过 Project Grant。
- Workspace Grant 与 Project Grant 不混用。
- archived Project 允许成员只读历史，写操作继续拒绝。
- 不实现 TaskExecutionPolicy、Action Ticket、Execution Gate、Scene Context、
  Shared Space 或 sandbox。

退出条件：

- 非成员、跨项目和无效 Grant 的详情、列表、搜索、Trace、SSE 与文件下载均拒绝。
- Web 根据 Capability 隐藏或禁用无权操作，服务端仍为最终边界。
- Repository、Application、API、完整 Vitest 和 Playwright 多 Principal 回归通过。

进入 15A 前的依赖检查：

- 只审计 14C Application 层残留的 owner-only 二次门禁是否与
  `write/approve/manage_*` Capability 一致。
- 该检查属于 14C dependency closure，不新增产品批次，不扩大到 15A 执行语义。

### Batch 15A：TaskExecutionPolicy 与 Execution Envelope

目标：

- 持久化版本化 `TaskExecutionPolicy`。
- Task 创建、修改、读取和审计使用 revision/乐观锁。
- 四类执行入口统一消费 policy：
  - Task
  - Workflow Task
  - Meeting AI
  - Direct Chat
- Preflight 计算：

```text
Principal Grant
  ∩ 项目权限
  ∩ Agent Runtime Binding
  ∩ Runtime Capability
  ∩ TaskExecutionPolicy
  -> ExecutionEnvelope
```

- Run 保存不可变 policy revision、Envelope、Binding revision、Runtime revision 和 Capability
  snapshot。

规则：

- 未配置策略时使用 legacy/default policy。
- 策略只能收窄权限，不能扩大 Principal Grant 或 Runtime Capability。
- Worker 启动前复核 Binding、Runtime、Policy 和 Envelope revision。
- 策略变化只影响后续 Run；已启动 Run 保持原快照。

退出条件：

- 四类入口使用同一 Preflight。
- 策略变更、revision 冲突、快照不可变和拒绝原因可追溯。
- Fake、DSH SDK、External Runtime 均经过同一策略门禁。

### Batch 15B：Action Ticket 与 Execution Gate

Action Ticket 最低字段：

- `ticketId`
- `principalId`
- `workspaceId`
- `contextType` / `contextId`
- `taskId` / `runId`
- `allowedActions` / `deniedActions`
- `resourceScopes`
- `policyRevision` / `envelopeId`
- `issuedAt` / `expiresAt`
- `issuedBy`

Gate 最低能力：

- blocking / non-blocking Gate。
- approve / reject / timeout。
- 等待、恢复、取消和过期。
- 决策人、依据、时间和策略 revision 不可变。

规则：

- deny-wins。
- 无有效 Ticket 或 Gate 决策不得派发进程或执行敏感动作。
- Ticket 不得超出 Principal Grant、Task Policy、Context Scope 和 Runtime Capability。
- Job 重试、租约恢复和业务回写必须校验 Ticket 幂等边界。

退出条件：

- Ticket 过期、上下文不匹配、Principal 停用和 Gate 拒绝均阻断执行。
- 重试不产生重复外部副作用、Task 消息、Meeting 发言或 Direct Chat 回复。

### Batch 16：Context 与 Scene Session（已完成）

目标：

- 保留现有 ContextPack/Receipt 读取兼容。
- 为 Task、Workflow Node、Meeting、Direct Chat 增加统一 Scene Session Binding。
- 引入 Chat Channel、SceneContextContribution、ContextReceipt 和增量投递游标。
- Context 可纳入评论共识、依赖、文档、Memory、Meeting Minutes 和 Workflow 信息。

隔离规则：

- 不同 Scene 不共享 Session Handle、Contribution 或 ContextPack。
- 私有 Episode、会议私密内容和 Shared Space 内容必须有独立权限投影。
- 持久 Session 与无状态 Runtime 使用不同增量/重放规则。
- 旧 ContextPack、Meeting Context、Direct Chat Context 保持可读。

退出条件：

- 场景之间无上下文泄漏。
- 同样输入能确定性重放 ContextPack 和 Receipt。
- SourceRef 可追溯，跨项目和 Memory 注入测试通过。

### Batch 17A：Task Execution Depth

范围：

- 队列排序、优先级和依赖阻塞。
- 暂停、阻断、自动执行资格和 Claim。
- `needsInput`、补充输入和恢复。
- Session Reset。
- 文档发现、Reveal、上传和权限。
- 自动提交、自动验收和 Review 退回。
- `deliveryTarget` 提及派发语义。

复用边界：

- 复用现有依赖、附件、Review、Workflow Task 和 Task Event。
- 不修改 Batch 15 的 Ticket/Gate 语义。
- 任务队列和 Teammate 工作队列不是同一概念，17A 先完成执行语义。

### Batch 17B：AI Teammate

状态：已完成。交付记录见
[v1-batch17b-ai-teammate.md](./v1-batch17b-ai-teammate.md)。

范围：

- Teammate 模板与实例、归属、版本和生命周期。
- 工作计划解析和受限任务生成。
- 工作队列、周报、自动执行资格。
- 执行身份、运行时长、Token 和成本统计。
- 归档、暂停和安全转派。

依赖：

- Principal / Workspace / Project Grant。
- Scene Session 和增量 Context。
- Task Execution Depth。
- Action Ticket、Gate 和 Execution Envelope。

### Batch 18：Meeting Collaboration

状态：已完成。交付记录见
[v1-batch18-meeting-collaboration.md](./v1-batch18-meeting-collaboration.md)。

范围：

- Facilitator、参会人生命周期和 AI Delegate。
- 私密嘱咐、已读位置和敏感信息边界。
- 会议文件、Minutes 自动生成与确认。
- 消息投递状态、Meeting Task、归档和恢复。
- 复用 Batch 12A 的 AI 参与和 Batch 16 的 Scene Context。

退出条件：

- 参会、委托、投递、纪要、任务和归档权限完整。
- 私密嘱咐不进入其他 Principal 的 Context 或投递。
- Meeting AI 与外部 Runtime 回归通过。

### Batch 19：Shared Space

范围：

- Workspace 共享路径权限和路径级 Grant。
- Global Write 审批。
- Locks、Claims、Session Digest。
- 文件操作审计。
- 受控 Agent Tool Surface。

前置条件：

- Principal / Workspace / Project Grant。
- Action Ticket 和 Gate。
- Scene Session Binding。
- 独立共享文件安全设计评审。

硬约束：

- 默认 `read-only`。
- 拒绝路径穿越、符号链接逃逸、未授权写入和锁竞争越权。
- 不开放危险 sandbox。
- Global Write 必须绑定 Ticket、Gate、Workspace 和 Actor。

### Batch 20：Project Governance 与 Workbench

只补残余能力：

- 项目负责人、健康度、进度、起止日期。
- 角色草稿确认、导入、来源锁定和并发保护。
- 项目产出汇总和项目历史审计。
- Workbench Brief SSE、指标偏好和可配置布局。
- 复用现有 Batch 10B/11A/11B，不重做项目、日报、模板和角色基础模型。

退出条件：

- 角色发布具备 revision 冲突保护和影响提示。
- 项目审计只追加。
- 工作台桌面、900px、390px 无溢出和遮挡。

### Batch 21：Legacy Compatibility Closeout

从 Batch 14A 开始维护迁移台账，最终执行：

- Employee/Principal 兼容导出。
- 旧数据 import dry-run。
- DSH Session/Workspace 能力映射确认。
- 旧 alias 使用率统计和清理计划。
- 废弃 Provider、Runtime 和 UI 能力处置。

退出条件：

- 旧数据保留和映射报告完整。
- 已废弃能力有明确删除、只读或兼容期限。
- 新运行不再依赖旧 JSON Storage。

### 后续技术债与构建质量计划

以下事项纳入后续维护排期，不阻塞 Batch 17B：

- **P2 Web 路由级代码分割**：对 Web 页面和重面板使用路由/页面级懒加载，
  保持导航、权限、刷新和交互语义。验收 production bundle 的首屏入口、懒加载
  chunk、gzip 大小，以及 HTML 与指纹静态资源的缓存和版本切换行为；覆盖
  1440px、900px、390px Playwright 回归。
- **P2 `tsdown` 配置维护**：将 packages/apps 中 `external` 配置迁移到
  `deps.neverBundle`。必须在现有 `tsdown` 版本内保持 external 集合和构建产物
  语义等价，不夹带版本升级。
- **P3 d.ts sourcemap 跟踪**：`rolldown-plugin-dts:fake-js` 的 sourcemap 告警
  保持 P3，不单独做破坏性 workaround。随未来 `tsdown` 升级验证 `.d.ts.map`
  可追踪性、declaration 内容、构建告警和消费方 typecheck。

## 7. 目标执行架构

```text
HTTP Request
  -> Auth Middleware
  -> Principal Resolver
  -> Workspace / Project Authorization
  -> Application Use Case
  -> TaskExecutionPolicy / Preflight
  -> Action Ticket / Execution Gate
  -> ContextPack + ContextReceipt
  -> Run + Job + Outbox
  -> Worker claim
  -> Ticket / Policy / Binding revalidation
  -> Runtime Adapter
  -> Normalized RunEvent
  -> Task / Workflow / Meeting / Direct Chat settlement
  -> Trace / Audit / Memory
```

边界：

- API 不执行外部进程。
- Application 不绕过 Ticket、Gate 或 Policy。
- Worker 不复用已失效的 Ticket。
- Adapter 不访问数据库或修改业务状态。
- 业务回写保留单次消费和幂等语义。

## 8. Migration 与兼容策略

1. 不在本路线图中预分配 Migration 编号，每批根据实际前置版本分配。
2. 先新增 nullable 字段/新表，再做 backfill，最后在兼容窗口后收紧约束。
3. 旧字段删除必须有独立 Migration、备份、回滚和旧数据 fixture。
4. Principal、Grant、Ticket、Gate、Scene 和 Receipt 的历史记录只追加或版本化。
5. JSONB 用于不可变策略/执行/Context 快照；权限、Ticket Scope 和审计索引使用关系列。
6. 每批同时验证 `N→N+x` 和 `0→N+x`，并逐表断言旧数据内容。
7. 旧 alias 解析必须有唯一优先级和冲突检测。
8. 数据导入先 dry-run，输出新增、复用、冲突、缺失和跳过报告。

## 9. 每批统一发布门禁

- 独立 worktree、分支和 commit，基线工作树干净。
- 独立 PostgreSQL 端口和数据库。
- `DSH_HOME`、FileStore、Agent Workspace、日志、截图和测试文件位于 worktree `.tmp`。
- Contracts、Repository、API、Worker、GUI 定向测试。
- 完整 Vitest。
- 外部 Runtime 四条执行链回归，不依赖真实模型凭证。
- 完整 Playwright，至少 1440px、900px、390px。
- `pnpm check`、`git diff --check`、脚本语法检查。
- API/Web/Worker 进程、临时数据库和容器检查。
- 旧数据、权限撤销、Ticket 过期和重试幂等回归。
- 发布文档记录实际完成、失败、跳过、已知限制和远端状态。

## 10. 进度跟踪

- [x] Batch 13 Phase 6 发布门禁
- [x] Batch 13.1A Runtime 兼容承诺收口
- [x] Batch 13.1B Runtime 经济与可见性
- [x] Batch 14A Principal 清点与模型
- [x] Batch 14B 认证与登录 Session
- [x] Batch 14C RBAC 消费与审计
- [x] Batch 14D RBAC 读授权闭环与 Project Capability
- [x] Batch 15A TaskExecutionPolicy 与 Envelope
- [x] Batch 15B Action Ticket 与 Execution Gate
- [x] Batch 16 Context 与 Scene Session
- [x] Batch 17A Task Execution Depth
- [x] Batch 17B AI Teammate
- [x] Batch 18 Meeting Collaboration
- [x] Batch 20A Identity Administration（独立身份运营批次，不包含 Batch 19/20）
- [ ] Batch 19 Shared Space
- [ ] Batch 20 Project Governance 与 Workbench
- [ ] Batch 21 Legacy Compatibility Closeout

## 11. 待决策事项

在进入对应批次前必须明确：

1. 首个 V1 登录协议是否采用账号密码 + Bearer Session，SSO 是否后置。
2. V1 的首个工作区模型是否支持多 Workspace，还是先单 Workspace + 多 Project。
3. 旧账号、Employee、Teammate 的迁移来源和 alias 优先级。
4. ~~WorkBuddy 是否仍有必须实现的专用兼容承诺。~~ 已解决：V1 只使用通用
   `plain-text`，专用 stream-json、Session resume 和工具流解析为非目标。
5. Shared Space 写能力的首发范围和审批责任人。
6. Legacy import 的数据导出方式、保留窗口和敏感字段处理。
7. AI Teammate 模板的产品归属和平台/个人可编辑边界。

## 12. 下一步

下一执行批次为 **Batch 19：Shared Space**，需独立安全评审与 worktree。
Batch 18 已完成；15B 的 Ticket/Gate 语义仍不能由 Meeting Collaboration、
Scene Context、Task Execution Depth 或 Runtime 统计查询绕过。
Shared Space 和 sandbox 扩展仍未实现。

建议在独立 worktree 执行：

```text
worktree: 独立 `.tmp/pluginmax-platform-batch19-*`
branch:   `feat/v1-batch19-*`
base:     Batch 18 local commit
```

## 13. 参考文档

- [v1-batch14a-identity-principal-rbac-audit.md](./v1-batch14a-identity-principal-rbac-audit.md)
- [v1-batch14b-auth-session.md](./v1-batch14b-auth-session.md)
- [v1-batch14c-rbac-authorization.md](./v1-batch14c-rbac-authorization.md)
- [v1-batch14d-read-authorization.md](./v1-batch14d-read-authorization.md)
- [v1-batch13-release-gate.md](./v1-batch13-release-gate.md)
- [v1-batch13.1a-runtime-compatibility.md](./v1-batch13.1a-runtime-compatibility.md)
- [v1-batch15a-task-execution-policy.md](./v1-batch15a-task-execution-policy.md)
- [v1-batch15b-action-ticket-gate.md](./v1-batch15b-action-ticket-gate.md)
- [v1-batch16-scene-context.md](./v1-batch16-scene-context.md)
- [v1-batch17a-task-execution-depth.md](./v1-batch17a-task-execution-depth.md)
- [v1-batch13.1b-runtime-economics.md](./v1-batch13.1b-runtime-economics.md)
- [v1-batch17b-ai-teammate.md](./v1-batch17b-ai-teammate.md)
- [v1-batch18-meeting-collaboration.md](./v1-batch18-meeting-collaboration.md)
- [v1-dsh-pluginmax-parity-gap-assessment.md](./v1-dsh-pluginmax-parity-gap-assessment.md)
- [v1-batch13-external-agent-runtime-integration.md](./v1-batch13-external-agent-runtime-integration.md)
- [v1-external-agent-runtime-technical-design.md](./v1-external-agent-runtime-technical-design.md)
- [engineering-platform-v1-technical-design.md](./engineering-platform-v1-technical-design.md)
- [engineering-isolation-plan.md](./engineering-isolation-plan.md)
- [technical-design-phase1-agent-execution-plan.md](./technical-design-phase1-agent-execution-plan.md)
- [technical-design-phase2-task-delivery-plan.md](./technical-design-phase2-task-delivery-plan.md)
- [technical-design-agent-task-control-overall.md](./technical-design-agent-task-control-overall.md)
- [platform-principal-rbac-design.md](./platform-principal-rbac-design.md)
- [agent-task-home-session-design.md](./agent-task-home-session-design.md)
- [task-comment-consensus-context-design.md](./task-comment-consensus-context-design.md)
- [teammate-work-queue-prd.md](./teammate-work-queue-prd.md)
- [teammate-work-queue-technical-design.md](./teammate-work-queue-technical-design.md)
- [workbench-management-cockpit-prd.md](./workbench-management-cockpit-prd.md)
