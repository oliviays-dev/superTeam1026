# 任务录入：Codex 执行轨迹

## 标题

`P1-Codex执行轨迹与摘要计划`

## 责任人

`P1-Codex记录员`

## 执行策略

- 允许公开网页与监管文件：不勾选
- 写文件、执行命令和外部发布前需要人工确认：不勾选
- 要求记录实际工具调用事件：勾选
- 指定 Runtime ID：绑定 `P1-Codex记录员` 的 `P1-Codex-Trace-Fake` Runtime ID

## 描述

验证 Codex JSONL Runtime 的生命周期摘要、命令工具事件、文件变更事件和最终输出映射。

最终文本必须包含 `PHASE1_CODEX_DONE` 与 `PHASE1_FEEDBACK_SEEN=<token>`。

## 验收标准

- 能展示 `summary · derived` 的 Agent 执行计划。
- 能展示命令调用、文件变更和最终消息对应的执行事件。
- 未采集到的模型与版本信息显示为“未采集”，不能猜测。
- 最终文本包含 `PHASE1_CODEX_DONE`。
