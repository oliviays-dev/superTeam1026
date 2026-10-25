# DSH Pluginmax R1-R4 GUI 测试方案

## 范围与基线

- 被测版本：R4，提交 `4b8ef43bbb6f387f64970540d289b0bfc99719de`。
- 上游基线：`vendor/deepseek-harness` 锁定在 `d347e703908d0406b7a7ef80e3a0e594d86b2215`。
- 被测插件：`dsh-collab-identity`、`dsh-collab-space`、`dsh-collab-roles`、`dsh-collab-meeting`。
- 测试入口：锁定上游 DSH Web 的 Settings 面板中的「协作身份」「共享」「角色」「会议」。
- 测试目标：从真实用户视角验证首次初始化、成员协作、共享审批、角色席位、多人会议和权限拒绝路径。

## 测试环境准备

### 1. 启动隔离环境

仓库根目录是本项目的 `dsh-pluginmax` 目录：

```sh
/Users/oliviayang/Codex/一切皆插件/dsh-pluginmax
```

如果刚打开一个新的终端，先执行：

```sh
cd "/Users/oliviayang/Codex/一切皆插件/dsh-pluginmax"
```

如果当前已经在 `/Users/oliviayang/Codex/一切皆插件`，也可以执行：

```sh
cd dsh-pluginmax
```

进入后用 `pwd` 确认输出以上完整路径，再用 `ls package.json` 确认能看到该文件。后续命令都在这个目录执行：

```sh
mkdir -p .tmp/bin
corepack enable --install-directory "$PWD/.tmp/bin" pnpm
export PATH="$PWD/.tmp/bin:$PATH"
pnpm --version
```

确认 `pnpm --version` 输出 `11.7.0`。如果新开终端，需要重新执行上面的 `export PATH="$PWD/.tmp/bin:$PATH"`。然后一次性执行构建和安装；使用 `&&` 可以保证前一步失败时立刻停止：

```sh
pnpm install --frozen-lockfile && \
pnpm build && \
rm -rf .tmp/dsh-home .tmp/gui-workspace && \
mkdir -p .tmp/gui-workspace && \
./scripts/install-profile.sh
```

安装成功后再启动 Web：

```sh
DSH_HOME="$PWD/.tmp/dsh-home" node \
  vendor/deepseek-harness/apps/cli/lib/bin.js \
  --profile pluginmax --no-open --port 33117 \
  2>&1 | tee .tmp/gui-web.log
```

等待日志出现 `dsh web: http://127.0.0.1:33117/...`。不要打开裸地址，必须打开日志中的完整 launch URL，否则可能缺少上游 Web 的授权上下文。

### 2. 创建 GUI 工作区

1. 在浏览器 Profile A 中打开完整 launch URL。
2. 在左侧「工作区」区域选择「添加工作区…」。
3. 选择这个已创建的空目录：

   ```text
   /Users/oliviayang/Codex/一切皆插件/dsh-pluginmax/.tmp/gui-workspace
   ```

   如果 GUI 打开的是 macOS 目录选择器，但看不到 `.tmp`，按 `Cmd+Shift+G`，粘贴上面的完整路径后回车，再点击「选择」或「Open」。
4. 进入该工作区，等待 Web 会话加载完成。
5. 打开 Settings，确认左侧导航能看到：
   - 协作身份
   - 共享
   - 角色
   - 会议
6. 先打开「协作身份」。如果是全新环境，用以下数据完成管理员初始化：
   - 用户 ID：`gui-admin`
   - 显示名称：`Admin`
   - 密码：`Admin-pass-123`

   如果已经初始化过，则用 `gui-admin` / `Admin-pass-123` 登录。
7. 在「协作身份」>「工作区成员」的工作区下拉框中，选择标题或路径包含 `.tmp/gui-workspace` 的工作区。点击右侧「工作区信息」图标，可查看名称、路径和工作区 ID，并点击「复制 ID」。这个 ID 就是下文的 `<WS_ID>`。
8. 返回「共享」。只有在「协作身份」登录成功后，「共享」顶部才会显示「工作区」下拉框。选择同一个工作区。

预期：四个 Pluginmax 设置分区都可见，无空白分区；登录后「共享」显示工作区下拉框；浏览器 Console 没有未捕获异常。

### 3. 测试账户矩阵

| Profile | 用户 ID | 显示名称 | 初始密码 | 全局角色 | 工作区角色 |
|---|---|---|---|---|---|
| A | `gui-admin` | `Admin` | `Admin-pass-123` | `admin` | 不需要添加，服务端有 admin 例外 |
| B | `gui-owner` | `Owner` | `Owner-pass-123` | `owner` | `owner` |
| C | `gui-member` | `Member` | `Member-pass-123` | `member` | `member` |
| D | `gui-guest` | `Guest` | `Guest-pass-123` | `guest` | 不添加 |

多账户测试必须使用不同浏览器 Profile，不要只依赖多个普通标签页，因为 Pluginmax Bearer token 保存在同一个浏览器 Profile 的 `localStorage.pluginmax.collab.token` 中。具体创建和切换方法见「附录 A：使用不同浏览器 Profile 测试多账户」。

## 测试约定

- 「Profile A/B/C/D」分别表示使用上表中的浏览器 Profile 登录。
- API 返回和持久化数据中的时间使用 UTC ISO 8601 字符串；「咨询锁」GUI 的到期时间显示为本地时间，便于人工判断。
- 每个用例结束后保留页面截图，文件名使用测试编号，例如 `B2-deny-policy.png`。
- 故意触发的 400/401/403 网络响应不算缺陷；浏览器 Console 中不应出现未捕获的 JavaScript 异常。
- 若某个用例依赖前置数据，先执行「标准数据准备」；单独重跑该用例时，需要按前置条件补齐数据。

## 核心用例

### A1. 首次启动与管理员 bootstrap

**优先级**：P0  
**前置**：使用全新 `.tmp/dsh-home`。  
**覆盖**：R1。

1. Profile A 打开 Settings >「协作身份」。
2. 确认页面处于 bootstrap 状态，包含「用户 ID」「显示名称」「密码」「创建管理员」。
3. 输入 `gui-admin`、`Admin`、`Admin-pass-123`。
4. 点击「创建管理员」。
5. 刷新页面。

**预期**：

- 创建后显示绿色提示「已创建管理员 gui-admin」。
- 页面显示 `Admin`、`gui-admin`、`admin`。
- 出现「账号」「工作区成员」「审计时间线」管理面板。
- 刷新后仍保持登录态，「协作身份」不回退到登录表单。
- 审计时间线至少有 `bootstrap` 一条记录。

### A2. 创建成员并绑定工作区

**优先级**：P0  
**前置**：A1 完成，已取得 `<WS_ID>`。  
**覆盖**：R1。

1. 在 Profile A >「协作身份」>「账号」中依次创建：
   - `gui-owner` / `Owner` / `Owner-pass-123` / 全局角色 `owner`
   - `gui-member` / `Member` / `Member-pass-123` / 全局角色 `member`
   - `gui-guest` / `Guest` / `Guest-pass-123` / 全局角色 `guest`
2. 每次创建后确认「账号」表格出现新用户，且提示为「成员账号已创建」。
3. 在「工作区成员」的「工作区」下拉框中选择 `<WS_ID>`。下方会显示完整工作区 ID，不要手工输入 `main`。
4. 输入 `gui-owner`，成员角色选 `owner`，点击「保存成员」。
5. 输入 `gui-member`，成员角色选 `member`，点击「保存成员」。
6. 不要添加 `gui-guest`。
7. 点击「协作身份」标题右侧的「刷新」。

**预期**：

- 「账号」表格包含三个新用户和正确全局角色。
- 「工作区成员」表格包含 `gui-owner/owner` 和 `gui-member/member`，不包含 `gui-guest`。
- 审计时间线出现 `register_user`、`member_add`。

### A3. 修改密码、退出与旧密码拒绝

**优先级**：P0  
**前置**：A2 完成。  
**覆盖**：R1。

1. Profile B 打开 Settings >「协作身份」。
2. 使用 `gui-owner` / `Owner-pass-123` 登录。
3. 在「当前密码」输入 `Owner-pass-123`，「新密码」输入 `Owner-pass-456`。
4. 点击「更新密码」。
5. 点击页面右上角的「退出登录」。
6. 先用旧密码 `Owner-pass-123` 再登录一次。
7. 改用新密码 `Owner-pass-456` 登录。

**预期**：

- 改密成功显示「密码已更新」。
- 退出后显示「已退出登录」，管理性和个人账号数据清空，回到登录表单。
- 旧密码登录失败，页面显示「用户 ID 或密码不正确。」
- 新密码登录成功，显示 `Owner / gui-owner / owner`。

### B1. 工作区共享文档写入与读取

**优先级**：P0  
**前置**：A2 完成，Profile B 已登录。  
**覆盖**：R2。

1. Profile B 打开 Settings >「共享」。
2. 顶部「工作区」选择 `<WS_ID>`。
3. 在「上传与文档」中输入路径 `docs/kickoff.md`，「范围」选 `workspace`。
4. 在「内容」输入：

   ```md
   # Kickoff

   目标：完成 Pluginmax GUI 回归。
   ```

5. 点击「上传」。
6. 在文件表中点击 `docs/kickoff.md` 的「读取」。
7. Profile A 也打开「共享」，选择同一个 `<WS_ID>`，点击 `docs/kickoff.md` 的「读取」。

**预期**：

- 上传后显示「已共享 docs/kickoff.md」。
- 文件表出现 `docs/kickoff.md`，范围为 `workspace`，大小大于 0，来源为 `user`。
- 内容预览显示完整 Markdown 文本。
- Profile A 与 Profile B 都能读取同一内容。
- 「摘要与审计」出现 `file_write`，读取后出现 `file_read`。

### B2. deny 策略优先、路径穿越与密钥扫描

**优先级**：P0  
**前置**：B1 完成，Profile B 已登录。  
**覆盖**：R2。

1. Profile B 在「策略」中输入匹配 `docs/confidential.md`，「范围」选 `workspace`，「权限」输入 `read`，「效果」选 `deny`。
2. 点击「添加」。
3. 上传路径 `docs/confidential.md`，内容 `内部评审材料`，范围为 `workspace`。
4. 点击该文件的「读取」。
5. 再次尝试上传路径 `../escape.md`，内容 `bad path`。
6. 尝试上传路径 `docs/secret-note.md`，内容包含 `key = sk-abcdefghijklmnopqrstuvwx`。

**预期**：

- deny 策略添加成功，并出现在策略表。
- `docs/confidential.md` 可上传，但读取被拒绝，页面显示 `matched deny policy`。
- `../escape.md` 被拒绝，错误信息包含 normalized path 或路径格式不合法，文件表不出现该文件。
- 包含密钥的内容被拒绝，错误信息为 `content contains a detected secret`，文件表不出现 `docs/secret-note.md`。
- 每次失败后点击「刷新」，确认失败输入没有写入文件表。

### B3. 全局共享审批链

**优先级**：P0  
**前置**：A2 完成；Profile B 是 `gui-owner`，Profile A 是 `gui-admin`。  
**覆盖**：R2。

1. Profile B 打开 Settings >「共享」，选择 `<WS_ID>`。
2. 上传路径 `reports/global-summary.md`，「范围」选 `global`，内容输入 `跨工作区只读摘要`。
3. 观察提示后，切到 Profile A >「共享」。
4. 在 Profile A 的「全局审批」中找到 `reports/global-summary.md`，确认状态为 `pending`。
5. 先不要批准；回到 Profile B，再提交一个全局文件 `reports/rejected.md`，内容 `不应批准`。
6. Profile A 在「全局审批」中拒绝 `reports/rejected.md`。
7. Profile A 批准 `reports/global-summary.md`。

**预期**：

- Profile B 全局上传提示「全局共享已提交审批」加请求 ID；文件不会立刻出现在工作区文件表。
- 只有 Profile A 能看到「全局审批」面板；Profile B 不应看到该面板。
- 拒绝后 `rejected.md` 状态变为 `rejected`，按钮变为不可用。
- 批准后 `global-summary.md` 状态变为 `approved`。
- 审计中出现 `global_submit`、`global_approve`、`global_reject`。

### B4. 咨询锁并发冲突

**优先级**：P1  
**前置**：A2 完成；Profile B 是工作区 owner。  
**覆盖**：R2。  
1. Profile B 打开 Settings >「共享」>「咨询锁」。
2. 路径输入 `docs/kickoff.md`。
3. 点击「加锁」。
4. 观察提示和「咨询锁」表。
5. 保持 Profile B 不释放锁，另开一个已登录同一工作区的浏览器 Profile，对同一路径点击「加锁」。

**用户视角预期**：

- 第一个用户能获得锁，「咨询锁」表显示路径、持有者、登录会话短标识和本地格式的到期时间。
- 第二个用户应看到明确的中文冲突提示，其中到期时间也是本地格式；不产生第二把活跃锁。
- 第一个用户点击「释放」后，第二个用户可以重新获得锁。

**按当前实现的判定**：

- 不得出现 `lock requires a session id` 或其他原始内部错误。
- 不得出现页面崩溃、重复锁或失败后仍然显示活跃锁。

### C1. 创建人设与工作区类型并物化

**优先级**：P0  
**前置**：A2 完成，Profile A 已登录。  
**覆盖**：R3。

1. Profile A 打开 Settings >「角色」。
2. 在「工作区」下拉框选择包含 `.tmp/gui-workspace` 的工作区；如需确认或复制 ID，点击右侧「工作区信息」图标。
3. 在「人设」中输入：
   - 标识：`architect`
   - 名称：`Architect`
   - 标签：`architecture, review`
   - 描述：`Owns module boundaries.`
   - SOUL：`Use engineering judgment. Prefer small, reversible changes.`
4. 点击「创建」。
5. 在「工作区类型」中输入：
   - 标识：`delivery`
   - 名称：`Delivery team`
   - 席位 JSON：

   ```json
   [
     {"id":"facilitator","label":"主持人","participantKind":"human","permissions":["read","write","approve"]},
     {"id":"reviewer","label":"评审人","participantKind":"human","permissions":["read","approve"]},
     {"id":"builder","label":"Builder","participantKind":"agent","personaId":"architect","permissions":["read","write"]}
   ]
   ```

6. 点击「创建」。
7. 在类型表 `delivery` 行点击「物化」。

**预期**：

- 人设表出现 `architect`，标签显示 `architecture, review`。
- 类型表出现 `delivery`，席位数显示 `3`。
- 物化后提示「已物化 Delivery team」。
- 「角色席位」表出现三行：`主持人`、`评审人`、`Builder`，初始状态均为空或未认领，`Builder` 关联 `architect`。

### C2. 席位认领、幂等认领与 Leader 转移

**优先级**：P0  
**前置**：C1 完成；Profile B/C 已登录。  
**覆盖**：R3。

1. Profile B 打开「角色」，把「工作区」改成 `<WS_ID>`。
2. 在「选择席位」中选「主持人」，点击「认领」。
3. 刷新后确认席位表。
4. Profile C 打开「角色」，设置同一 `<WS_ID>`。
5. 选择「评审人」，点击「认领」。
6. Profile B 保持已选「主持人」，再次点击「认领」。
7. Profile B 点击「主持人」行的「释放」。
8. 刷新后查看当前是否还有 Leader。
9. Profile B 再次选择「主持人」并点击「认领」。

**预期**：

- Profile B 第一次认领后提示「已认领 主持人」，`主持人` 行显示 `user/gui-owner`，Leader 为「是」。
- Profile C 认领后，`评审人` 行显示 `user/gui-member`，Leader 为「否」。
- 同一用户重复认领同一席位是幂等的：不报错，不产生第二行，Leader 保持不变。
- Leader 释放后，该席位状态为 `released`，没有其他席位持有 Leader。
- Leader 重新认领后再次显示为 Leader。

### C3. 非 admin 不能创建工作区类型

**优先级**：P1  
**前置**：Profile B 已登录。  
**覆盖**：R3 权限回归。

1. Profile B 打开「角色」。
2. 在「工作区类型」输入标识 `member-type`、名称 `Member type`，保留默认席位 JSON。
3. 点击「创建」。

**预期**：

- 请求被服务端拒绝，页面显示 `admin role is required for type creation`。
- 类型表不出现 `member-type`。
- 页面保持可用，其他面板不崩溃。

### D1. 多人会议创建、加入与 transcript

**优先级**：P0  
**前置**：A2/C2 完成；Profile B/C 已登录。  
**覆盖**：R4。

1. Profile B 打开 Settings >「会议」，把「工作区」改成 `<WS_ID>`。
2. 输入标题 `Delivery sync`，议程输入：

   ```md
   1. Review kickoff doc.
   2. Confirm next actions.
   ```

3. 点击「创建」。
4. 在详情面板的「入会名称」输入 `Owner`，点击「加入」。
5. 在「发言」输入 `Kickoff is ready for review.`，点击「发送」。
6. Profile C 打开「会议」，设置同一 `<WS_ID>`。
7. 在会议列表点击 `Delivery sync` 的「查看」。
8. 「入会名称」输入 `Member`，点击「加入」。
9. Profile C 发送 `I can review the shared doc.`。
10. Profile B 点击「刷新」。

**预期**：

- 创建后提示「已创建 Delivery sync」，详情自动打开。
- Profile B 加入后提示「已加入会议」，参与者表中 `Owner` 为 `真人/在任`，Leader 为「是」。
- Profile C 加入后，`Member` 也显示 `真人/在任`，Leader 为「否」。
- 两条发言都出现在 transcript，序号连续；Profile B 刷新后也能看到 Profile C 的发言。

### D2. 角色席位同步与待认领提示

**优先级**：P0  
**前置**：D1 完成且会议仍为 active；C1/C2 产生已认领的人类席位，`Builder` 未指派。  
**覆盖**：R3/R4 集成。

1. Profile B 打开 `Delivery sync` 详情。
2. 点击「同步席位」。
3. 刷新详情。
4. 检查参与者表。
5. 确认每个 pending 席位的「提示」列。

**预期**：

- 提示「已同步角色席位」。
- `主持人` 席位同步到 `gui-owner` 的角色在任者。
- `评审人` 席位同步到 `gui-member` 的角色在任者。
- `Builder` 没有在任者时显示为 `Agent/待认领`，人设为 `architect`。
- `Builder` 的提示包含 `/assignment claim <WS_ID> builder`。
- 已离开的席位不会被重复拉回为在任者。

### D3. 成员离开 tombstone、关闭会议与冷恢复

**优先级**：P0  
**前置**：D1/D2 完成；Profile B 是会议 Leader 或创建者。  
**覆盖**：R4。

1. Profile C 打开 `Delivery sync`。
2. 点击「离开」。
3. 确认参与者表中 Profile C 的状态。
4. Profile C 使用原来的入会名称 `Member` 再次点击「加入」。
5. Profile B 在「发言」输入 `Closing with agreed next steps.`，点击「发送」。
6. Profile B 在「关闭摘要」输入：

   ```md
   Agreed:
   - Review docs/kickoff.md.
   - Claim Builder before implementation.
   ```

7. 点击「关闭会议」。
8. Profile B 刷新页面，重新从会议列表点击 `Delivery sync` 的「查看」。
9. 重启 DSH Web 进程，重新用新 launch URL 打开 Profile A/B 的浏览器页面。
10. 再次打开 `Delivery sync` 详情。

**预期**：

- Profile C 离开后状态为 `已离开`，显示名 `Member` 保留。
- 同名 rejoin 被拒绝，错误提示包含 `left and cannot rejoin`。
- 关闭前后的所有发言都保留在 transcript。
- 关闭后提示「会议已关闭」，详情标题或状态显示 `已关闭`。
- 关闭摘要完整显示；输入区和「加入」「发送」「关闭会议」等 active 操作不再显示。
- 关闭时产生一条系统 transcript，内容包含关闭摘要。
- 重启后会议、参与者状态、transcript 和摘要仍能从存储恢复。

### E1. 未登录、非成员与非法 token 的 GUI 行为

**优先级**：P0  
**前置**：A2 完成；Profile D 为 `gui-guest`。  
**覆盖**：R1-R4 安全与降级。

1. Profile D 未登录时依次打开「共享」「角色」「会议」。
2. 使用 `gui-guest` / `Guest-pass-123` 登录。
3. 打开「共享」，把工作区切换到 `<WS_ID>`。
4. 尝试上传 `guest/should-fail.md`，范围为 `workspace`。
5. 打开「角色」，把「工作区」填为 `<WS_ID>`。
6. 选择任意空人类席位，点击「认领」。
7. 打开「会议」，把「工作区」填为 `<WS_ID>`。
8. 在 DevTools > Application > Local Storage 中把 `pluginmax.collab.token` 改成 `not-a-valid-token`。
9. 刷新页面并依次打开四个设置分区。
10. 移除 `pluginmax.collab.token` 后刷新页面。

**预期**：

- 未登录时，「共享」显示「请先在「协作身份」登录。」；「角色」「会议」显示「请先登录 Pluginmax」。
- 非成员上传显示 `workspace sharing permission is required` 或同类 403 错误。
- 非成员认领显示 `workspace member role is required`，席位表不产生新的在任者。
- 非成员会议列表或会议详情显示 `workspace member role is required`，不能看到成员会议内容。
- 非法 token 触发 401 后，各分区回到登录态或显示明确认证错误，不渲染受保护数据。
- 移除 token 后回到未登录提示，不保留旧用户身份。

## 用户视角补充场景

### F1. 新协作团队 Day 0 onboarding

**用户故事**：管理员首次部署平台，创建工作区、给 owner/member 分配账号，准备角色和项目文档，最后开启第一次会议。

1. 全新环境启动 DSH，管理员完成 A1。
2. 管理员通过 A2 创建 owner/member 并绑定工作区。
3. 管理员通过 C1 创建 `architect` 人设和 `delivery` 类型，并物化到 `<WS_ID>`。
4. Owner 通过 C2 认领「主持人」，Member 认领「评审人」。
5. Owner 通过 B1 上传 `docs/kickoff.md`。
6. Owner 通过 D1 创建 `Delivery sync`，Owner 和 Member 都加入。
7. Owner 点击「同步席位」，Member 发送一条确认发言。
8. Owner 使用 D3 的摘要关闭会议。

**预期**：

- 管理员能完成账号和成员初始化，不需要修改上游 DSH 或直接操作数据库。
- Owner/Member 只能在自己的权限内操作；类型创建和全局审批只留给 admin。
- 工作区文档、角色席位、会议参与者和 transcript 形成同一协作上下文。
- 新用户刷新或重新登录后仍能看到同一 `<WS_ID>` 下的文档、席位和会议。

### F2. Owner 准备评审材料并处理敏感文件

**用户故事**：Owner 需要把普通设计材料共享给成员，同时确保敏感路径不可读、密钥不会落盘，跨工作区材料必须经 admin 审批。

1. Owner 上传 `docs/design.md`，内容为普通设计说明。
2. Owner 确认 Member 可以读取 `docs/design.md`。
3. Owner 上传 `docs/confidential.md`，随后为该路径添加 `read/deny` 工作区策略。
4. Member 打开「共享」，尝试读取 `docs/confidential.md`。
5. Owner 尝试上传包含 `sk-abcdefghijklmnopqrstuvwx` 的内容。
6. Owner 上传 `reports/global-summary.md`，范围为 `global`。
7. Admin 在「全局审批」中拒绝或批准该请求。

**预期**：

- 普通工作区文档对成员可用。
- deny 策略优先于 allow；Member 读取敏感文件失败，且页面错误可理解。
- 含密钥内容被拦截，文件列表和 `.tmp/gui-workspace/.dsh-shared` 中都不应出现该内容。
- 全局文件只会在 admin 决策后进入已批准状态；审批动作本身有请求状态和审计。

### F3. 外部 Guest 只应看到被明确允许的内容

**用户故事**：项目邀请一位外部 Guest 查看，但不能让其加入会议、认领席位或读取内部工作区文件。

1. Guest 使用 Profile D 登录。
2. 打开「共享」，切换到 `<WS_ID>`，观察文件表。
3. 对表中任意文件点击「读取」。
4. 打开「角色」并输入 `<WS_ID>`。
5. 打开「会议」并输入 `<WS_ID>`。
6. Admin 移除 Guest 浏览器 token 或 Guest 自己退出，再直接刷新各分区。

**预期**：

- Guest 不能上传、认领或加入任何受工作区约束的资源。
- Guest 不能读取工作区文档；如果当前文件表已经向 Guest 展示文件路径，应记录为信息暴露缺陷。
- Guest 不能看到成员会议列表、参与者或 transcript。
- 未登录或非法 token 时，受保护分区回到登录/错误态，不残留旧数据。

### F4. 会前角色变动与会议席位恢复

**用户故事**：会议开始前后有人释放席位，会议必须稳定显示在任者、待认领席位和历史参与者。

1. 在会议 active 状态下执行一次「同步席位」。
2. Owner 在「角色」释放「主持人」。
3. 回到会议点击「刷新」；不要重新同步席位。
4. Owner 在「角色」重新认领「主持人」，确认重新成为 Leader。
5. 回到会议点击「同步席位」。
6. Member 打开会议详情并检查参与者状态。

**预期**：

- 未同步前，会议 transcript 和已有参与者不被角色表变动破坏。
- 重新同步后，重新认领的主持人成为在任者且 Leader 与角色状态一致。
- 已离开席位保持 tombstone，不与新的在任者混用同一个显示身份。
- 待认领席位继续显示可执行的 `/assignment claim <WS_ID> <seat>` 提示。

## 界面与可用性检查

每个核心用例至少做一次以下检查：

1. 在桌面宽度 1440x900 下检查表格、按钮、输入框无重叠。
2. 在移动宽度 390x844 下检查长表格可以滚动、按钮不被截断、文本可换行。
3. 成功提示与错误提示使用不同颜色，且错误文案能说明下一步原因。
4. 提交期间按钮不产生重复会议、重复文件或重复参与者。
5. 刷新后不出现丢失 token、错误身份或空白数据表。
6. DevTools Console 只允许出现故意 4xx 的网络日志，不允许未捕获异常或 React 渲染错误。

## 建议的 Playwright 自动化锚点

手工方案稳定后，可按以下锚点转成自动化：

- 登录状态：`localStorage.pluginmax.collab.token`。
- 身份面板：`[data-pluginmax-identity]`。
- 表单控件：`#pluginmax-user-id`、`#pluginmax-space-path`、`#pluginmax-persona-id`、`#pluginmax-meeting-title`。
- 按钮优先使用可见文案定位：`创建管理员`、`登录`、`上传`、`认领`、`加入`、`发送`、`关闭会议`。
- 表格断言：定位包含 `docs/kickoff.md`、`architect`、`Delivery sync` 的行。
- 每个用例保存截图和网络 HAR；对故意 4xx 请求设置白名单，不把安全负例误判为自动化失败。

## 通过标准

R1-R4 GUI 回归全部通过需要同时满足：

1. P0 用例 100% 通过。
2. P1 用例无未解释失败；已知实现缺口必须单独立 issue 并在报告中标注。
3. 所有受保护数据在未登录、非法 token、非成员路径下均不可见或不可操作。
4. 服务重启后 identity、sharing、roles、meeting 的持久状态可恢复。
5. 桌面和移动宽度下没有文本重叠、按钮截断或不可滚动区域。
6. 所有缺陷能通过截图、页面提示、网络状态码和复现步骤追溯。

## 当前需要特别关注的实现观察

以下是阅读当前 R4 实现后建议在 GUI 回归中重点确认的点：

1. **工作区文件列表的成员边界**：文件列表路由主要要求有效 token，`read` 才执行共享策略和成员/角色判断。F3 应验证 Guest 是否能在读取失败前看到文件路径；若能看到，应作为最小信息暴露问题记录。
2. **角色指派没有 GUI 入口**：服务端支持 `/api/collab/roles/seats/assign`，但当前 client 面板只见认领和释放。GUI 回归只能覆盖人类席位认领；Agent 席位指派需要单独 API/Agent 面板测试或补充 GUI。
3. **write deny 不能仅靠 GUI 上传验证**：上传成功后会创建 allow 策略，GUI 上传路径本身没有先走完整 policy resolve。GUI 只能稳定验证 read deny；write deny 应另用 Agent 工具或 API contract 测试覆盖。

## 附录 A：使用不同浏览器 Profile 测试多账户

推荐使用 Chrome 或 Edge 的浏览器 Profile。每个 Profile 会隔离 Cookie 和 localStorage，因此 `localStorage.pluginmax.collab.token` 不会跨 Profile 共享。以下以 macOS Chrome 为例。

### 创建测试 Profile

1. 打开 Chrome。
2. 点击右上角头像，或地址栏右侧的圆形 Profile 图标。
3. 在弹出菜单中选择「添加」。
4. 如果提示登录 Google 账号，选择「不使用账号继续」。
5. 将 Profile 命名为 `Pluginmax Admin`。
6. 选择一个容易区分的颜色。
7. 点击「完成」。
8. Chrome 会打开一个独立的新窗口。该窗口使用独立的浏览器存储。

如果需要测试普通成员，重复上述步骤，再创建 `Pluginmax Member`、`Pluginmax Guest` 等 Profile。

### 在 Profile 中登录

1. 在 `Pluginmax Admin` 窗口打开完整 launch URL，例如 `http://127.0.0.1:33117/...`。
2. 用 `gui-admin` / `Admin-pass-123` 登录。
3. 保持该窗口用于管理员操作。
4. 点击 Chrome 右上角头像，切换到另一个 Profile，例如 `Pluginmax Member`。
5. 在新 Profile 窗口打开同一个完整 launch URL。
6. 确认它没有自动继承管理员登录态。
7. 用第二个账户登录，例如 `gui-member` / `Member-pass-123`。

### 测试约定

- 不同 Profile 之间不会共享 Pluginmax Bearer token。
- 同一个 Profile 里的多个普通标签页会共享同一个 token，不能作为多账户隔离方式。
- 一边在 `Pluginmax Admin` 窗口执行授权、审批或成员管理，一边在 `Pluginmax Member` 或 `Pluginmax Guest` 窗口验证实际可见性和操作结果。
- 如果只需要临时测试两个身份，可以使用普通窗口加一个无痕窗口；但不要在同一类无痕窗口中测试多个账户，因为它们通常共享同一个临时 Profile。

## 附录 B：恢复 `dsh web` 访问授权

如果浏览器显示 `dsh web authentication required; reopen the URL printed by dsh web.`，表示当前标签页缺少本次 Web 进程的启动授权。每次重启 `dsh web`，完整 launch URL 都会变化。

1. 回到正在运行 `dsh web` 的终端。
2. 找到最新一行 `dsh web: http://127.0.0.1:33117/...`。
3. 复制这一整行里的完整 URL，包括末尾的 `?token=...`。
4. 在要测试的浏览器 Profile 中打开这个完整 URL。
5. 页面拿到授权后会重定向到干净地址；之后正常刷新即可。

如果启动日志已重定向到文件，可查看最后一个 launch URL：

```sh
grep 'dsh web:' .tmp/gui-web.log | tail -1
```

在 macOS 上也可以直接用最新 URL 打开浏览器：

```sh
open "$(sed -nE 's/^.*dsh web: (http:\/\/[^[:space:]]+).*$/\1/p' .tmp/gui-web.log | tail -1)"
```

注意：不要把裸地址 `http://127.0.0.1:33117` 保存成长期书签；应重新从终端复制每次启动的完整 launch URL。不同浏览器 Profile 需要分别打开这个完整 URL。
