# 工作流：Digital Employee 审批边界

## 元信息

- key: employee-approval
- version: 1
- description: 校验数字员工审批不能被浏览器用户代签

## 节点

### 发布审批

- id: release-approval
- type: approval
- executor: employee:backend-01
- approver: employee:backend-01
- execution: task-worker
- policy: any

## 连接
