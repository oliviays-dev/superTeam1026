#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DSH_HOME="${DSH_HOME:-$ROOT/.tmp/dsh-home}"
DSH_BIN="$ROOT/vendor/deepseek-harness/apps/cli/lib/bin.js"
PROFILE_DIR="$DSH_HOME/profiles/pluginmax"

export DSH_HOME

if [[ ! -f "$DSH_BIN" ]]; then
  echo "upstream DSH CLI is not built: $DSH_BIN" >&2
  echo "run ./scripts/bootstrap.sh first" >&2
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  PNPM_SHIM_DIR="$DSH_HOME/.bin"
  mkdir -p "$PNPM_SHIM_DIR"
  cat > "$PNPM_SHIM_DIR/pnpm" <<'SHIM'
#!/usr/bin/env bash
exec corepack pnpm "$@"
SHIM
  chmod +x "$PNPM_SHIM_DIR/pnpm"
  export PATH="$PNPM_SHIM_DIR:$PATH"
fi

mkdir -p "$DSH_HOME"
rm -rf "$PROFILE_DIR"

DSH_HOME="$DSH_HOME" node "$DSH_BIN" plugin --profile pluginmax add "$ROOT/plugins/dsh-pluginmax-canary"
DSH_HOME="$DSH_HOME" node "$DSH_BIN" plugin --profile pluginmax add "$ROOT/plugins/dsh-collab-shell"
DSH_HOME="$DSH_HOME" node "$DSH_BIN" plugin --profile pluginmax add "$ROOT/plugins/dsh-collab-identity"
DSH_HOME="$DSH_HOME" node "$DSH_BIN" plugin --profile pluginmax add "$ROOT/plugins/dsh-collab-employee"
DSH_HOME="$DSH_HOME" node "$DSH_BIN" plugin --profile pluginmax add "$ROOT/plugins/dsh-collab-space"
DSH_HOME="$DSH_HOME" node "$DSH_BIN" plugin --profile pluginmax add "$ROOT/plugins/dsh-collab-roles"
DSH_HOME="$DSH_HOME" node "$DSH_BIN" plugin --profile pluginmax add "$ROOT/plugins/dsh-collab-memory"
DSH_HOME="$DSH_HOME" node "$DSH_BIN" plugin --profile pluginmax add "$ROOT/plugins/dsh-collab-context"
DSH_HOME="$DSH_HOME" node "$DSH_BIN" plugin --profile pluginmax add "$ROOT/plugins/dsh-collab-meeting"
DSH_HOME="$DSH_HOME" node "$DSH_BIN" plugin --profile pluginmax add "$ROOT/plugins/dsh-collab-workflow"
DSH_HOME="$DSH_HOME" node "$DSH_BIN" plugin --profile pluginmax add "$ROOT/plugins/dsh-collab-project"
DSH_HOME="$DSH_HOME" node "$DSH_BIN" plugin --profile pluginmax add "$ROOT/plugins/dsh-collab-task"
DSH_HOME="$DSH_HOME" node "$DSH_BIN" plugin --profile pluginmax add "$ROOT/plugins/dsh-collab-teammate"
DSH_HOME="$DSH_HOME" node "$DSH_BIN" plugin --profile pluginmax add "$ROOT/plugins/dsh-collab-agent"
DSH_HOME="$DSH_HOME" node "$DSH_BIN" plugin --profile pluginmax add "$ROOT/plugins/dsh-collab-workbench"
node "$ROOT/scripts/add-web-bundle.mjs" "$PROFILE_DIR/package.json"

echo "installed profile: $PROFILE_DIR"
