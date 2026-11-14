# dsh-pluginmax 升级能力迁移技术方案评审意见

> 评审对象：`docs/v1-dsh-pluginmax-upgrade-migration-technical-plan.md`
> 文档类型：技术方案评审
> 评审视角：资深测试与质量架构
> 评审日期：2026-11-13
> 评审结论：**有条件通过**

---

## 1. 评审结论

方案的主线方向是正确的：继续以 Principal / Grant / Project Role 作为授权事实，以 Workflow / Task / Run / Job / Outbox 作为执行事实，不复制 DSH 存储和运行时，也不通过修改现有 TaskStatus 来承接外部状态。这些边界应当保留。

当前不建议把方案直接视为九个阶段的完整实施承诺。建议先将其收敛为：

- **本轮主干**：M1 执行可信、M2 模板责任绑定、M3 Router 动态计划。
- **后续路线**：M4-M8 只保留能力边界、依赖关系和决策门，不在本轮继续深化数据模型与交互细节。

进入 M1 编码前，需要补齐以下 P0 设计闭环：

1. 将“授权事实、派发适配性、单次动作门禁”分开表达，避免用一个 `allowed` 结果承载不同语义。
2. 修正验收证据规则，确保所有必需验收项都有可验证证据，而不是“至少一个”。
3. 明确平台模板的跨项目读取、管理和实例化授权路径。
4. 明确 Plan 物化、重试和 Reconciler 的原子性、唯一约束与关闭态围栏。
5. 明确当前状态与不可变历史的存储关系，尤其是 assignment、anomaly 和 acceptance。
6. 将 Migration 验证从“可执行”提升为“旧应用兼容、存量升级、约束冲突、关闭回滚均可验证”。

总体判断：

| 维度 | 结论 | 说明 |
| --- | --- | --- |
| 架构主线 | 通过 | 复用现有平台事实源和运行时链路 |
| 阶段顺序 | 通过 | M1 先于 M2/M3 的判断成立 |
| 实施准备度 | 有条件 | 关键语义和一致性约束尚未闭合 |
| 测试闭环 | 尚未通过 | 当前测试矩阵偏清单，缺少门禁场景和判定标准 |
| 范围控制 | 需收敛 | M1-M3 可进入主干，M4-M8 应暂为路线图 |

---

## 2. 方案中应保留的正确判断

- **不引入 `abnormal` TaskStatus**：异常作为独立执行维度，避免破坏现有队列、暂停、补充输入和 Review 状态机。
- **不建立第二套 Router DAG 事实源**：Plan 复用 Workflow Graph、Instance、Task 和 Run，方向正确。
- **M1 先于 M2/M3**：授权、证据和异常没有闭环前，角色绑定和动态计划会产生返工。
- **Feature Flag 与 additive migration 优先**：符合当前平台的演进方式，也便于分阶段观察。
- **Skill、Market 不增加授权**：技能和市场 entitlement 不能替代项目权限，这条边界必须保持。

---

## 3. P0：进入实施前必须补齐

### 3.1 分离授权、派发适配性与动作门禁

**对应原方案：** §4.1、§4.6、§14.2、§14.3

原方案将 Project Capability、Grant、Project Role、Runtime Profile、Data Policy、Node Constraint 和 Action Gate 统一压缩为 `EffectiveExecutionScope`。概念上做交集可以接受，但如果落成一个可缓存的 `allowed` 布尔值，会把三类不同问题混在一起：

- **授权问题**：该 Principal 是否有权访问该资源和执行该动作。
- **派发问题**：该 Runtime、角色、节点约束是否满足执行条件。
- **动作问题**：本次写入、外部发送或审批是否获得 Ticket / Gate 放行。

三者的事实来源、失效时机和审计粒度不同。尤其 Action Gate 是单次动作级决策，不应被固化为长期 Scope；Data Policy 也不应出现在与数据无关的普通任务派发中。

建议保留统一 Application Service，但返回分层决策：

```ts
type ExecutionDecision = {
  authorization: {
    allowed: boolean;
    permission: "read" | "write" | "approve" | "manage_members" | "manage_roles";
    grantIds: string[];
    membershipId?: string;
  };
  dispatchEligibility: {
    allowed: boolean;
    runtimeRevision?: number;
    policyRevision?: number;
    reasons: string[];
  };
  actionDecision?: {
    allowed: boolean;
    action: string;
    resourceId: string;
    ticketId?: string;
    gateId?: string;
  };
};
```

同时需要明确一致性检查点：

- 预检只提供候选结论，不作为启动依据。
- 实例启动前重新检查项目写权限、角色解析和 Runtime 条件。
- 节点派发前使用数据库权威状态再次检查，不能只依赖前端或缓存。
- 每次受保护的 Tool / 文件写入 / 外部发送单独检查 Gate。
- 角色、Grant、Runtime 或策略变化后，尚未产生副作用的工作必须停止。

**改进要求：**

- 不使用单一 `allowed` 表示全部语义；至少拆为 `authorization`、`dispatchEligibility` 和 `actionDecision`。
- 不要假设存在天然一致的 `grantRevision`、`roleRevision`、`runtimeRevision`。如需缓存，使用明确的授权纪元或短 TTL，并在副作用前重新校验。
- 缓存只允许缓存可验证的授权事实；不得跨动作复用 Gate 结论。
- 测试必须覆盖“预检后撤权”“校验后、派发前角色变化”“Runtime 降级”“A 资源 Ticket 用于 B 资源”等 TOCTOU 场景。

### 3.2 验收证据规则没有形成完整门禁

**对应原方案：** §4.2、§4.3、§12.3、§17.3

原规则要求“至少一个验收项有证据”，这会允许其余必需验收项未确认就自动进入 Review。现有 `TaskAcceptanceResult` 也缺少验收项标识和版本，无法回答“具体确认了哪一项”，只能回答“这次提交声称有若干证据”。

当前任务结构使用字符串数组保存 acceptance，且 `autoSubmit` 默认开启、`autoAccept` 默认关闭。迁移方案必须明确与现有自动提交、自动验收路径的兼容矩阵，否则新旧路径可能同时存在。

建议调整为：

```text
允许自动提交 Review
  = 当前 owner Run 完成且被选为本次证据
  ∩ 所有 required 验收项均存在有效确认
  ∩ 每项证据均可由服务端解析到当前 task/run
  ∩ 无失败工具事件、Gate 拒绝或失败计划节点
  ∩ 未命中禁止自动推进的异常
```

验收确认至少应包含：

```ts
type AcceptanceConfirmation = {
  acceptanceItemId: string;
  acceptanceItemRevision: number;
  taskId: string;
  runId: string;
  evidenceRefs: Array<{
    kind: "artifact" | "tool-event" | "run-output" | "external-resource";
    refId: string;
    version?: string;
    digest?: string;
  }>;
  confirmedByPrincipalId: string;
  confirmedAt: string;
};
```

**改进要求：**

- 将“至少一个”改为“所有 required 验收项均确认”；可选验收项需显式标记 optional。
- 为 acceptance item 建立稳定 ID 或规范化身份；任务验收内容修改后，旧证据必须失效。
- `evidenceRefs` 不使用无类型字符串；至少记录类型、引用 ID、版本和摘要，并由服务端验证归属。
- 明确“current Run”的选择规则，例如最新有效 owner Run；不能接受其他任务、旧 Run 或已 superseded Run 的证据。
- `task.evidence_review=observe` 只记录新旧判定差异，不得写“已确认”事实或改变状态。
- `task.evidence_review=enforce` 下，无完整证据时不得进入 Review；`autoAccept=true` 不得绕过证据规则。若保留特殊例外，必须单独命名、授权并审计。
- Agent 可以提交带证据的执行侧确认，但确认不等于批准；最终 Review 必须由具有 `approve` 能力的独立主体完成。

### 3.3 平台模板缺少跨项目授权语义

**对应原方案：** §5.1、§5.4、§14.2

增加 `scope=project|platform` 只解决了可见性标签，没有解决访问路径。当前 Workflow Definition 通过 `project_id` 归属于项目；平台模板跨项目可见后，必须明确三个不同动作的授权来源：

| 动作 | 建议授权原则 |
| --- | --- |
| 发现和读取平台模板 | 平台 access 或明确的可发布范围，不依赖 owner project 的普通成员身份 |
| 编辑、发布、下线平台模板 | 平台管理员，并可增加审批；owner project 不自动获得管理权 |
| 使用平台模板创建实例 | 调用方对目标项目具有 `write`，并重新执行目标项目内的绑定预检 |

平台模板的 `ownerProjectId` 只用于归属和追责，不能成为其他项目实例的运行授权来源。

**改进要求：**

- 在 §5 增加“读取平台模板”“管理平台模板”“在目标项目实例化平台模板”三条授权路径。
- 明确 `GET /workflows` 等现有按 project 过滤的查询如何兼容平台作用域，避免跨项目泄漏。
- 测试覆盖：非 owner project 成员可读取但不管理；owner project 普通成员不能管理；目标项目无 `write` 时不能实例化；实例化后所有节点仍按目标项目授权。

### 3.4 Plan 物化和 Reconciler 的幂等边界不够稳定

**对应原方案：** §6.6、§6.7、§6.8、§13.3、§16

原物化幂等键包含 `attempt`：

```text
router-worker:{instanceId}:v{planVersion}:{nodeId}:{attempt}
```

如果 `attempt` 由调用方传入，API 重试或 Worker 重放时变化，就会生成新的幂等键并重复创建 Task。节点执行重试应复用同一个 Task、增加 Run attempt，而不是重新物化 Task。

此外，方案同时提供显式 `materialize` 和 Reconciler 推进，但没有说明二者如何互斥；Plan 物化也没有定义“部分成功”后的恢复状态。当前 Workflow 已有 sweep lease、revision CAS 和幂等命令能力，方案应明确复用它。

**改进要求：**

- Task 物化幂等键由服务端稳定生成，只使用 `planId + planVersion + nodeId`，不包含客户端重试次数或可变化的 attempt。
- 新增物化账本，并对 `(plan_id, plan_version, node_id)` 建立数据库唯一约束；Task origin 也要有对应唯一约束。
- 物化使用可恢复状态机，例如 `pending -> materializing -> materialized / failed`，明确 Task 已创建但 origin 未写时如何恢复。
- Plan 的 approve、materialize、finalize 使用 revision / CAS；同一 Plan 的 Reconciler 使用租约或 `FOR UPDATE SKIP LOCKED`，保证单写。
- Outbox / Job 处理必须按消息 ID 幂等，不能仅依赖“处理成功后删除”。
- Feature Gate 关闭需要 fencing：副作用前再次检查开关和 Plan 状态；已通过检查但尚未执行的派发应有明确处理规则。
- “关闭态不读取 Router Domain 数据”应改为“不得继续调度或产生副作用”；控制面仍需读取状态以展示 `resume_required` 和安全停点。

### 3.5 当前状态与不可变历史需要明确分层

**对应原方案：** §4.2、§5.3、§12.2、§12.3

方案提出了 assignment revision、binding snapshot、anomaly 和 superseded evidence，但没有明确哪些表保存“当前有效状态”，哪些只保存历史。当前 `TaskExecutionAnomaly` 也只表示单个异常，而一个任务可能同时存在工具失败、依赖未满足和缺少证据。

建议按以下原则补齐：

| 对象 | 当前状态 | 不可变历史 | 关键约束 |
| --- | --- | --- | --- |
| Instance assignment | 每个 instance/node 一条当前绑定 | Workflow Audit / binding snapshot | `UNIQUE(instance_id, node_id)` |
| Anomaly | 按 task + run + code 记录活动异常 | Run Event / anomaly audit | 活动异常唯一；清除后保留历史 |
| Acceptance | 当前有效确认 | superseded confirmation | 每项验收、每个 Run 的当前确认唯一 |
| Router Plan | Plan 表保存 currentVersion/status | Plan Version 表不可变 | `UNIQUE(plan_id, version)` |

`executionHealth` 应由活动异常和证据状态计算或投影，不能成为与异常表并列、可独立修改的第二事实源。恢复执行时应按 Run attempt 清除对应异常，而不是无条件清空整个任务的所有异常。

### 3.6 Migration 验收需要覆盖存量与旧应用兼容

**对应原方案：** §12.1、§12.2、§17.2、§16

“additive migration”只说明不会直接删除数据，不等价于安全升级。以下情况仍需在设计阶段明确：

- 新增唯一约束前如何检测存量冲突，例如 Report 的 `project + kind + date + version`。
- 大表新增列、回填和建立索引时的锁与执行窗口。
- 新 Schema 下旧应用是否仍可启动和读取；数据库与应用是否按 N/N-1 兼容。
- Feature Flag 关闭是否是真正的“停止新行为”，而不是仅隐藏 UI。
- Group Scene 后续调整唯一键时，如何兼容现有 `principal_scope` 和 NULL 语义。

建议所有主干 Migration 按以下顺序验收：

```text
expand -> backfill / validate -> enforce constraints -> enable feature
```

每个 Migration 至少需要：

- 空库从 1 升到最新版本成功。
- 从当前 33/34 的真实结构快照升级成功。
- 旧应用在新 Schema 上可以启动并完成核心读操作。
- 唯一约束冲突预检查脚本可在升级前执行。
- 关闭 Feature Flag 后，旧链路恢复，已有数据不删除，未完成任务不自动恢复。

---

## 4. P1：范围与测试组织建议

### 4.1 将 M1 再拆成两个可独立验收的批次

M1 同时包含授权、异常、证据、Task Tool 和文件工具，风险面仍然较大。建议拆分：

- **M1a 执行判定与验收闭环**：分层授权决策、异常维度、验收证据、自动提交兼容。
- **M1b 受控 Tool 与工作区安全**：Task Tool Facade、工作区路径沙箱、Gate 接入。

M2/M3 只依赖 M1a 的核心授权与证据语义，不必等待文件工具全部完成。

### 4.2 M0 应产出可冻结的契约清单

当前 M0 的描述正确，但缺少明确交付物。建议至少冻结：

- 外部基线提交与工作区差异摘要。
- `ADOPT / ADAPT / DEFER / NON_TARGET` 判定表。
- 主干能力的输入输出示例、错误码和状态迁移。
- 必须保留和明确禁止的负向用例。

不需要冻结 M4-M8 的全部字段名和页面细节。

### 4.3 将测试矩阵转换为阶段退出门

§17 已有测试方向，但更像检查清单。建议每个主干阶段增加“通过条件”，并固定测试层级：

| 层级 | 主干必须覆盖 |
| --- | --- |
| Contract | Schema、状态枚举、错误码、兼容字段 |
| PostgreSQL integration | 唯一约束、CAS、事务、迁移、并发 |
| Application | 授权分层、幂等、工作流命令、关闭态 |
| Worker | 崩溃恢复、租约过期、重放、停止新派发 |
| API / E2E | 关键用户路径、阻塞提示、状态投影 |
| Security negative | 越权、自批、路径穿越、跨项目读取、Gate 绕过 |

测试结果需要能回答“该阶段是否允许开启 Feature Flag”，而不只是“测试数量是否增加”。

### 4.4 为 observe 到 enforce 定义明确门槛

`task.evidence_review` 从 `observe` 切到 `enforce` 前，至少应满足：

- 新旧判定差异已有稳定统计。
- 不存在授权允许但应拒绝的反例。
- 缺少证据的自动提交均被正确拦截。
- 现有 `autoSubmit` / `autoAccept` 任务的新旧行为差异已完成清点。
- 回退到 observe 不会改变已有 Task / Run / 证据历史。

---

## 5. 建议对原方案做的最小修改

| 原方案位置 | 建议修改 |
| --- | --- |
| §0.2、§18 | 明确 M1-M3 为本轮主干；M4-M8 为路线图，需逐阶段重新立项或评审 |
| §4.1 | 将统一 Scope 改为分层决策；补充授权缓存与副作用前复核规则 |
| §4.2、§12.3 | 增加异常生命周期、活动异常唯一约束、health 唯一事实来源 |
| §4.3 | 改为所有 required 验收项确认；补充验收项 ID、证据类型和 current Run 规则 |
| §5.1、§5.4 | 补充平台模板的读取、管理、目标项目实例化三条授权路径 |
| §6.6-§6.8 | 修正幂等键；补充物化账本、唯一约束、恢复状态和关闭围栏 |
| §12.1、§12.2 | 增加 expand/backfill/enforce 顺序、唯一约束冲突预检和旧应用兼容验证 |
| §16 | 明确 Feature Flag 关闭的运行时行为、在途操作处理和观察指标 |
| §17 | 将测试清单转为阶段退出门，保留主干正负向场景 |

不需要重写整份方案。以上修改完成后，方案即可作为 M1-M3 的技术基线和测试设计输入。

---

## 6. 最小主干验收场景

以下场景应作为 P0 门禁，不通过则不应开启对应 Feature Flag：

| 编号 | 场景 | 预期结果 |
| --- | --- | --- |
| G1 | 预检后、派发前撤销项目 Grant | 派发被拒绝，记录明确拒绝原因 |
| G2 | 预检后 Runtime 能力降级 | 节点不派发，进入可解释的安全停点 |
| G3 | 使用 A 资源的 Ticket 执行 B 资源动作 | 拒绝，Gate 结论不可复用 |
| G4 | 多个验收项仅一项有证据 | 不自动进入 Review，标记缺少证据 |
| G5 | 旧 Run 或旧 acceptance revision 的证据 | 拒绝，保留历史但不作为当前证据 |
| G6 | Agent 提交执行确认后继续批准自己的任务 | 最终批准被拒绝，记录审计 |
| G7 | `autoSubmit=true` 且无完整证据 | enforce 下停留 `in_progress` 并标记异常 |
| G8 | `autoAccept=true` 且证据未完成 | 不允许自动 Done，除非存在单独定义和授权的例外 |
| G9 | 同一 Plan 并发 approve/materialize | 每个节点只创建一个 Task，账本只有一条记录 |
| G10 | Task 创建后、origin 写入前 Worker 崩溃 | 恢复后补齐 origin，不重复创建 Task |
| G11 | Plan active 时关闭 Router Feature Flag | 无新派发，Plan 进入 `resume_required`，重开不自动执行 |
| G12 | 空库升级、33/34 快照升级、旧应用读取新 Schema | 均成功；唯一约束冲突在升级前可发现 |

---

## 7. 最终建议

**结论：有条件通过，可进入方案修订与测试基线设计，不建议直接进入全量编码。**

建议下一步只做两件事：

1. 按第 5 节修订原方案的主干章节，先把 M1-M3 的授权、证据、Plan 物化和 Migration 门禁写实。
2. 以第 6 节的最小场景为基础，补齐 Contract、PostgreSQL、Worker 和 API 的可执行测试映射。

M4-M8 暂保留在路线图中。等 M1-M3 的退出条件、迁移验证和回滚演练稳定后，再逐阶段展开，不需要在当前文档中继续增加细节。
