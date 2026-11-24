#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COMPOSE_PROJECT="${M13A_MIGRATION_COMPOSE_PROJECT:-pluginmax-m13a-migration}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.core-regression.yml}"
PORT="${M13A_MIGRATION_POSTGRES_PORT:-54468}"
export CORE_REGRESSION_POSTGRES_PORT="$PORT"
DATABASE_URL_INPUT="${DATABASE_URL:-postgres://pluginmax:pluginmax@127.0.0.1:${PORT}/pluginmax}"
STAMP="$(date -u +%Y%m%d%H%M%S)"
EMPTY_DATABASE="pluginmax_m13a_empty_${STAMP}"
FROM_47_DATABASE="pluginmax_m13a_from47_${STAMP}"
FROM_48_DATABASE="pluginmax_m13a_from48_${STAMP}"
EMPTY_URL="${DATABASE_URL_INPUT%/*}/${EMPTY_DATABASE}"
FROM_47_URL="${DATABASE_URL_INPUT%/*}/${FROM_47_DATABASE}"
FROM_48_URL="${DATABASE_URL_INPUT%/*}/${FROM_48_DATABASE}"

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
  for database in "$EMPTY_DATABASE" "$FROM_47_DATABASE" "$FROM_48_DATABASE"; do
    psql_database postgres \
      "DROP DATABASE IF EXISTS $database WITH (FORCE);" \
      >/dev/null 2>&1 || true
  done
  if [[ "${M13A_MIGRATION_KEEP_ENV:-0}" != "1" ]]; then
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

for database in "$EMPTY_DATABASE" "$FROM_47_DATABASE" "$FROM_48_DATABASE"; do
  psql_database postgres "CREATE DATABASE $database;"
done

DATABASE_URL="$EMPTY_URL" MIGRATION_TARGET_VERSION=49 \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null

FRESH_VERSION="$(psql_database "$EMPTY_DATABASE" \
  "SELECT MAX(version) FROM platform_migrations;")"
FRESH_FLAG="$(psql_database "$EMPTY_DATABASE" \
  "SELECT flag_key || '=' || mode
   FROM feature_flag_settings
   WHERE flag_key = 'mcp.provider_control_plane'
     AND scope_type = 'platform' AND scope_id = 'platform';")"
FRESH_TABLES="$(psql_database "$EMPTY_DATABASE" \
  "SELECT COUNT(*) FROM unnest(ARRAY[
     'mcp_providers',
     'mcp_provider_versions',
     'mcp_provider_probes',
     'mcp_provider_tools',
     'mcp_provider_audit_events'
   ]) AS expected(name)
   WHERE to_regclass('public.' || expected.name) IS NOT NULL;")"
FRESH_COLUMNS="$(psql_database "$EMPTY_DATABASE" \
  "SELECT COUNT(*) FROM information_schema.columns
   WHERE (table_name = 'mcp_providers'
          AND column_name IN (
            'status', 'current_version_id', 'health_status',
            'health_version_id', 'discovery_status', 'revision'
          ))
      OR (table_name = 'mcp_provider_versions'
          AND column_name IN (
            'credential_ref', 'credential_header_name', 'config_digest'
          ));")"
FRESH_TRIGGERS="$(psql_database "$EMPTY_DATABASE" \
  "SELECT COUNT(*) FROM pg_trigger
   WHERE NOT tgisinternal
     AND tgname IN (
       'mcp_providers_mutation_guard',
       'mcp_provider_versions_immutable',
       'mcp_provider_tools_immutable',
       'mcp_provider_audit_seq_guard',
       'mcp_provider_audit_append_only'
     );")"

DATABASE_URL="$EMPTY_URL" MIGRATION_TARGET_VERSION=49 \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null
IDEMPOTENT_VERSION="$(psql_database "$EMPTY_DATABASE" \
  "SELECT MAX(version) FROM platform_migrations;")"

DATABASE_URL="$FROM_47_URL" MIGRATION_TARGET_VERSION=47 \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null
psql_database "$FROM_47_DATABASE" "
INSERT INTO principals (
  id, kind, display_name, status, status_authority, source,
  version, created_at, updated_at
) VALUES (
  'm13a-migration-owner', 'human', 'M13a Migration Owner', 'active',
  'system', 'local', 1, NOW(), NOW()
);
INSERT INTO market_assets (
  id, asset_key, kind, name, description, publisher_principal_id,
  trust_level, visibility, visibility_scope_id, status, current_version,
  revision, created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000130100',
  'm13a.migration.existing',
  'skill',
  'M13a migration existing asset',
  '',
  'm13a-migration-owner',
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
  '00000000-0000-4000-8000-000000130101',
  '00000000-0000-4000-8000-000000130100',
  1,
  repeat('a', 64),
  'm13a-migration-owner',
  '{\"summary\":\"legacy\"}'::jsonb,
  '{\"minHostVersion\":\"2.0.0\"}'::jsonb,
  'published',
  NOW()
);"
DATABASE_URL="$FROM_47_URL" MIGRATION_TARGET_VERSION=49 \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null

DATABASE_URL="$FROM_48_URL" MIGRATION_TARGET_VERSION=48 \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null
psql_database "$FROM_48_DATABASE" "
INSERT INTO principals (
  id, kind, display_name, status, status_authority, source,
  version, created_at, updated_at
) VALUES (
  'm13a-migration-owner', 'human', 'M13a Migration Owner', 'active',
  'system', 'local', 1, NOW(), NOW()
);
INSERT INTO market_assets (
  id, asset_key, kind, name, description, publisher_principal_id,
  origin, sharing_scope, publication_status, availability_status,
  current_version, revision, created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000130200',
  'm13a.migration.binding',
  'skill',
  'M13a migration binding asset',
  '',
  'm13a-migration-owner',
  'user',
  'private',
  'published',
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
  '00000000-0000-4000-8000-000000130201',
  '00000000-0000-4000-8000-000000130200',
  1,
  repeat('b', 64),
  'm13a-migration-owner',
  '{\"summary\":\"binding\"}'::jsonb,
  '{\"minHostVersion\":\"2.0.0\"}'::jsonb,
  'published',
  NOW()
);"
DATABASE_URL="$FROM_48_URL" MIGRATION_TARGET_VERSION=49 \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null

FROM_47_VERSION="$(psql_database "$FROM_47_DATABASE" \
  "SELECT MAX(version) FROM platform_migrations;")"
FROM_48_VERSION="$(psql_database "$FROM_48_DATABASE" \
  "SELECT MAX(version) FROM platform_migrations;")"
FROM_47_FLAGS="$(psql_database "$FROM_47_DATABASE" \
  "SELECT string_agg(flag_key || '=' || mode, ',' ORDER BY flag_key)
   FROM feature_flag_settings
   WHERE flag_key IN (
     'market.governance_v2',
     'market.shared_supply',
     'mcp.provider_control_plane'
   );")"
LEGACY_READ="$(psql_database "$FROM_47_DATABASE" \
  "SELECT origin || '|' || sharing_scope || '|' ||
          publication_status || '|' || availability_status || '|' ||
          visibility || '|' || status
   FROM market_assets
   WHERE id = '00000000-0000-4000-8000-000000130100';")"

psql_database "$FROM_48_DATABASE" "
INSERT INTO mcp_providers (
  id, provider_key, owner_principal_id, name, description, status,
  current_version, current_version_id, health_status, health_checked_at,
  health_version_id, discovery_status, tool_count, revision,
  created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000130300',
  'm13a.migration.provider',
  'm13a-migration-owner',
  'M13a Migration Provider',
  '',
  'active',
  1,
  '00000000-0000-4000-8000-000000130301',
  'healthy',
  NOW(),
  '00000000-0000-4000-8000-000000130301',
  'ready',
  0,
  1,
  NOW(),
  NOW()
);
INSERT INTO mcp_provider_versions (
  id, provider_id, version, transport, endpoint_url, auth_kind,
  credential_ref, credential_header_name, request_timeout_ms,
  config_digest, created_by_principal_id, created_at
) VALUES (
  '00000000-0000-4000-8000-000000130301',
  '00000000-0000-4000-8000-000000130300',
  1,
  'streamable-http',
  'https://provider.example.test/mcp',
  'bearer',
  'env://M13A_MIGRATION_TOKEN',
  NULL,
  5000,
  repeat('c', 64),
  'm13a-migration-owner',
  NOW()
);
INSERT INTO market_asset_resource_bindings (
  id, asset_id, asset_version_id, resource_kind, resource_id,
  resource_version_id, created_by_principal_id, created_at
) VALUES (
  '00000000-0000-4000-8000-000000130302',
  '00000000-0000-4000-8000-000000130200',
  '00000000-0000-4000-8000-000000130201',
  'mcp_provider',
  'm13a.migration.provider',
  '00000000-0000-4000-8000-000000130301',
  'm13a-migration-owner',
  NOW()
);
INSERT INTO market_assets (
  id, asset_key, kind, name, description, publisher_principal_id,
  origin, sharing_scope, publication_status, availability_status,
  current_version, revision, created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000130310',
  'm13a.migration.catalogue',
  'mcp',
  'M13a Migration Catalogue',
  '',
  'm13a-migration-owner',
  'user',
  'private',
  'published',
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
  '00000000-0000-4000-8000-000000130311',
  '00000000-0000-4000-8000-000000130310',
  1,
  repeat('d', 64),
  'm13a-migration-owner',
  '{\"summary\":\"legacy MCP catalogue\"}'::jsonb,
  '{\"minHostVersion\":\"2.0.0\"}'::jsonb,
  'published',
  NOW()
);
INSERT INTO market_asset_resource_bindings (
  id, asset_id, asset_version_id, resource_kind, resource_id,
  resource_version_id, created_by_principal_id, created_at
) VALUES (
  '00000000-0000-4000-8000-000000130312',
  '00000000-0000-4000-8000-000000130200',
  '00000000-0000-4000-8000-000000130201',
  'mcp_provider',
  'm13a.migration.catalogue',
  '00000000-0000-4000-8000-000000130311',
  'm13a-migration-owner',
  NOW()
);"

PROVIDER_BINDING="$(psql_database "$FROM_48_DATABASE" \
  "SELECT COUNT(*)
   FROM market_asset_resource_bindings
   WHERE resource_kind = 'mcp_provider'
     AND resource_id IN (
       'm13a.migration.provider',
       'm13a.migration.catalogue'
     );")"
PROVIDER_AUDIT="$(
  psql_database "$FROM_48_DATABASE" \
    "SELECT COUNT(*) FROM mcp_provider_audit_events;"
)"

psql_database "$FROM_48_DATABASE" "
INSERT INTO market_assets (
  id, asset_key, kind, name, description, publisher_principal_id,
  trust_level, visibility, visibility_scope_id, status, current_version,
  revision, created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000130320',
  'm13a.old.app.write',
  'skill',
  'M13a old app write',
  '',
  'm13a-migration-owner',
  'private',
  'private',
  NULL,
  'active',
  1,
  1,
  NOW(),
  NOW()
);"
OLD_APP_READ="$(psql_database "$FROM_48_DATABASE" \
  "SELECT visibility || '|' || status || '|' || trust_level
   FROM market_assets
   WHERE id = '00000000-0000-4000-8000-000000130320';")"
OLD_APP_PROJECTION="$(psql_database "$FROM_48_DATABASE" \
  "SELECT origin || '|' || sharing_scope || '|' ||
          publication_status || '|' || availability_status
   FROM market_assets
   WHERE id = '00000000-0000-4000-8000-000000130320';")"

[[ "$FRESH_VERSION" == "49" ]]
[[ "$FRESH_FLAG" == "mcp.provider_control_plane=off" ]]
[[ "$FRESH_TABLES" == "5" ]]
[[ "$FRESH_COLUMNS" == "9" ]]
[[ "$FRESH_TRIGGERS" == "5" ]]
[[ "$IDEMPOTENT_VERSION" == "49" ]]
[[ "$FROM_47_VERSION" == "49" ]]
[[ "$FROM_48_VERSION" == "49" ]]
[[ "$FROM_47_FLAGS" == "market.governance_v2=off,market.shared_supply=off,mcp.provider_control_plane=off" ]]
[[ "$LEGACY_READ" == "platform|platform|published|active|public|active" ]]
[[ "$PROVIDER_BINDING" == "2" ]]
[[ "$PROVIDER_AUDIT" == "0" ]]
[[ "$OLD_APP_READ" == "private|active|private" ]]
[[ "$OLD_APP_PROJECTION" == "user|private|published|active" ]]

printf 'm13a_migration_vitest=ok\n'
printf 'fresh_migration=0->49\n'
printf 'upgrade_migration=47->49,48->49\n'
printf 'idempotent_migration=49->49\n'
printf 'flag=%s\n' "$FRESH_FLAG"
printf 'tables=%s\n' "$FRESH_TABLES"
printf 'columns=%s\n' "$FRESH_COLUMNS"
printf 'triggers=%s\n' "$FRESH_TRIGGERS"
printf 'existing_market=%s\n' "$LEGACY_READ"
printf 'mcp_bindings=%s\n' "$PROVIDER_BINDING"
printf 'old_app_read=%s\n' "$OLD_APP_READ"
printf 'old_app_projection=%s\n' "$OLD_APP_PROJECTION"
