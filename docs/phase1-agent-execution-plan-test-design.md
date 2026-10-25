# 测试设计：阶段一 Runtime Agent Execution Plan 闭环

> 版本：v1.0  
> 日期：2026-10-25  
> 测试对象：`dsh-collab-task`、`dsh-collab-agent`、`dsh-collab-context`、`dsh-collab-teammate` 的阶段一组合能力  
> 技术设计：[阶段一 Runtime Agent Execution Plan 闭环](./technical-design-phase1-agent-execution-plan.md)  
> 测试资料：[docs/fixtures/phase1/](./fixtures/phase1/README.md)

## 0. 结论先行

本方案不只验证“任务能跑完”，而是验证以下控制链是否真实闭环：

```text
Task Execution Policy
  → Runtime Preflight
  → Immutable Execution Envelope
  → Agent Run
  → Agent Execution Plan
  → Run Events / Tool Events / Gate
  → Final Run Snapshot
  → Review / Reject / Second Run
  → Archive / Restore
```

通过标准必须同时满足：

1. 页面显示的策略、Runtime 能力和实际 Run 快照一致。
2. Runtime 支持搜索、任务授权搜索、本轮启用搜索、实际发生搜索、最终快照记录五层事实不混淆。
3. 外部 Runtime 的 `observe-only` 边界不被伪装成 blocking Gate。
4. Review 退回说明进入第二轮 Agent 上下文，负责人恢复为原提交执行人，并产生新 Run。
5. 多轮执行可以按轮次查看各自的指令、计划、事件、产出和运行元数据。
6. 页面刷新、窄屏、失败和取消都不会制造假成功。

## 1. 测试范围

### 1.1 覆盖范围

| 能力域                | 覆盖内容                                                            |
| --------------------- | ------------------------------------------------------------------- |
| Task Execution Policy | 创建、编辑、持久化、legacy 默认值、公开来源、工具审批、指定 Runtime |
| Runtime Preflight     | 能力三态、必要能力和偏好能力、缺能力阻断、Runtime 不可用            |
| Agent Execution Plan  | `structured`、`summary`、`derived`、无计划时的降级文案              |
| Run Events            | 计划、步骤、工具调用、工具结果、会话、错误、文本进度、去重和顺序    |
| Search Facts          | Runtime 支持、任务授权、启动参数启用、实际工具事件、Run Snapshot    |
| Execution Gate        | blocking Gate 的批准、拒绝、超时；外部 Runtime 的 observe-only 边界 |
| Run Snapshot          | Provider、模型、Runtime、版本、认证、沙箱、搜索、计划可见性         |
| Review / Rerun        | 待验收、退回、反馈持久化、负责人恢复、第二轮 Run                    |
| Context Policy        | `execution-policy`、`source-policy` 和引用要求进入 Runtime 上下文   |
| 插件独立闭环          | Agent 缺失、Context 缺失、外部 Runtime 不可用时的明确降级           |
| GUI E2E               | 任务创建、执行过程、Gate、多轮切换、刷新、响应式、Console/Network   |

### 1.2 不覆盖范围

1. 阶段二 `Task Team`、`Task Delivery Plan`、`Work Item` 和 Lead Agent。
2. 真实 Codex、WorkBuddy、DeepSeek 账号的登录有效性、额度和供应商服务质量。
3. 外部 CLI 内部的私有工具协议；阶段一只验证平台能够观察和持久化的事件。
4. 跨项目自动记忆共享。
5. 原始思维链持久化。平台只允许展示推理阶段摘要，不保存原始 chain-of-thought。

## 2. 测试策略

### 2.1 四层测试

| 层级       | 目标                                              | 主要证据                                      |
| ---------- | ------------------------------------------------- | --------------------------------------------- |
| L1 自动化  | 契约、状态机、投影、幂等、错误处理                | Vitest、TypeScript、lint、build               |
| L2 集成    | Task → Agent → Context 的服务级闭环               | 服务测试、运行投影、持久化数据                |
| L3 GUI E2E | 用户从页面完成策略创建、执行、批准、退回和查看    | Playwright 截图、Network、Console、终端 trace |
| L4 边界    | 取消、失败、超时、外部 Runtime 不可阻断、插件缺失 | 诊断文案、Run 状态、Gate 状态、无假成功       |

### 2.2 确定性优先级

1. 能用 fake runtime 验证的内容必须先使用 fake runtime，避免模型波动污染结论。
2. blocking Gate 必须使用内置 DSH Runtime，因为当前外部 `codex-jsonl` 与 `plain-text` Adapter 默认是 `observe-only`。
3. 真实模型用例只能证明供应商可用性，不能替代 fake runtime 对平台协议和状态机的断言。
4. 探测只证明命令可启动，不证明 Prompt、工具事件或最终输出正确。

## 3. 测试环境

### 3.1 仓库与端口

默认仓库：

```text
/Users/oliviayang/Codex/一切皆插件/dsh-pluginmax
```

建议端口：`33131`。如果已占用，改用 `33132`、`33133`，不要停止正在使用的 `33124`。

### 3.2 每次使用全新隔离 profile

`scripts/install-profile.sh` 已支持通过 `DSH_HOME` 指定隔离目录。完整回归不得复用历史 `profile`，因为旧的账户、文件锁、Run 和归档版本会污染结果。

```sh
cd "/Users/oliviayang/Codex/一切皆插件/dsh-pluginmax"

export PHASE1_HOME="$PWD/.tmp/phase1-gui-test-home"
export PHASE1_WORKSPACE="$PWD/.tmp/phase1-gui-workspace"
export PHASE1_EVIDENCE="$PWD/.tmp/phase1-gui-evidence"

rm -rf "$PHASE1_HOME" "$PHASE1_WORKSPACE" "$PHASE1_EVIDENCE"
mkdir -p "$PHASE1_WORKSPACE" "$PHASE1_EVIDENCE"

DSH_HOME="$PHASE1_HOME" ./scripts/install-profile.sh
```

预期：

- 输出 `installed profile: .../.tmp/phase1-gui-test-home/profiles/pluginmax`。
- `$PHASE1_HOME/storages` 在服务首次启动前没有旧测试数据。
- `$PHASE1_WORKSPACE` 是本轮唯一允许写入的任务工作区。

### 3.3 构建和启动

```sh
CI=true corepack pnpm install --frozen-lockfile
CI=true corepack pnpm run build

DSH_HOME="$PHASE1_HOME" \
  node vendor/deepseek-harness/apps/cli/lib/bin.js \
  --profile pluginmax \
  --no-open \
  --port 33131 2>&1 | tee "$PHASE1_EVIDENCE/server.log"
```

预期：

1. 终端出现完整 `<ROOT_URL>`，形如 `http://127.0.0.1:33131/?token=...`。
2. 首次打开必须使用完整 URL，不能只打开裸地址。
3. 后续运行外部 Agent 时，同一终端持续出现：

```text
[外部Agent] run=run-... agent=... spawn: ...
[外部Agent] run=run-... stdin: stdin 已写入 ... 字节
[外部Agent] run=run-... session/tool_call/tool_result/close: ...
```

终端 trace 用于证明外部 Runtime 由真实子进程执行；页面证据用于证明状态和产物被平台正确投影。

### 3.4 浏览器 Profile

| Profile | 账号            | 全局角色 | 项目角色 | 用途                                      |
| ------- | --------------- | -------- | -------- | ----------------------------------------- |
| A       | `phase1-owner`  | admin    | owner    | 初始化、项目、Runtime、AI伙伴、任务和验收 |
| B       | `phase1-member` | member   | member   | 普通成员只读和越权检查                    |

初始密码统一使用本轮临时密码 `Pluginmax#2026`。账号只存在于隔离 `DSH_HOME`。

## 4. 测试数据准备

### 4.1 固定文件

| 用途                       | 文件                                                       |
| -------------------------- | ---------------------------------------------------------- |
| 消消乐市场调研任务         | `docs/fixtures/phase1/market-research-task.md`             |
| Codex 轨迹任务             | `docs/fixtures/phase1/codex-trace-task.md`                 |
| 内置 Runtime Gate 任务     | `docs/fixtures/phase1/builtin-gate-task.md`                |
| 退回反馈                   | `docs/fixtures/phase1/review-feedback.txt`                 |
| 研究策略 JSON              | `docs/fixtures/phase1/research-execution-policy.json`      |
| 写文件审批策略 JSON        | `docs/fixtures/phase1/tool-approval-execution-policy.json` |
| WorkBuddy stream-json fake | `docs/fixtures/phase1/workbuddy-stream-fake.mjs`           |
| Codex JSONL fake           | `docs/fixtures/phase1/codex-trace-fake.mjs`                |
| 三个 AI伙伴 SOUL           | `docs/fixtures/phase1/*-soul.md`                           |
| 浏览器执行投影采集片段     | `docs/fixtures/phase1/browser-evidence-snippet.js`         |

JSON 和任务 Markdown 是录入参考与 API 排障资料，GUI 用例仍按页面字段操作，不能通过直接写 storage 造验收结果。

### 4.2 Fake Runtime 预检

```sh
printf 'PHASE1_PREFLIGHT\n## 来源策略\npublic-web regulatory-filing\nPHASE1_FEEDBACK_ADD_COMPETITOR_COMPARISON' \
  | node docs/fixtures/phase1/workbuddy-stream-fake.mjs \
      --scenario search \
      --search \
      --phase1-session phase1-preflight \
      --output-format stream-json
```

预期包含：

```text
PHASE1_VISIBLE_PROGRESS
web_search
PHASE1_SEARCH_RESULT
PHASE1_RESEARCH_DONE
PHASE1_SOURCE_POLICY_SEEN=YES
PHASE1_FEEDBACK_SEEN=PHASE1_FEEDBACK_ADD_COMPETITOR_COMPARISON
```

Codex：

```sh
printf 'PHASE1_PREFLIGHT' \
  | node docs/fixtures/phase1/codex-trace-fake.mjs \
      exec --json --cd "$PHASE1_WORKSPACE" \
      --sandbox read-only \
      --output-last-message /tmp/phase1-codex-last-message.md -
cat /tmp/phase1-codex-last-message.md
```

预期 stdout 包含 `PHASE1_CODEX_VISIBLE_PROGRESS`，最终文件包含 `PHASE1_CODEX_DONE`。

任一预检失败，停止 GUI 执行，先排查 Node、路径和文件权限。

### 4.3 Runtime 和 AI 伙伴

Runtime 参数：

| Runtime 名称                 | Provider  | 协议              | 命令   | 结构化配置         | 用途                       |
| ---------------------------- | --------- | ----------------- | ------ | ------------------ | -------------------------- |
| `P1-WorkBuddy-Research-Fake` | WorkBuddy | 通用 stdin/stdout | `node` | 见下方字段         | 搜索、事件、策略、反馈     |
| `P1-WorkBuddy-Write-Observe` | WorkBuddy | 通用 stdin/stdout | `node` | 见下方字段         | 外部 observe-only 写入观察 |
| `P1-Codex-Trace-Fake`        | Codex     | Codex JSONL       | `node` | 工具与模型池见下方 | JSONL 摘要计划与未知元数据 |

WorkBuddy 搜索运行时：

| 字段           | 值                                                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 支持工具       | 网页搜索、网页抓取、读取文件                                                                                                         |
| 模型池         | 留空，沿用 CLI 默认模型                                                                                                              |
| 默认模型       | 沿用 CLI 默认模型                                                                                                                    |
| 最大上下文窗口 | 128000                                                                                                                               |
| 文件修改权限   | 默认权限                                                                                                                             |
| 最大执行回合   | 留空                                                                                                                                 |
| 额外参数       | `<REPO>/docs/fixtures/phase1/workbuddy-stream-fake.mjs --scenario search --slow --phase1-session phase1-research-gui --write-report` |

WorkBuddy 写入观察运行时：

| 字段           | 值                                                                                                                      |
| -------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 支持工具       | 写入文件                                                                                                                |
| 模型池         | 留空，沿用 CLI 默认模型                                                                                                 |
| 默认模型       | 沿用 CLI 默认模型                                                                                                       |
| 最大上下文窗口 | 128000                                                                                                                  |
| 文件修改权限   | 默认权限                                                                                                                |
| 最大执行回合   | 留空                                                                                                                    |
| 额外参数       | `<REPO>/docs/fixtures/phase1/workbuddy-stream-fake.mjs --scenario write --phase1-session phase1-write-gui --write-file` |

Codex 轨迹运行时：

| 字段           | 值                                                 |
| -------------- | -------------------------------------------------- |
| 支持工具       | 读取文件、执行命令                                 |
| 模型池         | 留空，沿用 CLI 默认模型                            |
| 默认模型       | 沿用 CLI 默认模型                                  |
| 最大上下文窗口 | 128000                                             |
| 执行沙箱       | 只读 / 网络受限                                    |
| 额外参数       | `<REPO>/docs/fixtures/phase1/codex-trace-fake.mjs` |

AI 伙伴定义：

| 名称             | 专业角色           | 基础说明                         | SOUL                         | 工具            | 执行方式                                  |
| ---------------- | ------------------ | -------------------------------- | ---------------------------- | --------------- | ----------------------------------------- |
| `P1-调研分析员`  | 市场调研分析员     | 负责公开来源竞品研究和机会判断   | `research-agent-soul.md`     | 留空            | 外部 Agent / `P1-WorkBuddy-Research-Fake` |
| `P1-Codex记录员` | 执行记录员         | 负责执行轨迹摘要和可核验证据整理 | `codex-trace-agent-soul.md`  | 留空            | 外部 Agent / `P1-Codex-Trace-Fake`        |
| `P1-内置门禁员`  | 受控文件写入执行员 | 仅执行批准后的工作区文件写入     | `builtin-gate-agent-soul.md` | `read`、`write` | 内置执行                                  |

SOUL 中不得出现 Provider、Runtime ID、命令、模型或沙箱信息；这些信息只属于执行绑定。

### 4.4 记录变量

创建后把真实值写入 `$PHASE1_EVIDENCE/ids.md`：

```text
WS_ID=
WORKBUDDY_SEARCH_RUNTIME_ID=
WORKBUDDY_WRITE_RUNTIME_ID=
CODEX_TRACE_RUNTIME_ID=
RESEARCH_TEAMMATE_ID=
CODEX_TEAMMATE_ID=
GATE_TEAMMATE_ID=
```

不要手写、猜测或复用其他环境 ID。

## 5. 自动化测试

### 5.1 全量门禁

```sh
CI=true corepack pnpm run check
```

预期：

- Typecheck 通过。
- Lint 通过。
- 全部 Vitest 通过。
- 全部插件 build 通过。
- contract 检查通过。
- pack dry-run 通过。

基线记录：2026-10-25 修复后已通过 37 个测试文件、610 个测试用例。实际回归以本轮命令输出为准，不在文档中固化永久数量。

### 5.2 阶段一定向测试

```sh
CI=true corepack pnpm exec vitest run \
  plugins/dsh-collab-agent/src/execution.test.ts \
  plugins/dsh-collab-agent/src/external.test.ts \
  plugins/dsh-collab-agent/src/index.test.ts \
  plugins/dsh-collab-task/src/service.test.ts \
  plugins/dsh-collab-task/src/index.test.ts \
  plugins/dsh-collab-task/src/client-smoke.test.ts \
  plugins/dsh-collab-context/src/index.test.ts
```

## 6. 核心功能链路用例

### CORE-01 Task Execution Policy 持久化

前置：Task 插件可独立启动。

| 步骤 | 操作                                  | 预期结果                                                               |
| ---- | ------------------------------------- | ---------------------------------------------------------------------- |
| 1    | 创建带 `executionPolicy` 的任务       | 任务保存策略原值；旧客户端缺省时读取 `legacy-default`                  |
| 2    | 将 `allowPublicWeb` 改为 false 并保存 | `sourcePolicy.allow` 移除 `public-web`、`regulatory-filing` 和引用要求 |
| 3    | 重新读取并刷新                        | 策略版本来自持久化记录，不从前端勾选状态推测                           |
| 4    | 给旧格式任务补字段                    | 不要求历史任务立即迁移，读取时生成 legacy default                      |
| 5    | 提交非法数组、非法工具类别或超限预算  | 请求被拒绝，原任务不被部分写入                                         |

通过条件：策略可以创建和编辑，但已启动 Run 的 Envelope 不被后来修改覆盖。

### CORE-02 Runtime Capability 与 Preflight

| 场景                 | 输入                                        | 预期                             |
| -------------------- | ------------------------------------------- | -------------------------------- |
| Runtime 明确支持搜索 | Runtime args 含 `--search` 或内置工具含搜索 | `capabilities.search=supported`  |
| Runtime 明确不支持   | 内置 Profile 无搜索工具                     | `unsupported` 并产生必要能力缺口 |
| Runtime 未知         | plain-text 无 `--search`                    | `unknown`，不能当成 true         |
| 必要条件缺失         | Task 要求 search required                   | `compatible=false`，不创建 Run   |
| 偏好条件缺失         | Task 仅要求 search preferred                | 产生 gap/warning，但可继续       |
| Runtime 不在白名单   | `allowedRuntimeIds` 不含当前 Runtime        | `policy-not-authorized`，阻断    |
| Runtime 停用或归档   | 绑定状态不可用                              | `runtime-unavailable`，阻断      |

通过条件：预检不创建 Run；阻断原因可读，建议 Runtime 不能由名称推断。

### CORE-03 Agent Execution Plan

| 场景                          | 事件来源                | 预期                                                                         |
| ----------------------------- | ----------------------- | ---------------------------------------------------------------------------- |
| 内置会话提交 `todo/write`     | `builtin-session`       | `source=explicit`，`visibility=structured`，步骤映射 complete/active/pending |
| 外部 Runtime 只有生命周期事件 | `external-trace`        | `source=derived`，`visibility=summary`，文案为“执行记录/已观察阶段”          |
| 无可靠计划事件                | 失败或历史 Run          | 显示 unavailable/暂无，不能伪造 Agent 原始步骤                               |
| 工具事件到达                  | tool.call / tool.result | Plan revision 增加，事件按序投影                                             |

通过条件：Plan 是事件投影视图，不替代原始 Run Event。

### CORE-04 Run Event 顺序与幂等

1. 连续写入同一 `sourceEventId` 两次。
2. 写入不同类型的工具事件。
3. 并发触发同一 Run 的事件缓冲。

预期：

- 同 Run 的 `seq` 严格递增。
- 重复 `sourceEventId` 不重复写入。
- 工具调用、工具结果和错误分别保留类型、摘要和时间。
- 原始 thinking 不写入公开事件；只记录推理阶段摘要。
- 达到事件保留上限后优先保留关键事件与 artifact 引用。

### CORE-05 搜索五层事实

| 层次            | 测试输入                          | 页面/快照预期                                  |
| --------------- | --------------------------------- | ---------------------------------------------- |
| L1 Runtime 支持 | WorkBuddy fake args 含 `--search` | Runtime 能力 supported                         |
| L2 任务授权     | 勾选“允许公开网页与监管文件”      | Envelope 允许 public-web                       |
| L3 参数启用     | 指定搜索 Runtime                  | `searchEnabled=true`                           |
| L4 实际发生     | fake 发出 `web_search` 工具事件   | `usedTools` 含 `web_search`，`searchUsed=true` |
| L5 最终快照     | Run 结束                          | 固化 true/true，不因后续策略编辑变化           |

反向用例：

| 场景                        | 预期                                   |
| --------------------------- | -------------------------------------- |
| 支持搜索但任务未授权        | `searchEnabled=false`                  |
| 任务授权但 Runtime 不支持   | preflight 阻断或 `searchEnabled=false` |
| 支持搜索但无法确认是否调用  | `searchUsed=null`，页面显示“未知”      |
| 完整工具事件且未搜索        | 终态可以 `searchUsed=false`            |
| 外部 Runtime 搜索结果不完整 | 不得把“未看到搜索”当作“没有搜索”       |

### CORE-06 Execution Gate 状态机

| 用例     | 操作                       | 预期                                       |
| -------- | -------------------------- | ------------------------------------------ |
| 批准     | pending Gate 收到 approved | 工具继续；Gate=approved；写 `gate.decided` |
| 拒绝     | pending Gate 收到 denied   | 工具返回结构化拒绝；Gate=denied            |
| 超时     | 达到 `expiresAt`           | Gate=expired；Run 不假成功                 |
| 取消     | Run AbortSignal 触发       | Gate=cancelled；终止等待                   |
| 幂等     | 重复提交同一决策           | 返回原决策，不产生第二条终态               |
| 冲突决策 | approved 后提交 denied     | 明确报“已经决定”，不覆盖                   |

### CORE-07 Run Snapshot 最终元数据

完成一次 WorkBuddy fake Run 后读取执行投影，预期：

```text
provider=phase1-fixture
model=phase1-research-model
runtimeName=P1-WorkBuddy-Research-Fake
runtimeVersion=1.0.0-phase1
authMode=fixture-no-secret
sandbox=workspace-write
gateEnforcement=observe-only
searchEnabled=true
searchUsed=true
planVisibility=summary
```

完成一次 Codex fake Run 后预期：

```text
provider=codex
model=unknown
runtimeVersion=unknown
authMode=unknown 或探测结果
sandbox=unknown 或会话元数据
searchEnabled=null
searchUsed=null
```

通过条件：未知显示“未采集/未知”，不能使用 Runtime 名称或上次 Run 元数据顶替。

### CORE-08 Review 退回与第二轮 Run

1. Agent Run 成功并自动进入待验收，负责人变为实例 owner。
2. owner 填写 `review-feedback.txt` 并退回。
3. 服务立即恢复原执行 Agent 为负责人并创建新 Run。
4. 检查第二轮 Prompt。

预期：

- 退回说明写入 Task messages，`deliveryTarget=receiver`。
- 第二轮 Prompt 包含 `PHASE1_FEEDBACK_ADD_COMPETITOR_COMPARISON`。
- 产生新 Run ID，旧 Run 保持不可变。
- 第二轮成功后再次进入待验收，负责人再次变为实例 owner。
- 反馈不因第一次 Run 失败、刷新或重试而丢失。

### CORE-09 Context Source Policy

1. 任务授权 `public-web` 和 `regulatory-filing`。
2. 要求 citation、publishedAt、accessedAt。
3. 生成 ContextPack 和 Prompt。

预期：

- 存在 `execution-policy` 与 `source-policy` section。
- Prompt 明确允许授权的公开来源，不再出现“ContextPack 外一律禁止”的旧硬编码。
- 禁止来源仍优先。
- Fake runtime 输出 `PHASE1_SOURCE_POLICY_SEEN=YES`。
- ContextReceipt 可选记录 envelope ID、策略版本和 plan visibility。

### CORE-10 失败与插件降级

| 场景               | 预期                                      |
| ------------------ | ----------------------------------------- |
| Agent 插件未安装   | 人工任务闭环可用；不显示执行区块          |
| Context 插件未安装 | Agent 仍可运行；标记 context unavailable  |
| Runtime 启动失败   | Run=failed，显示进程错误，不伪造成 stdout |
| 外部 Agent 空输出  | Run=failed，显示“未返回可用文本输出”      |
| 进程中断           | Run=interrupted，保留已有事件             |
| 超时               | Run=timeout；Plan 和 Gate 不显示完成      |
| 取消               | Run=cancelled；后续无权继续推进 Task      |

## 7. GUI 端到端用例

每个用例开始前：

1. 清空 Console。
2. 打开 Network，保留失败请求与错误状态。
3. 记录任务 ID、Run ID、Runtime ID 和截图。
4. 测试结束检查 Console 无未捕获异常；允许的 dev boot-order 噪声必须单独记录。

### GUI-01 初始化、Runtime 与 AI 伙伴

目标：从零准备可执行的三类 AI 伙伴，并验证 Runtime 真正可调用。

| 步骤 | 操作                                        | 输入                              | 逐项预期                                             |
| ---- | ------------------------------------------- | --------------------------------- | ---------------------------------------------------- |
| 1    | 打开完整 `<ROOT_URL>`                       | 无                                | 显示首次初始化或登录页                               |
| 2    | Settings > 协作身份创建管理员               | `phase1-owner` / `Pluginmax#2026` | 成为 admin，页面显示当前账号                         |
| 3    | 创建普通成员                                | `phase1-member` / member          | 用户列表出现该账号                                   |
| 4    | 左侧项目区域添加项目路径                    | `$PHASE1_WORKSPACE`               | 生成真实 `<WS_ID>`                                   |
| 5    | 将 `phase1-member` 加入项目                 | member                            | 项目成员可见，无 Owner 能力                          |
| 6    | AI Teammates > 外部 Agent 管理 > 注册运行时 | 搜索 Runtime 参数                 | 保存成功，状态“启用”                                 |
| 7    | 点击探测                                    | 无                                | 显示“命令探测通过”；记录 Runtime ID                  |
| 8    | 注册写入观察 Runtime                        | 参数表                            | 保存和探测成功                                       |
| 9    | 注册 Codex Trace Runtime                    | 参数表                            | 保存和探测成功                                       |
| 10   | 定义态新建三个个人模版                      | 名称、角色、说明、SOUL、工具      | 保存后为草稿；SOUL 中无 Runtime 信息                 |
| 11   | 依次点击“生效”                              | 三个模版                          | 状态变为“已生效”                                     |
| 12   | AI伙伴管理 > 新建 AI伙伴                    | 选择模版、项目、名称              | 实例创建成功并归当前 owner                           |
| 13   | 编辑 `P1-调研分析员` 的执行方式             | 外部 Agent / WorkBuddy Research   | 保存后显示 `外部 Agent · P1-WorkBuddy-Research-Fake` |
| 14   | 编辑 `P1-Codex记录员` 的执行方式            | 外部 Agent / Codex Trace          | 保存后徽标正确                                       |
| 15   | 编辑 `P1-内置门禁员`                        | 内置执行                          | 保存后显示“内置执行”                                 |
| 16   | 刷新页面并重新打开三个实例                  | 无                                | 绑定、SOUL、状态和项目不丢失                         |

通过条件：

- Runtime 列表、AI伙伴绑定和 SOUL 各自只展示本域信息。
- 探测结果不能替代任务执行结果。
- 记录到 `$PHASE1_EVIDENCE/ids.md` 的 Runtime ID 与页面一致。

截图：`phase1-gui01-runtimes.png`、`phase1-gui01-research-teammate.png`、`phase1-gui01-codex-teammate.png`。

### GUI-02 Task Execution Policy 创建、编辑和刷新

目标：验证阶段一页面能完整表达执行策略，并且刷新后不丢。

| 步骤 | 操作                                           | 输入                                      | 逐项预期                                |
| ---- | ---------------------------------------------- | ----------------------------------------- | --------------------------------------- |
| 1    | 任务管理 > 新建任务                            | 标题 `P1-策略持久化`，责任人为外部 AI伙伴 | 打开创建表单                            |
| 2    | 填写项目、描述、验收标准                       | 任意有效值                                | 必填项有效                              |
| 3    | 勾选“允许公开网页与监管文件”                   | 勾选                                      | 显示来源、发布日期和访问时间要求说明    |
| 4    | 勾选“写文件、执行命令和外部发布前需要人工确认” | 勾选                                      | 复选框保持勾选                          |
| 5    | 勾选“要求记录实际工具调用事件”                 | 勾选                                      | 复选框保持勾选                          |
| 6    | 选择责任 AI伙伴                                | 绑定 `P1-WorkBuddy-Research-Fake` 的伙伴  | Runtime 只读，任务内不能切换            |
| 7    | 选择本轮模型与推理强度                         | 模型池首项、`high`                        | 模型只能来自 Runtime 模型池             |
| 8    | 点击派发或保存                                 | 无                                        | 任务创建成功                            |
| 9    | 打开任务编辑态                                 | 无                                        | 策略、Runtime、模型和推理强度与输入一致 |
| 10   | 修改为不授权公开来源并保存                     | 取消第一个勾选                            | 其他字段按本轮操作保留                  |
| 11   | 刷新页面后再次打开编辑态                       | 无                                        | 修改后的策略仍在；无重复策略或旧值回写  |
| 12   | 归档该验证任务                                 | 无                                        | 从默认看板隐藏，历史保留                |

通过条件：页面的策略开关、Runtime、模型和推理强度与保存后的 Task `executionPolicy` 一致；刷新不改变选择状态。

截图：`phase1-gui02-policy-create.png`、`phase1-gui02-policy-refresh.png`。

### GUI-03 WorkBuddy 研究任务完整闭环

目标：验证搜索、来源策略、工具事件、计划、最终快照和 Review 的端到端投影。

| 步骤 | 操作                                          | 输入                         | 逐项预期                                                                         |
| ---- | --------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------- |
| 1    | 新建任务                                      | 按 `market-research-task.md` | 责任人为 `P1-调研分析员`                                                         |
| 2    | 保留“自动提交 Review”                         | 默认勾选                     | 成功后可进入待验收                                                               |
| 3    | 勾选公开来源和工具事件                        | 按文件                       | Runtime ID 指向 WorkBuddy Research                                               |
| 4    | 点击派发                                      | 无                           | 任务进入进行中，创建新 Run                                                       |
| 5    | 观察终端                                      | 无                           | 出现 spawn、stdin 字节数、session、thinking、tool_call、tool_result、close       |
| 6    | 观察页面“执行过程”                            | 无                           | 逐步出现 `PHASE1_VISIBLE_PROGRESS` 和搜索进度                                    |
| 7    | 展开“Agent 执行计划”                          | 无                           | 显示 `摘要 · 根据事件整理`，不伪造显式步骤                                       |
| 8    | 等待 Run 结束                                 | 无                           | 事件包含 `web_search` 调用和搜索返回                                             |
| 9    | 检查最终输出                                  | 无                           | 包含 `PHASE1_RESEARCH_DONE`、`PHASE1_SOURCE_POLICY_SEEN=YES`、来源日期和访问时间 |
| 10   | 检查“产出物”                                  | 无                           | 出现 `phase1-market-research-report.md`，可打开或下载并归属 WorkBuddy Run        |
| 11   | 检查“运行信息”                                | 无                           | Provider、模型、Runtime、版本、认证、沙箱和工具门禁显示 fake 提供的值            |
| 12   | 检查搜索三元组                                | 无                           | 搜索启用=是；网络=未采集；实际搜索=是                                            |
| 13   | 检查任务状态和责任人                          | 无                           | 状态进入待验收，责任人变为实例 owner                                             |
| 14   | 用 `browser-evidence-snippet.js` 获取执行投影 | 替换 `<TASK_ID>`             | snapshot `searchEnabled=true`、`searchUsed=true`、`usedTools` 含 `web_search`    |
| 15   | 刷新页面                                      | 无                           | 最终计划、事件、产出和快照仍属于同一轮次                                         |

注意：fake runtime 的“网络=未采集”是正确结果。它不能因为搜索成功就推断网络模式是 public。

通过条件：

- 页面、API 快照和终端 trace 三处证据一致。
- 没有任何步骤把 `unknown` 显示成 false 或 true。
- 原始 thinking 文本不进入持久化公开事件；页面只显示推理阶段摘要。

截图：`phase1-gui03-running.png`、`phase1-gui03-plan.png`、`phase1-gui03-snapshot.png`、`phase1-gui03-review.png`。

### GUI-04 搜索能力未知导致 Preflight 阻断

目标：验证“Runtime 名称看起来像 Codex”不会被当成具备搜索能力。

| 步骤 | 操作         | 输入                     | 逐项预期                                                        |
| ---- | ------------ | ------------------------ | --------------------------------------------------------------- |
| 1    | 新建任务     | 标题 `P1-无搜索能力阻断` | 责任人为 `P1-Codex记录员`                                       |
| 2    | 勾选公开来源 | 勾选                     | 任务要求 search                                                 |
| 3    | 指定 Runtime | `CODEX_TRACE_RUNTIME_ID` | 该 Runtime 没有 `--search`，搜索能力保持 unknown                |
| 4    | 点击派发     | 无                       | 页面出现无法启动执行的系统消息                                  |
| 5    | 检查错误文案 | 无                       | 明确包含 `Runtime capability is unknown: search` 或等价可读原因 |
| 6    | 检查任务状态 | 无                       | 不进入待验收，不出现 succeeded Run                              |
| 7    | 检查 Network | 无                       | 请求失败或任务消息记录失败原因，不能返回伪造 Run ID             |

通过条件：未知能力按“未证明支持”处理；阻断后仍可改 Runtime 或去掉公开来源要求后重试。

截图：`phase1-gui04-preflight-blocked.png`。

### GUI-05 Codex JSONL 摘要计划与未知元数据

目标：验证 Codex JSONL 事件进入 Run Event，同时不猜测未采集元数据。

| 步骤 | 操作           | 输入                                  | 逐项预期                                                                    |
| ---- | -------------- | ------------------------------------- | --------------------------------------------------------------------------- |
| 1    | 新建任务       | 按 `codex-trace-task.md`              | 责任人为 `P1-Codex记录员`                                                   |
| 2    | 不勾选公开来源 | 无                                    | 任务不要求搜索                                                              |
| 3    | 勾选工具事件   | 勾选                                  | 执行策略要求事件证据                                                        |
| 4    | 派发任务       | 无                                    | 创建 Codex fake Run                                                         |
| 5    | 观察终端       | 无                                    | 出现 spawn、stdin、reasoning 摘要、tool_call、tool_result、assistant、close |
| 6    | 检查页面       | 无                                    | 计划显示 `摘要 · 根据事件整理`                                              |
| 7    | 检查事件       | 无                                    | 显示命令调用和 file_change 对应事件                                         |
| 8    | 检查最终输出   | 无                                    | 包含 `PHASE1_CODEX_DONE`                                                    |
| 9    | 检查运行信息   | 无                                    | 模型、版本、认证和沙箱中的未知项显示“未采集”                                |
| 10   | 检查搜索事实   | 无                                    | 搜索启用和实际搜索均为未知，不显示“否”                                      |
| 11   | 搜索页面文本   | `PHASE1_CODEX_REASONING_SUMMARY_ONLY` | 任务执行事件中不得出现该原始文本                                            |

通过条件：Codex JSONL 协议错误不会影响页面；未知元数据不被 Runtime 名称补齐。

截图：`phase1-gui05-codex-plan.png`、`phase1-gui05-codex-meta.png`。

### GUI-06 内置 Runtime 写入 Gate：批准

前置：

- 内置 Runtime 可用，且至少有一个支持文件读写工具的内置模型。
- 当前运行目录是 `$PHASE1_WORKSPACE`。

目标：验证 blocking Gate 真正暂停工具，而不是执行后补一条“已批准”。

| 步骤 | 操作                   | 输入                       | 逐项预期                                          |
| ---- | ---------------------- | -------------------------- | ------------------------------------------------- |
| 1    | 确认目标文件不存在     | `phase1-gate-approved.txt` | 文件不存在                                        |
| 2    | 新建任务               | 按 `builtin-gate-task.md`  | 责任人为 `P1-内置门禁员`                          |
| 3    | 勾选工具审批和工具事件 | 指定 Runtime 留空          | 使用内置执行                                      |
| 4    | 派发任务               | 无                         | 执行详情出现等待授权，写工具保持暂停              |
| 5    | 检查页面               | 无                         | Agent 执行计划下出现“等待执行授权”及批准/拒绝按钮 |
| 6    | 授权前检查文件         | 无                         | 目标文件仍不存在                                  |
| 7    | 点击“批准”             | 无                         | 状态提示消失；工具恢复执行                        |
| 8    | 检查执行事件           | 无                         | 有工具请求、Gate requested 和“执行授权已通过”     |
| 9    | 等待 Run 完成          | 无                         | 最终输出包含 `PHASE1_GATE_DONE`                   |
| 10   | 检查目标文件           | 无                         | 文件存在且内容为 `PHASE1_GATE_APPROVED`           |

无法触发文件写入工具时：

1. 记录为 `BLOCKED`，原因写“内置模型未调用可识别写工具或内置 Runtime 不可用”。
2. 不能把“Run 输出了一段文字”算作 Gate 用例通过。

截图：`phase1-gui06-gate-pending.png`、`phase1-gui06-gate-approved.png`、`phase1-gui06-file.png`。

### GUI-07 内置 Runtime 写入 Gate：拒绝和超时

目标：验证拒绝和超时都不会产生目标文件或假成功。

| 步骤 | 操作                    | 输入                                | 逐项预期                                       |
| ---- | ----------------------- | ----------------------------------- | ---------------------------------------------- |
| 1    | 新建第二个 Gate 任务    | 目标文件 `phase1-gate-rejected.txt` | 任务进入等待授权                               |
| 2    | 点击“拒绝”              | 无                                  | Gate=denied，工具得到拒绝原因                  |
| 3    | 检查文件                | 无                                  | `phase1-gate-rejected.txt` 不存在              |
| 4    | 检查事件                | 无                                  | 出现“执行授权已拒绝”，Run 不显示 100% 成功写入 |
| 5    | 新建第三个 Gate 任务    | 目标文件 `phase1-gate-timeout.txt`  | 等待授权                                       |
| 6    | 不操作，等待 Gate 超时  | 默认约 5 分钟                       | Gate=expired；状态不显示“已批准”               |
| 7    | 检查文件                | 无                                  | `phase1-gate-timeout.txt` 不存在               |
| 8    | 尝试再次批准已过期 Gate | 仅 API/排障                         | 返回状态冲突，不覆盖 expired                   |

超时用例预计至少 5 分钟。若本轮时间预算不足，可把 UI 超时标记 `NOT RUN`，但 CORE-06 的自动化超时测试必须通过。

截图：`phase1-gui07-gate-denied.png`、`phase1-gui07-gate-expired.png`。

### GUI-08 外部 Runtime observe-only 边界

目标：验证外部 Runtime 不提供 blocking Gate 时，平台不伪装成动作前阻断。

| 步骤 | 操作                           | 输入                              | 逐项预期                                                     |
| ---- | ------------------------------ | --------------------------------- | ------------------------------------------------------------ |
| 1    | 创建临时 AI 伙伴或修改测试实例 | 绑定 `P1-WorkBuddy-Write-Observe` | 执行方式为外部 Agent                                         |
| 2    | 新建任务                       | 要求调用写工具                    | 勾选需要人工确认                                             |
| 3    | 派发任务                       | 无                                | Runtime 仍可运行                                             |
| 4    | 观察页面                       | 无                                | 显示工具调用和工具结果观察事件                               |
| 5    | 检查是否出现“等待执行授权”     | 无                                | 不应出现可操作的 blocking Gate，因为 Adapter 是 observe-only |
| 6    | 检查边界提示                   | 无                                | 应出现“仅执行后观察”及“Runtime 不支持执行前阻断”的明确提示   |
| 7    | 检查工作区副作用               | 无                                | `phase1-external-write.txt` 已生成，证明动作在平台观察前发生 |
| 8    | 检查 Run 结果                  | 无                                | 只能表述“已观察到动作”，不能表述“已成功阻断”                 |

判定：

- 事件可见且没有伪造 Gate，算协议投影正确。
- 页面没有 observe-only 明示时，记录为 P1 产品缺陷；不能把静默无 Gate 判为通过。

截图：`phase1-gui08-observe-only.png`。

### GUI-09 退回反馈、负责人恢复和第二轮 Run

目标：验证待验收退回后，反馈不丢失，任务回到原提交 Agent，并立即重跑。

前置：GUI-03 的第一轮 Run 已进入待验收。

| 步骤 | 操作               | 输入                  | 逐项预期                                                                  |
| ---- | ------------------ | --------------------- | ------------------------------------------------------------------------- |
| 1    | 记录第一轮信息     | Run 1、输出、负责人   | 负责人为 `phase1-owner`                                                   |
| 2    | 点击“退回”         | 空说明                | 确认按钮 disabled，不能提交                                               |
| 3    | 粘贴反馈           | `review-feedback.txt` | 文本完整显示                                                              |
| 4    | 确认退回           | 无                    | 任务回到进行中；产生新 Run；负责人恢复为 `P1-调研分析员`                  |
| 5    | 查看任务动态       | 无                    | 出现“退回并补充说明”和“负责人恢复为 P1-调研分析员”                        |
| 6    | 查看第二轮指令     | 无                    | 包含 `PHASE1_FEEDBACK_ADD_COMPETITOR_COMPARISON`                          |
| 7    | 观察终端           | 无                    | 出现新的 Run ID 和第二次 WorkBuddy spawn                                  |
| 8    | 等待第二轮完成     | 无                    | 输出包含 `PHASE1_FEEDBACK_SEEN=PHASE1_FEEDBACK_ADD_COMPETITOR_COMPARISON` |
| 9    | 检查第二轮产出     | 无                    | 出现 `phase1-market-research-report-feedback.md`                          |
| 10   | 打开轮次选择器     | 无                    | 同时有第 1 轮和第 2 轮，最新轮默认选中                                    |
| 11   | 切换第 1 轮        | 无                    | 只显示第一轮指令、计划、事件、产出和快照                                  |
| 12   | 切换第 2 轮        | 无                    | 只显示第二轮内容和反馈版产出，不串轮次                                    |
| 13   | 检查第二轮完成状态 | 无                    | 再次进入待验收，负责人回到实例 owner                                      |
| 14   | 点击通过           | 无                    | 任务完成，反馈、两轮 Run 和产出都保留                                     |
| 15   | 刷新页面           | 无                    | 多轮信息仍可切换查看                                                      |

通过条件：

- 反馈在 Task message、第二轮 Prompt、第二轮输出三处都可追溯。
- 第一轮 Run 不被覆盖。
- 负责人切换时序正确：Agent 执行中为 Agent，待验收时回到 owner。

截图：`phase1-gui09-reject-dialog.png`、`phase1-gui09-round-two-running.png`、`phase1-gui09-feedback-seen.png`、`phase1-gui09-round-switch.png`。

### GUI-10 失败、刷新和响应式

目标：验证失败可见、刷新一致和页面布局没有遮挡。

| 步骤 | 操作                                               | 输入 | 逐项预期                                  |
| ---- | -------------------------------------------------- | ---- | ----------------------------------------- |
| 1    | 使用 `--scenario fail` 注册失败 fake 并派发任务    | 无   | Run=failed                                |
| 2    | 检查错误                                           | 无   | 显示 `PHASE1_EXPECTED_FAILURE` 或可读诊断 |
| 3    | 检查任务状态                                       | 无   | 不进入待验收，不标记完成                  |
| 4    | 使用 `--scenario cancel` 的 long-running fake 派发 | 无   | Run 保持运行，终端持续有 start/session    |
| 5    | 取消 Run                                           | 无   | Run=cancelled；后续无完成事件             |
| 6    | 刷新详情页                                         | 无   | 取消状态和已有事件仍可见                  |
| 7    | 在 1280px 检查详情                                 | 无   | 右侧执行区完整，Gate 按钮不遮挡事件       |
| 8    | 在 900px 检查详情                                  | 无   | 文本换行，轮次选择器和运行信息不溢出      |
| 9    | 在 390px 检查详情                                  | 无   | 主区可用；无横向页面溢出、无文字遮挡      |
| 10   | 打开 Console 和 Network                            | 无   | 无未捕获异常；失败请求与 UI 状态一致      |

截图：`phase1-gui10-failed.png`、`phase1-gui10-cancelled.png`、`phase1-gui10-1280.png`、`phase1-gui10-900.png`、`phase1-gui10-390.png`。

### GUI-11 归档与恢复

目标：验证执行历史和策略不因归档丢失，归档 Run 不再接受新派发。

| 步骤 | 操作               | 输入 | 逐项预期                          |
| ---- | ------------------ | ---- | --------------------------------- |
| 1    | 归档已完成任务     | 无   | 从默认看板隐藏；归档计数增加      |
| 2    | 打开归档视图查看   | 无   | 计划、事件、反馈和审批历史可查看  |
| 3    | 尝试发送新指令     | 无   | 被拒绝或入口只读                  |
| 4    | 复原任务           | 无   | 继续保留归档前状态；不自动重跑    |
| 5    | 归档外部 Runtime   | 无   | 默认列表隐藏；绑定 AI伙伴同步暂停 |
| 6    | 查看已归档 Runtime | 无   | 只提供“复原”，不能直接启用        |
| 7    | 复原 Runtime       | 无   | 状态变为“停用”，需人工再次启用    |

截图：`phase1-gui11-task-archived.png`、`phase1-gui11-runtime-archived.png`。

## 8. 证据要求

每个 GUI 用例至少保留：

1. 任务 ID、Run ID、Runtime ID、AI伙伴 ID。
2. 操作前、运行中、结束后的页面截图。
3. 终端 trace 片段，必须包含 Run ID。
4. 用 `browser-evidence-snippet.js` 采集的 Plan、events、gates、snapshot 关键字段。
5. Console 截图或文本。
6. Network 中失败请求的 URL、HTTP 状态和响应摘要。

建议目录：

```text
.tmp/phase1-gui-evidence/
  ids.md
  server.log
  screenshots/
  execution-<task-id>.json
  console-<case-id>.txt
  result-summary.md
```

## 9. 结果记录模板

```markdown
### <CASE-ID> <标题>

- 结果：PASS / FAIL / BLOCKED / NOT RUN
- 账号 / 项目 / WS_ID：
- Runtime 名称 / ID：
- AI伙伴名称 / ID：
- 任务 ID / Run ID：
- 操作步骤：
- 实际结果：
- 预期结果：
- 终端 trace：
- Plan / Snapshot：
- Console / Network：
- 截图：
- 缺陷编号：
```

## 10. 缺陷记录模板

```markdown
### BUG-PHASE1-YYYYMMDD-NN

- 标题：
- 严重级别：P0 / P1 / P2 / P3
- 前置用例：
- 环境：
- 复现步骤：
- 实际结果：
- 预期结果：
- 影响范围：
- 终端 / API / Console：
- 证据：
- 初步定位：
- 修复状态：
```

## 11. 通过和退出标准

本轮可以判定通过，必须满足：

1. CORE-01 到 CORE-10 全部 PASS；不能执行的自动化项必须说明环境阻断原因。
2. GUI-01、02、03、04、05、09、10 必须 PASS。
3. GUI-06 和 GUI-07 在内置模型可用时必须 PASS；若受模型能力限制，记录 BLOCKED，不能用外部 fake 代替。
4. GUI-08 至少证明没有伪造 blocking Gate；observe-only 文案缺失必须登记缺陷。
5. 搜索五层事实在页面和 API 中一致，`null` 不得显示成 false。
6. 退回反馈必须进入第二轮 Run，负责人恢复正确。
7. 没有未解释的 Console 异常、Network 静默失败、假成功或串轮次。
8. 没有 P0/P1 开放缺陷。P2 缺陷必须有明确规避方式和后续计划。

## 12. 已知测试限制

1. blocking Gate 依赖真实内置模型主动调用文件写入工具；模型没有调工具时应标记 BLOCKED，而不是平台失败或通过。
2. 外部 Runtime 当前没有通用 blocking Gate 协议，不能用 fake 事件证明平台能够阻断外部进程。
3. `searchUsed=null` 是合法终态，表示无法确认，不是功能缺失。
4. 测试 fake 只验证 Adapter、Plan、Event、Snapshot 和 UI 契约，不证明真实供应商的资料质量。
5. 真实的 Codex、WorkBuddy、DeepSeek 登录与限流应在独立供应商回归中执行，不在本阶段一功能闭环中混跑。

## 13. 2026-10-25 首轮执行发现

| 编号          | 现象                                                                     | 根因                                                                       | 修复与回归                                                                                      |
| ------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| PHASE1-BUG-01 | Agent 任务自动提交 Review 后从看板消失，刷新页面后才恢复                 | 新建任务后仍保留旧责任人过滤器，任务交接给实例 owner 后不再匹配            | 新建成功后使用创建人范围并清空接收人筛选；增加 client smoke 防回归                              |
| PHASE1-BUG-02 | WorkBuddy 原始 thinking 文本进入“执行过程”                               | Adapter 将 reasoning 原文拼入 progress 缓冲                                | 终端、进度和持久化事件统一改为“Runtime 报告了新的推理阶段”；单测断言原文不泄露                  |
| PHASE1-BUG-03 | 摘要计划在终态复述完整最终结果，页面显示原始英文枚举                     | `finalizeRun` 把 Run 输出写入 Plan summary；前端直接展示 `summary/derived` | 派生计划使用固定执行摘要；计划可见性和来源改为中文产品语言                                      |
| PHASE1-BUG-04 | 外部 Runtime 的 observe-only 边界在任务详情不可见                        | Run Snapshot 未保存 `gateEnforcement`，UI 无法解释为什么没有 Gate          | Snapshot 增加可选 `gateEnforcement`；运行信息增加“工具门禁”，observe-only 显示明确警告          |
| PHASE1-BUG-05 | 另一个任务生成的文件出现在调研任务“产出物”中                             | 已完成 Run 的文件窗口被无限延伸到当前时刻，且文档查询只按单任务窗口扫描    | 终态窗口限制为 settle 后 15 分钟，并用工作区内全部 Run 的最近窗口判定归属；增加跨任务防串台测试 |
| FIXTURE-01    | `PHASE1_FEEDBACK_SEEN` 被错误识别为反馈 token；Markdown 下划线被渲染吞掉 | fake runtime 正则会命中任务描述中的字段名；测试标记未使用 code span        | 正则排除 `SEEN` 字段；稳定标记改为 inline code                                                  |

本轮验证状态：

- PHASE1-BUG-01、02、03、04、05 已通过 GUI 复测或定向自动化测试。
- WorkBuddy 搜索、Codex JSONL、预检阻断、Review 退回和第二轮 feedback 已实际跑通。
- 任务归档/复原、Runtime 归档/复原、绑定 AI伙伴自动暂停与手动重启已通过 GUI 验证。
- 390px、900px、1280px 截图未发现文字遮挡或按钮重叠；窄屏看板按设计进入横向滚动。
- Console 仅有上游已知的 `SlotAssemblyError` boot-order 噪声，没有未捕获的 Pluginmax 业务异常。
- 内置 Runtime blocking Gate 因隔离环境未配置可用模型，GUI 场景标记 `BLOCKED`；Execution Gate 状态机由自动化测试覆盖。
