# 工作流：Agent 超时兜底

## 元信息

- key: agent-node-timeout
- version: 1
- description: 用 1 秒超时快速验证 Agent 超时后的转人工流程

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
- timeout: 1s
- deliverable: implementation-report
  title: 实现说明
  type: text
  required: true
  min-text-length: 20
  description: 说明实现结果、覆盖范围和风险

## 连接
