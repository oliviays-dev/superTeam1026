# Pluginmax V1 Workbench 配置与 Brief SSE 产品与技术方案

> 状态：设计方案，尚未实现
>
> 目标批次：Batch 20 Workbench 部分
>
> 优先级：P1
>
> 依赖：Batch 11A Workbench Reports、Batch 14D 读授权、Identity Principal、
> 现有 Workbench Brief 不可变快照
>
> 对照基线：`dsh-pluginmax@a702267abfc6baebc7cab7b3045e71c204079e10`

## 1. 结论

当前平台已有可用的固定 Workbench。此次补齐的是“让 Workbench 成为个人工作面”的
能力：

- 模块拖拽排序。
- 六档宽度和高度。
- 命名布局、切换、设默认、恢复。
- 模块级刷新和加载/空/stale/partial error。
- Brief 通过 SSE 增量更新，而不是 15 秒轮询。

V1 建议把布局保存到服务端，按 Principal 隔离，并在浏览器保留本地恢复副本。
这与 DSH 的纯 `localStorage` 实现不同，是为了支持刷新恢复、跨设备和权限变化后的
一致体验。

## 2. 当前基础与缺口

### 2.1 当前平台已有

- `WorkbenchDashboard` 聚合接口。
- Brief 不可变快照、已读状态和更新频次。
- Follows、Supply Exception、Supplier Risk。
- Project Report 来源引用。
- Read authorization 和可读 Project 过滤。
- 响应式 1440、900、390 样式。
- 15 秒 React Query 轮询。

### 2.2 当前缺口

- 模块顺序和宽高固定。
- 没有命名布局。
- 没有默认布局与恢复。
- 没有服务端布局 revision。
- 不能模块级刷新。
- 没有统一 stale/partial error envelope。
- Brief 没有 SSE 增量事件和断线续传。
- 当前所有模块依赖一个 dashboard query，单模块失败影响较大。

## 3. 产品目标

1. 用户打开 Workbench 后 5 秒内看到最高优先级事项。
2. 用户可按工作习惯排列模块、宽度和高度。
3. 用户可保存多套布局并设置默认。
4. 页面刷新、跳转返回后恢复布局、滚动位置和模式。
5. 每个模块独立刷新，不阻塞其他模块。
6. 模块失败时保留旧数据并显示局部错误。
7. Brief 更新能在数秒内自动到达，断线后可续传。
8. 权限撤销后模块立即不可读，不展示旧缓存数据。

## 4. 非目标

- 任意用户创建组织公开仪表盘。
- 工作台内完成复杂任务编辑。
- 自定义任意第三方模块或代码。
- 组织级布局下发和团队共享布局，首版不做。
- 用 SSE 自动执行建议或审批。
- 用前端缓存替代服务端权限。
- 管理驾驶舱完整 BI 建模。

## 5. 用户与权限

| 用户 | 能力 |
| --- | --- |
| 普通成员 | 管理自己的布局，查看有权 Project 的数据 |
| 项目 Owner | 同上，可关注项目和查看项目报告 |
| Workspace ADMIN | 不自动获得 Project 数据 |
| Platform ADMIN | 不自动获得 Project 数据 |
| AI/Agent | 不作为布局主体，只产生 Brief 内容和建议 |

布局属于个人偏好，不属于 Workspace Grant 或 Project Grant。业务数据仍按资源权限过滤。

## 6. 信息架构

```text
工作台
├── 我的工作台
│   ├── 布局管理
│   ├── 恢复默认
│   ├── 模块网格
│   │   ├── 核心指标
│   │   ├── 每日简报
│   │   ├── 我的待办
│   │   ├── 重点关注
│   │   ├── 会议纪要
│   │   ├── 执行异常
│   │   ├── 供给例外
│   │   ├── 供应商风险
│   │   └── 项目报告
│   └── 模块详情/返回上下文
└── 管理驾驶舱
    └── 当前占位入口
```

## 7. 产品规则

### 7.1 模块定义

每个模块声明：

```ts
interface WorkbenchModuleDefinition {
  id: WorkbenchModuleId;
  title: string;
  defaultCols: 1 | 2 | 3 | 4 | 5 | 6;
  minHeight: number;
  maxHeight: number;
  refreshable: boolean;
  requiredCapability: "read";
  sourceKinds: WorkbenchSourceKind[];
}
```

模块：

- `metrics`
- `brief`
- `todo`
- `focus`
- `meeting-minutes`
- `control`
- `supply`
- `supplier`
- `reports`

### 7.2 宽度

六档：

```text
1/6、1/3、1/2、2/3、5/6、1
```

规则：

- 宽度只能吸附合法档位。
- 最小 1/6。
- 模块内部内容不能撑破网格。
- 1/3 宽度下标题、状态、刷新按钮保持单行。
- 小屏使用单列，但持久化仍保存桌面六档值。

### 7.3 高度

- 最小 190px。
- 最大 900px。
- `null` 表示内容自适应。
- 调整高度后模块内部独立滚动。
- 高度变化不得导致页面关键按钮跳动。

### 7.4 拖拽排序

- 标题栏除按钮和控件外为拖拽热区。
- 拖动中显示目标插入位置。
- 放到目标位置后立即更新当前布局。
- 刷新后保留。
- 键盘用户可通过“上移/下移”操作完成同样功能。
- 拖拽不是唯一操作方式。

### 7.5 布局管理

用户可：

- 保存当前布局并命名。
- 切换到已保存布局。
- 设置默认布局。
- 删除非默认布局。
- 恢复默认布局。
- 重命名布局。

限制：

- 名称 1 到 80 字符。
- 同一 Principal 下名称唯一。
- 默认布局唯一。
- 工厂默认布局不可删除。
- 删除当前布局后切换到默认布局。
- 本地缓存损坏时从服务端或工厂默认恢复。

### 7.6 刷新

每个模块有独立刷新按钮：

- 点击后只刷新该模块。
- 保留旧数据。
- 显示 `refreshing`。
- 成功后更新 `updatedAt`。
- 失败后显示局部错误和重试。
- 不允许无限自动重试。

### 7.7 模块状态

服务端统一返回：

```ts
type WorkbenchModuleState<T> =
  | { status: "ready"; data: T; updatedAt: string; staleAt: string | null }
  | { status: "stale"; data: T; updatedAt: string; staleAt: string; reason: string }
  | { status: "partial"; data: T | null; updatedAt: string | null; error: WorkbenchModuleError }
  | { status: "empty"; data: null; updatedAt: string | null }
  | { status: "forbidden"; error: WorkbenchModuleError };
```

`forbidden` 不返回旧业务数据。

### 7.8 Brief SSE

用户看到：

- 新简报或简报内容变化自动出现。
- “有新内容”提示和已读计数更新。
- 网络断线后自动重连。
- 重连从最后 cursor 继续，不重复插入。
- 会话失效时停止重连并回到登录态。

SSE 只推送个人有权访问的 Brief 摘要和 source ref，不推送完整敏感正文。

## 8. 技术架构

```text
Web Workbench
  -> Layout API
  -> Module API
  -> Brief SSE

Layout API
  -> WorkbenchLayoutRepository
  -> Principal self scope

Module API
  -> WorkbenchApplication
  -> existing repositories
  -> module state projection

Brief refresh
  -> Brief generator
  -> immutable brief snapshot
  -> workbench_brief_events append
  -> SSE stream
```

## 9. 数据模型

建议使用下一个可用加法 Migration。

### 9.1 `workbench_layouts`

| 字段 | 说明 |
| --- | --- |
| `id` | UUID |
| `actor_principal_id` | 布局所有者 |
| `name` | 布局名称 |
| `layout_document` | order + module cols/height JSONB |
| `is_default` | 是否默认 |
| `is_factory_default` | 是否系统默认 |
| `revision` | 乐观锁 |
| `created_at / updated_at` | 时间 |

索引：

- `(actor_principal_id, updated_at DESC)`。
- active default 唯一索引：
  `UNIQUE(actor_principal_id) WHERE is_default`。
- `UNIQUE(actor_principal_id, name)`。

约束：

- module ID 必须来自服务端注册表。
- cols 在 1 到 6。
- height 为 null 或 190 到 900。
- order 不重复，且覆盖所有允许模块或明确隐藏模块。

### 9.2 `workbench_layout_versions`

可选保留布局版本：

- layout_id、revision、document。
- changed_by、created_at。

用于并发恢复和审计。V1 可只保留最近 N 个。

### 9.3 `workbench_brief_events`

append-only：

| 字段 | 说明 |
| --- | --- |
| `id` | UUID |
| `actor_principal_id` | 收件人 |
| `seq` | 每 Principal 递增 |
| `event_type` | created/updated/read-count |
| `brief_id` | Brief |
| `brief_version` | 快照版本 |
| `payload` | 最小 diff |
| `created_at` | 时间 |

唯一约束：`(actor_principal_id, seq)`。

### 9.4 `workbench_module_snapshots`

可选缓存表，不作为授权事实：

- actor。
- module id。
- data hash。
- data JSONB。
- source_project_ids。
- updated_at。
- stale_at。

若现有聚合查询足够快，V1 可先不建表，只返回实时投影。

## 10. API

### 10.1 布局

```text
GET    /api/v1/workbench/layouts
POST   /api/v1/workbench/layouts
GET    /api/v1/workbench/layouts/:layoutId
PATCH  /api/v1/workbench/layouts/:layoutId
DELETE /api/v1/workbench/layouts/:layoutId
POST   /api/v1/workbench/layouts/:layoutId/default
POST   /api/v1/workbench/layouts/:layoutId/duplicate
POST   /api/v1/workbench/layouts/reset
```

PATCH 输入：

```ts
{
  expectedRevision: number;
  name?: string;
  layoutDocument?: WorkbenchLayoutDocument;
}
```

### 10.2 模块

```text
GET  /api/v1/workbench/modules/:moduleId
POST /api/v1/workbench/modules/:moduleId/refresh
GET  /api/v1/workbench/modules/meta
```

兼容：

- 保留 `/api/v1/workbench/dashboard`。
- 新增可选 `modules` map。
- 旧客户端继续读取原有扁平字段。
- 新客户端优先使用 module envelope。

### 10.3 Brief SSE

```text
GET /api/v1/workbench/brief/stream?afterSeq=123
```

事件：

```text
id: 124
event: brief.created
data: {"briefId":"...","version":3,"unreadCount":4}
```

要求：

- Bearer 认证。
- 不支持匿名 EventSource。
- 客户端使用 fetch stream。
- 每 15 到 30 秒 heartbeat。
- 断开后使用 Last-Event-ID 或 `afterSeq`。
- 服务端从持久事件回放后再接实时流。

### 10.4 错误码

```text
workbench_layout_name_conflict
workbench_layout_revision_conflict
workbench_layout_invalid
workbench_layout_not_found
workbench_layout_default_required
workbench_module_unknown
workbench_module_forbidden
workbench_module_refresh_failed
workbench_stream_cursor_invalid
workbench_stream_expired
```

## 11. 前端架构

### 11.1 状态分层

| 状态 | 位置 |
| --- | --- |
| 服务端布局 | React Query |
| 当前拖拽预览 | 本地组件 state |
| 当前布局临时快照 | localStorage |
| 模块数据 | 每模块独立 query |
| Brief 实时事件 | EventSource/fetch stream store |
| 滚动位置 | sessionStorage，跳转返回时恢复 |

### 11.2 本地缓存

key：

```text
pluginmax.workbench.layout-cache.v1
pluginmax.workbench.scroll.v1
```

规则：

- 本地缓存只用于快速恢复。
- 服务端 revision 更新后以服务端为准。
- 损坏时回退工厂默认。
- 退出登录清理 actor-specific key。

### 11.3 拖拽

建议使用成熟的 pointer/drag 排序库，避免手写边界和触控逻辑。项目当前没有
drag-and-drop 依赖，可评估：

- `@dnd-kit/core` + sortable。
- 原生 Pointer Events，仅在能保证可访问性和 390 视口时使用。

拖拽只改变布局，不直接触发业务写操作。

### 11.4 模块组件

```tsx
<WorkbenchModule
  id="brief"
  title="每日简报"
  state={briefState}
  actions={...}
  onRefresh={...}
/>
```

统一处理：

- 标题栏。
- 数量与状态。
- 刷新按钮。
- drag handle 区域。
- resize handles。
- body loading/empty/stale/error。

## 12. Brief 生成与推送

```text
Brief refresh request
  -> authorize actor
  -> generate deterministic brief snapshot
  -> persist immutable workbench_brief
  -> append workbench_brief_event
  -> emit outbox
  -> SSE subscriber sends event
```

规则：

- 相同 content hash 不重复创建版本。
- 并发 refresh 最多创建一个新 Brief。
- SSE event 只引用 snapshot，不复制敏感正文。
- 收件人权限变化后，不再推送无权内容。
- 已读事件更新 unread count，可产生轻量事件。

## 13. 性能与可用性

- Dashboard 首屏并行查询可保留，但后续改为模块级增量。
- 单模块目标 P95 小于 500ms，Brief 生成除外。
- SSE 连接数按实例限制。
- 事件保留至少 24 小时，支持断线重放。
- 模块错误不阻断其他模块。
- 前端不因一个 query 失败白屏。
- 大列表首屏限制条数，剩余通过详情页查看。

## 14. Migration

1. 新建 `workbench_layouts`。
2. 新建 `workbench_brief_events`。
3. 可选新建 layout versions 和 module snapshots。
4. 为每个 active Principal 写一个 factory default layout，或首次访问时惰性创建。
5. 不回填 DSH localStorage 布局。
6. 现有 Brief 快照不重写。
7. 现有 reads/settings/follows 保持不变。

升级门禁：

- fresh `0 -> N`。
- `N-1 -> N`。
- 现有 dashboard API 兼容。
- 旧 Brief 和 Follow 数据保留。

## 15. 测试

### 15.1 Database

- 布局唯一名称。
- 单 Principal 只有一个 default。
- revision 并发冲突。
- layout document schema。
- Brief event seq 单调且唯一。
- 回放 cursor。

### 15.2 API

- 用户不能读取或修改他人布局。
- 布局非法 module、宽度、高度被拒绝。
- 模块权限撤销后 forbidden。
- SSE 认证、续传、heartbeat 和过期 cursor。
- Brief refresh 并发幂等。
- 旧 dashboard 兼容。

### 15.3 GUI

- 拖拽、键盘上移/下移。
- 六档宽度和高度。
- 保存、切换、默认、删除、恢复。
- 刷新单模块。
- stale、partial error、empty。
- SSE 自动更新和断线重连。
- 1440、900、390 无溢出。

## 16. 分期

### Phase 1：布局

- 服务端布局。
- 拖拽、宽度、高度。
- 默认和恢复。

### Phase 2：模块状态

- module envelope。
- 独立 refresh。
- stale/partial error。

### Phase 3：Brief SSE

- persisted events。
- replay cursor。
- frontend stream merge。

### Phase 4：体验优化

- 布局版本。
- 指标偏好。
- 跳转返回滚动恢复。

## 17. 风险

| 风险 | 控制 |
| --- | --- |
| 拖拽导致误操作 | 标题栏热区 + 键盘替代 |
| 布局损坏白屏 | schema 校验 + 工厂默认 |
| 多设备不一致 | 服务端布局 + revision |
| Brief 事件重复 | per actor seq + cursor |
| SSE 泄露 | Bearer 认证 + 权限重算 |
| 单模块拖垮全部 | module envelope + 独立 query |
| 隐藏模块无法恢复 | 布局管理提供模块显示/隐藏入口 |

## 18. 完成定义

- 用户能拖拽、调整宽高并保存多套布局。
- 页面刷新、跨设备登录和跳转返回后布局恢复。
- 单模块可独立刷新，错误不扩散。
- Brief SSE 可连接、断线续传和幂等合并。
- 三视口和键盘操作通过。
- Workbench 从固定聚合面升级为可配置个人工作面。
