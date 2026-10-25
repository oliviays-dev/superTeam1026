# 工作流技术设计

## 1. 总体结构

新增独立插件：

```text
plugins/dsh-collab-workflow/
  client/index.js
  src/index.ts
  src/index.test.ts
  cordis.patch.yml
```

插件只依赖 `@pluginmax/shared` 与 `zod`。通过 Cordis 注入：

- `storageDomain`：持久化；
- `collabTeam`：浏览器身份和工作区成员校验；
- `webServer`：HTTP API；
- `commands` / `tools`：Agent 只读与节点操作入口；
- `settings.section` / `conversation.view`：客户端 UI。

除平台宿主能力外，工作流插件只把 `collabAgent`、`collabEmployee` 和 `collabTasks` 作为可选增强。Agent / Digital Employee 缺席时，节点仍可由责任人人工提交或管理员兜底；Task 模块缺席时，工作流必须用自己的节点状态、事件和 API 完成审批、交付、推进、取消和审计。

不修改上游 `deepseek-harness`，不 patch 既有插件内部模块。

## 2. 数据域

```yaml
name: collab_workflow
version: 1
tables: definitions
  instances
  events
```

记录主键使用 UUID；记录中保留 `workspaceId`。

### WorkflowDefinition

```ts
{
  id: string;
  workspaceId: string;
  key: string;
  version: number;
  name: string;
  description: string;
  sourceMd: string;
  graph: WorkflowGraph;
  status: "active" | "archived";
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}
```

`key + workspaceId + version` 唯一。导入 `active` 版本时旧 active 被归档；已运行实例保存自己的 `definitionVersion`，不受影响。

### WorkflowInstance

```ts
{
  id: string
  workspaceId: string
  definitionId: string
  definitionKey: string
  definitionVersion: number
  title: string
  status: "running" | "waiting" | "blocked" | "completed" | "cancelled" | "failed"
  sessionId?: string
  relatedSessionIds: string[]
  context: Record<string, string | number | boolean>
  nodes: Record<string, WorkflowNodeState>
  parentInstanceId?: string
  parentNodeId?: string
  createdBy: string
  createdAt: string
  updatedAt: string
}
```

`relatedSessionIds` 是过滤索引。用户从会话启动时可把当前会话写入主 `sessionId` 和关联集合；Agent 工具也可以显式补充关联。会话归属变化不改变实例所有权。

### WorkflowEvent

事件只追加，用于时间线和审计：

```ts
{
  id, instanceId, workspaceId, nodeId?, kind,
  actorId, actorKind, actorName, message, data, at
}
```

## 3. 图模型

```ts
interface WorkflowGraph {
  key: string;
  version: number;
  name: string;
  description: string;
  variables: WorkflowVariable[];
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  startNodeIds: string[];
  warnings: string[];
}

interface WorkflowNode {
  id: string;
  name: string;
  type: "task" | "service" | "approval" | "decision" | "subworkflow";
  description: string;
  executor: { kind: "system" | "user" | "agent"; id?: string; label?: string };
  approvers: Approver[];
  approvalPolicy: "all" | "any";
  metricExpression?: string;
  subworkflowKey?: string;
  subworkflowVersion?: number;
}

interface WorkflowEdge {
  id: string;
  from: string;
  to: string;
  condition?: string;
  result?: "approved" | "rejected";
  default?: boolean;
  breakCondition?: string;
  label?: string;
}
```

并行由“一个节点多条出边”表达；汇合由“一个节点多条入边”表达。节点在所有有效前驱完成后才就绪。

## 4. Markdown DSL

选择行导向语法而不是 Mermaid，原因是用户主要写业务步骤，不需要学习画布坐标；同时解析器可以对每一行给出稳定错误。

完整语法见 `docs/workflow-md-guide.md`。解析顺序：

1. 解析标题、元信息；
2. 解析 `### 节点名` 下的字段；
3. 解析连接区的 `from -> to`；
4. 构建图；
5. 执行结构校验；
6. 输出 canonical graph、errors、warnings。

字段支持中文键，标识符使用英文 `kebab-case`，避免持久化和工具调用出现空白字符。

## 5. 校验与循环检测

导入时执行静态校验：

1. 元信息完整；
2. 节点 ID 唯一；
3. 边引用存在；
4. 任务/审批/判断/子流程的必填字段存在；
5. 存在至少一个起点；
6. DFS/Tarjan 找强连通分量与回边；
7. 每个 loop 回边必须有 `break` 表达式；
8. 判断节点必须有条件边或默认边；
9. 审批节点必须有执行人；
10. 子流程必须引用平台内 active 模板；
11. 模板导入时，`executor`、`responsible` 和 `approver` 中的用户引用必须是平台账号；启动实例时，这些引用必须属于当前工作区；
12. Agent Profile 在启动实例时校验存在、启用和 task-worker 类型；平台 Profile 与旧结构存量 Profile 跨项目解析，Digital Employee 的项目授权仍在启动实例时校验；
13. 不可达节点生成 warning。

循环判定不是禁止所有环，而是“受控环”：每个环至少一条回边带 break。运行时把每个节点的进入次数写入上下文 `visits.<nodeId>` 和 `<nodeId>.attempts`，break 表达式为真时进入阻塞。

## 6. 表达式

首版使用小型安全表达式，不调用 `eval`：

```text
quality >= 80 && security == true
attempts >= 3 || approved_by_architect == true
```

支持数字、字符串、布尔、标识符、`>= <= > < == !=`、`&& || !`、括号。服务端在判断节点和循环 break 上使用同一解释器；解析失败返回面向用户的表达式错误。

## 7. 运行时状态机

### 启动

1. 解析指定 `definitionId` 或 active 版本；
2. 复制节点状态为 `waiting`；
3. 起点 `startNodeIds` 进入 `ready`；
4. 记录 `instance.started`；
5. 重新计算实例状态。

### 推进

节点完成时：

- 任务/服务：写入输出说明；
- 审批：检查通过策略；否决优先匹配 `result: rejected` 边，否则阻塞；
- 判断：根据上下文评估条件边，没有命中则走 default；
- 子流程：启动子实例，父节点保持 running，子流程完成后再推进。

对目标节点：

1. 检查环 break；
2. 累计进入次数；
3. 所有有效前驱完成后置 `ready`；
4. 服务节点保持 ready，等待显式 `complete`；
5. 审批节点初始化待审批人并置 waiting；
6. 任务/Agent 节点置 waiting。

启动前会再次执行用户引用校验，避免账号在导入后被删除或移出工作区导致流程进入无人可执行的实例。

首版不自动执行 shell 或无人值守服务调用；服务节点代表系统动作的就绪点，需要通过授权 API/工具确认完成。

### 实例状态计算

优先级：cancelled/failed/completed > blocked > waiting > running。若没有 ready/waiting/running 节点且至少一个 completed 终点，则 completed。

## 8. API

统一前缀 `/api/collab/workflow`，浏览器请求要求 same-origin + Bearer token。

| 方法 | 路径                     | 说明                         |
| ---- | ------------------------ | ---------------------------- |
| GET  | `/definitions`           | 按 workspace 列出定义        |
| POST | `/definitions/validate`  | 只校验，不落盘               |
| POST | `/definitions/import`    | 管理端保存新版本             |
| GET  | `/instances`             | 工作区实例；可传 `sessionId` |
| GET  | `/instances/detail`      | 实例详情与事件               |
| POST | `/instances/start`       | 启动实例                     |
| POST | `/nodes/complete`        | 完成任务/服务；Agent 节点可显式 `force=true` 人工兜底 |
| POST | `/nodes/cancel`          | 人工取消 Agent/Digital Employee 节点         |
| POST | `/approvals/decide`      | 通过/否决                    |
| POST | `/approvals/delegate`    | 转交                         |
| POST | `/approvals/countersign` | 加签                         |
| POST | `/instances/cancel`      | 取消实例                     |

服务端从 token 推导用户身份；Agent 工具从执行上下文推导身份。客户端提交的 actor 仅用于显示，不作为授权依据。

### 与任务管理的边界

任务管理不是工作流状态机的存储或决策方。工作流到 Task 的 `create / settle / projectStatus / projectEvent / projectAgentRun` 都是单向投影：Task 缺席、创建失败或刷新失败只影响任务侧可见性，不能阻塞工作流事件落库、审批结论、交付门禁或节点推进。Task 到工作流只允许“改派同步”和“审批/完成结论回传”，且必须校验 Task 确实属于当前工作流节点；工作流详情始终保留原生操作入口。

## 9. 前端设计

### 中间页签

注册：

```js
ctx.slots.inject("conversation.view", () =>
  ctx.slots.register(
    {
      name: "conversation.view",
      id: "pluginmax-workflow",
      order: 30,
      label: () => "工作流",
    },
    WorkflowTab,
  ),
);
```

组件通过原生 props 获取 `sessionId` 和 `useWorkspaces`，从 workspace snapshot 的 `sessionIds` 反查当前工作区。这保证 DSH 左侧会话选择天然驱动中间页签。

发起表单在成员可见视图中常显，避免按钮展开状态被 session 槽位重挂载清空。表单提交使用 document 级委托，提交成功后通过 `pluginmax:workflow-refresh` 通知页签刷新。

视觉遵循用户 demo：

- 最大宽度 880px；
- 卡片 7px 圆角、8px 间距；
- 状态点与 pill：running 绿、blocked 红、waiting 黄、completed 灰绿；
- 分支节点 8px 缩进 + 2px 左边框；
- 移动端将卡片 summary 重排为三行；
- 样式全部使用 `pmwf-` 前缀，避免污染 DSH。

### 设置管理

注册 `settings.section`，顺序放在会议之后。非 owner/admin 的导入按钮禁用，并在旁边说明“需要工作区 owner 或 admin”。

图形检查视图首版不做自由画布，而是确定性拓扑渲染：

- 线性节点纵向排列；
- 并行/分支子节点缩进；
- 循环回边用虚线和“循环 break”标签；
- 错误节点红色边框，warning 节点黄色边框。

## 10. 测试策略

- Parser：合法 DSL、中文键、串并行、条件、默认分支、循环、错误行定位。
- Expression：比较、布尔、缺变量、类型错误、注入拒绝。
- Validation：重复 ID、未知引用、无起点、不可达、无 break 循环、未知子流程。
- Engine：启动、串行、并行汇合、审批 all/any、否决、转交、加签、判断、break、子流程。
- Optional integration：Task 桥缺席时，人工审批、交付物门禁、服务节点就绪、Agent 成功自动完成都必须继续闭环；Task 桥存在时，失败投影不得反向阻塞工作流。
- API：认证、same-origin、工作区成员、owner/admin 写入、跨工作区拒绝。
- Client contract：bundle ESM、声明 `dsh.client`、注册两个已知 slot。
- GUI：按 `docs/workflow-gui-test-plan.md` 覆盖 PRD 场景。
