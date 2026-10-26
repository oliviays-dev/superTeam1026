# V1 Batch 13B: External Runtime Adapter Core

> 状态：已实现
>
> 分支：`feat/v1-batch13-external-agent-runtime`
>
> 基线：`4bc721dc3c205314b687f7c7e834096101c55966`

## 交付范围

- `@pluginmax/agent-runtime` 新增受控外部进程 Runner、Codex JSONL Adapter 和
  plain-text Adapter。
- 进程使用 `spawn(command, argv, { shell: false })` 启动，命令与参数分离。
- stdin 写入完整 UTF-8 Prompt；stdout/stderr 分别按字节上限采集，超限只保留
  截断内容并标记 `stdoutTruncated` / `stderrTruncated`。
- AbortSignal 与 Adapter 超时共用终止路径。POSIX 下先向独立进程组发送
  SIGTERM，宽限期后发送 SIGKILL；Windows 下退回直接子进程终止。
- Runner 只继承受限环境变量白名单；不接收 shell 字符串，也不执行 shell 展开。
- Codex JSONL 归一化 assistant 文本、progress、tool call/result、warning 和
  error；reasoning 只产生固定阶段摘要，不保存或暴露正文。
- Codex 诊断包含 Provider Session、模型、版本、认证模式和 sandbox；进程退出
  信息、耗时和截断状态进入执行诊断。
- plain-text 是 final-only：stdout 为最终文本，stderr 只生成受限 warning 或失败
  诊断；不生成 plan 或 tool 事件。
- 空最终输出、非零退出、外部 signal、坏 JSONL 和必要的 stdout 截断均失败。

## 明确未包含

- Agent Runtime Binding、Preflight 和 Runtime 管理 API 扩展。
- `RunExecutor` 外部 Adapter 派发、Worker 外部 Job 生命周期和业务回写。
- Provider Session resume、真实 Codex 登录探测和模型凭证依赖。
- Task、Meeting、Direct Chat 或 Run 状态写入。

因此任务派发中的 `codex-jsonl` 和 `plain-text` 仍返回
`runtime_adapter_unavailable`。本批只完成可独立测试的 Adapter Core。

## 测试

- 受控 argv：特殊字符 token 原样传递，不触发 shell 展开。
- Codex JSONL：正常、warning、provider error、tool、非零退出、空输出、坏 JSON、
  输出截断、取消和超时。
- plain-text：UTF-8 原始 stdin、正常 stdout、stderr、空 stdout、非零退出、
  signal、取消、超时和输出截断。
- 进程事实：退出码、signal、duration、stdout/stderr 字节数、截断和 Session
  元数据。
- Fake CLI 是 worktree 内的 Node 脚本，不依赖真实模型凭证。

## 已知限制

- Codex JSONL 解析按当前稳定事件形状做容错归一化；Provider 协议变化仍需新增
  夹具并更新解析器。
- 最终文本取最后一条非空 assistant message；尚未接入
  `--output-last-message` 文件链和 Codex session 文件补读。
- Windows 只保证直接子进程终止；POSIX 进程组终止是本批主要验证路径。
- 本批不持久化事件、不创建 Run、不自动重试，也不实现 kill 后的业务结算。
