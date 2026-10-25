# AI Teammate 技术方案

交互依据：`docs/demos/task-management-demo.html` 的 AI Teammates 模块。

> 2026-10-17 方向调整：AI 伙伴的目标身份不再是数字员工，而是 AI Principal 的产品投影。当前 `employeeId`、`collab_employee` 和数字员工状态属于迁移期兼容字段；后续统一为 `principalId`，并保持 `employeeId` 兼容别名。平台不建设独立 Employee 产品域。新方案见 `docs/platform-principal-rbac-design.md`。

## 1. 设计原则

1. **一份定义**。平台归属与个人归属的 AI Teammate 共用同一套定义字段，归属只决定可见范围与管理权限，不产生第二套模型。
2. **定义与委托分离**。定义层是长期身份（是谁、SOUL、场景、目标、版本、生命周期）；委托层（delegation）是某次会议 / 任务 / 评审的「本次嘱咐」与授权，可随时修改直到委托结束。
3. **运行态只读聚合**。AI Teammates 页的运行态不复制任务数据，只按接收方聚合任务并读最新进展。
4. **权限最小化**。个人归属只有本人可维护；平台归属只有平台管理员可维护，其余人只读。

## 2. 数据模型

域 `collab_teammate`（version 1），两张表。

### 2.1 `teammates`

| 字段                                    | 说明                                                    |
| --------------------------------------- | ------------------------------------------------------- |
| `id`                                    | `tm-<uuid>`                                             |
| `source`                                | `platform` / `personal`，即归属                         |
| `name` / `role`                         | 名称、专业角色                                          |
| `ownerUserId` / `ownerName`             | 个人归属为本人；平台归属记录创建者，展示为「平台」      |
| `description`                           | 基础说明                                                |
| `soul`                                  | SOUL.md 原文                                            |
| `scenarios[]` / `goals[]`               | 场景行为、工作目标                                      |
| `avatar`                                | 头像预置 id 或 `data:image/...`                         |
| `state`                                 | `draft` / `active` / `paused` / `inactive` / `archived` |
| `version`                               | `v<major>.<minor>`                                      |
| `personaId` / `employeeId`              | 可选；平台 DE 通过 `employeeId` 关联现有数字员工        |
| `createdBy` / `createdAt` / `updatedAt` | 审计字段                                                |

### 2.2 `events`

定义变更与状态流转的时间线：`id`、`teammateId`、`seq`、`at`、`actorUserId`、`actorName`、
`kind`（`created` / `updated` / `state` / `archived`）、`message`。`seq` 递增，保证同一毫秒内多次写入的顺序稳定。

### 2.3 与其他域的关系

- 平台 DE：`employeeId` 指向 `collab_employee` 的数字员工，运行时（工作区角色、Runtime Profile、ActionTicket）仍由员工域负责。定义以 teammate 为准，员工域只承载运行时身份。
- SOUL：当前由 teammate 记录承载；后续如需与 `collab_roles` 的 persona 共用，通过 `personaId` 关联并保持 SOUL 单向同步，避免双写。
- 委托：会议 / 任务的「本次嘱咐」存在 `collab_employee.delegations`，teammate 侧不重复存储。

## 3. 权限

| 操作                   | 个人归属                           | 平台归属     |
| ---------------------- | ---------------------------------- | ------------ |
| 查看                   | 所有登录用户                       | 所有登录用户 |
| 新建                   | 任意登录用户                       | 仅管理员     |
| 编辑 / 状态流转 / 归档 | 仅 owner 本人                      | 仅管理员     |
| 草稿改归属             | owner 本人；改成平台归属需要管理员 | —            |

管理员判定沿用现有身份服务：`role === "admin"`。

## 4. 状态机与版本

```
draft ──保存──> inactive ──生效──> active ──暂停──> paused ──重启──> active
                    │                  │                 │
                    └────────── 失效 ───┴──── 归档 ───────┘
```

- 允许流转：`draft → inactive | archived`；`inactive → active | archived`；`active → paused | inactive | archived`；`paused → active | inactive | archived`；`archived` 为终态。
- 草稿不能被直接生效，必须先保存。
- 版本：草稿为 `v0.1`；首次保存升为 `v1.0`；之后每次保存次版本号 +1。
- 平台归属的编辑、生效、失效会作用到全平台实例，前端需二次确认。

## 5. API

全部挂在 `/api/collab/teammates`，要求同源 + Bearer token。

| 方法 | 路径                                        | 说明                                                                                             |
| ---- | ------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| GET  | `/api/collab/teammates`                     | 定义列表 + `canManagePlatform`                                                                   |
| GET  | `/api/collab/teammates/detail?teammateId=`  | 定义详情 + 变更事件                                                                              |
| GET  | `/api/collab/teammates/runtime?teammateId=` | 只读聚合该 teammate 的任务                                                                       |
| POST | `/api/collab/teammates/create`              | `{ source, name?, role? }`                                                                       |
| POST | `/api/collab/teammates/update`              | 定义字段；草稿可带 `source` 改归属                                                               |
| POST | `/api/collab/teammates/profile`             | 实例资料 `{ teammateId, name, description }`；不动人设内容与版本                                 |
| POST | `/api/collab/teammates/leave-workspace`     | `{ teammateId, workspaceId, scope, assignmentId? }`；退出项目/项目角色，退出项目时改派未完成任务 |
| POST | `/api/collab/teammates/state`               | `{ teammateId, state }`                                                                          |

错误码沿用 `EmployeeError` 风格：`invalid_input` / `unauthorized` / `forbidden` / `not_found` / `conflict`。

## 6. 客户端

- 入口：shell 全局导航新增 `AI Teammates`（route `teammates`），页面注册在 `pluginmax.global`。
- 结构：页头（标题 + 平台管理员徽标 + 新建 Teammate）→ 运行态 / 定义态切换 → 左目录（平台归属 / 个人归属）→ 右详情。
- 运行态：当前跟进事项（按状态排序）、已归档分组、最近活动；只有 `running` 的任务才渲染 spinner 与流式文案。
- 定义态：只读信息（归属、定义版本、基础说明、SOUL、场景、目标、最近变更）与操作（编辑、暂停 / 全局失效、生效 / 重启、失效、归档）。
- 编辑态：头像预置 / 上传、名称、专业角色、归属（草稿可选）、当前版本、基础说明、SOUL.md 上传与编辑、场景行为、工作目标。
- 视觉：结构与尺寸按 demo，颜色统一走 `--dsw-alias-*`，状态色沿用 demo 的绿 / 琥珀 / 紫。

## 7. 运行态数据来源

- 判定归属：`receiverType === "agent"` 且 `receiverId` 等于 `teammate.id`，或平台 DE 的 `employeeId`。
- 只聚合调用者有权限的工作区（管理员可见全部，成员仅自己加入的）。
- 最新进展取任务消息中最后一条非空内容；没有消息时回退到任务描述。
- `running` 目前由「任务进行中且接收方为 agent」推导；接入 Agent Run 后可改为读 run 状态。

## 8. 与会议的关系

- 会议侧栏只保留聊天与历史记录；本次嘱咐、派遣、参与人增减在中间区域维护。
- 「本次嘱咐」是 delegation 的字段（目标、立场、关注点、发言策略、有效期），不是 teammate 定义。
- 委托进入 `completed` / `revoked` 后嘱咐只读；`active` / `expired`（可延期恢复）仍可修改。
- 会议关闭会停止分身发言、生成分身报告，并让委托进入 `completed`。

## 9. 尚未实现 / 下一步

1. 个人分身按项目一条家会话出现在左侧项目树（需要会话侧接线）。
2. 平台 DE 独立汇报线：当前自动开通的数字员工以「当前管理员」为 manager，后续接入独立汇报线。
3. 运行态接 Agent Run 实时进度（当前为任务消息轮询）。
4. 从运行态跳转任务详情（已预留 `pluginmax:navigate` 与 `window.__pluginmaxPendingTask`）。

## 10. 任务侧接入（已实现）

- 任务接收方目录（`/api/collab/tasks/bootstrap` 的 `directory.agents`）同时返回可指派的 AI Teammate：
  - 平台归属：对所有人可见；
  - 个人归属：仅 owner 本人可见；
  - 只有 `active`（已生效）的 teammate 才会出现。
- 指派给 teammate 时，任务服务先尝试按数字员工派发；失败则调用 `collabTeammateRuntime.ensureRuntime`，
  按 teammate 定义自动开通运行时身份后再派发，随后所有任务复用同一个数字员工。
- 自动开通步骤：persona（来自 teammate 的 SOUL）→ Agent Profile → 数字员工（manager：个人归属为 owner，
  平台归属为当前管理员）→ 置为 active → 授予工作区 `member` 角色 → 写入 Runtime Profile（
  `legacyAgentProfileId` 指向 Agent Profile）→ 回写 teammate 的 `employeeId`。
- teammate 未生效、或 manager 没有可用员工档案时，任务会以可读原因失败，而不是静默不派发。
