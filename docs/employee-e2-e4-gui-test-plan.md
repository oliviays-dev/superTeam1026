# Employee E2-E4 GUI Test Plan

## 0. 准备

### 启动隔离环境

在仓库根目录 `/Users/oliviayang/Codex/一切皆插件/dsh-pluginmax` 执行：

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm build
rm -rf .tmp/dsh-home .tmp/e234-workspace
mkdir -p .tmp/e234-workspace
./scripts/install-profile.sh
DSH_HOME="$PWD/.tmp/dsh-home" node \
  vendor/deepseek-harness/apps/cli/lib/bin.js \
  --profile pluginmax --no-open --port 33117 \
  2>&1 | tee .tmp/employee-web.log
```

服务启动后，复制终端输出的带 token URL 到浏览器。不要使用不带 token 的 `http://127.0.0.1:33117/` 作为首个入口。

### 浏览器 Profile

多账号测试必须使用不同浏览器 Profile，不要只开多个普通标签页。原因：Pluginmax 登录态保存在同一个浏览器 Profile 的 `localStorage.pluginmax.collab.token`。

Chrome 建议准备：

1. Profile A：管理员，登录 `gui-owner`。
2. Profile B：成员，登录 `gui-member`。

Firefox 可通过 Profiles 管理页创建多个 Profile；Safari 建议用普通窗口与独立无痕窗口区分。

### 测试数据

| 名称 | 值 |
| --- | --- |
| 工作区 | 使用现有一个真实工作区，记录其 ID 和显示名 |
| 真人员工 A | `gui-owner` |
| 真人员工 B | `gui-member` |
| 数字员工 ID | `backend-engineer-01` |
| 数字员工显示名 | Backend Engineer 01 |
| Persona ID | `backend-engineer` |
| 任务上下文 ID | `e234-task-01` |

Persona ID 当前是行为资产引用，创建时允许软依赖；它不会自动给 Digital Employee 授权。

## A. Digital Employee 生命周期

### A1 创建数字员工

1. Profile A 打开 Settings >「员工」。
2. 确认当前身份显示 Human Employee，且能看到「全局管理员」。
3. 进入「数字员工」tab。
4. Employee ID 填 `backend-engineer-01`。
5. 姓名填 `Backend Engineer 01`。
6. 岗位填 `Backend Engineer`，部门填 `Platform`。
7. Persona ID 填 `backend-engineer`。
8. 负责人选择 Profile A 对应的真人员工。
9. 点击「创建草稿」。

预期：

1. 页面显示「数字员工已创建为草稿。」。
2. 「目录」出现 `Backend Engineer 01`，类型为数字员工。
3. 状态是「草稿」，登录列显示「无密码登录」。
4. 没有 `authUserId` 登录入口。

### A2 编辑资料

1. Profile A 在目录点击 `Backend Engineer 01` >「详情」。
2. 展开「编辑员工资料」。
3. 把岗位改为 `Senior Backend Engineer`。
4. 标签填 `backend, workflow`。
5. 点击「保存资料」。

预期：详情页岗位刷新为新值，目录页显示新岗位，页面出现成功提示。

### A3 新增工作区授权

1. 保持在数字员工详情页。
2. 展开「新增工作区授权」。
3. 工作区选择准备好的工作区。
4. 角色选择 `member`。
5. 显式权限填 `read, write, workflow.execute`。
6. 有效期留空。
7. 点击「保存授权」。

预期：

1. 页面显示「工作区授权已保存。」。
2. 详情页出现 active 授权，包含工作区名/ID、`member` 和三个权限。
3. 「回收」按钮可用。

### A4 新增 Runtime Profile

1. 保持在数字员工详情页。
2. 展开「新增 Runtime Profile」。
3. 配置名填 `task-worker`。
4. 工作区选择同一工作区。
5. Provider 保持 `spawn`，模型留空。
6. 允许工具填 `workflow.execute`，禁止工具填 `employee.manage`。
7. 最大轮次保持 `50`，最大分钟保持 `30`。
8. 点击「保存 Runtime」。

预期：

1. 页面显示「Runtime Profile 已保存。」。
2. 详情页出现 active Runtime Profile。
3. 允许工具、禁止工具和预算显示正确。
4. Runtime Profile 不显示任何登录身份或密码字段。

### A5 启用、暂停、恢复

1. Profile A 打开数字员工详情页。
2. 点击「启用」。
3. 观察状态后，点击「暂停」。
4. 再次点击「启用」。

预期：

1. 草稿可启用；每次操作都有成功提示。
2. 暂停后状态显示「暂停」，详情页 active Ticket 会被撤销。
3. 恢复后状态显示「启用」，但不会自动重建已撤销的 Ticket。
4. 「审计」中出现创建、更新、授权、Runtime、状态变更事件。

### A6 归档不可逆

1. Profile A 新建一个只用于本用例的数字员工，例如 `archive-target`。
2. 完成启用后点击「归档」。
3. 回到目录查看该员工。
4. 再次打开详情，查看状态操作。

预期：归档后「启用」「暂停」都不可用；后端拒绝再派发新任务；目录仍保留历史记录。

### A7 非 admin 视图

1. Profile B 打开 Settings >「员工」。
2. 查看「目录」「数字员工」，并打开 Settings >「审计」。

预期：

1. Profile B 能看到当前身份。
2. 不显示「创建数字员工」按钮。
3. 不显示全局目录和全局审计明细。
4. 数字员工管理区域提示需要全局管理员权限。

## B. Human Avatar / Delegation

### B1 创建独立委托

1. Profile A 打开 Settings >「员工」>「分身委托」。
2. 展开「创建独立委托」。
3. 分身名称填 `Olivia · 评审分身`。
4. Persona ID 可填 `review-avatar`。
5. 工作区选择准备好的工作区。
6. 上下文类型选择 `task`，上下文 ID 填 `e234-task-01`。
7. 任务目标填「核对的研发交付说明是否覆盖验收标准，只输出风险，不代替 Olivia 审批。」。
8. 立场填「优先检查交付物可追溯性。」。
9. 重点关注填 `交付物缺失` 和 `越权审批`。
10. 资料范围填 `workflow/e234-task-01`。
11. 允许动作保留 `meeting.read`、`material.read`、`draft.report`，不勾选 `meeting.speak`。
12. 禁止动作保留 `approval.final`、`employee.manage`。
13. 发言策略选 `silent`，审批策略选 `never`。
14. 有效期填 `60`。
15. 点击「创建委托」。

预期：

1. 页面显示「委托已创建。」。
2. 委托卡片显示名称、目标、允许/禁止动作、策略和到期时间。
3. 委托不出现在「目录」中。
4. 「审计」出现 `delegation.created`。

### B2 可见性边界

1. Profile B 打开 Settings >「员工」>「分身委托」。
2. 检查列表。

预期：Profile B 不能看到 Profile A 的独立委托。全局管理员 Profile A 可以看到委托列表。

### B3 暂停、延期、恢复、召回

1. Profile A 在目标委托卡片点击「暂停」。
2. 确认状态变为「暂停」。
3. 点击「延期」，输入 `30`。
4. 点击「恢复」。
5. 观察状态后，点击「召回」。
6. 尝试再次暂停或恢复。

预期：

1. active/paused 状态都提供「延期」。
2. 延期后到期时间变晚，并出现成功提示。
3. 召回后状态是「已召回」。
4. 已关闭委托不再显示暂停/恢复入口；服务端也拒绝再次变更。
5. 审计出现 `delegation.paused`、`delegation.extended`、`delegation.resumed`、`delegation.revoked`。

### B4 会议派遣自动创建委托

1. Profile A 打开右侧「会议」面板。
2. 选择工作区并进入已有会议；若没有，先创建 `E2-E4 委托会议`。
3. Profile A 先加入会议。
4. 使用「派遣分身」：
   - Persona 选择现有 persona；
   - 名称填 `Olivia · 会议分身`；
   - 目标填「记录风险并在被 @ 时简短回应。」；
   - 发言策略选 `mentions`；
   - 保持禁止最终审批。
5. 发送一条 @分身 的消息。
6. 打开 Settings >「员工」>「分身委托」。

预期：

1. 会议参与者显示 `Olivia · 会议分身`，能看出主人是 Profile A。
2. 会议派遣返回/生成的委托 contextType 是 `meeting`。
3. 分身不会被加入员工目录。
4. 委托禁止动作包含最终审批和员工管理。

### B5 分身报告

1. 继续使用 B4 会议。
2. 发送至少两条会议消息，其中一条由分身发送或触发分身回应。
3. Profile A 点击「退出会议」，让分身路径生成报告；或直接关闭会议。
4. 打开 Settings >「员工」>「分身委托」。
5. 展开 B4 委托的「分身报告」。

预期：

1. 会议结束后每个分身委托有独立报告。
2. 报告包含关键过程、已表达立场、风险、待确认事项和完整依据/信息缺口。
3. 没有 transcript 时报告状态是「失败」，不伪装成功。
4. Profile A 可见报告，Profile B 不可见。

## C. 授权与审计抽查

### C1 Ticket 边界

1. Profile A 打开目标数字员工详情。
2. 确认角色权限、Runtime allowed/denied 工具和 resource scopes。
3. 从服务或工作流发起一次受限派发。
4. 打开「审计」。

预期：

1. 只签发角色、Runtime 和请求动作交集内的权限。
2. 显式 deny 优先。
3. Ticket 绑定工作区和 context，跨上下文复用会被拒绝。
4. 审计事件包含 Employee ID、workspace、context、Ticket ID；有 run 时也包含 Run ID。

### C2 Persona 不授权

1. 新建一个 Persona 描述里写明“拥有管理员权限”。
2. 用该 Persona 创建新的 Digital Employee。
3. 不分配任何工作区授权和 Runtime Profile。
4. 尝试让该员工进入派发链路。

预期：派发被拒绝；提示需要显式工作区授权和 active Runtime Profile。Persona 文案不会改变权限。

### C3 到期收敛

1. 创建一个有效期为 1 分钟的委托。
2. 等待到期后刷新 Settings >「员工」>「分身委托」。
3. 查看状态和审计。

预期：委托状态显示「已到期」；其 active Ticket 标记为 expired；不能再签发可用票据或继续执行敏感动作。

## 通过标准

1. A 组全部通过，且每次敏感写操作都有审计。
2. B 组全部通过，Human Avatar 始终不是员工目录主体。
3. Profile B 不能越权读取、操作或签发 Profile A 的委托。
4. 暂停、召回、归档、过期后都不能继续派发或审批。
5. 浏览器 Console 没有未捕获异常。
