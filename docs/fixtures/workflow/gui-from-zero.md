# 工作流：GUI 从零验收

## 元信息

- key: gui-from-zero
- version: 1
- description: 从零验证审批、人工交付物门禁、二次审批和服务节点

## 节点

### 需求确认

- id: requirement-confirmation
- type: approval
- executor: user:admin
- approver: 用户:admin
- policy: any

### 开发与交付

- id: development
- type: task
- executor: user:flow-member
- responsible: user:flow-member
- description: 提交满足字数要求的实现说明
- deliverable: implementation-report
  title: 实现说明
  type: text
  required: true
  min-text-length: 20
  description: 说明实现范围、验证结果和已知风险

### 发布审批

- id: release-approval
- type: approval
- executor: user:admin
- approver: 用户:admin
- policy: any

### 发布

- id: release
- type: service
- executor: system:deployment

## 连接

- requirement-confirmation -> development
- development -> release-approval
- release-approval -> release
