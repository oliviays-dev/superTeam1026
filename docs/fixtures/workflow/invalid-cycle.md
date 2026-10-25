# 工作流：非法死循环

## 元信息

- key: invalid-cycle
- version: 1
- description: 用于确认导入检查会拒绝没有 break 的循环

## 节点

### 开发

- id: development
- type: task
- executor: user:workflow-member

### 测试

- id: testing
- type: task
- executor: user:flow-owner

## 连接

- development -> testing
- testing -> development
