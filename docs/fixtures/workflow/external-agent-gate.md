# 工作流：外部 Agent 门禁

## 元信息

- key: external-agent-gate
- version: 1
- description: 验证外部 Agent 不能绕过交付物和 Review

## 节点

### 开发

- id: development
- type: task
- executor: agent:external-agent-profile-id
- responsible: user:project-owner-id
- description: 输出可审核的实现说明
- execution: task-worker
- trigger: auto-on-ready
- deliverable: report
  title: 实现说明
  type: text
  required: true
  min-text-length: 20
  description: 说明执行结果、覆盖范围和风险

## 连接
