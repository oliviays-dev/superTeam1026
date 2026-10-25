# dsh-collab-teammate

AI Teammate 统一管理面。平台归属的 teammate 与个人归属的数字分身共用同一套定义
（名称、专业角色、基础说明、SOUL、场景行为、工作目标、版本与活动记录），归属只决定
可见范围与管理权限。

- 平台归属：平台共享定义，只有管理员可以创建、编辑、生效、失效与归档。
- 个人归属：本人创建与维护，其他人只读。
- 定义版本：草稿为 `v0.1`，首次保存升为 `v1.0`，之后每次保存递增次版本号。
- 运行态：只读聚合指派给该 teammate 的任务；运行中才展示流式进展。
- Principal：每个 AI伙伴绑定一个 AI Principal；首次派发创建 Principal-owned
  Runtime Profile，不再生成 Employee 记录。
- Action Ticket：Task / Workflow 使用 Principal Runtime 派发时签发上下文与资源范围受限的 Ticket。
- 历史迁移：启动时把 Employee Runtime Profile 映射到 Principal Runtime，保留 `employeeId` 只作历史别名。
- 迁移后优先：一旦绑定 `principalId`，后续派发和高优先级状态判断只走 Principal，不回退到 Employee 运行路径。
- 产品入口：AI伙伴自行创建和管理，不依赖员工平台页面。
- 外部 Runtime：注册使用结构化表单描述工具能力、模型池、默认模型、最大上下文窗口、文件修改权限和回合上限；
  AI伙伴定义态绑定唯一执行 Runtime，任务页只能从该 Runtime 模型池选择本轮模型与推理强度；
  高级启动参数默认折叠，只接受额外 argv 文本并实时生成只读命令预览；平台托管参数不暴露编辑。

会议里的「本次嘱咐」不在本插件内存储，落在每次派遣生成的委托上。
