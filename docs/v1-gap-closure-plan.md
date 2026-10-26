# Pluginmax V1 功能缺口收敛计划

> 状态：Batch 13 发布门禁已通过；其余 V1 深化项继续执行
>
> 界面基线：与原 DSH 项目保持一致，采用 264px 左侧导航、DSH 风格明暗主题
> Token、工作台六栏卡片、项目双栏、任务四列看板和 AI 伙伴双栏。

## 1. 已完成

- 独立 Web、API、Worker 和 PostgreSQL。
- 项目、任务、Run、ContextPack、文件产物、验收和基础记忆。
- Fake Runtime、DSH SDK Adapter 与外部 Agent Runtime 均已接入 V1。
- 执行输入快照、ContextPack 来源、Run 事件、实时文本、最终输出和交付物展示。
- 原项目一致的全局导航与主要页面布局。
- 工作台六栏模块、项目目录与详情、任务四列看板、工作流、沟通和 AI 伙伴页面。
- AI 伙伴创建、编辑、启停、SOUL、工作场景、目标、工具、版本和活动记录。
- 线性工作流和基础会议。
- 全平台 E2E smoke。
- 项目成员、职责、项目角色库和成员角色分配；Local Admin 作为项目 owner
  自动补入，owner 不可移除或停用。
- 项目角色可解析为任务和 Agent 工作流步骤的实际执行 AI。
- 任务前置依赖、循环校验、派发门禁和详情编辑。
- 项目 Memory Topic、Claim 状态、Current Truth 版本和来源链。
- Playwright 浏览器回归和独立依赖/记忆/任务协作 API smoke。
- 任务评论回复、完整活动时间线和附件上传/下载/归档/复原。
- 工作流 Markdown 导入、确定性结构校验和 Node/Edge 图持久化。
- Agent 工作流节点自动派发 Run、人工验收门禁和交付物检查。
- 条件分支、审批、受控循环、子流程、超时重试、暂停恢复和运行审计。

## 2. 待完成

### 2.1 项目治理

- [x] 项目基础信息更新与归档。
- [x] 项目成员、职责和项目角色。
- [x] 项目角色与任务、工作流派发共用。
- [x] 项目模板。
- [x] 项目日报。

### 2.2 任务管理

- [x] 验收标准编辑。
- [x] 任务评论和基础活动记录。
- [x] 评论回复与完整任务活动时间线。
- [x] 文件上传、下载和任务附件。
- [x] 前置任务依赖。

### 2.3 Context 与 Memory

- [x] 项目 Topic、Claim、Current Truth 时间线。
- [x] Handoff Card 和 Review 队列。
- [x] Agent 私有 Episode 与项目过滤。
- [x] 会议自动摄入；任务 Review 已自动写入 Topic/Claim/Truth。

### 2.4 工作流

- [x] Markdown 导入和确定性校验。
- [x] 条件分支、审批、循环和子流程。
- [x] Agent 节点自动派发 Run。
- [x] 交付物门禁和退回（Agent Task 验收 + Artifact 检查）。

### 2.5 会议

- [x] AI 伙伴自动发言。
- [x] 会议纪要版本。
- [x] 行动项自动落任务。
- [x] AI 一对一私聊。

### 2.6 工作台

- [x] 每日简报生成与已读状态。
- [x] 关注覆盖规则。
- [x] 供给例外和供应商风险接入真实数据。

### 2.7 工程保障

- [x] 定期源码和数据库备份。
- [x] OpenTelemetry 或等价 Run 追踪。
- [x] Playwright 浏览器自动化回归。
- [x] Migration 0→23、20→23、22→23 兼容门禁与完整发布回归。

### 2.8 Agent Runtime

- [x] 外部 Runtime 注册、探测、启停、归档和审计。
- [x] 受控 Command + argv 安全执行边界。
- [x] `codex-jsonl` 与 `plain-text` 的 V1 Runtime Adapter。
- [x] AI 伙伴绑定外部 Runtime、Preflight、能力降级和不可用原因。
- [x] 外部 Runtime 通过 Worker/Run/Outbox 执行、取消、超时、失败和幂等回写。
- [x] `/api/v1` 外部 Runtime 管理接口与 GUI。

> 当前结论：Pluginmax Platform V1 已完成 Runtime 注册、绑定、Preflight、
> Adapter、Worker 执行、GUI 和发布门禁。任务、Workflow Task、会议 AI 与私聊均可
> 通过受控外部假 CLI 执行；真实 Provider Session resume、危险 sandbox 和任意 shell
> 仍不在范围内。验收记录见 `docs/v1-batch13-release-gate.md`。

## 3. 批次执行记录

批次 3A 已交付：项目成员与项目角色。

验收：

- 新建和既有项目都有且仅有一位 Local Admin owner。
- 项目可添加活跃 AI 伙伴成员，并维护职责、状态和角色。
- 项目角色可新增、改名、改说明和删除；被成员使用的角色不能删除。
- 成员角色必须属于当前项目，owner 不能被移除或停用。
- `/api/v1/projects/:projectId/members` 与
  `/api/v1/projects/:projectId/roles` 覆盖完整读写链路。
- 旧 Run、Worker、任务派发和 Runtime 路径不变。

批次 3B 已交付：任务依赖与结构化记忆。

验收：

- 任务可声明前置依赖并在派发时校验。
- Memory 可维护 Topic、Claim 和 Current Truth 版本。
- 项目角色复用于任务和工作流派发。
- 上述能力不改变现有页面主布局。

批次 4：任务协作与执行治理。

验收：

- 任务评论支持回复并形成完整活动时间线。
- 任务附件支持上传、读取、归档和权限校验。
- 工作流 Markdown 导入通过确定性校验，并能标识循环和悬空引用。
- Agent 节点可通过项目角色解析执行人并自动派发 Run。
- 交付物门禁失败时保留运行证据并阻止节点完成。

批次 5：工作流运行时。

验收：

- 条件求值确定性选择分支，并记录选择/跳过边。
- 用户和项目角色均可作为审批人；越权审批被拒绝。
- 循环必须同时有退出条件和明确上限。
- 子流程支持父子关系、成功/失败传播和调用链循环校验。
- Agent 节点支持 timeout、重试、幂等、暂停恢复和重复请求防护。
- 实例详情可查询节点迁移、分支、审批、重试和失败原因。
- Migration 10 可升级旧线性实例，旧 steps 数据保持可读。

批次 13：External Agent Runtime Integration（已完成 Batch 13A-E 与 Phase 6
发布门禁）。

排期位置：Batch 12B 已收口并提交后，Batch 13 才进入实现；不得回写、扩展或重开
Batch 12B 功能范围。

目标：

- 外部 Runtime 注册、探测、启停、归档、权限和审计进入 `/api/v1`。
- Command 只允许受控可执行文件与 argv 数组，禁止 shell 拼接、管道、重定向和命令替换。
- V1 Agent Runtime 新增 `codex-jsonl`、`plain-text` Adapter，所有模型调用仅由 Worker 执行。
- AI 伙伴可绑定外部 Runtime；停用、归档、探测失败和能力不足必须在派发前拦截。
- Runtime Capability、Execution Envelope、Provider Session、Run/Trace、取消、超时、
  重试、失败原因和幂等回写进入统一 Run 视图。
- 不支持结构化事件的 Runtime 明确降级为 summary/final-only，不伪造计划或工具步骤。

验收与完整阶段清单见 Batch 13 文档。
Phase 6 的兼容、迁移、完整 Vitest、完整 Playwright、GUI 和安全边界结果见
`docs/v1-batch13-release-gate.md`。
