# Workflow Agent GUI Test Plan：Phase X

## 1. 测试范围

本方案验证工作流 Agent 节点的完整闭环：

1. Agent Profile 注册、启用、停用；
2. Markdown 模板校验和导入；
3. 手动派发与自动派发；
4. Agent Run 状态、提示词、开始/结束时间；
5. Agent 输出写入 required 交付物后仍需人工确认；
6. 失败、超时、取消、重试和人工兜底；
7. Profile 管理权限、节点操作权限和重试上限；
8. Task Worker 不创建左侧会话。

不验证模型输出的业务正确性；只验证输出能否进入可审计的交付物门禁。

## 2. 环境准备

仓库根目录：

```text
/Users/oliviayang/Codex/一切皆插件/dsh-pluginmax
```

终端进入根目录：

```sh
cd "/Users/oliviayang/Codex/一切皆插件/dsh-pluginmax"
```

构建并安装隔离 profile：

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm build
./scripts/install-profile.sh
```

启动隔离 Web：

```sh
DSH_HOME="$PWD/.tmp/dsh-home" node \
  vendor/deepseek-harness/apps/cli/lib/bin.js \
  --profile pluginmax --no-open --port 33117
```

打开终端输出的 Web URL。如果继续使用既有 `.tmp/dsh-home`，不要删除该目录。

### 浏览器 Profile

使用三个独立浏览器 Profile，不要只开三个普通标签页：

| Profile   | 账号                     | 工作区身份                    |
| --------- | ------------------------ | ----------------------------- |
| Profile A | admin / owner 测试账号   | 全局管理员，工作区 owner      |
| Profile B | flow-owner 测试账号  | 工作区 owner                  |
| Profile C | workflow-member 测试账号 | 工作区 member，后续节点责任人 |

每个 Profile 分别完成登录后，记录各自的登录成功提示。

## 3. 测试数据

| 文件                                            | 用途                                   |
| ----------------------------------------------- | -------------------------------------- |
| `docs/fixtures/workflow/agent-manual.md`        | 手动派发、取消、重试、人工兜底         |
| `docs/fixtures/workflow/agent-node.md`          | `auto-on-ready`、30 分钟超时、重试上限 |
| `docs/fixtures/workflow/agent-node-timeout.md`  | 1 秒超时的快速超时兜底专用模板         |
| `docs/fixtures/workflow/product-delivery-v2.md` | 真实多节点流程中的 Agent 节点回归      |

测试文本：

```text
已完成开发节点：补充了接口契约、数据结构、回归范围和已知风险。
```

该文本超过 20 字，可满足模板中的 required text 门禁。

## 4. 用例 A：Agent Profile 注册

### A1 创建 Profile

1. Profile A 打开 Settings。
2. 进入「工作流」或「Agent」设置分区中的 Agent 区块。
3. 在「新建 Task Worker Profile」中填写：
   - Profile ID：`backend-agent`
   - 显示名称：`Backend Agent`
   - 描述：`工作流开发节点 Task Worker`
   - Persona ID：留空
4. 点击「创建 Profile」。

预期：

1. 出现「Agent Profile 已创建。」或同等明确反馈。
2. Profiles 列表出现 `Backend Agent`。
3. 状态为「启用」，类型为 `task-worker`，工具白名单为 `0 项`。
4. Console 没有未捕获异常。

### A2 重复 ID

1. 再次使用 Profile ID `backend-agent` 创建。

预期：

1. 表单区域显示 conflict 错误。
2. 原有 Profile 不重复出现。

### A3 停用/启用

1. 点击 `Backend Agent` 的「停用」。
2. 观察状态。
3. 再点击「启用」。

预期：

1. 停用后显示「停用」，启用后恢复「启用」。
2. 每次操作都有明确反馈。
3. 刷新页面后状态保持。

### A4 Persona 软依赖

1. 用 Profile A 打开 DSH 页面并登录。
2. 点击页面左下角「设置」。
3. 在设置弹窗的二级菜单中选择「Agent」。
4. 在右侧内容区找到「Agent Profiles」和「新建 Task Worker Profile」表单。
5. 填写以下内容：
   - Profile ID：`missing-persona-test`
   - 显示名称：`Missing Persona Agent`
   - 描述：可留空
   - Persona ID：`missing-persona`
6. 点击「创建 Profile」。

预期：

1. 表单附近显示 Persona 不存在类错误，例如 `persona does not exist: missing-persona`。
2. 「Agent Profiles」列表不新增 `Missing Persona Agent`。

注意：表单默认可能预填 Profile ID `backend-agent`。执行本用例前必须先改为 `missing-persona-test`，否则会先命中重复 ID 错误，无法验证 Persona 软依赖。

## 5. 用例 B：手动 Agent 执行

### B1 导入手动模板

1. Profile A 打开中间主操作区的「工作流」tab。
2. 如果当前显示「只看当前会话」，点击切换为「查看工作区全部」，确认列表不是某个 session 的过滤视图。
3. 在「刷新」右侧点击「模板管理」，确认打开 Settings >「工作流」。普通成员会看到该按钮置灰，悬停提示需要 Owner 或全局管理员权限。
4. 在 Settings 的「导入 Markdown 模板」区域选择 `docs/fixtures/workflow/agent-manual.md`。
5. 勾选「保存后启用」。
6. 点击导入。

预期：

1. 导入成功。
2. 模板列表出现 `Agent 手动执行 v1`。
3. 启动表单的「选择流程模板」可以选中该模板。

### B2 启动并派发

1. Profile C 选择「Agent 手动执行 v1」。
2. 标题填 `Agent 手动执行测试`。
3. 点击「启动」。
4. 打开实例详情，查看「开发」节点。
5. 点击「派发 Agent」。

预期：

1. 启动和派发都有成功反馈。
2. 开发节点显示 Agent Run。
3. 状态先显示「排队中」或「运行中」。
4. 显示 `Backend Agent`、`第 1 次`、开始时间、超时上限 30 分钟。
5. 「取消运行」可用；「派发 Agent」在 active run 期间不再重复显示。

### B3 取消运行

1. 在 run 处于「排队中」或「运行中」时点击「取消运行」。
2. 刷新实例。

预期：

1. 出现取消反馈。
2. run 变成「已取消」。
3. 开发节点回到可处理状态，显示可重新派发或人工代交。
4. 工作流事件里能看到 `agent.dispatched` 和 `agent.cancelled`。

### B4 重新派发并等待成功

1. 点击「重试」。
2. 等待 run 完成；真实模型通常需要几十秒。
3. 展开「查看运行提示词」。
4. 观察 run 输出。

预期：

1. 新 run 显示 `第 2 次`。
2. Prompt 包含一次性 Task Worker 边界、节点名和交付要求。
3. 成功后 run 显示「已成功」，有结束时间。
4. 开发节点自动变 completed，不再要求人工补充交付物或点击「完成」。
5. `实现说明` 的当前版本来自 Agent 提交，记录中的提交人是 `agent:backend-agent`，代交对象是 `backend-agent`。

## 6. 用例 C：自动派发与超时兜底

### C1 导入自动模板

1. Profile A 在工作流模板管理导入 `docs/fixtures/workflow/agent-node.md`。
2. 勾选「保存后启用」。

预期：

1. 导入成功，模板显示 `Agent 节点执行 v2`；旧的 1 秒超时版本会被归档。
2. 模板校验没有 Agent Profile 错误。

### C2 自动触发

1. Profile C 选择「Agent 节点执行 v2」。
2. 标题填 `Agent 自动执行测试 003`。
3. 点击「启动」。
4. 立即打开实例详情。

预期：

1. 不需要点击「派发 Agent」。
2. 开发节点自动进入 running。
3. run 的触发来源显示自动派发。
4. 超时上限显示 30 分钟，节点保持 running，等待 Agent 输出。
5. Agent 成功后节点自动 completed；不再显示「提交交付物」表单。

### C3 超时后转人工（可选专项）

1. Profile A 另行导入 `docs/fixtures/workflow/agent-node-timeout.md`，并启用该模板。
2. 用该模板创建流程，等待 Agent Run 进入「超时」；模板的 1 秒超时只用于这项专项验证。
3. 查看节点状态和事件。
4. 在「实现说明」下方确认出现「Agent 未完成本次运行；节点负责人可以人工代交交付物，或重新派发 Agent。」提示和输入框。
5. Profile C 粘贴第 3 节的测试文本，点击「人工代交」。
6. 点击「完成」。

预期：

1. run 显示「超时」，有错误说明和结束时间。
2. 开发节点变 blocked，提示 Agent 运行未完成。
3. 人工代交后开发节点变 ready，required 交付物满足。
4. 节点可以由责任人确认完成，不需要伪造 Agent Run 成功状态。
5. 提交记录保留人工提交人和 `onBehalfOf: backend-agent`。

## 7. 用例 D：权限与重试上限

### D1 Profile 管理

1. Profile B 打开 Settings > Agent。
2. 尝试停用 `Backend Agent` 后再启用。
3. Profile C 打开同一页面，尝试创建或停用 Profile。

预期：

1. Profile B 是 owner，可以停用/启用。
2. Profile C 是 member，服务端返回 403。
3. 页面显示可读的权限错误，不出现未捕获异常。

### D2 节点操作

1. 用 agent-manual 模板创建新实例，责任人保持 `workflow-member`。
2. Profile C 手动派发一次，然后取消。
3. 另用一个 guest 身份访问同一实例，尝试派发。

预期：

1. 节点责任人可以派发、取消、重试。
2. guest 不能派发，页面显示权限错误。
3. owner/admin 也可以操作，但普通 member 只能操作自己负责的节点。

### D3 重试上限

1. 让 `Agent 节点执行 v1` 的新实例第一次 run 失败或超时。
2. Profile C 点击「重试」。
3. 等第二次 run 失败或超时。
4. Profile C 再次点击「重试」。
5. Profile B 或 Profile A 尝试处理同一节点。

预期：

1. 第一次重试后 run 是第 2 次。
2. 第二次再次失败后，member 重试被拒绝。
3. 错误说明包含 `max-attempts=2`，并提示联系 owner/admin。
4. owner/admin 可以越过上限继续处理或改走人工交付。

## 8. 用例 E：完整工作流回归

1. Profile A 导入 `docs/fixtures/workflow/product-delivery-v2.md`。
2. 确认启动表单选择的是 `产品交付 v6`；不要复用旧的 `v5` 实例。
3. Profile C 启动实例，标题 `订单导出 Agent 回归`。
4. 在「需求评审」点击通过。
5. 观察「开发」和「测试准备」；「开发」下方必须有「AGENT 运行」区域和「派发 Agent」按钮。
6. 在「开发」节点手动派发 `Backend Agent`。
7. run 成功后开发节点自动 completed。
8. Profile C 完成「测试准备」。
9. Profile B 和 Profile C 完成发布审批。
10. 完成发布节点。

预期：

1. 需求评审通过后，开发和测试准备并行 ready。
2. Agent run 与交付物门禁只影响开发节点。
3. 发布审批满足 all 策略后，发布节点才可完成。
4. 实例最终状态 completed。
5. 左侧会话列表没有新增 `Backend Agent` 或 Task Worker home session。

## 9. 安全与可读性检查

1. 使用浏览器 DevTools 的 Network 面板确认 Agent API 都带 `Authorization: Bearer ...`。
2. 从非同源页面发起请求应被拒绝。
3. 所有 Agent 操作失败必须有中文、可读反馈；不允许静默失败。
4. 开始/结束时间使用本地时间显示；跨年记录包含年份。
5. Profile 下拉框或工作区选择器显示工作区名称；不直接要求用户识别 UUID。
6. 刷新页面后 Profile、run、交付物、节点状态不丢失。
7. Console 没有未捕获异常。

## 10. 结束清理

1. 不删除 `.tmp/dsh-home`；如需清理，先确认其中没有要保留的测试数据。
2. 停止 Web 进程。
3. 把失败的截图、实例 ID 和 run ID 附到缺陷记录。
4. 每个缺陷至少包含：操作步骤、期望结果、实际结果、浏览器 Profile、工作区名称、实例 ID。
