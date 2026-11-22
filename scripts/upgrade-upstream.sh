#!/usr/bin/env bash
# usage: ./scripts/upgrade-upstream.sh <release-tag>   如 dsh-v0.2.2-rc.5
#
# 行为（见 docs/technical-design-dsh-upstream-sync.md §4.3）：
#   1. 校验 vendor 是 gitlink（Phase 0 形态）
#   2. 显式 URL fetch 官方仓库 tag（不依赖本地 remote，杜绝误升级父仓库）
#   3. checkout tag 并解析 commit 作为 cliRef
#   4. 从 tag 内 packages/sdk/client/package.json 推导 SDK 版本（同 release 锁定）
#   5. release 区已一致时跳过 manifest 重写（幂等：重复执行不产生 diff）
#   6. lockfile 已是目标版本时跳过 pnpm add（幂等）
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <release-tag>" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SUB="$ROOT/vendor/deepseek-harness"
MANIFEST="$ROOT/ops/dsh-sync/manifest.yml"
PKG="$ROOT/packages/agent-runtime/package.json"
TAG="$1"

fail() { echo "✗ $*" >&2; exit 1; }

# 1. 形态校验：必须是 gitlink
git -C "$ROOT" ls-tree HEAD vendor/deepseek-harness | grep -q '^160000' \
  || fail "vendor/deepseek-harness 不是 gitlink，先执行 Phase 0 修复"

# 2. fetch 官方（显式 URL，不依赖本地 remote 命名）
git -C "$SUB" fetch https://github.com/deepseek-ai/deepseek-harness.git \
  "refs/tags/$TAG:refs/tags/$TAG" \
  || fail "无法从官方仓库获取 $TAG"

# 3. checkout tag 并解析 commit
git -C "$SUB" checkout --detach "$TAG"
CLI_REF="$(git -C "$SUB" rev-parse HEAD)"

# 4. 从 tag 内元数据推导 SDK 版本，保证 CLI 与 SDK 同 release
SDK_VER="$(git -C "$SUB" show "$TAG:packages/sdk/client/package.json" \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).version))')"
[[ -n "$SDK_VER" ]] || fail "无法从 tag 元数据推导 SDK 版本"

# 5. 原子写入 manifest（release 区已一致则跳过，保证幂等）
if grep -q "tag: $TAG" "$MANIFEST" 2>/dev/null \
  && grep -q "cliRef: $CLI_REF" "$MANIFEST" \
  && grep -q "sdkClient: $SDK_VER" "$MANIFEST"; then
  echo "• manifest 已对齐到 $TAG，跳过重写"
else
  cat > "$MANIFEST.tmp" <<EOF
# DSH CLI 与 SDK 客户端必须锁同一 release。本文件由 upgrade-upstream.sh
# 校验与写入；人工修改后必须通过 release gate 才能合入。
release:
  tag: $TAG
  cliRef: $CLI_REF
  sdkClient: $SDK_VER
syncedAt: "$(date -Iseconds)"
syncedBy: "scripts/upgrade-upstream.sh"
releaseNotes: "https://github.com/deepseek-ai/deepseek-harness/releases/tag/$TAG"
migrationChecklist: "ops/dsh-sync/checklists/$TAG.md"
EOF
  mv "$MANIFEST.tmp" "$MANIFEST"
  echo "• manifest 已写入：tag=$TAG cliRef=$CLI_REF sdkClient=$SDK_VER"
fi

# 6. 更新 lockfile 中的 SDK 版本（已是目标版本则跳过）
CURRENT="$(node -p "require('$PKG').dependencies['@deepseek-ai/dsh-sdk-client']")"
if [[ "$CURRENT" != "$SDK_VER" ]]; then
  pnpm --dir "$ROOT" --filter @pluginmax/agent-runtime add \
    "@deepseek-ai/dsh-sdk-client@$SDK_VER"
else
  echo "• lockfile 已是 @deepseek-ai/dsh-sdk-client@$SDK_VER，跳过 pnpm add"
fi

echo "✓ gitlink / manifest / lockfile 已对齐到 $TAG"
echo "→ 下一步：./scripts/bootstrap.sh && pnpm check && ./scripts/smoke.sh"
