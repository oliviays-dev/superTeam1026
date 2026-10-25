# V1 批次 5：工作流运行时

> 状态：已实现

## 1. 范围

批次 5 把 V1 的线性步骤工作流升级为可审计的图运行时：

- 确定性条件分支、默认分支和分支选择记录。
- 审批节点、用户/角色审批人、待审批状态、全部/任一策略和拒绝行为。
- 有 break 条件且有明确 loop-limit 的受控循环。
- 父子流程实例、状态传播、失败传播和调用链循环校验。
- Run 超时、节点重试、幂等启动/命令、暂停与恢复。
- 节点状态、分支、审批、重试和失败原因的不可变审计。
- 与项目成员、项目角色、Task、Artifact、人工验收门禁和 Fake Runtime 集成。

不包含真实模型 E2E、外部 Agent 容器沙箱或正式 Profile 修改。

## 2. 执行模型

`workflow_definitions.graph` 保存版本化图定义。启动实例时复制运行态到
`workflow_instances.runtime_nodes/runtime_edges/runtime_context`，因此后续定义升级不会
改变已启动实例。

状态推进由纯函数完成：

1. 起始节点进入 `ready`。
2. 判断节点自动执行安全表达式解释器，只选择一个条件分支或默认分支。
3. 普通并行分支可同时激活多个目标；汇合节点等待全部入边完成判断。
4. 审批节点初始化审批人和待审批记录，拒绝时优先匹配 rejected 边，否则阻塞。
5. 回边在 `break-condition` 成立或达到 `loop-limit` 时阻塞，否则重新激活循环路径。
6. 子流程节点保持 `running`，父实例在 reconcile 时消费子实例终态。
7. Agent 节点通过 Task → Run → Artifact → Task Review 的门禁闭环推进。

表达式解释器不调用 `eval`，支持标量、比较、布尔运算、括号和点分变量名。未知变量和
非法类型均返回稳定错误并进入运行审计。

## 3. 数据迁移

Migration 10 只新增表、索引和带默认值的实例/Run 元数据：

- `workflow_instances`：定义 key/version、父实例关系、运行态、失败原因、暂停时间、
  revision 和启动幂等键。
- `workflow_approvals`：审批人、轮次、状态、意见和操作人。
- `workflow_audit_events`：按实例递增的不可变审计事件。
- `workflow_command_receipts`：审批、暂停、恢复、重试等命令的幂等回执。
- `runs`：attempt、timeout、幂等键、工作流实例/节点关联。

旧实例的 `steps` 原样保留。API 读取 runtime 数组为空的旧实例时，会依据 `graph` 和
`steps` 合成兼容节点状态；旧定义缺失图时，会在首次启动时生成线性兼容图。

回滚时应先停止 API/Worker，再恢复批次 5 之前的数据库备份；新增列和表不要求删除即可
让旧代码继续读取原列，但旧代码不会解释新的图运行态。

## 4. API

```text
POST /api/v1/workflows/:workflowId/start
GET  /api/v1/workflow-instances?projectId=
GET  /api/v1/workflow-instances/:instanceId
GET  /api/v1/workflow-instances/:instanceId/detail
POST /api/v1/workflow-instances/:instanceId/nodes/complete
POST /api/v1/workflow-instances/:instanceId/approvals
POST /api/v1/workflow-instances/:instanceId/pause
POST /api/v1/workflow-instances/:instanceId/resume
POST /api/v1/workflow-instances/:instanceId/retry
POST /api/v1/workflow-instances/:instanceId/reconcile
```

写接口支持 `Idempotency-Key`。开发环境通过 `x-pluginmax-actor` 注入本地操作者，
默认 `local-admin`。服务端仍以项目成员、项目角色和审批人记录进行授权，不接受客户端
提交审批人字段。

## 5. 验证

```sh
pnpm check
pnpm test:smoke:workflow-runtime
pnpm test:smoke:workflow-postgres
pnpm test:e2e:browser
```

`workflow-runtime-smoke.sh` 覆盖条件分支、角色审批、越权审批、暂停恢复、拒绝阻塞、
循环上限、非法循环、父子流程、子流程失败传播、循环调用、超时恢复、重复重试、
重试上限和幂等启动。`workflow-postgres-smoke.sh` 直接验证 migration 10 和旧实例读取。

## 6. 已知边界

- 超时传播依赖 Run 自身 timeout 与 `reconcile` 调用；当前没有独立定时调度服务。
- `reconcile` 是显式/界面触发，后续可增加低频后台 sweep，但不改变状态机契约。
- 审批仅支持通过/拒绝；转交和加签仍由后续批次扩展。
- 所有模型相关验证使用确定性 Fake Runtime。
