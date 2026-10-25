# 工作流：复杂方案评审

## 元信息

- key: complex-review
- version: 2
- description: 复杂技术方案的两段评审

## 节点

### 架构评审

- id: architecture
- type: approval
- executor: user:flow-member
- approver: 用户:admin
- policy: any

### 安全复核

- id: security
- type: approval
- executor: user:admin
- approver: 用户:flow-member
- policy: any

## 连接

- architecture -> security [result: approved]
