# 阶段一测试资料

> **历史范围说明**：本目录只保留旧插件阶段一的测试夹具。`WorkBuddy
> stream-json` 夹具不代表 Platform V1 现行协议，也不要注册为 V1
> `plain-text` Runtime 的推荐样例。V1 的通用外部 Agent 夹具位于
> `docs/fixtures/external-agent/`，契约见
> [v1-batch13.1a-runtime-compatibility.md](../../v1-batch13.1a-runtime-compatibility.md)。

本目录服务于 [阶段一 Runtime Agent Execution Plan 测试设计](../../phase1-agent-execution-plan-test-design.md)。

## 文件清单

| 文件                                  | 用途                                                          | 进入系统的方式                             |
| ------------------------------------- | ------------------------------------------------------------- | ------------------------------------------ |
| `market-research-task.md`             | WorkBuddy 外部 Runtime 的搜索、策略、执行事件和退回反馈测试   | 在任务创建/编辑表单中按字段录入            |
| `codex-trace-task.md`                 | Codex JSONL 的摘要计划、工具事件和未知元数据测试              | 在任务创建/编辑表单中按字段录入            |
| `builtin-gate-task.md`                | 内置 Runtime 的 blocking Gate 测试                            | 在任务创建/编辑表单中按字段录入            |
| `review-feedback.txt`                 | Review 退回后第二轮上下文与负责人恢复                         | 粘贴到退回说明弹窗                         |
| `research-agent-soul.md`              | 调研 AI 伙伴的 SOUL，仅包含角色与工作原则                     | 粘贴到定义态模版的 `SOUL.md`               |
| `codex-trace-agent-soul.md`           | Codex 记录员 SOUL                                             | 粘贴到定义态模版的 `SOUL.md`               |
| `builtin-gate-agent-soul.md`          | 内置门禁员 SOUL                                               | 粘贴到定义态模版的 `SOUL.md`               |
| `browser-evidence-snippet.js`         | 从浏览器 Console 读取 Task Execution Projection               | 替换 `<TASK_ID>` 后在页面 Console 执行     |
| `research-execution-policy.json`      | 公开来源研究策略的完整契约样本                                | API 集成或排障；GUI 按字段勾选             |
| `tool-approval-execution-policy.json` | 写文件审批策略的完整契约样本                                  | API 集成或排障；GUI 按字段勾选             |
| `workbuddy-stream-fake.mjs`           | 历史 WorkBuddy stream-json、搜索/写入工具事件与会话元数据夹具 | 仅用于复现旧插件阶段一，不代表 V1 协议 |
| `codex-trace-fake.mjs`                | 稳定输出 Codex JSONL 工具事件和最终消息                       | 注册为 Provider `Codex` 的外部 Runtime     |

## Fake Runtime 预检

在仓库根目录执行：

```sh
printf 'PHASE1_PREFLIGHT' \
  | node docs/fixtures/phase1/workbuddy-stream-fake.mjs \
      --scenario search \
      --search \
      --phase1-session phase1-preflight \
      --output-format stream-json
```

预期 stdout 是逐行 JSON，包含：

```text
PHASE1_VISIBLE_PROGRESS
web_search
PHASE1_SEARCH_RESULT
PHASE1_RESEARCH_DONE
PHASE1_SOURCE_POLICY_SEEN=NO
```

使用研究任务完整 Prompt 时，`PHASE1_SOURCE_POLICY_SEEN` 应为 `YES`。

Codex fake 预检：

```sh
printf 'PHASE1_PREFLIGHT' \
  | node docs/fixtures/phase1/codex-trace-fake.mjs \
      exec --json --cd "$PWD/.tmp/phase1-gui-workspace" \
      --sandbox read-only \
      --output-last-message /tmp/phase1-codex-last-message.md -
cat /tmp/phase1-codex-last-message.md
```

预期 stdout 包含 `PHASE1_CODEX_VISIBLE_PROGRESS`，最终文件包含 `PHASE1_CODEX_DONE`。

## Runtime 参数

WorkBuddy 搜索运行时：

| 字段           | 值                                                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Provider       | WorkBuddy                                                                                                                            |
| 协议           | 通用 stdin/stdout                                                                                                                    |
| 命令           | node                                                                                                                                 |
| 模型来源       | 沿用 CLI 默认模型                                                                                                                    |
| 最大上下文窗口 | 128000                                                                                                                               |
| 搜索参数       | 开启                                                                                                                                 |
| 文件修改权限   | 默认权限                                                                                                                             |
| 最大执行回合   | 留空                                                                                                                                 |
| 额外参数       | `<REPO>/docs/fixtures/phase1/workbuddy-stream-fake.mjs --scenario search --slow --phase1-session phase1-research-gui --write-report` |

WorkBuddy 写入观察运行时：

| 字段           | 值                                                                                                                      |
| -------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Provider       | WorkBuddy                                                                                                               |
| 协议           | 通用 stdin/stdout                                                                                                       |
| 命令           | node                                                                                                                    |
| 模型来源       | 沿用 CLI 默认模型                                                                                                       |
| 最大上下文窗口 | 128000                                                                                                                  |
| 搜索参数       | 关闭                                                                                                                    |
| 文件修改权限   | 默认权限                                                                                                                |
| 最大执行回合   | 留空                                                                                                                    |
| 额外参数       | `<REPO>/docs/fixtures/phase1/workbuddy-stream-fake.mjs --scenario write --phase1-session phase1-write-gui --write-file` |

Codex 轨迹运行时：

| 字段           | 值                                                 |
| -------------- | -------------------------------------------------- |
| Provider       | Codex                                              |
| 协议           | Codex JSONL                                        |
| 命令           | node                                               |
| 模型来源       | 沿用 CLI 默认模型                                  |
| 最大上下文窗口 | 128000                                             |
| 搜索参数       | 关闭                                               |
| 执行沙箱       | 只读 / 网络受限                                    |
| 额外参数       | `<REPO>/docs/fixtures/phase1/codex-trace-fake.mjs` |

`<REPO>` 必须替换为：

```text
/Users/oliviayang/Codex/一切皆插件/dsh-pluginmax
```

上述参数说明属于旧插件阶段一。Platform V1 不会为 WorkBuddy 自动追加
`--print`、`--output-format` 或其他协议参数，也不解析 `stream-json`；如复用真实
CLI，必须在 V1 Runtime 注册参数中显式填写经过验证的 `--print` 与
`--output-format text`。

`--write-report` 会让搜索场景在当前工作区生成 `phase1-market-research-report.md`；带 `PHASE1_FEEDBACK_*` 的第二轮生成 `phase1-market-research-report-feedback.md`。`--write-file` 会让写入观察场景生成 `phase1-external-write.txt`。
