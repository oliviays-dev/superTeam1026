# 工作流 GUI 测试方案

> 说明：本文件是早期 GUI 测试方案；当前从零执行和端到端主计划见 `docs/gui-test-plan-workflow-from-zero.md`。后者已于 2026-10-19 增补列表 / 详情、数据范围、节点编码、并行 vs N 选 1、子流程嵌套和交付物时间等回归项。

## 0. 准备

仓库根目录是：

```sh
/Users/oliviayang/Codex/一切皆插件/dsh-pluginmax
```

进入仓库并构建：

```sh
cd /Users/oliviayang/Codex/一切皆插件/dsh-pluginmax
corepack pnpm install --frozen-lockfile
corepack pnpm build
```

启动隔离环境：

```sh
rm -rf .tmp/workflow-home .tmp/workflow-gui-workspace
mkdir -p .tmp/workflow-gui-workspace
./scripts/install-profile.sh
DSH_HOME="$PWD/.tmp/workflow-home" node \
  vendor/deepseek-harness/apps/cli/lib/bin.js \
  --profile pluginmax --no-open --port 33118 \
  2>&1 | tee .tmp/workflow-web.log
```

复制终端输出的带 token URL 到浏览器。若刷新出现 `authentication required`，关闭旧页签，重新复制最新 URL。

### 浏览器 Profile 隔离

1. 在 Chrome/Edge 点击地址栏右侧头像。
2. 选择“添加新的 Chrome Profile / 添加 Profile”。
3. 选择“不登录继续”，命名 Profile A / Profile B / Profile C。
4. 在每个 Profile 中分别打开最新带 token URL。
5. 每个 Profile 使用不同账号登录“协作身份”。不要只用同一 Profile 里的多个普通标签页。

### 账号与工作区

1. 首次进入“协作身份”时创建 admin：`workflow-admin`。
2. Settings > 协作身份 > 成员管理，新增 `flow-owner`、`workflow-member`。
3. 创建或选择一个测试工作区。
4. 将 `flow-owner` 加入该工作区，角色 owner；将 `workflow-member`、`workflow-admin` 加入为 member。
5. 三个 Profile 分别登录 `workflow-admin`、`flow-owner`、`workflow-member`。

### 测试文件

- [产品交付主流程](/Users/oliviayang/Codex/一切皆插件/dsh-pluginmax/docs/fixtures/workflow/product-delivery.md)：审批、并行、汇合、发布。
- [产品交付交付物增强流程](/Users/oliviayang/Codex/一切皆插件/dsh-pluginmax/docs/fixtures/workflow/product-delivery-v2.md)：必交文本、选交链接和 Agent 节点人工代交。
- [受控返工流程](/Users/oliviayang/Codex/一切皆插件/dsh-pluginmax/docs/fixtures/workflow/controlled-loop.md)：审批否决回边和 break。
- [子流程模板](/Users/oliviayang/Codex/一切皆插件/dsh-pluginmax/docs/fixtures/workflow/sub-process.md)：两段审批。
- [父子流程模板](/Users/oliviayang/Codex/一切皆插件/dsh-pluginmax/docs/fixtures/workflow/parent-child.md)：规则判断和子流程。
- [非法死循环](/Users/oliviayang/Codex/一切皆插件/dsh-pluginmax/docs/fixtures/workflow/invalid-cycle.md)：校验应失败。

## A. 管理端导入与图形检查

### A1 导入合法主流程

前置条件：测试工作区尚未导入 `product-delivery v1`。如果模板列表已有 `产品交付 v1`，本用例只执行第 2-7 步检查校验和图形；不要重复保存，直接进入 A2。

1. Profile A 登录 `workflow-admin`。
2. 打开 Settings > 工作流。
3. 在“工作区”下拉框选择测试工作区。
4. 在“导入 Markdown 模板”区域点击文件选择框，选择 `docs/fixtures/workflow/product-delivery.md`。
5. 确认“保存后启用”勾选。
6. 点击“校验”。
7. 阅读校验结果和下方节点图形检查。
8. 点击“保存新版本”。

预期：

- 校验显示 1 条黄色预警，内容包含 `development has an agent executor without responsible`；没有红色错误。该提示说明 Agent 执行节点未声明人类责任人，导入后先由工作区 owner/admin 代为处理。
- 图形检查按顺序显示：需求评审、开发、测试准备、发布审批、发布；节点类型显示“审批 / 任务 / 服务”。
- 保存成功显示绿色反馈：“已保存「产品交付」v1”。
- 定义列表出现 `产品交付 v1`，状态“启用”。

重复导入同一份 `v1` 时，应显示红色反馈：“该模板版本已存在。请把 Markdown 元信息里的 version 改成新版本号，或换一个流程 key。”，定义列表不产生重复记录。

### A2 导入交付物增强版本

1. Profile A 仍在 Settings > 工作流。
2. 选择 `docs/fixtures/workflow/product-delivery-v2.md`。
3. 点击“校验”。
4. 确认图形检查中“开发”节点后出现交付物要求。
5. 点击“保存新版本”。

预期：

- 校验没有错误；可选链接交付物显示为“选交”。
- “开发交付说明”显示为“必交 · 文本”。
- “实现分支”显示为“选交 · 链接”。
- 保存成功显示“已保存「产品交付」v2”。

### A3 非法死循环被拒绝

1. 仍在 Settings > 工作流。
2. 重新选择 `docs/fixtures/workflow/invalid-cycle.md`。
3. 点击“校验”。
4. 尝试点击“保存新版本”。

预期：

- 校验区出现红色错误，内容包含“cycle requires a break condition”。
- “保存新版本”仍可点击，但提交后显示红色错误，不会落库。
- 定义列表不出现 `invalid-cycle`。

### A4 非 owner/admin 控件禁用

1. Profile C 登录 `workflow-member`。
2. 打开 Settings > 工作流。
3. 查看导入编辑器和按钮状态。

预期：

- 可以看到工作区和模板列表。
- “校验”“保存新版本”禁用。
- 页面明确显示：“流程模板由工作区负责人或全局管理员管理”。

## B. 中间工作流页签与会话过滤

工作流页签中的“发起表单”常显；权限不足时不显示表单，只显示权限说明。

### B1 启动并过滤当前会话

1. Profile B 在测试工作区打开一个会话，记住会话标题，例如“开发会话”。
2. 打开中间页签“工作流”。
3. 确认顶部显示“工作区名称 / 开发会话”。
4. 确认发起表单可见，模板选择“产品交付 v2”。
5. 标题输入“订单导出功能”，点击“启动”。
6. 保持过滤为“只看当前会话”。
7. 在另一个会话重复启动一个实例，标题“另一个会话流程”。
8. 回到“开发会话”的工作流页签。

预期：

- 启动后显示“已启动工作流”。
- 列表只显示关联当前会话的实例。
- 过滤标识显示“当前会话相关 · 1 条”。
- 点击“查看工作区全部”后，能看到“另一个会话流程”。
- 切回“只看当前会话”后，“另一个会话流程”消失。

### B2 空状态

1. 新建一个没有关联流程的会话。
2. 打开“工作流”页签，保持“只看当前会话”。
3. 切换到“查看工作区全部”。

预期：

- 当前会话视图显示：“当前会话没有相关流程实例。”
- 工作区全部视图显示已有实例，或显示工作区空状态。
- 浏览器 Console 没有未捕获异常。

## C. 审批、串并行与汇合

### C1 需求评审通过后唤醒并行节点

1. Profile C 打开“开发会话”的“工作流”页签。
2. 展开“订单导出功能”。
3. 确认“需求评审”的状态是“可执行”，审批人显示 `workflow-member`。
4. 点击“通过”。

预期：

- 点击期间按钮禁用；成功后显示“已通过审批”。
- “需求评审”变为“完成”。
- “开发”和“测试准备”同时变为“可执行”。
- 卡片摘要显示“当前：开发、测试准备”，不显示内部节点 ID。
- 事件摘要包含通过审批。

### C2 并行汇合

1. 继续在“订单导出功能”中，展开“开发”。
2. 确认交付要求区域显示“开发交付说明”和“实现分支”。
3. 先尝试点击“完成”。
4. 在“开发交付说明”中输入至少 30 个字：`完成订单导出接口与数据结构，覆盖权限、并发导出和空结果场景，记录已知风险。`
5. 点击“提交交付物”。
6. 可选：在“实现分支”粘贴一个 `https://` 开头的链接，并再次提交。
7. 点击“完成”。
8. 观察“发布审批”。
9. Profile C 完成“测试准备”。

预期：

- 没有提交文本前，“完成”按钮显示为“缺少 1 项交付物”并禁用。
- 提交成功显示“已提交「开发交付说明」”，状态变为“已提交”。
- 提交后“完成”按钮恢复可用。
- 只完成“开发”时，“发布审批”仍保持等待，因为另一条并行分支未完成。
- “测试准备”也完成后，“发布审批”变为“可执行”。
- “发布”在发布审批完成前保持等待。

### C3 发布审批通过

1. Profile B 登录 `flow-owner`，展开“订单导出功能”。
2. 对“发布审批”点击“通过”。
3. Profile C 登录 `workflow-member`，对同一“发布审批”点击“通过”。
4. “发布”变为“可执行”后，由 Profile B 或 Profile C 点击“完成”。

预期：

- 发布审批策略是“all”，第一位通过后节点仍显示等待。
- 两位审批人都通过后，“发布审批”完成。
- “发布”变为“可执行”，卡片提示由工作区负责人或管理员处理。
- 点击完成后，“发布”变为“完成”，实例状态变为“完成”。

## D. 审批转交与加签

### D1 转交

1. Profile C 打开一个自己的待审批节点，例如新的“产品交付”实例的“需求评审”。
2. 点击“转交”。
3. 在“转交给”下拉框选择 `flow-owner`。
4. 点击“确认”。

预期：

- 显示“已转交审批”。
- 原审批人状态变为“已转交”。
- `flow-owner` 出现在待审批列表。
- Profile C 不再看到“通过 / 否决”按钮。

### D2 加签

1. Profile B 打开已被转交给自己的审批节点。
2. 点击“加签”。
3. 选择 `workflow-admin`。
4. 点击“确认”。
5. Profile B 先点击“通过”。
6. Profile C 打开同一实例，再对加签审批点击“通过”。

预期：

- 加签后必签人数增加。
- Profile B 通过后节点仍未完成。
- Profile C 也通过后节点完成，并推进后续节点。
- 每次操作都有事件摘要。

## E. 判断分支与子流程

### E1 导入父子模板

1. Profile A 打开 Settings > 工作流。
2. 先导入 `docs/fixtures/workflow/sub-process.md`。
3. 再导入 `docs/fixtures/workflow/parent-child.md`。

预期：

- 两个模板都保存并启用。
- “复杂方案评审”子模板和“带子流程的交付”父模板都出现在列表中。

### E2 高分走子流程

1. Profile B 打开“工作流”页签，发起“带子流程的交付”，标题“复杂方案实例”。
2. 展开“复杂方案实例”。
3. 在“方案判断”点击“录入判断”。
4. 确认 JSON 至少包含 `"complexity": 8`。
5. 点击“确认”。

预期：

- “方案判断”完成。
- “复杂方案评审”变为“进行中”。
- “标准开发”保持等待。
- 列表中出现一个子实例，标题形如“复杂方案实例 · 复杂方案评审”。

### E3 子流程完成回写父流程

1. Profile A 打开子实例。
2. Profile B 在父实例的「复杂方案评审」节点下的嵌套子流程卡片中，对“架构评审”点击“通过”。
3. Profile C 在同一张嵌套卡片中，对“安全复核”点击“通过”。
4. 回到父实例“复杂方案实例”。

预期：

- 子实例两个审批完成后，状态变为“完成”。
- 父实例的“复杂方案评审”变为“完成”。
- 父实例的“归档”变为“可执行”。
- 完成归档后父实例状态为“完成”，摘要仍显示全流程节点顺序；“标准开发”显示为“跳过”。

### E4 低分走标准分支

1. 再启动一个“带子流程的交付”，标题“标准方案实例”。
2. 在“方案判断”录入 `"complexity": 3`。
3. 展开父实例，查看“标准开发”完成按钮。
4. Profile C 确认按钮禁用，文案为“Owner/Admin 可完成”。
5. Profile B 点击“完成”。

预期：

- “标准开发”变为“可执行”。
- “复杂方案评审”保持等待，不创建子实例。
- 完成标准开发后，“归档”变为“可执行”。
- 未授权账号不能触发完成请求；只有 owner/admin 能完成无责任人的 Agent 节点。

## F. 受控循环 break

### F1 前两次否决可返工

1. Profile B 启动“受控返工流程”，标题“返工流程”。
2. 展开“返工流程”。
3. Profile B 完成“需求确认”。
4. Profile B 或可执行成员完成“开发”。
5. Profile C 对“测试”点击“否决”。
6. 观察实例状态。

预期：

- “测试”完成，否决结果被记录。
- “开发”重新变为“可执行”，卡片摘要显示“当前：开发”。
- 实例状态不是阻塞。
- “测试”节点下方显示循环保护提示：最多尝试 3 次；当前第 2 / 3 次。

### F2 第三次否决触发 break

1. 第二次完成“开发”。
2. Profile C 再次对“测试”点击“否决”。
3. 第三次完成“开发”。
4. Profile C 第三次对“测试”点击“否决”。
5. 展开节点详情。

说明：本模板默认 `attempts = 1`。第三次否决回边时上下文中的尝试数达到 `attempts >= 3`。

预期：

- “开发”变为“阻塞”。
- 阻塞说明包含“已触发 break：attempts >= 3”。
- “开发”节点下方显示红色说明：“已达到尝试上限：最多尝试 3 次，后续流程已阻断。”
- 实例状态变为“阻塞”。
- “发布就绪”保持等待，不能继续推进。

## G. 权限、登录与反馈

### G1 未登录

1. 打开浏览器开发者工具，切到“Application”（Safari 中为“存储”）面板。
2. 展开“Local Storage”，选中当前站点，删除键 `pluginmax.collab.token`。
3. 刷新页面。
4. 打开“工作流”页签。

备选方法（不推荐）：如果习惯使用 Console，Chrome/Edge 会拦截首次粘贴并要求先输入 `allow pasting` 回车解锁，然后才能粘贴执行：

```js
localStorage.removeItem("pluginmax.collab.token");
```

预期：

- 页签显示“请先在「协作身份」登录。”
- 不显示实例数据、UUID 列表或可操作按钮。

### G2 跨工作区不可读

1. 让 Profile C 只加入测试工作区 A。
2. 在另一个工作区 B 中用其他账号创建工作流实例。
3. Profile C 打开自己会话的工作流页签。
4. 切换“查看工作区全部”。

预期：

- Profile C 只能看到自己有权的工作区数据。
- 不出现工作区 B 的实例。
- 如果直接构造不可访问工作区的请求，服务端返回 403，界面显示中文错误。

### G3 操作反馈与防重复

1. 展开“订单导出功能”。
2. 快速连续点击“通过”或“完成”。
3. 临时断网或输入错误判断 JSON 后再次提交。

预期：

- 提交期间按钮禁用。
- 同一节点不会生成重复完成/审批事件。
- 判断 JSON 错误时显示红色中文提示，流程不推进。
- 网络或权限错误显示服务端返回的中文原因。
