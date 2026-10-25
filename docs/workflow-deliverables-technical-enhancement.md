# 工作流交付物增强技术设计

## 1. 背景与决策

当前工作流已经能表达节点、串并行、审批、判断、子流程和受控循环，但节点完成仍接近“人工勾选”：

- `executor: agent:backend-agent` 只是执行者描述，不会启动 Agent；
- `POST /nodes/complete` 只接受可选 `note`，不校验关键交付物；
- UI 上的「完成」没有表达“已交付”“已验收”“人工豁免”的差别；
- Agent 节点和普通任务节点在服务端权限上区分不足。

本次增强只解决**工作流自身的交付证据与完成门禁**，不引入 Agent 自动执行。这是工作流能力的第一个闭环。

本阶段的明确约束：

1. `executor: agent:<id>` 的节点不会自动运行。
2. 关键交付物由有权限的人类用户代为上传或填写。
3. 所有必交交付物提交后，用户仍需显式确认完成，流程才会推进。
4. 不把 Agent 自动变成左侧会话，也不要求为本阶段创建 Agent home session。

后续 Agent 自动触发、运行记录、人设和会话形态见：

- `docs/agent-platform-prd.md`
- `docs/agent-workflow-execution-phase-x.md`

## 2. 目标

1. 管理员能在 Markdown 中声明节点的关键交付物。
2. 用户能清楚看到每个节点“需要交什么、谁交、是否已交、是否可完成”。
3. 必交交付物未齐时，服务端拒绝完成，UI 禁用完成按钮并说明缺失项。
4. Agent 节点在本阶段支持“人工代交 + 确认完成”，并留下显式审计。
5. 交付物与流程实例一起工作区隔离，不能跨工作区读取。
6. 旧版定义继续兼容：没有声明交付物的节点保持现状，但 UI 必须提示“无交付物要求，确认完成”。

## 3. 非目标

本阶段不做：

- 自动启动 Agent；
- 后台长任务运行时；
- Agent home session；
- 任意 shell 或系统服务自动执行；
- 交付物内容语义级自动评审；
- 旧流程实例的强制迁移。

## 4. 核心概念

### 交付物要求

交付物要求属于流程定义的一部分，随节点版本固化。它描述“必须交什么”，不描述系统如何自动生成。

```ts
interface DeliverableRequirement {
  key: string;
  title: string;
  type: "file" | "text" | "link";
  required: boolean;
  description: string;
  accept?: string[];
  minTextLength?: number;
  maxFiles?: number;
}
```

约束：

- `key` 在节点内唯一，使用英文 kebab-case；
- `type: file` 用于上传设计文档、测试报告、截图等；
- `type: text` 用于简要交付说明、回归结论、变更摘要；
- `type: link` 用于外部系统链接，例如仓库、Issue、CI Run；
- `required: true` 会阻止节点完成；
- `required: false` 只作为补充材料，不阻塞流转。

### 交付物提交

```ts
interface DeliverableSubmission {
  id: string;
  workspaceId: string;
  instanceId: string;
  nodeId: string;
  requirementKey: string;
  requirementTitle: string;
  type: "file" | "text" | "link";
  value: string;
  artifacts: ArtifactMetadata[];
  submittedBy: string;
  submittedByName: string;
  onBehalfOf?: string;
  submittedAt: string;
  status: "submitted" | "rejected";
  note?: string;
}
```

同一要求允许多次提交，保留历史。服务端只取当前有效提交用于完成判断；被拒绝的提交继续留在时间线中。

### 人工代交

Agent 节点在未接入自动执行前使用 `onBehalfOf` 表达“人类代 Agent 提交”：

```text
提交人：workflow-member
代交对象：backend-agent
交付物：API 设计文档
确认完成：workflow-member
```

这不是宣称 Agent 已经运行，而是明确表示：节点所需的交付证据由人类操作者提供。

## 5. Markdown DSL 扩展

在节点字段下新增 `deliverable` 块。

```md
### 开发

- id: development
- type: task
- executor: agent:backend-agent
- responsible: user:workflow-member
- description: 完成接口、数据结构和回归说明
- deliverable: api-design
  title: API 设计文档
  type: file
  required: true
  accept: .md,.pdf
  description: 包含接口契约、数据结构和边界说明
- deliverable: regression-report
  title: 回归说明
  type: text
  required: true
  min-text-length: 30
  description: 说明已覆盖场景、未覆盖场景和已知风险
- deliverable: implementation-branch
  title: 实现分支
  type: link
  required: false
```

### 字段规则

| 字段              | 必填 | 说明                               |
| ----------------- | ---- | ---------------------------------- |
| `deliverable`     | 是   | 交付物 key，节点内唯一。           |
| `title`           | 是   | 用户可读名称。                     |
| `type`            | 是   | `file`、`text`、`link`。           |
| `required`        | 否   | 默认 `false`。                     |
| `description`     | 否   | 交付要求说明。                     |
| `accept`          | 否   | 文件扩展名白名单，仅 `file` 有效。 |
| `min-text-length` | 否   | 文本最小长度，仅 `text` 有效。     |
| `max-files`       | 否   | 单个提交最大文件数，默认 1。       |

### 责任人字段

新增可选字段：

```md
- responsible: user:workflow-member
```

用途：

- 用户节点缺省时，`responsible` 可以覆盖 `executor` 作为操作人；
- Agent 节点在本阶段必须有明确的人类责任人；未声明时回退到 workspace owner/admin；
- 审批节点继续使用 `approver`，不受该字段影响。

解析器会把 `responsible` 存为节点元数据，不改变现有 `executor` 的含义。

## 6. 数据模型

`collab_workflow` 存储域保持 `version: 1`：本次是未发布格式上的附加表和字段，不引入不兼容变更。

### WorkflowNode

```ts
interface WorkflowNode {
  id: string;
  name: string;
  type: "task" | "service" | "approval" | "decision" | "subworkflow";
  description: string;
  executor: Executor;
  responsible?: ActorRef;
  deliverables: DeliverableRequirement[];
  // 其他既有字段保持不变
}
```

### WorkflowNodeState

```ts
interface WorkflowNodeState {
  nodeId: string;
  status: NodeStatus;
  deliverables: Record<string, DeliverableState>;
  // 其他既有字段保持不变
}

interface DeliverableState {
  requirementKey: string;
  latestSubmissionId?: string;
  status: "pending" | "submitted" | "rejected";
  submittedAt?: string;
  submittedBy?: string;
  onBehalfOf?: string;
}
```

### ArtifactMetadata

文件本体不放入 `collab_workflow.json`，存储域只保存元数据。

```ts
interface ArtifactMetadata {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  checksum: string;
  storagePath: string;
}
```

推荐落盘位置：

```text
$DSH_HOME/pluginmax/workflows/<workspaceId>/instances/<instanceId>/artifacts/<submissionId>/<fileName>
```

路径必须经过规范化后做 workspace/instance containment 校验，禁止 `..`、符号链接逃逸和任意 MIME 直接执行。

## 7. 完成门禁

### 判定规则

节点完成前，服务端逐项检查交付物要求：

1. `required: true` 且状态为 `pending`：阻止完成；
2. `required: true` 且最新提交为 `rejected`：阻止完成；
3. `required: true` 且存在 `submitted`：满足；
4. `required: false`：不参与完成判断；
5. 定义没有任何 required deliverable：允许显式确认完成。

服务端响应应返回结构化缺失列表：

```json
{
  "ok": false,
  "error": {
    "code": "missing_deliverables",
    "message": "还有必交交付物未提交",
    "details": [
      {
        "key": "api-design",
        "title": "API 设计文档",
        "type": "file",
        "reason": "pending"
      }
    ]
  }
}
```

### 完成接口

现有接口语义调整：

```http
POST /api/collab/workflow/nodes/complete
```

请求扩展：

```ts
{
  instanceId: string;
  nodeId: string;
  note?: string;
}
```

规则：

- 没有 required deliverable 时，仍允许直接完成；
- 完成事件记录 `deliverableSnapshot`，包含每个 required key 的当前状态和提交 ID；
- Agent 节点完成事件额外记录 `onBehalfOf`。

### 交付物接口

| 方法   | 路径                                                                         | 说明                 |
| ------ | ---------------------------------------------------------------------------- | -------------------- |
| `POST` | `/api/collab/workflow/deliverables/text`                                     | 提交文本交付物       |
| `POST` | `/api/collab/workflow/deliverables/link`                                     | 提交链接交付物       |
| `POST` | `/api/collab/workflow/deliverables/file`                                     | multipart 上传文件   |
| `GET`  | `/api/collab/workflow/deliverables/download?submissionId=...&artifactId=...` | 下载已提交文件       |
| `POST` | `/api/collab/workflow/deliverables/reject`                                   | owner/admin 拒绝提交 |

安全约束：

1. 所有接口要求 same-origin 和 Bearer token；
2. 读取、提交、下载都必须校验 workspace membership；
3. 文件下载使用 Content-Disposition attachment，不内联渲染 HTML/SVG；
4. 单文件默认上限 20MB，单节点总提交量上限 100MB；
5. 提交接口按 `instanceId + nodeId + requirementKey` 串行化，避免并发写覆盖。

## 8. 权限模型

本次同步收紧普通任务节点的完成权限：

| 节点类型   | 可提交交付物                                       | 可确认完成                          |
| ---------- | -------------------------------------------------- | ----------------------------------- |
| 用户任务   | `executor` 或 `responsible` 指定的用户             | 指定用户；owner/admin 可管理员介入  |
| Agent 节点 | `responsible` 用户；未声明时 workspace owner/admin | 同左                                |
| 系统服务   | owner/admin 或被授权服务身份                       | owner/admin；自动连接器后续单独设计 |
| 审批       | 不适用                                             | 继续沿用 approver 逻辑              |

权限判断变化：

1. Agent actor 不再因为 `actor.kind === "agent"` 自动获得所有节点完成权；
2. 普通 workspace member 不能完成未分配给自己的节点；
3. 管理员介入必须写入事件，不允许静默代操作；
4. `onBehalfOf` 只能是人类用户显式提交时写入，客户端提交的值不作为授权依据，必须从已校验的节点定义推导。

## 9. 客户端交互

### 节点详情

可执行任务和 Agent 节点展开后新增“交付要求”区域：

```text
交付要求

API 设计文档          必交 · 文件      [已提交]
回归说明              必交 · 文本      [缺失]
实现分支              选交 · 链接      [未提交]

[上传/填写交付物]
[确认完成]
```

状态文案：

| 状态        | 用户文案 |
| ----------- | -------- |
| `pending`   | 待提交   |
| `submitted` | 已提交   |
| `rejected`  | 已退回   |

### 完成按钮

1. 所有 required deliverable 已提交：显示「确认完成」；
2. 有缺失或退回项：显示「缺少 N 项交付物」，按钮禁用；
3. 无 required deliverable：显示「确认完成」，点击时可提示“该节点没有交付物要求”；
4. 提交期间按钮进入 pending 态；
5. Agent 节点在区域顶部显示：“本节点暂不自动运行；当前由人类代交交付物。”

### 时间线

节点事件追加：

- `deliverable.submitted`
- `deliverable.rejected`
- `node.completed_with_deliverables`
- `node.completed_without_required_deliverables`

事件 data 中不写入文件内容，只保存提交 ID、文件名、checksum、提交人和代交对象。

## 10. 存量兼容

1. 旧 definitions 没有 `deliverables` 字段时，反序列化为空数组。
2. 已运行实例不回填新的交付要求；它继续按启动时的定义版本执行。
3. 新导入定义如果声明了 required deliverable，完成逻辑自动启用。
4. 存储 migration 幂等：重复启动或崩溃后重跑，不得创建重复表结构或重复默认状态。

## 11. 测试策略

### Parser / Validation

- 解析单个和多个交付物；
- 交付物 key 重复时报错；
- `file` 的 `accept`、`text` 的 `min-text-length` 类型校验；
- `responsible` 格式校验；
- Agent task 缺少 `responsible` 时保存成功，但导入结果产生 warning。

### Engine

- required pending 不能完成；
- required rejected 不能完成；
- 所有 required submitted 后才能完成；
- optional 缺失不阻塞；
- 无 required deliverable 的旧节点继续完成；
- 完成事件包含交付物快照；
- 并发提交和并发完成不产生重复推进。

### API / Security

- 未登录、跨 origin、跨工作区读取均拒绝；
- 非 responsible member 不能提交或完成；
- owner/admin 代操作写入审计；
- 文件路径穿越、超限、非法扩展名被拒绝；
- 下载仅允许同一 workspace member。

### GUI

- 完成按钮根据缺失数量禁用；
- 上传成功、文本不足、服务端拒绝均有反馈；
- Agent 节点明确显示人工代交提示；
- 旧流程实例展开不空白、不报错；
- 移动端交付列表不横向溢出。

## 12. 里程碑

### W1 交付契约与门禁

- 扩展 parser、graph schema、storage migration；
- 完成前校验 required deliverables；
- 更新完成事件。

### W2 交付物 API 与存储

- text/link/file 提交；
- 文件存储和下载；
- 拒绝与审计。

### W3 GUI 与回归

- 节点交付列表；
- 上传与文本表单；
- 完成按钮门禁；
- GUI 测试数据与用例。

### W4 权限收紧

- 修正 task/service 的过宽完成权限；
- 增加管理员介入审计；
- 全量 `pnpm check`。

本阶段完成后，工作流可以安全地表达“完成需要什么证据”。但 `backend-agent` 仍只是待执行的 Agent 引用，真正的运行形态和自动触发进入 Agent PRD 与 Phase X。
