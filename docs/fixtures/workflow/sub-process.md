# 工作流：复杂方案评审

## 元信息

- key: complex-review
- version: 1
- description: 复杂技术方案的两段评审

## 节点

### 架构评审

- id: architecture
- type: approval
- executor: user:workflow-member
- approver: 用户:flow-owner
- policy: any

### 安全复核

- id: security
- type: approval
- executor: user:flow-owner
- approver: 用户:workflow-member
- policy: any

## 连接

- architecture -> security [result: approved]
