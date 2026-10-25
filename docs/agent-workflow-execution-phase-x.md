# 工作流 Agent 节点执行设计：Phase X

## 1. 定位

Phase X 建立在两份前置设计之上：

1. `docs/workflow-deliverables-technical-enhancement.md`：节点必须有交付物证据和完成门禁；
2. `docs/agent-platform-prd.md`：工作流执行者默认是 Task Worker，不是人类分身，也不自动生成左侧 home session。

Phase X 解决一个问题：

> 当工作流节点进入就绪时，如何把任务安全地交给指定 Agent，并把结果转成可验收的交付物？

它不试图让 `backend-agent` 变成一个自主员工。Phase X 的 Agent 是被派发、被限定、被审计的任务执行者。

## 2. 范围

### 包含

1. Agent Profile Registry；
2. 工作流 Agent 节点的派发记录；
3. 手动派发；
4. 显式声明开启的自动派发；
5. Task Worker 运行状态；
6. Agent 输出到交付物门禁的映射；
7. 失败、重试、取消和超时；
8. Agent Run 观测 UI。

### 不包含

1. 自动执行任意 shell；
2. 给 Agent 全量主机权限；
3. 自动创建 Agent home session；
4. 自动把 Agent 加入工作区成员；
5. 后台定时扫描所有流程；
6. 多 Agent 协商式自动排程；
7. 无人工参与的最终验收。

## 3. 产品原则

1. **显式优先**：只有模板明确定义 auto，才自动派发。
2. **运行可见**：每个节点能看到 Agent Run 的状态和结果。
3. **最小授权**：每次运行获得一次 ticket，不继承用户全部权限。
4. **输出不是验收**：Agent 运行完成不等于节点完成，必须满足交付物门禁。
5. **失败不是静默**：失败、超时和取消必须回到流程状态和 UI。
6. **不污染会话列表**：Task Worker 默认不产生左侧会话。

## 4. Agent 在 GUI 中的形态

Phase X 使用 Agent Platform PRD 中的 Task Worker 形态。

`backend-agent` 的默认呈现：

```text
开发
执行者：Backend Agent
状态：运行中
责任人：workflow-member

最近运行
run-8f31 · 运行中 · 今天 14:32

交付要求
API 设计文档          必交 · 文件      [待 Agent 输出]
回归说明              必交 · 文本      [待 Agent 输出]
```

它不出现在左侧工作区会话列表。用户从工作流节点进入 Run 详情。

只有满足以下条件，才考虑 home session：

1. 产品显式创建 Teammate Agent；
2. Agent 需要跨任务保持收件箱；
3. 用户需要主动和它持续对话；
4. 管理员明确授权它的长期工作区身份。

Phase X 不满足这些条件，因此不自动开 home session。

## 5. Agent Profile Registry

新增独立服务 `collabAgent`，推荐放在新插件：

```text
plugins/dsh-collab-agent/
```

不建议继续膨胀 roles 插件。roles 继续负责人设和席位；Agent Registry 负责可派发运行对象。

### AgentProfile

```ts
interface AgentProfile {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  personaId?: string;
  runtimeKind: "task-worker" | "continuable-session" | "connector";
  defaultModel?: {
    provider: string;
    model: string;
    reasoningEffort?: string;
  };
  allowedTools: string[];
  ownerUserId: string;
  status: "active" | "disabled";
  createdAt: string;
  updatedAt: string;
}
```

约束：

1. `id` 在工作区内唯一；
2. `personaId` 是软依赖，引用 `collabPersonas`；
3. `runtimeKind: task-worker` 是 Phase X 默认形态；
4. `continuable-session` 预留给 Teammate Agent；
5. `connector` 不启动模型，只调用已注册服务；
6. `allowedTools` 使用白名单，默认为空；
7. Profile 不能跨工作区使用。

### 存储域

```yaml
name: collab_agent
version: 1
tables: profiles
  runs
```

Profile 和 Run 都保留 `workspaceId`。

## 6. 工作流定义扩展

Agent 节点在交付物增强之后继续扩展。

```md
### 开发

- id: development
- type: task
- executor: agent:backend-agent
- responsible: user:workflow-member
- execution: task-worker
- trigger: auto-on-ready
- max-attempts: 2
- timeout: 30m
- deliverable: implementation-report
  title: 实现说明
  type: text
  required: true
```

### 字段

| 字段            | 默认              | 说明                                              |
| --------------- | ----------------- | ------------------------------------------------- |
| `execution`     | `manual`          | Phase X 中 Agent 节点可用 `task-worker`。         |
| `trigger`       | `manual-dispatch` | 可选 `auto-on-ready`。                            |
| `max-attempts`  | `1`               | 自动重试上限。                                    |
| `timeout`       | `30m`             | 单次运行超时。                                    |
| `agent-profile` | `executor.id`     | 显式指定 Agent Profile；缺省用 executor id 解析。 |

校验规则：

1. `trigger: auto-on-ready` 必须能解析到 active Agent Profile；
2. Profile 必须是 `task-worker`；
3. Profile `status` 必须是 `active`；
4. 至少一个 required deliverable 时才建议自动派发；
5. 没有显式 `auto-on-ready` 一律手动派发。

## 7. 运行记录

### AgentRun

```ts
interface AgentRun {
  id: string;
  workspaceId: string;
  agentProfileId: string;
  personaId?: string;
  source: "workflow";
  instanceId: string;
  nodeId: string;
  dispatchKey: string;
  trigger: "manual-dispatch" | "auto-on-ready";
  status:
    | "queued"
    | "running"
    | "waiting_input"
    | "succeeded"
    | "failed"
    | "timeout"
    | "cancelled";
  attempt: number;
  promptSnapshot: string;
  contextSnapshot: Record<string, string | number | boolean>;
  output?: {
    summary: string;
    rawTranscriptRef?: string;
    endedAt?: string;
    stopReason?: string;
  };
  error?: string;
  startedAt?: string;
  endedAt?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}
```

`dispatchKey` 用于幂等：

```text
<workspaceId>:<instanceId>:<nodeId>:<attempt>:<nodeEnteredAt>
```

同一个节点进入次数、同一个 attempt，只允许存在一个 active run。

## 8. 派发状态机

```text
节点 ready
   |
   +-- 手动派发
   |      用户点击「派发 Agent」
   |
   +-- auto-on-ready
          advance() 创建 queued dispatch
                 |
                 v
              queued -> running
                 |
                 +--> succeeded
                 |      输出写入候选交付物
                 |      仍需满足 required gate
                 |
                 +--> waiting_input
                 |      提示责任人补充上下文
                 |
                 +--> failed / timeout
                 |      可重试或转人工
                 |
                 +--> cancelled
                        取消实例、取消节点或管理员介入
```

节点状态不直接等于 run 状态：

| Run 状态                          | 节点状态                         |
| --------------------------------- | -------------------------------- |
| queued / running / waiting_input  | running 或 waiting               |
| succeeded 且 required gate 满足   | 可确认完成                       |
| succeeded 但 required gate 不满足 | blocked 或 waiting               |
| failed / timeout                  | blocked                          |
| cancelled                         | ready 或 blocked，按取消来源决定 |

## 9. 自动触发逻辑

### 触发点

自动派发只发生在工作流引擎的确定性推进点：

1. 上游节点完成；
2. `advance()` 计算目标节点为 `ready`；
3. 节点是 Agent task；
4. trigger 是 `auto-on-ready`；
5. Agent Profile 可解析且 active；
6. 不存在同一 `dispatchKey` 的 active run；
7. 实例没有被取消。

不在以下时机触发：

1. 打开页面；
2. 轮询列表；
3. 服务重启；
4. 用户切换会话；
5. 定义导入；
6. 审批 merely waiting。

### 队列

Phase X 使用进程内受控队列：

1. 每个工作区最多 2 个并发 Task Worker；
2. 全局默认最多 4 个并发；
3. 同一节点串行；
4. 服务重启后 `queued` 可重新入队；
5. `running` 状态在重启后先标记 `interrupted`，允许责任人手动重试；
6. 不做跨进程持久队列和分布式锁。

队列不调用 shell，不扫描文件系统；它只把构造好的 prompt 和 ticket 交给上游 Agent runtime adapter。

### Prompt 构造

Prompt 只包含本次任务需要的上下文：

```text
# DSH Pluginmax Workflow Task Worker

## 任务
完成接口、数据结构和回归说明。

## 上下文
- 工作流：产品交付
- 实例：订单导出功能
- 节点：开发
- 上下文变量：complexity = 5

## 交付要求
1. implementation-report：至少 30 字的实现说明。

## 边界
1. 只处理当前节点。
2. 不要修改工作流定义。
3. 不要声称已完成未提交的交付物。
4. 输出必须可直接进入交付物审核。
```

Persona 只提供行为风格和约束，不提供额外权限。

## 10. Runtime Adapter

Phase X 优先使用一次性 Task Worker，而不是 continuable 分身。

适配器接口：

```ts
interface WorkflowAgentRuntime {
  start(request: {
    runId: string;
    label: string;
    prompt: string;
    personaId?: string;
    model?: AgentModelSelection;
    allowedTools: string[];
    signal: AbortSignal;
  }): Promise<{
    wait(): Promise<{
      status: "completed" | "failed" | "cancelled";
      summary: string;
      rawTranscriptRef?: string;
      diagnostic?: string;
    }>;
    dispose(): Promise<void>;
  }>;
}
```

实现策略：

1. 复用上游 `subagents` 能力；
2. worker 不作为人类分身进入会议；
3. worker 的最终输出由 runtime adapter 写回 AgentRun；
4. worker 不直接把节点标记为 completed；
5. raw transcript 只保存引用或安全摘要，不把大文本塞进工作流主存储。

如果上游 runtime 不可用：

1. run 进入 `failed`；
2. 节点进入 `blocked`；
3. UI 显示“Agent 运行时不可用，可转人工代交”；
4. 不静默降级成普通任务完成。

## 11. 输出与交付物门禁

Agent 运行成功后，runtime adapter 根据交付物类型写入候选结果：

| 交付物类型 | Agent 自动输出方式                                                       |
| ---------- | ------------------------------------------------------------------------ |
| `text`     | 将结构化文本写入最新 submission                                          |
| `link`     | 如果输出中包含明确链接，提取并保存为候选；否则保持待人工补充             |
| `file`     | Agent 只能引用已授权产物；不能自动伪造文件；通常仍由人工上传或连接器生成 |

所有提交记录：

```json
{
  "submittedBy": "agent:backend-agent",
  "runId": "run-8f31",
  "onBehalfOf": null,
  "requiresReview": true
}
```

完成规则不变：

1. required deliverable 未满足，节点不能完成；
2. `responsible` 用户需要确认 Agent 输出；
3. 如定义了后续 approval，仍必须走审批；
4. 管理员确认时要写入管理员介入事件。

## 12. 失败、重试与人工兜底

### 失败分类

| 类型                      | 处理                                     |
| ------------------------- | ---------------------------------------- |
| Profile 不存在或 disabled | 不派发，节点 blocked                     |
| Runtime 不可用            | run failed，节点 blocked，提示人工代交   |
| Prompt 构造失败           | run failed，记录缺失上下文               |
| Worker non-completed      | run failed，保存 stop reason             |
| 超时                      | cancel signal，run timeout，节点 blocked |
| 输出缺失 required text    | run succeeded，但节点仍缺交付物          |
| 用户取消实例              | active run cancelled                     |

### 重试

1. `max-attempts` 只作用于自动重试；
2. 第一次失败默认等待责任人确认后重试，避免盲跑；
3. 重试创建新的 attempt 和 `dispatchKey`；
4. 超过上限后只能人工处理或管理员调整实例；
5. 所有 retry 写入事件。

### 人工兜底

任何 Agent 节点都必须保留人工兜底路径：

1. 责任人可上传或填写交付物；
2. UI 明确显示“人工代 Agent 提交”；
3. 系统记录 onBehalfOf；
4. 不需要伪造 Agent Run 成功状态。
5. Agent 运行面板保留“人工完成”和“取消节点”。
6. 人工完成和取消节点仅允许 workspace owner 或 admin；节点责任人不能越权接管。
7. “人工完成”仍必须先补齐全部 required deliverables；可先取消 active run，再人工代交并确认完成。
8. Owner/Admin 可填写选填接管备注；备注随人工完成或人工取消事件留痕。
9. “取消节点”先取消 active run，再将节点置为 skipped，关联 Task 使用 `cancelled` 结论关闭。
10. 普通完成仍受 required gate 约束，人工完成也不会绕过 required gate。

## 13. API

| 方法    | 路径                                | 说明                     |
| ------- | ----------------------------------- | ------------------------ |
| `GET`   | `/api/collab/agent/profiles`        | 列出 Agent Profile       |
| `POST`  | `/api/collab/agent/profiles`        | 创建 Profile             |
| `PATCH` | `/api/collab/agent/profiles/:id`    | 更新状态、人设、工具范围 |
| `GET`   | `/api/collab/agent/runs`            | 列出运行                 |
| `GET`   | `/api/collab/agent/runs/:id`        | 查看运行详情             |
| `POST`  | `/api/collab/agent/runs/dispatch`   | 手动派发                 |
| `POST`  | `/api/collab/agent/runs/:id/cancel` | 取消运行                 |
| `POST`  | `/api/collab/agent/runs/:id/retry`  | 创建重试                 |

安全要求：

1. Profile 管理仅 workspace owner/admin；
2. 手动派发需要节点责任人或 owner/admin；
3. Agent actor 只能使用自己的 run ticket；
4. 跨 workspace 的 Profile、Run、节点操作一律拒绝；
5. 自动派发不能由客户端 token 直接打开，只由服务端 workflow engine 触发。

## 14. UI

### 工作流节点

Agent 节点展示：

1. Agent 名称和 Persona；
2. trigger 类型；
3. run 状态；
4. 责任人；
5. 交付物状态；
6. 手动派发、重试、取消、转人工按钮。

按钮规则：

| 状态                 | 按钮                                 |
| -------------------- | ------------------------------------ |
| 未派发               | 「派发 Agent」                       |
| queued               | 「取消」                             |
| running              | 「取消」，其他禁用                   |
| failed / timeout     | 「重试」「转人工」                   |
| succeeded 但缺交付物 | 「补充交付物」「确认完成」按门禁启用 |

### Agent Run 详情

展示：

1. 输入 prompt 快照；
2. Profile 和 Persona；
3. trigger 来源；
4. attempt、开始时间、结束时间；
5. summary；
6. 输出映射到的交付物；
7. 错误和结束原因；
8. 后续操作。

### 设置

设置新增：

```text
Agent
  Profiles
  最近运行
  工具范围
```

短期可以先只读展示 Agent Profile，编辑能力允许分阶段开放。

## 15. 测试策略

### Registry

- Profile 创建、更新、禁用；
- Persona 软依赖；
- 跨 workspace 引用拒绝；
- allowedTools 默认为空。

### Parser

- `execution`、`trigger`、`timeout`、`max-attempts`；
- auto 节点缺少 Profile 时报错；
- manual 节点没有 Profile 时可保存，但运行前报错。

### Trigger

- 节点 ready 恰好创建一个 queued run；
- 重复 advance 不重复派发；
- 重启后 queued 可恢复，running 标记 interrupted；
- disabled Profile 不自动派发；
- 取消实例取消 active run。

### Runtime

- worker 成功输出写入 AgentRun；
- failed 输出进入 blocked；
- timeout 会 abort；
- worker 不能直接完成节点；
- required text 缺失时节点仍不能完成。

### Security

- Agent ticket 只允许 run 范围；
- 无 tool 权限时拒绝调用；
- 跨实例、跨工作区操作拒绝；
- 管理员介入写入审计。

### GUI

- Agent 节点不新增左侧会话；
- run 状态变化可见；
- 失败后能转人工；
- required deliverable 未满足时完成按钮禁用；
- 移动端节点详情可读。

## 16. 实施顺序

### X0 Agent Profile 最小注册表

- `collab_agent` 存储；
- Profile CRUD；
- Persona 软依赖；
- 设置只读列表。

### X1 Run 记录与手动派发

- AgentRun 数据模型；
- 手动派发 API；
- runtime adapter；
- run 详情 UI。

### X2 输出映射

- summary 映射 text deliverable；
- required gate 保持；
- 人工确认完成；
- 审计事件。

### X3 显式自动派发

- `auto-on-ready`；
- 幂等 dispatch key；
- 进程内队列；
- 失败、超时、重试。

### X4 可观测性与回归

- Agent Run 列表；
- 工作流事件联动；
- GUI 测试方案；
- 全量 `pnpm check`。

Phase X 完成后的验收标准是：

> 一个工作流 Agent 节点可以被派发给指定 Agent，用户能看见运行过程和结果；但只有交付物门禁满足并由责任人确认后，流程才会继续。
