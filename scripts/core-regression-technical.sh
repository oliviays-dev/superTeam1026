#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COMPOSE_PROJECT="${COMPOSE_PROJECT:-pluginmax-core-regression-technical}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.core-regression.yml}"
DATABASE_URL_INPUT="${DATABASE_URL:-postgres://pluginmax:pluginmax@127.0.0.1:54440/pluginmax}"
STAMP="$(date -u +%Y%m%d%H%M%S)"
FRESH_DATABASE="pluginmax_core_technical_fresh_${STAMP}"
UPGRADE_DATABASE="pluginmax_core_technical_upgrade_${STAMP}"
FRESH_URL="${DATABASE_URL_INPUT%/*}/${FRESH_DATABASE}"
UPGRADE_URL="${DATABASE_URL_INPUT%/*}/${UPGRADE_DATABASE}"
RUN_ID="${CORE_REGRESSION_RUN_ID:-technical-${STAMP}}"
TMP_ROOT="$ROOT/.tmp/core-regression/${RUN_ID}"
LOG_DIR="$TMP_ROOT/logs"
SUMMARY="$TMP_ROOT/summary.txt"

mkdir -p "$LOG_DIR"
: >"$SUMMARY"

record() {
  printf '%s\n' "$*" | tee -a "$SUMMARY"
}

compose() {
  "$ROOT/scripts/db-compose.sh" \
    -p "$COMPOSE_PROJECT" \
    -f "$ROOT/$COMPOSE_FILE" \
    "$@"
}

psql_database() {
  local database="$1"
  local sql="$2"
  compose exec -T postgres psql -U pluginmax -d "$database" \
    -qAt -v ON_ERROR_STOP=1 -c "$sql"
}

cleanup() {
  psql_database postgres \
    "DROP DATABASE IF EXISTS $FRESH_DATABASE WITH (FORCE);" \
    >/dev/null 2>&1 || true
  psql_database postgres \
    "DROP DATABASE IF EXISTS $UPGRADE_DATABASE WITH (FORCE);" \
    >/dev/null 2>&1 || true
  if [[ "${CORE_REGRESSION_KEEP_ENV:-0}" != "1" ]]; then
    compose down -v >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

compose up -d postgres >/dev/null
for _ in {1..120}; do
  container_id="$(compose ps -q postgres)"
  health="$(docker inspect --format '{{.State.Health.Status}}' "$container_id" 2>/dev/null || true)"
  if [[ "$health" == "healthy" ]] &&
    psql_database postgres "SELECT 1;" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

psql_database postgres "CREATE DATABASE $FRESH_DATABASE;"
psql_database postgres "CREATE DATABASE $UPGRADE_DATABASE;"

DATABASE_URL="$FRESH_URL" \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts \
  >"$LOG_DIR/fresh-all.log" 2>&1

FRESH_VERSION="$(psql_database "$FRESH_DATABASE" \
  "SELECT MAX(version) FROM platform_migrations;")"
UPGRADE_FROM="$((FRESH_VERSION - 1))"
[[ "$FRESH_VERSION" -gt 1 ]]

DATABASE_URL="$UPGRADE_URL" MIGRATION_TARGET_VERSION="$UPGRADE_FROM" \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts \
  >"$LOG_DIR/upgrade-from-${UPGRADE_FROM}.log" 2>&1

psql_database "$UPGRADE_DATABASE" "
INSERT INTO principals (
  id, kind, display_name, status, status_authority, source,
  version, created_at, updated_at
) VALUES (
  'principal-core-upgrade-owner', 'human', 'Core Upgrade Owner', 'active',
  'account', 'account', 1, NOW(), NOW()
);
INSERT INTO workspaces (
  id, display_name, status, created_by_principal_id, version,
  created_at, updated_at
) VALUES (
  'workspace-core-upgrade', 'workspace-core-upgrade', 'active',
  'principal-core-upgrade-owner', 1, NOW(), NOW()
);
INSERT INTO workspace_members (
  id, workspace_id, principal_id, status, version, created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000003201',
  'workspace-core-upgrade', 'principal-core-upgrade-owner',
  'active', 1, NOW(), NOW()
);
INSERT INTO role_grants (
  id, principal_id, scope_type, scope_id, role_key, permissions, status,
  source_kind, source_ref, granted_by_principal_id, revoked_by_principal_id,
  granted_at, expires_at, revoked_at, version, created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000003202',
  'principal-core-upgrade-owner', 'workspace', 'workspace-core-upgrade',
  'ADMIN', '[\"read\",\"manage_members\",\"manage_roles\"]'::jsonb,
  'active', 'workspace-role', 'core-upgrade-fixture', NULL, NULL,
  NOW(), NULL, NULL, 1, NOW(), NOW()
);
"

DATABASE_URL="$UPGRADE_URL" \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts \
  >"$LOG_DIR/upgrade-to-${FRESH_VERSION}.log" 2>&1

UPGRADE_VERSION="$(psql_database "$UPGRADE_DATABASE" \
  "SELECT MAX(version) FROM platform_migrations;")"
UPGRADE_WORKSPACE="$(psql_database "$UPGRADE_DATABASE" \
  "SELECT id || '|' || display_name || '|' || status
   FROM workspaces
   WHERE id = 'workspace-core-upgrade';")"
UPGRADE_MEMBER_VERSION="$(psql_database "$UPGRADE_DATABASE" \
  "SELECT version
   FROM workspace_members
   WHERE id = '00000000-0000-4000-8000-000000003201';")"
UPGRADE_SHARED_ROOT="$(psql_database "$UPGRADE_DATABASE" \
  "SELECT status || '|' || default_read || '|' || default_write
   FROM shared_space_roots
   WHERE workspace_id = 'workspace-core-upgrade';")"

[[ "$UPGRADE_VERSION" == "$FRESH_VERSION" ]]
[[ "$UPGRADE_WORKSPACE" == "workspace-core-upgrade|workspace-core-upgrade|active" ]]
[[ "$UPGRADE_MEMBER_VERSION" == "1" ]]
[[ "$UPGRADE_SHARED_ROOT" == "active|t|f" ]]
record "upgrade_migration=${UPGRADE_FROM}->${UPGRADE_VERSION}"
record "upgrade_workspace=$UPGRADE_WORKSPACE"
record "upgrade_shared_root=$UPGRADE_SHARED_ROOT"

FRESH_TABLES="$(psql_database "$FRESH_DATABASE" \
  "SELECT COUNT(*)
   FROM information_schema.tables
   WHERE table_schema = 'public'
     AND table_name IN (
       'workspaces',
       'workspace_members',
       'role_grants',
       'identity_audit_events'
     );")"

[[ "$FRESH_TABLES" == "4" ]]
record "fresh_migration=0->${FRESH_VERSION}"

rm -rf "$TMP_ROOT/dsh-home" "$TMP_ROOT/files" "$TMP_ROOT/workspaces"
mkdir -p "$TMP_ROOT/dsh-home" "$TMP_ROOT/files" "$TMP_ROOT/workspaces"

set +e
TEST_DATABASE_URL="$FRESH_URL" \
  DSH_HOME="$TMP_ROOT/dsh-home" \
  FILE_STORE_ROOT="$TMP_ROOT/files" \
  AGENT_WORKSPACE_ROOT="$TMP_ROOT/workspaces" \
  PLUGINMAX_ROOT="$ROOT" \
  CI=true \
  pnpm test 2>&1 | tee "$LOG_DIR/full-vitest.log"
VITEST_EXIT="${PIPESTATUS[0]}"
set -e

record "full_vitest_exit=$VITEST_EXIT"
record "platform_sha=$(git rev-parse HEAD)"
record "dsh_sha=$(git -C '/Users/oliviayang/Codex/一切皆插件/dsh-pluginmax' rev-parse HEAD)"
record "evidence_root=$TMP_ROOT"

cat >"$TMP_ROOT/manifest.json" <<JSON
{
  "runId": "$RUN_ID",
  "platformSha": "$(git rev-parse HEAD)",
  "dshSha": "$(git -C '/Users/oliviayang/Codex/一切皆插件/dsh-pluginmax' rev-parse HEAD)",
  "freshMigration": $FRESH_VERSION,
  "upgradeMigration": $UPGRADE_VERSION,
  "vitestExitCode": $VITEST_EXIT,
  "evidenceRoot": "$TMP_ROOT"
}
JSON

exit "$VITEST_EXIT"
