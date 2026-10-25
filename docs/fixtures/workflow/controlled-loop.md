# 工作流：受控返工流程

## 元信息

- key: controlled-loop
- version: 1
- description: 测试失败可返工，但最多三次
- variable: attempts = 1

## 节点

### 需求确认

- id: confirm
- type: task
- executor: user:flow-owner

### 开发

- id: development
- type: task
- executor: agent:backend-agent
- responsible: user:workflow-member

### 测试

- id: testing
- type: approval
- executor: user:workflow-member
- approver: 用户:workflow-member
- policy: any

### 发布就绪

- id: release-ready
- type: service
- executor: system:deployment

## 连接

- confirm -> development
- development -> testing
- testing -> development [result: rejected, break: attempts >= 3]
- testing -> release-ready [result: approved]
