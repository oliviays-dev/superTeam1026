# 工作流：账号校验负例

## 元信息

- key: validation-negative
- version: 1
- description: 确认模板校验拒绝不存在于平台的用户引用

## 节点

### 需求确认

- id: requirement-confirmation
- type: approval
- executor: user:workflow-member
- approver: 用户:workflow-member
- policy: any

## 连接
