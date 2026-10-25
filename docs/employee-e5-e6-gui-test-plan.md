# E5 / E6 GUI 测试方案

## 准备

1. 仓库根目录执行 `corepack pnpm install --frozen-lockfile` 和 `corepack pnpm build`。
2. 用 `scripts/install-profile.sh` 准备项目内 DSH home。
3. 启动隔离 web 服务，并分别用 Profile A（全局管理员/工作区负责人）和 Profile B（普通成员）登录。
4. Profile A 先在 Settings >「员工」创建并启用 Digital Employee `Backend Engineer 01`。
5. 给该员工分配当前工作区 `member` 授权，权限至少包含 `read, write`。
6. 在员工详情新增 Runtime Profile，并在「映射 Task Worker Profile」填入一个当前工作区已启用、类型为 `task-worker` 的 Agent Profile。

## E5 Workflow 收敛

### A1 导入正式员工节点模板

1. Profile A 打开中间主操作区「工作流」。
2. 进入 Settings >「工作流」的模板导入区。
3. 选择 `docs/fixtures/workflow/employee-node.md`。
4. 点击「校验」，确认没有 error。
5. 点击「保存新版本」。

预期：

1. 模板保存成功；图形检查中开发节点显示「数字员工 · Backend Engineer 01」。
2. 员工不存在、未启用、缺少工作区授权、缺少 Runtime Profile 或缺少 Task Worker 映射时，校验出现明确 error。
3. 旧 `agent-node.md` 仍能正常导入。

### A2 启动并自动派发

1. Profile A 启动「Digital Employee 节点执行」实例。
2. 等待开发节点进入运行状态。
3. 展开「Digital Employee 运行」。
4. 打开 Settings >「审计」。

预期：

1. 节点显示 `Digital Employee 运行中`，执行者显示员工名，不显示裸 UUID。
2. 运行记录 principal 是 Digital Employee，并携带 ticket。
3. 审计出现 `employee.ticket.issued`。

### A3 输出与交付门禁

1. 等 Agent Run 成功，或在其提示词输出中写入 `# 交付报告` 与 `## 交付说明` 后等待结算。
2. 回到工作流实例刷新。
3. 打开 Settings >「审计」。

预期：

1. 输出先通过运行票据授权；审计出现允许的 `write`。
2. 交付说明自动生成为交付记录，提交者是 `employee:<id>`，显示名是员工名。
3. 所有 required 交付物满足前，节点不能完成；全部满足后可自动完成。
4. 输出缺少交付说明时，节点阻塞并提示可重试或人工代交。

### A4 票据失效

1. 在员工运行未结束前，把 Digital Employee 改为「暂停」。
2. 等 Agent Run 结束并刷新实例。
3. 再把员工恢复为「启用」。

预期：运行票据授权失败时输出被拒绝，节点阻塞并显示明确原因；不会自动完成，也不能绕过交付门禁。

### A5 人工兜底

1. 构造一个失败、取消或超时的员工节点。
2. 由责任人打开交付物区，提交满足要求的文本。
3. 点击「完成」。

预期：节点可由责任人或 owner/admin 人工兜底；操作留痕；后续节点继续推进。

## E6 治理、审计与报告中心

### B1 治理中心过滤

1. Profile A 打开 Settings >「员工」>「治理中心」。
2. 分别选择「全部工作区」和单个工作区。
3. 选择 `Backend Engineer 01`。
4. 设置开始/结束日期，再搜索「审批」「失败」「报告」。

预期：

1. 只有全局管理员能看到治理中心；Profile B 无法查看。
2. 员工、授权、票据、委托、审计和运行异常随过滤刷新。
3. 活动时间显示本地可读格式，不显示 UTC 原文。
4. 主标签使用员工名和工作区名；ID 只作为辅助信息。

### B2 权限矩阵与预算

1. 治理中心滚动到「权限矩阵与运行配置」。
2. 检查数字员工的角色、权限、到期时间、预算和 Task Worker 映射。

预期：权限来源清楚；没有映射的 Runtime Profile 出现在风险区；预算显示轮次和分钟。

### B3 风险与异常

1. 让一次 Agent Run 失败或超时。
2. 用无 `approve` 授权的员工定义一个审批人，再尝试导入/校验模板。
3. 回到治理中心搜索异常。

预期：失败、超时、越权、票据失效、员工受限和运行配置不完整会进入「风险与异常」。

### B4 分身报告中心

1. Profile A 在会议中派遣一个分身并发送几条消息。
2. 退出会议或关闭会议生成报告。
3. 在治理中心搜索该报告。

预期：报告可按关键词过滤；失败报告显示原因，成功报告可展开全文。

## 通过标准

1. `employee:` 和旧 `agent:` 模板都能导入；正式员工运行带 Employee Principal 和票据。
2. 交付物门禁、失败、取消、重试和人工兜底行为与旧 Agent 节点一致。
3. 治理中心能回答“谁做的、权限来自哪里、结果和异常是什么”。
4. 浏览器 Console 没有未捕获异常。
