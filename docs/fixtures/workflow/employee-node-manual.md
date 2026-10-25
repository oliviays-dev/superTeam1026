# 工作流：Digital Employee 手动派发

## 元信息

- key: employee-node-manual
- version: 1
- description: 手动校验 Digital Employee 生命周期边界、票据和交付物门禁

## 节点

### 开发

- id: development
- type: task
- executor: employee:backend-01
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
