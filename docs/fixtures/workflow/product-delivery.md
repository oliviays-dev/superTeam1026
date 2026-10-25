# 工作流：产品交付

## 元信息

- key: product-delivery
- version: 1
- description: 需求评审后并行开发与测试，最后审批发布
- variable: complexity = 5

## 节点

### 需求评审

- id: requirement-review
- type: approval
- executor: user:workflow-member
- approver: 用户:workflow-member
- policy: any

### 开发

- id: development
- type: task
- executor: agent:backend-agent
- responsible: user:workflow-member
- description: 完成接口、数据结构和回归说明

### 测试准备

- id: test-preparation
- type: task
- executor: user:workflow-member
- description: 准备测试用例和验收清单

### 发布审批

- id: release-approval
- type: approval
- executor: user:flow-owner
- approver: 用户:flow-owner
- approver: 用户:workflow-member
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
