# 工作流：Membership Check

## 元信息

- key: membership-check
- version: 1
- description: 确认平台账号模板校验通过，项目成员资格延迟到启动时检查

## 节点

### Membership Approval

- id: membership-approval
- type: approval
- executor: user:flow-outsider
- approver: 用户:admin
- policy: any

## 连接
