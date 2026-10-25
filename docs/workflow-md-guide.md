# 工作流 Markdown 定义语法

工作流模板使用行导向 Markdown。目标是让管理员直接阅读和版本管理，不需要先学画布。

## 1. 最小示例

```md
# 工作流：产品交付

## 元信息

- key: product-delivery
- version: 1
- description: 从需求评审到发布的轻量流程
- variable: complexity = 5
- variable: security_reviewed = false

## 节点

### 需求评审

- id: requirement-review
- type: approval
- executor: user:flow-member
- approver: 用户:admin
- policy: all

### 开发

- id: development
- type: task
- executor: agent:backend-agent
- responsible: user:Alice
- deliverable: implementation-report
  title: 开发交付说明
  type: text
  required: true
  min-text-length: 30
  description: 说明接口、测试范围和已知风险

### 发布

- id: release
- type: service
- executor: system:deployment

## 连接

- requirement-review -> development
- development -> release
```

## 2. 文档结构

```text
# 工作流：<显示名>
## 元信息
## 节点
### <节点显示名>
## 连接
```

三个二级标题必须存在且只出现一次。`###` 是节点显示名，可中文；`id` 是英文标识。

## 3. 元信息字段

| 字段          | 必填 | 说明                                                 |
| ------------- | ---- | ---------------------------------------------------- |
| `key`         | 是   | 工作区内唯一，格式 `kebab-case`。                    |
| `version`     | 是   | 正整数；保存时同 key 下不能重复。                    |
| `description` | 否   | 一句话说明。                                         |
| `variable`    | 否   | `name = default`；默认支持数字、布尔、带引号字符串。 |

示例：

```md
- key: incident-handling
- version: 2
- description: 高风险事件的处置流程
- variable: severity = 3
- variable: customer_impact = true
```

## 4. 节点类型

### 任务 task

由用户、Agent 或人设完成。

```md
### 开发

- id: development
- type: task
- executor: user:Alice
- review-required: false
- description: 完成后端接口和测试
```

- `review-required` 默认 `true`。节点生成的 Task 完成后会先进入人工 Review。
- 设为 `false` 时，Task 提交后直接完成并驱动工作流节点完成；Agent 普通执行节点在其运行成功后也会走同一条直接完成路径。缺少必填交付物时，工作流仍会保留节点门禁，不会静默推进。

### 服务 service

代表系统/服务动作的就绪点。首版不自动执行命令，必须通过授权 API/工具确认完成。

```md
### 部署

- id: deploy
- type: service
- executor: system:deployment
```

### 审批 approval

审批是控制门，支持多人审批。

```md
### 技术评审

- id: tech-review
- type: approval
- executor: user:tech-lead
- approver: 用户:Alice
- approver: agent:architect
- policy: all
```

- `policy: all`：所有必签人通过才通过。
- `policy: any`：任一必签人通过即通过。
- 否决会优先走 `rejected` 出边；没有 rejected 边则阻塞。
- 审批节点进入待处理时会自动创建“待 Review”的审批 Task，并标注并签/或签；审批 Task 不展示手动任务的自动 Review 开关。
- Agent 只能作为审批 Task 的负责人接收处理；Agent 运行成功不会等价于审批通过，仍必须产生明确的通过或退回结论。

### 判断 decision

用于规则分支或 AI 决策。

```md
### 复杂度判断

- id: complexity
- type: decision
- executor: system:rules
```

连接上写条件；未命中时走 `default`。AI 决策把 executor 写成 `agent:architect`，由 Agent 通过工具写入判断结果。

### 子流程 subworkflow

```md
### 复杂方案评审

- id: complex-review
- type: subworkflow
- executor: system:workflow
- subworkflow: complex-review
- subworkflow-version: 1
```

`subworkflow` 必须是同一工作区已启用的模板 key。省略版本时使用当前 active 版本。

## 5. 执行者写法

```text
executor: system:<服务标识>
executor: user:<用户标识>
executor: agent:<Agent/人设标识>
executor: employee:<Employee ID>
```

审批人可多行：

```text
- approver: 用户:Alice
- approver: agent:architect
- approver: employee:backend-01
```

`用户:` / `agent:` / `employee:` 前缀用于 UI；冒号后的标识分别使用系统用户标识、Agent Profile ID 和 Employee ID。

导入模板时校验 `user:<用户标识>` 必须是平台账号；在项目中启动实例时再校验这个账号是否是当前工作区的真实成员。不存在、已移出或只是“名字像角色”的标识都会被拒绝。`system:<服务标识>` 表示系统能力。

### Agent 执行控制

### Digital Employee 执行控制

正式数字员工使用 Employee ID：

```md
- executor: employee:backend-01
- execution: task-worker
- trigger: auto-on-ready
```

导入前必须在「设置 > 员工」确认：

1. Digital Employee 已启用；
2. 在当前工作区有显式角色授权；
3. 有启用的 Runtime Profile；
4. Runtime Profile 已填写 Task Worker Profile 映射。

派发时会签发绑定到 workflow instance 的 Action Ticket；员工被暂停、票据过期或显式拒绝时，输出不会进入交付物。旧 `agent:<id>` 语法继续可用，但运行记录会标记为过渡 Task Worker。

`agent:<id>` 绑定 Agent Profile。平台 Teammate 派生的 Profile 和旧结构存量 Profile 可跨项目解析；新建项目私有 Profile 只能在创建它的项目里启动。下面字段通常一起写在任务节点里：

```md
- execution: task-worker
- trigger: manual-dispatch
- max-attempts: 2
- timeout: 30m
- agent-profile: backend-agent
```

| 字段            | 默认值               | 说明                                                             |
| --------------- | -------------------- | ---------------------------------------------------------------- |
| `execution`     | `manual`             | `task-worker` 表示由一次性 Agent 执行；`manual` 继续由人工交付。 |
| `trigger`       | `manual-dispatch`    | `auto-on-ready` 会在节点就绪后由服务端自动派发。                 |
| `max-attempts`  | `1`                  | 同一次节点进入最多派发次数，取值 1 到 5。                        |
| `timeout`       | `30m`                | 单次 Agent 运行超时，支持 `1s` 到 `1h`。                         |
| `agent-profile` | executor 的 Agent id | 显式指定 Profile；不填时尝试使用 `executor: agent:<id>` 解析。   |

- 自动派发必须同时满足 `execution: task-worker` 和 `trigger: auto-on-ready`；
- 导入和启动时校验 Profile 存在、启用且类型是 `task-worker`；平台可见 Profile 不要求运行实例使用创建时的项目；
- Agent 成功输出不会直接完成节点；必须满足 required 交付物，并由责任人确认；
- 失败、超时、中断或取消后，责任人可以人工代交，owner/admin 可以越过重试上限处理。

### 责任人

可选字段：

```md
- responsible: user:Alice
```

用户任务可以用它把实际操作人和 `executor` 分开。Agent / Digital Employee 节点建议始终声明人类责任人；未声明时保存会产生 warning，运行期由工作区负责人或管理员处理。

启动实例时，`responsible: user:<id>` 里的用户必须是当前工作区成员；`responsible: employee:<id>` 的数字员工必须启用并有当前工作区授权。

### 交付物

节点可以声明一个或多个交付物，用于完成门禁：

```md
- deliverable: api-design
  title: API 设计文档
  type: file
  required: true
  accept: .md,.pdf
  max-files: 2
  description: 包含接口契约、错误码和数据结构
- deliverable: regression-report
  title: 回归说明
  type: text
  required: true
  min-text-length: 30
- deliverable: implementation-branch
  title: 实现分支
  type: link
  required: false
```

规则：

- `deliverable` 后是节点内唯一的英文 key；
- 子属性使用两空格缩进；
- `type` 支持 `file`、`text`、`link`；
- `required: true` 的交付物未提交时不能完成节点；
- 文件单次最多 `max-files` 个，单个文件上限 20MB；
- 同一交付物可以重复提交，新的提交会成为当前版本，旧版本保留在提交历史里。

## 6. 连接语法

基础：

```md
- development -> testing
```

并行：从一个节点写多条边。

```md
- approved -> backend
- approved -> frontend
- approved -> qa-plan
- backend + frontend + qa-plan -> release
```

汇合节点 `release` 有三条入边，三条来源完成后才就绪。普通线性边不需要显式 `+`；写 `a + b -> c` 时解析器只把 `a`、`b` 记录为入边，额外 token `c` 会报错。建议直接写三条 `->`。

条件：

```md
- complexity -> complex [condition: complexity >= 8]
- complexity -> standard [default]
```

审批结果：

```md
- tech-review -> development [result: approved]
- tech-review -> security-fix [result: rejected]
```

受控循环：

```md
- test-failed -> development [break: attempts >= 3]
```

一条边可组合：

```md
- review -> rework [result: rejected, break: attempts >= 3]
```

## 7. 循环规则

所有循环必须在至少一条回边上声明 `break`。

运行时上下文：

- `visits.<nodeId>`：节点累计进入次数；
- `<nodeId>.attempts`：同一节点的重试次数，首次进入为 1。

示例：

```md
- testing -> development [break: attempts >= 3]
- testing -> release [result: approved]
```

break 为真时目标节点进入阻塞；用户需要修改上下文、跳过、取消或让管理员调整模板。

## 8. 表达式

支持：

- 数字：`80`、`1.5`
- 布尔：`true`、`false`
- 字符串：`"high"`
- 标识符：`complexity`、`security_reviewed`
- 比较：`>= <= > < == !=`
- 逻辑：`&& || !`
- 括号

合法示例：

```text
severity >= 1 && customer_impact == true
quality >= 80 || (architect_approved == true && risk == "low")
```

不支持函数调用、属性访问、赋值和任意代码。

## 9. 保存前检查

导入页会显示：

| 级别    | 示例                                | 是否可保存 |
| ------- | ----------------------------------- | ---------- |
| error   | 重复节点 ID、未知引用、循环无 break | 否         |
| warning | Agent 节点缺少 responsible          | 是         |
| summary | 节点数、边数、并行分支数            | 是         |

建议流程：

1. 粘贴或选择 `.md`；
2. 点击“校验”；
3. 阅读 errors/warnings；
4. 查看图形检查；
5. 确认后点击“保存新版本”。

## 10. 常见错误

| 错误                                    | 处理                                 |
| --------------------------------------- | ------------------------------------ |
| `workflow key is required`              | 补 `- key: ...`。                    |
| `duplicate node id: development`        | 保证 ID 唯一。                       |
| `edge references unknown node: testng`  | 修正拼写。                           |
| `approval node requires approver`       | 至少写一行 `- approver`。            |
| `cycle requires a break condition`      | 给回边加 `[break: ...]`。            |
| `decision node requires a default edge` | 给判断节点补 `[default]`。           |
| `unknown subworkflow: foo`              | 先导入并启用该子流程模板。           |
| `deliverable ... requires a title`      | 检查交付物子属性是否保留两空格缩进。 |
