#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COMPOSE_PROJECT="${COMPOSE_PROJECT:-pluginmax-batch20a-identity}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.batch20a.yml}"
DATABASE_URL_INPUT="${DATABASE_URL:-postgres://pluginmax:pluginmax@127.0.0.1:54433/pluginmax}"
STAMP="$(date -u +%Y%m%d%H%M%S)"
FRESH_DATABASE="pluginmax_batch20a_fresh_$STAMP"
UPGRADE_DATABASE="pluginmax_batch20a_upgrade_$STAMP"
FRESH_URL="${DATABASE_URL_INPUT%/*}/$FRESH_DATABASE"
UPGRADE_URL="${DATABASE_URL_INPUT%/*}/$UPGRADE_DATABASE"
TMP_ROOT="$ROOT/.tmp/batch20a-identity-admin"
LOG_DIR="$TMP_ROOT/logs"

mkdir -p "$LOG_DIR"

compose() {
  "$ROOT/scripts/db-compose.sh" -p "$COMPOSE_PROJECT" -f "$ROOT/$COMPOSE_FILE" "$@"
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
}
trap cleanup EXIT

compose up -d postgres >/dev/null
for _ in {1..80}; do
  container_id="$(compose ps -q postgres)"
  health="$(docker inspect --format '{{.State.Health.Status}}' "$container_id" 2>/dev/null || true)"
  if [[ "$health" == "healthy" ]] &&
    compose exec -T postgres psql -U pluginmax -d pluginmax -qAt \
      -c "SELECT 1" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
psql_database postgres "CREATE DATABASE $FRESH_DATABASE;"
psql_database postgres "CREATE DATABASE $UPGRADE_DATABASE;"

DATABASE_URL="$UPGRADE_URL" MIGRATION_TARGET_VERSION=31 \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null
psql_database "$UPGRADE_DATABASE" "
INSERT INTO principals (
  id, kind, display_name, status, status_authority, source,
  version, created_at, updated_at
) VALUES (
  'principal-upgrade-owner', 'human', 'Upgrade Owner', 'active',
  'account', 'account', 1, NOW(), NOW()
);
INSERT INTO workspace_members (
  id, workspace_id, principal_id, status, created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000002001',
  'workspace-upgrade', 'principal-upgrade-owner', 'active', NOW(), NOW()
);
INSERT INTO role_grants (
  id, principal_id, scope_type, scope_id, role_key, permissions, status,
  source_kind, source_ref, granted_by_principal_id, revoked_by_principal_id,
  granted_at, expires_at, revoked_at, version, created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000002002',
  'principal-upgrade-owner', 'workspace', 'workspace-upgrade', 'ADMIN',
  '[\"read\",\"manage_members\",\"manage_roles\"]'::jsonb, 'active',
  'workspace-role', 'upgrade-fixture', NULL, NULL, NOW(), NULL, NULL, 1,
  NOW(), NOW()
);
"
DATABASE_URL="$UPGRADE_URL" MIGRATION_TARGET_VERSION=32 \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null
upgrade_version="$(psql_database "$UPGRADE_DATABASE" \
  "SELECT MAX(version) FROM platform_migrations;")"
upgrade_workspace="$(psql_database "$UPGRADE_DATABASE" \
  "SELECT id || '|' || display_name || '|' || status FROM workspaces WHERE id = 'workspace-upgrade';")"
upgrade_member_version="$(psql_database "$UPGRADE_DATABASE" \
  "SELECT version FROM workspace_members WHERE id = '00000000-0000-4000-8000-000000002001';")"
[[ "$upgrade_version" == "32" ]]
[[ "$upgrade_workspace" == "workspace-upgrade|workspace-upgrade|active" ]]
[[ "$upgrade_member_version" == "1" ]]

DATABASE_URL="$FRESH_URL" MIGRATION_TARGET_VERSION=32 \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null
fresh_version="$(psql_database "$FRESH_DATABASE" \
  "SELECT MAX(version) FROM platform_migrations;")"
fresh_tables="$(psql_database "$FRESH_DATABASE" \
  "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'workspaces';")"
[[ "$fresh_version" == "32" ]]
[[ "$fresh_tables" == "1" ]]

TEST_DATABASE_URL="$FRESH_URL" DSH_HOME="$TMP_ROOT/dsh-home" \
  FILE_STORE_ROOT="$TMP_ROOT/files" AGENT_WORKSPACE_ROOT="$TMP_ROOT/workspaces" \
  node_modules/.bin/vitest run \
  packages/contracts/src/identity.test.ts \
  packages/application/src/authorization.test.ts \
  packages/database/src/identity-principal-schema.test.ts \
  packages/database/src/identity-repository.test.ts \
  apps/api/src/identity-administration.test.ts

printf 'fresh_migration=%s\n' "$fresh_version"
printf 'upgrade_migration=%s\n' "$upgrade_version"
printf 'workspace_backfill=%s\n' "$upgrade_workspace"
