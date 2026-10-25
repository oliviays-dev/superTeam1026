# 工作流：缺少 Runtime Profile 的 Digital Employee 节点执行

## 元信息

- key: no-runtime-node
- version: 1
- description: 校验缺少 Runtime Profile 映射的 Digital Employee 被拒绝派发

## 节点

### 开发

- id: development
- type: task
- executor: employee:no-runtime-01
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
