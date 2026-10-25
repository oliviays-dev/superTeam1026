# 任务录入：内置 Runtime 写入门禁

## 标题

`P1-内置Runtime文件写入门禁`

## 责任人

`P1-内置门禁员`（内置执行）

## 执行策略

- 允许公开网页与监管文件：不勾选
- 写文件、执行命令和外部发布前需要人工确认：勾选
- 要求记录实际工具调用事件：勾选
- 指定 Runtime ID：留空

## 描述

使用文件写入工具在当前项目工作区创建 `phase1-gate-approved.txt`，文件内容必须为 `PHASE1_GATE_APPROVED`。在工具执行前等待人工批准；批准后完成写入，并输出 `PHASE1_GATE_DONE`。

## 验收标准

- 任务详情出现 `等待执行授权`，且在批准前不得生成目标文件。
- 点击 `批准` 后生成 `phase1-gate-approved.txt`，内容为 `PHASE1_GATE_APPROVED`。
- 执行事件出现工具调用与授权通过记录。
- 最终输出包含 `PHASE1_GATE_DONE`。
- 拒绝场景不得生成文件；超时场景 Gate 状态为 `expired`，Run 不得假成功。
