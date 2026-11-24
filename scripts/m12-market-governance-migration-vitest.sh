#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COMPOSE_PROJECT="${M12_MIGRATION_COMPOSE_PROJECT:-pluginmax-m12-migration}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.core-regression.yml}"
PORT="${M12_MIGRATION_POSTGRES_PORT:-54466}"
export CORE_REGRESSION_POSTGRES_PORT="$PORT"
DATABASE_URL_INPUT="${DATABASE_URL:-postgres://pluginmax:pluginmax@127.0.0.1:${PORT}/pluginmax}"
STAMP="$(date -u +%Y%m%d%H%M%S)"
EMPTY_DATABASE="pluginmax_m12_empty_${STAMP}"
FROM_46_DATABASE="pluginmax_m12_from46_${STAMP}"
FROM_47_DATABASE="pluginmax_m12_from47_${STAMP}"
EMPTY_URL="${DATABASE_URL_INPUT%/*}/${EMPTY_DATABASE}"
FROM_46_URL="${DATABASE_URL_INPUT%/*}/${FROM_46_DATABASE}"
FROM_47_URL="${DATABASE_URL_INPUT%/*}/${FROM_47_DATABASE}"

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
  for database in "$EMPTY_DATABASE" "$FROM_46_DATABASE" "$FROM_47_DATABASE"; do
    psql_database postgres \
      "DROP DATABASE IF EXISTS $database WITH (FORCE);" \
      >/dev/null 2>&1 || true
  done
  if [[ "${M12_MIGRATION_KEEP_ENV:-0}" != "1" ]]; then
    compose down -v >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

compose up -d postgres >/dev/null
for _ in {1..120}; do
  container_id="$(compose ps -q postgres)"
  health="$(
    docker inspect --format '{{.State.Health.Status}}' \
      "$container_id" 2>/dev/null || true
  )"
  if [[ "$health" == "healthy" ]] &&
    psql_database postgres "SELECT 1;" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

for database in "$EMPTY_DATABASE" "$FROM_46_DATABASE" "$FROM_47_DATABASE"; do
  psql_database postgres "CREATE DATABASE $database;"
done

DATABASE_URL="$EMPTY_URL" MIGRATION_TARGET_VERSION=48 \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null

FRESH_VERSION="$(psql_database "$EMPTY_DATABASE" \
  "SELECT MAX(version) FROM platform_migrations;")"
FRESH_FLAGS="$(psql_database "$EMPTY_DATABASE" \
  "SELECT string_agg(flag_key || '=' || mode, ',' ORDER BY flag_key)
   FROM feature_flag_settings
   WHERE flag_key IN ('market.governance_v2', 'market.shared_supply');")"
FRESH_TABLES="$(psql_database "$EMPTY_DATABASE" \
  "SELECT COUNT(*) FROM unnest(ARRAY[
     'market_governance_audit_events',
     'market_asset_resource_bindings'
   ]) AS expected(name)
   WHERE to_regclass('public.' || expected.name) IS NOT NULL;")"
FRESH_COLUMNS="$(psql_database "$EMPTY_DATABASE" \
  "SELECT COUNT(*) FROM information_schema.columns
   WHERE table_name = 'market_assets'
     AND column_name IN (
       'origin', 'sharing_scope', 'sharing_scope_id',
       'publication_status', 'availability_status', 'admin_locked',
       'admin_locked_at', 'admin_locked_by_principal_id',
       'admin_lock_reason', 'published_at', 'delisted_at', 'archived_at',
       'suspended_at', 'suspended_reason', 'publication_changed_at',
       'availability_changed_at'
     );")"
FRESH_TRIGGERS="$(psql_database "$EMPTY_DATABASE" \
  "SELECT COUNT(*) FROM pg_trigger
   WHERE NOT tgisinternal
     AND tgname IN (
       'market_assets_governance_projection',
       'market_governance_audit_append_only',
       'market_asset_resource_bindings_guard',
       'market_asset_resource_bindings_immutable'
     );")"

DATABASE_URL="$EMPTY_URL" MIGRATION_TARGET_VERSION=48 \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null
IDEMPOTENT_VERSION="$(psql_database "$EMPTY_DATABASE" \
  "SELECT MAX(version) FROM platform_migrations;")"

DATABASE_URL="$FROM_46_URL" MIGRATION_TARGET_VERSION=46 \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null

DATABASE_URL="$FROM_47_URL" MIGRATION_TARGET_VERSION=47 \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null
psql_database "$FROM_47_DATABASE" "
INSERT INTO principals (
  id, kind, display_name, status, status_authority, source,
  version, created_at, updated_at
) VALUES (
  'm12-migration-owner', 'human', 'M12 Migration Owner', 'active', 'system',
  'local', 1, NOW(), NOW()
);
INSERT INTO market_assets (
  id, asset_key, kind, name, description, publisher_principal_id,
  trust_level, visibility, visibility_scope_id, status, current_version,
  revision, created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000120001',
  'm12.migration.panel',
  'panel',
  'M12 Migration Panel',
  '',
  'm12-migration-owner',
  'official',
  'public',
  NULL,
  'active',
  1,
  1,
  NOW(),
  NOW()
);
INSERT INTO market_asset_versions (
  id, asset_id, version, digest, publisher_principal_id, manifest,
  compatibility, status, created_at
) VALUES (
  '00000000-0000-4000-8000-000000120002',
  '00000000-0000-4000-8000-000000120001',
  1,
  repeat('a', 64),
  'm12-migration-owner',
  '{\"panelPluginId\":\"market.sample\"}'::jsonb,
  '{\"minHostVersion\":\"2.0.0\"}'::jsonb,
  'published',
  NOW()
);"

DATABASE_URL="$FROM_46_URL" MIGRATION_TARGET_VERSION=48 \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null
DATABASE_URL="$FROM_47_URL" MIGRATION_TARGET_VERSION=48 \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null

FROM_46_VERSION="$(psql_database "$FROM_46_DATABASE" \
  "SELECT MAX(version) FROM platform_migrations;")"
FROM_47_VERSION="$(psql_database "$FROM_47_DATABASE" \
  "SELECT MAX(version) FROM platform_migrations;")"
BACKFILL="$(psql_database "$FROM_47_DATABASE" \
  "SELECT origin || '|' || sharing_scope || '|' ||
          publication_status || '|' || availability_status || '|' ||
          visibility || '|' || status
   FROM market_assets
   WHERE id = '00000000-0000-4000-8000-000000120001';")"
BINDING_SEED="$(psql_database "$FROM_47_DATABASE" \
  "SELECT COUNT(*)
   FROM market_asset_resource_bindings
   WHERE asset_id = '00000000-0000-4000-8000-000000120001'
     AND resource_kind = 'trusted_panel'
     AND resource_id = 'market.sample';")"

psql_database "$FROM_47_DATABASE" "
INSERT INTO market_assets (
  id, asset_key, kind, name, description, publisher_principal_id,
  trust_level, visibility, visibility_scope_id, status, current_version,
  revision, created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000120003',
  'm12.old.app.write',
  'skill',
  'Old app write',
  '',
  'm12-migration-owner',
  'private',
  'private',
  NULL,
  'active',
  1,
  1,
  NOW(),
  NOW()
);"
OLD_APP_READ="$(psql_database "$FROM_47_DATABASE" \
  "SELECT visibility || '|' || status || '|' || trust_level
   FROM market_assets
   WHERE id = '00000000-0000-4000-8000-000000120003';")"
OLD_APP_WRITE="$(psql_database "$FROM_47_DATABASE" \
  "SELECT origin || '|' || sharing_scope || '|' ||
          publication_status || '|' || availability_status
   FROM market_assets
   WHERE id = '00000000-0000-4000-8000-000000120003';")"

[[ "$FRESH_VERSION" == "48" ]]
[[ "$FRESH_FLAGS" == "market.governance_v2=off,market.shared_supply=off" ]]
[[ "$FRESH_TABLES" == "2" ]]
[[ "$FRESH_COLUMNS" == "16" ]]
[[ "$FRESH_TRIGGERS" == "4" ]]
[[ "$IDEMPOTENT_VERSION" == "48" ]]
[[ "$FROM_46_VERSION" == "48" ]]
[[ "$FROM_47_VERSION" == "48" ]]
[[ "$BACKFILL" == "platform|platform|published|active|public|active" ]]
[[ "$BINDING_SEED" == "1" ]]
[[ "$OLD_APP_READ" == "private|active|private" ]]
[[ "$OLD_APP_WRITE" == "user|private|published|active" ]]

printf 'm12_migration_vitest=ok\n'
printf 'fresh_migration=0->48\n'
printf 'upgrade_migration=46->48,47->48\n'
printf 'idempotent_migration=48->48\n'
printf 'flags=%s\n' "$FRESH_FLAGS"
printf 'tables=%s\n' "$FRESH_TABLES"
printf 'columns=%s\n' "$FRESH_COLUMNS"
printf 'triggers=%s\n' "$FRESH_TRIGGERS"
printf 'backfill=%s\n' "$BACKFILL"
printf 'binding_seed=%s\n' "$BINDING_SEED"
printf 'old_app_read=%s\n' "$OLD_APP_READ"
printf 'old_app_write=%s\n' "$OLD_APP_WRITE"
