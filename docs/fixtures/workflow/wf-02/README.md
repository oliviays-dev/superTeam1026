# WF-02 测试资料

按文件名编号顺序使用。所有文件都从全局 `工作流 > 模板管理 > 新建模版` 导入或粘贴。

| 步骤 | 文件 | 操作 | 预期 |
| --- | --- | --- | --- |
| 2-3（全新环境） | `step-02-gui-from-zero-v1.md` | 粘贴并校验，通过后保存 | `GUI 从零验收` `v1` 保存成功，详情有 4 个节点 |
| 2-3（复用环境备用） | `step-02-gui-from-zero-v3.md` | 当前环境已有 v1/v2 时粘贴并校验，通过后保存 | `GUI 从零验收` `v3` 保存成功，详情有 4 个节点 |
| 4 | `step-04-validation-negative-v1.md` | 粘贴后校验 | 校验失败；错误完整列出执行人和审批人 `workflow-member 不是平台账号` |
| 5 | `step-04-validation-negative-v1.md` | 不修改内容，再次校验 | 仍显示同一组校验失败，不能变成通过 |
| 6 | `step-06-validation-positive-v1.md` | 粘贴后校验 | 校验通过；不保存，点击右上角 `x` 关闭 |
| 7 | `step-07-product-delivery-v7.md` | 导入并保存 | `产品交付 v7` 保存成功，详情显示并行分支 |
| 8 | `step-08-invalid-cycle-v2.md` | 粘贴后尝试校验/保存 | 显示 `cycle requires a break condition`，不能落库 |

如果某个 `key + version` 已在当前环境导入过，先看左侧列表中该 key 的最高版本；归档版本也占用版本号。全新环境用 `v1`；当前环境已有 v1/v2 时，复用备用文件 `v3`。
