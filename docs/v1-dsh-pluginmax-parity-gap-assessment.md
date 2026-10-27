# Pluginmax V1 与 dsh-pluginmax 能力对照及 P0 评估

> 状态：只读审计完成
>
> 审计日期：2026-10-27
>
> V1 对照基线：`feat/v1-batch18-meeting-collaboration` / `bb1510cce7ea628990f7d61c20d8aa91a09c92a1`
>
> dsh 对照基线：`feat/external-agent-teammates` / `a702267abfc6baebc7cab7b3045e71c204079e10`

## 1. 审计范围与基线说明

用户所称 `dsd-pluginmax` 在当前工作区对应
`/Users/oliviayang/Codex/一切皆插件/dsh-pluginmax`，本文按实际仓库名
`dsh-pluginmax` 记录。

`/Users/oliviayang/Codex/pluginmax-platform` 的 `main` 当前停在
`222c01c1474cdab3845e1c0d6c4b9fb643b3fc22`，只覆盖到 Batch 13.1B。
为避免把旧 main 误当成完整 V1，本次以已完成的 Batch 18 worktree
`bb1510c` 作为平台功能对照面。

审计仅基于源码、Migration、Contracts、测试和设计文档，不读取正式数据库、
正式 Session/Profile、原始业务数据或用户生产配置。

## 2. 结论摘要

1. dsh-pluginmax 是依赖 DSH Slot、Storage Domain、WebServer、Workspace
   Registry 和 subagent 的 14 插件套件；V1 是独立 PostgreSQL、Fastify、React、
   API、Worker 平台，不应按插件目录做 1:1 平移。
2. 项目、任务、工作流、会议、AI 伙伴、记忆、Context、外部 Runtime、RBAC 和
   Worker 主链路已经迁移，部分能力在 V1 中更强。
3. 尚未迁移的主要产品域是 Shared Space、项目治理完整面、工作台可配置布局、
   Human Avatar 通用委托，以及完整 Legacy Closeout。
4. DSH Shell、Slot、Workspace Browser、原生 conversation、JSON Storage 和
   Employee 产品页属于明确的非迁移目标，不应计入“功能遗漏”。
5. 在已完成的 Batch 18 代码与安全边界内，没有发现新的代码级 P0。
6. 从“发布当前 V1”与“替换 dsh-pluginmax”的交付视角，仍存在 3 个 P0：
   - 最新实现未合入 `pluginmax-platform/main`；
   - 团队账号、平台角色和工作区管理未形成可用闭环；
   - 旧 DSH 数据只有 synthetic dry-run，没有获批的正式迁移来源和 backfill。

## 3. 严重度定义

| 级别 | 定义 |
| --- | --- |
| P0 | 阻断安全生产发布、正式团队上线或 dsh 数据切换；必须先解决 |
| P1 | 关键能力缺口或显著兼容风险，有临时绕行但不能视为完成 |
| P2 | 产品体验、运营便利、非核心兼容或后续增强 |
| Non-target | 明确不进入 V1 目标，不按缺口处理 |

“代码级 P0”和“交付级 P0”需要区分。当前 P0 主要是交付与产品闭环问题，
不是已知的 Run、Ticket、Gate、Scene 或权限放行漏洞。

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

结论：迁移目标应是业务契约和用户能力，不是旧插件目录、Slot、命令或存储结构。

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
| identity / R1 | Account、Session、Principal、Alias、Grant | MIGRATED | Bearer、RBAC、读授权和审计已落地；账号管理工作区仍缺 |
| space / R2 | 无 | PLANNED | Batch 19 独立安全评审 |
| roles / R3 | Project Role、Project Template、Teammate Template | PARTIAL | 席位和角色权限已迁移；Persona 资产、Workspace Type、Seat Claim 未单独迁移 |
| workflow | Workflow Definition/Runtime/Governance | MIGRATED | Markdown、分支、审批、循环、子流程、交付物和 Principal 已迁移 |
| task | Task、Queue、Claim、Review、Run | STRONGER | 依赖、needsInput、deliveryTarget、Session Reset、文档和自动验收更完整 |
| meeting | Meeting AI、Delegate、Minutes、Task、File | STRONGER | Batch 18 补齐 Facilitator、私密嘱咐、投递、文件、确认和归档 |
| agent | Agent/Runtime/Binding/Run/Envelope/Gate | STRONGER | 持久 Worker、外部 Runtime、Policy/Ticket/Gate 和 usage receipt 更完整 |
| teammate | Template、Instance、Work Plan、Queue、Report | MIGRATED | 生命周期、自动执行、统计、周报和安全转派已落地 |
| employee | Principal 替代 Employee 产品域 | NON_TARGET / PARTIAL | Employee 目录不迁移；Human Avatar 通用委托仍有能力缺口 |
| memory | Topic、Claim、Truth、Episode、Handoff、Review | MIGRATED | 时间线、来源和幂等摄入已落地 |
| context | Scene Session、Contribution、Cursor、Receipt | STRONGER | 四类入口统一、确定性重放和敏感 Context 隔离已落地 |
| project | Project、Role、Template、Report | PARTIAL | 基础域已迁移；治理元数据、角色草稿确认、审计和产出物待 Batch 20 |
| workbench | Dashboard、Brief、Follow、Risk | PARTIAL | 聚合数据已迁移；布局编辑和 Brief SSE 待 Batch 20 |
| shell | React 自有 Shell | NON_TARGET | 不迁移 DSH Slot 和 Workspace Browser |

## 6. 已经完成且不应重复开发

### 6.1 身份与授权

- Human/AI Principal、Account、Credential、Bearer Session。
- Platform/Workspace/Project Grant 分离，Project ADMIN 不绕过 Grant。
- Alias 兼容解析和项目 owner 双源一致性报告。
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

未迁移：

- 通用 Context-bound Human Avatar 委托。
- 委托目标、立场、关注点、允许/禁止动作、有效期和频控。
- pause / extend / revoke / expiry notice。
- Avatar 报告、审计和上下文关联。

现状：

- Batch 18 的 Meeting Delegate 只覆盖会议内 Human/AI 代表与私密嘱咐。
- 它不是可跨 Task、Workflow、Meeting 复用的人类分身授权层。
- Principal 设计明确保留 Human Avatar/Delegation，但当前路线图没有独立批次。

建议：新增独立设计，不要复用 Meeting Delegate 表承载跨场景委托。

### 7.5 Account / Workspace Administration

未迁移或不完整：

- 登录账号邀请/创建、资料更新和初始密码流程。
- 平台角色/Grant 管理 UI 与通用 API。
- Workspace 主表、Workspace 选择、成员管理和管理员界面。
- 账号分页、搜索、审计查看和 Credential 维护。

现状：

- V1 支持管理员 bootstrap、登录、改密、账号启停、Principal/Grant 数据模型。
- 当前 API 没有通用账号创建、平台 Grant 分配和 Workspace 管理面。
- 多用户生产环境不能依赖每个用户都被预置。
- 路线图只记录“多 Workspace 模型待决策”，没有明确交付批次。

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

优先级：P1/P2，取决于是否仍要求 dsh Task/Issue 双语义。

### 7.7 Persona / Workspace Type / Seat Claim

dsh roles 提供：

- Persona 资产库。
- Workspace Type recipes。
- Seat materialization、claim、assign、release。
- Leader election 和开会 Facilitator 系统席位。

V1 已用 Project Role、Project Template 和 Teammate Template 解决部分业务问题，
但没有独立 Persona 资产目录、Workspace Type 和 Seats Claim。

建议：

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
差异，优先级 P2，可并入 Batch 20 收口。

### 7.9 DSH Native Session / Agent 观测

dsh 依赖宿主提供的：

- 左侧 native conversation。
- Persistent home session。
- Continuable subagent。
- Provider Session/tool stream。
- Workspace Browser 和 DSH Slot。

V1 明确不迁移这些宿主能力，且 WorkBuddy 保持 plain-text、stdin、final-only。

仍可规划但不属于本迁移目标的增强：

- Provider Session Resume。
- `maxTurns` / `maxToolCalls` / `maxCost` 强制执行。
- 通用 structured plan 和完整搜索/网络证据链。
- Distributed scheduler 和跨进程 Agent runner。

## 8. 路线图内待完成任务

### 8.1 Batch 19：Shared Space

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

### 8.2 Batch 20：Project Governance + Workbench

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

### 8.3 Batch 21：Legacy Compatibility Closeout

任务：

1. 扩展 dry-run 覆盖全部需要迁移的 dsh 域，而不只当前 8 个 Principal/RBAC 域。
2. 明确唯一获批旧快照、账号大小写、多 Employee 合并、owner 权威和 alias 冲突规则。
3. 输出 Employee/Principal、Task、Workflow、Meeting、Memory、Context、Workbench
   兼容导出。
4. 执行真实 import dry-run，输出新增、复用、冲突、缺失、跳过和 blocked 报告。
5. 在独立数据库完成 approved backfill，不读取或覆盖正式数据。
6. 建立 alias 使用率、废弃期限和旧 Provider/Runtime 处置计划。
7. 确认旧 Session 不迁移，所有用户重新认证。
8. 保留历史 Run、Ticket、Gate、ContextPack、Receipt 和审计可读。

退出条件：旧数据映射、冲突报告、回滚和兼容读取全部可验证。

## 9. 路线图外但仍需决策的任务

| 任务 | 建议优先级 | 原因 |
| --- | --- | --- |
| 账号邀请/创建与平台 Grant 管理 | P0/P1 | 多用户生产上线必需，当前仅 bootstrap/status |
| Workspace 主模型和管理界面 | P1 | 当前只有 workspace_members/Grant 结构，无完整消费面 |
| Human Avatar 通用 Delegation | P1 | Principal 设计明确保留，当前只有 Meeting Delegate |
| Task 通用外部关联与来源 UI | P1/P2 | 跨 Meeting/Workflow 追溯已有局部实现 |
| Persona 资产与 Seat Claim 决策 | P2 | 避免与 Teammate Template/Project Role 双写 |
| Provider Session Resume | P2 | 当前非目标，需 Provider 兼容设计 |
| Runtime 预算硬限制 | P2 | 需 Runtime Capability 与取消协议支持 |
| 登录 Rate Limit / MFA / SSO | P1/P2 | Batch 14B 已列为限制，取决于部署边界 |

## 10. P0 评估

### 10.1 代码与安全面

当前未发现新的代码级 P0：

- 15A Envelope、policy revision 和 Run 快照未被 Batch 18 修改。
- 15B Ticket/Gate、Token 和 Worker 复核语义未被绕过。
- Scene Session、Cursor、Receipt 未被 Meeting Collaboration 绕过。
- Meeting 私密嘱咐、Delegate 和归档边界有定向回归。
- Full Vitest、Playwright 和 RBAC/Runtime negative cases 通过。

### 10.2 交付级 P0

| ID | P0 | 影响 | 建议动作 |
| --- | --- | --- | --- |
| P0-REL-01 | 最新 Batch 18 实现不在 `main` | 部署 main 会缺 Batch 14-18；无法把当前能力视为正式发布 | 建 release integration 分支，合入 Batch 14-18，重跑完整门禁 |
| P0-ID-01 | 账号和 Workspace 管理闭环缺失 | 只能 bootstrap 管理员；无法正常邀请/维护团队账号和平台 Grant | 新增 Identity Administration 收口，至少账号邀请、角色 Grant、Workspace 成员管理 |
| P0-MIG-01 | dsh 数据尚无正式迁移 | 无法替换现有 dsh 的用户、项目、任务、工作流、会议和历史关系 | 完成 Batch 21 的正式 dry-run、批准来源、backfill 和回滚演练 |

条件说明：

- 如果是全新单管理员内部试点，`P0-ID-01` 可临时由部署脚本建号；一旦进入团队试点即为 P0。
- 如果只使用全新 V1 数据库，`P0-MIG-01` 不影响启动；一旦承诺替换 dsh 即为 P0。
- `P0-REL-01` 与业务范围无关，发布当前实现前必须解决。

## 11. 建议执行顺序

1. 先做 release integration，把 Batch 14-18 收敛到正式发布分支并重跑完整门禁。
2. 与 Batch 19 并行启动 Identity Administration 设计，至少覆盖账号邀请、平台 Grant、
   Workspace 成员和审计。
3. Batch 19 完成 Shared Space 安全边界。
4. Batch 20 完成 Project Governance、Workbench 和 Teammate 产品面收口。
5. 单独设计 Human Avatar / Delegation，不复用 Meeting Delegate。
6. Batch 21 完成全量迁移 dry-run、正式 backfill、兼容导出和别名退出。

不建议把 Shared Space 与 Identity Administration 塞进同一批实施；前者是文件安全，
后者是身份运营，风险面不同。

## 12. 非目标清单

以下旧能力不按“尚未迁移”计数：

- DSH Shell、Slot、Settings section。
- DSH Workspace Browser、native conversation、左侧 session tree。
- DSH JSON Storage、cordis patch、profile bundle。
- Employee 目录、HR 组织/汇报/部门数据。
- Digital Employee 独立产品入口。
- Task Worker 专用旧 runner 和插件内队列。
- WorkBuddy stream-json、Provider Session 专用解析、工具流解析。

这些能力只保留其业务契约，V1 使用 Principal、PostgreSQL、Run/Worker、Scene 和
自有 Web Shell 重新实现。

## 13. 证据索引

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

