# Pluginmax Platform V1：后续迭代路线图

> 状态：Batch 13.1A、13.1B、14A-18 已完成并合入 `main`；
> 下一正式批次为 Batch 20A Identity Administration
>
> 当前 main：`e1dca0dc1da3ebd3a41373172eda0082842e1d80`
>
> 初始路线图基线：`bc7f55b651737c34ea288b8ad2adf3c51bf3a6ea`
>
> 最后更新：2026-10-27

> 产品决策：现有 dsh-pluginmax 数据主要是测试和可丢弃数据。V1 采用全新开始，
> 不迁移旧业务数据，不双写，不保留旧业务 ID 在新平台继续可用的承诺。旧系统
> 只做冻结写入、只读归档和最终下线。

## 1. 文档目的

本文统一 V1 后续迭代范围、依赖顺序、技术边界、产品决策和发布门禁。原则是吸收
dsh-pluginmax 的产品能力与安全契约，不按旧插件目录做 1:1 平移，尤其不迁移
DSH Shell、Slot、JSON Storage 和旧 Employee 页面。

Batch 14-18 已完成并合入 `main`，因此“最新实现尚未进入 main”和“旧数据尚未
迁移”不再作为发布阻断项。V1 从新数据库、新 Principal 和新业务数据开始；旧
dsh 数据不进入正式迁移范围。

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
- Batch 13.1B 已完成 Workspace Runtime 可见范围、Token/成本 unknown 口径和
  execution history；Migration 29 已落地。
- Batch 17A 已完成 Task 队列、Claim、needsInput、Review、Session Reset 和
  文档边界；Migration 28 已落地。
- Batch 17B 已完成 AI Teammate 模板、实例、工作队列、自动执行、统计、周报和
  安全转派；Migration 30 已落地。
- Batch 18 已完成 Meeting Facilitator、Delegate、私密嘱咐、投递、文件、
  Minutes 确认、Meeting Task、归档与恢复；Migration 31 已落地。
- Batch 14-18 已合入 `main`，最新平台能力不再依赖独立批次 worktree 才能部署。

### 2.2 主要缺口

| 缺口 | 当前状态 | 影响 |
| --- | --- | --- |
| 身份认证 | 已完成 14B：Bearer Session；Bearer 模式不接受客户端 actor Header 回退 | 生产认证边界已建立 |
| Principal 统一 | 已完成 14A/14C/14D：Human/AI Principal、Grant、读授权和 Capability 已统一消费 | 新业务只写规范 Principal，不接受第二套身份事实 |
| RBAC 消费 | 已完成 14C/14D 的主门禁和读授权；进入 15A 前审计 Application 残留 owner-only 二次门禁 | 防止 Route Grant 与 Application 门禁语义不一致 |
| TaskExecutionPolicy | 已完成 15A：持久化 revision、统一 Preflight 和不可变 Run Envelope | 任务级 Runtime、工具、来源和预算已进入执行快照 |
| Action Ticket / Gate | 已完成 15B：持久化 Ticket、Gate、不可变决策与 Worker 门禁 | 高风险动作具备可校验、可过期和可审计的执行边界 |
| Scene Context | 已完成 16：四类 Scene Session、Contribution、Channel、Cursor 和 Receipt 已统一 | 场景隔离、确定性重放和来源追溯已建立 |
| Task / Teammate 深度 | 17A/17B 已完成队列、Claim、needsInput、Session Reset、工作计划、自动执行和统计 | V1 已有完整任务与 AI Teammate 工作面 |
| Meeting Collaboration | Batch 18 已完成 Facilitator、Delegate、私密嘱咐、投递、文件、Minutes 确认、Meeting Task、归档与恢复 | 会议协作闭环已建立 |
| Shared Space | 尚无工作区共享路径、写审批、Locks 和文件审计 | 不能安全开放 Agent 文件写 |
| Identity Administration | 只有 bootstrap、登录、改密和账号启停；缺少账号邀请/创建、平台 Grant、Workspace 成员与 Grant 管理面 | 团队生产上线仍缺 P0 身份运营闭环 |
| Legacy Retirement | 旧数据已决定不迁移；仍需冻结写入、只读归档、保留期限和最终下线 | 旧系统不能成为新平台运行时依赖 |

## 3. 迭代原则

1. **白纸启动。** V1 使用全新 PostgreSQL 和全新业务数据，不导入旧 dsh 测试
   数据或业务数据。
2. **能力迁移，不迁移实现。** 吸收产品契约和安全边界，不迁移 DSH Shell、Slot、
   JSON Storage、旧路由或插件内 Runtime。
3. **单一事实来源。** Principal、Account、Credential、AuthSession、
   WorkspaceMember 和 RoleGrant 不得出现第二套并行身份或权限模型。
4. **先 P0 身份运营。** 多用户生产上线前完成 Identity Administration，再做
   其他增强。
5. **安全默认拒绝。** Task Policy、Runtime Capability、Principal Grant 和项目
   权限取交集；Ticket/Gate、Scene 和 Worker 复核不得绕过。
6. **已启动 Run 使用不可变快照。** 策略、身份、Context 和 Runtime revision
   变化只影响后续 Run。
7. **不双写、不兼容旧业务 ID。** 新平台不承诺旧 ID、旧 Session、旧 Workspace
   或旧 JSON Storage 继续可用。
8. **每批独立。** 使用独立 worktree、分支、PostgreSQL、`.tmp` 和 DSH_HOME。
9. **文档只记录实际完成状态。** 规划内容不得冒充完成。
10. **风险分层。** P0/P1/P2、Non-target 和待决策能力不得混写。

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
  +----> Batch 20A：Identity Administration（P0）
  |          |
  |          v
  +----> Batch 19：Shared Space（需独立安全评审）
  |
  v
Batch 20：Project Governance + Workbench（P1/P2）
  |
  +----> Human Avatar / Delegation（独立待规划）
  |
  v
Batch 21：Legacy Retirement（可选 P2）
```

Batch 20A 必须先于 Batch 19。Batch 19 的共享写能力必须完成独立安全评审和
Ticket/Gate/Scene 复核，未开放前不得宣称完成。Batch 21 是可选退役工作，不是
数据迁移项目，也不阻断 V1 白纸启动。

## 5. 批次总表

| 批次 | 优先级 | 依赖 | 核心范围 | 退出条件 |
| --- | --- | --- | --- | --- |
| 13.1A Runtime 兼容收口 | P1 | Batch 13 | WorkBuddy 通用 plain-text 决策；文档承诺纠偏 | 已完成：契约、回归和文档一致 |
| 13.1B Runtime 经济与可见性 | P2 | 14C、15A、17A | Workspace Runtime 可见范围、Token/耗时统计 | 已完成：权限可见性、Token 对账和 Run 遥测测试通过 |
| 14A Principal 清点与模型 | P0 | Batch 13 | Human/AI Principal、Account、Grant 基础模型 | 已完成：模型、认证/RBAC 基础与审计边界通过；不承担旧数据导入 |
| 14B 认证与登录 Session | P0 | 14A | Bearer Session、登录、改密、启停、Credential | 无认证拒绝，账号状态与 Principal 状态同步 |
| 14C RBAC 消费与审计 | P0 | 14B | Platform/Workspace/Project Grant、项目角色授权 | 越权写入拒绝，Grant 撤销立即生效，审计可追溯 |
| 14D RBAC 读授权闭环 | P0 | 14C | Project Capability；项目、Task、Run、Workflow、Meeting、Memory、Report、Handoff、Attachment、Trace、SSE 和批量的读隔离 | 非成员/跨项目读取拒绝，列表、搜索、Trace、事件流和文件下载无泄露 |
| 15A Policy / Envelope | P0 | 14D | 版本化 TaskExecutionPolicy、Preflight、快照 | 四类执行入口共用策略，策略不能扩权 |
| 15B Ticket / Gate | P0 | 15A | Action Ticket、阻塞 Gate、决策和恢复 | 无 Ticket 或 Gate 不放行，重试无重复副作用 |
| 16 Scene Context | P1 | 14C、15B | Scene Session、Contribution、Receipt、Channel | 场景隔离、确定性重放、来源可追溯 |
| 17A Task Execution Depth | P1 | 13.1A、15B、16 | 队列、暂停、Claim、needsInput、文档、自动验收 | 队列、依赖、恢复、Review 和文档权限通过 |
| 17B AI Teammate | P1 | 14C、16、17A、13.1B | 模板、生命周期、工作计划、周报、统计 | 已完成：模板/实例可追溯、受限任务、转派和统计对账通过 |
| 18 Meeting Collaboration | P1 | 14C、16 | Facilitator、Delegate、私密嘱咐、文件、归档 | 已完成：委托、投递、纪要、归档和敏感信息边界通过 |
| 20A Identity Administration | P0 | 14A-14D | 账号邀请/创建、Credential、Platform Grant、Workspace 成员与 Grant、目录、审计、Web 管理面 | 多用户可邀请、授权、撤销并审计；无第二套身份/权限事实 |
| 19 Shared Space | P1 | 14C、15B、16 | 路径权限、Global Write、Locks、文件审计 | 路径穿越、越权写、锁竞争和写审批通过 |
| 20 Governance + Workbench | P1/P2 | 14C、17B | 项目负责人/健康度/进度/日期、产出物、审计、角色确认、SSE、布局、驾驶舱 | 并发保护、只追加审计、三视口无溢出 |
| 21 Legacy Retirement | P2（可选） | 20A、20 | 旧系统冻结、只读归档、兼容导出、Session 失效、下线 | 旧系统无写入、无迁移、无运行时依赖；保留期限明确 |

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

### Batch 14A：身份、Principal 与历史清点（已完成）

历史说明：该批完成时曾规划旧数据 dry-run 和迁移来源。当前产品决策已关闭这条
路线；本节保留历史模型和审计记录，不再承诺旧 dsh 数据导入。

目标模型：

- `Principal`：稳定主体，类型为 Human 或 AI。
- `Account`：Human Principal 的可选认证能力，不保存 HR 身份。
- `ExternalIdentityLink`：外部身份来源到 Principal 的通用映射模型；V1 新业务
  不依赖旧 dsh 数据。
- `WorkspaceMember`：Principal 在工作区中的成员关系。
- `RoleGrant`：`platform`、`workspace`、`project` 范围内的显式授权。
- `Alias`：兼容引用解析边界；白纸启动后不作为旧业务 ID 长期可用的承诺。

清点范围：

- V1 Agent、Project Member、Owner、Task Assignee、Run Actor、Approver、Meeting
  Participant、Audit Actor。
- 旧 Employee、Teammate、账号、Runtime Profile、Action Ticket 和 Delegation 的文档契约。
- 每个字段的“当前来源、目标字段、兼容边界、处置优先级”。

约束：

- Principal 不保存密码、HR 资料或 Runtime 凭据。
- AI Principal 永远没有密码登录。
- 一个 AI Companion/Teammate 绑定唯一 AI Principal。
- 一个 Human Principal 最多一个主登录账号。
- archived Principal 不能参与新任务、新工作流或新授权。

交付：

- Principal 模型、审计边界和 Migration 24 设计。
- 当前已完成并合入 main 的认证/RBAC 事实。
- 过期技术设计状态修正。

不包含：旧 dsh 数据转换、import dry-run、backfill、alias 清理或双写。

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

### Batch 20A：Identity Administration

优先级：P0。必须先于 Batch 19。

目标：

- 补齐多用户生产上线所需的账号邀请、创建、资料更新、启停、Credential 初始化和
  受控重置。
- 提供平台角色、Platform Grant、Workspace 成员和 Workspace Grant 的管理闭环。
- 提供账号目录搜索、分页、状态、身份审计和 Web 管理面。
- 明确复用现有 Principal、Account、Credential、AuthSession、WorkspaceMember
  和 RoleGrant，不建立第二套身份或权限事实。

范围：

- 账号邀请/创建、显示名与资料更新。
- Credential 初始化、一次性激活或受控重置；secret 不写日志、不返回不可恢复
  明文、不进入审计。
- Platform Role / Platform Grant 查询、授予、撤销、到期与审计。
- Workspace 成员、成员状态和 Workspace Grant 管理。
- 账号目录、搜索、分页、状态和历史审计。
- 管理员 Web 管理面与 Capability/权限禁用状态。

安全与兼容：

- 所有写操作要求 active Platform ADMIN 或对应管理 Grant。
- Platform ADMIN 不因此绕过 Project Grant。
- 重复邀请、并发更新、已归档 Principal、disabled Account、revoked/expired Grant
  必须返回稳定冲突或幂等结果。
- 不新增 Employee 产品域，不恢复旧账号双写，不读取旧 dsh 数据。

退出条件：

- 管理员可邀请、创建、维护、停用和审计账号。
- 可分配/撤销 Platform Grant 和 Workspace Grant，撤销后立即生效。
- AI Principal 不能登录；archived Principal 不能获得新授权。
- Repository、Application、API、Web 和多 Principal Playwright 回归通过。

### Batch 19：Shared Space

优先级：P1。必须独立安全评审，不得与 Batch 20A 混批。

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

退出条件：

- 路径权限、Global Write、Locks、Session Digest 和文件审计全部有负向回归。
- 未授权写入、跨 Workspace、路径逃逸、锁竞争和 Gate 绕过全部 fail closed。
- 在完整安全门禁通过前，不得宣称 Shared Space 或共享写能力已完成。

### Batch 20：Project Governance 与 Workbench

优先级：P1/P2。

只补残余能力：

- 项目负责人、健康度、进度、起止日期和基础信息。
- 项目阶段性产出物、来源追溯和筛选。
- 项目历史审计，只追加并与成员/角色/Grant 事件关联。
- 角色草稿确认、导入、来源锁定和并发保护。
- 角色删除的成员影响确认、工作流模版阻塞和进行中任务改派。
- Workbench 可配置布局、六档宽度、高度、默认布局和恢复。
- Workbench Brief SSE、模块刷新、指标偏好和 stale/partial error。
- 管理驾驶舱容器和管理数据权限。
- 复用现有 Batch 10B/11A/11B，不重做项目、日报、模板和角色基础模型。

退出条件：

- 角色发布具备 revision 冲突保护和影响提示。
- 项目审计只追加。
- 工作台桌面、900px、390px 无溢出和遮挡。

### Human Avatar / 通用 Delegation（独立待规划）

优先级：P1，不并入 Batch 20A、19 或 20。

- 覆盖 Task、Workflow、Meeting 等跨场景的受限 Human Avatar 委托。
- 明确 owner、目标、立场、关注点、允许/禁止动作、有效期、频控、暂停、延期、
  撤销、过期和报告。
- Batch 18 Meeting Delegate 只是会议级代表，不能替代通用 Delegation。
- 不复用 Meeting Delegate 表承载跨场景委托，不新增独立 Principal。

### Batch 21：Legacy Retirement（可选）

优先级：P2。可选退役项目，不是数据迁移项目，也不是 V1 发布阻断项。

只保留：

- 旧 dsh 系统冻结写入。
- 旧测试/业务数据只读归档。
- 运维级兼容导出和归档校验。
- 数据保留期限、访问控制和删除计划。
- 旧 Session 全部失效，旧环境不可继续登录。
- 旧 Provider、Runtime、插件和 UI 最终下线。

明确不做：

- 不迁移旧业务数据。
- 不做正式 dry-run、backfill 或历史数据兼容导入。
- 不建立双写。
- 不要求旧业务 ID、旧 Workspace 或旧 Session 在新平台继续可用。
- 不把 Legacy Retirement 写成发布阻断项。

退出条件：

- 旧系统无写入入口，仅按保留期限只读。
- 归档完整性、访问控制和删除计划有记录。
- 新平台不依赖旧 JSON Storage、旧 Session 或旧插件运行时。

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

## 8. Schema Migration 与白纸启动

1. “Migration”在本路线图中只指 V1 PostgreSQL schema migration，不指 dsh
   业务数据迁移。
2. 不在本路线图中预分配 Migration 编号，每批根据实际前置版本分配。
3. 新表或新字段优先 additive；如涉及历史 V1 数据，必须说明 backfill、兼容读取
   和回滚。
4. Principal、Grant、Ticket、Gate、Scene、Receipt 和审计历史只追加或版本化。
5. JSONB 用于不可变策略/执行/Context 快照；权限、Ticket Scope 和审计索引使用
   关系列。
6. 每批验证 fresh `0→N` 和 V1 upgrade `N→N+x`；不验证 dsh JSON Storage
   import。
7. V1 正式环境从新数据库开始，不执行旧账号、Task、Workflow、Meeting、Memory、
   Context、Workbench 或 Session 的导入。
8. 旧业务 ID、alias、Workspace 和 Session 不承诺在新平台继续有效；不为兼容
   旧数据保留双写。
9. 旧系统只按 Batch 21 的可选退役方案冻结写入、只读归档和最终下线。

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
- V1 fresh schema、权限撤销、Ticket 过期和重试幂等回归。
- 不得引入 dsh 数据 import、双写或旧 Session 迁移。
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
- [ ] Batch 21 Legacy Retirement（可选）

## 11. 优先级与待决策事项

### 11.1 当前优先级

| 优先级 | 项目 |
| --- | --- |
| P0 | Batch 20A Identity Administration：账号邀请/创建、Credential、Platform Grant、Workspace 成员与 Grant、审计和 Web 管理面 |
| P1 | Batch 19 Shared Space；Batch 20 Project Governance + Workbench 的核心治理项 |
| P1（独立待规划） | Human Avatar / 通用 Delegation |
| P2 | Workbench 体验增强、Teammate 产品面残余、Persona/Seat Claim、Task 通用外部关联、Provider Session Resume、Runtime 预算硬限制、MFA/SSO/Rate Limit |
| P2（可选） | Batch 21 Legacy Retirement：只读归档和旧系统下线 |
| Non-target | 旧 dsh 业务数据迁移、backfill、双写、旧 Session 延续、旧业务 ID 长期兼容 |

### 11.2 待决策事项

1. V1 首发是单 Workspace 还是多 Workspace；无论选择哪种，都复用现有
   WorkspaceMember/RoleGrant，不新增第二套工作区权限。
2. Batch 20A 的账号邀请方式、Credential 初始化/重置交付方式、邮件/SSO 是否后置。
3. Shared Space 的首发路径范围、Global Write 业务场景和审批责任人。
4. Human Avatar / 通用 Delegation 的目标场景、动作边界和报告口径。
5. Legacy Retirement 的只读保留期限、归档位置、访问人和最终销毁流程。
6. Persona/Seat Claim 是否仍需要独立产品，或由 Teammate Template + Project Role
   完整替代。
7. Provider Session Resume、Runtime 预算硬限制、MFA/SSO/Rate Limit 的后续排期。

### 11.3 风险说明

- Identity Administration 涉及 Credential、Grant 和审计，必须先完成 P0 再做
  团队生产上线。
- Shared Space 是高风险文件写能力；独立安全评审前保持 read-only。
- Batch 20 范围较大，项目治理和 Workbench 可分阶段交付，但不得降低并发、
  审计和权限门禁。
- Legacy Retirement 只处理旧系统归档和下线；只读归档仍含敏感数据，必须明确
  访问控制、保留期限和删除责任人。
- Human Avatar 若直接复用 Meeting Delegate，可能把会议级权限扩散到 Task 和
  Workflow；必须独立建模。
- 白纸启动意味着旧业务 ID、Session、Workspace 和历史数据不延续，这是接受
  的产品结果，不应在发布后作为迁移缺陷重新打开。

## 12. 下一步

下一执行批次为 **Batch 20A：Identity Administration**，优先级 P0。
Batch 14-18 已合入 main；V1 从白纸启动，不迁移旧 dsh 数据。
15B 的 Ticket/Gate 语义仍不能由 Meeting Collaboration、Scene Context、
Task Execution Depth、Identity Administration 或 Runtime 统计查询绕过。
Shared Space 和 sandbox 扩展仍未实现。

建议在独立 worktree 执行：

```text
worktree: 独立 `.tmp/pluginmax-platform-batch20a-*`
branch:   `feat/v1-batch20a-*`
base:     main（包含 Batch 14-18）
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
