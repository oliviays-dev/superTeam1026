#!/usr/bin/env bash
# Unified local/CI gate for DSH upstream synchronization.
# Usage: ./scripts/release-gate-dsh.sh [--fast]
# --fast runs only G1 and G2; the default runs G1 through G7 in order.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SUBMODULE_REL="vendor/deepseek-harness"
SUBMODULE="$ROOT/$SUBMODULE_REL"
MANIFEST_REL="ops/dsh-sync/manifest.yml"
MANIFEST="$ROOT/$MANIFEST_REL"
LOCK_REL="pnpm-lock.yaml"
SDK_PACKAGE="packages/agent-runtime/node_modules/@deepseek-ai/dsh-sdk-client/package.json"
SYNC_COMMIT="${DSH_RELEASE_GATE_COMMIT:-HEAD}"
FAST=false

case "${1:-}" in
  "") ;;
  --fast) FAST=true ;;
  *)
    echo "usage: $0 [--fast]" >&2
    exit 2
    ;;
esac

fail() {
  echo "✗ DSH release gate: $*" >&2
  exit 1
}

manifest_value() {
  sed -n "s/^[[:space:]]*$1:[[:space:]]*//p" "$MANIFEST" |
    tail -n 1 |
    sed -e 's/^"//' -e 's/"$//'
}

manifest_at_commit_value() {
  local content
  content="$(git -C "$ROOT" show "$SYNC_COMMIT:$MANIFEST_REL")" ||
    fail "unable to read manifest at $SYNC_COMMIT"
  printf '%s\n' "$content" |
    sed -n "s/^[[:space:]]*$1:[[:space:]]*//p" |
    tail -n 1 |
    sed -e 's/^"//' -e 's/"$//'
}

lock_sdk_specifier() {
  local content
  content="$(git -C "$ROOT" show "$1:$LOCK_REL")" ||
    fail "unable to read lockfile at $1"
  printf '%s\n' "$content" |
    awk -v package="'@deepseek-ai/dsh-sdk-client'" '
      BEGIN { target = "      " package ":"; printed = 0 }
      $0 == "  packages/agent-runtime:" { in_package = 1; next }
      in_package && $0 ~ /^  [^[:space:]].*:/ { in_package = 0 }
      in_package && $0 == target { in_dependency = 1; next }
      in_dependency && printed == 0 && $0 ~ /^        specifier:/ {
        sub(/^        specifier:[[:space:]]*/, "")
        print
        printed = 1
      }
    '
}

changed_in_commit() {
  git -C "$ROOT" diff-tree --no-commit-id --name-only -r "$SYNC_COMMIT" |
    grep -Fxq "$1"
}

run_gate() {
  local gate="$1"
  shift
  echo "▶ $gate: $*"
  "$@"
  echo "✓ PASS $gate"
}

cd "$ROOT"

command -v git >/dev/null || fail "git is required"
command -v node >/dev/null || fail "node is required"
command -v pnpm >/dev/null || fail "pnpm is required"
[[ -f "$MANIFEST" ]] || fail "missing $MANIFEST_REL"
[[ -f "$ROOT/$LOCK_REL" ]] || fail "missing $LOCK_REL"

TAG="$(manifest_value tag)"
CLI_REF="$(manifest_value cliRef)"
SDK_VERSION="$(manifest_value sdkClient)"

[[ -n "$TAG" ]] || fail "manifest release.tag is empty"
[[ -n "$CLI_REF" ]] || fail "manifest release.cliRef is empty"
[[ -n "$SDK_VERSION" ]] || fail "manifest release.sdkClient is empty"
[[ "$CLI_REF" =~ ^[0-9a-f]{40}$ ]] ||
  fail "manifest release.cliRef must be a 40-character commit SHA"

# G1 — manifest and submodule consistency (§4.2).
GITLINK_MODE="$(git ls-tree HEAD "$SUBMODULE_REL" | awk '{print $1}')"
GITLINK_FROM_HEAD="$(git ls-tree HEAD "$SUBMODULE_REL" | awk '{print $3}')"
INDEX_MODE="$(git ls-files --stage "$SUBMODULE_REL" | awk '{print $1}')"
INDEX_GITLINK="$(git ls-files --stage "$SUBMODULE_REL" | awk '{print $2}')"

[[ "$GITLINK_MODE" == "160000" ]] ||
  fail "HEAD $SUBMODULE_REL is not a gitlink (mode=$GITLINK_MODE)"
[[ "$INDEX_MODE" == "160000" ]] ||
  fail "index $SUBMODULE_REL is not a gitlink (mode=$INDEX_MODE)"
[[ -n "$GITLINK_FROM_HEAD" ]] || fail "HEAD does not contain the submodule gitlink"
[[ -n "$INDEX_GITLINK" ]] || fail "index does not contain the submodule gitlink"
[[ "$GITLINK_FROM_HEAD" == "$CLI_REF" ]] ||
  fail "HEAD gitlink ($GITLINK_FROM_HEAD) != manifest cliRef ($CLI_REF)"
[[ "$INDEX_GITLINK" == "$CLI_REF" ]] ||
  fail "index gitlink ($INDEX_GITLINK) != manifest cliRef ($CLI_REF)"

SUBMODULE_STATUS="$(git submodule status -- "$SUBMODULE_REL")" ||
  fail "unable to read submodule status"
[[ "$SUBMODULE_STATUS" != +* && "$SUBMODULE_STATUS" != -* ]] ||
  fail "submodule is not initialized at the anchored commit: $SUBMODULE_STATUS"
SUBMODULE_HEAD="$(git -C "$SUBMODULE" rev-parse HEAD)"
[[ "$SUBMODULE_HEAD" == "$CLI_REF" ]] ||
  fail "submodule HEAD ($SUBMODULE_HEAD) != manifest cliRef ($CLI_REF)"

TAG_COMMIT="$(git -C "$SUBMODULE" rev-parse "refs/tags/$TAG^{commit}")" ||
  fail "release tag $TAG is not available in the official submodule"
[[ "$TAG_COMMIT" == "$CLI_REF" ]] ||
  fail "release tag $TAG ($TAG_COMMIT) != manifest cliRef ($CLI_REF)"

[[ -f "$ROOT/$SDK_PACKAGE" ]] || fail "installed DSH SDK client not found; run bootstrap first"
INSTALLED_SDK_VERSION="$(node -p 'require(process.argv[1]).version' "$ROOT/$SDK_PACKAGE")"
DECLARED_SDK_VERSION="$(node -p 'require(process.argv[1]).dependencies["@deepseek-ai/dsh-sdk-client"]' "$ROOT/packages/agent-runtime/package.json")"
[[ "$INSTALLED_SDK_VERSION" == "$SDK_VERSION" ]] ||
  fail "installed SDK ($INSTALLED_SDK_VERSION) != manifest sdkClient ($SDK_VERSION)"
[[ "$DECLARED_SDK_VERSION" == "$SDK_VERSION" ]] ||
  fail "agent-runtime SDK dependency ($DECLARED_SDK_VERSION) != manifest sdkClient ($SDK_VERSION)"

echo "✓ PASS G1: manifest, gitlink, tag, and installed SDK are consistent"

# G2 — atomic sync commit validation (§4.6).
git -C "$ROOT" rev-parse --verify "$SYNC_COMMIT^" >/dev/null 2>&1 ||
  fail "G2 requires a parent commit; set DSH_RELEASE_GATE_COMMIT to a sync commit"

PARENT_COMMIT="$(git -C "$ROOT" rev-parse "$SYNC_COMMIT^")"
GITLINK_PARENT="$(git -C "$ROOT" rev-parse "$PARENT_COMMIT:$SUBMODULE_REL")"
GITLINK_SYNC="$(git -C "$ROOT" rev-parse "$SYNC_COMMIT:$SUBMODULE_REL")"
SDK_PARENT="$(lock_sdk_specifier "$PARENT_COMMIT")"
SDK_SYNC="$(lock_sdk_specifier "$SYNC_COMMIT")"
MANIFEST_PARENT_TAG="$(manifest_at_commit_value tag)"
MANIFEST_SYNC_TAG="$(manifest_at_commit_value tag)"

if [[ "$MANIFEST_PARENT_TAG" != "$MANIFEST_SYNC_TAG" ]]; then
  manifest_changed=true
else
  # Treat any manifest release block edit as a sync change. This intentionally
  # rejects metadata-only edits in a commit that does not move the gitlink.
  manifest_changed=false
  git -C "$ROOT" diff "$PARENT_COMMIT" "$SYNC_COMMIT" -- "$MANIFEST_REL" |
    grep -Eq '^[+-][^+-]' && manifest_changed=true || true
fi

if [[ "$GITLINK_PARENT" != "$GITLINK_SYNC" ]]; then
  gitlink_changed=true
else
  gitlink_changed=false
fi

if [[ "$SDK_PARENT" != "$SDK_SYNC" ]]; then
  lock_sdk_changed=true
else
  lock_sdk_changed=false
fi

if [[ "$gitlink_changed" == true || "$manifest_changed" == true || "$lock_sdk_changed" == true ]]; then
  [[ "$gitlink_changed" == true ]] ||
    fail "atomic sync violation: manifest/lockfile changed without the vendor gitlink"
  [[ "$manifest_changed" == true ]] ||
    fail "atomic sync violation: gitlink changed without ops/dsh-sync/manifest.yml"
  [[ "$lock_sdk_changed" == true ]] ||
    fail "atomic sync violation: gitlink changed without a pnpm-lock.yaml sdk-client version change"

  GITLINK_MANIFEST_REF="$(manifest_at_commit_value cliRef)"
  GITLINK_SDK_VERSION="$(manifest_at_commit_value sdkClient)"
  [[ "$GITLINK_SYNC" == "$GITLINK_MANIFEST_REF" ]] ||
    fail "sync commit gitlink ($GITLINK_SYNC) != sync commit cliRef ($GITLINK_MANIFEST_REF)"
  [[ "$SDK_SYNC" == "$GITLINK_SDK_VERSION" ]] ||
    fail "sync commit lockfile sdk-client ($SDK_SYNC) != sync commit sdkClient ($GITLINK_SDK_VERSION)"
fi

echo "✓ PASS G2: sync commit atomicity is valid"

if [[ "$FAST" == true ]]; then
  echo "✓ DSH fast release gate passed (G1-G2)"
  exit 0
fi

# G3-G7 — fail fast in the documented order.
run_gate "G3" ./scripts/bootstrap.sh
run_gate "G4" pnpm exec vitest run dsh-contract
run_gate "G5" pnpm exec vitest run host-contract
run_gate "G6" pnpm run check
run_gate "G7" ./scripts/smoke.sh

echo "✓ DSH release gate passed (G1-G7)"
