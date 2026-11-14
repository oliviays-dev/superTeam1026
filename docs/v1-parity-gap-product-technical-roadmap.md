# Pluginmax V1 核心 Parity 缺口产品与技术方案索引

> 状态：设计方案总索引。Shared Space 已实现；其余三个能力尚未实现
>
> 更新日期：2026-10-28
>
> 基线：`pluginmax-platform@5b7f7f5bc179ca0435c96126a950e7b3605847f4`
>
> DSH 对照：`dsh-pluginmax@a702267abfc6baebc7cab7b3045e71c204079e10`

## 1. 方案列表

| 能力 | 产品与技术方案 | 目标批次 | 当前 parity | 优先级 |
| --- | --- | --- | --- | --- |
| Shared Space | [v1-shared-space-product-technical-design.md](./v1-shared-space-product-technical-design.md) | Batch 19 | `IMPLEMENTED / VERIFIED` | P1 |
| Project Governance | [v1-project-governance-product-technical-design.md](./v1-project-governance-product-technical-design.md) | Batch 20 | `PARTIAL / MISSING` | P1 |
| Workbench 配置与 Brief SSE | [v1-workbench-configuration-product-technical-design.md](./v1-workbench-configuration-product-technical-design.md) | Batch 20 | `PARTIAL` | P1 |
| Human Avatar Delegation | [v1-human-avatar-delegation-product-technical-design.md](./v1-human-avatar-delegation-product-technical-design.md) | 独立批次 | `MISSING` | P1 |

## 2. 统一设计原则

1. 复用现有 Principal、Grant、Action Ticket、Gate、Scene、FileStore、Audit 和
   Outbox，不建立第二套身份或权限事实。
2. 页面隐藏不是安全边界，所有操作由服务端最终授权。
3. 历史事实不可静默覆盖。审计、Ticket、Gate、Receipt 和版本记录保持不可变或只追加。
4. 新能力先加 schema，再迁移旧 V1 数据；不引入 DSH JSON Storage。
5. 所有 Agent 操作必须经过 Execution Envelope、Policy、Ticket 和 Gate。
6. 所有高风险能力有默认关闭、显式开启和 fail closed 路径。
7. 每个能力按 Contracts、Database、Application、API、Worker、Web 和 E2E 分层验收。

## 3. 共有依赖

```text
Principal / Account / Workspace / Project
  |
  +--> Workspace/Project Grant
  |
  +--> TaskExecutionPolicy / Execution Envelope
  |
  +--> Action Ticket / Execution Gate
  |
  +--> Scene Session / Context Receipt
  |
  +--> FileStore / Outbox / Audit / Trace
```

## 4. 推荐实施顺序

### 4.1 Batch 19 Shared Space

原因：

- 独立安全边界最强。
- 必须先完成路径、Locks、Ticket、Gate 和文件审计。
- Project Output 和 Meeting File 后续可以引用 Shared Space entry。

前置：

- 独立文件安全评审。
- 20A Workspace 管理面。
- 15B/16 语义冻结。

### 4.2 Batch 20 Project Governance

原因：

- 补齐项目摘要、产出物、历史和角色治理。
- 为 Workbench 提供可靠项目健康度和产出数据。

前置：

- Shared Space 可选但推荐，Project Output 可复用 Shared File。
- Workflow Role Snapshot 设计评审。

### 4.3 Batch 20 Workbench

原因：

- 依赖稳定 module contract 和 Project Governance 数据。
- SSE 和布局可以独立交付，但模块数据质量受 Project Governance 影响。

前置：

- Module envelope。
- Layout persistence。
- Brief event persistence。

### 4.4 Human Avatar Delegation

建议作为独立批次，不并入 Batch 19 或 Batch 20。

原因：

- 涉及跨 Task、Workflow、Meeting 的授权语义。
- 必须复用 Ticket/Gate/Scene，但不能扩大 15A/15B 快照语义。
- 需要单独产品确认审批强度和动作集合。

## 5. 共同数据与契约边界

### 5.1 Principal

- Human Avatar 不是 Principal。
- Shared Space Actor 可以是 Human 或 AI Principal。
- Workbench Layout 归属于当前 Human Principal。
- Project Owner 是 Project scope Grant，不是 Platform Role。

### 5.2 Grant

- Workspace Grant 不自动成为 Project Grant。
- Project Grant 不自动成为 Workspace 文件读取权限。
- Shared Space 写权限不能绕过 Action Ticket。
- Human Avatar 权限不扩大主人 Grant。

### 5.3 Ticket 与 Gate

所有新能力复用 15B：

- Shared Space 写和 Global Write。
- Human Avatar 高风险动作。
- Project 角色影响确认如需要分阶段审批，可走普通确认，不强制 Ticket。

### 5.4 Scene

- Shared Space Agent 操作必须绑定当前 Scene。
- Human Avatar 使用独立 `delegation:<id>` Scene。
- Workbench 不执行高风险动作，不需要 Scene。
- Project Governance 的浏览器写操作使用普通 RBAC 审计。

### 5.5 Audit

新增审计域：

- `shared_space_events`
- `project_audit_events`
- `delegation_events`

Workbench 布局和 SSE 可使用普通业务审计，不把个人拖拽操作写入高风险安全审计。

## 6. 共同 Migration 原则

1. 不预分配版本号，实施时读取当前最高版本。
2. 先 additive，再 backfill，最后约束。
3. 新增 enum 使用数据库 CHECK 或稳定文本值，不使用本地化展示文案。
4. 大回填分批，并输出冲突报告。
5. 所有新表默认无正式数据。
6. fresh `0 -> N` 与 `N-1 -> N` 必须同时通过。
7. 不读取旧 DSH JSON Storage。

## 7. 共同测试门禁

每个能力至少覆盖：

- Contracts 正向与负向 schema。
- fresh 和 upgrade Migration。
- 权限交集、deny-wins、跨 Workspace/Project。
- 并发 revision、重复提交和幂等。
- API 错误码和资源存在性泄露。
- Worker 重试、取消、超时和恢复，如涉及执行。
- 1440、900、390 三视口。
- 截图、trace、日志和测试数据摘要。
- secret 不进入 fixture、日志、截图或审计。

## 8. 产品决策待确认

| 决策 | 建议默认 |
| --- | --- |
| Shared Space 是否首发开放 | 只读首发，写入后置 |
| Workspace 默认读取范围 | active Workspace members 只读 |
| Project 编号是否强制自动 | 新项目自动，历史手工 code 保留 |
| Owner 是否允许 AI Principal | 首版不允许 |
| Project Output 是否复用 Shared Space | 推荐复用 |
| Workbench 布局存储 | 服务端个人布局 + 本地缓存 |
| 是否支持团队共享布局 | 首版不支持 |
| Human Avatar 默认审批策略 | `suggest-only` |
| 是否允许 Avatar 最终审批 | 默认不允许，需独立高风险开关 |
| Meeting Delegate 是否迁移 | 保留，新 Delegation 为事实来源，Meeting 为投影 |

## 9. 发布判断

当前状态：

- Shared Space 已由 Migration 33、定向/完整 Vitest、Worker 恢复和 Playwright
  三视口验证；可以宣称已覆盖，证据见
  [v1-shared-space-implementation-report-20261028.md](./v1-shared-space-implementation-report-20261028.md)。
- 不得宣称 Project Governance 和角色草稿已覆盖。
- 不得宣称 Workbench 可配置布局和 Brief SSE 已覆盖。
- 不得宣称 Human Avatar 通用委托已覆盖。

如果 V1 首发不承诺这些能力，必须在发布说明中明确业务降级；如果属于已承诺核心链路，
Block 19/20 和 Human Avatar 仍是 P1 发布阻断候选。
