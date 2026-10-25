# 工作流：产品交付 v7

## 元信息

- key: product-delivery
- version: 7
- description: 需求评审后并行开发与测试，关键交付物作为完成门禁
- variable: complexity = 5

## 节点

### 需求评审

- id: requirement-review
- type: approval
- executor: user:flow-member
- approver: 用户:flow-member
- policy: any

### 开发

- id: development
- type: task
- executor: agent:backend-agent
- responsible: user:flow-member
- description: 完成接口、数据结构和回归说明
- execution: task-worker
- trigger: manual-dispatch
- max-attempts: 2
- timeout: 30m
- agent-profile: backend-agent
- deliverable: implementation-report
  title: 开发交付说明
  type: text
  required: true
  min-text-length: 30
  description: 说明接口、数据结构、已覆盖场景和已知风险
- deliverable: implementation-branch
  title: 实现分支
  type: link
  required: false
  description: 可选，粘贴分支或变更链接

### 测试准备

- id: test-preparation
- type: task
- executor: user:flow-member
- description: 准备测试用例和验收清单

### 发布审批

- id: release-approval
- type: approval
- executor: user:admin
- approver: 用户:admin
- approver: 用户:flow-member
- policy: all

### 发布

- id: release
- type: service
- executor: system:deployment

## 连接

- requirement-review -> development [result: approved]
- requirement-review -> test-preparation [result: approved]
- development -> release-approval
- test-preparation -> release-approval
- release-approval -> release [result: approved]
