# 外部 Agent Teammates GUI 测试方案

> 独立测试方案，覆盖外部 Agent 运行时、Teammate 绑定、任务/工作流联动、失败路径和回滚。不要复用用户正在使用的 `33124` 数据目录。

## 1. 环境准备

### 1.1 启动隔离服务

在仓库根目录执行：

```bash
lsof -ti tcp:33117 -sTCP:LISTEN
pnpm --filter dsh-collab-task --filter dsh-collab-workflow --filter dsh-collab-teammate --filter dsh-collab-agent build
DSH_HOME="$PWD/.tmp/external-agent-home" node vendor/deepseek-harness/apps/cli/lib/bin.js --profile pluginmax --no-open --port 33117
```

如果第一条命令有 PID，先停止该测试进程；再执行构建和启动。GUI 使用插件 `lib/` 构建产物，只跑源码测试不够。启动后从终端复制带 `?token=` 的完整 URL 打开。

### 1.2 账号与项目

| 角色          | 要求                                       |
| ------------- | ------------------------------------------ |
| Admin         | 平台管理员，用于平台级配置和跨权限检查     |
| Project Owner | 至少一个项目的 Owner，用于项目级外部运行时 |
| Member        | 普通成员，用于验证不能注册外部运行时       |

准备一个项目，并记录项目 ID。给项目创建一个最小代码目录或空目录，确保任务/工作流可解析到 `workspacePath`。

### 1.3 假外部 Agent 路径

把以下路径中的 `<REPO>` 替换为本仓库绝对路径：

| 用途                   | Command | Args                                                       |
| ---------------------- | ------- | ---------------------------------------------------------- |
| 通用 plain-text 假实现 | `node`  | `<REPO>/docs/fixtures/external-agent/plain-text-agent.mjs` |
| Codex JSONL 假实现     | `node`  | `<REPO>/docs/fixtures/external-agent/codex-fake.mjs`       |

已安装真实 Codex 时，可另行注册 `command=codex`、`protocol=codex-jsonl`。第一版不测试需要写仓库的真实任务。

### 1.4 真实 WorkBuddy 接入准备

本节只测真实 WorkBuddy，不使用 `docs/fixtures/external-agent/` 下的任何文件，也不使用 shell 脚本伪装 WorkBuddy。当前平台只通过通用 `plain-text` 外部运行时承接 WorkBuddy，契约如下：

```text
argv:   只使用 Runtime 注册参数，平台不追加 Prompt 或协议参数
stdin:  UTF-8 完整平台 Prompt
stdout: UTF-8 最终结果
stderr: 登录、网络、权限、执行诊断
exit 0: 成功
非零:   失败
SIGTERM: 取消
```

macOS 安装包内置的 CLI 可能缺少运行入口并报 `Cannot find module '../dist/codebuddy'`。本方案的 `<WORKBUDDY_CLI>` 统一表示用户级 npm 安装的完整真实 CLI；本机当前版本是 `2.161.0`。不要复制到测试夹具目录，也不要通过包装脚本改名：

```bash
/Users/oliviayang/.npm-global/bin/codebuddy
```

本地非交互执行已确认使用 `--print`，平台通过 stdin 传入完整 Prompt，最终文本写入 stdout。平台不会自动追加 `--print`、`--output-format` 或 `--max-turns`，因此这些参数必须在 Runtime 中显式登记。Prompt-only 探测和真实任务不要共用同一套回合上限；本地运行时建议如下：

| 字段     | 值                                                                         |
| -------- | -------------------------------------------------------------------------- |
| Provider | `WorkBuddy`                                                                |
| Protocol | `通用 stdin/stdout`                                                        |
| Command  | `<WORKBUDDY_CLI>`                                                          |
| Args     | `--print --output-format text --max-turns 8 --permission-mode acceptEdits` |

在 GUI 里录入 Args 时，每个命令行 token 单独一行，不要输入 `"--output-format text"` 这种带引号的组合项。正确配置是：

```text
--print
--output-format
text
--max-turns
8
--permission-mode
acceptEdits
```

Prompt-only 连通性检查可以继续用 `--max-turns 1`；需要读取上下文、写文件或调用工具的任务必须给更高的回合计数。文件写入用例使用独立测试目录，并保持 `acceptEdits` 权限范围。不要为了绕过权限提示注册 `--dangerously-skip-permissions`。

启动 DSH 前，先在运行 DSH 的同一台机器和同一用户会话完成 WorkBuddy 登录，再执行下面的终端连通性检查：

```bash
<WORKBUDDY_CLI> --print --output-format text --max-turns 1 --permission-mode acceptEdits 'Reply with exactly WORKBUDDY_CONNECTIVITY_OK and no other text'
```

输出必须恰好包含 `WORKBUDDY_CONNECTIVITY_OK`。只看退出码不够：WorkBuddy CLI 在未登录时可能输出 `Authentication required...`，但退出码可能是 0。连通性门禁必须同时校验退出码和输出；未满足时不要继续 WB-02 之后的用例。

上面的终端命令使用位置参数，是 CLI 自身的诊断方式；平台派发不依赖位置参数，必须用 WB-01 单独验证 stdin 输入链路。平台不解析 `stream-json`，不读取 Provider Session，也不生成 reasoning/tool 事件。

真实接入分两种模式：

| 模式             | 适用场景                                        | 运行时配置                                     |
| ---------------- | ----------------------------------------------- | ---------------------------------------------- |
| Local WorkBuddy  | CLI 和凭据在本机，可直接访问当前项目目录        | 上表的本地 CLI 参数                            |
| Remote WorkBuddy | 本机 CLI 连接官方远端 WorkBuddy，实际执行在远端 | WorkBuddy 官方远端 Profile/Endpoint 非交互参数 |

截至 WorkBuddy CLI 2.161.0，`--help` 没有暴露通用的远程 endpoint 参数。Remote WorkBuddy 必须使用官方产品提供的 Profile、Endpoint 或远程控制配置；不要把 HTTP URL 拼进 Prompt 当作远程执行，也不要自定义 HTTP 包装。若当前账号没有官方远程执行入口，WB-05 到 WB-08 标记为阻塞，不使用假实现代替。

Remote 模式必须先确认远端工作区策略。如果测试会读写仓库，远端 WorkBuddy 必须挂载同一项目目录、同步同一提交，或由官方远程执行协议自行传输工作区；否则只能先测不依赖仓库文件的 Prompt-only 任务。

凭据不得写进平台 Args。使用 WorkBuddy 官方 Profile、macOS Keychain、环境变量或远端服务自己的登录态。若必须使用环境变量，要先在启动 DSH 服务的终端里配置，让 WorkBuddy 子进程继承；不要把 token、API key 或密码填到可见参数里。

### 1.5 WorkBuddy 已知风险门禁

1. 未登录 CLI 可能返回 `Authentication required...`，退出码可能是 0。执行前必须按 1.4 做输出断言；若平台把该输出记为成功结果，WB-08 判失败并记录缺陷。
2. WorkBuddy 的模型输出可能包含解释文字。测试 Prompt 必须要求稳定标记，验收以标记为准，不要求整段输出完全相等。
3. 高风险权限提示可能阻塞外部进程。工作流取消用例必须在派发前确认运行时参数不会触发交互提示。
4. `--max-turns 1` 适合 Prompt-only 探测，不适合工具任务：Agent 首轮调用 Bash/Read/Write 后可能触发 `Max turns (1) exceeded`，CLI 退出码为 0 且 stdout 为空。真实任务运行时至少给 8 回合。
5. 本机 GUI 登录态和终端登录态可能不同步。所有 WorkBuddy 用例必须从启动 DSH 的同一终端环境验证连通性。

## 2. 用例总览

### 外部 Agent 假实现回归

| 编号   | 场景             | 关键验收                                     |
| ------ | ---------------- | -------------------------------------------- |
| EXT-01 | 权限             | Admin/Owner 可管理，Member 不可              |
| EXT-02 | 注册与探测       | 运行时可保存、启停、探测                     |
| EXT-03 | Teammate 绑定    | 旧 Teammate 默认内置，新 Teammate 可绑定外部 |
| EXT-04 | 通用外部任务     | stdin/stdout 全链路可见                      |
| EXT-05 | Codex JSONL 任务 | 进度、结果、外部 Session ID 可见             |
| EXT-06 | 工作流门禁       | 外部成功仍需交付物/Review/审批               |
| EXT-07 | 失败路径         | 启动失败、空输出、停用运行时有明确原因       |
| EXT-08 | 人工介入         | Owner/Admin 可完成/取消，成员不可            |
| EXT-09 | 独立闭环         | 无任务模块时工作流仍可完成                   |
| EXT-10 | 回滚             | 切回内置/停用运行时/revert 分支均安全        |

### 真实 WorkBuddy 回归

| 编号  | 模式   | 场景           | 关键验收                                     |
| ----- | ------ | -------------- | -------------------------------------------- |
| WB-01 | 本机   | 真实连通和登录 | 版本、stdin Prompt、结果标记全部来自真实 CLI |
| WB-02 | 本机   | 真实任务执行   | Task 状态、过程、stdout 结果和执行历史同步   |
| WB-03 | 本机   | 真实工作流节点 | Agent 成功后仍遵守交付物、Review、审批门禁   |
| WB-04 | 本机   | 真实取消       | 取消外部进程后不得出现假完成或继续流转       |
| WB-05 | 远端   | 真实远端连通   | 官方远端 Profile 可探测，Workspace 策略明确  |
| WB-06 | 远端   | 真实远端任务   | 远端执行过程、结果和任务状态同步             |
| WB-07 | 远端   | 真实远端工作流 | 远端 Agent 成功后仍遵守工作流门禁            |
| WB-08 | 远端   | 认证/网络失败  | 未登录、断网、Endpoint 不可用均有失败原因    |
| WB-09 | 双模式 | 权限与敏感信息 | 目录范围可控，凭据不进入 UI、日志或执行历史  |

## 3. 回归步骤

### EXT-01 权限

1. Admin 打开 **AI Teammates > 外部 Agent**，应看到 **注册运行时**。
2. Project Owner 打开同一页面，也应看到 **注册运行时**。
3. Member 打开同一页面，不显示 **注册运行时**；直接调用创建接口应返回“平台或项目 Owner/Admin 才能管理外部 Agent 运行时”。
4. Member 仍可查看运行时列表，因为后续需要理解 Teammate 绑定。

### EXT-02 注册与探测

1. Admin/Owner 注册 Codex 假实现：
   - Provider：`Codex`
   - Protocol：`Codex JSONL`
   - Command：`node`
   - Args：`<REPO>/docs/fixtures/external-agent/codex-fake.mjs`
   - 状态：启用
2. 保存后列表应显示命令、启用状态、Provider 和协议。
3. 点击 **探测**，应提示命令探测通过，并记录探测结果。
4. 点击 **编辑**，修改名称、Provider、协议、命令、Args 或状态；保存后列表应显示新定义，并提示“已更新外部 Agent”。
5. 修改命令或 Args 后，旧探测结果应被清空；再次探测才会生成新的探测结论。
6. 注册通用 Agent：
   - Provider：`Command`
   - Protocol：`通用 stdin/stdout`
   - Command：`node`
   - Args：`<REPO>/docs/fixtures/external-agent/plain-text-agent.mjs`
7. 停用通用 Agent，状态应变为停用；重新启用应恢复。
8. 点击 **归档**，确认弹窗必须写明影响：默认列表隐藏、不能再被选择或执行、已绑定 Teammate 数量、可复原。
   确认后该运行时从默认列表消失，`已归档 N` 计数加一，并提示“N 个 Teammate 需要改绑或切回内置执行”。
9. 点击 `已归档 N` 进入归档视图：归档项显示 **已归档** 徽标，只提供 **复原** 动作。
10. 点击 **复原**：提示“已复原为停用”，归档视图清空；返回运行列表后该项为 **已停用**，需要再次手动启用。

### EXT-03 Teammate 绑定

1. 打开一个升级前创建的 Teammate，执行方式应默认显示 **内置执行**，且任务行为不变。
2. 新建或编辑 Teammate：
   - 执行方式：`外部 Agent`
   - 外部 Agent：EXT-02 的 Codex 假实现
3. 不选择运行时直接保存，保存按钮应不可用。
4. 保存后重新打开定义，执行方式仍为外部 Agent。
5. 再创建一个内置执行 Teammate，供后续对比。

### EXT-04 通用外部任务

1. 在任务管理创建任务，标题为“外部通用 Agent 验收”。
2. 接收方选择 EXT-03 的通用外部 Teammate。
3. 派发后任务应进入 **进行中**，详情出现外部 Agent 执行记录。
4. 进度应包含“收到任务”，结果应包含“外部 Agent 已完成本地验证”。
5. 任务完成后，若任务要求 Review 则进入 **待 Review**；若不需要 Review 则自动进入完成态。

### EXT-05 Codex JSONL 任务

1. 创建并派发第二个任务给 Codex 外部 Teammate。
2. 任务详情应显示实时过程“外部 Agent 正在执行”。
3. 运行完成后，最终输出应包含“Codex 假实现已完成 GUI 验收任务”。
4. 详情或执行历史中的 Agent Run 应记录 `externalSessionId=gui-fake-thread-1`。
5. 若 UI 没有直接展示 session ID，可通过任务详情引用的 Agent Run 审计数据确认。

### EXT-06 工作流门禁

1. 先给外部 Teammate 派发一个最小任务，确保运行态已生成；在 Teammate 运行态详情复制 Agent Profile ID。
2. 上传或创建一个包含 Agent 节点的工作流模板，节点配置：

```markdown
# 工作流：外部 Agent 门禁

## 元信息

- key: external-agent-gate
- version: 1
- description: 验证外部 Agent 不能绕过交付物和 Review

## 节点

### 开发

- id: development
- type: task
- executor: agent:<Agent Profile ID>
- responsible: user:<Project Owner>
- execution: task-worker
- trigger: auto-on-ready
- review-required: true
- deliverable: report
  title: 实现说明
  type: text
  required: true
  min-text-length: 20
```

3. 启动工作流实例并让节点派发给外部 Teammate。
4. 外部 Agent 成功后，工作流节点不得直接跳到后续审批；应先写入“实现说明”交付物并进入等待人工 Review。
5. 拒绝交付物后重新提交，节点应保持待 Review。
6. 通过 Review 后，若模板有审批节点，仍必须由审批人完成审批。
7. 将该 Agent 节点改为 `review-required: false` 后再测试一次；交付物完整时应自动完成并进入下一节点。

### EXT-07 失败路径

1. 注册 Command 为 `definitely-not-installed-agent` 的运行时并绑定 Teammate。
2. 派发任务，任务应失败，执行历史应包含 `ENOENT` 或“命令不存在”类诊断，不得进入待 Review。
3. 注册一个输出为空的 `plain-text` 运行时（可用系统命令 `true` 临时验证）。
4. 派发任务，应提示外部 Agent 未返回可用文本输出。
5. 在任务运行中停用其绑定的运行时，已在运行的执行允许完成或失败；下一次派发应立即失败，
   失败原因必须点名该运行时并提示「启用后重试或切换为内置执行」。
6. 取消一个运行中的外部任务，状态应变为已取消，后续工作流节点不得继续。
7. 归档一个绑定了 Teammate 的运行时，再派发任务：失败原因必须为「已归档，请复原或改绑其他运行时」，
   不得与「已停用」「不存在」混用同一句文案。
8. Teammate 列表与详情在绑定运行时不可用时必须显示 `（已停用）` / `（已归档）` / `（运行时不存在）`；
   打开编辑执行方式时，不可用的当前绑定保留为禁用项，并提示改绑或切回内置执行。

### EXT-08 人工介入

1. 让 Owner/Admin 打开一个进行中的 Agent 工作流节点任务。
2. 使用人工介入完成，必须补全节点必需交付物；备注可为空。
3. 提交后工作流按 Review/审批配置继续，任务历史应记录人工介入。
4. 普通成员尝试人工介入该节点，应被拒绝。
5. Owner/Admin 取消一个 Agent 节点，工作流节点应进入取消/阻止态，任务状态同步，不能继续误流转。

### EXT-09 工作流独立闭环

1. 在没有任务管理处理人的新项目里导入 EXT-06 模板。
2. 启动、派发、提交交付物、Review、审批并完成实例。
3. 工作流不应因任务模块不可用而阻塞。
4. 若任务模块存在，再把同一实例的节点状态与任务投影核对一致。

### EXT-10 回滚验证

按影响从小到大验证：

1. 把 Teammate 从外部执行改回内置执行；新任务应使用内置 Worker。
2. 停用外部运行时；已绑定 Teammate 的新任务应失败且提示可修复或转人工。
3. 归档外部运行时；默认列表隐藏、归档视图可复原，归档期间新任务失败且提示改绑或复原。
4. 使用测试数据目录时可直接停止服务并删除 `.tmp/external-agent-home`。
5. 代码回滚时，切回 `main` 或 revert 功能分支提交；老数据缺少外部字段仍应等价于内置执行。
   归档状态是普通字段，revert 后旧版本会把归档项重新当作可用运行时的历史数据，需先复原再回滚。

## 4. 真实 WorkBuddy 回归步骤

以下用例全部使用真实 WorkBuddy 登录态和官方 CLI。为了隔离真实写入，先准备空目录 `/tmp/workbuddy-gui-workspace`，并把 WorkBuddy 用例所属项目的 Workspace 配置为该目录。不要让 WB 用例读写用户业务仓库。

### WB-01 本机真实连通和登录

1. 在启动 DSH 的终端执行 `"<WORKBUDDY_CLI>" --version`，记录 WorkBuddy CLI 版本；当前应为 `2.161.0`。
2. 执行 1.4 的 Prompt-only 连通性命令，输出必须包含 `WORKBUDDY_CONNECTIVITY_OK`。
3. Admin 或 Project Owner 在 **AI Teammates > 外部 Agent** 注册 1.4 的 Local WorkBuddy 运行时。
4. 点击 **探测**，应记录命令存在和版本；探测不要求发起模型请求。
5. 启用运行时后，再次查看 WorkBuddy 官方 CLI 版本，确认 GUI 使用的是同一本机安装。

### WB-02 本机真实任务执行

1. 新建 Teammate，执行方式选择 **外部 Agent**，绑定 WB-01 的 WorkBuddy 运行时。
2. 创建 Task，标题为“真实 WorkBuddy 连通验收”，描述要求：`Reply with exactly WORKBUDDY_TASK_OK and no other text. Do not read or modify files.`。
3. 派发给该 WorkBuddy Teammate。
4. 任务详情应先显示外部进程运行中；完成后，stdout 最终结果包含 `WORKBUDDY_TASK_OK`。
5. 执行历史应记录真实 WorkBuddy 命令、启动时间、结束时间、退出码和 stdout 结果；stderr 只记录诊断，不得记录凭据。
6. 若任务要求 Review，先进入待 Review；将任务配置为无需 Review 后重跑，应从运行中直接进入完成态。

已回归通过：本机真实执行返回 `WORKBUDDY_TASK_OK`，Task 进入待 Review，执行历史能看到启动、结束和最终结果。

### WB-03 本机真实工作流节点

1. 新建一个绑定 WorkBuddy 运行时的 Teammate，并启动独立工作流实例。
2. Agent 节点 Prompt 要求：`Reply with exactly WORKBUDDY_WORKFLOW_OK and no other text. Do not read or modify files.`。
3. 节点进入运行中时，工作流详情和对应 Task 投影都要显示 WorkBuddy 正在执行。
4. WorkBuddy 返回 `WORKBUDDY_WORKFLOW_OK` 后，节点不得因 Agent 成功而直接完成：
   - 必需交付物缺失时保持待补交付物；
   - `review-required: true` 时进入待 Review；
   - 后续存在审批节点时等待审批。
5. 补全交付物、通过 Review 和审批后，工作流才能进入下一节点或完成。工作流可能把 Agent 返回结果包装成节点交付报告，因此交付物断言关注“任务目标、结果和风险/说明完整”，不要机械要求整段交付物等于 literal `WORKBUDDY_WORKFLOW_OK`。
6. 把该节点改为无需 Review 且无必需交付物，再创建一个实例；WorkBuddy 成功后该节点应自动完成。

已回归通过：真实工作流生成 Task 和交付物，进入 Review；人工 Review 后工作流和 Task 同步完成。

### WB-04 本机真实取消

1. 创建一个真实长任务，Prompt 要求：`Think silently for about 60 seconds, then reply with exactly WORKBUDDY_CANCELLED_TEST_OK and no other text. Do not read or modify files.`。
2. 确认 Task 与工作流节点都进入运行中。
3. Project Owner 或 Admin 从工作流节点触发取消。
4. WorkBuddy 子进程应收到终止信号；工作流节点显示 Agent 已取消；对应 Task 必须显示独立状态 **已取消**，不得显示 **已完成**，进度不得被补成 100%。
5. 执行历史记录“用户取消”，后续工作流节点不启动。
6. 打开 WorkBuddy 官方 CLI 的 `ps` 视图或系统进程列表，确认没有残留执行进程。
7. 已取消 Task 的接收方、状态、验收项和评论均应只读；打开工作流节点入口仍可用，便于追溯。

已回归通过：真实取消实例 `WB-04 Immediate Cancel Regression` 生成 Task `TSK-MUPPOG9C-82C8`。节点和 WorkBuddy 运行都显示已取消，Task 进入独立“已取消”状态，进度保持 0%，验收项保持未勾选；执行历史同步“人工取消节点”“工作流节点已取消”和 Agent 未完成原因。进程检查没有残留用户级 `codebuddy --print` 执行进程。

已修复回归：历史上取消节点会把 Task 投影成 `done / 已完成`。修复后取消结论保留为 `cancelled / 已取消`，刷新和工作流 reconcile 不会再把它改写为完成。

### WB-05 远端真实连通

1. 在 WorkBuddy 官方产品中启用远端执行 Profile/Endpoint，并记录官方 Workspace 策略。
2. 在启动 DSH 的终端使用官方 CLI 非交互模式执行 Prompt-only 连通性请求，输出包含 `WORKBUDDY_REMOTE_CONNECTIVITY_OK`。
3. 注册第二个运行时，Provider 为 `WorkBuddy`，Protocol 仍为 `通用 stdin/stdout`；Command 与 Args 必须来自官方远端接入方式。
4. 平台探测应成功，并能把 Local 与 Remote 区分展示。
5. 若官方 CLI 没有当前账号可用的远端执行入口，本用例标记阻塞；不要改用本地进程或 mock 顶替。

### WB-06 远端真实任务

1. 创建 Teammate 绑定 WB-05 的 Remote WorkBuddy 运行时。
2. 派发 Prompt-only 任务，描述要求：`Reply with exactly WORKBUDDY_REMOTE_TASK_OK and no other text. Do not access local files.`。
3. Task 运行中，平台应显示远端执行来源；用户不应把远端执行误解为本机执行。
4. 完成后，stdout 包含 `WORKBUDDY_REMOTE_TASK_OK`，Task 状态、执行历史和外部运行记录一致。
5. Review 行为与 WB-02 第 6 步一致。

### WB-07 远端真实工作流

1. 创建一个 Agent 节点绑定 Remote WorkBuddy Teammate 的工作流实例。
2. 派发后，工作流节点、Task 投影和执行历史都标识 Remote WorkBuddy。
3. 远端成功返回稳定标记后，仍必须依次满足交付物、Review、审批门禁。
4. 拒绝 Review 后节点不得前进；补交并通过后才能前进。
5. 若远端 Workspace 会同步文件，只允许它访问 `/tmp/workbuddy-gui-workspace`；用例结束时确认业务仓库没有新增文件。

### WB-08 远端认证/网络失败

1. 退出 WorkBuddy 官方远端登录态后派发 Prompt-only Task。
2. 平台应把执行标记为失败或需要登录，不得把 `Authentication required...` 当作业务成功。
3. 重新登录后重试，同一 Task 或新建 Task 应能完成。
4. 断开网络或使用官方产品明确无效的 Endpoint/Profile 后派发，执行应在可等待时间内失败，stderr 包含认证、DNS、超时或连接失败类原因。
5. 工作流对应节点不得前进；用户能看到重试、修正配置或转人工处理入口。
6. 恢复登录和网络后，平台不需要重启服务即可继续执行新派发。

### WB-09 权限与敏感信息

1. 分别用 Admin、Project Owner、Member 打开 WorkBuddy 运行时管理；权限行为与 EXT-01 一致。
2. 检查 Local 和 Remote 运行时的 Command、Args、探测记录、Task 详情和工作流执行历史，不得出现 token、API key、Cookie 或密码。
3. Prompt-only 用例尝试要求 WorkBuddy 读取用户业务仓库外层目录；平台项目 Workspace 应限制可见范围，WorkBuddy 不应返回业务仓库内容。
4. 文件写入只允许发生在 `/tmp/workbuddy-gui-workspace`；用例前后对比业务仓库 `git status`，不得出现 WorkBuddy 造成的变更。
5. 取消和失败日志中的命令行可以被审计，但不能包含凭据值。

## 5. 通过标准

1. `pnpm check` 全量通过。
2. EXT-01 到 EXT-10 全部通过。
3. 升级前创建的 Teammate、任务、工作流实例无需数据迁移即可继续使用。
4. 外部 Agent 成功结果不能绕过工作流交付物、Review 或审批。
5. 每个失败路径都有用户可读原因和可执行下一步。
6. 服务重启后，排队任务可恢复；运行中外部进程中断时标记为中断，不会假成功。
7. WB-01 到 WB-04 必须全部通过；WB-05 到 WB-08 在账号具备官方远端执行能力时必须全部通过，否则必须明确记录阻塞原因。
8. WB-09 必须通过。任何 WorkBuddy 输出、日志或审计记录中不得泄漏凭据。
9. 未登录 WorkBuddy 的零退出码输出不得被平台解释为任务成功；若发现该缺陷，真实 WorkBuddy 套件整体判失败。

## 6. 2026-10-01 GUI 回归记录

### 已通过

| 范围            | 证据                                                                                                                                               |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| EXT-04 / EXT-05 | 通用外部 Agent 与 Codex JSONL 假实现任务完成；过程、最终输出、外部 Session ID 和执行历史同步。                                                     |
| EXT-06          | `外部 Agent 审批退回归` 完成完整链路：Agent 成功后仍需必交交付物；Review 退回、补交、通过和后续流转保持一致；Task 状态、工作流标签、执行历史同步。 |
| EXT-07          | `definitely-not-installed-agent` 触发启动失败，节点保持阻塞；页面显示“Agent 运行未完成”和 `ENOENT` 诊断，不进入 Review 或完成态。                  |
| EXT-08          | Admin/Owner 人工介入必须先补齐必交交付物；人工代交和确认完成后工作流完成，Task 同步为已完成并保留人工介入历史。Owner/Admin 权限由服务测试覆盖。    |
| EXT-09          | 工作流无 Task 模块时的独立闭环、Agent 无 Review 自动完成由服务测试覆盖；Task 模块存在时投影同步另由 GUI 核对。                                     |
| EXT-10          | Teammate 从内置切外部、已有 Agent Profile 再切新运行时、停用/失败路径由服务测试覆盖；老数据无外部字段按内置执行。                                  |
| 回归修复        | 历史工作流 Task 曾显示原始 `agent-7da80235`。修复后刷新页面会只同步接收方显示名为 `Codex 外部 Agent`，不重算已完成结果。                           |
| 自动化          | `pnpm check` 通过；全部 181 个测试通过，覆盖 stdin/stdout、Codex JSONL、SIGTERM 取消、启动失败、取消终态和历史数据修复。                           |

### WorkBuddy 当前门禁

- WorkBuddy.app 内置 CLI 2.147.0 缺少 `dist/codebuddy`，不能作为运行时。
- 已改用用户级 npm 安装的完整真实 CLI 2.161.0：`/Users/oliviayang/.npm-global/bin/codebuddy`。
- Prompt-only 连通命令已返回 `WORKBUDDY_CONNECTIVITY_OK`，退出码为 0，WB-01 的终端门禁通过。
- WB-02 到 WB-04 进入 GUI 真实链路回归；WB-05 到 WB-08 仍需官方远端执行入口，没有该入口时记录阻塞。
- 本机真实回归结果：WB-01 到 WB-04 全部通过。WB-04 还发现真实服务缺少工作流到任务的取消结论桥接方法；已新增显式桥接适配层，历史错误数据 `TSK-MUPNOML8-5110` 刷新后从“已完成”迁移到“已取消”，进度和验收项也恢复为未完成。

## 7. 2026-10-15 运行时状态与归档回归记录

环境：`.tmp/external-agent-home`（端口 33117，隔离数据目录），Admin 登录，6 个外部运行时、4 个外部 Teammate。

### 修复内容

1. 运行时三态在页面上显式表达：`启用中 / 已停用 / 已归档` 徽标取代原来只有一行浅色文字的状态描述。
2. Teammate 卡片与详情在绑定运行时不可用时显示 `（已停用）`、`（已归档）`、`（运行时不存在）`，
   并给出派发前需要改绑或切回内置执行的提示。
3. 补齐归档闭环：归档确认弹窗、默认列表隐藏、`已归档 N` 视图切换、复原（归档 → 停用）。
4. 派发失败原因按运行时状态区分，不再统一显示“运行时不存在或已停用”。

### 已通过

| 用例                        | 证据                                                                                                                                                                        |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| EXT-02 停用                 | 点击停用后徽标变为 `已停用`、按钮变为 `启用`，顶部提示“外部 Agent「通用命令假实现」已停用，绑定它的 Teammate 在下一次派发时会失败。”；切换页签后状态保持。                  |
| EXT-02 归档                 | 确认弹窗写明“从默认列表隐藏、不能再被选择或执行、当前有 1 个 Teammate 仍绑定它、可复原”；确认后列表移除该项、`已归档 1` 计数刷新，并提示需要改绑的 Teammate 数量。          |
| EXT-02 归档视图与复原       | `已归档 1` 视图只显示归档项，徽标为 `已归档`，动作仅剩 `复原`；复原后提示“已复原为停用”，归档视图清空，返回列表后该项为 `已停用`，需手动启用。                              |
| EXT-07 状态可见性与失败原因 | 停用后选中 `通用外部 Agent`：详情显示 `外部 Agent · 通用命令假实现（已停用）`；编辑执行方式时下拉保留禁用项 `通用命令假实现（已停用 · 不可用）`，并提示改绑或切回内置执行。 |
| 自动化                      | `vitest run` 26 个文件 / 389 个测试全部通过；新增运行时状态流转、归档视图、Teammate 绑定状态与失败原因断言。                                                                |

### 备注

1. 本轮 GUI 回归结束时已把 6 个运行时全部恢复为 `启用`，归档视图为空。
2. GUI 验证使用的 Admin 密码为临时改动，已在回归结束后还原原哈希。
3. 归档运行时不阻止操作，但会明确提示受影响 Teammate；派发时以“已归档，请复原或改绑”失败，符合回滚策略中的“停用或归档外部运行时”。

## 8. 2026-10-15 外部 Agent 反馈链路诊断与修复

### 现场证据

Task `TSK-MV8TGYHM-AA22` 首轮成功。人工退回并追加了“需形成 md 文档报告”后，
run 2 / run 3 都显示“外部 Agent 未返回可用的文本输出”。WorkBuddy trace 显示两次 CLI 均已启动，
并收到平台 Prompt；但首轮分别尝试用 Bash 查目录，随后触发 `Max turns (1) exceeded`。
CLI 退出码为 0 且 stdout 为空，因此平台按失败处理。

### 结论

1. 二次反馈本身已经派发，不是任务层没有触发。
2. 运行时 Args 里的 `--max-turns 1` 只适合 Prompt-only 探测；工具任务需要更高回合计数。
3. 外部 `plain-text` / `codex-jsonl` 是一次性进程。旧任务层第二次只投递增量讨论，
   WorkBuddy 看不到“上面的任务描述”，会尝试用工具找回上下文，放大了回合不足问题。
4. 零退出且 stdout 为空时，stderr 诊断被丢弃，导致认证/权限类问题只剩笼统提示。

### 修复

1. 外部执行身份的 Task 每轮重发完整任务定义、完整任务时间线和本次响应。
2. 零退出空输出时，stderr 会合并进失败诊断。
3. 真实 WorkBuddy 任务运行时建议把 `--max-turns` 从 `1` 调整为 `8`；Prompt-only 探测仍可用 `1`。

## 9. 2026-10-15 运行时定义编辑回归记录

### 更新内容

1. 未归档运行时卡片提供 `编辑`；归档视图仍只提供 `复原`，避免归档项被重新配置。
2. 编辑态复用注册表单，标题为 `编辑运行时`，保存按钮为 `保存修改`。
3. 名称、Provider、协议、命令、参数和状态可编辑；运行时 ID 和归属不变。
4. 命令或参数变化后清空旧探测结果，页面必须重新探测后再用于任务。

### 建议操作

| 步骤 | 操作                      | 预期结果                                                            |
| ---- | ------------------------- | ------------------------------------------------------------------- |
| 1    | 打开未归档运行时卡片      | 可见 `编辑`、`探测`、`停用/启用`、`归档`                            |
| 2    | 点击 `编辑`               | 表单标题为 `编辑运行时`，已有名称、Provider、协议、命令和参数被载入 |
| 3    | 修改参数并点击 `保存修改` | 提示 `已更新外部 Agent：<名称>`；旧探测结果消失                     |
| 4    | 点击 `探测`               | 新参数探测通过后才应继续派发任务                                    |
| 5    | 刷新页面                  | 编辑结果保持；运行时 ID 和绑定关系不变                              |

### 自动化验证

1. 服务端覆盖定义更新、旧探测结果清空和状态保存。
2. 前端烟测覆盖编辑入口、编辑态标题、保存按钮和更新请求。
3. 定向测试通过 3 个文件 / 61 条用例；全量测试通过 27 个文件 / 399 条用例。
4. `typecheck`、`oxlint`、`build` 和 `contract` 均通过；Teammate 前端产物已重建。

### 自动化

新增外部 Agent 无输出 stderr 诊断、外部 Teammate 二次派发完整上下文回归。
`vitest run` 定向通过 3 个测试文件 / 77 个测试。
