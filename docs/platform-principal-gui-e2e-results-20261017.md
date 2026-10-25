# 平台 Principal GUI E2E 执行结果（2026-10-17 / 2026-10-18）

> 关联方案：`docs/platform-principal-rbac-design.md`  
> 关联测试方案：`docs/platform-principal-gui-e2e-test-plan.md`  
> 执行方式：Codex In-app Browser + Playwright/DOM accessibility 操作  
> 结论：核心 P0 主链路可验收；仍有一组未覆盖的兼容、外部 Agent、密钥失效与并发场景需要后续专项执行。

## 1. 执行环境

| 项           | 实际值                                                                                       |
| ------------ | -------------------------------------------------------------------------------------------- |
| 工作目录     | `/Users/oliviayang/Codex/一切皆插件/dsh-pluginmax`                                           |
| DSH_HOME     | `.tmp/principal-gui-e2e-home`                                                                |
| 端口         | `33130`                                                                                      |
| 项目         | `PP-Alpha`、`PP-Beta`，通过隔离环境测试夹具预注册                                            |
| 浏览器       | Codex In-app Browser                                                                         |
| 视口         | `1440 x 1000`、`900 x 900`、`390 x 844`                                                      |
| 账号         | `pp-admin`、`pp-owner`、`pp-member`、`pp-guest`、`pp-outsider`、`pp-ai-owner`、`pp-disabled` |
| 历史迁移夹具 | `PP-AI-Legacy` / `digital-pp-legacy` / `tm-pp-legacy`                                        |

项目通过测试夹具预注册的原因是宿主目录选择器不适合在每个用例中重复执行。账号、项目成员、项目角色、工作流、任务、会议和 AI 伙伴的验收操作均通过 GUI 完成。只有工作流角色节点在执行中遇到一次前端旧 actor 缺陷时，使用本地测试 API 推进了该节点；相应前端缺陷已经修复并有静态回归测试。

## 2. 自动化验证结果

| 检查                       | 结果                                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `corepack pnpm test`       | 通过：33 个测试文件、508 个测试                                                                                          |
| `corepack pnpm typecheck`  | 通过                                                                                                                     |
| `corepack pnpm build`      | 通过                                                                                                                     |
| `corepack pnpm pack:check` | 通过                                                                                                                     |
| `corepack pnpm lint`       | 无 error；仅既有 unused/风格 warning                                                                                     |
| `git diff --check`         | 通过                                                                                                                     |
| `corepack pnpm contract`   | 未通过：`upstream submodule working tree must remain clean`，为既有 `vendor/deepseek-harness` 脏工作树，不是本轮功能回归 |

## 3. 已修复缺陷

| ID            | 等级 | 问题                                                                                    | 修复                                                                                             |
| ------------- | ---- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| PP-GUI-BUG-01 | P0   | AI 伙伴创建把平台角色当工作区角色，`pp-owner` 作为项目负责人仍被 Agent Registry 拒绝    | 内部 Runtime provisioning 改用工作区成员角色，并增加受信任的 Agent Profile internal path         |
| PP-GUI-BUG-02 | P1   | 创建失败补偿只归档，连续失败会留下多条同名归档 AI                                       | 修复根因避免正常路径失败；历史失败遗留记录仍需后续数据清理                                       |
| PP-GUI-BUG-03 | P1   | AI 任务自动转人工验收后，24h 负荷丢失运行时长和 Token                                   | 活动投影同时按 `receiverPrincipalId` 归属历史运行                                                |
| PP-GUI-BUG-04 | P0   | 非管理员在平台设置中能看到“角色/审计”，并可释放项目席位                                 | 非管理员只显示“登录账号”，角色/审计页签仅平台管理员可见                                          |
| PP-GUI-BUG-05 | P0   | 平台审计页仍显示“真人员工 / Employee ID”且审计为空                                      | 审计页切到身份服务 `/api/collab/team/audit`，显示创建账号、更新账号、登录、改密等 Principal 审计 |
| PP-GUI-BUG-06 | P2   | 停用账号登录显示英文原文；切换账号后设置页残留“已退出登录”                              | 统一中文认证错误；成功登录事件清理旧提示                                                         |
| PP-GUI-BUG-07 | P0   | 账号切换后任务筛选沿用上一个账号，成员看不到派给自己的任务                              | token 变化时重置派出方、责任人、优先级、来源和搜索条件                                           |
| PP-GUI-BUG-08 | P0   | 待验收任务只有责任人可自审，创建人和管理员反而不能通过                                  | 服务端新增验收权限投影与 action guard；创建人、项目负责人、管理员、审批角色可验收                |
| PP-GUI-BUG-09 | P0   | 旧工作流模板直接引用 Agent Profile 时，Run 没有 `principalId`                           | 当 Agent Profile 唯一映射到一个 active Principal Runtime 时自动解析 Principal 并签发 Ticket      |
| PP-GUI-BUG-10 | P1   | 切换账号后工作流详情继续使用旧 `detail.actor`，角色节点按钮被误禁用                     | token 变化时清空 detail、selection、busy 和反馈状态                                              |
| PP-GUI-BUG-11 | P1   | 无正式交付物时，提示词没有输出标题契约，但结果校验仍强制要求 `# 交付报告 / ## 交付说明` | 所有 workflow task-worker 都注入固定输出契约                                                     |
| PP-GUI-BUG-12 | P2   | 会议 AI 提及项只绑定 `onMouseDown`，键盘和自动化操作无法选择                            | 改为 `onClick`，指针和键盘均可激活                                                               |
| PP-GUI-BUG-13 | P1   | AI 会议回复已落库，但原 @ 消息 delivery 永久停留 `pending`                              | worker reply 成功后回写对应待投递记录为 `delivered`                                              |
| PP-GUI-BUG-14 | P1   | AI 参会代表记录没有显式 AI Principal 字段                                               | 参会代表新增 `aiPrincipalId`，运行时开通后写入                                                   |
| PP-GUI-BUG-15 | P0   | Agent 可调用 roles 工具以 `collab-roles-tool` 自行认领项目角色，污染项目成员            | roles 工具改为只读 list；命令入口移除 agent claim/release                                        |
| PP-GUI-BUG-16 | P0   | 390 视口平台设置固定双列，内容被裁切到不可用                                            | 窄屏设置弹窗改为单列，导航横排滚动，内容占满并独立纵向滚动                                       |

## 4. 用例执行结果

| 用例           | 结果    | 实际结果                                                                             |
| -------------- | ------- | ------------------------------------------------------------------------------------ |
| PP-GUI-ENV-01  | PASS    | 首次管理员初始化、导航、账号页签和刷新保持正常                                       |
| PP-GUI-ENV-02  | PASS    | 主路径无企业员工入口；旧 Employee 审计页已替换                                       |
| PP-GUI-ACC-01  | PASS    | 7 个账号创建、列表和刷新一致                                                         |
| PP-GUI-ACC-02  | PASS    | 名称与全局角色修改成功；角色改 guest 后恢复 member                                   |
| PP-GUI-ACC-03  | PASS    | 最后管理员降级/停用被拒绝，中文提示稳定可见                                          |
| PP-GUI-ACC-04  | PARTIAL | 停用后登录被拒绝且中文提示正确；独立浏览器 Profile 不可用，未验证已登录会话即时失效  |
| PP-GUI-ACC-05  | PASS    | 修改密码成功，旧密码失败，新密码成功，随后恢复测试密码                               |
| PP-GUI-ACC-06  | PASS    | 非管理员仅看到登录账号，无目录、角色、审计入口                                       |
| PP-GUI-PRJ-01  | PARTIAL | 项目和 Owner 配置通过 GUI 验证；项目创建因目录选择夹具未重复执行                     |
| PP-GUI-PRJ-02  | PASS    | 候选显示 Human Principal 与 AI Principal，无 Employee 类型                           |
| PP-GUI-PRJ-03  | PASS    | Human Principal 添加、Builder、刷新保持均正常                                        |
| PP-GUI-PRJ-04  | PARTIAL | 平台角色、工作区角色、项目角色在 GUI 中独立展示；未执行完整写权限正反向              |
| PP-GUI-PRJ-05  | PASS    | 4 角色草稿取消后清空；重建后确认 v2，关闭重开保持                                    |
| PP-GUI-PRJ-06  | PARTIAL | 未使用 Temp-Role 可删除并确认 v3；被任务引用角色删除未覆盖                           |
| PP-GUI-PRJ-07  | NOT RUN | 双 Profile 并发 revision 冲突受单浏览器 Profile 限制                                 |
| PP-GUI-PRJ-08  | PASS    | `pp-outsider` 项目列表为 0，任务列表为空                                             |
| PP-GUI-AI-01   | PASS    | 修复后成功创建并绑定 Alpha；列表唯一 active 实例                                     |
| PP-GUI-AI-02   | PASS    | AI 显示“平台角色未分配”，不从 Owner 继承                                             |
| PP-GUI-AI-03   | PASS    | 失效后从任务责任人候选移除；恢复后重新出现                                           |
| PP-GUI-AI-04   | PARTIAL | 归档列表可访问；运行中归档阻断未覆盖                                                 |
| PP-GUI-AI-05   | NOT RUN | 归档任务转移未覆盖                                                                   |
| PP-GUI-AI-06   | NOT RUN | 外部 Agent Runtime 专项未覆盖                                                        |
| PP-GUI-TASK-01 | PASS    | Human 任务创建、成员开始、提交、管理员验收全链路通过                                 |
| PP-GUI-TASK-02 | PASS    | AI 任务完成、产出 Markdown、待验收、刷新保持、AI 负荷显示 8524 Token                 |
| PP-GUI-TASK-03 | PARTIAL | 失效 AI 不在新任务候选；旧页面提交未覆盖                                             |
| PP-GUI-TASK-04 | PASS    | 非成员任务列表为空                                                                   |
| PP-GUI-WF-01   | PARTIAL | 启动审批与 Builder 角色节点实际推进；角色按钮修复前有一次使用 API 推进               |
| PP-GUI-WF-02   | PASS    | AI 节点自动派发、Principal Ticket、输出修复、重试成功、人工 Review 和发布审批完成    |
| PP-GUI-WF-03   | NOT RUN | 暂停 AI 后旧实例派发阻断未覆盖                                                       |
| PP-GUI-WF-04   | NOT RUN | 新实例角色快照未覆盖                                                                 |
| PP-GUI-MTG-01  | PASS    | AI 代表指派、结构化 @、worker 回复落库、delivery=delivered、刷新可查                 |
| PP-GUI-MTG-02  | NOT RUN | AI 代表撤销/取消参会未覆盖                                                           |
| PP-GUI-MIG-01  | PASS    | `PP-AI-Legacy` 可见、仅 1 个 Principal/Profile、重启后仍为 1，无重复                 |
| PP-GUI-MIG-02  | NOT RUN | 无 Runtime 的历史 AI 未构造                                                          |
| PP-GUI-MIG-03  | NOT RUN | 已归档 Principal 的历史 AI 未构造                                                    |
| PP-GUI-MIG-04  | NOT RUN | 旧 Employee 任务/Run 历史回查未构造                                                  |
| PP-GUI-AUD-01  | PASS    | 创建、更新、登录、失败登录、改密、成员操作可见，目标账号过滤有效                     |
| PP-GUI-AUD-02  | PARTIAL | 项目历史展示 12 条变更、Principal、角色差异和账号操作；搜索未单独验证                |
| PP-GUI-AUD-03  | PARTIAL | AI 任务、Run、Ticket、Principal 和执行历史可追溯；失败详情脱敏抽样有限               |
| PP-GUI-SEC-01  | NOT RUN | 清空/伪造 token 未执行                                                               |
| PP-GUI-SEC-02  | PASS    | 非管理员无平台角色/审计入口；项目内操作边界保持                                      |
| PP-GUI-SEC-03  | PARTIAL | AI Principal 未分配平台角色；Owner 全角色变更下的继承回归未覆盖                      |
| PP-GUI-SEC-04  | NOT RUN | 归档 Principal 旧页面派发未覆盖                                                      |
| PP-GUI-SEC-05  | PARTIAL | 人员跨项目隔离通过；AI 跨项目候选串线未覆盖                                          |
| PP-GUI-QA-01   | PASS    | 账号、人类任务、AI 任务、工作流、会议均通过刷新/重新进入验证持久化                   |
| PP-GUI-QA-02   | PASS    | 1440/900/390 无页面横向溢出；390 设置改为单列，账号表使用局部横向滚动                |
| PP-GUI-QA-03   | PARTIAL | 会议提及按钮改为可键盘激活；完整 Tab/Enter 和焦点陷阱未覆盖                          |
| PP-GUI-QA-04   | PARTIAL | 稳定版本无影响功能的未捕获异常；服务重启过程有 boot-order/connection retry 日志      |
| PP-GUI-QA-05   | PARTIAL | 多类空状态正常；无项目/无角色全新空环境未独立重跑                                    |
| E2E-01         | PASS    | 账号 → 项目成员 → 工作区角色/项目角色 → 成员访问 → 管理员验收                        |
| E2E-02         | PASS    | AI 伙伴 → 项目成员 → AI 任务 → 工作流 AI 节点 → Review/审批 → 历史回查               |
| E2E-03         | PARTIAL | Employee Runtime 迁移、Principal 绑定、幂等通过；旧任务/Run 与迁移后新派发未完整重跑 |

## 5. 仍待处理

### P1

1. 早期 AI 创建失败补偿仍留下 3 条同名归档记录。正常失败根因已修复，但需要一次性数据修复或可审计清理流程。
2. `collab_meeting say` 仍无法把 agent session 映射到 `ai_representative`；用户路径的 worker reply 不受影响，但内部工具语义不一致。
3. 外部 Agent Runtime、运行中归档、任务转移、旧页面归档/停用派发等负向链路尚未执行。

### P2

1. 工作流模板详情主要显示“负责人”，未直接展示 AI 执行者；实例详情已能显示 `Agent · PP-AI-Runtime`。
2. 390 视口账号表依赖局部横向滚动，虽可用，但移动端编辑体验仍可进一步卡片化。
3. 项目历史的人类主体仍使用“人类成员”文案，与 Human Principal 术语不完全统一。

### 环境限制

1. In-app Browser 只有一个共享 localStorage Profile，无法完成双账号并发 revision、实时会话失效和真正独立 Profile 的并发测试。
2. 宿主目录选择器不适合自动化，项目创建使用预注册夹具。
3. 历史任务、Run、无 Runtime AI 和归档 Principal 需要更完整的旧环境数据包。

## 6. 发布建议

当前版本可以进入主链路演示和下一轮专项验收，不建议直接标记为“全量 GUI E2E 完成”。建议下一轮优先执行：

1. 双浏览器 Profile 的账号失效、并发 revision 和跨账号缓存隔离。
2. 外部 Agent Runtime、归档 AI、任务转移和工作流暂停恢复。
3. Employee 历史任务/Run 完整迁移包与重启幂等。
4. 密钥清空、伪造 Token、直接写接口和敏感日志读取安全专项。
5. 移动端账号表卡片化及设置弹窗焦点可访问性。
