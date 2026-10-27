# V1 Batch 13.1A：Runtime 兼容承诺收口

> 状态：已完成
>
> 基线 worktree：`.tmp/pluginmax-platform-batch16-scene-context`
>
> 基线分支：`feat/v1-batch16-scene-context`
>
> 基线 HEAD：`b638479cc5d9be8a7abb78689d3fa7b9d0a64fa1`
>
> 工作 worktree：`.tmp/pluginmax-platform-batch13.1a-runtime-compatibility`
>
> 工作分支：`feat/v1-batch13.1a-runtime-compatibility`

## 1. 决策

WorkBuddy 在 V1 中只通过通用 `plain-text` 外部 Runtime 接入，不实现专用
WorkBuddy/CodeBuddy Parser 或 Adapter。

这意味着：

- `provider = workbuddy` 只表达产品来源和运行元数据，不改变执行协议；
- 完整 Prompt 通过 stdin 以 UTF-8 传给子进程；
- 子进程最后输出的 stdout 是最终文本；
- stderr 只作为 warning 或失败诊断；
- `--print`、`--output-format text`、`--max-turns` 等参数由 Runtime Owner 按 CLI
  版本在注册参数中显式提供，平台不自动追加；
- 平台不解析 `stream-json`，不伪造 plan/tool 事件，不读取 Provider Session；
- 平台不把 WorkBuddy 的产品名或 Prompt 自述当作模型、Provider、版本或认证事实；
- Provider Session resume、结构化工具事件和 Token/成本统计不在本批范围。

Token、成本、时长统计和 Workspace Runtime 可见范围统一由 Batch 13.1B 收口，并在
Batch 17B 前完成。

## 2. 现行契约

```text
spawn(command, registeredArgs, {
  cwd: isolatedWorkspace,
  shell: false,
  stdio: ["pipe", "pipe", "pipe"],
})

stdin:  UTF-8 complete prompt
stdout: UTF-8 final text
stderr: diagnostics
exit 0 + non-empty stdout: completed
exit 0 + empty stdout: failed
exit non-zero: failed
SIGTERM / AbortSignal: cancelled
```

Adapter 能力固定为：

- `planVisibility = opaque`
- `toolEventCompleteness = none`
- `textStreaming = final-only`
- structured plan/tool events 为 `unsupported`
- session resume 为 `unknown`，且当前不 resume

Prompt 不作为位置参数注入。终端里直接运行 WorkBuddy 的连通性命令可以使用位置参数，
但那是 CLI 自身的诊断方式，不是平台派发契约。

## 3. 兼容矩阵

| 能力 | V1 结论 | 说明 |
| --- | --- | --- |
| WorkBuddy Provider | 支持 | 仅允许 `plain-text`；`codex-jsonl` 被 Contracts 拒绝 |
| stdin Prompt | 支持 | 每轮发送完整 UTF-8 Prompt |
| stdout 最终文本 | 支持 | 空 stdout 按失败处理 |
| stderr 诊断 | 支持 | 成功时有 warning，失败时进入错误信息 |
| 取消与超时 | 支持 | 复用受控进程组终止 |
| 自定义 CLI 参数 | 支持 | Owner 显式登记，平台不改写 |
| 自动追加 `--print` | 不支持 | 必须显式登记 |
| 自动追加 `--output-format` | 不支持 | 推荐显式登记 `text` |
| `stream-json` 解析 | 非目标 | 当前没有 WorkBuddy 专用事件协议承诺 |
| reasoning/tool 结构化事件 | 非目标 | 不把 stdout 猜成 JSONL |
| Provider Session 读取/resume | 非目标 | 一次性无状态进程 |
| 模型/版本/认证自动探测 | 非目标 | 只保存可验证快照，未知即为 `unknown` |
| Token/成本/时长统计 | 延后 13.1B | 不阻塞 17A 的执行语义 |
| Workspace Runtime 可见性 | 延后 13.1B | 不属于 Provider 协议收口 |

## 4. 文档纠偏

- `docs/gui-test-plan-external-agent-teammates.md` 的现行 WorkBuddy 契约改为
  stdin Prompt，并明确平台不自动追加协议参数。
- 阶段一 `stream-json` 夹具和测试设计标记为历史材料，不再代表 V1 现行协议。
- 旧 DSH 插件设计保留为历史实现事实，不能作为 Platform V1 能力证据。
- `docs/v1-external-agent-runtime-technical-design.md` 中的通用 `plain-text`
  契约保持不变。

## 5. 验证

- Contracts：WorkBuddy 只接受 `plain-text`，能力投影不承诺结构化事件。
- Adapter：WorkBuddy 标签不改写 argv，完整 Prompt 仍通过 stdin，输出仍为 final-only。
- 定向 Vitest：2 files / 23 tests 通过。
- 完整 Vitest（独立 PostgreSQL `127.0.0.1:54429`）：51 files / 247 tests 通过。
- 分包 typecheck、oxlint、packages/API/Worker 构建和 Web production build 通过。
- `git diff --check` 与 Prettier 检查通过。
- Playwright 未重跑：本批没有修改 API、Web 或 Worker 产品行为，也没有数据库迁移；
  只冻结 Runtime 契约并修正文档/测试。真实 GUI 行为的后续验证仍由 17A 发布门禁覆盖。
- 不依赖真实 WorkBuddy 凭证；真实 CLI 的历史证据只用于证明通用协议可接入，CI
  回归使用 worktree 内 fixture。

## 6. Migration 与回滚

本批没有数据库结构或数据变更，不新增 Migration。

回滚只需 revert 本批提交。文档、fixture 和测试变更不产生运行时数据，也不影响历史
Run、Ticket、Gate、Scene Session 或 Receipt。

## 7. 边界

本批完成 Runtime 兼容承诺收口，不包含：

- Batch 17A Task Execution Depth；
- Batch 13.1B Runtime 经济与可见性；
- Batch 17B AI Teammate；
- Shared Space、sandbox、Lane 级路径写权限或 Global Write；
- WorkBuddy 专用 JSONL、Session resume 或工具流解析。
