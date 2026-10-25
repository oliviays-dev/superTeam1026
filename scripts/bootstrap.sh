#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

git -C "$ROOT" submodule update --init --recursive vendor/deepseek-harness

echo "[pluginmax] Installing plugin workspace"
pnpm --dir "$ROOT" install --frozen-lockfile
pnpm --dir "$ROOT" build

echo "[pluginmax] Building locked upstream DSH"
# DSH's local-only lefthook installer is skipped in CI; as a submodule it
# cannot safely rewrite the parent repository's worktree Git config.
CI=true pnpm --dir "$ROOT/vendor/deepseek-harness" install --frozen-lockfile
CI=true pnpm --dir "$ROOT/vendor/deepseek-harness" build

echo "[pluginmax] Bootstrap complete"
