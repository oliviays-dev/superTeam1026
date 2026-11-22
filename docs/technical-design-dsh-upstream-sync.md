# 技术设计：DSH 上游同步与版本对齐机制

> 版本：v1.1
>
> 日期：2026-11-21
>
> 状态：设计草案，供评审、任务拆分和实施验收共同引用
>
> 适用范围：`vendor/deepseek-harness` 的仓库形态修复、DSH CLI 与
> `@deepseek-ai/dsh-sdk-client` 的版本对齐、上游升级流程、兼容性防护与回滚
>
> 本次更新：首版设计，覆盖现状审计结论、目标架构、四个阶段的迁移与验收方案
>
> 关联设计：
>
> - [Pluginmax 工程化平台 V1 技术设计](./engineering-platform-v1-technical-design.md)
> - [dsh-pluginmax 升级能力迁移技术方案](./v1-dsh-pluginmax-upgrade-migration-technical-plan.md)
>   （该方案覆盖能力迁移；本设计覆盖其未涉及的 vendor 上游同步维度）

## 0. 结论

DSH（DeepSeek Harness）在本项目中具有双重身份：既是与 Codex、CodeBuddy
（workbuddy provider）平行的外部 Runtime，又是 `plugins/dsh-collab-*` 插件集合的
运行宿主。官方仓库 `deepseek-ai/deepseek-harness` 处于 developer preview 阶段，
README 明确声明存在兼容性破坏变更，因此上游同步必须是一套受控流程，
而不是简单的 `git pull`。

当前仓库的 vendored 状态是坏的，本设计首先修复它，然后建立受控同步机制：

```text
现状（坏）：
vendor/deepseek-harness      ← 040000 tree（普通源码快照，一次性 commit）
.gitmodules                  ← 声明 submodule，指向 fork（oliviays-dev/deepseek-harness）
scripts/upgrade-upstream.sh  ← fetch 解析到父仓库，实际会升级主仓库自身
版本                         ← CLI 0.1.3-alpha.1 ≠ SDK 0.2.1-rc.3 ≠ 官方最新 0.2.2-rc.5

目标（好）：
vendor/deepseek-harness      ← 160000 gitlink（真 submodule，指向官方仓库）
.gitmodules                  ← url 官方仓库 + 锚定 release tag
ops/dsh-sync/manifest.yml    ← CLI ref 与 SDK 版本强制同 release 锁定
scripts/upgrade-upstream.sh  ← v2：fetch 官方 → checkout tag → 一致性校验 → 触发回归
防护层                       ← SDK 契约测试 + 插件宿主服务契约测试 + release gate
```

核心判断：

1. **先修仓库形态，再谈版本升级。** 快照形态下同步脚本无法工作，
   一切同步动作都建立在 gitlink 修复之上。
2. **CLI 与 SDK 必须锁同一个 release。** 跨版本子进程协议没有契约保证，
   版本错位本身就是当前最大的隐患。
3. **只跟 rc，不跟 alpha。** 官方 alpha 变更幅度不可控，rc 是官方对外的集成基线。
4. **升级必须过 release gate。** 0.2.1-rc.2 与 0.2.2-rc.1 都出现过静默破坏部署的先例，
   只读 release notes 不足以判断影响。
5. **平台代码不修改 vendor。** 沿用 V1 设计的非目标：对上游只读，适配全部在平台侧完成。

## 1. 背景与现状

### 1.1 vendored 形态审计结论

对仓库 HEAD 的 `git ls-tree` 审计结果：

```text
$ git ls-tree HEAD vendor/deepseek-harness
040000 tree 699dd8b... vendor/deepseek-harness
```

`040000 tree` 说明该路径是普通目录快照，不是 `160000 commit` gitlink。
整份源码（约 3,226 个 TS/TSX 文件，767,579 行）在
`c41f395 chore: import isolated Pluginmax source snapshot` 中一次性进入主仓库历史。

由此产生的连锁问题：

| 问题 | 证据 | 后果 |
| --- | --- | --- |
| `git submodule status` 输出为空 | 无 gitlink 映射 | bootstrap.sh 的 `submodule update --init` 无法按预期工作 |
| vendor 内无 `.git` | 目录审计 | `git -C vendor/deepseek-harness` 解析到父仓库 |
| upgrade-upstream.sh 升级的是主仓库自身 | 脚本执行 `fetch origin master` | 同步机制形同虚设，且存在误操作主仓库的风险 |
| `.gitmodules` 指向 fork | `oliviays-dev/deepseek-harness` | fork 落后官方的可能性未受管理 |
| 主仓库体积膨胀 | vendor 占全部 TS 行数约 74% | clone、diff、审查噪音已沉淀进历史 |

### 1.2 版本错位现状

| 组件 | 当前版本 | 官方最新 | 差距 |
| --- | --- | --- | --- |
| vendored DSH CLI（`@deepseek-ai/dsh`） | 0.1.3-alpha.1 | 0.2.2-rc.5 | 落后一个 minor 大版本 |
| npm `@deepseek-ai/dsh-sdk-client` | 0.2.1-rc.3 | 0.2.2-rc.5 | 落后同 minor 的 rc.4/rc.5 与一个 minor |
| 运行时组合 | SDK 0.2.1-rc.3 经 `DSH_BIN` 子进程驱动 CLI 0.1.3-alpha.1 | — | 跨版本协议无契约保证 |

`DSH_BIN` 的接线链路（本设计的对齐目标贯穿此链路）：

```text
env.DSH_BIN
  → packages/config（dshBin）
  → apps/worker（Worker 依赖注入）
  → packages/agent-runtime（DshSdkAdapter → DeepSeekHarness({ dshBin, ... })）
  → 子进程 vendor/deepseek-harness/apps/cli/lib/bin.js
```

scripts 侧的引用：

- `scripts/bootstrap.sh`：`submodule update --init` → vendor 内 `pnpm install` + `build`
- `scripts/smoke.sh`：`DSH_BIN="$ROOT/vendor/deepseek-harness/apps/cli/lib/bin.js"`
- `scripts/install-profile.sh`：同上路径安装 `plugins/dsh-pluginmax-canary`
- `plugins/dsh-pluginmax-canary/README.md`：插件安装示例使用 vendor CLI 路径

### 1.3 平台对 DSH 的四层依赖面

任何上游升级的影响评估都必须逐层检查以下依赖面：

**L1 — npm SDK API 层**（`packages/agent-runtime/src/dsh-sdk.ts`）

平台实际消费的 API 面：

```ts
new DeepSeekHarness({
  dshBin, profile, dshHome, cwd,
  provider, model, maxTokens, requestTimeoutMs,
})
harness.run(instruction, { sessionId, onNotification })
harness.close()
// HarnessNotification：session.status / subagent.started / subagent.finished / session.event
// session.event.type：turn/start, turn/end, tool/call, tool/result
// RunResult.finalResponse
```

平台侧的 `mapDshNotification` 按事件字符串精确匹配。上游事件命名或结构变更
会导致平台 Run 追踪静默丢失事件（不报错、只丢数据），这是最危险的失效模式。

**L2 — CLI 子进程协议层**（`DSH_BIN` → `apps/cli/lib/bin.js`）

SDK 与 CLI 之间的 profile、session、插件协议无版本协商。已知的静默破坏先例：
0.2.1-rc.2 破坏按 0.2.0 官方指南配置的 connection row；0.2.2-rc.1 桌面端
静默重写 profile package.json（34 bundles → 2）导致插件无法启动。

**L3 — cordis 宿主服务层**（`plugins/dsh-collab-*`，14 个插件）

插件通过 `ctx.get(...)`、`ctx.provide`、`ctx.on`、`ctx.emit` 消费宿主服务：

```text
sessions, sessionPersistence, sessionTitle,
workspaceRegistry, subagents, agents, collabTeam,
storageDomain.open(spec),
ctx.on("agent/assistant-stream"), ctx.emit("agent-run-settled")
```

已知破坏：0.2.1 删除 subagents 服务的 service 级 `start(provider, request)`，
直接命中 `dsh-collab-agent` 的 `deps.subagents()` 依赖。

**L4 — 构建与脚本路径层**

`bootstrap.sh`、`smoke.sh`、`install-profile.sh` 硬编码 vendor 内构建产物路径；
宿主 Zod 升级（0.2.2-rc.2 升至 4.6.6）与 workspace `zod: ^4` 的 schema
行为差异需要回归验证。

### 1.4 官方已知破坏案例（升级检查单的输入）

| 版本 | 事件 | 对本项目影响 |
| --- | --- | --- |
| 0.2.1-rc.2 | 静默破坏按 0.2.0 指南配置 connection row 的部署 | L2 profile 初始化 |
| 0.2.1 | subagents 服务删除 `start(provider, request)` | L3 dsh-collab-agent |
| 0.2.2-rc.1 | 静默重写 profile package.json（34 → 2 bundles），插件启动失败 | L2/L3 插件安装链路 |
| 0.2.2-rc.2 | Session 批量事件、错误分类调整、AgentTeam 具名子代理、技能路径迁移、Office 原生工具 | L1/L3/L4 多层迁移 |

## 2. 目标与非目标

### 2.1 目标

- 将 `vendor/deepseek-harness` 恢复为标准 git submodule，指向官方
  `deepseek-ai/deepseek-harness`；fork 仅作为备用镜像。
- 建立版本 manifest，强制 DSH CLI ref 与 `@deepseek-ai/dsh-sdk-client`
  npm 版本同 release 对齐。
- 提供可用的上游同步脚本：fetch 官方 → checkout release tag → 一致性校验 →
  触发构建与回归，全程幂等且可中断。
- 建立三层兼容防护：SDK 契约测试、插件宿主服务契约测试、全链路 release gate。
- 提供明确的回滚设计：gitlink revert + lockfile revert + 环境清理，短时间内可完成。

### 2.2 非目标

- 不修改 `vendor/deepseek-harness` 上游源码（沿用 V1 非目标）。
- 不重写 `dsh-collab-*` 插件的业务逻辑；适配只发生在插件边界。
- 不清除主仓库历史中的 vendor 快照体积（git filter-repo 属破坏性改写，另行专项评审）。
- 不追踪官方 master 滚动更新；同步只锚定 release tag。
- 不支持 alpha 版本同步。

## 3. 总体方案

### 3.1 目标架构

```text
                 ┌───────────────────────────────┐
                 │ deepseek-ai/deepseek-harness  │
                 │ （官方仓库，release tag 锚定） │
                 └──────────────┬────────────────┘
                                │ gitlink（160000）
┌───────────────────────────────┼───────────────────────────────┐
│ superTeam1026（pluginmax-platform）                            │
│                               ▼                               │
│  ops/dsh-sync/manifest.yml ←── 锁定 CLI ref = SDK 版本          │
│        │                                                      │
│        ▼                                                      │
│  scripts/upgrade-upstream.sh v2                               │
│    fetch 官方 → checkout tag → manifest 一致性校验              │
│        │                                                      │
│        ▼                                                      │
│  Release Gate（CI 与本地同一入口）                              │
│    G1 manifest 一致性                                          │
│    G2 gitlink / manifest / lockfile 原子一致                    │
│    G3 bootstrap 构建 vendor                                     │
│    G4 SDK 契约测试（L1）                                        │
│    G5 插件宿主服务契约测试（L3）                                 │
│    G6 pnpm check（typecheck + lint + test + build）             │
│    G7 smoke：插件安装 + runtime e2e（L2/L4）                     │
│        │                                                      │
│        ▼                                                      │
│  gitlink + manifest + lockfile 同一提交（原子变更，可整体回滚）   │
└───────────────────────────────────────────────────────────────┘
```

### 3.2 方案对比与决策

| 维度 | A. 真 submodule（推荐） | B. 快照 + 同步脚本 | C. 放弃 vendor，CLI 走 npm 安装 |
| --- | --- | --- | --- |
| 同步成本 | 低：fetch + checkout tag | 高：rsync/patch 易错 | 最低 |
| 升级可回滚 | git revert gitlink | 依赖脚本正确性 | lockfile revert |
| 可复现构建 | gitlink + manifest 双重锁定 | 快照漂移风险 | 版本锁定强 |
| 离线/内网友好 | 好（本地已有 checkout） | 好 | 差（依赖 registry） |
| 仓库体积 | clone 需额外拉 submodule | 已付出（历史快照） | 最小 |
| bootstrap/脚本改动 | 小（存量脚本即为此设计） | 大 | 需改 DSH_BIN 发现逻辑 |
| 上游升级可控性 | tag 锚定，精确 | 漂移不可控 | 跟 npm latest，不可控 |

决策：采用方案 A。理由：

1. 现有 `bootstrap.sh`、`upgrade-upstream.sh`、`smoke.sh` 全部按 submodule 语义编写，
   方案 A 是让存量脚本恢复设计意图，改动最小。
2. gitlink 的原子提交（gitlink + manifest + lockfile 同 commit）天然支持整体回滚。
3. 方案 C 虽然体积最优，但将运行宿主的确定性交给 npm registry 与全局环境，
   与"本地优先平台"的设计原则冲突。后续若插件全部迁移至独立平台，可作为演进方向
   再评估（见 §8 开放问题）。

## 4. 详细设计

### 4.1 仓库形态修复（Phase 0）

目标：HEAD 中 vendor 变为 gitlink，`.gitmodules` 指向官方仓库。

迁移步骤（一次性操作，需在干净工作树上执行）：

```bash
# 1. 移除快照跟踪（--cached 只动索引，本地文件随后手动清理）
git rm -r --cached vendor/deepseek-harness
rm -rf vendor/deepseek-harness

# 2. 以官方仓库重建 submodule（锚定 release tag）
git submodule add https://github.com/deepseek-ai/deepseek-harness.git vendor/deepseek-harness
git -C vendor/deepseek-harness checkout dsh-v0.2.2-rc.5

# 3. 校验
git ls-tree HEAD vendor/deepseek-harness   # 期望：160000 commit
git submodule status                       # 期望：列出且前缀无 '+'/'-'

# 4. 提交
git add .gitmodules vendor/deepseek-harness
git commit -m "chore: restore vendor/deepseek-harness as official submodule"
```

`.gitmodules` 目标形态：

```ini
[submodule "vendor/deepseek-harness"]
	path = vendor/deepseek-harness
	url = https://github.com/deepseek-ai/deepseek-harness.git
	branch = refs/tags/dsh-v0.2.2-rc.5
```

约束：

- `branch` 字段仅作提示用途；同步以 manifest 中的精确 ref 为准（见 §4.2），
  禁止依赖 branch 跟踪实现自动滚动。
- fork `oliviays-dev/deepseek-harness` 保留为备用镜像，写入 `ops/dsh-sync/README.md`，
  不进入默认 fetch 路径。

### 4.2 版本 manifest（单一事实源）

新增 `ops/dsh-sync/manifest.yml`，作为 CLI ref 与 SDK 版本的唯一锁定点：

```yaml
# DSH CLI 与 SDK 客户端必须锁同一 release。本文件由 upgrade-upstream.sh v2
# 校验与写入；人工修改后必须通过 release gate 才能合入。
release:
  tag: dsh-v0.2.2-rc.5
  cliRef: "<官方 tag 对应 commit>"
  sdkClient: 0.2.2-rc.5
syncedAt: "<ISO8601>"
syncedBy: "scripts/upgrade-upstream.sh"
releaseNotes: "https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.5"
migrationChecklist: "ops/dsh-sync/checklists/dsh-v0.2.2-rc.5.md"
```

一致性规则（脚本与 CI 双重执行）：

1. `git -C vendor/deepseek-harness rev-parse HEAD` 必须等于 `release.cliRef`。
2. `@deepseek-ai/dsh-sdk-client` 的安装版本必须等于 `release.sdkClient`。
3. `release.tag` 与 `release.cliRef` 必须可互相推导（tag 与 commit 互查）。
4. 任何不一致 → release gate 直接失败，禁止合入。

首次对齐目标定为 CLI 0.2.2-rc.5 + SDK 0.2.2-rc.5（消除当前错位），
而非停留在 0.2.1 线：0.2.1 线的 rc.4/rc.5 与 0.2.2 线都包含 SDK 集成迁移要求，
分两次升级只会重复支付迁移成本。

### 4.3 同步脚本 v2（`scripts/upgrade-upstream.sh`）

重写为幂等、可中断、强制校验的流程：

```bash
#!/usr/bin/env bash
# usage: ./scripts/upgrade-upstream.sh <release-tag>   如 dsh-v0.2.2-rc.5
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SUB="$ROOT/vendor/deepseek-harness"
MANIFEST="$ROOT/ops/dsh-sync/manifest.yml"
TAG="$1"

fail() { echo "✗ $*" >&2; exit 1; }

# 1. 形态校验：必须是 gitlink
git -C "$ROOT" ls-tree HEAD vendor/deepseek-harness | grep -q '^160000' \
  || fail "vendor/deepseek-harness 不是 gitlink，先执行 Phase 0 修复"

# 2. fetch 官方（显式 URL，不依赖本地 remote 命名，杜绝 §1.1 的父仓库误升级）
git -C "$SUB" fetch https://github.com/deepseek-ai/deepseek-harness.git \
  "refs/tags/$TAG:refs/tags/$TAG" \
  || fail "无法从官方仓库获取 $TAG"

# 3. checkout tag 并解析 commit
git -C "$SUB" checkout --detach "$TAG"
CLI_REF="$(git -C "$SUB" rev-parse HEAD)"

# 4. 从 tag 内元数据推导 SDK 版本，保证 CLI 与 SDK 同 release
# （实测路径：官方仓库内 sdk-client 位于 packages/sdk/client/package.json）
SDK_VER="$(git -C "$SUB" show "$TAG:packages/sdk/client/package.json" \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).version))')"

# 5. 原子写入 manifest
cat > "$MANIFEST.tmp" <<EOF
release:
  tag: $TAG
  cliRef: $CLI_REF
  sdkClient: $SDK_VER
syncedAt: "$(date -Iseconds)"
syncedBy: "scripts/upgrade-upstream.sh"
EOF
mv "$MANIFEST.tmp" "$MANIFEST"

# 6. 更新 lockfile 中的 SDK 版本
pnpm --filter @pluginmax/agent-runtime add "@deepseek-ai/dsh-sdk-client@$SDK_VER"

echo "✓ gitlink / manifest / lockfile 已对齐到 $TAG"
echo "→ 下一步：./scripts/bootstrap.sh && ./scripts/release-gate-dsh.sh"
```

设计要点：

- **显式 fetch URL**：修复 §1.1 中 fetch 解析到父仓库的问题，不依赖本地 remote 命名。
- **SDK 版本从 tag 内 package.json 推导**：CLI 与 SDK 天然同 release，
  不允许人工填写两个来源。
- **gitlink、manifest、lockfile 三者必须在同一提交内变更**（CI 校验，见 §4.6），
  保证任何 revert 都是整体回滚。

### 4.4 L1 防护：SDK 契约测试

新增 `packages/agent-runtime/src/dsh-contract.test.ts`。目标不是测 DSH 功能，
而是固化平台对上游的假设，让破坏在 CI 阶段暴露而非生产静默失效：

```text
契约项：
C1  构造参数被接受：dshBin/profile/dshHome/cwd/provider/model/maxTokens/requestTimeoutMs
C2  run(instruction, { sessionId, onNotification }) 返回 Promise<RunResult>
C3  RunResult.finalResponse 存在且为 string
C4  通知事件枚举：session.status / subagent.started / subagent.finished / session.event
C5  session.event.type 枚举：turn/start, turn/end, tool/call, tool/result
C6  close() 幂等且可 await
C7  （smoke 阶段）DSH_BIN --version 输出与 manifest.tag 一致
```

实现策略：C1–C6 以 vendor 内 SDK 类型定义与构造行为断言为主，不依赖真实模型调用；
C7 在 smoke 阶段执行真实二进制探测。

配套改造：`mapDshNotification` 从"字符串精确匹配"改为显式白名单 + 未知事件告警：

```ts
const KNOWN_NOTIFICATION_METHODS = new Set([
  "session.status",
  "subagent.started",
  "subagent.finished",
  "session.event",
]);
// 未知 method 不再静默丢弃：产出 progress 类型的 warning 事件（带原始 method 名），
// 使上游新增/改名的事件在 Run 追踪中可见。
```

### 4.5 L3 防护：插件宿主服务契约测试

新增 `plugins/dsh-collab-agent/src/host-contract.test.ts`（其余 collab 插件按需复制），
以类型断言 + 轻量 mock 固化插件消费的宿主服务形状：

```text
契约项：
H1  ctx.get("subagents") 返回对象，且插件实际调用的方法签名存在
    （针对 0.2.1 删除 start(provider, request) 的先例，锁定签名）
H2  ctx.get("sessions" / "sessionPersistence" / "sessionTitle") 存在
H3  ctx.get("workspaceRegistry") 存在
H4  ctx.storageDomain.open(spec) 可调用并返回 domain
H5  ctx.on("agent/assistant-stream") / ctx.emit("agent-run-settled") 事件名有效
H6  ctx.provide / ctx.inject / ctx.effect 生命周期可用
```

实施方式：从 vendor 的宿主服务类型生成类型级断言（`satisfies` / 类型导入），
运行时测试用内存 mock。上游破坏时先表现为类型错误，其次才是运行时契约失败。

同步到 0.2.2 时必须人工迁移的点（列入该版本 checklist）：

- subagents / AgentTeam 具名子代理新 API 的适配（H1）
- 技能名称与路径迁移（若插件引用旧技能）
- Session 批量事件包装（若插件自定义事件追加）

### 4.6 Release Gate（CI 与本地统一）

新增 `scripts/release-gate-dsh.sh`，同步提交必须完整通过：

```text
Gate 顺序（快速失败在前）：
G1  manifest 一致性校验（§4.2 四条规则）
G2  原子性校验：gitlink 变化 ⇔ manifest 变化 ⇔ lockfile 中 sdk-client 版本变化
G3  ./scripts/bootstrap.sh（vendor install + build）
G4  pnpm vitest run dsh-contract（L1 契约）
G5  pnpm vitest run host-contract（L3 契约）
G6  pnpm check（typecheck + lint + test + build）
G7  ./scripts/smoke.sh（插件安装 + runtime e2e，L2/L4）
```

CI 侧约束（workflow 调整）：

- checkout 增加 `submodules: recursive`，vendor 变化时缓存 submodule。
- 触发路径：`vendor/deepseek-harness`（gitlink）、`ops/dsh-sync/**`、
  `packages/agent-runtime/**`、`plugins/dsh-collab-*/**`。
- 单边提交拦截：某提交只改 gitlink 未改 manifest（或反之）→ G2 直接失败。
- gate 通过后在 PR 评论粘贴该 release 迁移 checklist 的执行结果。

### 4.7 回滚设计

回滚以提交为最小单位（gitlink + manifest + lockfile 同提交）：

```bash
# 版本回滚：整体 revert 同步提交
git revert <sync-commit>
./scripts/bootstrap.sh && ./scripts/release-gate-dsh.sh

# 环境清理（防止旧 profile / session 残留干扰）
rm -rf .tmp/dsh-home
rm -rf .tmp/dsh-home-platform
```

约束：

- 平台 Run 事实中保存的 `dsh_session_id` 与 `raw_ref` 不做迁移或清理；
  回滚后的旧 session 按"只读历史事实"处理（沿用 V1 设计第 3 条判断）。
- 回滚同样必须过 release gate（证明回到上一个可用组合）。

## 5. 实施计划

### Phase 0 — 形态修复（预计 0.5 天）

- 执行 §4.1 迁移步骤，gitlink 指向官方仓库。
- vendor 首锚版本：0.2.2-rc.5（与 Phase 1 版本对齐合并验证）。
- 验收：`git submodule status` 正常；`bootstrap.sh` 可完成 install + build。

### Phase 1 — 版本对齐与 SDK 适配（预计 1–2 天）

- 落地同步脚本 v2 → gitlink、manifest、lockfile 对齐到 0.2.2-rc.5。
- 执行该 release 迁移 checklist：subagents/AgentTeam API 适配、Session 批量事件、
  错误分类、技能路径、Zod 4.6.6 回归。
- `mapDshNotification` 改造为白名单 + 未知事件告警。
- 验收：release gate G1–G7 全绿；`dsh-collab-agent` subagents 路径 smoke 通过。

### Phase 2 — 契约防护层（预计 2–3 天，开发可与 Phase 1 并行，合并串行）

- 落地 `dsh-contract.test.ts`（C1–C7）。
- 落地 `host-contract.test.ts`（H1–H6），覆盖 `dsh-collab-agent`、
  `dsh-collab-task`、`dsh-collab-meeting` 三个高风险插件，其余插件按模板复制。
- 验收：本地临时注入一个假事件名（演练，不入库）验证契约测试能红。

### Phase 3 — CI Gate 与流程固化（预计 1 天）

- `scripts/release-gate-dsh.sh` + workflow 触发规则 + 原子提交校验。
- `ops/dsh-sync/README.md`：同步 SOP（何时跟 rc、checklist 模板、回滚 SOP、
  fork 镜像用途说明）。
- 验收：模拟一次 0.2.x → 0.2.y 的同步演练，全程只按 SOP 操作成功。

## 6. 风险与缓解

| # | 风险 | 等级 | 缓解 |
| --- | --- | --- | --- |
| R1 | 0.2.1 → 0.2.2 一次性跨版本迁移改动大，回归定位困难 | 高 | 按 L1→L3→L2 分层提交迁移；gate 逐层验证 |
| R2 | subagents API 适配引入行为回归 | 高 | H1 契约锁定 + `dsh-collab-agent` 全链路 smoke |
| R3 | 未知事件静默丢失，Run 追踪失效 | 高 | 白名单 + 未知事件告警；C4/C5 契约覆盖事件枚举 |
| R4 | 上游再次出现静默破坏（profile 重写类） | 中 | G7 全链路插件安装 smoke；升级先在演练环境执行 |
| R5 | Zod 4.6.6 与 workspace zod ^4 行为差异 | 中 | G6 全量 test；contracts schema 快照对比 |
| R6 | gitlink 修复期间 CI 拉取 submodule 失败 | 中 | workflow `submodules: recursive` + 重试 |
| R7 | fork 与官方漂移导致追踪混乱 | 低 | manifest 仅锚官方；fork 只作镜像记录 |
| R8 | 同步脚本在非 Linux 环境不可用 | 低 | 保持 POSIX bash；CI 以 Linux 为准，Windows 走 WSL |

## 7. 验收标准

- [ ] `git ls-tree HEAD vendor/deepseek-harness` 输出 `160000 commit`。
- [ ] `git submodule status` 列出且无 `+`/`-` 前缀。
- [ ] `ops/dsh-sync/manifest.yml` 通过一致性校验（tag/cliRef/sdkClient 互洽）。
- [ ] vendored CLI 与 `@deepseek-ai/dsh-sdk-client` 同为 0.2.2-rc.5。
- [ ] `dsh-contract`（C1–C7）与 `host-contract`（H1–H6）测试存在且通过。
- [ ] `mapDshNotification` 对未知事件产生可见告警而非静默丢弃。
- [ ] `scripts/upgrade-upstream.sh <tag>` 幂等执行两次不产生 diff。
- [ ] release gate G1–G7 全绿；G2 对单边修改提交正确拦截。
- [ ] 回滚演练：revert 同步提交 + 环境清理后，上一个组合 gate 全绿。

## 8. 开放问题

1. **vendor 长期形态**：若 `dsh-collab-*` 全部迁移到独立平台（Web + Platform API +
   PostgreSQL），L3 依赖面消失后，是否收缩为"仅 CI 拉 submodule"或切换方案 C？
   建议插件迁移完成度超过 80% 时重新评估。
2. **协议协商**：是否向官方提议 SDK↔CLI 子进程握手时交换版本号，
   将 R4 类静默破坏转为显式错误？（上游协作项，本项目不承诺。）
3. **历史体积**：主仓库历史中 76.8 万行快照是否执行 `git filter-repo` 清理？
   涉及全员 re-clone，需单独评审。
4. **多版本并存**：未来若需灰度支持新旧 DSH，manifest 是否扩展多 slot？
   当前按单 slot 设计，不为未发生的复杂度预付成本。
