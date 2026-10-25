# 企业员工平台 GUI 测试方案（E0-E7）

> 2026-10-17 方向调整：员工平台已暂停建设。本文仅保留迁移期兼容与历史回归价值。目标产品不再提供企业员工目录，平台设置收敛为账号与权限；AI 由 AI 伙伴管理，未来 HRM 通过 Principal 映射接入。新方案见 `docs/platform-principal-rbac-design.md`。

本文是三层员工体系的独立 GUI 回归方案，不覆盖既有阶段性测试文档。它覆盖 E0-E7 已交付能力和当前明确预留的能力：

> Phase 1 入口更新：平台设置只保留「身份与权限」一级入口，企业员工是默认页签；账号、角色和审计分别作为子页签。旧的独立「数字员工 / 分身委托 / 治理中心」设置视图已隐藏，相关能力通过企业员工详情、AI 伙伴、会议或审计入口验证。

1. E0：过渡 Task Worker 输出契约、交付物门禁和修复重试；
2. E1：Human Employee 目录映射和稳定 Employee ID；
3. E2：Digital Employee 生命周期、Runtime Profile 和工作区授权；
4. E3：显式授权、Action Ticket、deny 优先和审计来源；
5. E4：Human Avatar / Delegation、会议分身报告和目录隔离；
6. E5：工作流 `employee:<id>` 执行、旧 `agent:<id>` 兼容和交付物门禁；
7. E6：治理中心、风险异常、活动时间线、权限矩阵和报告中心；
8. E7：工作台面板集成、权限边界和 by-role 面板组合预留。

当前实现边界必须按“预期结果”验收，不能当作缺陷绕过：

1. Digital Employee 是正式员工主体，但没有密码登录；
2. Digital Employee 审批引用可以保存和显示，但最终审批必须等待专用 runtime decision path，浏览器用户不能代签；
3. Human Avatar / Delegation 不进入员工目录，不自动继承主人全部权限；
4. 工作台只组合服务端能力，不创建权限、不绕过服务端校验；
5. by-role 面板组合只展示 `预留 · schema v1`，没有编辑、拖拽或保存入口；
6. Task Worker 是过渡执行适配层，正式执行身份应以 Digital Employee 和 Employee Run 为准。

## 1. 测试环境

### 1.1 仓库根目录

所有终端命令都在仓库根目录执行：

```sh
cd /Users/oliviayang/Codex/一切皆插件/dsh-pluginmax
```

如果终端提示不在目标目录，用 `pwd` 确认输出结尾是：

```text
/Users/oliviayang/Codex/一切皆插件/dsh-pluginmax
```

### 1.2 构建和门禁

1. 执行：

   ```sh
   corepack pnpm install --frozen-lockfile
   corepack pnpm check
   ```

2. 预计输出：
   1. typecheck、lint、unit、build、contract、pack 校验全部通过；
   2. Vitest 显示 `9 passed` 个测试文件、`96 passed` 个用例；
   3. contract 检查显示 `8 plugin bundle(s)`；
   4. 没有未捕获异常或 failed 任务。

如果这里失败，先停止 GUI 测试并记录失败阶段，不要用手工点击代替自动化门禁结论。

### 1.3 初始化隔离环境

1. 停止旧的本地 DSH 进程，或选择未被占用的新端口。
2. 执行：

   ```sh
   rm -rf .tmp/dsh-home
   mkdir -p .tmp
   ./scripts/install-profile.sh
   ```

3. 启动隔离服务：

   ```sh
   DSH_HOME="$PWD/.tmp/dsh-home" node \
     vendor/deepseek-harness/apps/cli/lib/bin.js \
     --profile pluginmax \
     --no-open \
     --port 33117
   ```

4. 终端输出一个带 token 的 URL，例如：

   ```text
   http://127.0.0.1:33117/?token=<WEB_TOKEN>
   ```

5. 把该 URL 记为 `<ROOT_URL>`。首次进入浏览器必须使用完整带 token URL。
6. 如果服务中断，重启后必须复制终端最新打印的 URL。旧 token URL 不可继续使用。

### 1.4 浏览器 Profile 约束

Pluginmax 登录 token 保存在同一浏览器 Profile 的 `localStorage` 中。多账号测试不能只靠同一 Profile 的多个普通标签页。

| Profile   | 账号              | 全局角色 | 工作区角色 | 用途                                       |
| --------- | ----------------- | -------- | ---------- | ------------------------------------------ |
| Profile A | `flow-owner`      | admin    | owner      | 管理员、创建数字员工、发起工作流、治理验证 |
| Profile B | `workflow-member` | member   | member     | 普通成员、审批人、责任人、执行确认         |
| Profile C | `workflow-viewer` | guest    | guest      | 只读和权限边界验证                         |

Chrome 建立独立 Profile 的操作：

1. 打开 Chrome。
2. 点击右上角头像图标。
3. 选择「添加」或「其他 Profile > 添加」。
4. 选择「不登录继续」或本地测试用 Profile。
5. 命名为 `Pluginmax A`、`Pluginmax B`、`Pluginmax C`。
6. 在每个 Profile 中分别打开 `<ROOT_URL>`。

Safari 可改用三个不同浏览器 Profile/隔离窗口方案；若无法隔离，切换账号前必须点击「退出登录」，确认旧 token 清除后再登录下一个账号。

### 1.5 基础账号和工作区

以下 `<WS_ID>`、`<SESSION_ID>` 均为占位符。执行时从页面复制真实值替换，不要手写编造 ID。

1. Profile A 打开 `<ROOT_URL>`。
2. 在左侧「工作区」区域选择「添加工作区…」。
3. 选择一个已创建的空目录作为测试工作区，例如：

   ```text
   /Users/oliviayang/Codex/一切皆插件/dsh-pluginmax/.tmp/employee-workspace
   ```

4. 等待该工作区在左侧列表和中间工作区上下文中加载完成，确认不是「暂无可用工作区」。
5. 打开 Settings >「身份与权限」>「登录账号」。
6. 如果出现首次初始化表单，填写：
   1. 用户 ID：`flow-owner`
   2. 显示名称：`Workflow Owner`
   3. 初始密码：`Pluginmax#2026`
7. 完成初始化并保持登录。
8. 在「用户管理」创建：
   1. `workflow-member` / `Workflow Member` / `Pluginmax#2026` / 全局角色 `member`
   2. `workflow-viewer` / `Workflow Viewer` / `Pluginmax#2026` / 全局角色 `guest`
9. 在「工作区成员」选择测试工作区，添加：
   1. `workflow-member`，角色 `member`
   2. `workflow-viewer`，角色 `guest`
10. 使用工作区信息 icon 查看并复制 `<WS_ID>`。

预计输出：

1. Profile A 当前身份显示为 `Workflow Owner`。
2. 用户列表包含三个账号。
3. 工作区成员列表包含 owner、member、guest 三类账号。
4. Settings >「身份与权限」>「企业员工」>「目录」自动出现 `Workflow Owner`，主体类型为「真人员工」，状态为「启用」。
5. 添加工作区前，「工作区成员」不显示可复制的 `main` 假详情；添加后才能复制真实工作区 ID。
6. 浏览器 Console 没有未捕获异常。

## 2. 全局验收标准

1. 每个用例的实际结果与预计输出一致；
2. 所有失败都有显性提示，不静默失败；
3. 所有时间字段优先显示本地可读时间，完整 UTC 值不作为主要阅读信息；
4. 所有长 ID 不直接挤压主要操作区，可通过详情、悬停或复制获取；
5. 所有按钮在不可用时使用 disabled，而不是点击后才暴露错误；
6. 页面布局在 1280px、900px、390px 宽度下无按钮遮挡、无嵌套双滚动条；
7. 每个主要操作后页面刷新或自动刷新到最新状态；
8. 敏感操作在服务端拒绝时，UI 不显示成功文案；
9. 浏览器 Console 没有未捕获异常；
10. 操作证据包含截图或录屏，并记录时间、账号、工作区和对象 ID。

## 3. 功能测试

### F1 平台入口和员工语言

#### F1.1 管理员入口

1. Profile A 打开 Settings。
2. 确认一级/二级区域包含「员工」和「审计」，且两者平行。
3. 打开「员工」。
4. 检查 tab：`目录`、`数字员工`、`分身委托`、`治理中心`。
5. 逐个切换 tab，再单独打开「审计」。

预计输出：

1. 员工页内的四个 tab 可见且可点击；「审计」是与「员工」平行的设置入口。
2. 「目录」显示真人员工。
3. 「数字员工」显示创建表单和已有数字员工。
4. 「分身委托」不把 Human Avatar 显示为员工目录记录。
5. 「治理中心」对全局管理员可见；「审计」入口对所有人可见，明细仅管理员可见。
6. 文案使用「真人员工」「数字员工」「Human Avatar / 分身」，不把三者混为一谈。

#### F1.2 普通成员边界

1. Profile B 登录 `workflow-member`。
2. 打开 Settings >「身份与权限」>「企业员工」。
3. 检查「数字员工」「治理中心」，并打开设置左侧的「审计」入口。

预计输出：

1. Profile B 能查看自己被授权可见的员工目录和分身委托；
2. 创建数字员工、生命周期按钮、授权表单、Runtime 表单、治理中心和审计明细不可用或明确提示需要全局管理员权限；
3. 没有任何绕过提示的隐藏输入或可提交的伪管理表单。

#### F1.3 访客边界

1. Profile C 登录 `workflow-viewer`。
2. 打开 Settings >「身份与权限」>「企业员工」。
3. 打开中间主操作区「工作台」。

预计输出：

1. Profile C 不看到管理操作入口。
2. 工作台能加载基本面板，但管理员权限面板显示「此面板需要全局管理员权限。」。
3. 对敏感操作没有可见的可用按钮。

### F2 Human Employee 目录映射

#### F2.1 自动映射

1. Profile A 打开 Settings >「身份与权限」>「企业员工」>「目录」。
2. 找到 `Workflow Owner`。
3. 点击「详情」。
4. 记录 Employee ID。
5. Profile B 登录后重复查看自己的员工详情。

预计输出：

1. 每个登录账号都有稳定 Employee ID。
2. 主体类型为「真人员工」。
3. 详情显示登录用户 ID、状态、部门 / 岗位和工作区授权。
4. 刷新或重新登录后 Employee ID 不变。

#### F2.2 目录不把数字员工当登录用户

1. Profile A 先完成 F3 创建 `Backend Engineer 01`。
2. 回到「目录」。
3. 检查该员工的类型 / 登录列。
4. 打开「协作身份」用户管理。

预计输出：

1. `Backend Engineer 01` 显示「数字员工」和「无密码登录」。
2. Identity 用户管理没有新增 `backend-01` 可登录账号。
3. 没有密码重置入口挂在数字员工上。

### F3 Digital Employee 生命周期

#### F3.1 创建过渡 Task Worker Profile

Digital Employee 的 Runtime Profile 必须映射到一个 Task Worker Profile 才能被工作流派发。

1. Profile A 打开 Settings >「Agent」。
2. 选择 `<WS_ID>` 工作区。
3. 在「新建 Task Worker Profile」填写：
   1. Profile ID：`backend-agent`
   2. 显示名称：`后端开发 Agent`
   3. 描述：`Employee platform regression worker`
   4. Persona ID：如页面存在该字段，可留空或选择有效 Persona。
4. 点击「创建 Profile」。
5. 刷新列表。

预计输出：

1. 列表出现 `backend-agent`。
2. 状态为「启用」。
3. 类型为 `task-worker`。
4. 若 Persona ID 留空，创建成功且不影响后续执行映射。

#### F3.2 创建数字员工草稿

1. Profile A 打开 Settings >「身份与权限」>「企业员工」>「数字员工」。
2. 在「创建数字员工」填写：
   1. Employee ID：`backend-01`
   2. 姓名：`Backend Engineer 01`
   3. 岗位：`Backend Engineer`
   4. 部门：`Platform Engineering`
   5. Persona ID：从下拉框选择已存在的 `backend-soul`；如果下拉框为空，点击「新增 Persona」在 Settings >「身份与权限」>「角色」创建，回到本页后点击「刷新 Persona」。
   6. 负责人：`Workflow Owner`
   7. 邮箱：`backend-01@example.com`
   8. 标签：`backend,workflow`
3. Persona 下拉框必须显示所有已存在 Persona，不能手工输入不存在的 ID。
4. 点击「创建草稿」。

预计输出：

1. 出现「数字员工已创建为草稿。」。
2. 目录出现 `Backend Engineer 01`，状态「草稿」。
3. 页面说明 Persona 只约束行为，不授予权限。
4. 该员工没有登录密码字段。
5. 没有任何 Persona 时，「创建草稿」不可用，并提示先在 Settings >「身份与权限」>「角色」创建。

`backend-soul` Persona 创建资料（Settings >「身份与权限」>「角色」>「人设」）：

- 标识：`backend-soul`
- 名称：`Backend Engineer Soul`
- 标签：`backend,engineering`
- 描述：`后端工程师数字员工的行为人设：负责服务端 API、数据模型与联调，只约束行为，不授予权限。`
- SOUL：

  ```text
  你是数字员工 backend-01 的后端工程师人设，名字叫 Backend Engineer。

  职责边界：
  - 负责服务端 API 设计与实现、数据库模型、任务队列与联调排查。
  - 不修改与后端无关的前端样式，不擅自变更产品需求或权限配置。

  工作原则：
  - 先确认接口契约（输入、输出、错误码、幂等性），再动手实现。
  - 改动必须附带测试；无法本地验证时明确说明风险与验证缺口。
  - 涉及破坏性变更、数据迁移或依赖升级时，先列出影响并请求确认。

  沟通方式：
  - 直接、简洁，以事实、日志和代码为依据。
  - 汇报结构：结论、关键原因、下一步建议。
  - 需求不明确时先列出假设，确认后再执行。
  ```

#### F3.3 Persona 引用与软依赖

1. 打开 Settings >「身份与权限」>「角色」确认 `backend-soul` 存在。
2. 打开 `Backend Engineer 01` 详情，确认 Persona 显示为 `backend-soul`。
3. 在编辑表单中打开 Persona ID 下拉框，确认只能选择现有 Persona；若历史数据引用了不存在的 Persona，该项显示「未找到 / 待配置」且不会被静默改掉。
4. 保存资料后刷新详情，确认 Persona 引用保持不变。

预计输出：

1. 有效 Persona 的数字员工详情能显示对应 Persona ID；
2. 历史数据或服务端数据中的缺失 Persona 仍显示「未找到 / 待配置」，不伪装成已加载；
3. GUI 创建和编辑入口不允许把 Persona 改成任意不存在的新 ID。

#### F3.4 启用、暂停、恢复、归档

1. 在目录中找到 `Backend Engineer 01`。
2. 点击「启用」。
3. 点击「详情」，检查资料。
4. 在资料表单中把岗位改为 `Senior Backend Engineer`，点击「保存资料」。
5. 回到目录，点击「暂停」。
6. 点击「启用」恢复。
7. 最后再次点击「暂停」，继续后续执行权限测试时再恢复。

预计输出：

1. 状态按 `草稿 > 启用 > 暂停 > 启用` 变化。
2. 保存资料后列表和详情立即显示 `Senior Backend Engineer`。
3. 非法状态转移按钮 disabled。例如草稿不能直接从「归档」恢复为「启用」的按钮不可点击。
4. 暂停后该员工不应能被工作流派发。

#### F3.5 归档边界

所需材料：

1. `backend-01` 已按 F3.2-F3.4 完成启用；`backend-agent` Task Worker Profile 已按 F3.1 创建。
2. 测试模板 `docs/fixtures/workflow/employee-node.md`。
3. 当前工作区已按 F1.1 完成：`workflow-member` 账号存在，并已加入该工作区的「工作区成员」（模板开发节点的负责人引用 `user:workflow-member`，缺失时导入校验会拒绝并提示负责人不是当前工作区成员）。
4. `archive-01` 创建数据：
   1. Employee ID：`archive-01`
   2. 姓名：`Archive Test 01`
   3. 岗位：`Backend Engineer`
   4. 部门：`Platform Engineering`
   5. Persona ID：`backend-soul`
   6. 负责人：`Workflow Owner`
   7. 邮箱：`archive-01@example.com`
   8. 标签：`backend,archive-test`
5. 最小授权数据：工作区 `<WS_ID>`、角色 `viewer`、显式权限 `read`、有效期留空（操作口径同 F4.1）。
6. Runtime Profile 数据：配置名 `archive-runtime`、工作区 `<WS_ID>`、Provider `spawn`、模型和允许/禁止工具留空、最大轮次 `10`、最大分钟 `10`、映射 Task Worker Profile `backend-agent`（操作口径同 F4.2）。

步骤：

1. Profile A 打开 Settings >「身份与权限」>「企业员工」>「数字员工」，按「所需材料」创建 `archive-01` 草稿，回到目录点击「启用」。
2. 打开 `archive-01` 详情，按最小授权数据和 Runtime Profile 数据分别完成「新增工作区授权」和「新增 Runtime Profile」。
3. 归档前先准备引用它的流程：打开 Settings >「工作流」，把 `docs/fixtures/workflow/employee-node.md` 内容复制到临时文件，把 `executor: employee:backend-01` 改为 `executor: employee:archive-01`，使用不同的 key 和 version 导入成功。
4. 回到目录，点击 `archive-01` 的「归档」。
5. 打开 `archive-01` 详情，确认「工作区授权」和「Runtime Profile」区块仍完整展示。
6. 确认归档后不能再选为执行者：把临时文件内容重新粘贴到「导入 Markdown 模板」，点击「校验」，确认校验失败并提示 `archive-01` 必须启用。
7. 确认运行阻塞：在「从启用模板发起」填写实例标题并点击「启动」，回到主界面中间的「工作流」页签（不是设置弹窗），打开刚启动的实例，检查「开发」节点执行者显示 `数字员工 · Archive Test 01`，节点显示阻塞原因，且没有派发和完成按钮。

预计输出：

1. `archive-01` 状态为「归档」。
2. 重新校验引用 `archive-01` 的模板内容失败，提示必须启用；归档员工不能再被选为新的工作流执行者。
3. 引用它的节点派发被服务端拒绝，节点显示明确阻塞原因，例如「Digital Employee「archive-01」不可派发；请检查员工状态、工作区授权、Runtime Profile 和 Agent Profile 映射」。
4. 页面不提供对归档员工的新任务派发入口。
5. 使用 `archive-01` 的工作流节点不显示派发和完成按钮。

### F4 显式授权、Runtime Profile 和 Action Ticket

#### F4.1 新增工作区授权

1. Profile A 打开 `Backend Engineer 01` 详情。
2. 展开「新增工作区授权」。
3. 填写：
   1. 工作区：`<WS_ID>`
   2. 角色：`member`
   3. 显式权限：`read, write`
   4. 有效期：留空。
4. 点击「保存授权」。
5. 再新增一条 `viewer` / `read`、有效期 `5` 分钟的授权，用于边界测试。

预计输出：

1. 详情「工作区授权」出现两条记录。
2. 长期授权到期显示为可理解的长期 / `-` / 不限，不显示原始空字符串。
3. 5 分钟授权显示本地到期时间。
4. 无权限数字员工不会自动获得授权。

#### F4.2 新增 Runtime Profile

1. 展开「新增 Runtime Profile」。
2. 填写：
   1. 配置名：`backend-runtime`
   2. 工作区：`<WS_ID>`
   3. Provider：`spawn`
   4. 模型：留空
   5. 允许工具：留空
   6. 禁止工具：留空
   7. 最大轮次：`50`
   8. 最大分钟：`30`
   9. 映射 Task Worker Profile：`backend-agent`
3. 点击「保存 Runtime」。

预计输出：

1. Runtime Profile 显示启用状态。
2. 详情显示 `spawn / 默认模型`、预算 `50 轮 / 30 分钟`。
3. Task Worker 映射显示 `backend-agent`。
4. 不再显示「缺少 Task Worker 映射；工作流不能派发。」。

#### F4.3 缺少映射时拒绝派发

所需材料：

1. 当前工作区已按 F1.1 完成：`workflow-member` 账号存在，并已加入该工作区的「工作区成员」（模板开发节点的负责人引用 `user:workflow-member`）。
2. 测试模板 `docs/fixtures/workflow/no-runtime-node.md`。
3. `no-runtime-01` 创建数据：
   1. Employee ID：`no-runtime-01`
   2. 姓名：`No Runtime 01`
   3. 岗位：`Backend Engineer`
   4. 部门：`Platform Engineering`
   5. Persona ID：`backend-soul`
   6. 负责人：`Workflow Owner`
   7. 邮箱：`no-runtime-01@example.com`
   8. 标签：`backend,no-runtime`
4. 最小授权数据：工作区 `<WS_ID>`、角色 `viewer`、显式权限 `read`、有效期留空（操作口径同 F4.1）。
5. 边界条件：本用例不创建 Runtime Profile，也不填映射 Task Worker Profile。

步骤：

1. Profile A 打开 Settings >「身份与权限」>「企业员工」>「数字员工」，按「所需材料」创建 `no-runtime-01` 草稿，回到目录点击「启用」。
2. 打开 `no-runtime-01` 详情，仅完成「新增工作区授权」；不创建 Runtime Profile。
3. 打开 Settings >「工作流」，在「导入 Markdown 模板」选择 `docs/fixtures/workflow/no-runtime-node.md`，点击「校验」，再尝试「保存新版本」。
4. 观察校验与导入结果。

预计输出：

1. 「校验」直接报错，提示包含缺少 Runtime Profile 或缺少 Task Worker 映射等可读原因（Digital Employee「no-runtime-01」必须启用，且具备显式工作区授权、启用 Runtime Profile 和 Agent Profile 映射）。
2. 「保存新版本」被拒绝，不产生新模板版本，图形校验不把它显示为已保存。
3. 不存在可启动的引用 `no-runtime-01` 的模板，不生成成功运行记录，节点不进入运行中或完成。

#### F4.4 暂停员工时拒绝派发

所需材料：

1. `backend-01` 已按 F3.2-F3.4 启用，并完成 F4.1 工作区授权和 F4.2 Runtime Profile。
2. 当前工作区已按 F1.1 完成：`workflow-member` 账号存在，并已加入该工作区的「工作区成员」。
3. 专用测试模板 `docs/fixtures/workflow/employee-node-manual.md`。它的开发节点必须是 `executor: employee:backend-01` 且 `trigger: manual-dispatch`。
4. 边界条件：不要用 `product-delivery-v2.md`、`agent-node.md` 或其他 `executor: agent:backend-agent` 模板执行本用例。那些是过渡 Task Agent 节点，不会因为 `backend-01` 被暂停而自动停止；对应失败原因只会反映 Task Agent 自身的运行或输出校验结果。

步骤：

1. Profile A 在主操作区打开「工作流」页签，点击「模板管理」。
2. 把 `docs/fixtures/workflow/employee-node-manual.md` 的全部内容粘贴到「导入 Markdown 模板」，点击「校验」，再点击「保存新版本」。
3. 关闭模板管理，回到主操作区「工作流」页签。
4. 在顶部「选择流程模板」选择 `Digital Employee 手动派发 v1`，填写实例标题 `F4.4 suspend employee`，点击「启动」。
5. 在实例列表搜索 `F4.4 suspend employee`，点击标题卡片展开；确认「开发」节点执行者显示 `数字员工 · backend-01`，节点处于「就绪」。
6. 将 `backend-01` 暂停。
7. 回到该 ready 状态的开发节点，点击「派发」。
8. 观察错误提示和运行记录。
9. 重新启用 `backend-01` 后重试。

预计输出：

1. 暂停时派发请求被服务端拒绝，提示包含「Digital Employee「Backend Engineer 01」已暂停，不能派发」。
2. 不创建新的 Agent 运行记录；失败尝试不会被页面显示为成功。
3. 治理中心能看到 `backend-01` 处于暂停的风险项；若历史运行存在，不会把旧格式失败冒充本次暂停原因。
4. 重新启用后满足授权和 Runtime 条件时可以派发。

#### F4.5 显式 deny 优先

所需材料：

1. 操作人：Profile A，登录 `flow-owner`，全局管理员。Runtime Profile 是挂在数字员工上的执行限制，不是 Profile A 自己的用户配置。
2. 被限制对象：数字员工 `Backend Engineer 01 / backend-01`。
3. `backend-01` 已按 F3.2-F3.4 启用；目标工作区已有 F4.1 的 `<WS_ID> / member / read, write` 授权；Task Worker Profile `backend-agent` 已按 F3.1 创建。
4. 可复用 F4.4 的 `docs/fixtures/workflow/employee-node-manual.md`。若 F4.4 后没有可用实例，按第 6 步新建。
5. 边界条件：当前工作流派发请求的动作是 `read` / `write`，所以本用例用 `write` 验证端到端拒绝。不要写 `workspace.write`；除非运行契约实际请求 `tool:workspace.write`，否则它不会进入票据的拒绝列表。

步骤：

1. Profile A 打开 Settings >「身份与权限」>「企业员工」>「目录」。
2. 找到 `Backend Engineer 01`，点击「详情」。
3. 展开「新增 Runtime Profile」，创建一个专用 deny Profile：
   1. 配置名：`backend-deny-write-runtime`
   2. 工作区：`<WS_ID>`
   3. Provider：`spawn`
   4. 模型：留空
   5. 允许工具：`write`
   6. 禁止工具：`write`
   7. 最大轮次：`50`
   8. 最大分钟：`30`
   9. 映射 Task Worker Profile：`backend-agent`
4. 点击「保存 Runtime」，等待表单收起并显示成功提示。
5. 回到 `backend-01` 详情，确认 active Runtime Profile 是 `backend-deny-write-runtime`，原有 `backend-runtime` 显示为停用。
6. 准备并打开 `employee-node-manual` 实例：
   1. Profile A 回到主操作区，打开「工作流」页签；这是流程实例页，不是 Settings 弹窗里的「工作流」设置页。
   2. 确认右上或左侧工作区选择为 `<WS_ID>`，必要时点击「查看工作区全部」，避免只看到当前会话实例。
   3. 若复用 F4.4 实例：在搜索框输入 F4.4 使用的实例标题，点击标题卡片展开实例详情。
   4. 若没有可复用实例：点击「模板管理」，把 `docs/fixtures/workflow/employee-node-manual.md` 的全部内容粘贴到「导入 Markdown 模板」，依次点击「校验」和「保存新版本」；关闭模板管理后，回到「工作流」页签。
   5. 在顶部「选择流程模板」中选择 `Digital Employee 手动派发 v1`，在实例标题框输入 `F4.5 deny runtime`，点击「启动」。
   6. 在实例列表搜索 `F4.5 deny runtime`，点击标题卡片展开；确认实例下「开发」节点执行者为 `数字员工 · backend-01`，状态为「就绪」。
7. 单独确认 `backend-01` 已启用：Profile A 打开 Settings >「身份与权限」>「企业员工」>「目录」，找到 `Backend Engineer 01`；如果状态不是「启用」，点击「启用」。返回「工作流」页签并刷新。
8. 在展开的开发节点中，由节点责任人 Profile B 或 Profile A 点击「派发」。
9. 等待 Agent 运行结束。若 Agent 因输出格式重试失败，先修复模板输入或重新派发，直到出现一次成功运行；不要把输出格式失败误判为本用例结果。
10. 观察开发节点状态、交付物、Agent 运行记录和节点事件。
11. 验证恢复路径时，回到 Settings >「身份与权限」>「企业员工」>「数字员工 / 真人员工」，进入 `Backend Engineer 01` 详情。
12. 展开「新增 Runtime Profile」，创建一个恢复用 active Profile：
    1. 配置名：`backend-allow-write-runtime`
    2. 工作区：同一个 `<WS_ID>`
    3. Provider：`spawn`
    4. 模型：留空
    5. 允许工具：`write`
    6. 禁止工具：留空
    7. 最大轮次：`50`
    8. 最大分钟：`30`
    9. 映射 Task Worker Profile：`backend-agent`
13. 点击「保存 Runtime」，等待表单收起并显示成功提示；确认 `backend-allow-write-runtime` 为启用，`backend-deny-write-runtime` 已自动停用。
14. 回到主操作区「工作流」页签，刷新后在 `F4.5 deny runtime` 实例的开发节点运行记录中点击「重试」。
15. 打开 Settings >「身份与权限」>「企业员工」>「治理中心」和 Settings >「审计」，按 `backend-01`、`write` 或失败 / 拒绝过滤。

预计输出：

1. 新的 `backend-deny-write-runtime` 保存为 active；同一工作区内旧的 active Runtime Profile 自动停用。
2. Agent 子任务本身可能显示成功，因为工作器已完成生成；但工作流把输出回写到节点时会被票据拒绝。
   - Agent 运行记录状态显示 `已成功 · 输出被票据拒绝`，而不是普通的「成功」或「失败」。
3. 开发节点最终为「阻塞」，节点说明包含 `Digital Employee 输出被拒绝` 和 `action is explicitly denied`。
4. 必交交付物仍保持「待提交」，实例不能继续到后续节点。
5. 节点提供「重试」入口；保存允许 `write` 的新 active Runtime Profile 后点击「重试」，会签发新票据并创建第 2 次运行。
6. 第 2 次运行成功时，交付物由 `Backend Engineer 01` 自动提交，开发节点变为「完成」，流程可继续推进。
7. 审计出现 `write / 拒绝` 记录，并包含 `employeeId`、`workspaceId`、`ticketId` 和 `runId`；`denied` 优先于同名的 `allowed`。

### F5 Human Avatar / Delegation

#### F5.1 会议派遣结构化分身

1. Profile A 打开左侧会议入口。
2. 选择 `<WS_ID>` 工作区，创建会议 `Employee Avatar 回归`。
3. 进入会议。
4. 点击「+ 添加分身」。
5. 选择有效 Persona。
6. 确认派遣。
7. 在会议中发送：
   1. `请分身记录当前风险。`
   2. `当前结论：交付物门禁必须保留。`
8. 发送一条 @分身 的定向消息。

预计输出：

1. 参与者列表出现分身，显示为主人名下的分身，并带「AI 分身」标识。
2. 分身发言有 AI 标识，与真人消息可区分。
3. Settings >「身份与权限」>「企业员工」>「分身委托」自动新增一条 active 委托。
4. 委托详情显示主人、上下文、目标、授权 / 禁止、发言 / 审批策略和到期时间。

#### F5.2 分身不进入员工目录

1. 打开 Settings >「身份与权限」>「企业员工」>「目录」。
2. 搜索分身显示名。
3. 打开「数字员工」tab。
4. 回到「分身委托」。

预计输出：

1. 员工目录没有新增分身记录。
2. 数字员工数量不因派遣分身增加。
3. 分身只出现在「分身委托」。
4. 分身条目明确显示 `Human Avatar`，不显示为独立员工。

#### F5.3 生命周期：暂停、恢复、延期、召回

1. Profile A 打开「分身委托」。
2. 选择 active 委托。
3. 点击「延期」。
4. 点击「暂停」。
5. 回到会议尝试让它继续响应。
6. 回到委托点击「恢复」。
7. 最后点击「召回」。
8. 回到会议观察后续消息。

预计输出：

1. 每次操作有成功提示并刷新状态。
2. 暂停期间分身不再自动响应新消息。
3. 恢复后满足发言策略时才继续响应。
4. 召回后分身不能继续发言或读取新资料。
5. 非法状态按钮 disabled，例如已召回记录没有「暂停」按钮。

#### F5.4 到期边界

1. 创建一条短有效期委托，或选择已有委托查看到期时间。
2. 等待到期，或用测试环境支持的最小有效期。
3. 到期后在会议中 @该分身。
4. 打开「分身委托」和「治理中心」。

预计输出：

1. 到期后分身不再响应。
2. 委托状态显示已过期或等价状态。
3. 治理中心出现票据失效 / 委托受限风险项。
4. 不出现“已过期但仍自动发言”。

#### F5.5 会后报告生成

1. 使用 F5.1 的会议。
2. 让分身退出会议，或关闭会议。
3. 打开 Settings >「身份与权限」>「企业员工」>「分身委托」。
4. 展开对应委托的分身报告。
5. 打开「治理中心」>「分身报告中心」。
6. 打开中间主操作区「工作台」>「分身报告」。

预计输出：

1. 每个分身有一条独立报告。
2. 报告状态为「已生成」或明确失败原因。
3. 报告内容包含关键过程、结论 / 立场、风险、待确认事项或实现中的等价章节。
4. 报告不属于其他真人分身。
5. 三个入口看到同一份报告内容。

#### F5.6 报告失败可见

1. 如可用故障注入或最小 Persona 使报告生成失败。
2. 若无法注入，记录为当前环境限制，改用已有失败样例验证。
3. 打开「分身委托」「治理中心」「工作台」。

预计输出：

1. 失败报告显示「失败」和错误原因。
2. 治理中心风险与异常列表出现「分身报告失败」。
3. 页面不显示空内容当成功。

### F6 工作流定义与员工执行者

#### F6.1 导入旧 Agent 模板

1. Profile A 打开 Settings >「工作流」。
2. 使用「导入 Markdown 模板」。
3. 选择 `docs/fixtures/workflow/agent-node.md`。
4. 确认导入。
5. 确认模板列表出现新模板；点击「校验」可查看图形校验视图。

预计输出：

1. 导入成功，模板 key 为 `agent-node`，version 为 `2`。
2. 节点执行者可解释为过渡 Task Worker。
3. 自动派发字段显示正确。
4. 不提示 `employee:backend-01` 必填错误。

#### F6.2 导入 Digital Employee 模板

1. Profile A 在完成 `backend-01` 启用、授权和 Runtime 后，打开 Settings >「工作流」。当前工作区需已包含 `workflow-member` 成员（见 F1.1 第 8-9 步），否则导入校验会以「负责人不是当前工作区成员」拒绝。
2. 导入 `docs/fixtures/workflow/employee-node.md`。
3. 点击「校验」，确认图形校验视图无错误。
4. 在「从启用模板发起」填写实例标题并启动，回到中间主操作区「工作流」tab 打开该实例。

预计输出：

1. 导入成功。
2. 开发节点执行者显示 `数字员工 · Backend Engineer 01` 或等价文案。
3. 责任人显示 `Workflow Member`。
4. 必交交付物显示 `实现说明`，要求不少于 20 字。

#### F6.3 引用不存在员工

1. 复制 `employee-node.md` 内容到临时文件。
2. 把 `executor: employee:backend-01` 改为 `executor: employee:not-exists`。
3. 保持 key 和 version 与现有模板不同，导入。
4. 观察导入错误。

预计输出：

1. 导入或启动校验失败。
2. 错误明确指向不存在或不可用员工。
3. 不创建新模板版本。
4. 图形校验不把失败定义显示为已保存。

#### F6.4 非法循环仍被拒绝

1. Profile A 导入 `docs/fixtures/workflow/invalid-cycle.md`。
2. 观察校验反馈。
3. 如页面支持修改，不补充 break 逻辑直接重试。

预计输出：

1. 导入失败。
2. 错误说明存在循环且缺少 break 逻辑。
3. 不产生可用模板。

### F7 工作流执行、运行记录和交付物门禁

#### F7.1 启动员工工作流

1. Profile A 打开中间主操作区「工作流」tab。
2. 默认应显示「查看工作区全部」状态；如处于会话过滤，点击切换。
3. 选择 `employee-node` 或等价模板。
4. 填写标题：`Employee 节点回归`。
5. 点击「启动」。
6. 刷新页面。

预计输出：

1. 出现「已启动工作流」。
2. 刷新后实例仍在列表中。
3. 实例标题为 `Employee 节点回归`。
4. 开发节点进入 ready 或自动派发状态。
5. 左侧切换 session 只过滤视图，不改变工作流归属工作区的事实。

#### F7.2 Digital Employee 自动派发

1. 使用 F7.1 实例。
2. 在节点面板或工作台选择开发节点。
3. 检查执行者和派发方式。
4. 若为 `auto-on-ready`，观察自动派发；否则点击「派发」。
5. 刷新节点详情。

预计输出：

1. 执行者显示 Digital Employee。
2. 运行记录 principalType 为 Digital Employee，并关联 `backend-01`。
3. 运行记录关联 workflow instance、node、Action Ticket 和 Task Worker 映射。
4. 成功、失败、超时、取消状态都清晰可见。
5. 如果运行失败，页面说明失败原因，不把失败输出当作交付物。

#### F7.3 成功输出仍受交付物门禁

1. 等 Agent Run 成功。
2. 打开开发节点交付物。
3. 检查「实现说明」。
4. 在内容不足 20 字时尝试完成。
5. 提交满足要求的说明：

   ```text
   已完成回归实现说明：覆盖员工执行、票据来源、交付物校验和风险记录。
   ```

6. 由责任人 Profile B 或具有完成权限的用户点击「完成」。

预计输出：

1. Agent 成功不直接完成节点。
2. 内容不足时完成被拒绝，提示缺少或不足交付物。
3. 满足 required 交付物后责任人可完成。
4. 完成后节点状态变为完成，流程推进。

#### F7.4 失败 / 超时 / 取消后人工兜底

1. 导入 `docs/fixtures/workflow/agent-node-timeout.md`，或构造极短 timeout 的测试模板。
2. 启动实例。
3. 等待 Agent 运行超时；如果支持取消，也可在运行中点击「取消运行」。
4. 观察节点状态。
5. 由责任人提交符合要求的实现说明。
6. 点击「完成」。

预计输出：

1. 运行显示 `超时` / `已取消`，不显示成功。
2. 节点保持可人工处理状态。
3. 页面提示 Agent 未完成，节点负责人可人工代交或重新派发。
4. 满足必交交付物后才能完成。
5. 人工兜底事件保留 actor 和时间。

#### F7.5 重试上限

1. 使用 `max-attempts: 2` 的模板。
2. 第一次派发失败后，尝试「重新派发」。
3. 第二次失败后再次尝试。
4. 如页面提供 Owner/Admin 越过上限入口，使用管理员账号验证。

预计输出：

1. 前两次允许重试。
2. 第三次普通派发被拒绝。
3. 错误说明达到最大尝试次数。
4. Owner/Admin 显式越限时页面说明这是越限处理，不是普通重试。

#### F7.6 旧 Agent / 新 Employee 身份区分

1. 分别打开 `agent-node` 与 `employee-node` 实例详情。
2. 比较执行者、运行记录和治理活动时间线。

预计输出：

1. 旧模板显示 Task Worker / Agent Profile 身份。
2. 新模板显示 Digital Employee 和稳定 Employee ID。
3. 治理中心的活动来源能区分 `运行票据` 与 `过渡 Task Worker`。
4. 两者都保留交付物门禁。

### F8 工作流审批权限

#### F8.1 真人审批通过

1. 使用一个含审批节点的模板，审批人写 `workflow-member`。
2. Profile A 启动实例并推进到审批节点。
3. Profile B 打开「工作流」或「工作台」。
4. 选择该审批节点。
5. 输入审批意见：`同意，材料完整。`
6. 点击「通过」。

预计输出：

1. 只有 `workflow-member` 看到可用「通过」「否决」按钮。
2. Profile A 若不是审批人，只读显示等待对应审批人。
3. Profile C 没有操作按钮。
4. 通过后状态显示已通过、时间和审批人。
5. 流程推进到下一节点。
6. 主工作流和工作台均提供审批意见输入框；请求携带填写的备注。

#### F8.2 非审批人不能代签

1. 在另一实例推进到同一审批节点。
2. Profile A 打开节点。
3. 尝试寻找通过 / 否决入口。
4. Profile C 重复检查。

预计输出：

1. 非审批人没有可用通过 / 否决按钮。
2. 页面显示「等待对应审批人操作。」或等价只读说明。
3. 即使直接调用 API，也应被服务端拒绝；GUI 至少不能提供误导入口。

#### F8.3 Digital Employee 审批当前边界

1. 导入审批人包含 `approver: employee:backend-01` 的测试模板。
2. Profile A 启动并推进到审批节点。
3. 打开「工作台」>「审批」。
4. 检查操作入口和说明。

预计输出：

1. 审批人显示 Digital Employee。
2. 页面显示「数字员工审批等待专用 runtime decision path。」。
3. 没有真人代签按钮。
4. 实例保持等待，不因浏览器用户操作被误推进。
5. 审批节点不显示「派发」按钮。

#### F8.4 审批否决和流程阻塞

1. Profile B 打开一个自己的待审批实例。
2. 输入否决原因：`交付说明缺少风险项。`
3. 点击「否决」。
4. 刷新流程图和节点状态。
5. 在审批节点尚未成为待审批状态时（上游未完成），尝试直接调用审批 API。

预计输出：

1. 审批状态为否决。
2. 下游节点不进入 ready。
3. 实例显示阻塞或需要处理，而不是完成。
4. 否决原因和操作人可见。
5. 未激活的审批节点（`waiting` 且无已决审批）被拒绝，返回 `approval is waiting for upstream nodes`，不产生审批记录或事件。
6. 审批失败时 UI 显示可读错误，已填写的意见不被清空。

### F9 治理、审计和报告中心

#### F9.1 治理指标

1. Profile A 执行完 F3-F7 的一组操作。
2. 打开 Settings >「身份与权限」>「企业员工」>「治理中心」。
3. 检查指标：员工、授权记录、运行票据、分身委托。
4. 选择全部工作区和全部员工。

预计输出：

1. 指标数量大于 0。
2. 员工数量包含真人和数字员工。
3. 授权记录包含显式授权。
4. 分身委托数量与会议派遣的 delegation 数一致。

#### F9.2 过滤器和搜索

1. 在治理中心选择 `<WS_ID>`。
2. 员工选择 `Backend Engineer 01`。
3. 设置开始日期为今天。
4. 在搜索框输入 `失败`。
5. 清空搜索，再输入审批、报告、`backend-01` 分别测试。

预计输出：

1. 活动、风险、报告和运行记录随过滤条件更新。
2. 日期边界包含当天开始和结束。
3. 搜索命中运行异常、审批动作、报告内容或上下文。
4. 无结果时显示「没有 / 暂无」类空状态，不显示误导性旧数据。
5. 搜索覆盖中文状态标签（失败、超时、允许、拒绝）、employeeId、profileId、ticketId 和主体类型（数字员工 / Task Worker）。

#### F9.3 风险与异常

1. 确保至少存在以下一项：
   1. 被拒绝的越权动作；
   2. failed / timeout / interrupted 运行；
   3. 失败报告；
   4. 缺少 Task Worker 映射的 Runtime；
   5. 暂停或归档员工；
   6. 失效票据。
2. 打开治理中心「风险与异常」。
3. 展开相关条目。

预计输出：

1. 每个异常有类型、时间、主体和原因。
2. 拒绝动作显示 employeeId、动作和原因。
3. 运行异常显示员工或 Profile、实例和节点。
4. 排序按时间倒序，最新在最上。

#### F9.4 活动时间线和权限来源

1. 打开治理中心「员工活动时间线」。
2. 找到一次派发、审批或拒绝。
3. 检查 actor、动作、状态和权限来源。
4. 打开「审计」tab。
5. 展开同一时间段记录。

预计输出：

1. 时间线按最新在上排序。
2. Digital Employee 活动能定位 employeeId。
3. 过渡 Task Worker 能定位 profileId 或显示过渡来源。
4. 审计记录包含 workspaceId、contextId、delegationId、ticketId、runId 中可用的关联字段。
5. 拒绝记录显示拒绝原因。

#### F9.5 权限矩阵

1. 打开治理中心「权限矩阵与运行配置」。
2. 找到 `Backend Engineer 01 · member`。
3. 检查工作区、权限、到期时间。
4. 找到 Runtime Profile，检查预算和映射。

预计输出：

1. 授权没有隐式继承描述。
2. 显式权限 `read, write` 可见。
3. Runtime Profile 显示预算和 `backend-agent` 映射。
4. 缺失映射的配置出现异常或风险提示。

#### F9.6 分身报告中心

1. 打开治理中心「分身报告中心」。
2. 在搜索框输入分身名、主人名或报告关键词。
3. 展开报告。
4. 清空搜索。

预计输出：

1. 报告中心只对管理员显示。
2. 搜索能命中报告内容或错误内容。
3. 每条报告显示创建时间、状态和正文 / 错误。
4. 不显示无权限员工或非测试工作区的数据。

### F10 工作台集成

#### F10.1 入口和固定布局

1. Profile A 打开中间主操作区。
2. 确认有「工作台」tab。
3. 点击「工作台」。
4. 检查顶部标题、工作区名称、当前会话短标识、工作区切换器和刷新按钮。
5. 检查六个基础面板。

预计输出：

1. 六个面板全部出现：员工详情、委托详情、工作流节点、审批、分身报告、管理员权限面板。
2. 顶部工作区显示名称而不是裸 UUID。
3. 当前会话只显示短标识或省略号形式。
4. 工作区切换器可用。
5. 页面没有空白分区或不可解释的占位卡。

#### F10.2 员工详情面板

1. 在「员工详情」选择 `Workflow Owner`。
2. 检查显示名、主体类型、部门 / 岗位、Employee ID。
3. 展开「工作区授权」。
4. 再选择 `Backend Engineer 01`。
5. 展开「工作区授权」和「Runtime Profile」。
6. 管理员状态下展开「审计」。

预计输出：

1. 真人显示「真人员工」，数字员工显示「数字员工」。
2. 授权显示工作区名、角色、权限、到期时间。
3. Runtime 显示 provider、模型、Task Worker 映射。
4. 管理员可见审计，普通成员不可见敏感审计或无审计区块。
5. 管理员对 active 授权可见「撤销」按钮；点击后反馈并刷新授权列表。
6. Employee ID 等 ≥32 字符的长 ID 默认显示为前 8 位 + `…`；悬停显示完整值和「点击复制」提示，点击复制到剪贴板。
7. 新增授权入口跳转 Settings 管理页（提示文案可见）。

#### F10.3 委托详情面板

1. 在「委托详情」选择 active 委托。
2. 检查委托主体、主人、上下文、有效期、目标、立场、授权 / 禁止、发言 / 审批。
3. 点击「延期」。
4. 点击「暂停」。
5. 点击「恢复」。
6. 点击「召回」。
7. 展开关联报告。

预计输出：

1. 委托主体显示 `Human Avatar`。
2. 操作只对 active / paused 状态开放。
3. 每次操作有反馈并刷新。
4. 已召回状态不再显示暂停 / 恢复 / 延期操作。
5. 报告与该委托关联。

#### F10.4 工作流节点面板

1. 在「工作流节点」选择一个实例。
2. 选择任务节点。
3. 检查节点、状态、尝试次数、执行者、责任人。
4. 若 ready 且是 task-worker，点击「派发」。
5. 点击「刷新」。
6. 展开「运行记录」和「节点事件」。

预计输出：

1. 执行者区分真人员工、数字员工或 Task Worker。
2. 派发按钮只在允许状态可用。
3. 运行记录显示 Digital Employee 或 Task Worker、状态和主体名。
4. 节点事件按时间可读显示 actor 和消息。
5. 完成操作受交付物和服务端权限约束。
6. 状态显示「节点第 N 次激活 · 本轮第 M 次派发」双口径；无派发时只显示节点激活次数。
7. 运行记录缺失执行者时显示「未指定执行者」，不显示 `undefined`。
8. 执行者为暂停 / 归档的数字员工时，不显示派发和完成按钮，改为显示明确阻塞原因。

#### F10.5 审批面板

1. 选择审批节点。
2. Profile A 检查非自己审批的记录。
3. Profile B 打开自己为审批人的记录。
4. 输入意见并点击「通过」。
5. 再用一个否决用例点击「否决」。

预计输出：

1. 非审批人只读。
2. 当前审批人能看到输入框、通过、否决。
3. 操作后显示成功反馈并刷新状态。
4. 数字员工审批只显示等待专用 runtime path。
5. 审批失败时显示可读错误，已填写的意见不被清空。
6. 实例或节点未加载时，点击审批按钮显示明确错误，不静默失败。

#### F10.6 分身报告面板

1. 在「分身报告」输入主人名、分身名或报告关键词。
2. 展开结果。
3. 输入不存在的关键词。

预计输出：

1. 搜索结果与治理中心一致。
2. 报告正文或失败原因完整可读。
3. 无结果显示空状态。

#### F10.7 管理员权限面板

1. Profile A 检查面板指标。
2. 展开授权矩阵表格。
3. Profile B 打开同一工作台。
4. Profile C 打开同一工作台。

预计输出：

1. 管理员可见员工、授权记录、Runtime Profile、有效票据指标。
2. 表格列包含员工、工作区、角色、权限、到期。
3. Profile B 不看到治理明细或提示需要全局管理员权限。
4. Profile C 同样无管理数据。

#### F10.8 by-role 面板组合预留

1. 滚动到「按角色面板组合」。
2. 检查 schema 标识和角色卡片。
3. 尝试寻找编辑、拖拽、启用、保存入口。
4. 缩放窗口到 900px 和 390px。

预计输出：

1. 显示 `预留 · schema v1`。
2. 列出 `admin`、`owner`、`member`、`viewer` 的规划模块。
3. 明确说明角色定制编排尚未启用。
4. 没有任何可编辑 / 保存入口。
5. 窄屏面板纵向堆叠，无横向滚动和按钮遮挡。

### F11 响应式、可读性和异常反馈

#### F11.1 桌面 / 窄屏 / 移动

1. 在 1280px 宽度检查 Settings >「身份与权限」>「企业员工」、工作流和工作台。
2. 缩小到 900px。
3. 缩小到 390px。
4. 打开目录、Runtime 表单、工作流启动表单、工作台六面板。

预计输出：

1. 表单控件换行，不压缩文字到不可读。
2. 长 ID / 长标题可换行或省略，并有详情可查。
3. 按钮不覆盖输入框。
4. 主内容区和内部面板不出现无法解释的左右双滚动条。
5. 移动宽度下操作仍可达。

#### F11.2 时间和 ID 可读性

1. 打开员工目录、分身委托、运行记录、节点事件和审计。
2. 检查时间显示。
3. 悬停或展开长 ID。
4. 使用复制能力复制 Employee ID、工作区 ID、实例 ID。

预计输出：

1. 默认显示本地可读时间。
2. 不把 `2026-09-10T00:41:34.467Z` 这类原始 ISO 字符串作为唯一用户可见信息。
3. 长 ID 不撑破布局。
4. 复制值与详情一致。

#### F11.3 服务端错误

1. 用 Profile C 触发一个只读边界下的敏感操作；若 GUI 已禁用，则记录无入口。
2. 用 Profile B 尝试访问管理员治理中心。
3. 在派发条件不满足时尝试派发。
4. 提交一个必填字段为空的表单。

预计输出：

1. 服务端拒绝时 UI 显示可读错误。
2. 成功 / 错误提示不同颜色或明确语义。
3. 错误后不清理用户已填写的无关表单内容，除非安全原因必须重置。
4. 不出现 `undefined`、裸异常堆栈或英文内部错误作为唯一反馈。

#### F11.4 Console 检查

每完成一个 F 模块执行一次：

1. 打开浏览器开发者工具 Console。
2. 清空旧日志。
3. 重复该模块关键操作。
4. 检查输出。

预计输出：

1. 没有未捕获异常。
2. 没有重复请求风暴。
3. 401 / 403 只在权限边界用例中作为预期失败出现，并有 UI 说明。
4. React key / hydration / CORS 类警告计为缺陷。

## 4. 核心端到端旅程

### J1 管理员创建数字员工并由工作流交付任务

前置：

1. 已完成基础账号、工作区、`backend-agent` Task Worker Profile 准备；
2. `backend-01` 尚未创建；
3. 已有 Profile B 为 `<WS_ID>` member。

步骤：

1. Profile A 打开 Settings >「身份与权限」>「企业员工」>「数字员工」。
2. 创建 `backend-01 / Backend Engineer 01 / Backend Engineer / Platform Engineering`，Persona ID 可用有效值或软依赖测试值，负责人为 `Workflow Owner`。
3. 点击「创建草稿」。
4. 打开详情，确认无密码登录。
5. 新增 `<WS_ID>` / `member` / `read, write` 授权。
6. 新增 Runtime Profile `backend-runtime`，映射 `backend-agent`。
7. 启用 `backend-01`。
8. 打开 Settings >「工作流」，导入 `docs/fixtures/workflow/employee-node.md`。
9. 打开中间主操作区「工作流」tab，确认默认「查看工作区全部」。
10. 启动 `employee-node`，标题 `J1 数字员工交付`。
11. 等待开发节点自动派发或手动点击「派发」。
12. 观察 Agent Run 成功或失败。
13. 若成功，检查交付物「实现说明」是否满足 20 字以上。
14. Profile B 打开同一实例。
15. 提交或补充人工说明后点击「完成」。
16. Profile A 刷新流程图和治理中心。

预计输出：

1. Digital Employee 创建、启用、授权、Runtime 配置全部成功。
2. 工作流执行者显示 `Backend Engineer 01 · 数字员工`。
3. 派发生成 Employee Principal / Digital Employee 运行记录，而不是普通登录用户。
4. 成功输出不能绕过 required 交付物。
5. Profile B 只有满足交付物后能完成。
6. 治理中心出现派发、成功 / 失败、完成相关活动。
7. 任何失败都有原因，且人工兜底仍可用。
8. Console 无未捕获异常。

### J2 真人在会议中派出分身并获得报告

步骤：

1. Profile A 在左侧会议入口创建 `J2 分身评审`。
2. 进入会议，发送议程消息：`评审目标：确认员工平台回归风险。`
3. 点击「+ 添加分身」，选择 Persona。
4. 确认派遣。
5. 发送群发消息：`请关注交付物门禁和审批边界。`
6. @该分身发送：`请记录你的观点和风险。`
7. 等待分身按策略响应。
8. Profile A 打开 Settings >「身份与权限」>「企业员工」>「分身委托」。
9. 检查委托目标、授权 / 禁止、发言 / 审批策略。
10. 点击「暂停」，回会议确认不再响应。
11. 恢复委托。
12. 继续发送一条 @分身消息。
13. 让分身离开或关闭会议。
14. 回到「分身委托」展开报告。
15. 打开治理中心和工作台的分身报告面板复查。

预计输出：

1. 分身在参与者列表显示为主人的分身，带 AI 标识。
2. 分身不进入员工目录。
3. 暂停期间不响应，恢复后才按策略响应。
4. 离会或关闭会议生成独立报告。
5. 报告包含客观过程、结论、风险和待确认事项。
6. 治理中心和工作台可见同一报告。
7. 委托生命周期操作全部留痕。

### J3 数字员工越权 / 受限被治理中心捕获

步骤：

1. Profile A 创建数字员工 `restricted-01` 并启用。
2. 不给它任何工作区授权。
3. 导入执行者为 `employee:restricted-01` 的测试模板并启动。
4. 尝试派发。
5. 给它 `viewer / read` 授权，但 Runtime 缺少 Task Worker 映射。
6. 再次尝试派发。
7. 创建完整 Runtime 后派发一次允许执行的任务。
8. 将员工暂停，再尝试派发。
9. 打开治理中心风险与异常、活动时间线、权限矩阵。
10. 按员工 `restricted-01` 和工作区过滤。

预计输出：

1. 无授权派发失败，原因明确。
2. 缺 Runtime 或映射派发失败。
3. 满足条件后才能成功派发。
4. 暂停员工派发失败。
5. 每次拒绝都出现在风险与异常。
6. 成功与失败都出现在活动时间线。
7. 权限矩阵只显示显式授权，不显示 Persona 隐式授权。
8. 服务端拒绝不被 UI 显示为成功。

### J4 责任人处理 Agent 失败并保留门禁

步骤：

1. Profile A 导入 `docs/fixtures/workflow/agent-node-timeout.md`。
2. 启动标题为 `J4 超时兜底` 的实例。
3. 等待 Agent 超时；若实现支持取消，也可在运行中取消。
4. Profile B 打开实例。
5. 检查开发节点状态和失败原因。
6. 尝试在交付物为空时点击「完成」。
7. 提交满足要求的实现说明。
8. 点击「完成」。
9. 刷新节点、事件、治理中心。

预计输出：

1. Agent 状态为超时 / 取消 / 失败，不是成功。
2. 空交付物不能完成。
3. 责任人提交满足要求的交付物后可以完成。
4. 流程推进且事件记录人工兜底 actor。
5. 治理中心保留运行异常和人工完成两类记录。

### J5 审批边界与数字员工审批等待

步骤：

1. 准备一个含真人审批节点和 Digital Employee 审批引用的流程。
2. Profile A 启动实例。
3. Profile A 打开真人审批节点，确认自己不是审批人时的只读状态。
4. Profile B 打开同一节点，输入意见并点击「通过」。
5. 流程推进到 Digital Employee 审批节点。
6. Profile A、B、C 分别检查审批面板。
7. 尝试寻找真人代签入口。
8. 打开治理中心过滤该实例。

预计输出：

1. Profile B 能完成真人审批。
2. Profile A / C 不能代签真人审批。
3. Digital Employee 审批显示等待专用 runtime decision path。
4. 没有任何浏览器用户能代替数字员工通过审批。
5. 实例保持等待或进入明确定义的阻塞状态。
6. 治理中心能追溯审批引用和当前等待原因。

### J6 治理管理员回答“这是谁、能做什么、做过什么”

步骤：

1. 完成至少一次 Digital Employee 派发、一次 Human Avatar 会议、一次拒绝操作。
2. Profile A 打开 Settings >「身份与权限」>「企业员工」>「治理中心」。
3. 按工作区 `<WS_ID>` 过滤。
4. 按员工 `backend-01` 过滤，记录活动。
5. 按员工 `restricted-01` 过滤，记录拒绝。
6. 按时间今天过滤。
7. 打开权限矩阵和 Runtime 配置。
8. 打开分身报告中心，搜索 J2 报告关键词。
9. 打开「审计」，展开一条拒绝记录。

预计输出：

1. 管理员能看出主体是真人员工、数字员工还是 Human Avatar。
2. 每条敏感活动有 employeeId / profileId、时间、动作、结果。
3. 拒绝记录有权限来源、票据或原因。
4. Runtime 显示显式工具策略、预算和 Task Worker 映射。
5. 分身报告能按内容搜索。
6. 审计记录能串联 workspace、context、delegation、ticket、run 等可用字段。

## 5. 测试数据和文件

### 5.1 工作流文件

以下文件位于 `docs/fixtures/workflow/`：

| 文件                      | 用途                                        |
| ------------------------- | ------------------------------------------- |
| `agent-node.md`           | 旧 `agent:<profileId>` 自动派发和交付物门禁 |
| `agent-manual.md`         | 手动派发 Task Worker                        |
| `agent-node-timeout.md`   | 超时 / 失败 / 人工兜底                      |
| `employee-node.md`        | `employee:<employeeId>` 正式数字员工执行    |
| `employee-node-manual.md` | 数字员工手动派发和生命周期拒绝边界          |
| `product-delivery-v2.md`  | 常规业务流程回归                            |
| `controlled-loop.md`      | 循环 break 逻辑                             |
| `invalid-cycle.md`        | 死循环必须被拒绝                            |
| `parent-child.md`         | 父子流程                                    |
| `sub-process.md`          | 子流程                                      |

导入失败用例可复制后修改，不要直接改 fixtures：

1. `employee:missing-employee`：验证不存在员工；
2. `user:not-a-member`：验证非工作区成员；
3. 删除 controlled loop 的 break 字段：验证缺 break 拒绝；
4. 将 version 改回已存在版本：验证重复版本拒绝。

### 5.2 员工与授权数据

| 对象                | 最小数据                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------ |
| Task Worker Profile | `backend-agent` / `后端开发 Agent` / `task-worker`                                               |
| Digital Employee    | `backend-01` / `Backend Engineer 01` / `Backend Engineer` / `Platform Engineering`               |
| 授权                | `<WS_ID>` / `member` / `read, write`                                                             |
| Runtime             | `backend-runtime` / `spawn` / `50` 轮 / `30` 分钟 / 映射 `backend-agent`                         |
| Deny Runtime        | `backend-deny-write-runtime` / `spawn` / allowed `write` / denied `write` / 映射 `backend-agent` |
| 受限员工            | `restricted-01`，无授权或仅 `viewer / read`                                                      |
| 归档员工            | `archive-01`，用于派发拒绝                                                                       |

### 5.3 分身委托数据

| 字段     | 建议值                                           |
| -------- | ------------------------------------------------ |
| 显示名   | `Workflow Owner 的评审分身`                      |
| 上下文   | J2 会议 ID                                       |
| 目标     | `跟踪回归风险并输出客观报告`                     |
| 允许     | 阅读会议、阅读资料、草拟报告、提问 / 记录风险    |
| 禁止     | 最终审批、代表主人同意结论                       |
| 审批策略 | `suggest-only` 或当前实现的 never / 建议型等价值 |
| 到期     | 测试结束后 15-30 分钟                            |

### 5.4 交付物文本

有效实现说明：

```text
已完成实现说明：覆盖员工执行、显式授权、Action Ticket、交付物校验和风险记录。
```

无效说明：

```text
ok
```

有效评审意见：

```text
同意，材料包含实现说明、风险和测试结论。
```

无效否决应填写原因：

```text
交付说明缺少风险项和回滚方案。
```

## 6. 执行顺序建议

1. 先执行 1.2-1.5 环境准备。
2. 执行 F1-F5，确认身份、目录、生命周期、授权和分身基础稳定。
3. 执行 F6-F8，确认工作流定义、员工执行、门禁和审批。
4. 执行 F9-F11，确认治理、工作台、响应式和异常反馈。
5. 执行 J1-J6 端到端旅程。
6. 最后重复 F10.8 和 F11.1 作为回归收尾。
7. 汇总缺陷、截图、Console 记录和对象 ID。

如果时间有限，最低回归集为：

1. F1.1、F2.1、F3.2-F3.4；
2. F4.2、F4.4；
3. F5.1、F5.3、F5.5；
4. F6.2、F7.1-F7.3、F8.1、F8.3；
5. F9.3、F10.1-F10.8；
6. J1、J2、J4。

## 7. 缺陷记录模板

每条缺陷至少记录：

```md
### BUG-<编号>：<短标题>

- 阶段 / 用例：F7.2 / J1
- 环境：macOS + Chrome Profile A + port 33117
- 账号：flow-owner
- 工作区：`<WS_ID>`
- 对象：employee `backend-01`, instance `<INSTANCE_ID>`, node `development`
- 复现步骤：
  1. ...
  2. ...
- 实际结果：
  - ...
- 预计结果：
  - ...
- 证据：
  - 截图 / 录屏 / Console
- 初步影响：阻塞 / 严重 / 一般 / 轻微
```

## 8. 通过 / 失败判定

### 通过条件

1. F1-F11 全部通过；
2. J1-J6 全部通过；
3. 自动化 `corepack pnpm check` 通过；
4. 当前预留能力没有伪装为已启用；
5. 当前明确不做的 Digital Employee 最终审批不会被真人代签；
6. 没有高危安全和权限缺陷；
7. Console 无未捕获异常。

### 阻塞发布的问题

1. Digital Employee 获得隐式权限或密码登录；
2. Human Avatar 进入员工目录；
3. Avatar 能继承主人全部权限或执行未授权审批；
4. 非审批人能通过 GUI 或公开 API 推进审批；
5. Agent 成功输出绕过 required 交付物；
6. 暂停 / 归档员工仍能派发；
7. deny 策略不生效；
8. 服务端拒绝被 UI 显示为成功；
9. 工作台绕过服务端权限；
10. 治理中心无法追溯 Employee / Ticket / Run / Delegation 来源。
