# V1 Batch 13 Phase 6: Release Gate

> 状态：通过，无遗留 P0/P1 缺陷
>
> 分支：`feat/v1-batch13-external-agent-runtime`
>
> 验收基线：`6c3a1ce46617f7fa10a5904b8e4e89a8beb553a4`
>
> Migration：23
>
> 日期：2026-10-26

## 1. 结论

Batch 13A-E 的 Runtime 管理、Adapter、Binding/Preflight、Worker 执行和 GUI 观测
通过发布门禁。Batch 8、9、10A、10B、11A、11B、12A、12B 的既有业务语义保持兼容。

本次只修复发布门禁中的过期门禁值、缺失回归覆盖和测试隔离问题，没有修改 Batch 13A-E
的协议、Binding 数据模型、Preflight 安全边界或外部 Runtime 执行协议。

## 2. 自动化结果

| 门禁 | 结果 |
| --- | --- |
| 13A-D 定向 PostgreSQL/Vitest | 9 个文件，50 个测试通过 |
| 完整 Vitest | 35 个文件，179 个测试通过 |
| 完整 Playwright | 16 个测试通过 |
| `pnpm check` | typecheck、lint、Vitest、build 全部通过 |
| `git diff --check` | 通过 |

完整 Vitest 与 `pnpm check` 均连接 `docker-compose.batch13.yml` 映射到
`127.0.0.1:54422` 的独立 PostgreSQL 数据库。门禁结束后临时数据库已删除。

## 3. Migration 兼容

`scripts/external-runtime-postgres-smoke.sh` 已扩展为三条路径：

- `0→23`：23 条 Migration、6 张 Runtime/Binding 表、Run 执行字段和默认 Agent 正确。
- `20→23`：保留旧 Agent、Task、Run、Trace、ContextPack、Meeting、Meeting Message、
  Direct Chat、Memory Topic/Claim/Truth 和 Project Template。
- `22→23`：保留现有 Runtime revision、active Binding、旧 Run 输出；旧 Run 的
  `execution_snapshot` 按 nullable 语义保持 `NULL`。

断言逐表检查内容与关联，不只检查表存在或行数。

## 4. 外部 Runtime 执行链路

四条链路均使用仓库内
`packages/agent-runtime/test-fixtures/external-cli.mjs`，不依赖真实模型凭证：

| 链路 | 协议 | 结果 |
| --- | --- | --- |
| Task | `codex-jsonl` | Run 完成，Task 进入 review，结构化事件与 Session 可读 |
| Workflow Task | `codex-jsonl` | 工作流自动派发的 Task/Run 完成并进入 review |
| Meeting AI | `codex-jsonl` | Meeting AI Turn 完成并回写 Meeting |
| Direct Chat | `plain-text` | final-only 回复完成并回写私聊 |

定向套件同时覆盖取消、取消生效、超时、非零退出、spawn marker 阻止重放、Preflight
失败和契约/权限门禁。

## 5. 兼容矩阵

| 历史批次 | 兼容证据 |
| --- | --- |
| Batch 8 | runtime reliability、maintenance/effect、运维 GUI 用例通过 |
| Batch 9 | trace/readiness/backup 相关 Repository 与 API 测试通过 |
| Batch 10A | meeting decisions API 与浏览器用例通过 |
| Batch 10B | memory closure、Handoff、Episode API 与浏览器用例通过 |
| Batch 11A | workbench reports API 与浏览器用例通过 |
| Batch 11B | project templates API、Vitest 与浏览器用例通过 |
| Batch 12A | meeting AI participation API、Worker 与浏览器用例通过 |
| Batch 12B | AI direct chat API、Worker 与 390px 浏览器用例通过 |

Fake、DSH SDK 和外部 Runtime 的混用没有改变既有派发、Run 结算或业务回写语义。

## 6. GUI 与安全边界

完整 Playwright 在 1440px、900px 和 390px 验证外部 Runtime 管理、AI 伙伴绑定和
Run 详情。`.app-stage` 溢出断言通过，截图抽查未发现文字遮挡或关键操作不可用。

主要截图：

- `.tmp/batch13e-agent-binding-1793020029602.png`
- `.tmp/batch13e-agent-binding-900-1793020029602.png`
- `.tmp/batch13e-agent-binding-390-1793020029602.png`
- `.tmp/batch13e-run-plain-1793020038077.png`
- `.tmp/batch13e-run-codex-1793020038077.png`
- `.tmp/batch13e-run-codex-900-1793020038077.png`
- `.tmp/batch13e-run-codex-390-1793020038077.png`
- `.tmp/batch13e-runtime-probe-failed-1793020029602.png`
- `.tmp/screenshots/batch8/operations-desktop.png`
- `.tmp/screenshots/batch8/operations-mobile.png`

安全边界保持：

- API/Application 不启动外部进程，Worker 持有 Job、Run 和进程生命周期。
- `spawn(command, argv, { shell: false })`；拒绝 shell 拼接和非法 argv。
- 默认 `read-only` sandbox、受控 Workspace Root 和能力上限。
- reasoning 正文不持久化；Provider Session 只作诊断。
- 不实现 Provider Session resume，不开放危险 sandbox 或任意 shell。

## 7. 门禁修复

1. API readiness 的默认期望 Migration 从过期的 22 更新为 23。
2. Batch 9 trace 测试的 Migration 上限从 20 更新为 23。
3. Batch 11B、Batch 8 和 Batch 3B Playwright 中过期或歧义的界面断言已更新。
4. 新增 Workflow Task 外部 Runtime 执行回归。
5. Migration smoke 从 `20→21` 单项扩展为 `0→23`、`20→23`、`22→23` 完整数据断言。
6. Playwright 失败产物和 Batch 8 截图目录移入 worktree `.tmp`。

## 8. 已知限制

- 不自动 resume 外部 Provider Session，也不在 Worker 崩溃后重放已启动进程。
- 不支持远程 Daemon、容器编排、MCP 配置注入或任意 shell。
- `x-pluginmax-actor` 仍不是正式认证；生产认证不在 Batch 13 范围内。
- 构建存在已有的 chunk size、tsdown sourcemap 和 `deps.external` deprecation warning，
  不影响本批门禁。
- 仓库当前未配置 Git remote，因此未执行 push。

## 9. 隔离与清理

- `DSH_HOME=/Users/oliviayang/Codex/一切皆插件/.tmp/dsh-home-batch13`，未清空。
- File store、Agent workspace、日志、trace 和截图均位于当前 worktree `.tmp`。
- 未修改正式 Profile、正式数据库、Session、历史批次 worktree 或原
  `dsh-pluginmax`。
- API、Web、Worker 测试进程和临时 PostgreSQL 数据库在门禁后清理。
