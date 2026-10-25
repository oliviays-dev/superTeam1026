# 工作流：Agent 手动执行

## 元信息

- key: agent-manual
- version: 1
- description: 用于手动派发、取消、重试和人工兜底测试

## 节点

### 开发

- id: development
- type: task
- executor: agent:backend-agent
- responsible: user:workflow-member
- description: 输出可审核的开发交付说明
- execution: task-worker
- trigger: manual-dispatch
- max-attempts: 2
- timeout: 30m
- deliverable: implementation-report
  title: 实现说明
  type: text
  required: true
  min-text-length: 20
  description: 说明实现结果、覆盖范围和风险

## 连接
