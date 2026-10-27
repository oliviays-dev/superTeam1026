# Pluginmax V1 与 dsh-pluginmax 能力对照及 P0 评估

> 状态：只读审计完成；后续迭代计划已按白纸启动决策更新
>
> 审计日期：2026-10-27
>
> V1 对照基线：`main` / `e1dca0dc1da3ebd3a41373172eda0082842e1d80`
>
> dsh 对照基线：`feat/external-agent-teammates` / `a702267abfc6baebc7cab7b3045e71c204079e10`

> 产品决策：现有 dsh-pluginmax 数据主要是测试和可丢弃数据。V1 全新开始，
> 不迁移旧业务数据，不双写，不保留旧业务 ID/Session 在新平台继续可用的承诺。
> 旧系统只做冻结写入、只读归档和最终下线。

## 1. 审计范围与基线说明

用户所称 `dsd-pluginmax` 在当前工作区对应
`/Users/oliviayang/Codex/一切皆插件/dsh-pluginmax`，本文按实际仓库名
`dsh-pluginmax` 记录。

`/Users/oliviayang/Codex/pluginmax-platform` 的 `main` 已包含 Batch 14-18。
本次直接以实际 main 作为平台功能对照面。

审计仅基于源码、Migration、Contracts、测试和设计文档，不读取正式数据库、
正式 Session/Profile、原始业务数据或用户生产配置。

## 2. 结论摘要

1. dsh-pluginmax 是依赖 DSH Slot、Storage Domain、WebServer、Workspace
   Registry 和 subagent 的 14 插件套件；V1 是独立 PostgreSQL、Fastify、React、
   API、Worker 平台，不应按插件目录做 1:1 平移。
2. 项目、任务、工作流、会议、AI 伙伴、记忆、Context、外部 Runtime、RBAC 和
   Worker 主链路已经迁移，部分能力在 V1 中更强。
3. 后续的主要产品域是 Identity Administration、Shared Space、项目治理完整面、
   工作台可配置布局和 Human Avatar 通用委托。
4. DSH Shell、Slot、Workspace Browser、原生 conversation、JSON Storage 和
   Employee 产品页属于明确的非迁移目标，不应计入“功能遗漏”。
5. 在已完成的 Batch 18 代码与安全边界内，没有发现新的代码级 P0。
6. 原 `P0-REL-01` 已关闭：Batch 14-18 已合入 main。
7. 原 `P0-MIG-01` 已关闭：旧数据不迁移，V1 白纸启动。
8. 当前唯一剩余 P0 是团队账号、平台角色和 Workspace 管理闭环，即
   Batch 20A Identity Administration。

## 3. 严重度定义

| 级别 | 定义 |
| --- | --- |
| P0 | 阻断安全生产发布或正式团队上线；必须先解决 |
| P1 | 关键能力缺口或显著兼容风险，有临时绕行但不能视为完成 |
| P2 | 产品体验、运营便利、非核心兼容或后续增强 |
| Non-target | 明确不进入 V1 目标，不按缺口处理 |

“代码级 P0”和“交付级 P0”需要区分。当前没有已知的 Run、Ticket、Gate、
Scene 或权限放行漏洞；剩余 P0 是身份运营交付闭环。

## 4. 架构对照

| 维度 | dsh-pluginmax | Pluginmax V1 |
| --- | --- | --- |
| 宿主 | DeepSeek Harness 插件宿主 | 独立 API / Worker / Web |
| 存储 | DSH JSON Storage Domain | PostgreSQL + additive migrations |
| 页面 | DSH Shell、Slot、Settings section、native conversation | React 单页应用、自有导航和业务面板 |
| 身份 | 账号 + Employee 过渡 + Principal migration | Principal/Account/Credential/Grant 为规范模型 |
| 项目 | 项目等于 DSH workspace | 独立 Project；Project ID 可兼容执行 Workspace key |
| 执行 | 插件内 runner + DSH subagent | 持久 Run/Job/Outbox/Worker + Runtime Adapter |
| 安全 | 插件内 scope + Ticket | 15A Policy/Envelope + 15B Ticket/Gate + RBAC 交集 |
| Context | collab_context scene sessions | Scene Session、Contribution、Cursor、Receipt |
| 可部署性 | 依赖锁定 DSH 版本与 Profile | 独立部署、备份、就绪检查和迁移 |

结论：后续对标目标应是业务契约和用户能力，不是旧插件目录、Slot、命令、
JSON Storage 或旧业务数据。

## 5. 插件级能力矩阵

状态：

- `MIGRATED`：核心能力已落地。
- `STRONGER`：能力已落地，V1 安全或执行面更强。
- `PARTIAL`：核心可用，但有明确缺口。
- `PLANNED`：已在 V1 路线图排期。
- `NON_TARGET`：明确不迁移。

| dsh 能力域 | V1 对应 | 状态 | 说明 |
| --- | --- | --- | --- |
| canary / R0 | 平台健康、契约与 Migration 测试 | NON_TARGET | 宿主安装契约不需要迁移 |
| identity / R1 | Account、Session、Principal、Grant、WorkspaceMember | PARTIAL | Bearer、RBAC、读授权和审计已落地；账号/Workspace 管理由 Batch 20A 补齐 |
| space / R2 | 无 | PLANNED | Batch 19 独立安全评审 |
| roles / R3 | Project Role、Project Template、Teammate Template | PARTIAL | 席位和角色权限已迁移；Persona 资产、Workspace Type、Seat Claim 未单独迁移 |
| workflow | Workflow Definition/Runtime/Governance | MIGRATED | Markdown、分支、审批、循环、子流程、交付物和 Principal 已迁移 |
| task | Task、Queue、Claim、Review、Run | STRONGER | 依赖、needsInput、deliveryTarget、Session Reset、文档和自动验收更完整 |
| meeting | Meeting AI、Delegate、Minutes、Task、File | STRONGER | Batch 18 补齐 Facilitator、私密嘱咐、投递、文件、确认和归档 |
| agent | Agent/Runtime/Binding/Run/Envelope/Gate | STRONGER | 持久 Worker、外部 Runtime、Policy/Ticket/Gate 和 usage receipt 更完整 |
| teammate | Template、Instance、Work Plan、Queue、Report | MIGRATED | 生命周期、自动执行、统计、周报和安全转派已落地 |
| employee | Principal 替代 Employee 产品域 | NON_TARGET / PARTIAL | Employee 目录不迁移；Human Avatar 通用委托独立待规划 |
| memory | Topic、Claim、Truth、Episode、Handoff、Review | MIGRATED | 时间线、来源和幂等摄入已落地 |
| context | Scene Session、Contribution、Cursor、Receipt | STRONGER | 四类入口统一、确定性重放和敏感 Context 隔离已落地 |
| project | Project、Role、Template、Report | PARTIAL | 基础域已迁移；治理元数据、角色草稿确认、审计和产出物待 Batch 20 |
| workbench | Dashboard、Brief、Follow、Risk | PARTIAL | 聚合数据已迁移；布局编辑和 Brief SSE 待 Batch 20 |
| shell | React 自有 Shell | NON_TARGET | 不迁移 DSH Slot 和 Workspace Browser |
| legacy data | 可选 Legacy Retirement | NON_TARGET | 不迁移测试/业务数据；只读归档和下线 |

## 6. 已经完成且不应重复开发

### 6.1 身份与授权

- Human/AI Principal、Account、Credential、Bearer Session。
- Platform/Workspace/Project Grant 分离，Project ADMIN 不绕过 Grant。
- Principal 引用解析边界和项目 owner 双源一致性报告；不承诺旧业务 ID
  长期可用。
- Resource、列表、Trace、SSE、附件和产物的读授权。
- 15A Policy/Envelope、15B Ticket/Gate 与 Worker revision 复核。

### 6.2 Task / Workflow / Meeting / Direct Chat

- 四类入口共用 Run、Job、Outbox、Worker、Runtime Effect 和 Trace。
- Task 队列、优先级、依赖、Claim、pause/block/needsInput/resume。
- Workflow Markdown、分支、审批、循环、子流程、交付物门禁和恢复。
- Meeting AI、Minutes、Action Item、Delegate、私密嘱咐、投递、文件和归档。
- Direct Chat 独立 Scene Session、增量 Context 和幂等回复。

### 6.3 Runtime / Context / Memory

- External Runtime 注册、Probe、Binding、Capability、Preflight 和执行。
- `plain-text` final-only 与 `codex-jsonl` 归一化事件。
- Run usage receipt、Token/成本 unknown 语义、阶段耗时与 reconciliation。
- Scene Session、Contribution、Cursor、Receipt、Replay 和敏感来源排除。
- Memory Claim/Truth/Review/Episode/Handoff。

这些能力不应因 dsh 插件存在旧接口而回退到旧存储或另建第二条执行链路。

## 7. 尚未迁移的功能

### 7.1 Shared Space / 文件协作

未迁移：

- Workspace 共享目录和路径级权限。
- Global Read / Global Write 工具面。
- Global Write 审批、Claim 和 Locks。
- Session Digest / 脱敏摘要。
- 文件审计、符号链接逃逸防护和受控 Agent 工具网关。

现状与风险：

- V1 已有受控 Task 附件、Run Artifact 和 Meeting File，但没有共享工作路径。
- 这是“能力尚未开放”，不是“已开放但失控”。
- 若正式发布承诺 Agent 共享文件写入，该缺口立即升级为 P0；否则按 Batch 19 的 P1
  安全项目处理。

### 7.2 Project Governance

未迁移：

- Project Owner、健康度、进度、开始/目标日期。
- 项目阶段性产出物及按来源追溯。
- 项目历史审计和跨模块事件合并。
- 项目角色草稿 → 确认、整组覆盖、`rolesRevision` 并发保护。
- 角色删除的成员影响确认、工作流模版阻塞和进行中任务改派。
- 已启动工作流实例的角色快照。
- 项目编号全局递增语义；V1 当前是唯一但时间戳型编码。

路线图归属：Batch 20。

### 7.3 Workbench 完整交互

未迁移：

- 七模块标题栏拖拽排序。
- 六档宽度、模块高度、命名布局、默认布局和本地恢复。
- 模块级刷新、stale、partial error 和管理驾驶舱模式容器。
- 模块配置与 Brief 增量 diff 推送。

现状：

- V1 已有 Workbench Dashboard、Brief、Follows、供给例外和供应商风险数据。
- 当前 UI 是固定/聚合型工作面，不是 dsh 的可编排工作台。
- dsh 自身也未实现 Brief SSE 推送，因此该项属于“规划增强”，不是旧功能遗漏。

路线图归属：Batch 20。

### 7.4 Human Avatar / Delegation

优先级：P1，独立待规划，不并入 Batch 20A、19 或 20。

未迁移：

- 通用 Context-bound Human Avatar 委托。
- 委托目标、立场、关注点、允许/禁止动作、有效期和频控。
- pause / extend / revoke / expiry notice。
- Avatar 报告、审计和上下文关联。

现状：

- Batch 18 的 Meeting Delegate 只覆盖会议内 Human/AI 代表与私密嘱咐。
- 它不是可跨 Task、Workflow、Meeting 复用的人类分身授权层。
- Principal 设计明确保留 Human Avatar/Delegation；路线图已将其列为独立待规划
  能力，而不是 Batch 20A/19/20 的子项。

建议：新增独立设计，不要复用 Meeting Delegate 表承载跨场景委托。

### 7.5 Account / Workspace Administration

路线图归属：Batch 20A Identity Administration，优先级 P0，先于 Batch 19。

未迁移或不完整：

- 登录账号邀请/创建、资料更新、启停、Credential 初始化和受控重置。
- 平台角色/Grant 管理 UI 与通用 API。
- Workspace 主表、Workspace 选择、成员管理和管理员界面。
- 账号分页、搜索、身份审计和 Web 管理面。

现状：

- V1 支持管理员 bootstrap、登录、改密、账号启停、Principal/Grant 数据模型。
- 当前 API 没有通用账号创建、平台 Grant 分配和 Workspace 管理面。
- 多用户生产环境不能依赖每个用户都被预置。
- 必须复用 Principal/Account/Credential/AuthSession/WorkspaceMember/RoleGrant，
  不建立第二套身份或权限事实。

### 7.6 通用 Task 外部关联与来源 UI

dsh Task 有显式 `links`，可关联 Meeting/Workflow 并在 Task UI 中追溯。

V1 已有：

- `meeting_tasks` 会议到 Task。
- Workflow Node/Run 到 Task。
- Meeting Traceability。

仍缺：

- 通用 `task_external_links` 契约。
- Task 详情统一展示所有外部来源。
- Issue 与 Task 的产品语义分层。

优先级：P2，不与当前 P0/P1 混淆。

### 7.7 Persona / Workspace Type / Seat Claim

dsh roles 提供：

- Persona 资产库。
- Workspace Type recipes。
- Seat materialization、claim、assign、release。
- Leader election 和开会 Facilitator 系统席位。

V1 已用 Project Role、Project Template 和 Teammate Template 解决部分业务问题，
但没有独立 Persona 资产目录、Workspace Type 和 Seats Claim。

建议与优先级：P2。

- Persona 资产库先作为 NON_TARGET，避免与 Teammate Template 双写。
- Project Role 保留为唯一角色授权事实。
- 若需要“待认领席位/Leader election”，另做明确产品设计，不要复活 dsh assignment
  JSON 双写。

### 7.8 Teammate 产品面残余

dsh 有、V1 未完整对应：

- Avatar/显示资产。
- Template switch。
- Leave workspace。
- 独立 audit-events 浏览和 identity/runtime 聚合详情。
- 活动、日报、角色权限和历史的原始五页签布局。

V1 的核心模板、实例、队列、自动执行、统计、周报和转派已具备。上述多为产品面
差异，优先级 P2，可并入 Batch 20 的体验收口。

### 7.9 DSH Native Session / Agent 观测

dsh 依赖宿主提供的：

- 左侧 native conversation。
- Persistent home session。
- Continuable subagent。
- Provider Session/tool stream。
- Workspace Browser 和 DSH Slot。

V1 明确不迁移这些宿主能力，且 WorkBuddy 保持 plain-text、stdin、final-only。

仍可规划但不属于当前 P0/P1 的增强：

- Provider Session Resume。
- `maxTurns` / `maxToolCalls` / `maxCost` 强制执行。
- 通用 structured plan 和完整搜索/网络证据链。
- Distributed scheduler 和跨进程 Agent runner。

这些项目统一作为 P2 决策项，不与 Identity Administration、Shared Space 或
Project Governance 混排。

## 8. 路线图内待完成任务

### 8.1 Batch 20A：Identity Administration（P0）

前置：Batch 14A-14D 已完成的 Principal、Account、Credential、AuthSession、
WorkspaceMember 和 RoleGrant。

任务：

1. 实现账号邀请、创建、资料更新、启停和 Session 撤销闭环。
2. 实现 Credential 初始化和受控重置；secret 不写日志、不返回不可恢复明文、
   不进入审计。
3. 实现 Platform Role / Platform Grant 的查询、授予、撤销和到期管理。
4. 实现 Workspace 成员、成员状态和 Workspace Grant 管理。
5. 实现账号目录搜索、分页、状态、身份审计和 Web 管理面。
6. 重复邀请、并发更新、archived Principal、disabled Account、revoked/expired
   Grant 必须有稳定错误或幂等结果。
7. 所有操作复用现有身份/权限事实，不新增第二套账号、Grant 或审计。

退出条件：

- 管理员可完成邀请、创建、维护、停用和授权。
- Grant 撤销立即生效；Platform ADMIN 不绕过 Project Grant。
- AI Principal 不能登录，archived Principal 不能获得新授权。
- Repository、Application、API、Web 和多 Principal Playwright 回归通过。

### 8.2 Batch 19：Shared Space（P1）

前置：独立安全评审、15B Ticket/Gate、16 Scene Binding、Principal/RBAC。

任务：

1. 设计 Workspace 共享根、路径 Grant 和默认只读。
2. 拒绝路径穿越、绝对路径、反斜杠、`.`、`..`、符号链接逃逸。
3. 实现 read/write/list/claim/release 的受控工具接口。
4. Global Write 绑定 Ticket、Gate、Actor、Workspace 和资源 Scope。
5. 实现 advisory locks、claim、冲突和过期恢复。
6. 生成脱敏 Session Digest，禁止把凭据或完整敏感正文写入审计。
7. 对文件访问、拒绝、写入、审批和回滚建立只追加审计。
8. 覆盖 Agent/外部 Runtime 文件操作负向测试和多视口 GUI。

退出条件：未授权写、路径逃逸、锁竞争和 Gate 绕过全部 fail closed。

### 8.3 Batch 20：Project Governance + Workbench（P1/P2）

任务：

1. Project Owner、健康度、进度、起止日期和说明补全。
2. 全局可追溯项目编号。
3. 项目产出物登记、阶段/主题筛选和来源追溯。
4. 项目历史审计只追加，并与身份/成员/Grant 事件关联。
5. 项目角色草稿、整组确认、revision 冲突和成员影响确认。
6. 角色下线的工作流模版阻塞与进行中任务改派。
7. Workbench 模块拖拽、六档宽度、高度、布局保存/默认/恢复。
8. Workbench Brief SSE、指标偏好和模块级刷新状态。
9. 管理驾驶舱容器和必要数据权限。
10. Teammate 产品面残余、Avatar 和审计详情按产品优先级收口。

退出条件：并发保护、只追加审计和 1440/900/390 三视口无溢出。

### 8.4 Batch 21：Legacy Retirement（可选 P2）

只保留：

1. 旧 dsh 系统冻结写入。
2. 旧测试/业务数据只读归档和运维级兼容导出。
3. 数据保留期限、访问控制和最终销毁计划。
4. 旧 Session 全部失效，旧环境不可继续登录。
5. 旧 Provider、Runtime、插件和 UI 最终下线。

明确不做：

- 不迁移旧测试/业务数据。
- 不做正式 dry-run、backfill 或历史数据兼容导入。
- 不双写，不保留旧业务 ID/Workspace/Session 在新平台继续可用。
- Batch 21 不阻断 V1 发布。

退出条件：

- 旧系统无写入入口，仅按保留期限只读。
- 归档完整性、访问控制和删除计划有记录。
- 新平台对旧 JSON Storage、旧 Session 和旧插件运行时零依赖。

## 9. 路线图外但仍需决策的任务

| 任务 | 建议优先级 | 原因 |
| --- | --- | --- |
| Human Avatar 通用 Delegation | P1 | Principal 设计明确保留，当前只有 Meeting Delegate |
| Task 通用外部关联与来源 UI | P2 | 跨 Meeting/Workflow 追溯已有局部实现 |
| Persona 资产与 Seat Claim 决策 | P2 | 避免与 Teammate Template/Project Role 双写 |
| Provider Session Resume | P2 | 当前非目标，需 Provider 兼容设计 |
| Runtime 预算硬限制 | P2 | 需 Runtime Capability 与取消协议支持 |
| MFA / SSO / Rate Limit | P2 | Batch 14B 已列为限制，待身份运营和部署评审确认 |
| Teammate 产品面残余 | P2 | 核心生命周期、队列和报告已完成 |

Workspace 主模型、成员和 Grant 管理已纳入 Batch 20A，不再作为路线图外任务。

## 10. P0 评估

### 10.1 代码与安全面

当前未发现新的代码级 P0：

- 15A Envelope、policy revision 和 Run 快照未被 Batch 18 修改。
- 15B Ticket/Gate、Token 和 Worker 复核语义未被绕过。
- Scene Session、Cursor、Receipt 未被 Meeting Collaboration 绕过。
- Meeting 私密嘱咐、Delegate 和归档边界有定向回归。
- Full Vitest、Playwright 和 RBAC/Runtime negative cases 通过。

### 10.2 交付级 P0

| ID | 状态 | 说明 | 解决方式 |
| --- | --- | --- | --- |
| P0-ID-01 | OPEN | 账号、平台 Grant 和 Workspace 成员管理闭环缺失；多用户生产上线仍依赖手工预置 | Batch 20A Identity Administration |
| P0-REL-01 | CLOSED | Batch 14-18 已合入 `main e1dca0d` | 无需另建 release integration 分支 |
| P0-MIG-01 | CLOSED | 产品决定 dsh 测试/业务数据不迁移，V1 白纸启动 | 取消正式数据迁移；Legacy Retirement 可选且不阻断发布 |

当前最终剩余 P0：仅 `P0-ID-01`。

如果 V1 仅做单管理员内部试点，可由部署脚本临时创建账号；进入团队试点前，
Batch 20A 仍是 P0。旧 dsh 数据的只读归档、保留期限和下线属于 P2 运维工作，
不是 P0。

## 11. 建议执行顺序

1. **Batch 20A Identity Administration（P0）**：先补齐多用户生产身份运营。
2. **Batch 19 Shared Space（P1）**：完成独立安全评审和共享写安全边界。
3. **Batch 20 Project Governance + Workbench（P1/P2）**：完成项目治理和工作台。
4. **Human Avatar / Delegation**：独立待规划 P1，不复用 Meeting Delegate。
5. **Batch 21 Legacy Retirement（可选 P2）**：冻结旧系统、只读归档、Session
   失效和下线；不迁移数据。
6. Persona/Seat Claim、Task 外部关联、Provider Resume、预算硬限制、
   MFA/SSO/Rate Limit 保持 P2 决策项。

不建议把 Identity Administration 与 Shared Space 合并；前者是身份运营，后者是
文件写入安全，风险和验证面不同。

## 12. 风险说明

- **身份运营**：账号邀请、Credential 初始化/重置和 Platform Grant 是新的高风险
  管理面；必须复用现有身份事实，避免 secret 泄漏和 Grant 越权。
- **Workspace 模型**：单 Workspace 还是多 Workspace 尚未最终决定；Batch 20A
  只能在现有 WorkspaceMember/RoleGrant 上增量实现，不能引入第二套权限来源。
- **Shared Space**：共享写、Global Write 和 Locks 必须独立安全评审；未开放前
  风险仍是“能力缺失”，而不是“已开放但绕过 Gate”。
- **白纸启动**：旧 dsh 历史数据、业务 ID、Session 和 Workspace 不延续；这是
  已接受的产品决策，不是迁移缺陷。
- **Legacy Retirement**：只读归档仍含敏感业务数据，必须明确访问控制、保留期限
  和最终删除责任人。
- **Human Avatar**：通用委托若直接复用 Meeting Delegate，可能扩大跨场景权限；
  必须独立设计允许/禁止动作和上下文边界。
- **P2 能力**：Provider Resume、预算硬限制、MFA/SSO 等未完成不影响当前白纸
  启动和已完成的 Batch 14-18 范围，但会影响特定部署场景。

## 13. 非目标清单

以下旧能力不按“尚未迁移”计数：

- DSH Shell、Slot、Settings section。
- DSH Workspace Browser、native conversation、左侧 session tree。
- DSH JSON Storage、cordis patch、profile bundle。
- Employee 目录、HR 组织/汇报/部门数据。
- Digital Employee 独立产品入口。
- Task Worker 专用旧 runner 和插件内队列。
- WorkBuddy stream-json、Provider Session 专用解析、工具流解析。
- 旧 dsh 测试/业务数据迁移、正式 dry-run、backfill 和双写。
- 旧业务 ID、旧 Workspace、旧 Session 或旧 alias 在新平台长期可用。

这些能力只保留其业务契约，V1 使用 Principal、PostgreSQL、Run/Worker、Scene 和
自有 Web Shell 重新实现。旧系统只做可选只读归档和最终下线。

## 14. 证据索引

V1：

- [v1-post-batch13-migration-roadmap.md](./v1-post-batch13-migration-roadmap.md)
- [v1-batch14a-identity-principal-rbac-audit.md](./v1-batch14a-identity-principal-rbac-audit.md)
- [v1-batch14b-auth-session.md](./v1-batch14b-auth-session.md)
- [v1-batch14c-rbac-authorization.md](./v1-batch14c-rbac-authorization.md)
- [v1-batch14d-read-authorization.md](./v1-batch14d-read-authorization.md)
- [v1-batch17a-task-execution-depth.md](./v1-batch17a-task-execution-depth.md)
- [v1-batch17b-ai-teammate.md](./v1-batch17b-ai-teammate.md)
- [v1-batch18-meeting-collaboration.md](./v1-batch18-meeting-collaboration.md)

dsh：

- `dsh-pluginmax/README.md`
- `dsh-pluginmax/plugins/dsh-collab-space/README.md`
- `dsh-pluginmax/plugins/dsh-collab-roles/README.md`
- `dsh-pluginmax/plugins/dsh-collab-project/README.md`
- `dsh-pluginmax/plugins/dsh-collab-workbench/README.md`
- `dsh-pluginmax/plugins/dsh-collab-employee/src/service.ts`
- `dsh-pluginmax/docs/project-role-draft-confirm-design.md`
- `dsh-pluginmax/docs/workbench-management-cockpit-prd.md`
- `dsh-pluginmax/docs/meeting-agent-task-session-design.md`

