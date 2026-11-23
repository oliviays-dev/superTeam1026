# DSH 上游同步 SOP

本文是 `vendor/deepseek-harness` 的受控同步、验收和回滚操作手册。技术依据见
`docs/technical-design-dsh-upstream-sync.md`；版本事实只读
`ops/dsh-sync/manifest.yml`。

## 核心规则

- 只跟官方 release tag，**禁止跟 alpha**；普通同步只选择 rc。
- CLI gitlink、`manifest.yml`、`packages/agent-runtime` SDK 依赖和
  `pnpm-lock.yaml` 必须在同一同步提交中变更。
- 官方仓库是唯一锚定来源：`https://github.com/deepseek-ai/deepseek-harness`。
- `vendor/deepseek-harness` 只读，平台侧适配不允许直接修改 vendor。
- 任何同步/回滚提交都必须通过 `scripts/release-gate-dsh.sh`。
- 一个 release 对应一份 checklist；执行一项就勾一项，并在证据可用时注明
  时间、命令或 PR。

## 当前锚点

| 项目        | 值                                           |
| ----------- | -------------------------------------------- |
| Release tag | `dsh-v0.2.2-rc.5`                            |
| CLI ref     | `9c2670d3bce5275e0d1610272958121af87787bb`   |
| SDK client  | `0.2.2-rc.5`                                 |
| Checklist   | `ops/dsh-sync/checklists/dsh-v0.2.2-rc.5.md` |

怀疑锚点漂移时，先运行：

```bash
./scripts/release-gate-dsh.sh --fast
git ls-tree HEAD vendor/deepseek-harness
git submodule status vendor/deepseek-harness
node -p "require('./packages/agent-runtime/node_modules/@deepseek-ai/dsh-sdk-client/package.json').version"
```

## 同步 SOP

### 1. 选择版本并准备分支

1. 只在官方 GitHub release 页评估 rc；记录 breaking changes、迁移项和风险。
2. 确认目标 tag 不是 alpha。除非用户明确要求，不做 alpha 同步。
3. 从最新 `main` 创建专用分支：

   ```bash
   git switch main
   git pull --ff-only
   git switch -c sync/dsh-<version>
   ```

4. 复制最近一份 checklist 到
   `ops/dsh-sync/checklists/<release-tag>.md`，清空勾选结果。该文件会被
   manifest 的 `migrationChecklist` 引用。

### 2. 执行受控同步

```bash
./scripts/upgrade-upstream.sh <release-tag>
```

脚本会：

1. 校验 vendor 是 gitlink；
2. 显式从官方仓库 fetch 指定 tag；
3. detach checkout 到 tag；
4. 解析 tag commit 写入 `release.cliRef`；
5. 从 tag 内 `packages/sdk/client/package.json` 推导 `release.sdkClient`；
6. 原子重写 `ops/dsh-sync/manifest.yml`；
7. 将 `@deepseek-ai/dsh-sdk-client` 更新到同一版本。

不要手改 `tag`、`cliRef` 或 `sdkClient` 来“修好”不一致。脚本失败时先清理
工作区，再从干净基线重试。

### 3. 审计变更闭包

```bash
git status --short
git diff --submodule=log
git diff -- packages/agent-runtime/package.json pnpm-lock.yaml
```

预期变更至少包括：

- `vendor/deepseek-harness` gitlink；
- `ops/dsh-sync/manifest.yml`；
- `ops/dsh-sync/checklists/<release-tag>.md`；
- `packages/agent-runtime/package.json`；
- `pnpm-lock.yaml`。

如果 SDK peer dependency 变化，相关 peer 依赖和 lockfile 也必须在同一闭包内
更新。禁止把 gitlink、manifest、lockfile 拆成多个提交。

### 4. 构建、迁移清单与契约预检

```bash
./scripts/bootstrap.sh
pnpm --filter @pluginmax/agent-runtime run build
pnpm exec vitest run dsh-contract
pnpm exec vitest run host-contract
```

按 release checklist 逐项执行 L1–L4。只有命令通过、人工核对完成后才勾选。
L2 的 `DSH_BIN --version` 和 L3 的插件全链路 smoke 必须等待 vendor build
产物存在后再执行；不要在 `bin.js` 生成前运行依赖它的 smoke。

### 5. 原子提交

```bash
git add \
  vendor/deepseek-harness \
  ops/dsh-sync/manifest.yml \
  ops/dsh-sync/checklists/<release-tag>.md \
  packages/agent-runtime/package.json \
  packages/agent-runtime/package.json \
  pnpm-lock.yaml

git commit -m "feat(dsh-sync): align DSH CLI and SDK to <version>"
```

重复路径不是必需；如 peer 闭包产生额外包级 manifest 变更，一并加入同一
提交。提交后先运行快速一致性检查：

```bash
./scripts/release-gate-dsh.sh --fast
```

### 6. 全量 release gate

```bash
./scripts/release-gate-dsh.sh
```

固定顺序是：

| Gate | 内容                                               |
| ---- | -------------------------------------------------- |
| G1   | manifest 一致性四条规则                            |
| G2   | gitlink / manifest / lockfile SDK 版本原子变更校验 |
| G3   | `scripts/bootstrap.sh`                             |
| G4   | `dsh-contract`                                     |
| G5   | `host-contract`                                    |
| G6   | `pnpm check`                                       |
| G7   | `scripts/smoke.sh`                                 |

gate 通过后，在 PR 描述粘贴：

- release tag、commit 和 SDK version；
- checklist 剩余未勾项；
- `release-gate-dsh.sh` 各 gate 结果；
- 关键 smoke 证据。

## 回滚 SOP

回滚的最小单位是完整同步提交，不是单独 revert lockfile 或 submodule。

### 1. 找到同步提交

```bash
git log --oneline -- vendor/deepseek-harness ops/dsh-sync/manifest.yml
git show --stat <sync-commit>
```

如果同步后有少量修复提交，应按逆序整体 revert；只有修复本身与上游版本
无关时才保留。

### 2. 整体 revert

```bash
git switch main
git pull --ff-only
git switch -c rollback/dsh-<previous-version>
git revert --no-edit <sync-commit>
```

冲突时停止手工拼接部分文件。优先重新构造完整上一锚点：checkout 旧 tag、
恢复旧 manifest、恢复旧 SDK dependency 和 lockfile，并确认三者指向同一个
历史提交。

### 3. 清理运行环境

```bash
rm -rf .tmp/dsh-home
rm -rf .tmp/dsh-home-platform
```

只清理临时运行环境。平台 Run 事实中的 `dsh_session_id` 和 `raw_ref`
是历史事实，不做迁移、清理或重写。

### 4. 验证回滚提交

```bash
./scripts/release-gate-dsh.sh --fast
./scripts/bootstrap.sh
./scripts/release-gate-dsh.sh
```

回滚提交同样必须通过完整 gate。如果上一版本 checklist 仍然存在，抽查其中
L1/L2/L3 关键项，确认没有依赖已回滚版本的迁移代码。

## Fork 镜像说明

`oliviays-dev/deepseek-harness` 只是备用镜像，不参与默认同步路径：

- `.gitmodules` 和 `scripts/upgrade-upstream.sh` 都锚定官方仓库；
- fork 可能落后、漂移或包含本地实验提交，不能作为版本事实来源；
- 不把 fork URL 写入 manifest，也不 checkout fork 上的非 tag 分支。

仅当官方仓库临时不可达时，可以人工从 fork 取同名 tag 做只读恢复：

```bash
git -C vendor/deepseek-harness \
  fetch https://github.com/oliviays-dev/deepseek-harness.git \
  "refs/tags/<release-tag>:refs/tags/<release-tag>"
```

取回后必须核对：

```bash
git -C vendor/deepseek-harness rev-parse "refs/tags/<release-tag>^{commit}"
```

只有该 commit 与 manifest 的 `cliRef` 完全一致时才能继续。不一致时停止，
改用官方 tag 或记录上游事故；禁止为了通过 gate 修改 `cliRef`。
