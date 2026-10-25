# E7 Workstation GUI 详细测试方案

本文覆盖 E7「Workstation 集成」的完整 GUI 回归。测试对象是中间主操作区的「工作台」，以及它与员工目录、数字员工授权、委托单、分身报告、工作流节点、审批和治理中心的组合行为。

本文独立执行，不覆盖既有测试文档。

## 1. 测试范围

| 区域 | 覆盖内容 |
| --- | --- |
| 工作台入口 | 主操作区 tab、工作区切换、当前会话标识、固定面板布局 |
| 员工详情 | 真人员工 / 数字员工、授权、Runtime Profile、审计可见性 |
| 委托详情 | Human Avatar 委托授权、生命周期操作、报告关联 |
| 工作流节点 | 实例选择、节点选择、执行者、状态、运行记录、事件、派发/完成 |
| 审批 | 当前审批人操作、非审批人只读、数字员工审批边界 |
| Avatar 报告 | 报告搜索、成功/失败展示、owner 边界 |
| 管理员权限 | 治理汇总、授权矩阵、非管理员权限边界 |
| 预留能力 | by-role 面板组合 schema 可见但不可编辑 |

本轮明确不验收：

1. by-role 面板组合编辑、拖拽和保存；
2. 自定义模块注册；
3. Digital Employee 最终审批执行；
4. Workstation 修改或绕过服务端权限。

这些能力当前必须表现为不可用或明确等待，不能伪装成功。

## 2. 环境准备

### 2.1 启动隔离环境

1. 进入仓库根目录：

   ```sh
   cd /Users/oliviayang/Codex/一切皆插件/dsh-pluginmax
   ```

2. 确认 `33117` 端口没有旧服务；如果被占用，先停止旧进程，或改用 `33118`。
3. 执行完整构建和隔离初始化：

   ```sh
   corepack pnpm install --frozen-lockfile
   corepack pnpm build
   rm -rf .tmp/dsh-home
   mkdir -p .tmp
   ./scripts/install-profile.sh
   ```

4. 启动隔离 web 服务：

   ```sh
   DSH_HOME="$PWD/.tmp/dsh-home" node \
     vendor/deepseek-harness/apps/cli/lib/bin.js \
     --profile pluginmax \
     --no-open \
     --port 33117
   ```

5. 终端会打印一个带 token 的 URL，例如：

   ```text
   http://127.0.0.1:33117/?token=<WEB_TOKEN>
   ```

6. 复制该 URL。后续 Profile A 首次进入时使用它。

### 2.2 浏览器 Profile 准备

Pluginmax 登录 token 保存在浏览器 Profile 的 `localStorage` 中。不要只依赖同一 Profile 下的多个普通标签页。

| 浏览器 Profile | 平台账号 | 全局角色 | 工作区角色 | 用途 |
| --- | --- | --- | --- | --- |
| Profile A | `flow-owner` | admin | owner | 管理员、流程发起人、治理验证 |
| Profile B | `workflow-member` | member | member | 普通成员、审批人、执行人 |
| Profile C | `workflow-viewer` | guest | guest | 只读和权限边界验证 |

如果无法使用独立浏览器 Profile，可以在切换账号前点击「退出登录」，确认旧 token 已清除后再登录另一个账号。同一浏览器 Profile 同一时间只能保持一个账号登录。

### 2.3 初始化账号和工作区

1. Profile A 打开 2.1 得到的带 token URL。
2. 打开 Settings >「协作身份」。
3. 如果显示首次初始化表单，填写：
   - 用户 ID：`flow-owner`
   - 显示名称：`Workflow Owner`
   - 初始密码：`Pluginmax#2026`
4. 完成初始化并登录。
5. 在「协作身份」的用户管理中创建：
   - `workflow-member` / `Workflow Member` / `Pluginmax#2026` / 全局角色 `member`
   - `workflow-viewer` / `Workflow Viewer` / `Pluginmax#2026` / 全局角色 `guest`
6. 在「工作区成员」选择测试工作区。
7. 添加 `workflow-member`，成员角色 `member`。
8. 添加 `workflow-viewer`，成员角色 `guest`。
9. 分别点击「保存成员」。

预计输出：

1. Profile A 当前身份为 `Workflow Owner`。
2. 用户列表出现三个账号。
3. 工作区成员列表出现 `flow-owner`、`workflow-member`、`workflow-viewer`。
4. Console 没有未捕获异常。

记录工作区 ID 为 `<WS_ID>`。可通过工作区信息 icon 查看并复制。

### 2.4 准备 Task Worker Profile 和数字员工

1. Profile A 打开 Settings >「Agent」。
2. 选择 `<WS_ID>` 对应工作区。
3. 在「新建 Task Worker Profile」填写：
   - Profile ID：`backend-agent`
   - 显示名称：`后端开发 Agent`
   - 描述：`E7 workstation regression worker`
   - Persona ID：可留空
4. 点击「创建 Profile」。
5. 确认列表出现 `后端开发 Agent`，状态为「启用」，类型为 `task-worker`。
6. 打开 Settings >「员工」>「数字员工」。
7. 填写：
   - Employee ID：`backend-01`
   - 姓名：`Backend Engineer 01`
   - 岗位：`Backend Engineer`
   - 部门：`Platform Engineering`
   - Persona ID：优先选择已存在的人设 ID；若只验证员工模型，可填写 `backend-persona`
   - 负责人：`Workflow Owner`
8. 点击「创建草稿」。
9. 在目录中找到 `Backend Engineer 01`，点击「启用」。
10. 展开员工详情，在「新增工作区授权」中选择：
    - 工作区：`<WS_ID>`
    - 角色：`member`
    - 显式权限：`read, write`
11. 点击「保存授权」。
12. 展开「新增 Runtime Profile」，填写：
    - 配置名：`backend-runtime`
    - 工作区：`<WS_ID>`
    - Provider：`spawn`
    - 模型：留空
    - 最大轮次：`50`
    - 最大分钟：`30`
    - 映射 Task Worker Profile：`backend-agent`
13. 点击「保存 Runtime」。

预计输出：

1. 出现提示「数字员工已创建为草稿。」。
2. `Backend Engineer 01` 状态为「启用」。
3. 员工详情显示工作区授权 `read, write`。
4. Runtime Profile 显示 `backend-runtime` 和映射 `backend-agent`。
5. 数字员工显示「无密码登录」，没有密码登录入口。

### 2.5 准备会议分身委托

1. Profile A 打开左侧会议入口。
2. 选择 `<WS_ID>` 工作区，创建会议：`E7 分身委托验证`。
3. 进入会议。
4. 使用「派分身」或当前实现中的等价入口派遣分身。
5. 填写：
   - 显示名称：`Olivia 的评审分身`
   - 目标：`跟踪 E7 工作台回归风险并输出报告`
   - 立场：`重点关注交付物是否满足门禁`
   - 允许动作：`meeting.read`、`material.read`、`draft.report`
   - 禁止动作：`approval.final`
   - 审批策略：`never`
6. 确认派遣。
7. 在会议中发送至少两条与分身相关的消息。
8. 让分身退出会议，或关闭会议以生成报告。
9. 回到工作台和员工设置页确认报告已生成。

预计输出：

1. 会议参与者列表中分身显示为某个真人的分身，并有 AI/分身标识。
2. Settings >「员工」>「分身委托」出现一条委托记录。
3. 对应委托有 `已生成` 状态的分身报告。
4. 员工目录不新增 Human Avatar 记录。

## 3. 功能测试

### F1 工作台入口、固定布局和预留组合

1. Profile A 打开中间主操作区。
2. 确认 tab 列表包含「工作台」。
3. 点击「工作台」。
4. 检查顶部标题、工作区名称、当前会话短标识和工作区切换器。
5. 检查六个基础面板是否全部出现。
6. 滚动到「按角色面板组合」。
7. 尝试寻找编辑、拖拽、启用、保存布局入口。
8. 将窗口宽度从约 1280px 缩小到约 900px，再到约 390px。

预计输出：

1. 顶部显示「工作台」标题、工作区名称、会话短标识和工作区切换器。
2. 会话短标识形如 `12345678…`，不显示完整长 UUID 作为主信息。
3. 六个面板标题全部可见：
   - `员工详情`
   - `委托详情`
   - `工作流节点`
   - `审批`
   - `分身报告`
   - `管理员权限面板`
4. 「按角色面板组合」显示 `预留 · schema v1`。
5. 卡片列出 `admin`、`owner`、`member`、`viewer` 的规划模块。
6. 页面明确说明角色定制编排尚未启用。
7. 没有任何编辑、拖拽、保存、启用按钮。
8. 窄屏下面板纵向堆叠，文字可换行，没有横向滚动或按钮遮挡。
9. Console 没有未捕获异常。

### F2 员工详情面板

#### F2.1 管理员查看真人与数字员工

1. Profile A 打开「工作台」。
2. 在「员工详情」选择 `Workflow Owner`。
3. 检查显示名、主体类型、部门、岗位、Employee ID。
4. 展开「工作区授权」。
5. 再选择 `Backend Engineer 01`。
6. 展开「工作区授权」。
7. 展开「Runtime Profile」。
8. 展开「审计」。

预计输出：

1. `Workflow Owner` 显示为 `真人员工`。
2. `Backend Engineer 01` 显示为 `数字员工 · 启用`。
3. Employee ID 是 `backend-01`，但不是卡片主标题。
4. 数字员工授权显示工作区名称、`member`、`read, write`。
5. Runtime Profile 显示 `backend-runtime`、`spawn`、映射 `backend-agent`。
6. 审计条目使用本地可读时间，并显示动作和允许/拒绝结果。
7. 页面不把 Persona 显示为权限来源。

#### F2.2 普通成员边界

1. Profile B 使用 `workflow-member / Pluginmax#2026` 登录。
2. 打开「工作台」>「员工详情」。
3. 检查可选员工范围。
4. 展开自己的工作区授权。
5. 仅通过 UI 观察，不修改 token 或调用隐藏接口。

预计输出：

1. Profile B 默认只能选择自己映射出的 Human Employee。
2. 能看到自己的基础详情和当前工作区授权。
3. 不能看到 `Backend Engineer 01` 的管理员审计。
4. 页面不出现空白面板或未捕获异常。

### F3 委托详情面板

前置：存在 `Olivia 的评审分身` 委托。

1. Profile A 打开「工作台」>「委托详情」。
2. 选择 `Olivia 的评审分身`。
3. 检查委托主体、主人、上下文类型、上下文短 ID、有效期。
4. 检查目标、立场与指令、允许动作、禁止动作、发言策略、审批策略。
5. 点击「延期」。
6. 在浏览器弹窗输入 `30`，确认。
7. 点击「暂停」。
8. 观察状态和操作按钮。
9. 点击「恢复」。
10. 点击「召回」。
11. 再次打开「委托详情」下拉框。

预计输出：

1. 委托主体显示 `Olivia 的评审分身 · Human Avatar`。
2. 主人显示真人员工名，不显示裸 UUID 作为主标签。
3. 授权和禁止动作能区分。
4. active 委托显示「延期」「暂停」「召回」。
5. 延期后出现绿色提示「委托有效期已延长。」，有效期刷新。
6. 暂停后出现「委托已暂停。」，操作区出现「恢复」。
7. 恢复后出现启用状态反馈。
8. 召回后出现「委托已召回。」，active/paused 操作区消失。
9. 召回后的委托仍可查看历史和报告，但不能再次暂停/恢复。
