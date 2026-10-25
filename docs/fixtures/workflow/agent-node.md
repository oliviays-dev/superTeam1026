# 工作流：Agent 节点执行

## 元信息

- key: agent-node
- version: 2
- description: 校验 Agent Task Worker 的自动派发和交付物门禁

## 节点

### 开发

- id: development
- type: task
- executor: agent:backend-agent
- responsible: user:workflow-member
- description: 输出可审核的开发交付说明
- execution: task-worker
- trigger: auto-on-ready
- max-attempts: 2
- timeout: 30m
- deliverable: implementation-report
  title: 实现说明
  type: text
  required: true
  min-text-length: 20
  description: 说明实现结果、覆盖范围和风险

## 连接
