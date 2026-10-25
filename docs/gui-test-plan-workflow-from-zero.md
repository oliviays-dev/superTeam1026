# 工作流 GUI 测试方案（从零执行）

> 目标：从空环境开始，验证当前全局 Shell 下的工作流导入、启动、审批、交付物、Agent / Digital Employee 派发、分支、子流程、权限和治理闭环。
>
> 参考：`docs/workflow-md-guide.md`、`docs/workflow-gui-test-plan.md`、`docs/workflow-agent-gui-test-plan.md`、`docs/gui-test-design-task-e2e.md`。
>
> 交互参考：`docs/demos/platform-interaction-demo.html`；节点编码与缩进规则：`docs/workflow-node-coding-and-indentation-design.md`。
>
> 最近更新（2026-10-19）：补充列表 / 详情拆分、KPI、数据范围切换、节点详情折叠、节点编码（并行 vs N 选 1）、子流程嵌套、进入条件和交付物提交时间等 GUI 回归项。
>
> 环境说明（2026-09-24）：`member / password-456` 在 33124 实测可登录，但它是共享账号，密码可能被其他测试修改。本文不再依赖它；先在 1.3 创建本轮专用 `flow-member` 和 `flow-viewer`。

## 0. 本轮先跑什么

如果只做一轮高性价比回归，执行以下集合：

1. 自动门禁：`corepack pnpm check`。
2. 自动专项：工作流、Agent、Employee、AI Teammate 相关测试文件，共覆盖解析、审批、派发、票据、重启恢复和生命周期。
3. GUI 最小集：`WF-01`、`WF-02`、`WF-03`、`WF-04`、`WF-06`、`WF-08`、`WF-09`、`WF-11`、`WF-12`、`WF-13`、`WF-14`。
4. E2E 最小集：`E2E-WF-01`、`E2E-WF-02`、`E2E-WF-04`、`E2E-WF-05`。
5. 最近 UI 迭代至少加跑 `WF-13`、`WF-14` 和 `E2E-WF-05`；`WF-06` / `WF-08` 同时覆盖并行流程与 N 选 1 分叉的表达差异。
6. 基于上一版 `gui-test-design-task-e2e.md` 的必跑映射：`F-09`、`E2E-04`、`E2E-06`；建议加跑 `F-01`、`F-03`、`F-10`。

任务管理中的 `F-04` 至 `F-07`、`E2E-01` 至 `E2E-03` 和会议 `F-08` / `E2E-05` 本轮可不跑，除非要额外检查任务、会议与工作流的跨模块入口。

## 1. 从零准备

### 1.1 账号与测试资源

| 项目             | 值 / 文件                                                                        | 说明                                                                    |
| ---------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 仓库根目录       | `/Users/oliviayang/Codex/一切皆插件/dsh-pluginmax`                               | 所有命令在这里执行                                                      |
| 当前环境         | `.tmp/dsh-home`，服务端口通常为 `33124`                                          | 已有数据；不要直接删除                                                  |
| 当前测试项目     | `.tmp/smoke-workspace`                                                           | 已在当前环境中注册，`<WS_ID>` 为 `00000000-0000-4000-8000-000000000001` |
| 全新隔离环境     | `.tmp/dsh-home`，端口 `33118`                                                    | 仅在没有其他服务使用时重建                                              |
| 全新测试项目     | `.tmp/gui-workflow-workspace`                                                    | 先用 `mkdir -p` 创建，再在 UI 添加                                      |
| Profile A        | `admin / password-123`                                                           | 全局 admin；当前环境中已存在                                            |
| Profile B        | `flow-member / Pluginmax#2026`                                                   | 本轮专用工作区执行人                                                    |
| Profile C        | `flow-viewer / Pluginmax#2026`                                                   | 本轮专用 guest                                                          |
| 基础工作流       | `docs/fixtures/workflow/gui-from-zero.md`                                        | 人工审批、交付物、二次审批、服务节点                                    |
| 并行工作流       | `docs/fixtures/workflow/product-delivery-v2.md`                                  | 自动化基线为 `v6`；GUI 阶段复制并替换身份后使用 `v7`                    |
| Agent 工作流     | `docs/fixtures/workflow/agent-node.md`、`agent-manual.md`                        | 自动 / 手动派发、取消和重试                                             |
| 失败兜底         | `docs/fixtures/workflow/agent-node-timeout.md`                                   | 1 秒超时转人工                                                          |
| Digital Employee | `docs/fixtures/workflow/employee-node.md`、`employee-approval.md`                | 员工执行与审批边界                                                      |
| 循环 / 子流程    | `docs/fixtures/workflow/controlled-loop.md`、`sub-process.md`、`parent-child.md` | 否决回边、break、判断和子流程                                           |
| 非法模板         | `docs/fixtures/workflow/invalid-cycle.md`                                        | 死循环必须拒绝                                                          |
| 交互参考         | `docs/demos/task-management-demo.html`                                           | 只参考布局和交互，不作为通过证据                                        |

### 1.2 环境启动

| 步骤 | 操作                                                                                                                        | 所需资料                        | 预期                                                                            |
| ---- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------- |
| 1    | 复用当前 `33124` 服务时，跳到 1.3；需要全新环境时继续                                                                       | 当前 `<ROOT_URL>`               | 不删除正在使用的 `.tmp/dsh-home`                                                |
| 2    | `cd /Users/oliviayang/Codex/一切皆插件/dsh-pluginmax`                                                                       | 仓库路径                        | `pwd` 正确                                                                      |
| 3    | 全新环境先停止占用 `33124` 的服务，再执行 `./scripts/bootstrap.sh`                                                          | Git submodule、`pnpm-lock.yaml` | 插件和锁定版 DSH 安装、构建完成                                                 |
| 4    | `./node_modules/.bin/vitest run` 或 `corepack pnpm check`                                                                   | 已安装依赖                      | 全量测试通过；当前实测为 12 个测试文件、167 个用例                              |
| 5    | `rm -rf .tmp/dsh-home .tmp/gui-workflow-workspace && mkdir -p .tmp/gui-workflow-workspace`                                  | 本地临时目录                    | 仅全新环境执行，清理旧数据                                                      |
| 6    | `./scripts/install-profile.sh`                                                                                              | `scripts/install-profile.sh`    | 安装 shell、identity、employee、roles、meeting、workflow、task、teammate、agent |
| 7    | `DSH_HOME="$PWD/.tmp/dsh-home" node vendor/deepseek-harness/apps/cli/lib/bin.js --profile pluginmax --no-open --port 33118` | 已构建的 DSH CLI                | 输出带 token 的 `<ROOT_URL>`                                                    |

服务重启后必须重新复制最新 `<ROOT_URL>`，旧 token 不能继续使用。

### 1.3 账号和工作区初始化

1. 建立三个独立 Chrome Profile：`Workflow A/B/C`，分别打开最新 `<ROOT_URL>`。
2. 复用当前环境时，Profile A 使用 `admin / password-123` 登录。全新环境时，在 Settings > `身份与权限` > `登录账号` 初始化同一账号。
3. 当前环境使用已注册的 `.tmp/smoke-workspace`。全新环境创建 `.tmp/gui-workflow-workspace`，在左侧项目区添加并记录真实 `<WS_ID>`。
4. Settings > `身份与权限` > `登录账号` 创建：
   - `flow-member / Flow Member / Pluginmax#2026 / member`
   - `flow-viewer / Flow Viewer / Pluginmax#2026 / guest`
   - `flow-outsider / Flow Outsider / Pluginmax#2026 / member`
   - 如果用户 ID 已存在且密码未知，改用 `flow-member2 / flow-viewer2`，并同步替换本文和 fixture 中的 ID；不要继续猜旧密码。
5. 在项目管理 > `成员权限` 设置：
   - `admin`：`owner`
   - `flow-member`：`member`
   - `flow-viewer`：`guest`

不要把 `flow-outsider` 加入任何测试项目；它只作为平台账号供 WF-03 验证模板校验和启动期项目成员校验。6. Profile B 使用 `flow-member / Pluginmax#2026` 登录；Profile C 使用 `flow-viewer / Pluginmax#2026` 登录。7. Settings > `员工` > `目录` 确认 `admin`、`flow-member`、`flow-viewer` 对应的真人员工是「启用」；历史环境中已删除的 `workflow-owner / workflow-member / workflow-viewer` 投影应显示「归档」。

如果左下角已经显示 `Admin`，说明当前环境已经初始化。不要再初始化或尝试切换到一个不存在的账号；先在 `身份与权限 > 登录账号` 创建所需账号，再通过左下角 `切换账号` 登录。

预计结果：左下角显示当前账号；切换账号后任务、工作流和员工数据同步刷新；guest 不获得管理入口。

### 1.4 工作流文档

本轮的基本测试文档是 `docs/fixtures/workflow/gui-from-zero.md`，内容如下：

```md
# 工作流：GUI 从零验收

## 元信息

- key: gui-from-zero
- version: 1
- description: 从零验证审批、人工交付物门禁、二次审批和服务节点

## 节点

### 需求确认

- id: requirement-confirmation
- type: approval
- executor: user:admin
- approver: 用户:admin
- policy: any

### 开发与交付

- id: development
- type: task
- executor: user:flow-member
- responsible: user:flow-member
- description: 提交满足字数要求的实现说明
- deliverable: implementation-report
  title: 实现说明
  type: text
  required: true
  min-text-length: 20
  description: 说明实现范围、验证结果和已知风险

### 发布审批

- id: release-approval
- type: approval
- executor: user:admin
- approver: 用户:admin
- policy: any

### 发布

- id: release
- type: service
- executor: system:deployment

## 连接

- requirement-confirmation -> development
- development -> release-approval
- release-approval -> release
```

完整语法以 `docs/workflow-md-guide.md` 为准。重点检查：

1. `## 元信息`、`## 节点`、`## 连接` 各出现一次。
2. `key + version` 决定模板版本，同版本不可重复导入。
3. `user:` 后的 ID 必须是平台账号；启动实例时还必须是当前项目成员。
4. `deliverable` 的子属性保留两空格缩进。
5. `required: true` 的交付物未提交时不能完成节点。
6. `execution: task-worker` 与 `trigger: auto-on-ready` 同时存在才会自动派发。
7. Digital Employee 必须先启用、授权并映射 Runtime Profile。
8. 所有循环必须包含 `break`。

除 `gui-from-zero.md` 外，其余 fixtures 继续保留 `flow-owner / workflow-member` 作为自动化基线；GUI 执行前必须复制到 `.tmp/gui-cases/`，把 `flow-owner` 替换为 `admin`、`workflow-member` 替换为 `flow-member`，并把 `version` 递增 1。平台账号是共享资源；把它们加入 `<WS_ID>` 只影响启动实例，不影响模板校验。如果因密码未知改用 `flow-member2` 等新 ID，同步替换副本中的 `flow-member` 并再次递增 `version`。

## 2. 自动化测试运行清单

### 2.1 全量门禁

```sh
corepack pnpm check
```

当前实测基线：`12` 个测试文件、`163` 个用例、`11` 个 plugin bundle；以本次命令实际输出为准。

### 2.2 工作流专项

```sh
corepack pnpm test -- \
  plugins/dsh-collab-workflow/src/index.test.ts \
  plugins/dsh-collab-agent/src/index.test.ts \
  plugins/dsh-collab-employee/src/index.test.ts \
  plugins/dsh-collab-teammate/src/index.test.ts \
  plugins/dsh-collab-teammate/src/runtime.test.ts
```

本次直接执行 Vitest 的结果为 `12 passed` 个测试文件、`167 passed` 个用例；其中工作流专项有 40 个用例，包含 Task 模块缺席时的独立闭环和 Agent 节点人工完成 / 取消。

如果 `corepack pnpm` 因网络或依赖状态检查阻塞，而 `node_modules/.bin/vitest` 已存在，可直接执行：

```sh
./node_modules/.bin/vitest run \
  plugins/dsh-collab-workflow/src/index.test.ts \
  plugins/dsh-collab-agent/src/index.test.ts \
  plugins/dsh-collab-employee/src/index.test.ts \
  plugins/dsh-collab-teammate/src/index.test.ts \
  plugins/dsh-collab-teammate/src/runtime.test.ts
```

必须确认以下测试通过：

| 范围          | 测试用例                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflow 解析 | `parses parallel branches, approvals, and controlled cycles`、`rejects an uncontrolled cycle`、`parses Agent execution and runtime limits`                                                                                                                                                                                                                                                                                                        |
| Workflow 实例 | `imports, archives previous versions, and starts an instance`、`runs parallel nodes through a join and approval`                                                                                                                                                                                                                                                                                                                                  |
| 审批门禁      | `rejects decisions on a future approval node that is still waiting`、`supports delegation and countersign`                                                                                                                                                                                                                                                                                                                                        |
| 交付物        | `rejects a deliverable and requires a new submission`、`does not accept an agent reply without the required delivery section`                                                                                                                                                                                                                                                                                                                     |
| 分支和循环    | `blocks a controlled loop when break becomes true`、`reactivates a completed node after a controlled rejection`、`starts and completes a sub-workflow`                                                                                                                                                                                                                                                                                            |
| 独立完整性    | `runs the human and approval lifecycle without an optional task module`、`direct-completes a no-review Agent node without a task module`                                                                                                                                                                                                                                                                                                          |
| Agent 派发    | `auto-dispatches a ready Agent node and maps output to the delivery gate`、`allows the responsible user to recover a timed-out agent node manually`、`allows manual intervention to complete a running or blocked Agent node`、`allows manual intervention to cancel an Agent node and closes its task`、`supports manual dispatch, cancellation, retry, permissions, and attempt cap`、`runs workflow task workers in a persistent task session` |
| Employee 派发 | `dispatches employee nodes through mapped runtime and preserves the principal`、`recovers an employee node after an automatic ticket failure`、`reports a suspended employee as the manual dispatch blocker`                                                                                                                                                                                                                                      |
| AI Teammates  | `creates a personal draft and promotes it on first save`、`restricts platform definitions to administrators`、`provisions one runtime identity and reuses it for later tasks`、`refuses to dispatch a teammate that is not active`                                                                                                                                                                                                                |
| 接口边界      | `requires same origin and a valid bearer token`、`blocks non-manager import`、`rejects a member of another workspace`                                                                                                                                                                                                                                                                                                                             |

### 2.3 只跑关键用例

时间不足时使用：

```sh
corepack pnpm test -- plugins/dsh-collab-workflow/src/index.test.ts \
  -t "parses parallel branches|rejects an uncontrolled cycle|imports, archives|runs parallel nodes|rejects decisions on a future approval|rejects a deliverable|supports delegation|blocks a controlled loop|starts and completes a sub-workflow|auto-dispatches|dispatches employee|reports a suspended employee|without an optional task module|without a task module"
```

## 3. 单点 GUI 用例

### WF-01 入口、权限和登录

所需资料：Profile A/B/C。

1. A/B/C 分别打开左侧 `工作流`。
2. 确认页面标题为 `工作流`；A 能看到 `仅看已加入 / 平台全量` 范围切换、`模版管理`、`新建工作流`、四张 KPI 卡（实例总数 / 进行中 / 阻塞·失败 / 已完成），以及工具栏 `全部项目`、`状态：全部`、`全部负责人`、搜索框、`搜索`、`清除筛选`。
3. 确认项目筛选默认是 `全部项目`，`清除筛选` 在无筛选时禁用。
4. A 点击 `模版管理`，确认进入同页的 `工作流模版管理`，而不是打开设置弹窗。
5. B 点击 `模版管理`，确认可查看但 `新建模版 / 编辑 / 启用 / 归档` 不可用；C 不能发起流程。

预期：A（owner/admin）可维护模板；B 可查看但不能修改；C 不能发起流程。KPI 数字与当前项目范围内的实例一致；范围切换和筛选栏布局在桌面 / 窄屏下都不重叠；未登录时提示先在「身份与权限 → 登录账号」登录。

测试记录：10-02 通过；2026-10-19 复跑入口、admin/member 权限和响应式布局通过。当前环境缺少可用的 guest 登录凭据，C 的只读与跨项目越权分支未重跑。

### WF-02 导入、校验和图形检查

所需资料：`docs/fixtures/workflow/wf-02/` 目录下的执行包；`README.md` 记录文件与步骤的对应关系。

1. A 打开全局 `工作流` > `模版管理`。
2. 点击 `新建模版`，全新环境选择 `step-02-gui-from-zero-v1.md`；当前环境已有 `gui-from-zero v1/v2` 时选择 `step-02-gui-from-zero-v3.md`。
3. 点击 `校验`，确认显示 `校验通过`；再点击 `保存新版本`。
4. 点击 `新建模版`，粘贴 `step-04-validation-negative-v1.md`，点击 `校验`。
5. 不修改编辑区内容，继续使用同一个文件再次点击 `校验`。
6. 清空编辑区后粘贴 `step-06-validation-positive-v1.md`，点击 `校验`；确认通过后不保存，点击右上角 `x` 关闭编辑器。
7. 点击 `新建模版`，导入 `step-07-product-delivery-v7.md`，确认模板显示为 `产品交付 v7`。
8. 点击 `新建模版`，粘贴 `step-08-invalid-cycle-v2.md`，尝试保存。

预期：模板列表与详情在同一个内联页面显示；基础模板详情按 `01/02/03/04` 展示四个节点、依赖和负责人；并行模板显示需求评审、开发、测试准备、发布审批、发布；非法死循环出现 `cycle requires a break condition` 且不落库。`workflow-member` 不再是平台账号，校验错误必须完整列出所有引用，不能只显示「校验失败」；重复校验未变更内容时仍保持失败，不能变成通过；修正 ID 后详细错误被通过结果替换。右上角反馈保持短文案并自动消失，详细错误保留到用户关闭或触发下一次校验/保存。新版界面没有 `保存后启用` 复选框，保存模板默认启用。

测试记录：10-02 测试通过

### WF-03 项目筛选和新建工作流弹窗

所需资料：已启用的 `GUI 从零验收` 当前版本（全新环境为 v1，复用环境可为 v3）；平台账号 `flow-outsider`（已在 1.3 创建，但未加入 `<WS_ID>`）；`docs/fixtures/workflow/wf-03/step-01-membership-check-v1.md`。

1. A 在 `模版管理 > 新建模版` 粘贴 `step-01-membership-check-v1.md`，创建临时模板 `membership-check v1`：一个 approval 节点使用 `executor: user:flow-outsider` 和 `approver: 用户:admin`。点击 `校验`，确认通过；保存并启用。
2. A 点击 `新建工作流`，选择 `<WS_ID>` 和 `membership-check`。点击 `启动`。
3. A 在项目管理 > `成员权限` 把 `flow-outsider` 加入 `<WS_ID>`，角色为 `member`，再重新启动。
4. B 打开全局 `工作流`，确认项目筛选默认是 `全部项目`；切换为 `<WS_ID>` 对应项目，再切回 `全部项目`。
5. 从 `工作流` 切到 `任务`，再点回 `工作流`，确认项目筛选再次默认为 `全部项目`（不继承上次选择）。
6. 使用状态和当前节点负责人筛选，确认列表随条件变化；KPI 仍按数据范围统计、不随状态筛选跳变；`清除筛选` 恢复全部条件。
7. 点击 `新建工作流`，确认打开弹窗而不是页面内常驻表单。
8. 在弹窗中选择 `项目归属` 和 `工作流模版`，检查 `节点预览`。
9. 在 `工作流名称` 输入 `WF-03 基础交付`，点击 `启动`。
10. 打开该实例详情，切换 `仅看已加入 / 平台全量`，确认页面回到列表，且 KPI、筛选栏、`工作流实例` 标题和列表都正常显示。

预期：`flow-outsider` 是平台账号时模板校验通过，但它还不属于 `<WS_ID>` 时启动被拒绝，提示包含「不是当前工作区成员」，且不创建实例；加入项目后可启动。每次进入工作流页项目筛选默认 `全部项目`；全局页不再提供 `只看当前会话`；项目和状态筛选正确、KPI 不随筛选跳变、清除筛选有效；新建弹窗同时显示项目归属、模板和节点预览；启动成功后弹窗关闭，列表出现实例；在详情中切换数据范围必须回到列表，不能出现只剩空状态的白屏；切换账号不会显示其他项目无权访问的实例。

测试记录：10-02 通过；2026-10-19 复跑项目默认值、状态/负责人/清除筛选、新建弹窗和数据范围切换均通过。

### WF-04 人工交付物、系统服务节点和管理员兜底

所需资料：`WF-03 基础交付`。

1. A 展开 `需求确认`，点击 `通过`。
2. B 展开 `开发与交付`，不填交付物直接点击 `完成`。
3. 输入少于 20 字的文本，尝试提交。
4. 输入至少 20 字的实现说明，点击 `提交交付物`，再点击 `完成`。
5. A 通过 `发布审批` 后展开 `发布`，检查节点状态、标题、执行者和提示。
6. A/B 打开 `任务管理`，用来源筛选 `工作流`，确认没有为系统服务节点 `发布` 创建 Task。
7. B 展开 `发布`，确认没有完成操作；A 刷新后在同一位置确认可以看到 `管理员完成`，并点击完成。
8. 把工作流详情宽度分别调整到桌面、约 760px 和约 390px，重新展开 `发布`。

预期：没有交付物时按钮显示 `缺少 1 项交付物`；字数不足不能提交；提交后状态为 `已提交`，节点可完成并进入发布审批。系统服务节点显示 `等待系统执行`，状态标签独占一行，`发布就绪` 标题和说明不被挤压或遮挡；提示说明它不创建个人 Task，只等待系统接入或 Owner/Admin 兜底。任务管理中不能出现可拖拽完成的系统服务 Task；B 不能完成节点，A（owner/admin）可以兜底完成；窄屏下状态标签完整显示，节点内容仍然可读。

测试记录：10-02 测试通过

### WF-05 否决、返工和受控循环

所需资料：`controlled-loop.md` 的 GUI 副本（替换真人账号并递增版本）。

1. A 在 `工作流 > 模版管理 > 新建模版` 导入 `受控返工流程`，返回列表后点击 `新建工作流` 启动。
2. A 完成 `需求确认`。
3. B 进入 `测试` 节点，连续执行否决，观察回边次数。
4. 达到 `attempts >= 3` 后再次否决。

预期：前两次否决回到 `开发`；审批 Task 在逆向流转后保持待 Review 并可再次产生结论，不因节点回退被误标完成；达到 break 后目标节点阻塞，后续 `发布就绪` 不 ready；节点显示尝试上限和触发条件。

测试记录：10-02 测试通过

### WF-06 并行、汇合与多人审批

所需资料：`product-delivery-v2.md` 的 GUI 副本 `产品交付 v7`。

1. B 点击 `新建工作流`，选择 `产品交付 v7`，名称填 `WF-06 并行交付` 后启动。
2. B 通过 `需求评审`，确认 `开发` 和 `测试准备` 同时 ready。
3. 在 `任务管理` 用来源筛选 `工作流` 确认 `发布审批` 尚未生成 Task；`开发` / `测试准备` ready 后分别生成进行中 Task，卡片和详情都有来源标识。
4. B 完成 `开发` 的人工交付物并完成节点，再完成 `测试准备`；对应 Task 生命周期一致。
5. `发布审批` 生成待 Review Task，描述包含 `并签：全部审批人通过后才完成`。
6. B 在 Task 详情把该审批 Task 改派给 `admin`，刷新工作流详情；预期审批人变为 Admin，原负责人不能再通过。
7. 打开工作流来源 Task 详情，确认普通执行输入框已被替换为 `由工作流节点驱动` 提示；审批 Task 可直接通过/退回，执行 Task 提供 `打开工作流节点`。
8. A 和 B 分别对 `发布审批` 点击 `通过`，其中原负责人操作应被拒绝，Admin 通过后继续等待另一位审批人。
9. 完成并签后，A 完成 `发布` 服务节点。

预期：开发或测试任一支路未完成时发布审批不 ready；`policy: all` 下第一位通过后仍等待；两人通过后发布 ready；发布完成后实例完成。流程图必须把该段显示为虚线「并行流程」容器，编码 `3-1` / `3-2`，汇合节点编码 `4` 且不缩进；节点详情中汇合节点显示中性灰「汇合」标签，流程概览节点上不重复显示「汇合」。审批 Task 的通过/退回会回写工作流，工作流侧转交 / 加签也会同步 Task 负责人；工作流任务不能拖拽改状态。

测试记录：10-09 通过；2026-10-19 复跑并行容器、编码、汇合标签和响应式布局通过。

### WF-07 审批转交、加签、未来节点

所需资料：`sub-process.md` 和 `product-delivery-v2.md` 的 GUI 副本（替换真人账号并递增版本）。

1. A 在 `工作流 > 模版管理 > 新建模版` 导入 `complex-review`，返回列表点击 `新建工作流` 启动，确认第一阶段只有 `架构评审` ready。
2. 在 `安全复核` 仍 waiting 时尝试审批。
3. A 通过 `架构评审`。
4. 对 `安全复核` 执行转交或加签，再完成审批。

预期：未来审批节点拒绝操作且不产生记录；转交后原审批人不能继续操作；加签后必须新增审批人完成；事件保留转交 / 加签来源。

测试记录：10-09 测试通过

### WF-08 判断、子流程和服务节点

所需资料：`sub-process.md`、`parent-child.md`。

1. 先完成 WF-09 第 1-3 步，记录动态 Agent Profile ID。
2. 把两个 fixture 复制到 `.tmp/gui-cases/`；把 `flow-owner` 替换为 `admin`、`workflow-member` 替换为 `flow-member`，递增 `version`，再把 `agent:backend-agent` 和 `agent-profile: backend-agent` 中的 `backend-agent` 替换为记录到的 Profile ID。
3. A 在 `工作流 > 模版管理 > 新建模版` 依次导入并启用子流程副本和父流程副本。
4. 点击 `新建工作流` 启动父流程，名称填 `WF-08 复杂方案`，录入 `{"complexity": 8}`。
5. 检查流程概览：该段是实线「分支流程 · 2 选 1」，编码为 `2a` / `2b`，不是虚线「并行流程」；`2a` 显示进入条件 `complexity >= 8`，`2b` 显示默认分支的反面条件 `complexity < 8`。
6. 点击 `2a 复杂方案评审`，确认节点展开后出现「子流程 · 2」和子流程模板预览，内部节点编码为 `2a.1 架构评审`、`2a.2 安全复核`；分支未命中时内部节点状态为「未启动」。
7. 完成子流程两个审批。
8. 再次点击 `新建工作流` 启动 `WF-08 标准方案`，录入 `{"complexity": 3}`；确认 `2a` 跳过、`2b` ready，进入条件仍完整显示。
9. 完成标准开发和服务节点。

预期：高分实例创建并回写子流程；低分实例跳过子流程；父流程在子流程完成后继续；两个实例都最终完成。N 选 1 分叉必须与并行流程在容器样式、标题和编码上明确区分；不能再把 `2a` / `2b` 显示成普通并行兄弟。子流程节点必须显示内部节点数量，点击后能查看实际实例内容，未启动时能查看模板预览和 `2a.1` / `2a.2` 层级编码；不能只显示一个没有下钻入口的 `2a` 卡片，也不能使用泛化的「默认分支」作为进入条件。

测试记录：10-09 通过；2026-10-19 复跑 N 选 1 条件、子流程展开和层级编码通过。

### WF-09 Agent 自动 / 手动派发和失败兜底

所需资料：`agent-node.md`、`agent-manual.md`、`agent-node-timeout.md`。

1. A 打开左侧 `AI Teammates` > `新建平台 Teammate`，创建 `Backend Worker`，填写专业角色、基础说明和 SOUL，点击 `保存全局定义`，再点击 `生效`。
2. 在 `任务管理` 新建一个测试任务并指派给 `Backend Worker`。当前实现会自动开始执行，并在首次指派 / 触发时自动开通 Agent Profile、Employee、Runtime Profile；仅在未自动启动时才补发指令。
3. 回到 `AI Teammates` 的 `定义态管理` > `执行身份`，记录生成的 `Agent Profile ID`。
4. 把 `agent-node.md` 复制到 `.tmp/gui-cases/`，把 `workflow-member` 替换为 `flow-member` 并递增 `version`，再将 `executor: agent:backend-agent` 替换为记录到的 Profile ID；在 `模版管理 > 新建模版` 导入，先在创建执行身份的项目启动，再切换到另一个成员项目启动，确认平台 Teammate 派生的 Profile 都能自动派发。
5. 检查 Agent 运行区域、trigger、runSeq、prompt 摘要、运行状态和交付物。
6. 用同样方式修改 `agent-manual.md`，启动后手动点击 `派发 Agent`；在运行中点击 `取消运行`，随后重试。
7. 用同样方式修改 `agent-node-timeout.md`，等待超时，由 B 人工代交。
8. 另用一份 `agent-node.md` 副本，在执行节点元信息外追加 `review-required: false` 并递增版本。启动后等待 Agent 运行成功，检查 Task 直接变为已完成、工作流节点被驱动；若必填交付物未满足，节点必须保持 ready/blocked，不得跳过门禁。
9. 用一份 `review-required: true` 的 Agent Task 样例，确认运行成功后 Task 进入待 Review，而不是直接完成工作流。
10. 另启动一次任务，在运行中重启 `33125` 服务，使用新 token 打开页面并展开实例。
11. 在 Agent 运行失败后打开任务管理详情，先点一次 `刷新`；再次进入工作流详情后回到任务详情，确认旧任务能补齐运行记录。
12. 对同一 Agent 节点手动重新派发，回到任务详情确认执行过程、失败原因和结果会跟随最新 run 更新。
13. 在包含历史跨节点误挂记录的旧环境里，打开任务管理并点一次 `刷新`；检查被误挂的 Task（例如当前环境的 `TSK-MULCGWJF-0173`），确认误挂 run、初始执行消息被清理，状态按工作流权威状态恢复为进行中，并出现清理 / 状态同步事件。
14. 在 Agent 运行中或失败阻塞后，展开 Agent 运行区域。确认只有 Owner/Admin 能看到人工介入入口；若有 active run，先点击 `取消运行`，补齐全部必交付物，填写选填接管备注后点击 `人工完成`。缺失交付物时按钮必须禁用。检查节点变为完成、时间线出现人工完成事件和备注、关联 Task 关闭。
15. 再启动一个 Agent 节点，用 Owner/Admin 填写选填备注后点击 `取消节点` 并确认；用责任人账号确认看不到该入口。检查 active run 取消、节点变为已跳过、时间线出现人工取消事件和备注、关联 Task 以取消结论关闭。

预期：`设置 > Agent` 已下线，不再作为入口；AI Teammates 在首次指派并触发任务时会开通执行身份；平台 Teammate 派生的 Agent Profile 可被不同项目的工作流解析，但运行记录和 Task 仍跟随实例项目；自动派发不需要点击；取消、失败、超时都不显示成功；输出未满足交付要求时节点 blocked；责任人可人工代交，owner/admin 可越过重试上限；只有 Owner/Admin 可通过 Agent 运行区域显式执行 `人工完成` / `取消节点`；人工完成不绕过必交付物门禁，接管备注选填且留痕；服务重启后被中断的运行显示可读原因，节点进入阻塞并同时提供 `重新派发`、人工交付和人工介入入口，点击重新派发后创建 `runSeq + 1` 的新运行。工作流 Agent Task 会创建 `de-task-*` 独立 session，session 名称使用承载 Task 的 TSK 编号；任务详情能看到执行过程和失败输出，历史缺失的 Agent run 会在补投影后出现，同节点重跑复用同一条 session。Agent run 只投影到相同节点的 Task；刷新会清理历史误挂到其他节点的 run，并把非终态任务恢复为工作流权威状态。

测试记录：2026-10-19 复现并修复“工作流任务改派给 Agent 后启动普通任务会话，而不是工作流节点 run”的问题。修复后用 `TSK-MV92O024-6CDE` 改派“柯真 01 测试”，新增 `source=workflow`、`nodeId=test-design` 的 run 和 `de-task-TSK-MV92O024-6CDE-test-design-digital-e386906a` session；任务详情显示“Agent 正在执行工作流节点”。随后重启服务，run 正确转为 `interrupted`，节点显示错误原因、`重新派发 AI伙伴` 和人工代交入口。完整超时、人工接管和内容验收分支未在本轮重复执行。

### WF-10 Digital Employee 派发、票据和暂停

所需资料：`employee-node.md`、`employee-node-manual.md`、`employee-approval.md`；WF-09 已生成的执行身份。

1. 在 WF-09 的 `执行身份` 区域记录生成的 `Employee ID`；不要固定使用旧数据中的 `backend-01`。
2. 把 `employee-node.md` 复制到 `.tmp/gui-cases/`，把 `workflow-member` 替换为 `flow-member` 并递增 `version`，再将 `employee:backend-01` 替换成实际 Employee ID；在 `模版管理 > 新建模版` 导入，再通过 `新建工作流` 启动，确认执行者显示 AI Teammate 名称和数字员工身份。
3. 检查 run 的 employeeId、principalType、ticketId 和输出是否进入交付物。
4. 在 `AI Teammates` 暂停该 Teammate，或停用它的执行身份，再用替换后的 `employee-node-manual.md` 尝试派发。
5. 用相同方式处理 `employee-node-manual.md` 和 `employee-approval.md`，替换真人账号、员工 ID 并递增版本，用 A/B/C 检查审批。

预期：旧 `backend-01 / backend-runtime` 属于历史工作区，不能再作为当前环境的固定前置；满足授权、Runtime 和映射后才派发；暂停员工派发失败；输出被 deny 时节点 blocked 而不是成功；数字员工审批只能等待 runtime decision path，浏览器用户不能代签。

### WF-11 权限、刷新和 Console

所需资料：Profile A/B/C，以及一个已完成、一个阻塞实例。

1. B 打开 `工作流 > 模版管理`，确认只能查看模板。
2. C 尝试直接打开其他工作区实例。
3. A 刷新工作流列表、节点详情和治理中心。
4. 每个 Profile 检查 Console。

预期：非 owner/admin 不能导入、启停模板；跨工作区不可读；刷新后 run、交付物、审批和节点状态不丢失；Console 无未捕获异常。

### WF-12 工作流独立完整性

这个用例先由自动化证明依赖边界，再在当前一体化环境做界面冒烟。不要为了 GUI 测试卸载任务插件；只有当发布配置支持独立安装工作流插件时，才执行第 4-6 步的“无 Task 环境”分支。

1. 运行 2.2 中的两个独立完整性自动化用例，确认人工确认、Agent 成功、交付门禁和审批都能在没有 Task 桥时推进。
2. 当前环境打开 `工作流` 详情，确认审批、完成、交付物、Agent 派发 / 重试 / 取消都在工作流详情内可直接操作；不依赖先打开任务卡。
3. 检查 `服务` 节点，确认它进入 `等待系统执行 / 管理员兜底` 状态即可，不因没有 Task 而被误判失败。
4. 若使用仅安装 Workflow 的环境：从零导入 `gui-from-zero.md`，启动后完成审批、交付、二次审批和管理员完成发布。
5. 同一环境导入 `agent-node.md` 副本并把 `review-required` 设为 `false`；确认 Agent 成功且交付门禁满足后节点和实例自动完成。
6. 检查无 Task 环境的工作流事件：启动、派发、交付、审批、完成都有记录；流程不需要 Task ID 作为决策依据。

预期：工作流详情是独立操作入口；Task 是可选投影。自动化用例中相关节点 `taskIds` 保持为空，Agent 派发 payload 不携带 `workflowTaskId`；无 Task 环境中没有任务页入口，但工作流仍能完成模版管理、实例启动、审批、交付、Agent 执行、取消和审计。

### WF-13 列表、KPI、详情头部与数据范围

所需资料：当前项目中至少 2 条工作流实例（可使用 `1015-Demo演示` / `软件开发交付 v2` 等现有实例）；Profile A/B。

1. A 打开 `工作流`，确认页面标题为 `工作流`，范围控件为 `仅看已加入 / 平台全量`，顶部有 `模版管理`、`新建工作流` 和四张 KPI 卡。
2. 在 `仅看已加入` 和 `平台全量` 之间切换，确认 KPI、列表数量和项目筛选选项随范围变化；项目筛选仍默认 `全部项目`。
3. 进入任一工作流详情后切换数据范围，确认立即回到列表，KPI、筛选栏、`工作流实例` 标题和列表全部可见，不能只剩空白 / 空状态。
4. 打开实例详情，确认头部是「← 返回」+「工作流 / 工作流名称」面包屑 + 关注星标，更新时间在最右侧；关注星标无矩形外框。
5. 确认标题旁不再显示模板流水摘要；模板入口位于流程概览标题旁，点击模板名称可打开模板详情。
6. 检查列表行：左侧显示当前节点 / 负责人 / DDL，第二行显示「项目」和「更新人 + 时间」，右侧状态水平居中；无交付物节点的状态也在同一右侧位置。

预期：范围和项目筛选行为稳定；切换范围不会残留详情态；KPI 按当前范围统计；详情头部与列表行在桌面和窄屏下都保持对齐，文本不互相遮挡。

测试记录：2026-10-19 执行通过。数据范围 `仅看已加入` 为 `29 / 6 / 4 / 19`，`平台全量` 为 `31 / 6 / 4 / 21`；详情切换范围回列表；移动端标题区已修复。详见 `docs/gui-test-report-workflow-2026-10-19.md`。

### WF-14 节点详情、编码与交付物浮层

所需资料：`product-delivery-v2.md`（并行）和 `sub-process.md` / `parent-child.md`（N 选 1 + 子流程）的 GUI 实例。

1. 打开并行实例，确认流程图使用虚线「并行流程」容器，编码 `3-1` / `3-2`，汇合节点编码为 `4` 且不缩进；连接箭头与节点中心对齐。
2. 打开 N 选 1 实例，确认流程图使用实线「分支流程 · 2 选 1」，编码 `2a` / `2b`；承接节点分别显示具体进入条件，默认分支必须显示推导出的反面条件（例如 `complexity < 8`），不能显示泛化的「默认分支」。
3. 检查子流程节点：流程图显示「子流程 · N 个节点」；节点详情类型标签显示「子流程 · N」；点击节点后能展开查看内部节点（已启动看实例，未启动看模板预览），内部编码为 `2a.1`、`2a.2`。
4. 确认节点详情默认全部折叠；展开节点 A 后再展开节点 B，A 不能自动收起；再次点击任一节点可单独收起。
5. 检查节点标题行：负责人、执行时间（计划 / 实际完成，超时追加逾期时长）、交付物 `x/y`；节点状态固定靠右；执行时间超时信息位于第二行末尾。
6. 点击流程节点上的「交付 x/y」，确认浮层显示交付项、值/文件名和提交时间，时间与值同一行且不带「提交于」前缀；未提交项不显示时间。
7. 对照流程图与节点详情，确认同一节点编码一致；「汇合」标签只在节点详情出现，流程概览节点上不显示重复标签。

预期：节点编码、缩进、分支 / 并行 / 汇合 / 子流程表达一致；节点详情可独立多开；交付物浮层信息完整且不遮挡节点操作；刷新后编码、折叠状态、交付物时间与工作流数据一致。

测试记录：2026-10-19 执行通过。并行/N 选 1/子流程表达、多节点展开、右对齐状态和交付物时间浮层均通过；概览节点的嵌套交互控件已修复。

## 4. E2E 工作流闭环

统一入口：模板通过 `工作流 > 模版管理 > 新建模版` 导入；实例通过 `工作流 > 新建工作流` 弹窗启动。不要再从设置弹窗找旧版导入表单。

如果 WF 阶段已经导入同一 `key + version`，E2E 阶段直接复用现有模板，不要重复保存；新版模板管理器默认展示各 key 的最新版本。

### E2E-WF-01 人工审批与交付闭环

使用 `gui-from-zero.md`，由 A 启动和终审，B 执行交付。

| 步骤 | 操作                                                                                         | 资料 / 文件        | 预期                                    |
| ---- | -------------------------------------------------------------------------------------------- | ------------------ | --------------------------------------- |
| 1    | A 在 `模版管理 > 新建模版` 导入并启用模板                                                    | `gui-from-zero.md` | 四节点图形和版本正确                    |
| 2    | A 点击 `新建工作流`，项目归属填 `<WS_ID>`，名称填 `E2E-WF-01` 后启动                         | 新建弹窗           | 需求确认 ready                          |
| 3    | A 通过需求确认                                                                               | 审批意见可选       | 开发与交付 ready                        |
| 4    | B 提交有效实现说明并完成                                                                     | 不少于 20 字       | 发布审批 ready                          |
| 5    | A 通过发布审批                                                                               | 审批意见           | 发布节点 ready                          |
| 6    | A 展开 `发布`，确认 `等待系统执行` 与 `发布就绪` 不互相挤压，再确认任务管理没有系统服务 Task | 实例 ID            | 长状态标签独立一行，系统服务不生成 Task |
| 7    | A 点击 `管理员完成` 完成发布                                                                 | Owner/Admin        | 实例 completed                          |
| 8    | A/B 刷新治理和审计                                                                           | 实例 ID            | 节点、交付物、审批、完成人一致          |

通过标准：交付物门禁不可绕过；系统服务节点不创建个人 Task，只能由系统接入或 Owner/Admin 兜底完成；状态文案较长时节点标题和说明不被遮挡；每一步都有事件；刷新后状态一致。

`WF-12` 补充标准：两个独立完整性自动化用例必须通过；工作流模板管理和实例闭环不得因为 Task 模块缺席而失败。Task 模块存在时，投影失败只能表现为任务侧历史缺失，工作流事件和节点状态必须保持一致。

### E2E-WF-02 Agent 交付闭环

使用 `agent-node.md` 和 AI Teammates 自动生成的 Agent Profile。

| 步骤 | 操作                                                                               | 资料 / 文件          | 预期                                                                               |
| ---- | ---------------------------------------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------- |
| 1    | A 先创建并生效 AI Teammate，记录 Profile ID，再替换并在 `模版管理` 导入 Agent 流程 | `agent-node.md` 副本 | 节点 ready 后自动派发                                                              |
| 2    | 检查 Agent 运行                                                                    | run 详情             | trigger 为自动，状态最终 succeeded / failed / timeout                              |
| 3    | 检查交付物                                                                         | 运行输出             | 满足门禁后进入待确认，不能自动借运行成功跳过 gate                                  |
| 4    | `review-required: true` 时由 B 在 Task/工作流确认完成                              | 交付物               | 节点完成并推进                                                                     |
| 5    | `review-required: false` 时等待 Agent 成功后的直接完成                             | Task 详情            | Task 已完成且节点推进，但缺失必填交付物时不得推进                                  |
| 6    | A 查看治理中心                                                                     | instanceId、runId    | 能追溯 Agent、ticket、输出和确认人                                                 |
| 7    | 打开 Task 详情，检查执行过程和左侧 Session                                         | `de-task-*` session  | Task 显示 run 状态、过程输出和失败原因；session 已挂到项目                         |
| 8    | 让 Agent 输出缺少交付标题，再回到 Task 详情刷新                                    | 失败 run             | Task 不会一直停留在“等待输出”；失败原因与工作流一致                                |
| 9    | 同一实例的多个节点 Task 并存时，在任务管理点一次 `刷新`，逐个展开检查              | 同实例多节点 Task    | 每个 Task 只显示自身节点的 run；没有 run 的节点 Task 不会被其他节点 run 改成进行中 |

通过标准：运行状态、交付物状态和节点状态三者可区分且一致；Task 投影只读展示工作流执行事实，不再吞掉失败结果；工作流 Agent 与普通 Agent Task 一样具备可追踪的执行 session；Task 与 Agent run 的映射按工作流节点隔离。

### E2E-WF-03 受控返工闭环

使用 `controlled-loop.md`。

| 步骤 | 操作                                       | 资料 / 文件          | 预期                               |
| ---- | ------------------------------------------ | -------------------- | ---------------------------------- |
| 1    | A 导入受控返工流程并通过 `新建工作流` 启动 | `controlled-loop.md` | 确认节点 ready                     |
| 2    | A 完成需求确认，B 否决测试                 | 审批意见             | 开发重新 ready，attempts 增加      |
| 3    | 重复否决直到第三轮                         | 运行记录             | 每轮回边有事件                     |
| 4    | 第三次否决                                 | break 条件           | 目标节点 blocked，发布就绪不 ready |
| 5    | A 查看治理和事件                           | 实例 ID              | 能看出触发条件和阻断原因           |

通过标准：只允许已声明 break 的回边；阻断后没有静默完成或继续推进。

### E2E-WF-04 Digital Employee 工作流闭环

使用 `employee-node.md` 和 AI Teammates 自动生成的 Digital Employee。

| 步骤 | 操作                                                                                                               | 资料 / 文件             | 预期                            |
| ---- | ------------------------------------------------------------------------------------------------------------------ | ----------------------- | ------------------------------- |
| 1    | A 创建平台 AI Teammate，保存定义并生效                                                                             | AI Teammates 页面       | 定义状态为 `已生效`             |
| 2    | A 先通过测试任务指派 Teammate，确认执行身份开通，记录 Employee ID；替换 `employee:backend-01` 后在 `模版管理` 导入 | `employee-node.md` 副本 | 执行者显示数字员工，节点派发    |
| 3    | 检查 agent run                                                                                                     | employeeId、ticketId    | 运行身份为 Digital Employee     |
| 4    | 暂停员工后重试派发                                                                                                 | Settings > 员工         | 派发被拒绝并显示暂停原因        |
| 5    | 恢复员工并重试                                                                                                     | Runtime                 | 新 run 签发，成功输出进入交付物 |
| 6    | B 确认交付物并完成节点                                                                                             | 实现说明                | 流程推进，审计可追溯            |

通过标准：暂停 / 恢复、Action Ticket、deny-wins、交付物门禁和责任人确认全部生效。

### E2E-WF-05 工作流 UI 迭代回归闭环

使用当前环境中的并行实例、N 选 1 + 子流程实例和一个带交付物的实例；至少覆盖 A/B 两个 Profile。

| 步骤 | 操作                                                  | 资料 / 文件                   | 预期                                                                   |
| ---- | ----------------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------- |
| 1    | A 在 `工作流` 列表切换到 `平台全量`，打开任一实例详情 | 现有实例                      | 列表→详情正常，头部显示面包屑和模板入口                                |
| 2    | 在详情中切换 `仅看已加入` 或 `平台全量`               | 范围控件                      | 回到列表，KPI / 筛选栏 / 列表标题可见，无白屏                          |
| 3    | 重新进入详情，展开一个节点，再展开另一个节点          | 节点标题行                    | 两个节点同时展开；再次点击可单独收起                                   |
| 4    | 打开并行实例，检查流程图                              | `product-delivery-v2.md` 实例 | 虚线「并行流程」、`3-1/3-2`、汇合 `4` 不缩进，箭头与节点中心对齐       |
| 5    | 打开 N 选 1 实例，检查流程图                          | `parent-child.md` 实例        | 实线「分支流程 · 2 选 1」、`2a/2b`、进入条件完整；默认分支不是泛化文案 |
| 6    | 点击 `2a` 子流程节点                                  | 子流程实例 / 模板             | 显示「子流程 · N 个节点」，展开后可见内部节点与 `2a.1` 层级编码        |
| 7    | 点击「交付 x/y」                                      | 带已提交交付物的节点          | 浮层显示交付值/文件名与提交时间，时间同一行、无「提交于」              |
| 8    | B 以成员身份重复步骤 1-3，再刷新页面                  | Profile B                     | 权限、范围、折叠和多节点展开行为一致；Console 无异常                   |

通过标准：本轮 UI 迭代涉及的列表 / 详情 / 范围切换 / 节点编码 / 子流程展开 / 交付物时间全部可用；无空白页、错位、重复标签或节点自动收起；刷新后状态一致。

测试记录：2026-10-19 执行通过。展开节点后切换数据范围正常回列表；另复现并修复工作流任务改派 Agent 后启动普通任务会话的问题。详见 `docs/gui-test-report-workflow-2026-10-19.md`。

## 5. 与上一版方案的执行映射

基于 `docs/gui-test-design-task-e2e.md`，本轮选择如下：

| 上一版用例                        | 本轮是否运行 | 原因                                                 |
| --------------------------------- | ------------ | ---------------------------------------------------- |
| `F-01` 全局 Shell                 | 建议运行     | 确认工作流位于全局导航且不破坏 Session               |
| `F-03` 员工生命周期               | 必跑         | `WF-10`、`E2E-WF-04` 的前置                          |
| `F-09` 工作流员工执行与审批       | 必跑         | 本轮核心                                             |
| `F-10` 治理与响应式               | 建议运行     | 检查 run、ticket、拒绝和报告追溯                     |
| `E2E-04` 员工入职并完成工作流交付 | 必跑         | 与 `E2E-WF-04` 对应                                  |
| `E2E-06` 审批失败可见且不越权     | 必跑         | 覆盖未来节点、否决和数字员工审批                     |
| `F-02`、`F-04` 至 `F-08`、`F-11`  | 可选         | 主要覆盖账号、任务、会议、响应式，不属于工作流主链路 |
| `E2E-01` 至 `E2E-03`、`E2E-05`    | 本轮不跑     | 任务 / 会议专项；需要跨模块回归时再执行              |

## 6. 证据和通过标准

保存：

```text
.tmp/gui-evidence/workflow/<CASE-ID>/summary.md
.tmp/gui-evidence/workflow/<CASE-ID>/console.txt
.tmp/gui-evidence/workflow/<CASE-ID>/ids.md
.tmp/gui-evidence/workflow/<CASE-ID>/*.png
```

`ids.md` 至少记录：

1. `<WS_ID>`、definitionId、instanceId、nodeId、runId、ticketId；
2. 每个测试账号和 Profile；
3. 导入文件的路径和版本；
4. 审批、否决、派发、取消、重试、完成的实际时间。

通过标准：

1. `corepack pnpm check` 通过；
2. 工作流、Agent、Employee 自动专项通过；
3. `WF-01`、`WF-02`、`WF-03`、`WF-04`、`WF-06`、`WF-08`、`WF-09`、`WF-11`、`WF-12`、`WF-13`、`WF-14` 通过；
4. `E2E-WF-01`、`E2E-WF-02`、`E2E-WF-04`、`E2E-WF-05` 完成闭环；
5. 未来审批不可提前、必交交付物不可绕过、暂停员工不可派发、Agent 失败不可显示成功；
6. 平台账号缺失在模板校验失败；项目成员缺失在启动实例失败；员工目录不把已删除平台账号的旧真人投影显示为启用；Task 模块缺席不阻塞工作流闭环；
7. 刷新后 run、ticket、交付物、审批和节点状态一致；
8. Console 无未捕获异常；
9. 最近迭代 UI 回归通过：切换数据范围不白屏、项目筛选每次默认 `全部项目`、并行流程与 N 选 1 分叉表达不同、子流程可展开查看内部节点、节点可多开且编码一致、交付物浮层显示同一行的提交时间。
