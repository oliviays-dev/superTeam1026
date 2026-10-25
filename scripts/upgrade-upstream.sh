#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <upstream-commit-or-ref>" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
git -C "$ROOT/vendor/deepseek-harness" fetch origin master
git -C "$ROOT/vendor/deepseek-harness" checkout "$1"
git -C "$ROOT" add vendor/deepseek-harness

echo "Upstream gitlink updated. Run ./scripts/bootstrap.sh and pnpm check before committing."
