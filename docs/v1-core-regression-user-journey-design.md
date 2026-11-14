# Pluginmax V1 核心用户历程回归设计

> 状态：用户视角测试设计已执行；管理员安全边界通过，DSH parity 业务缺口仍存在
>
> 设计日期：2026-10-28
>
> 平台基线：`main` / `5b7f7f5bc179ca0435c96126a950e7b3605847f4`
>
> DSH 对照基线：`feat/external-agent-teammates` / `a702267abfc6baebc7cab7b3045e71c204079e10`
>
> 技术视角设计：[v1-core-regression-technical-test-design.md](./v1-core-regression-technical-test-design.md)
>
> 本轮执行报告：[v1-core-user-journey-execution-report-20261028.md](./v1-core-user-journey-execution-report-20261028.md)

## 1. 设计目的

本文从用户视角定义 V1 发布前的核心回归旅程。测试对象是用户能否完成工作、
理解状态、恢复失败并确认权限边界，不是 DSH 插件目录、Slot、JSON Storage、
Shell 或内部实现是否逐项对应。

每个旅程必须可以：

- 独立执行。
- 使用确定、命名空间隔离的合成测试数据。
- 串行复用同一批 Principal、Workspace 和 Project。
- 在 1440、900、390 三视口检查。
- 产生截图、trace、API/Worker 日志和数据摘要。
- 明确区分 `PASS`、`PARTIAL`、`BLOCKED`、`FAIL`。

## 2. 参与者与测试数据

| 用户 | 身份 | 预期可见范围 | 在旅程中的职责 |
| --- | --- | --- | --- |
| 平台管理员 A | active Platform ADMIN | 身份管理全量，不自动读取所有 Project | U1 团队初始化 |
| 平台管理员 B | 第二个 active Platform ADMIN | 身份管理全量 | U7 验证最后管理员并发保护 |
| Workspace 管理员 | active Workspace ADMIN | 指定 Workspace 管理面 | U1、U6 |
| 项目 Owner | 项目 Owner + Project Grant | 被授权 Project | U2 项目执行 |
| 项目 Member 1 | Project Member | 被授权 Project | U3 协作 |
| 项目 Member 2 | Project Member | 被授权 Project | U3、U5 |
| 外部成员 | 非 Project Member | 无项目数据 | U6 负向 |
| 停用账号 | disabled Account | 无法登录 | U6 |
| 归档 Principal | archived | 无法获得新授权 | U6 |
| 撤销 Grant 用户 | active Principal + revoked Grant | 撤销后立即无 Project 权限 | U6 |
| 邀请中用户 | pending Account | 无登录能力，可完成一次性激活 | U1 |
| AI Teammate | AI Principal | 仅被授权 Project | U4 |
| AI Meeting 代表 | Meeting Delegate | 仅在会议委托范围 | U5 |

固定业务数据：

- Workspace A：团队 A。
- Workspace B：隔离用团队 B。
- Project Main：主项目。
- Project Other：跨项目隔离。
- Task A：可执行任务。
- Task B：依赖阻塞任务。
- Workflow W：含审批和交付 Gate。
- Meeting M：含 AI 参与者和私密嘱咐。
- Runtime R：Fake 或受控 External Runtime。
- Artifact/Attachment/Meeting File：各一个。

所有用户名和资源名带同一个运行 ID，避免并行和重跑污染。

## 3. 全局体验标准

每个页面和操作都必须满足：

### 3.1 可见性

- 有权限操作可见且可用。
- 无权限操作不可见或明确禁用。
- 禁用状态说明原因，用户知道应联系谁或补充什么权限。
- 隐藏按钮不是权限证明，直接 URL/API 仍必须拒绝。

### 3.2 状态

- 加载态有操作反馈，不只显示空白。
- 空态说明当前没有什么、下一步能做什么。
- 部分失败时保留其他可用区域，并指出失败模块。
- 错误态可理解、可重试，不暴露内部堆栈或 secret。
- 刷新后状态与服务器一致，不显示已撤销权限下的旧操作入口。

### 3.3 布局

- 1440、900、390 宽度无水平页面滚动。
- 按钮、标题、状态、时间、ID 不互相遮挡。
- 表单错误靠近对应字段。
- hover、禁用、加载和状态变化不导致关键布局跳动。
- 移动端可完成全部核心动作，不以“仅桌面可用”替代。

### 3.4 安全

- 截图、trace 和 fixture 中没有密码、Token、激活凭据或 Credential secret。
- 对非成员不显示项目名称、任务标题、文件名、Run 输出或错误细节。
- 撤销 Grant 后，页面刷新和直接 API 都立即失效。

## 4. U1 团队初始化

目标：平台管理员能从零完成团队、账号、Workspace 和角色初始化，新成员能自行激活
并登录。

前置：

- 系统无正式数据，独立测试数据库已完成 Migration 32。
- 平台管理员 A、B 已通过受控 bootstrap 建立。
- Workspace B、Project Main 尚不存在。

步骤：

1. 平台管理员 A 登录。
2. 打开“账号与权限”，搜索空目录并确认空态可理解。
3. 邀请项目 Owner，选择一次性激活凭据。
4. 确认激活凭据只显示一次，页面没有将明文写入审计或历史。
5. 创建一个 Workspace A，并将 Owner 加为成员。
6. 给 Owner 授予 Workspace 角色。
7. 授予 Owner 创建 Project 所需的显式权限。
8. Owner 使用一次性凭据激活账号并首次登录。
9. Owner 修改密码并重新登录。
10. 平台管理员 B 登录，确认账号和 Workspace 目录可见。

必须验证：

- 重复邀请同一登录 ID 返回可理解冲突，不生成重复账号。
- 未激活账号不能登录。
- 已停用账号不能登录。
- AI Principal 不能使用登录表单。
- Platform ADMIN 能管理身份，但未加入 Project 时不能读取 Project 数据。
- 最后两个可登录平台管理员并存时，不能把管理员集合降为零。

本轮执行结果：

- 原始 main 对“有效管理员 + AI ADMIN 或 pending ADMIN”的最后一个管理员保护不足。
- 本轮已修复并通过 Repository、API 和 GUI 回归，`P0-REG-01` 状态为 `CLOSED`。

通过标准：Owner 能完成激活和首次登录；身份、Workspace 和审计状态一致。

## 5. U2 项目执行

目标：Project Owner 从 Project 创建走到 Task、Workflow、Meeting 和工作台汇总。

前置：

- U1 已完成。
- Owner 拥有 Project Main 的 manage/write/approve。

步骤：

1. Owner 创建 Project Main，填写名称、编号和说明。
2. 创建或应用一个项目角色。
3. 添加 Member 1、Member 2 和 AI Teammate。
4. 创建 Task A，设置执行者、验收条件和截止时间。
5. 创建 Task B，并设置依赖 Task A。
6. 导入或创建一个 Workflow，包含任务、审批和交付 Gate。
7. 创建 Meeting M，邀请 Member 和 AI Teammate。
8. 打开 Workbench，检查待办、关注、风险和会议摘要区域。
9. 刷新页面，确认项目、角色、Task、Workflow 和 Meeting 均恢复。

必须验证：

- 无权限成员看不到角色管理和成员管理按钮。
- Task B 在依赖完成前不能执行。
- Workflow 校验失败时显示具体节点和原因。
- Workbench 汇总只包含 Owner 可读 Project。

用户视角差异：

- Project 负责人、健康度、进度、起止日期、产出物和项目历史审计在当前平台没有完整
  GUI 链路，本轮标记 `PARTIAL`。
- DSH 的项目角色草稿确认、整组生效、revision 冲突和成员影响提示在当前平台没有
  等价入口，标记 `BLOCKED`。
- Workbench 固定模块可用，但拖拽排序、六档宽度、高度、命名布局、默认和恢复没有
  等价入口，标记 `PARTIAL`。

通过标准：Project 基础、Task、Workflow 和 Meeting 创建链路通过；治理和布局缺口
单独记录，不混入通过。

## 6. U3 成员协作

目标：普通 Member 只看到被授权 Project，并能完成评论、附件、Review 和会议参与。

前置：

- U2 已完成。
- Member 1 只有 Project Main 的 read/write。
- Member 1 不是 Project Other 成员。

步骤：

1. Member 1 登录。
2. 检查项目列表只出现 Project Main。
3. 打开 Task A，更新进度并添加评论。
4. 上传一个合成附件并重新打开下载。
5. 提交 Task A 到 Review。
6. Owner 打开 Task A，查看评论和附件，退回答辩意见。
7. Member 1 看到退回原因，补充输入并重新提交。
8. Member 2 参加 Meeting，查看共享消息和 Minutes 草稿。
9. Member 1 刷新页面，确认任务时间线和附件仍存在。
10. Member 1 用直接 URL 尝试打开 Project Other 的 Task、Run、Meeting、
    Attachment 和 Artifact。

必须验证：

- 非成员访问全部返回拒绝，不泄露资源是否存在。
- 附件和 Artifact 下载必须携带认证。
- Review 需要 approve 权限，普通 write 不能代替 approve。
- 评论、附件、Review 和时间线顺序稳定。

通过标准：授权协作完成，直接 URL 越权全部拒绝。

## 7. U4 AI 执行

目标：用户创建或选择 AI Teammate，通过受控 Runtime 完成工作并看到 Run、产物、
统计和最终状态。

前置：

- U2 已创建 Project Main 和 AI 成员。
- Runtime R 已注册，Probe 成功，Binding 有效。
- 使用 Fake 或受控 External Runtime，不依赖真实模型凭证。

步骤：

1. Owner 打开 AI Teammate。
2. 创建 Teammate Template，填写角色、SOUL、场景和目标。
3. 创建 Teammate Instance，绑定 Runtime R。
4. 输入工作计划，生成受限 Work Plan。
5. 将 Task A 派发给 Teammate。
6. 查看 Preflight 结果和 Envelope。
7. 执行 Run，观察 queued、running、completed 或 failed。
8. 打开 Run 详情，查看事件、Context、Ticket、Gate、产物和 usage。
9. 检查 Teammate 当前工作、统计和周报。
10. 触发一次失败，再重试并确认没有重复产物。

必须验证：

- Runtime 未 Probe 成功前不能执行。
- 无 Ticket、过期 Ticket、Gate 拒绝时不启动外部进程。
- `plain-text` 只展示 final-only 最终输出。
- Token/成本 unknown 显示为 unknown，不显示 0。
- 取消、超时和重试有明确用户状态。
- 刷新后 Run 状态和产物不丢失。

通过标准：AI 执行闭环完成，失败恢复和 unknown 语义可理解。

## 8. U5 会议闭环

目标：会议从创建、AI 参与、私密嘱咐、Minutes 到行动项转 Task 和归档完整闭环。

前置：

- U2 已创建 Meeting M。
- AI Teammate 是有效 Project Member。
- Member 1、Member 2 可参会。

步骤：

1. Owner 打开 Meeting M，检查参会者和主持人。
2. 邀请 AI Teammate 或创建 AI 代表。
3. 给 AI 代表添加一条私密嘱咐，只有委托人和 AI 可见。
4. AI 在会议中回复，其他成员看到消息但不看到私密内容。
5. 发起 Minutes 生成。
6. 编辑 Minutes 并确认发布。
7. 从行动项创建 Task。
8. 上传 Meeting File 并下载。
9. Owner 或主持人归档 Meeting。
10. 刷新页面，确认 Minutes 版本、行动项、文件和追溯链。
11. Member 1 尝试读取私密嘱咐、归档写操作和 Cross-project Meeting。

必须验证：

- 私密嘱咐不进入其他 Principal 的 Context 或页面。
- Minutes 并发修改出现 revision 冲突，不静默覆盖。
- 行动项转 Task 幂等，不创建重复 Task。
- 归档后的 Meeting 只读。
- 文件下载受 Project 权限约束。

通过标准：会议、私密信息、Minutes、行动项、文件和归档全部可追溯。

## 9. U6 权限负向与隔离

目标：从非成员、跨 Workspace/Project、撤销 Grant、停用账号和归档 Principal 的
真实用户路径证明服务端边界。

前置：

- Project Main、Project Other 和两个 Workspace 已存在。
- 准备 revoked、expired、disabled、archived 四类状态。

步骤：

1. 未登录用户直接打开 Project、Task、Run、Meeting、Attachment 和 Artifact URL。
2. 非成员登录后直接打开上述 URL。
3. Platform ADMIN 未加入 Project Main，直接打开 Project Main。
4. Member 1 使用 Project Main 的身份读取 Project Other。
5. Platform ADMIN 撤销 Member 1 的 Project Grant。
6. Member 1 不刷新页面先尝试写；刷新后再尝试读写。
7. 停用 Member 2 的账号，使用旧 Session 访问。
8. 归档 Principal 后尝试新增 Grant。
9. Workspace A 管理员尝试访问 Workspace B。
10. 非成员尝试通过分页、搜索、Trace、SSE 和 Workbench 聚合读取数据。

必须验证：

- 每个入口都拒绝，不只页面按钮消失。
- 错误不泄露资源名称、存在性或内部细节。
- Grant 撤销立即生效。
- 停用账号立即撤销现有 Session。
- archived Principal 不能获得新授权。
- Workspace 与 Project 权限不互相继承。

通过标准：所有负向路径 fail closed，安全缺陷为零。

## 10. U7 恢复与并发

目标：刷新、重试、取消、Gate、Credential 重置和并发管理员操作后状态一致。

步骤：

1. 在 Task 详情和 Run 执行中刷新页面。
2. 取消 queued Run 和 running Run。
3. 模拟 Runtime 超时，确认失败原因和重试入口。
4. 重试 Run，确认产物和业务回写不重复。
5. 创建 blocking Gate，审批通过后恢复。
6. 创建 blocking Gate，拒绝后终止。
7. Owner 签发 Credential 重置，确认现有 Session 撤销。
8. 两个平台管理员并发撤销对方 Grant。
9. 两个平台管理员并发停用对方账号。
10. 两个 Workspace 管理员并发撤销对方 Grant。
11. 在三个视口检查错误态、加载态、禁用态和刷新恢复。

必须验证：

- 并发管理员操作不会把有效管理员集合降为零。
- AI ADMIN、pending Account ADMIN 和 disabled Credential 不被当成可登录管理员。
- 取消、超时、拒绝和重试后的 Run、Task、Job、Outbox 和事件一致。
- 页面刷新后不显示已经失效的批准、取消或重试入口。
- 失败证据可定位，但不包含 secret。

当前状态：

- 最后一个管理员并发保护已修复，定向并发测试通过。
- Workbench 配置、模块级 stale/partial error 和 Brief SSE 没有等价 UI，相关步骤
  标记 `BLOCKED`，不用轮询结果冒充 SSE。

通过标准：恢复链路状态一致，管理员边界安全，三视口可用。

## 11. 旅程覆盖矩阵

| 用户能力 | U1 | U2 | U3 | U4 | U5 | U6 | U7 | 当前判断 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 登录、邀请、激活 | 核心 |  |  |  |  | 负向 | 重置 | `VERIFIED` |
| Workspace 与成员 | 核心 |  |  |  |  | 负向 | 并发 | `VERIFIED` |
| Platform/Workspace/Project Grant | 核心 | 核心 |  |  |  | 核心 | 核心 | `VERIFIED` 局部 |
| Project 创建与成员 |  | 核心 |  |  |  | 负向 |  | `VERIFIED` 局部 |
| Project Governance |  | 缺口 |  |  |  |  |  | `BLOCKED` |
| Task 基础与深度 |  | 核心 | 核心 |  |  | 负向 | 恢复 | `VERIFIED` 局部 |
| Workflow 与 Gate |  | 核心 |  |  |  | 负向 | 恢复 | `VERIFIED` 局部 |
| Meeting 闭环 |  | 入口 | 参与 | 参与 | 核心 | 负向 |  | `VERIFIED` 局部 |
| Direct Chat 与 Scene |  |  | 参与 |  | 追溯 | 负向 | 刷新 | `VERIFIED` 局部 |
| AI Teammate |  | 配置 |  | 核心 | 参与 | 负向 | 重试 | `VERIFIED` 局部 |
| Runtime |  |  |  | 核心 |  | 负向 | 核心 | `VERIFIED` 局部 |
| Memory |  |  |  |  | 核心 | 负向 |  | `VERIFIED` 局部 |
| Workbench 基础 |  | 汇总 |  |  | 汇总 | 负向 | 刷新 | `VERIFIED` 局部 |
| Workbench 配置与 SSE |  | 缺口 |  |  |  |  | 缺口 | `BLOCKED` |
| Attachment/File/Artifact |  |  | 核心 | 产物 | 核心 | 核心 |  | `VERIFIED` 局部 |
| Shared Space |  |  |  |  |  |  |  | `BLOCKED` |
| Human Avatar Delegation |  |  |  |  | 部分 |  |  | `BLOCKED` |

## 12. 三视口检查

每个旅程至少检查：

| 视口 | 重点 |
| --- | --- |
| 1440 x 960 | 信息密度、双栏布局、表格和长 ID |
| 900 x 960 | 侧栏、双栏折叠、按钮换行、表单宽度 |
| 390 x 844 | 主导航、卡片堆叠、任务字段、文件下载和错误态 |

自动断言：

- `document.documentElement.scrollWidth - window.innerWidth <= 2`。
- 关键按钮和输入在视口内可点击。
- 关键标题、状态、时间和 ID 不重叠。
- 加载到完成的布局高度变化不导致关键控件跳动。
- 截图可人工复核，不能只看 DOM。

## 13. 证据要求

每个旅程保存：

- 开始和结束时间。
- 使用的 Principal 和资源逻辑 Key。
- 截图：每个关键状态至少一张。
- Playwright trace：失败时保留，成功时保留关键旅程。
- API 和 Worker 日志：脱敏后保存。
- 失败请求 status、code、requestId。
- 刷新和恢复后的状态摘要。
- 清理状态。

禁止保存：

- 明文密码。
- 激活 Token。
- Session Token。
- Credential secret。
- Authorization Header。
- 正式用户配置或旧生产业务数据。

## 14. 发布判定

### 14.1 可判定通过

必须同时满足：

- U1、U2、U3、U4、U5、U6、U7 核心断言通过。
- `P0-REG-01` 关闭。
- 无跨 Project 读写泄露。
- 无 Gate、Ticket、Run 重试重复副作用。
- 三视口无关键溢出和遮挡。
- 默认完整测试命令包含数据库集成，不再大面积 skip。
- 证据包完整且不含 secret。

### 14.2 允许带降级发布

只有在发布说明明确披露时，以下能力可作为降级项：

- Shared Space 未开放，Agent 不具备共享目录写入能力。
- Project Governance 和角色草稿确认未开放。
- Workbench 固定布局，不支持自定义布局和 Brief SSE。
- Human Avatar 仅支持会议内 Delegation，不支持跨场景委托。
- Persona、Seat Claim、Task 通用外部关联保持 P2。

不得带降级发布：

- 最后一个可登录管理员可被移除。
- 非成员或跨 Project 可读敏感资源。
- 撤销 Grant 不立即生效。
- Credential 或 Token 泄露。
- Gate 可绕过。
- Migration 丢失历史关联或审计。

## 15. 当前结论

用户视角的核心 Task、Workflow、Meeting、AI Teammate、Runtime、Memory 和基础
Workbench 已有可验证链路，但不能据此宣称完整覆盖 DSH。

当前最重要的用户感知缺口是：

1. Shared Space、Project Governance、Workbench 可配置布局与 Brief SSE、
   Human Avatar 没有等价用户链路。
2. 核心回归已形成 bearer 与 local-development 两阶段统一入口，但 Shared Space、
   Project Governance 和 Workbench 配置仍没有可供 GUI 验收的等价功能。

管理员安全阻断已关闭；剩余 DSH parity 缺口仍应保留为发布阻断或明确业务降级。
