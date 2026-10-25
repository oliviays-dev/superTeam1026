# dsh-collab-agent

Agent Profile 注册表与 Task Worker 运行时。Phase X 中工作流 Agent 节点通过
`collabAgent` 服务派发一次性运行；运行过程与结果记录在 `collab_agent` 存储，
不会创建左侧会话，也不进入会议。

当前能力是 **transitional Task Worker**，只用于工作流节点的受控一次性执行。
它不是员工模型里的 Digital Employee，也不是真人派出的 Human Avatar；
后续以 `collabEmployee` 和统一授权模型为准，本插件只保留为执行适配层。

阶段一新增 `collab_agent_execution` 独立存储域：

- Runtime capability snapshot；
- 五层能力/授权/参数解析后的 Execution Envelope；
- Agent Execution Plan 与结构化 Run Event；
- Execution Gate 和决策审计；
- Run Execution Snapshot，包括搜索、网络、沙箱和计划可见性。

该插件继续只拥有执行域。Task 业务状态、项目记忆和团队编排分别由对应插件拥有。

详见 `docs/agent-workflow-execution-phase-x.md`。
