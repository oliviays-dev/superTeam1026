# Agent 平台形态 PRD

## 1. 背景

平台里已经出现了几种容易被混用的“Agent”：

1. 会议里的 Agent 分身：由真人派遣，代表这个人参加会议和发言；
2. 工作流里的 `executor: agent:backend-agent`：看起来像负责人，但当前还没有运行时；
3. 角色席位里的 Agent 席位：表达这个席位可以由 Agent 认领；
4. 用户心智中的“我的 Agent”：希望它有稳定身份、记忆、职责和可见的工作记录。

如果不先统一产品语言，很容易把所有 Agent 都塞进左侧会话或会议分身模型，导致权限、归属和可观测性混乱。

本文定义平台中 Agent 的产品形态、归属和界面呈现。后续 Phase X 的工作流自动执行延续这里的分类。

## 2. 目标

1. 用户能一眼分辨“这是谁的 Agent、它代表谁、它当前在做什么”。
2. 人可以拥有会议分身，但不是所有 Agent 都必须变成人的分身。
3. 工作流任务 Agent 有独立、可审计的运行视图，不污染真人左侧会话列表。
4. Agent 可以复用人设 SOUL，但人设不等于运行时，也不等于权限。
5. 长期稳定的 Agent 成员可以拥有 home session，但必须显式创建，而不是由一个工作流节点隐式生成。

## 3. 非目标

首版不做：

- 通用自主 Agent 操作系统；
- 无人工审批的全公司自动化；
- 让 Agent 任意创建工作区、成员或工作流；
- 把所有历史会议分身自动迁移成持久 Agent 成员；
- 为每个任务自动生成左侧会话。

## 4. 核心概念

### Persona：人设资产

Persona 是可复用的行为资产，包含名称、描述、标签和 SOUL。

它回答：

> 这个 Agent 应该以什么风格、专业边界和行为约束工作？

它不回答：

- 谁拥有它；
- 它能访问哪些工具；
- 它是否常驻；
- 它当前是否在运行。

因此 Persona 可以被会议分身、工作流任务 Agent、未来的持久成员复用。

### Agent Profile：可派发 Agent

Agent Profile 是把 Persona、运行形态和权限范围打包后的可派发对象。

示例：

```text
backend-agent
- 显示名：Backend Agent
- 人设：backend-engineer
- 运行形态：task worker
- 默认范围：指定工作区
- 可用工具：workflow.read / workflow.submit
- 责任人：workflow-member
```

Agent Profile 是后续 Phase X 的核心对象。没有 Profile 时，工作流里的 `executor: agent:backend-agent` 只能作为待人工代办的标签。

### Agent Run：一次运行

Agent Run 是一次可观测的执行实例。

它记录：

- 由哪个流程、节点、消息或用户触发；
- 使用哪个 Profile 和 Persona；
- 输入上下文；
- 运行状态；
- 输出和交付物；
- 会话或 transcript 引用；
- 错误、重试和结束原因。

Agent 可以消失，但 Agent Run 必须可追溯。

## 5. Agent 形态分类

### 5.1 人类分身 / Human Avatar

这是当前会议模型中的形态。

特点：

- 有明确的主人；
- 代表主人在会议中露面和发言；
- 通常绑定 Persona；
- 显示为“某人的分身”；
- 发言在会议里有特殊标识；
- 主人能决定它是否参加、是否自动回应、是否退出。

适用场景：

- 主人不能实时参加，但希望 Agent 按自己的立场收集信息；
- 会议中需要多个角色视角；
- 主人希望保留最终解释权。

界面原则：

- 不为每个分身在左侧自动开一个 home session；
- 分身主要出现在会议参与者列表和会议消息流；
- 运行详情通过参与者详情或会议侧栏查看；
- 它的发言必须标识为 Agent，不能冒充主人本人。

### 5.2 任务 Agent / Task Worker

这是工作流节点最需要的形态。

特点：

- 为一个明确任务临时启动；
- 输入是节点描述、上下文和交付要求；
- 输出是结果、说明和交付物引用；
- 默认没有持久 home session；
- 不代表某个人在会议中发言；
- 不自动成为工作区成员；
- 权限来自一次受限的 dispatch ticket。

适用场景：

- 完成接口设计草案；
- 汇总会议结论；
- 起草测试计划；
- 分析日志并输出报告。

界面原则：

- 主要出现在工作流节点详情和 Agent Run 详情；
- 左侧会话列表默认不显示；
- 用户可以点开“运行详情”查看输入、输出、状态和错误；
- 如果任务有会议上下文，可以跳转到关联会议或会话，但不把运行本身伪装成真人会话。

### 5.3 持久成员 Agent / Teammate Agent

这是未来需要显式创建的高级形态。

特点：

- 有稳定身份；
- 可以拥有 home session 或收件箱；
- 可被分配长期职责；
- 有生命周期：创建、启用、暂停、归档；
- 有明确 owner 和工作区角色；
- 它的会话出现在左侧时必须有独立分组和视觉标识。

适用场景：

- 团队常驻的“需求整理员”；
- 项目里的“知识管理员”；
- 需要持续接收任务、提醒和消息的 Agent 成员。

界面原则：

- 不与真人会话混排；
- 左侧新增“Agent”分组，或至少使用稳定图标和后缀标识；
- home session 的标题使用 Agent 名称，不冒充人类；
- Agent 成员列表能看到 owner、职责、状态和最近运行。

### 5.4 系统连接器 / System Connector

这不是人格化 Agent。

特点：

- 执行部署、通知、同步等系统动作；
- 通常不需要 Persona；
- 权限绑定到服务标识和动作；
- 不出现在会议参与者列表；
- 在工作流中显示为系统节点执行器。

适用场景：

- 触发部署；
- 写入工单；
- 同步状态；
- 发送通知。

## 6. 用户场景

### 场景 A：给会议派一个分身

Alice 不能参加“里程碑评审”，她派遣 `Alice-backend-avatar` 参会。

预期：

1. 会议参与者列表显示 `Alice-backend-avatar · Alice 的分身`；
2. Agent 发言有 Agent 标识；
3. 主人可以控制自动发言策略；
4. 会议结束后分身不自动变成持久团队成员；
5. 会议 transcript 保留它说过什么。

### 场景 B：工作流节点分配给 backend-agent

“产品交付”流程中的「开发」节点分配给 `backend-agent`。

当前阶段预期：

1. 节点显示执行者是 `Backend Agent`；
2. 页面明确提示“Agent 尚未自动运行”；
3. 有权限的人代为上传 API 设计文档和回归说明；
4. 用户确认完成后，事件记录“人工代交”。

Phase X 后的预期：

1. 节点就绪后可自动或手动派发 `backend-agent`；
2. 用户能看到 Agent Run 从“排队”到“运行中”再到“已完成”；
3. Agent 输出进入节点交付物区；
4. 必交项不满足时节点仍然不能完成；
5. 失败和重试有独立记录。

### 场景 C：创建常驻 Agent 成员

团队创建 `delivery-coordinator`，负责整理风险和提醒待办。

预期：

1. 创建时必须选择 Persona、owner、工作区和工具范围；
2. 系统显式生成 home session 或收件箱；
3. 左侧列表明确显示它是 Agent；
4. 它可以被暂停或归档；
5. 它的历史运行和工作记录可以审计。

## 7. 信息架构

### 左侧栏

原则：

1. 真人会话仍是默认主体；
2. 人类分身不出现在左侧会话；
3. Task Worker 不出现在左侧会话；
4. Teammate Agent 只有显式创建后才进入“Agent”分组；
5. 分组必须可折叠。

示例：

```text
工作区
  产品平台
    需求评审
    开发会话

Agent
  delivery-coordinator        [常驻]
```

### 中间操作区

未来中间主操作区可以承载：

- 会话工作台；
- 工作流页签；
- Agent 运行详情；
- Agent 成员管理；
- 会议页签。

Agent Run 详情应作为工作台中的一个页面或抽屉，而不是简单替换当前会话。

### 设置

设置中管理稳定资产：

- Persona；
- Agent Profile；
- 工具授权；
- Teammate Agent 生命周期；
- 审计。

短期只需要 Persona 管理和只读 Agent Profile 列表；Agent Profile 正式落地属于 Phase X 前置能力。

## 8. 权限与信任

### 归属

| 形态           | owner              | 工作区身份                        | 可见性               |
| -------------- | ------------------ | --------------------------------- | -------------------- |
| 人类分身       | 某个真人           | 会议参与者，不是 workspace member | 会议成员可见         |
| Task Worker    | 派发者或流程责任人 | dispatch ticket                   | 有权限的流程成员可见 |
| Teammate Agent | 创建者或管理员     | 显式 Agent member                 | 工作区可见           |
| 系统连接器     | 平台/管理员        | 服务身份                          | 操作事件可见         |

### 最小权限

每次 Agent Run 应获得独立 ticket，包含：

- workspaceId；
- instanceId；
- nodeId；
- runId；
- allowed tools；
- expiry；
- deliverable scope。

Agent 不应继承创建者的全部权限，也不应因为拥有 Persona 就获得文件、命令或网络权限。

## 9. 生命周期

### Persona

```text
创建 -> 编辑 -> 复用 -> 归档
```

Persona 没有运行状态。

### 人类分身

```text
派遣 -> 加入 -> 发言/等待 -> 退出/会议结束
```

分身不承诺长期记忆。

### Task Worker

```text
排队 -> 运行 -> 等待补充输入 -> 完成 / 失败 / 取消
```

运行结束后不隐式保留 home session。

### Teammate Agent

```text
创建 -> 启用 -> 接收任务 -> 暂停 -> 恢复 -> 归档
```

home session 只在有明确产品需要时创建。

## 10. 关键产品规则

1. Persona 不等于 Agent。
2. Agent Profile 不等于运行。
3. 会议分身不等于工作流执行者。
4. 没有显式创建，不生成 Agent home session。
5. 所有 Agent 发言和输出必须有 Agent 标识。
6. 所有自动执行必须有触发来源、权限范围和审计。
7. 必交交付物未满足时，任何 Agent 或人类的“任务完成”都不能推进流程。

## 11. 成功指标

1. 歧义率：用户看到 Agent 后能回答“它是谁、代表谁、在做什么”。
2. 可追溯性：每次 Agent 输出都能定位触发来源和运行记录。
3. 左侧栏干扰：短期工作流 Agent 不增加真人会话列表噪音。
4. 权限安全：未授权工具、跨工作区读取、越权完成在自动化测试中被拒绝。
5. 交付质量：Agent 节点完成后能找到输入、输出和确认人。

## 12. 验收

### 短期工作流增强阶段

- Agent 节点不会自动运行；
- 有权限用户可代交关键交付物；
- 完成事件明确记录人工代交；
- 左侧栏不出现 backend-agent 会话。

### Phase X 前置

- 存在 Agent Profile 管理；
- 存在 Persona 与 Profile 的关联；
- 存在工具范围模板；
- 用户能查看 Agent Run 列表。

### Phase X

- 工作流可按策略派发 Task Worker；
- 运行状态、输出、失败和重试可见；
- 自动执行不会绕过交付物门禁；
- 所有运行可审计。

## 13. 演进路径

```text
Workflow Deliverables
  只补流程证据和人工确认门禁
        |
        v
Agent Platform PRD
  统一 Persona / Profile / Run / 分身 / 常驻成员
        |
        v
Agent Profile Registry
  定义可派发对象和权限模板
        |
        v
Phase X Workflow Execution
  手动/自动派发 Task Worker，输出进入交付物门禁
        |
        v
Teammate Agent
  显式创建 home session 和长期职责
```
