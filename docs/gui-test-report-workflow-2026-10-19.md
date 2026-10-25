# 工作流 GUI 测试执行报告（2026-10-19）

## 环境

- 服务：`http://127.0.0.1:33125/`
- 数据目录：`.tmp/dsh-home`
- 主账号：`admin / password-123`
- 浏览器：Codex In-app Browser
- 已验证视口：`1440x900`、`760x900`、`390x844`
- 任务详情回归实例：`TSK-MV92O024-6CDE`
- 工作流实例：`77c7c77d-e9b8-49bf-8a60-b16b4bad4062`

## 通过项

| 用例                                | 结果       | 主要证据                                                                                                                                             |
| ----------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| WF-01 入口、权限和登录              | 部分通过   | admin 可见范围切换、模板管理和新建工作流；member 可见模板管理禁用、新建工作流可用                                                                    |
| WF-02 导入、校验和图形检查          | 通过       | 模板负例一次列出全部用户引用错误；修正版本和账号后显示“校验通过”                                                                                     |
| WF-03 项目筛选和新建工作流弹窗      | 通过       | 项目筛选默认“全部项目”；离开工作流再进入后重置；状态/负责人/清除筛选有效；弹窗包含项目、模板、节点预览                                               |
| WF-04 服务节点                      | 通过       | `发布` 节点固定右对齐显示“等待系统执行”，展开后仅 Owner/Admin 可见“管理员完成”                                                                       |
| WF-06 并行、汇合与多人审批          | 通过       | 虚线“并行流程”、`3-1/3-2`、汇合 `4` 不缩进                                                                                                           |
| WF-08 判断、子流程和服务节点        | 通过       | 实线“分支流程 · 2 选 1”、`2a/2b`、双方进入条件；子流程可展开 `2a.1/2a.2`                                                                             |
| WF-09 Agent 改派与会话启动          | 修复后通过 | 改派后新增 `source=workflow` 的节点 run，session 为 `de-task-TSK-MV92O024-6CDE-test-design-digital-e386906a`；任务详情显示“Agent 正在执行工作流节点” |
| WF-11 刷新和 Console                | 通过       | 刷新后列表/KPI/默认项目筛选恢复；新会话 Console 无 warning/error                                                                                     |
| WF-13 列表、KPI、详情头部与数据范围 | 修复后通过 | 已加入 `29 / 6 / 4 / 19`，平台全量 `31 / 6 / 4 / 21`；详情切换范围回列表；移动端头部不再拆行                                                         |
| WF-14 节点详情、编码与交付物浮层    | 通过       | 节点默认折叠、多开互不影响；概览节点与交付物按钮为并列控件；交付时间与值同一行                                                                       |
| E2E-WF-05 UI 迭代回归               | 通过       | 展开节点后切换数据范围，正常回到列表，KPI、筛选栏和标题均可见                                                                                        |

## 发现与修复

### 1. 工作流任务改派给 Agent 后启动了错误的会话

修复前：

- 任务 `TSK-MV92O024-6CDE` 改派给“柯真 01 测试”后，产生的是 `source=task`、`instanceId=TSK-MV92O024-6CDE`、`nodeId=task` 的普通任务 run。
- 工作流节点仍处于 `blocked/ready`，工作流详情显示“尚未派发过 AI伙伴运行”。
- 对应 session 虽然存在，但不是工作流节点 run，无法回写节点状态和交付门禁。

修复后：

- 工作流任务在任务层仅持久化责任人并同步节点投影，不再启动普通任务会话。
- 责任人落库后，工作流桥接层启动节点自己的 run。
- 新 run：`run-0a60cbfc-5709-4f12-85df-1b611388600d`
- `source=workflow`、`instanceId=77c7c77d-e9b8-49bf-8a60-b16b4bad4062`、`nodeId=test-design`
- session：`de-task-TSK-MV92O024-6CDE-test-design-digital-e386906a`
- 工作流节点显示“AI伙伴自动运行中 · 第 1 次”。
- 随后按计划重启服务，run 正确转为 `interrupted`；工作流节点显示“已中断”、错误原因、“重新派发 AI伙伴”和人工代交入口，没有静默丢失。

### 2. 移动端详情头部被“更新时间”挤压

- 修复前：`390px` 下“工作流 /”被拆成两行，关注星标掉到下一行。
- 修复后：标题区使用独立网格行，更新时间移到第二行右侧；标题单行省略，星标保持同一行。

### 3. 流程概览存在嵌套交互控件

- 修复前：节点容器使用 `role=button`，内部又包含“交付 x/y”按钮，辅助技术会识别为嵌套操作。
- 修复后：节点选择和交付物入口改为并列按钮；点击和键盘 Enter 仍可展开节点。

### 4. “全部项目”视图下重新派发 AI伙伴无响应

- 修复前：详情跨项目查看时，Agent 操作仍使用页面项目筛选值；筛选为“全部项目”时该值为空，重新派发请求返回通用 `workflow operation failed`。
- 修复后：Agent 派发、取消和重试统一使用当前工作流实例的真实 `workspaceId`，不再依赖筛选栏状态。
- 已实测中断节点点击“重新派发 AI伙伴”后显示“已重新派发 AI伙伴 运行”，Console 无 error。

## 自动化验证

- `vitest run`：`33` 个测试文件，`527` 个用例通过。
- `tsc -p tsconfig.test.json --noEmit`：通过。
- `oxlint packages plugins`：通过，存在仓库既有 warning，无 error。
- `node --check plugins/dsh-collab-workflow/client/index.js`：通过。
- `git diff --check`：通过。

## 未覆盖

- 当前环境没有可用的 `flow-member` / `flow-viewer` 登录凭据，guest 只读和跨项目越权用例未重新执行。
- Agent 真实运行已启动并生成 session；本轮验收重点是“是否启动正确的 workflow run 和 session”，随后通过服务重启验证了中断恢复。未等待完整内容产出和人工交付验收。

## 证据

截图位于 `.tmp/gui-evidence/workflow/`，包括：

- `WF-01/template-manager.png`
- `WF-01/member-permissions.png`
- `WF-02/validation-negative.png`
- `WF-02/validation-positive-admin.png`
- `WF-03/new-workflow-dialog.png`
- `WF-03/new-workflow-dialog-mobile.png`
- `WF-04/release-node-expanded.png`
- `WF-09/reassigned-workflow-run.png`
- `WF-09/reassigned-run-interrupted-recovery.png`
- `WF-09/retry-button-fixed.png`
- `WF-11/refresh-list.png`
- `WF-13/mobile-detail-before.png`
- `WF-13/mobile-detail-after.png`
- `WF-14/parallel-overview-after-a11y-fix.png`
- `WF-14/n-choice-overview.png`
- `WF-14/subflow-expanded.png`
- `WF-14/delivery-popover.png`
- `E2E-WF-05/scope-switch-from-expanded-detail.png`
