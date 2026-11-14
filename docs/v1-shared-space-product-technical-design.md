# Pluginmax V1 Shared Space 产品与技术方案

> 状态：Batch 19 已实现并通过 Migration、定向 Vitest、完整 Vitest 与
> Playwright 三视口验收
>
> 目标批次：Batch 19
>
> 优先级：P1
>
> 依赖：Batch 14C/14D Principal RBAC、Batch 15B Action Ticket/Gate、Batch 16
> Scene Session、Batch 20A Workspace Administration
>
> 对照基线：`dsh-pluginmax@a702267abfc6baebc7cab7b3045e71c204079e10`
>
> 实现基线：`pluginmax-platform@5b7f7f5bc179ca0435c96126a950e7b3605847f4`
>
> 实际 Migration：33（additive）

## 0. 实施结果

本批已经把设计落为可运行能力，而不是只保留方案：

- Migration 33 新增 Workspace root、路径 policy、文件/版本、lock/claim、
  write/global request、append-only event 与脱敏 digest，并为已有 Workspace
  回填只读 root。
- API、Application、Database 与 Worker 共用 `SharedSpaceApplication` 和
  `SharedSpaceRepository`，没有新增 Principal、Grant、Audit、FileStore 或
  权限模型。
- Web 新增“共享空间”，覆盖目录、上传、读取、下载、版本、revision conflict、
  lock conflict、policy preview、Global Write 审批、审计与 digest。
- Agent 工具只接受逻辑路径、entry ID 和受控字段；写/移动/删除请求绑定
  Action Ticket 与 Execution Gate，Worker 在消费前重新校验 Principal、
  Grant、Scene、Policy、Ticket 和 Gate。
- 完整测试与证据见
  [v1-shared-space-implementation-report-20261028.md](./v1-shared-space-implementation-report-20261028.md)。

## 1. 结论

Shared Space 是 Workspace 级受控文件协作面，不是任务附件的替代品，也不是把
服务器目录直接暴露给用户或 Agent。

产品必须同时满足：

- 用户能看到 Workspace 内的共享目录、文件、策略和审计。
- 默认只读，写入必须经过显式授权。
- 高风险写入经过 Action Ticket 和 Execution Gate。
- Agent 只能通过受控工具接口访问，不接触绝对路径。
- 路径穿越、符号链接逃逸、Locks 竞争和未授权写入 fail closed。
- 文件内容、摘要、审计和下载都受 Workspace/Principal 权限约束。

## 2. 当前基础与缺口

### 2.1 平台已有

- Workspace 主表、Workspace 成员和 Workspace Grant。
- Project RBAC、Action Ticket、Execution Gate、Scene Session。
- Task Attachment、Meeting File、Run Artifact 和 FileStore。
- 只追加身份审计、Run Event、Trace 和 Outbox。
- Agent 执行必须使用 Execution Envelope、Ticket 和 Policy。

### 2.2 实施前缺口（本批已关闭）

- Workspace 共享根和目录树。
- 路径级 Grant 和 deny policy。
- 共享文件版本、摘要和下载隔离。
- Agent 文件读取/写入工具。
- Global Write 审批。
- 文件级 claim、advisory lock 和冲突恢复。
- 共享 Session Digest 和共享文件审计。

### 2.3 与现有文件对象的关系

Shared Space、Task Attachment、Meeting File 和 Run Artifact 保持独立事实：

| 对象 | 归属 | 用途 |
| --- | --- | --- |
| Shared File | Workspace | 长期共享资料和 Agent 协作输入输出 |
| Task Attachment | Task | 任务上下文和验收材料 |
| Meeting File | Meeting | 会议资料和会后归档 |
| Run Artifact | Run | 执行产物和交付证据 |

V1 不做自动双向同步。后续可通过 `source_ref` 把 Task、Meeting 或 Run 文件登记到
Shared Space，但不复制第二份内容。

## 3. 产品目标

1. 用户能在 Workspace 中创建目录、上传文件、读取和下载文件。
2. Workspace 成员默认只能读取明确开放的共享根，不默认获得写权限。
3. Owner/Workspace ADMIN 能配置路径级 allow/deny policy。
4. AI Teammate 能在授权路径内读取资料，并在批准后写入。
5. 并发写入有锁、版本和冲突提示，不静默覆盖。
6. 用户能查看文件写入、读取拒绝、审批和锁操作审计。
7. Session Digest 能总结 Agent 使用过的共享资料，但不包含 secret。
8. 所有敏感操作可追溯到 Principal、Grant、Scene、Run、Ticket 和 Gate。

## 4. 非目标

- 通用网盘、在线文档协作、实时多人富文本编辑。
- 通过浏览器直接访问宿主机绝对路径。
- 开放任意 shell、任意目录写和危险 sandbox。
- 自动同步外部云盘、Git 仓库或对象存储。
- 让 Workspace Grant 隐式获得 Project 权限，或反之。
- 用 Shared Space 代替 15B Ticket/Gate。
- 把正式文件或旧 DSH JSON Storage 数据导入新平台。

## 5. 用户与权限

| 用户 | 默认能力 | 需要显式授权 |
| --- | --- | --- |
| Workspace 普通成员 | 列出和读取默认 read-only 根 | 写指定路径、创建目录、删除 |
| Workspace ADMIN | 配置共享根、路径 policy、查看审计 | 高风险写仍走 Gate |
| Project Owner | 只能访问 Workspace 开放路径 | 不因 Project Owner 身份自动获得写 |
| Agent/Teammate | 通过工具读取授权路径 | 写入、移动、删除、Global Write |
| Platform ADMIN | 管理平台身份，不自动读取文件 | Workspace Grant 或受控运维流程 |
| 非成员 | 无访问 | 无 |

### 5.1 有效权限

```text
read =
  Principal active
  AND Workspace membership active
  AND Workspace read Grant
  AND matching allow policy
  AND no matching deny policy

write =
  Principal active
  AND Workspace write Grant
  AND path write permission
  AND no matching deny policy
  AND (human browser write OR valid Action Ticket)
```

规则：

- deny 永远优先于 allow。
- 路径 policy 不能扩大 Workspace Grant。
- Agent 写操作必须绑定 Workspace、Actor、路径、Run、Scene 和 Ticket。
- Ticket 过期或上下文变化后重新校验。
- 下载和列表使用同一路径权限，不允许通过文件 ID 绕过。

## 6. 用户历程

### 6.1 Owner 建立共享资料区

1. Workspace ADMIN 打开“共享空间”。
2. 系统显示默认 Workspace 共享根、当前权限摘要和审计入口。
3. 管理员创建 `projects/alpha/` 和 `research/` 两个目录。
4. 默认成员对 `projects/alpha/` 只读。
5. 给项目成员添加 `research/` 读取 policy。
6. 给 AI Teammate 添加 `research/drafts/` 读写 policy。
7. 页面展示有效权限预览，说明哪些主体能读、能写。

### 6.2 用户上传和更新文件

1. 用户进入目标目录，点击“上传文件”或“新建 Markdown”。
2. 服务端规范化路径并执行 secret scan。
3. 写入成功后生成新 version、sha256 和审计事件。
4. 文件列表显示更新时间、更新人、大小和当前 revision。
5. 两个用户同时更新时，后提交者收到 revision conflict，不静默覆盖。

### 6.3 Agent 读取共享资料

1. Teammate Run 获得 Scene Context 和委托材料范围。
2. Agent 调用 `shared_space.list` 或 `shared_space.read`。
3. 服务端检查 Workspace、Principal、Grant、路径 policy、Run 和 Ticket。
4. 读取事件写 audit，只记录路径、hash、Actor 和结果，不记录正文。
5. 文件内容进入 ContextPack 时生成受限 source ref。

### 6.4 Agent 写入和审批

1. Agent 请求写入 `research/drafts/report.md`。
2. 服务端发现该路径需要 blocking Gate。
3. 创建 `write` Gate，展示目标路径、文件 hash、diff 摘要和 Ticket Scope。
4. Owner 批准后 Worker 重新校验 Ticket、Gate revision、文件 revision 和锁。
5. 写入成功，生成版本和审计。
6. Gate 拒绝、过期、Ticket 失效或锁冲突时不得写入。

### 6.5 Global Write

1. 用户或 Agent 请求写到 Workspace 根之外的全局限定目录。
2. 系统创建 Global Write Request。
3. 审批人看到来源 Workspace、目标路径、文件 hash、用途和过期时间。
4. 批准后签发短期 Ticket，只允许一次受控写入。
5. 请求不可重放，写入结果和审计可追溯。

## 7. 信息架构

Workspace 下新增“共享空间”入口：

```text
共享空间
├── 文件
│   ├── 目录树
│   ├── 搜索
│   ├── 上传/新建
│   └── 文件详情
├── 策略
│   ├── 路径规则
│   ├── 主体与角色
│   └── 有效权限预览
├── 全局写入
│   ├── 待审批
│   └── 历史
├── 锁与占用
└── 审计与摘要
```

### 7.1 文件列表

字段：

- 路径、名称、目录/文件。
- 大小、MIME、更新时间、更新人。
- 当前 revision、sha256 摘要。
- 当前锁状态和持锁主体。
- 当前用户的有效权限。

操作：

- 进入目录。
- 预览文本、Markdown、图片和受支持文档。
- 下载。
- 编辑或上传新版本。
- 查看版本与审计。
- 获取/释放锁。

### 7.2 策略编辑

规则字段：

- Subject：Principal、Workspace ADMIN、Workspace MEMBER 或 Project Role。
- Path pattern：规范化相对路径 glob。
- Permissions：`list`、`read`、`write`、`delete`。
- Effect：`allow` 或 `deny`。
- Expiry：可选。

UI 必须提供解释器预览：

```text
Principal: principal-ai-researcher
Path: research/drafts/**
Result: write allowed
Reason: allow policy + Workspace write Grant + Scene/Ticket valid
```

### 7.3 审计

默认列：

- 时间。
- Actor 和 Principal 类型。
- 操作：list/read/write/delete/lock/claim/approve/deny。
- 路径。
- 结果和 reason。
- Run/Ticket/Gate ID。
- 文件 version/hash。

不展示：

- 完整文件正文。
- Credential、Token、Cookie。
- 未脱敏的敏感内容。

## 8. 技术架构

```text
Web
  -> API Auth / Workspace Authorization
  -> SharedSpaceApplication
  -> PolicyEvaluator + ActionTicketService + GateService
  -> SharedSpaceRepository
  -> FileStore
  -> Audit / Outbox

Agent Tool
  -> Tool Gateway
  -> Scene/Ticket validation
  -> SharedSpaceApplication
```

职责：

- Web 不提供绝对路径。
- Application 负责路径规范化、策略计算、版本、锁和审批编排。
- Repository 负责事务和数据库事实。
- FileStore 负责受控内容存储，不拥有权限。
- Agent Tool 不允许直接访问 FileStore 或数据库。

## 9. 数据模型

Migration 使用下一个可用加法编号，不预先写死为 33。

### 9.1 `shared_space_roots`

| 字段 | 说明 |
| --- | --- |
| `workspace_id` | 主键，关联 Workspace |
| `storage_prefix` | 平台生成的逻辑存储前缀，不接受绝对路径 |
| `status` | `active / archived` |
| `default_read` | 默认 `true`，仅对 active Workspace members |
| `default_write` | 固定 `false` |
| `version` | 乐观锁 |
| `created_at / updated_at` | 时间 |

### 9.2 `shared_space_policies`

| 字段 | 说明 |
| --- | --- |
| `id` | UUID |
| `workspace_id` | Workspace |
| `subject_kind` | `principal / workspace-role / project-role` |
| `subject_id` | Principal ID、角色 ID |
| `path_pattern` | 规范化相对路径 |
| `permissions` | JSONB 数组 |
| `effect` | `allow / deny` |
| `expires_at` | 可空 |
| `created_by / created_at` | 审计 |

索引：`(workspace_id, subject_kind, subject_id, effect)`。

### 9.3 `shared_space_entries`

| 字段 | 说明 |
| --- | --- |
| `id` | UUID |
| `workspace_id` | Workspace |
| `path` | 规范化相对路径 |
| `kind` | `file / directory` |
| `status` | `active / archived` |
| `current_version` | 文件 revision |
| `sha256` | 文件 hash，目录为空 |
| `size` | 字节数 |
| `mime_type` | MIME |
| `storage_key` | 平台生成，不暴露给用户 |
| `created_by / updated_by` | Principal |
| `created_at / updated_at` | 时间 |

唯一约束：`(workspace_id, path)`。

### 9.4 `shared_space_versions`

只追加保存文件版本：

- entry_id、version、sha256、size、mime_type。
- storage_key。
- created_by、created_at。
- source_run_id、ticket_id、gate_id。

唯一约束：`(entry_id, version)`。

### 9.5 `shared_space_locks`

| 字段 | 说明 |
| --- | --- |
| `workspace_id` | Workspace |
| `path` | 锁路径 |
| `owner_principal_id` | 持锁主体 |
| `owner_session_id` | 可空 |
| `run_id / challenge_id` | Agent 执行来源 |
| `mode` | `exclusive / shared` |
| `status` | `active / released / expired` |
| `lease_expires_at` | 租约 |
| `version` | 乐观锁 |

active 锁按 `(workspace_id, path, mode)` 建立唯一/冲突约束。

### 9.6 `shared_space_global_requests`

- 来源 Workspace、Actor、目标逻辑路径。
- 内容 sha256、size、用途。
- policy revision、ticket id、gate id。
- status：`pending / approved / rejected / expired / consumed`。
- expiry、decision actor、decision reason、timestamps。

### 9.7 `shared_space_events`

append-only 审计事件：

- Workspace、Actor Principal。
- action、path、entry_id、version。
- decision、reason。
- run_id、ticket_id、gate_id。
- metadata JSONB，禁止正文和 secret。

### 9.8 `shared_space_digests`

- Workspace、scene/session 范围。
- digest date 或 revision。
- 脱敏摘要正文。
- source event range。
- generated_at。

## 10. 路径与文件安全

### 10.1 路径规范化

必须拒绝：

- 绝对路径。
- 反斜杠路径。
- `.` 和 `..` 段。
- 空段、NUL、控制字符。
- 超出长度限制。
- 大小写归一化后冲突。
- Windows 保留名和设备名。
- 指向共享根外的符号链接。

必须执行：

- Unicode 规范化。
- 最大深度限制。
- 每段字符白名单。
- `realpath` 后验证仍在共享根内。
- 根目录和存储前缀不接受用户输入。

### 10.2 Secret Scan

写入前至少检测：

- API key、私钥、Bearer Token、密码字段。
- 云厂商访问密钥特征。
- `.env` 和常见 credential 文件。

命中时：

- 默认拒绝。
- 返回可理解错误和脱敏命中类别。
- 不把原文写入日志。
- 管理员不能通过普通 UI 绕过；如确需受控例外，必须走独立 Gate。

### 10.3 文件限制

- 单文件大小上限可配置。
- 文本预览和二进制下载分离。
- HTML/SVG/脚本等主动内容默认附件下载，不内联执行。
- MIME 以服务端检测和扩展名双重校验。
- 上传文件名与展示名分离。

## 11. API

### 11.1 空间与策略

```text
GET    /api/v1/workspaces/:workspaceId/shared-space
PATCH  /api/v1/workspaces/:workspaceId/shared-space
GET    /api/v1/workspaces/:workspaceId/shared-space/policies
POST   /api/v1/workspaces/:workspaceId/shared-space/policies
PATCH  /api/v1/workspaces/:workspaceId/shared-space/policies/:policyId
DELETE /api/v1/workspaces/:workspaceId/shared-space/policies/:policyId
POST   /api/v1/workspaces/:workspaceId/shared-space/policy-preview
```

### 11.2 文件

```text
GET    /api/v1/workspaces/:workspaceId/shared-space/files?path=
POST   /api/v1/workspaces/:workspaceId/shared-space/files
GET    /api/v1/workspaces/:workspaceId/shared-space/files/:entryId
GET    /api/v1/workspaces/:workspaceId/shared-space/files/:entryId/content
GET    /api/v1/workspaces/:workspaceId/shared-space/files/:entryId/download
PUT    /api/v1/workspaces/:workspaceId/shared-space/files/:entryId/content
POST   /api/v1/workspaces/:workspaceId/shared-space/files/:entryId/archive
GET    /api/v1/workspaces/:workspaceId/shared-space/files/:entryId/versions
```

### 11.3 锁与声明

```text
GET    /api/v1/workspaces/:workspaceId/shared-space/locks
POST   /api/v1/workspaces/:workspaceId/shared-space/locks
DELETE /api/v1/workspaces/:workspaceId/shared-space/locks/:lockId
POST   /api/v1/workspaces/:workspaceId/shared-space/claims
```

### 11.4 Global Write 与审计

```text
GET    /api/v1/shared-space/global-write-requests
POST   /api/v1/shared-space/global-write-requests
POST   /api/v1/shared-space/global-write-requests/:requestId/decision
GET    /api/v1/workspaces/:workspaceId/shared-space/audit
GET    /api/v1/workspaces/:workspaceId/shared-space/digests
```

### 11.5 错误码

```text
shared_space_forbidden
shared_space_path_invalid
shared_space_path_escape
shared_space_secret_detected
shared_space_version_conflict
shared_space_lock_conflict
shared_space_lock_expired
shared_space_gate_required
shared_space_gate_rejected
shared_space_file_too_large
shared_space_mime_rejected
shared_space_ticket_invalid
shared_space_global_request_exists
shared_space_global_request_consumed
```

## 12. Agent Tool Contract

只暴露逻辑路径和受控操作：

```text
shared_space_list({ workspaceId, path })
shared_space_read({ workspaceId, entryId })
shared_space_write({ workspaceId, path, content, expectedVersion })
shared_space_move({ workspaceId, entryId, targetPath })
shared_space_delete({ workspaceId, entryId, expectedVersion })
shared_space_lock({ workspaceId, path, mode, leaseSeconds })
shared_space_release_lock({ workspaceId, lockId })
```

工具规则：

- 不接受绝对路径、storage key 或 shell command。
- 每次调用都携带 Scene、Run、Actor、Ticket。
- 写操作只能返回业务结果，不返回内部存储位置。
- 工具默认超时和输出大小有限制。
- 读取正文进入模型上下文前应用 source scope 和脱敏策略。

## 13. 状态与并发

### 13.1 文件状态

```text
active -> archived
active -> active (new version)
archived -> active (admin restore)
```

删除使用 archive，不物理删除审计和历史版本。

### 13.2 Lock 状态

```text
active -> released
active -> expired
expired -> new active
```

租约过期后：

- 不恢复旧写入。
- 新持有者必须基于最新文件 revision。
- 旧 Writer 提交时收到 stale lease。

### 13.3 写入事务

```text
authorize
  -> normalize path
  -> scan secret
  -> acquire lock or use compare-and-swap
  -> validate expected version
  -> persist content to FileStore staging
  -> insert version + update entry
  -> append audit/outbox
  -> commit
  -> publish derived event
```

文件内容写入和数据库事务无法共享单个 ACID 事务，因此：

- 内容先写 staging。
- 数据库成功后提交最终 storage key。
- 失败时清理 staging。
- 定时维护任务清理孤儿内容。

## 14. Migration

实际使用下一个加法 Migration 33，并保持在已有 Workspace、身份、Project、
Task、Run、Ticket、Gate 和 Scene 语义之上：

1. 新建 roots、policies、entries、versions、locks、global requests、events、digests。
2. 为已有 Workspace 创建 `shared_space_roots`，状态 active，默认只读。
3. 不回填任何宿主目录内容。
4. 不回填旧 DSH Shared Space 数据。
5. 默认写权限为空。
6. 索引覆盖 policy lookup、path、lock lease、audit query。

升级门禁：

- fresh `0 -> N`。
- `N-1 -> N`。
- 已有 Workspace 获得 root。
- Migration 33 的 upgrade fixture 明确覆盖“已有 Workspace 获得默认只读
  root”；不依赖临时 `workspace_members` 推断。
- 已有 Project、Task、Meeting、Run 和审计不受影响。

## 15. 测试

### 15.1 Database

- 路径唯一、版本唯一、active lock 冲突。
- policy deny-wins。
- 审计 append-only。
- Global Request 最多消费一次。
- Workspace 归档后拒绝写入。

### 15.2 API

- 未认证、非成员、跨 Workspace。
- Platform ADMIN 无 Workspace Grant。
- revoked/expired Grant。
- 路径穿越、反斜杠、Unicode、符号链接。
- secret scan、大小和 MIME。
- 文件 ID 与路径不能绕过授权。
- 并发写 revision 冲突。

### 15.3 Worker/Agent

- 无 Ticket 写入拒绝。
- Ticket 路径、Actor、Workspace、Scene 不匹配拒绝。
- Gate 拒绝、过期、取消拒绝。
- 读写工具超时和输出限制。
- Worker 重启后锁恢复与过期。

### 15.4 GUI

- 目录浏览、上传、读取、下载。
- 策略编辑和有效权限预览。
- 冲突和锁提示。
- Gate 审批后恢复。
- 1440、900、390 三视口。

## 16. 发布门禁

必须全部满足：

- 默认只读。
- 未授权写零放行。
- 路径穿越和 symlink 逃逸零放行。
- secret 默认拒绝。
- Global Write 必须绑定 Gate、Ticket、Actor、Workspace 和 Scope。
- 锁竞争和过期恢复有负向测试。
- 文件下载和列表无跨 Workspace 泄露。
- 审计不含正文、secret 或绝对路径。

## 17. 分期

四个阶段均已在 Batch 19 落地；后续只允许在保持以下语义不变的前提下扩展。

### Phase 1：只读共享

- Workspace 共享根。
- 目录/文件读取和下载。
- 默认只读 policy。
- audit。

### Phase 2：受控人类写

- 上传、更新、archive。
- revision conflict。
- Workspace write Grant。

### Phase 3：Agent 与 Locks

- Tool Gateway。
- Lock/Claim。
- Scene/Ticket 校验。
- Digest。

### Phase 4：Global Write

- 全局限定目录。
- 审批请求。
- 一次性 Ticket。

## 18. 风险

| 风险 | 控制 |
| --- | --- |
| 文件路径逃逸 | 规范化、realpath、根目录 containment |
| Secret 泄漏 | 写前扫描、日志脱敏、禁止正文审计 |
| 并发覆盖 | version + lock + CAS |
| Agent 越权 | Grant ∩ policy ∩ Scene ∩ Ticket |
| Global Write 扩大权限 | 一次性 Gate + 短期 Ticket |
| 文件与 DB 不一致 | staging、Outbox、孤儿清理 |
| 大文件拖垮 API | 限流、大小限制、流式下载 |

## 19. 完成定义

- 用户可以完成 Workspace 文件浏览、读取、上传和审批写入。
- Agent 只能通过受控工具访问。
- 所有拒绝、写入、审批和锁操作可追溯。
- 安全负向测试全部通过。
- 三视口 GUI 可用。
- Shared Space 从 `MISSING` 变为 `EQUIVALENT` 或 `STRONGER`。

当前判断：平台侧已从 `MISSING` 变为 `STRONGER`。平台额外提供 PostgreSQL
revision/version、deny-wins path policy、Action Ticket/Gate 绑定、append-only
审计、一次性 Global Write 和 Worker 恢复；受控 Agent 工具不暴露 storage key
或 shell command。
