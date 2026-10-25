# 会议侧边栏设计方案

## 概述

将会议功能从「设置」页面迁移到主界面右侧边栏，提供常驻可及的会议模式。用户可以在不离开当前会话的情况下查看、发起、加入、参与讨论、派遣 Agent 分身、退出会议。中心主区域保持留给业务工作台（R6 workstation 未来填充）。

## 架构位置

DSH Web 客户端是三栏布局（`sidebar | conversation | details`）。会议侧边栏通过以下 slot 组合实现：

| Slot | 用途 |
|---|---|
| `sidebar.footer.action` (list) | 在左侧边栏底部添加会议图标按钮，点击切换右侧面板开关 |
| `shell.overlay` (list, root) | 渲染右侧滑入面板，覆盖在 details 列之上，不遮挡中心对话区 |

不需要修改上游代码。会议插件的 client bundle 同时注册这两个 slot。

## 交互设计

### 整体布局

```
┌──────────┬─────────────────────────────┬──────────┐
│          │                             │ 会议面板  │
│  左侧边栏 │     中心对话/工作台           │ 380px    │
│  (不变)   │     (不受影响)               │          │
│          │                             │          │
│  [💬]    │                             │          │
│  [设置]   │                             │          │
└──────────┴─────────────────────────────┴──────────┘
```

会议面板通过 `shell.overlay` 渲染，使用 `position: absolute; right: 0; top: 0; bottom: 0; width: 380px` 定位，带 slide-in 动画。打开时覆盖 details 列（如果有），但不遮挡中心 conversation 列。窄屏时面板全宽覆盖。

### 左侧边栏入口

在 `sidebar.footer.action` 注册一个图标按钮（users/messages icon）。按钮状态：

- **关闭**：显示会议图标，无背景色。
- **打开**：显示会议图标 + 背景色高亮，同时右侧面板滑入。
- 有未读消息时显示 badge（数字）。

### 会议面板 - 两个视图

#### 视图 1：会议列表（默认）

用户打开面板时看到当前工作区的活跃会议列表。

**元素：**

- **顶栏**：「会议」标题 + 关闭按钮（X）。
- **工作区选择**：顶部下拉框，默认选中当前用户是成员的第一个工作区，带 info 图标展开面板显示工作区详情和复制 ID。
- **创建按钮**：「+ 新会议」按钮，点击展开内联表单（标题 + 议程 + 创建按钮），完成后自动刷新列表。
- **会议卡片列表**：每张卡片显示标题、状态 pill（进行中/已关闭）、参与者人数、创建时间、操作按钮（加入 / 查看）。
- **空状态**：「当前工作区暂无会议。点击上方按钮发起一个。」

#### 视图 2：会议聊天（选中会议后）

点击一个会议卡片后，面板切换到聊天视图。

**元素：**

- **顶栏**：返回箭头 + 会议标题 + 状态 pill + 参与者数。
- **参与者条**：横向滚动，显示所有参与者头像圈（首字母）和名字，leader 有关注/星标标记。当前用户高亮。
- **消息流**：聊天气泡样式，从下往上滚动。每条消息显示发送者名字、时间、内容。系统消息（如「xxx 加入了会议」）居中灰色显示。
- **输入区**：文本框 + 发送按钮。如果当前用户未加入会议，显示「加入会议后可发言」提示 + 加入按钮。
- **操作栏**（当前用户已加入时显示在输入区上方）：
  - 「离开会议」按钮
  - 「关闭会议」按钮（仅 Leader 可见）
  - 「关闭摘要」输入框（关闭会议时填写）
- **Agent 分身派遣**（当前用户已加入且是 workspace 成员时显示）：
  - Toggle switch：「派遣 Agent 分身」
  - 打开后显示 persona 选择下拉框（从 roles 插件读取可用人设）
  - 「派遣」按钮：调用 join API，以 agent 角色加入

### 会议状态流转

```
列表视图 --点击会议卡片--> 聊天视图
聊天视图 --点击返回箭头--> 列表视图
面板关闭 --再点侧边栏图标--> 面板打开（记住上次视图）
```

### Agent 分身派遣流程

1. 用户在聊天视图打开「派遣 Agent 分身」开关。
2. 系统从 roles 插件获取当前工作区可用的 persona 列表。
3. 用户选择一个 persona，点击「派遣」。
4. 插件调用 `POST /api/collab/meeting/join`，参数中 `kind: "agent"`, `personaId` 选中的 persona。
5. 服务端 spawn 一个 subagent（复用现有 meeting adapter），以选定的 SOUL 和工具边界参与讨论。
6. 参与者列表出现 Agent 头像（机器人 icon），消息流中出现 Agent 的发言。

### 与 Settings 页面的关系

**移除** Settings 中的完整「会议」分区。会议的全部操作都在侧边栏面板中完成。Settings 中保留一个简化入口：「在侧边栏中打开会议」链接按钮，点击触发侧边栏打开。

## 数据流与 API

客户端已有的 API 端点完全够用，不需要新增服务端路由：

| 操作 | API | 说明 |
|---|---|---|
| 获取工作区 | `GET /api/collab/team/workspaces` | 复用 identity 插件 |
| 获取会议列表 | `GET /api/collab/meetings?workspaceId=…` | 已有 |
| 创建会议 | `POST /api/collab/meetings` | 已有 |
| 获取会议详情 | `GET /api/collab/meeting?meetingId=…` | 已有（含参与者、消息） |
| 加入会议 | `POST /api/collab/meeting/join` | 已有 |
| 发言 | `POST /api/collab/meeting/message` | 已有 |
| 离开 | `POST /api/collab/meeting/leave` | 已有 |
| 关闭 | `POST /api/collab/meeting/close` | 已有 |
| 同步席位 | `POST /api/collab/meeting/seats/pull` | 已有 |
| 获取 persona 列表 | `GET /api/collab/personas?workspaceId=…` | 复用 roles 插件 |

## 实现要点

### Client 代码变更

只修改 `plugins/dsh-collab-meeting/client/index.js`（约 903 行 → 重构为约 600 行纯侧边栏版）：

1. **删除** `MeetingSection` 组件和 `settings.section` 注册。
2. **新增** `MeetingPanel` 组件：完整的侧边栏面板（列表 + 聊天两个子视图）。
3. **新增** `MeetingSidebarToggle` 组件：侧边栏底部图标按钮。
4. **注册** 两个 slot：
   ```js
   ctx.slots.inject("sidebar.footer.action", () =>
     ctx.slots.register({ name: "sidebar.footer.action", id: "pluginmax-meeting-toggle", … }, MeetingSidebarToggle));
   ctx.slots.inject("shell.overlay", () =>
     ctx.slots.register({ name: "shell.overlay", id: "pluginmax-meeting-panel", … }, MeetingPanel));
   ```
5. **共享状态**：面板的 open/close 和当前视图用 React state 管理，Toggle 和 Panel 通过一个 module-level store（简单的 subscribe/emit 模式）通信。

### 样式约束

- 使用 DSH 的 CSS 变量（`var(--dsw-alias-*)`），保持主题一致。
- 面板宽度 380px（>= 768px 视口），100vw（< 768px）。
- slide-in 动画：`transform: translateX(100%)` → `translateX(0)`，200ms ease-out。
- 面板背景 `var(--dsw-alias-bg-layer-1)`，与侧边栏一致。
- 消息气泡：自己的消息右对齐主色底色，他人消息左对齐灰底。

### 需要注意

- `sidebar.footer.action` 接收 `wide` prop（sidebar 展开或收起），需要在收起模式（rail）时只显示图标不显示文字。
- `shell.overlay` 的容器 `pointer-events: none`，但子元素自动恢复 `pointer-events: auto`。面板根元素需要确保占满整个面板区域，防止点击穿透。
- 当 details 列已经打开时（用户在查看 subagent 详情等），会议面板覆盖其上方是预期行为，不需要特殊处理。

## 里程碑拆分

本设计作为 R4.5 迭代实施，不需要新建插件，只修改 meeting 插件：

1. **Step 1**：Sidebar toggle button + overlay panel 骨架 + 列表视图 + 创建会议。
2. **Step 2**：聊天视图（消息气泡 + 输入 + 加入/离开/关闭）。
3. **Step 3**：Agent 分身派遣（toggle + persona 选择 + join as agent）。
4. **Step 4**：移除 Settings 中的旧会议分区，保留链接。

每步完成后 `pnpm check` 全量验证。
