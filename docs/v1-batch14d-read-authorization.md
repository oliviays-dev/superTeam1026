# V1 Batch 14D: RBAC 读授权闭环与 Project Capability

> 状态：Project、Task、Run、Workflow、Meeting、Memory、Report、Handoff、
> Attachment、Artifact、Trace、SSE 与跨项目聚合读入口已接入统一授权。
> Platform ADMIN 仍不绕过 Project Grant。Migration 24 足够，本批未新增
> Migration 25，未执行旧数据 backfill，未修改 Batch 14B Password/Session
> 语义。

## 1. 单一授权事实

读授权继续使用 14C 的 `AuthorizationRepository` 与
`AuthorizationService`，没有建立第二套权限系统。

```text
Bearer Session / local-development Principal
  -> trusted Principal
  -> AuthorizationService read route mapping
  -> AuthorizationRepository resource -> Project resolution
  -> active membership + active Project Grant
  -> Application read method
```

`AuthorizationService.authorizeRoute` 对 GET/HEAD 进行集中路由映射：

- Project 路径参数或白名单列表的 `projectId` 查询参数映射到 `read`。
- Task、Run、Workflow Instance、Meeting、Attachment、Artifact、Trace 等资源
  先由 `AuthorizationRepository.projectIdsForResource` 解析所属 Project。
- Trace 可关联多个 Project；只有每个 Project 都可读时才允许返回。
- 无 Project 的 direct-chat Run 保持既有 self boundary，由 Direct Chat
  应用层继续校验归属。

Handler 不拼接临时 Project 权限规则。Application 仍需 owner/manage 的写方法
保持原写门禁；纯读方法改为 Project read。

## 2. 读资源范围

| 资源 | 读入口 | Project 来源 |
| --- | --- | --- |
| Project | 列表、详情、Capability、Roles、Members、Authorization Report | Project ID |
| Task | 列表、详情、dependency/messages/attachments 聚合、Task Runs | Task |
| Run | 详情、events、input/context/artifacts、SSE stream | Run |
| Workflow | 定义列表、实例列表/详情、audit | Workflow / Instance / query |
| Meeting | 列表、详情、AI Policy、Minutes、Action Items、Traceability | Meeting |
| Memory | Topic、Claim Trace、Review queue、Agent Episode | Project |
| Report | 列表、详情、项目内搜索 | Project + Report |
| Handoff | 列表、详情 | Project + Handoff |
| Attachment | task attachment download | Task Attachment |
| Artifact | artifact download | Artifact |
| Trace | trace projection | 所有关联 Run 的 Project |
| Workbench | Dashboard、Brief、Follows、项目风险列表 | 可读 Project 集合 |

项目列表与无 `projectId` 的 Task 批量列表只返回 Principal 可读项目的数据。
Workbench Dashboard/Brief 每次按当前 Grant 重新计算可读项目；旧 Brief 不会继续
暴露已撤销项目的数据。

archived Project 仍允许成员只读历史；写操作继续统一返回
`409 project_archived`。Capability 对 archived Project 只开放 `read`。

## 3. Project Capability

新增：

```text
GET /api/v1/projects/:projectId/capability
```

仅 Project read 可用。响应至少包含：

```json
{
  "projectId": "...",
  "principalId": "...",
  "capabilities": {
    "read": true,
    "write": false,
    "approve": false,
    "manage_members": false,
    "manage_roles": false
  },
  "ownerSources": {
    "legacy": false,
    "grant": false,
    "consistent": true
  },
  "effectivePermissions": ["read"],
  "grantSource": "grant",
  "membershipId": "...",
  "membershipStatus": "active"
}
```

`ownerSources.consistent` 复用 14C 的 legacy owner / explicit owner Grant
一致性语义。Capability 是 Web 展示辅助，不是授权事实；服务端预授权仍是最终
边界。

## 4. Web

- App 按当前项目请求 Capability。
- Project 设置按 `write` 禁用。
- 成员与角色操作分别按 `manage_members` / `manage_roles` 禁用。
- Task 创建、编辑、派发、附件、评论按 `write`；Review 按 `approve`。
- Workflow 创建/导入/启动/运行控制按 `write`；审批按 `approve`。
- Meeting 创建、消息、AI Policy、Action Item 按 `write`；纪要发布按
  `approve`。
- Memory Review/Truth、Report 生成按 `approve`。

Bearer 模式下 Run SSE 改为携带 Authorization Header 的 fetch stream；Task
Attachment 与 Artifact 下载也使用认证请求，不再依赖裸 `EventSource` 或无认证
链接。

## 5. Grant 与 Principal 语义

- revoked / expired Project Grant 不产生 read 权限。
- Workspace Membership/Grant 不映射为 Project 权限。
- Platform ADMIN 没有 Project membership/read Grant 时不能读取该项目。
- disabled Account、archived Principal 在认证阶段拒绝。
- AI Principal 必须有 active Project membership 与 read Grant；local-development
  的普通 actor 不能被当作 AI Principal 冒充。
- 不信任 `x-pluginmax-actor` 作为 Bearer 回退；伪造 trusted Header 被删除。

## 6. Migration 与回滚

Migration 24 已包含：

- `principals` / `accounts` / `auth_sessions`
- `workspace_members`
- `principal_aliases`
- `role_grants`
- `identity_audit_events`
- `project_members.principal_id`

14D 只新增查询与投影，不需要新的表、列或索引，因此不新增 Migration 25。

回滚：

1. 回滚应用提交即可恢复旧读消费；Migration 24 数据保留。
2. 本批没有 backfill 脚本，也没有 `migration_run_id`。
3. 不删除审计和 Grant 历史。
4. 恢复旧版本不会恢复 Bearer Header actor 回退。

## 7. 本批边界

未实现：

- TaskExecutionPolicy
- Action Ticket / Execution Gate
- Scene Context
- Shared Space
- sandbox

本批不声称 Batch 15A / 15B 已完成。

## 8. 验证

- Repository / Application / API 读授权矩阵。
- 完整 Vitest。
- 非成员、跨项目、archived Project、archived Principal、disabled Account、
  revoked/expired Grant、workspace-only Grant、AI Principal、Platform ADMIN
  跨项目读测试。
- 列表、项目内搜索、附件下载、Artifact 下载、Trace、SSE 与 Workbench 泄露测试。
- Playwright 多 Principal 读隔离与 Capability 禁用场景。
- Web production build、typecheck、lint、相关 package/API 构建与
  `git diff --check`。
