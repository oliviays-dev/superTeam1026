# Pluginmax V1 核心回归技术测试设计

> 状态：已落地并执行；核心管理员安全缺陷已修复，剩余缺口为 DSH parity 业务能力
>
> 设计日期：2026-10-28
>
> 平台基线：`pluginmax-platform` / `main` / `5b7f7f5bc179ca0435c96126a950e7b3605847f4`
>
> DSH 基线：`dsh-pluginmax` / `feat/external-agent-teammates` / `a702267abfc6baebc7cab7b3045e71c204079e10`
>
> 平台 Migration：32
>
> 配套用户视角设计：[v1-core-regression-user-journey-design.md](./v1-core-regression-user-journey-design.md)

## 1. 目标与边界

本设计回答两个问题：

1. 平台已迁移能力能否通过 Contracts、Database、Application、API、Worker、
   Web 和 Playwright 形成可重复的技术证据。
2. `pluginmax-platform` 是否完整覆盖 `dsh-pluginmax` 的核心用户感知链路。

本轮执行测试并修复测试过程中确认的产品或测试缺陷。修复范围只覆盖管理员安全边界、
测试稳定性、fixture 与 Runbook，不继续实现 Batch 19、Batch 20 或 Batch 21，
不修改 15A Execution Envelope、15B Ticket/Gate、16 Scene Session 语义。

明确排除：

- 正式数据库、正式 Session/Profile、生产业务数据和用户配置。
- DSH Shell、Slot、Workspace Browser、native conversation 和插件宿主安装。
- 旧 JSON Storage、cordis patch、profile bundle、旧业务数据迁移。
- Employee 独立产品域、HR 数据、旧 Plugin UI。
- 旧 Session、Workspace、业务 ID 的长期兼容。
- WorkBuddy 专用 stream-json、Provider Session 和工具流解析。

## 2. 基线与冲突处理

### 2.1 已核实基线

| 对象 | 分支 | HEAD | 工作树 |
| --- | --- | --- | --- |
| 平台 | `main` | `5b7f7f5bc179ca0435c96126a950e7b3605847f4` | 干净 |
| DSH | `feat/external-agent-teammates` | `a702267abfc6baebc7cab7b3045e71c204079e10` | 干净 |

两个本地分支都与各自 `origin` 跟踪分支一致，当前没有 ahead/behind。

平台 `main` 已包含 Batch 20A 的合并提交。`docs/v1-batch20a-identity-administration.md`
中的“本地 commit、未 push”属于旧状态描述，不能作为当前远端事实。

### 2.2 不纳入当前通过证据的提交

`codex/v1-batch20a-identity-hardening` 的
`cac2050344c7c9092e4bb7063f8ee30fefdb97f0` 尚未合入 `main`。该提交包含
“只统计可登录 HUMAN Principal 的平台管理员”和并发管理员变更保护，但本设计
只能把它视为待评审修复，不能当作当前版本已通过证据。

### 2.3 原始 main 缺陷与修复结果

当前 main 的最后一个平台管理员保护只检查是否存在其他 active ADMIN Grant，
并把 AI Principal 或存在 active Account 行的 Principal 计入“可继续管理”的
管理员。它没有同时要求：

- Principal 是 Human。
- Principal 为 active。
- Account 为 active。
- 存在 active 的 scrypt password Credential。
- 并发撤销、停用或重置时对管理员集合加锁。

因此，一个有效人类管理员加一个不可登录的 AI ADMIN 或 pending ADMIN 时，
当前保护可能允许移除最后一个可登录管理员。该问题属于发布阻断候选
`P0-REG-01`。本轮已在不合并 hardening 分支的前提下重新实现修复，并补充
Repository 并发与不可登录管理员回归。当前状态为 `CLOSED`，证据见
`packages/database/src/identity-administration-guards.test.ts`。

## 3. 当前测试证据盘点

### 3.1 测试资产

| 层 | 测试文件 | 静态用例数 | 主要证据 |
| --- | ---: | ---: | --- |
| Contracts | 11 | 50 | DTO、状态机、错误码、unknown 语义 |
| Database | 12 | 43 | Migration、Repository、约束、并发、幂等 |
| Application | 5 | 20 | 授权、Gate、SLA、Runtime 经济、Teammate 计划 |
| API | 21 | 99 | Auth、RBAC、CRUD、SSE、文件、跨项目隔离 |
| Worker | 3 | 9 | Job、Probe、维护效果、恢复 |
| Web 单测 | 1 | 4 | Runtime 可观测性展示 |
| Playwright | 22 个文件，20 个业务用例 | 21 | 主要批次故事线 |

Playwright 当前没有统一 `webServer` 启动配置，多个批次通过不同 shell 脚本准备
数据库、seed、API、Worker、Web 和固定账号。测试存在，但不是一个可独立串行
复用的统一核心回归入口。

### 3.2 本轮实际执行结果

执行日期：2026-10-28。

| 命令 | 环境 | 结果 | 解释 |
| --- | --- | --- | --- |
| `pnpm test` | 未设置 `TEST_DATABASE_URL` | 31 文件通过、32 跳过；156 用例通过、138 跳过 | 只能证明无数据库单元测试，不能证明数据库和 API 集成 |
| `TEST_DATABASE_URL=<隔离临时库> pnpm test` | 独立临时数据库，Migration 32 | 62 文件通过、1 文件失败；293 用例通过、1 失败 | 唯一失败为 `workbench-reports.test.ts` 单用例 5 秒超时 |
| `TEST_DATABASE_URL=<同一隔离库> vitest run apps/api/src/workbench-reports.test.ts` | 同一独立临时数据库 | 1 文件通过；3 用例通过，耗时 4.82 秒 | 失败用例单独复跑通过，判定为负载敏感的偶发超时 |
| `pnpm test:core:technical` | 独立 PostgreSQL，独立 fresh/upgrade 数据库 | fresh、upgrade、Workspace 回填和 64 文件/299 用例全部通过 | 修复后的核心技术回归最终证据 |
| `pnpm test:core:e2e` | bearer 与 local-development 两套隔离数据库和服务 | bearer 7/7、local 5/5 通过 | 12 个核心 GUI 用例，32 张截图 |

上述结果说明：

- “完整 Vitest 通过”不能由默认 `pnpm test` 单独证明。
- 数据库集成测试需要显式 `TEST_DATABASE_URL`。
- 全量运行曾出现一个负载敏感超时；已将对应用例超时提高到 15 秒，最终全量
  64 文件/299 用例通过。
- 文档中历史 “294 tests passed” 不能替代本轮证据。

### 3.3 已有证据能证明什么

- Bearer 登录、伪造 Header 拒绝、账号停用和 Session 撤销有 API 测试。
- Platform ADMIN 不绕过 Project Grant，跨项目读写拒绝有 Repository、API 和
  Playwright 证据。
- 15A Policy、15B Ticket/Gate、16 Scene、17A Task Depth、17B Teammate、18
  Meeting 均有跨层测试。
- Runtime 注册、Probe、Binding、Preflight、执行、取消、超时、final-only 和
  unknown usage 有较完整证据。
- Task、Meeting、Memory、Report、Handoff、Attachment、Artifact、Trace、SSE
  和跨项目读取存在定向负向测试。

### 3.4 原始缺口与关闭状态

- 默认 `pnpm test` 不设置数据库时仍会跳过集成用例；新增
  `test:core:technical` 强制使用隔离数据库并执行完整测试，已关闭核心回归入口缺口。
- 已新增统一 `test:core:e2e`，按 bearer 和 local-development 两阶段串行执行。
- 已覆盖“有效 HUMAN ADMIN + AI/pending/disabled ADMIN”的最后一个管理员保护。
- 已覆盖 Platform 和 Workspace ADMIN 的并发撤销、停用或移除。
- 已统一保存命令、退出码、服务日志、fixture、manifest 和三视口截图。
- fixture 不再包含密码，密码通过 `CORE_REGRESSION_PASSWORD` 运行时环境注入。
- 自动敏感信息扫描未命中密码、Authorization Header 或 Bearer Token。
- Shared Space、Project Governance、可配置 Workbench 和 Human Avatar 仍未被证明
  覆盖，状态继续为 `PARTIAL` 或 `MISSING`。

## 4. 测试分层与证据规则

### 4.1 分层职责

| 层 | 必须先证明 | 不应承担 |
| --- | --- | --- |
| Contracts | DTO、枚举、错误码、状态转换、未知值语义 | 数据库权限和真实执行 |
| Database | Migration、约束、事务、锁、索引、只追加审计 | HTTP 和 UI |
| Application | 授权编排、Policy/Envelope、Ticket/Gate、结算 | HTTP 传输细节 |
| API | 认证、RBAC、CRUD、分页、搜索、SSE、下载、错误边界 | Worker 外部进程 |
| Worker | Claim、租约、恢复、取消、超时、重试、外部 Runtime | 业务授权真相 |
| Web | Capability 可见性、校验、加载/空/错态、刷新恢复 | 服务端最终边界 |
| Playwright | 用户历程、多 Principal 隔离、三视口和失败恢复 | 代替底层并发与契约测试 |

### 4.2 证据状态

| 状态 | 使用条件 |
| --- | --- |
| `VERIFIED` | 当前基线、指定命令实际执行成功，退出码和产物已记录 |
| `PARTIAL` | 测试存在，但只覆盖部分条件或只覆盖单层 |
| `SKIPPED` | 因环境或依赖未执行，不得写成通过 |
| `BLOCKED` | 对应产品能力尚不存在，无法形成用户等价证据 |
| `PLANNED` | 已设计但尚未实现或执行 |

### 4.3 单次执行记录

每次回归必须记录：

- 平台和 DSH 实际 SHA、分支、工作树状态。
- 命令原文、开始/结束时间、退出码、通过/失败/跳过数量。
- `DATABASE_URL` 的逻辑数据库名，不记录 secret。
- API、Worker、Web、PostgreSQL 进程 PID、端口和健康状态。
- 截图、trace、API/Worker 日志和测试数据摘要路径。
- 每个失败的唯一用例名、首个错误、是否可复现、复跑结果。
- 清理结果，包括临时数据库、Schema、容器和 `.tmp` 文件。

### 4.4 敏感信息规则

- 密码、激活 Token、Session Token、Credential secret 只允许存在于进程内存和
  测试运行时。
- 不写入 Markdown、JSON fixture、命令日志、截图、Playwright trace 或提交。
- fixture 只保存账号 ID、Principal ID、角色和资源 ID，不保存明文 secret。
- 失败日志如可能包含 Authorization Header，必须先脱敏再归档。
- 测试结束后检查 `.tmp` 中的常见 token/password 关键字，命中即视为证据失败。

## 5. 测试数据设计

### 5.1 账号与 Principal

| Key | 类型 | 状态 | 用途 |
| --- | --- | --- | --- |
| `admin-a` | Human Principal + Account | active Platform ADMIN | 团队初始化主管理员 |
| `admin-b` | Human Principal + Account | active Platform ADMIN | 最后管理员并发保护 |
| `admin-ai` | AI Principal + AI ADMIN Grant | active，不可登录 | 验证 AI 不能计为可用管理员 |
| `admin-pending` | Human Principal + pending Account | active ADMIN Grant | 验证无 active Credential 不计为可用管理员 |
| `workspace-admin` | Human Principal | active Workspace ADMIN | Workspace 管理和最后管理员保护 |
| `project-owner` | Human Principal | active Project Owner | 项目执行 |
| `project-member-1` | Human Principal | active Member | 任务、评论、附件、Review |
| `project-member-2` | Human Principal | active Member | 协作、会议和隔离 |
| `outsider` | Human Principal | active 非成员 | 负向隔离 |
| `disabled-account` | Human Principal + disabled Account | disabled | 登录拒绝 |
| `archived-principal` | Human Principal | archived | 新授权和资源访问拒绝 |
| `pending-invite` | Human Principal + pending Account | pending | 一次性激活 |
| `revoked-grant` | Human Principal + revoked Project Grant | active Principal | 撤销即时生效 |
| `expired-grant` | Human Principal + expired Project Grant | active Principal | 过期即时拒绝 |
| `teammate-ai` | AI Principal + active Teammate | active | AI 执行 |

平台管理员至少准备两个可登录账号。单一管理员只能验证基础拒绝，不能验证并发
保护。

### 5.2 Workspace 与 Project

- 2 个 Workspace：`ws-team-a`、`ws-team-b`。
- 至少 2 个 Project：`project-main`、`project-other`。
- 每类 Grant 都有 active、revoked、expired 三种状态。
- 至少一个 archived Project，用于只读历史和写入拒绝。
- 至少一个 archived Workspace，用于成员和 Grant 写拒绝。

### 5.3 业务资源

- 2 个 Task：普通可执行 Task、依赖阻塞 Task。
- 1 个 Workflow Definition、1 个 Instance、1 个审批节点、1 个交付 Gate。
- 1 个 Meeting、1 个 AI 参与者、1 条私密嘱咐、1 份 Minutes。
- 1 个 Direct Chat Thread 和独立 Scene Session。
- 1 个 Teammate Template、1 个 Instance、1 个 Work Plan、1 个 Work Item。
- 1 个 Runtime、1 个 Probe、1 个 Binding、1 个 Preflight、1 个 Run。
- 1 个 Memory Topic、Claim、Truth、Review、Episode、Handoff。
- 1 个 Project Report、1 个 Brief、1 个 Follow、1 个 Supply Exception、
  1 个 Supplier Risk。
- 1 个 Task Attachment、1 个 Meeting File、1 个 Run Artifact。

### 5.4 数据创建规则

1. 优先通过公开 API 或 Application 创建。
2. 只有 archived、expired、并发与恢复状态无法由 API 形成时，才允许写独立测试
   数据库。
3. 直接写库数据必须记录表名、约束原因、前置版本和清理 SQL。
4. 所有 ID 使用测试命名空间，例如 `core-20261028-*` 或固定 UUID。
5. 每个脚本必须可重复执行，重复创建返回稳定 201/200/409，不产生第二套事实。
6. 清理必须只针对本命名空间，不能删除共享数据库中的其他 Schema 或数据。

## 6. 技术回归套件

### 6.1 T01 Contracts

覆盖：

- Project、Task、Workflow、Meeting、Runtime、Scene、Teammate、Memory、
  Workbench 和 Identity DTO。
- 状态转换不允许未知值。
- stable error code 与 HTTP status 映射。
- Provider、模型、Runtime、Token、成本和时间未知值保持 `unknown`，不伪造 0。
- Capability、Policy、Envelope、Ticket 和 Gate 只能收窄权限。

退出条件：

- `pnpm --filter @pluginmax/contracts typecheck`
- Contracts Vitest 全通过。
- 新增或变化字段有正负 schema 用例。

### 6.2 T02 Database 与 Migration

覆盖：

- fresh `0 -> 32`。
- upgrade `31 -> 32`。
- upgrade `23 -> 32`，保留 Project、Run、Ticket、Scene 和审计历史。
- Migration 32 Workspace 回填、`workspace_members.version` 默认值和索引。
- Principal、Account、Credential、Grant、Session 约束。
- `identity_audit_events`、Grant、Run Event 和 Ticket 历史的只追加或版本化行为。
- active Grant 唯一性、过期判断、Grant 撤销和乐观锁。
- 并发管理员变更、并发成员变更、并发 Grant 创建。
- Audit 和敏感字段扫描，不出现 password/token/secret。

必须新增的负向回归：

1. 两个有效平台管理员：
   - 并存撤销两个 Grant，恰好一个成功。
   - 并存停用两个账号，至少一个成功但仍保留一个可登录管理员。
2. 一个有效管理员，另一个是 AI ADMIN：
   - 不允许撤销、停用或重置最后一个可登录管理员。
3. 一个有效管理员，另一个是 pending Account ADMIN：
   - 不允许把 pending 账号当作可继续管理。
4. 一个有效管理员，另一个 Credential 已 disabled：
   - 不允许移除最后一个可登录管理员。
5. Workspace 使用同样矩阵。

当前状态：`CLOSED`。新增 5 个管理员边界用例，覆盖只统计可登录 Human ADMIN、
并发撤销、并发停用、archived Principal 拒绝新 Workspace Grant、Workspace
ADMIN 并发移除和 pending ADMIN 不计为可用管理员。

### 6.3 T03 Application 与授权编排

覆盖：

- Platform、Workspace、Project Grant 互不继承。
- Platform ADMIN 不绕过 Project Read/Write/Approve。
- revoked/expired Grant 对后续请求立即失效。
- archived Project 允许授权成员只读历史，拒绝写。
- archived Principal、disabled Account、过期 Session fail closed。
- Task、Workflow、Meeting、Direct Chat 共用 Preflight。
- Envelope、Ticket、Gate revision 不一致时拒绝执行。
- deny-wins、策略只收窄、Ticket 不超出 Principal 和 Context Scope。
- Worker 重试不重复副作用。

退出条件：

- Application 定向测试全通过。
- 每个拒绝有稳定 reason，不只断言 403。
- 允许与拒绝都产生可追溯审计。

### 6.4 T04 API 认证与 RBAC

正向：

- Platform ADMIN 邀请账号、激活、登录、创建 Workspace、授权成员。
- Project Owner 创建 Project、角色、成员、Task、Workflow 和 Meeting。
- Project Member 完成被授权写操作。
- AI Principal 通过专用执行路径工作，不使用 Human Bearer。

负向：

- 无 Bearer、伪造 trusted Header。
- 非成员、跨 Workspace、跨 Project。
- revoked/expired Grant。
- disabled Account、archived Principal。
- AI Principal 获取 Human Session。
- Platform ADMIN 直接读取无权 Project。
- archived Project 写操作。
- 错误 Cursor、越界分页、非法搜索。

并发与幂等：

- 重复邀请和重复 Grant 返回稳定冲突或相同结果。
- `Idempotency-Key` 的重复请求不产生二次副作用。
- SSE 重连从 `afterSeq` 继续，不重复或漏事件。
- Attachment/Artifact 下载不能通过未认证 URL 或跨项目 ID 绕过。

### 6.5 T05 Worker 与 Runtime

覆盖：

- Job Claim 只有一个 Worker 获得租约。
- 过期租约恢复后旧 Worker 被 fencing。
- cancel、timeout、retry、dead-letter。
- Outbox 与 Runtime Effect 幂等。
- External Runtime probe 成功前不可执行。
- Binding revision、Runtime revision、Capability snapshot 不可变。
- `plain-text` final-only stdout。
- `codex-jsonl` 事件归一化。
- Provider/Token/cost unknown 语义保留。
- Worker 重启、取消、超时后业务状态一致。

当前状态：`PARTIAL`。已有 Worker 和 Runtime 测试，但核心旅程尚未统一编排成一条
可独立执行的回归。

### 6.6 T06 Web 与 Playwright

Web 层覆盖：

- 按 Capability 显示按钮、入口、禁用态。
- 表单必填、格式、长度、冲突提示。
- 加载、空、部分失败、错误、重试。
- 刷新恢复和权限变化后重新请求。
- 1440、900、390 三视口文本不遮挡、无水平溢出、布局不跳动。
- 失败时保留 trace、截图、API/Worker 日志和数据摘要。

禁止只通过 DOM 中存在按钮判定权限。每个关键 Capability 必须有 API 负向反证。

## 7. DSH 能力到平台等价链路

状态定义：

- `EQUIVALENT`：用户核心链路等价。
- `STRONGER`：平台更完整或安全边界更强。
- `PARTIAL`：存在关键缺口，不可记为完整覆盖。
- `MISSING`：无可用替代链路。
- `NON_TARGET`：明确不迁移并有产品理由。

### 7.1 Parity Matrix

| ID | DSH 用户能力 | 旧用户历程 | 平台等价历程 | 平台源码与测试证据 | 状态 | 风险 |
| --- | --- | --- | --- | --- | --- | --- |
| P01 | 登录账号、密码、Session、启停 | 创建账号、登录、改密、退出 | Admin 邀请、一次性激活、登录、重置、停用 | `apps/api/src/app.ts` auth/admin routes；`apps/api/src/auth.test.ts`；`identity-administration.test.ts` | `STRONGER` | 最后一个管理员保护已修复，见 `P0-REG-01 CLOSED` |
| P02 | Human/AI Principal 与迁移别名 | 账号、Employee、Teammate 主体映射 | Human/AI Principal、Alias、禁 AI 登录 | `packages/database/src/identity-principal-schema.test.ts`；`authorization-repository.test.ts` | `STRONGER` | 旧 ID 不再长期兼容 |
| P03 | Workspace 成员、角色和 Grant | 工作区成员、owner/member/guest | Workspace 成员、Workspace Grant、Workspace ADMIN | `IdentityAdministrationView.tsx`；`identity-administration.test.ts` | `STRONGER` | 最后 Workspace ADMIN 需同矩阵验证 |
| P04 | 平台/工作区/项目角色授权 | 账号角色、项目席位、权限 | Platform/Workspace/Project Grant 与 Capability | `authorization.ts`；`authorization.test.ts`；`read-authorization.test.ts` | `STRONGER` | 必须持续证明不隐式继承 |
| P05 | Project 创建、模板、成员、日报 | 创建工作区、应用模板、成员、日报 | Project、Template、Role、Report | `project-templates.test.ts`；`workbench-reports.test.ts` | `EQUIVALENT` | 未覆盖治理字段 |
| P06 | Project 负责人、健康度、进度、日期、产出物、历史审计 | 项目概览、治理编辑、历史 | 平台仅有 name/code/description/status | `packages/contracts/src/platform.ts`；DSH `dsh-collab-project/src/index.ts` | `PARTIAL` | P1 发布阻断候选 |
| P07 | 项目角色草稿、确认、revision、影响提示、实例快照 | 导角色、确认、删除影响 | 无等价草稿确认链路 | DSH `roles/confirm`；平台 `app.ts` 仅直接 CRUD | `MISSING` | P1 发布阻断候选 |
| P08 | Task CRUD、指派、评论、附件、Review | 建任务、指派、沟通、验收 | Task、Message、Attachment、Review | `task-collaboration.spec.ts`；`task-execution-depth.test.ts` | `EQUIVALENT` | 无 |
| P09 | Task 队列、依赖、Claim、暂停、输入、转派、归档 | 队列、暂停、补充、改派 | 队列、Claim、blocked、needsInput、resume、transfer | `task-execution-depth.spec.ts`；`task-execution-depth.test.ts` | `STRONGER` | 需统一用户旅程证据 |
| P10 | Workflow 导入、校验、分支、审批、循环、子流程、交付物 | 导入、启动、审批、返工、交付 | Markdown、审批、Gate、快照、恢复和审计 | `workflow-markdown.spec.ts`；`workflow-runtime.spec.ts`；`workflow-governance.spec.ts` | `STRONGER` | 已有证据分散在多个脚本 |
| P11 | Meeting 参会、AI、代表、嘱咐、Minutes、Task、File、归档 | 建会、邀请 AI、纪要、行动项、归档 | Meeting Facilitation、Delegate、私密嘱咐、Minutes、Task、File | `meeting-collaboration.spec.ts`；`meeting-decisions.spec.ts`；API tests | `EQUIVALENT` | 需要完整单旅程 |
| P12 | Direct Chat、Scene、增量 Context、Cursor、Receipt、重放 | 单独会话与上下文 | Direct Chat、Scene Session、Cursor、Receipt、Replay | `ai-direct-chat.spec.ts`；`scene-context.spec.ts`；Repository tests | `STRONGER` | 无 |
| P13 | Teammate 模板、实例、计划、队列、自动执行、统计、周报、转派 | 管理 AI伙伴并派活 | Template、Instance、Work Plan、Auto Run、Report | `ai-teammate.spec.ts`；`teammates.test.ts`；`teammate.test.ts` | `EQUIVALENT` | 产品面残余见 P14 |
| P14 | Teammate Avatar、切换模板、离开 Workspace、聚合审计 | 管理 AI伙伴资料与历史 | 核心生命周期存在，部分产品动作缺失 | `TeammatesView.tsx`；DSH teammate routes | `PARTIAL` | P2 |
| P15 | Runtime 注册、Probe、Binding、Preflight、Run、取消、超时、重试 | 配外部 Agent，预检并执行 | 同一执行面，持久 Worker 与 Envelope/Gate | `external-runtime-gui.spec.ts`；`external-runtime-execution.test.ts`；Worker tests | `STRONGER` | 需最终统一烟雾 |
| P16 | Memory Claim、Truth、Review、Episode、Handoff | 提炼、审核、交接 | 同域模型和来源追溯 | `memory-closure.spec.ts`；`dependency-memory.spec.ts` | `EQUIVALENT` | 无 |
| P17 | Workbench 指标、Brief、Follow、风险、供给例外 | 打开工作台、阅读简报、关注 | 固定模块 Dashboard、Brief、Follow、风险 | `workbench-reports.spec.ts`；`OperationsViews.tsx` | `EQUIVALENT` | 不含可配置布局 |
| P18 | Workbench 拖拽、六档宽度、高度、命名布局、默认/恢复、模块刷新、SSE | 自定义工作台并接收增量 | 平台固定模块网格，15 秒轮询，无布局编辑和 Brief SSE | `OperationsViews.tsx`；DSH `workbench/client/index.js`；`workbench/src/index.ts` | `PARTIAL` | P1 发布阻断候选 |
| P19 | Management cockpit 模式入口与容器 | 切换管理驾驶舱 | 平台有模式入口和占位容器 | `OperationsViews.tsx`；DSH workbench client | `EQUIVALENT` | 双方业务数据完整度均有限 |
| P20 | Task/Meeting/Artifact 文件与下载隔离 | 上传、下载、按权限访问 | Attachment、Meeting File、Artifact 受 Project RBAC | `app.ts` download routes；`read-authorization.test.ts` | `EQUIVALENT` | 不覆盖共享目录 |
| P21 | Workspace Shared Space、路径 Grant、Global Write、Locks、Digest、审计 | 共享文件、审批写、锁和摘要 | 无共享目录、无路径授权、无 Global Write、无 Locks | DSH `dsh-collab-space`；平台无对应 route/table/test | `MISSING` | P1 发布阻断候选 |
| P22 | Human Avatar 通用 Delegation、暂停、延期、撤销、过期、报告 | 真人在 Task/Meeting/Workflow 派分身 | Meeting Delegate 仅覆盖会议，不是跨场景 Delegation | 平台 meeting delegate；DSH `dsh-collab-employee`/delegation | `MISSING` | P1 |
| P23 | Persona 资产库 | 创建和复用 SOUL/Persona | Teammate Template/SOUL 可部分替代，无独立 Persona 目录 | `TeammatesView.tsx`；`teammates.test.ts` | `PARTIAL` | P2 |
| P24 | Workspace Type、Seat Claim、Leader election | 工作区配方、认领席位、Leader | Project Role/Template 部分替代，无认领和历史席位语义 | `project-templates.ts`；DSH `dsh-collab-roles` | `PARTIAL` | P2 |
| P25 | Task 通用 external links 与来源 UI | 从 Task 追溯 Meeting/Workflow | Meeting Task 和 Workflow 关联存在，无统一 Task links | `meeting_tasks`；Workflow Run；Task Detail | `PARTIAL` | P2 |
| P26 | Employee 目录和 Employee 产品域 | 员工、数字员工、治理中心 | Principal 替代，Employee 不作为 V1 产品域 | `platform-principal-rbac-design.md` | `NON_TARGET` | 需保持 Principal 可追溯 |
| P27 | DSH Shell、Slot、Workspace Browser、native conversation | 宿主导航和会话树 | 自有 React Shell，不迁移宿主体验 | `apps/web/src/App.tsx` | `NON_TARGET` | 不能误算功能遗漏 |
| P28 | JSON Storage、cordis patch、profile bundle、旧数据 | 旧 Profile 与持久化 | PostgreSQL 白纸启动，不迁移旧数据 | `v1-post-batch13-migration-roadmap.md` | `NON_TARGET` | Legacy Retirement 可选 |
| P29 | Provider Session、stream-json、工具流解析 | WorkBuddy/Provider 专用体验 | plain-text final-only，不解析专用流 | `v1-batch13.1a-runtime-compatibility.md` | `NON_TARGET` | 不提供 Provider Resume |
| P30 | Host canary 与插件安装契约 | 安装 canary、宿主健康 | 平台自有 health/ready/migration | `apps/api/src/app.test.ts` | `NON_TARGET` | 宿主契约不进入产品验收 |

### 7.2 Parity 统计

| 状态 | 数量 | 说明 |
| --- | ---: | --- |
| `STRONGER` | 8 | Identity、RBAC、Task Depth、Workflow、Scene、Runtime 等 |
| `EQUIVALENT` | 8 | Project 基础、Task 基础、Meeting、Teammate 核心、Memory、Workbench 基础等 |
| `PARTIAL` | 6 | Project Governance、Workbench 配置、Teammate 产品残余、Persona、Seat、Task links |
| `MISSING` | 3 | Project Role Draft/Confirm、Shared Space、Human Avatar |
| `NON_TARGET` | 5 | Employee 产品域、DSH 宿主、旧数据、Provider 专用流、canary |
| 合计 | 30 | 仅按用户感知能力计数，不按插件目录计数 |

项目治理的总体判断仍是 `PARTIAL`，因为基础项目域可用；P07 草稿确认治理链单独
计入 `MISSING`。

### 7.3 发布判断

修复后仍不能表述为“完整覆盖 DSH 核心用户感知链路”。仍存在：

- `P1-PAR-01`：Shared Space 缺失。
- `P1-PAR-02`：Project Governance 和 Role Draft/Confirm 缺失。
- `P1-PAR-03`：Workbench 可配置布局和 Brief SSE 缺失。
- `P1-PAR-04`：通用 Human Avatar Delegation 缺失。

若 V1 发布说明不承诺 DSH 完整对等，上述业务缺口可作为产品降级披露；若承诺
“完整覆盖 DSH 核心链路”，它们全部是发布阻断项。

## 8. 平台能力、技术测试、GUI 旅程、测试数据与证据状态

| 能力 | 技术测试 | GUI 旅程 | 测试数据 | 目标证据状态 |
| --- | --- | --- | --- | --- |
| 团队初始化与身份运营 | T01、T02、T03、T04 | U1 | `admin-a/b`、`pending-invite`、Workspace A | `VERIFIED` |
| Project 基础与成员 | T01、T03、T04 | U2、U6 | `project-owner`、`project-main` | `PARTIAL` |
| Project Governance | T01、T03、T04 | U2 | 治理字段和角色草稿 | `BLOCKED` |
| Task 基础与深度 | T01、T03、T04、T05 | U2、U3、U7 | Task、dependency、review、attachment | `VERIFIED` 局部 |
| Workflow | T01、T03、T04、T05 | U2、U7 | Workflow、approval、gate、artifact | `VERIFIED` 局部 |
| Meeting 闭环 | T01、T03、T04、T05 | U5 | Meeting、AI、briefing、minutes、file | `VERIFIED` 局部 |
| Direct Chat 与 Scene | T01、T03、T04、T05 | U3、U7 | thread、scene、receipt | `VERIFIED` 局部 |
| AI Teammate | T01、T03、T04、T05 | U4 | template、instance、plan、queue | `VERIFIED` 局部 |
| Runtime | T01、T02、T04、T05 | U4、U7 | runtime、probe、binding、run | `VERIFIED` 局部 |
| Memory | T01、T03、T04 | U5、U7 | claim、truth、episode、handoff | `VERIFIED` 局部 |
| Workbench 基础 | T01、T03、T04 | U2、U5 | reports、brief、follows、risk | `VERIFIED` 局部 |
| Workbench 配置与 SSE | T01、T04、T06 | U7 | layouts、stale/partial state | `BLOCKED` |
| 文件与下载隔离 | T03、T04 | U3、U5、U6 | attachment、meeting file、artifact | `VERIFIED` 局部 |
| 多 Principal 负向隔离 | T02、T03、T04、T06 | U6 | outsider、revoked、disabled、archived | `VERIFIED` 局部 |
| 全旅程恢复 | T02、T04、T05、T06 | U7 | 可重试 Run、Gate、并发管理员 | `VERIFIED` |

## 9. 执行顺序与门禁

### 9.1 环境门禁

1. 确认两个仓库 HEAD 和工作树。
2. 使用独立 Worktree、独立 PostgreSQL 数据库或 Schema、独立 `.tmp`。
3. 分配不与现有进程冲突的 API、Web、PostgreSQL 端口。
4. 分别设置 bearer 与 local-development 两套认证环境，以及各自的
   `DSH_HOME`、`FILE_STORE_ROOT`、`AGENT_WORKSPACE_ROOT`。
5. 确认测试数据库 Migration 为空，执行 fresh `0 -> 32`。
6. 确认没有连接正式数据库 URL。

### 9.2 推荐执行顺序

1. Contracts。
2. Database Migration fresh 和 upgrade。
3. Repository 约束、并发、审计。
4. Application 授权、Policy、Ticket、Gate。
5. API 正向和负向隔离。
6. Worker、Outbox、Runtime 执行与恢复。
7. Web 构建与静态检查。
8. Playwright U1-U7 串行。
9. 汇总退出码、失败、截图、trace、日志和数据摘要。
10. 清理测试数据库、Schema、进程和 `.tmp`，保留脱敏证据。

### 9.3 停止条件

出现以下任一情况立即停止发布判定：

- Migration 失败或 fresh/upgrade 结果不一致。
- 可登录管理员可被降为零。
- 非成员、跨 Project 或 revoked Grant 仍可读资源。
- 密码、Token、Credential secret 出现在审计、日志、截图或 fixture。
- 未授权下载 Attachment、Artifact 或 Meeting File。
- Gate 被绕过或 Run 重试产生重复副作用。
- 关键截图存在水平溢出、文本遮挡或不可操作状态。

## 10. 已落地 Runbook

统一入口：

```bash
pnpm test:core:technical
pnpm test:core:e2e
```

分阶段调试：

```bash
CORE_E2E_PHASE=bearer pnpm test:core:e2e
CORE_E2E_PHASE=local pnpm test:core:e2e
```

默认隔离端口：

- PostgreSQL：`54440`
- bearer API/Web：`4540` / `4541`
- local-development API/Web：`4560` / `4561`

`CORE_REGRESSION_KEEP_ENV=1` 可保留 Compose 环境用于诊断；默认会删除数据库、
进程、网络和容器。

### 10.1 证据目录

```text
.tmp/core-regression/<run-id>/
├── manifest.json
├── logs/
│   ├── api.log
│   ├── worker.log
│   └── web.log
├── bearer/
│   ├── playwright-results/
│   └── screenshots/
├── local/
│   ├── playwright-results/
│   └── screenshots/
├── bearer-fixture.json
└── summary.txt
```

### 10.2 环境变量

```text
PLUGINMAX_ROOT
DATABASE_URL
AUTH_MODE=bearer
API_PORT
WEB_PORT
DSH_HOME
FILE_STORE_ROOT
AGENT_WORKSPACE_ROOT
RBAC_E2E_FIXTURE_PATH
PLUGINMAX_WEB_BASE_URL
CORE_REGRESSION_RUN_ID
CORE_E2E_PHASE
CORE_REGRESSION_PASSWORD
CORE_REGRESSION_KEEP_ENV
```

### 10.3 证据汇总要求

`manifest.json` 至少包含：

- 两个仓库 SHA。
- Migration 版本。
- 命令、退出码、数量。
- 测试数据命名空间。
- 截图、trace、日志路径。
- 失败用例和复跑结果。
- 清理状态。

## 11. 当前发布阻断与优先修复

| ID | 优先级 | 状态 | 说明 |
| --- | --- | --- | --- |
| `P0-REG-01` | P0 | CLOSED | 已修复最后一个可登录 Platform/Workspace ADMIN 保护并补齐并发回归 |
| `P1-REG-01` | P1 | CLOSED | 新增核心技术回归入口，强制隔离数据库并执行完整测试 |
| `P1-REG-02` | P1 | CLOSED | 新增两阶段核心 GUI 回归、seed、manifest 和证据归档 |
| `P1-REG-03` | P1 | CLOSED | Workbench 用例超时调整到 15 秒，最终全量测试通过 |
| `P1-PAR-01` | P1 | OPEN | Shared Space 未实现 |
| `P1-PAR-02` | P1 | OPEN | Project Governance 与角色草稿确认未实现 |
| `P1-PAR-03` | P1 | OPEN | Workbench 布局、模块状态和 Brief SSE 未实现 |
| `P1-PAR-04` | P1 | OPEN | 通用 Human Avatar Delegation 未实现 |
| `P2-REG-01` | P2 | CLOSED | 核心回归已统一收集三视口截图与 Playwright 输出 |
| `P2-REG-02` | P2 | OPEN | Teammate 产品残余、Persona、Seat Claim、Task links 未覆盖 |

## 12. 完成定义

技术回归设计落地完成必须同时满足：

1. fresh `0 -> 32` 和 upgrade `31 -> 32` 在隔离数据库通过。
2. 含数据库的完整 Vitest 通过并记录数量。
3. 最后一个 Human ADMIN 正向和并发负向全部通过。
4. U1-U7 Playwright 在 1440、900、390 三视口串行通过。
5. 每条关键能力有测试、数据、命令和证据位置。
6. Shared Space、Project Governance、Workbench 和 Human Avatar 明确标记
   `PARTIAL` 或 `MISSING`，不得伪装为通过。
7. 没有 secret 进入任何归档证据。
8. 测试数据、数据库、容器和进程完成清理。

## 13. 本轮设计优化

执行结果修正了原设计中的五个假设：

1. **认证模式必须分阶段。** 现有 Playwright 同时包含 bearer 和
   local-development 故事线，不能在一个服务进程中混跑。Runbook 现按两个独立
   数据库、端口和进程阶段执行。
2. **密码不应进入 fixture。** `core-regression-seed.ts` 只写 ID、登录名和状态，
   Playwright 通过 `CORE_REGRESSION_PASSWORD` 获取运行时密码。
3. **环境清理必须包含 Compose。** 仅删除数据库会遗留容器和端口。技术脚本和
   GUI 脚本现在默认执行 `compose down -v`。
4. **共享 seed 字段必须可配置。** 会议 GUI 曾硬编码 seed 显示名，现已改为读取
   fixture 的 `displayName`，避免跨套件数据耦合。
5. **容器启动需要 ready 轮询。** 仅等待 `pg_isready` 不足以避免初始化竞态，
   脚本现在同时检查 Compose health 和真实 `SELECT 1`。
