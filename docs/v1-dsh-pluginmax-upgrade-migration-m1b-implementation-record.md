# dsh-pluginmax 升级迁移 M1b 实施记录

> 阶段：M1b Agent Task Tools、Run 隔离工作区、Execution Envelope / Gate 接入
> 日期：2026-11-13
> 仓库：`pluginmax-platform`
> 实施基线：`main@5b7f7f5bc179ca0435c96126a950e7b3605847f4`
> 只读备份：`/Users/oliviayang/Codex/backups/dsh-migration-preflight-20261113-105957`

## 1. 实施前保护记录

### 1.1 备份校验

在只读备份目录执行：

```sh
LC_ALL=C LANG=C shasum -a 256 -c SHA256SUMS
```

结果：`SHA256SUMS` 中全部 36 个校验项均为 `OK`。本轮未修改备份目录。

### 1.2 Git 基线

```text
branch: main
HEAD:   5b7f7f5bc179ca0435c96126a950e7b3605847f4
```

开始实施时工作树已有大量用户未提交修改和未跟踪文件。本轮未执行
`git reset --hard`、`git checkout --`、`git clean` 或未跟踪文件清理。

## 2. 完成范围

本轮新增：

- 受控 `AgentTaskToolFacade`。
- `task_query`、`task_submit_deliverable`、`task_request_input`、`task_comment`。
- `read_file`、`write_file`、`list_files`。
- Run 级隔离工作区。
- 每动作 Ticket / Gate 验证与 Gate 单次消费账本。
- Tool Invocation 幂等记录和 Run Event 审计投影。
- 默认关闭的 M1b Feature Flags。
- Migration 37。

本轮未实施 M2、M3、M4-M8，也未修改外部 `dsh-pluginmax` 仓库。

## 3. Contract

新增 `packages/contracts/src/agent-task-tools.ts`：

- `AgentTaskToolName`
- `AgentTaskToolCategory`
- `AgentToolRuntimeProof`
- 严格 Tool request / payload schema
- `AgentToolWorkspaceLimits`
- `ToolInvocationRecord`
- `AgentTaskToolExecutionResult`
- `AGENT_TASK_TOOLS_FLAG = "agent.task_tools"`
- `AGENT_WORKSPACE_FILES_FLAG = "agent.workspace_files"`

模型可见 payload 使用 strict schema，不接受 `userId`、`projectId`、`runId`、
`actor` 或任意 resource scope。Run、Run Attempt、Scene Session 和 Agent
Principal 通过单独的 server-owned runtime proof 输入，并由 Facade 从数据库反查。

## 4. Migration 37

文件：`packages/database/src/schema.ts`、`packages/database/src/migrate.ts`

新增表：

```text
tool_invocations
```

关键约束：

- `UNIQUE(run_id, idempotency_key)`
- `UNIQUE(gate_id)`
- `gate_id` / `ticket_id` 可空，仅用于记录失败前的拒绝事实
- `request_digest` 绑定幂等键与实际参数
- `status IN ('started', 'succeeded', 'failed')`
- 不保存读取文件正文

新增默认 Flag：

```text
agent.task_tools=off
agent.workspace_files=off
```

Migration 37 是纯 additive migration，不修改现有 Task、Run、Ticket 或 Review 表。

## 5. Application / Tool Facade

新增 `packages/application/src/agent-task-tools.ts`。

每次调用按以下顺序执行：

1. 严格解析 server-owned runtime proof 和 Tool payload。
2. 从 Run 读取当前 `attempt`，必须与 proof 一致。
3. 要求当前 `RunExecutionEnvelope` 存在。
4. 从 Envelope 取 `agentPrincipalId`，不接受模型自报。
5. 从 Run 精确反查 Scene Session，要求 Scene、Agent 和 Agent Principal 一致。
6. 从 Run 派生 Task、Project、Workspace 和 Ticket。
7. 重新读取 Feature Flag，关闭时不产生新副作用。
8. 重新读取并验证当次 Action Ticket。
9. 重新读取并验证当次 Execution Gate，要求 blocking + approved。
10. 通过 Tool Invocation 账本消费 Gate，同一 Gate 只能授权一个动作。
11. 执行动作并写入不含敏感正文的 Run Event。

Gate 不缓存。denied、expired、cancelled、cross-Run、cross-Task 或
cross-resource 均默认拒绝。

## 6. 文件沙箱

新增 `packages/files/src/workspace-sandbox.ts`。

限制：

- 仅接受相对路径。
- 拒绝绝对路径、盘符路径、`..`、NUL、反斜杠、空段、`.` 中间段和控制字符。
- 逐级 `lstat`，任意一级符号链接均拒绝。
- 最终读取使用 `O_NOFOLLOW`。
- 读、写、列表深度、列表条目数和列表输出字节数均有限制。
- 写入使用同目录临时文件、`fsync` 和原子 `rename`。
- 写入临时文件使用 `O_CREAT | O_EXCL | O_NOFOLLOW` 和 `0600` 权限。

RunExecutor 工作区从项目级路径调整为：

```text
<workspaceRoot>/runs/<runId>
```

## 7. API

新增只读审计路由：

```http
GET /api/v1/runs/:runId/tool-invocations
```

未新增公网 Tool 执行路由。Tool Facade 只作为 Worker/Application 内部受控入口，
避免把 Run、Attempt 或 Actor 身份暴露为模型可自报的 HTTP 参数。

## 8. Feature Flags

| Flag | 默认 | 行为 |
| --- | --- | --- |
| `agent.task_tools` | off | 关闭时拒绝全部 Task Tools，包括只读查询 |
| `agent.workspace_files` | off | 关闭时拒绝全部工作区文件工具 |

Flag 每次调用从数据库读取。关闭后新调用在 Ticket/Gate 消费之前被拒绝。

## 9. 测试与门禁结果

已执行：

```text
pnpm typecheck  pass
pnpm lint       pass
pnpm build      pass
pnpm test       pass（无数据库模式下）
```

全仓 Vitest 结果：

```text
Test Files  37 passed | 39 skipped (76)
Tests       190 passed | 170 skipped (360)
```

该全仓命令未设置 `TEST_DATABASE_URL`，因此 PostgreSQL 集成文件被跳过。随后通过
本地 Colima Docker 实际补跑：

```text
./scripts/agent-task-tools-vitest.sh   pass
Test Files 3 passed
Tests      20 passed
```

该脚本覆盖 M1b Facade、文件沙箱和 M1a G1-G8 聚焦集成测试。

```text
./scripts/m1b-migration-vitest.sh      pass
fresh_migration=0->37
upgrade_migration=36->37
old_app_read=["Required item"]|review
old_app_review=return|local-admin
```

```text
./scripts/m1a-migration-vitest.sh      pass
fresh_migration=0->37
upgrade_migration=34->37
acceptance_items=2
acceptance_revisions=2
constraint_conflicts=0
```

Teammates 数据库集成已实际重跑，既有失败仍存在：

```text
./scripts/teammate-vitest.sh            fail
apps/api/src/teammates.test.ts:442
expected statistics.runCount=1, received 0
```

本轮未修改 Teammates 周报日期相关代码，也没有将该既有失败声明为已修复。

可在无数据库模式下实际执行的聚焦测试：

```text
packages/application/src/agent-task-tools.test.ts  pass
packages/files/src/workspace-sandbox.test.ts       pass
合计                                                11/11 pass
```

覆盖：

- 模型伪造 actor/projectId/runId。
- Run Attempt、Scene Session 与 Agent Principal 不匹配。
- 缺少 Execution Envelope、Ticket 或 Gate。
- 跨 Run、跨 Task Gate 与 Ticket scope。
- Gate denied、expired、cancelled。
- Feature Flag 关闭。
- 绝对路径、`..`、NUL、反斜杠、符号链接。
- 读写、列表深度、条目数和输出字节上限。
- 写入原子替换和失败前原内容保持。
- Tool Event 不记录文件正文。

## 10. 剩余风险与进入下一阶段条件

进入 M2 前仍需：

1. 修复或明确豁免既有 Teammates 周报日期/归属统计夹具失败。
2. 决定是否将 Task Tool invoke 接入具体 Runtime 双向 Tool RPC；当前只提供
   受控 Application Facade，不新增公网执行入口。
