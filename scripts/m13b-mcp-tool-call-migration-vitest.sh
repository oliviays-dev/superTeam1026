#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COMPOSE_PROJECT="${M13B_MIGRATION_COMPOSE_PROJECT:-pluginmax-m13b-migration}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.core-regression.yml}"
PORT="${M13B_MIGRATION_POSTGRES_PORT:-54470}"
export CORE_REGRESSION_POSTGRES_PORT="$PORT"
DATABASE_URL_INPUT="${DATABASE_URL:-postgres://pluginmax:pluginmax@127.0.0.1:${PORT}/pluginmax}"
STAMP="$(date -u +%Y%m%d%H%M%S)"
EMPTY_DATABASE="pluginmax_m13b_empty_${STAMP}"
FROM_48_DATABASE="pluginmax_m13b_from48_${STAMP}"
FROM_49_DATABASE="pluginmax_m13b_from49_${STAMP}"
EMPTY_URL="${DATABASE_URL_INPUT%/*}/${EMPTY_DATABASE}"
FROM_48_URL="${DATABASE_URL_INPUT%/*}/${FROM_48_DATABASE}"
FROM_49_URL="${DATABASE_URL_INPUT%/*}/${FROM_49_DATABASE}"

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
  for database in "$EMPTY_DATABASE" "$FROM_48_DATABASE" "$FROM_49_DATABASE"; do
    psql_database postgres \
      "DROP DATABASE IF EXISTS $database WITH (FORCE);" \
      >/dev/null 2>&1 || true
  done
  if [[ "${M13B_MIGRATION_KEEP_ENV:-0}" != "1" ]]; then
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

for database in "$EMPTY_DATABASE" "$FROM_48_DATABASE" "$FROM_49_DATABASE"; do
  psql_database postgres "CREATE DATABASE $database;"
done

DATABASE_URL="$EMPTY_URL" MIGRATION_TARGET_VERSION=50 \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null

FRESH_VERSION="$(psql_database "$EMPTY_DATABASE" \
  "SELECT MAX(version) FROM platform_migrations;")"
FRESH_FLAGS="$(psql_database "$EMPTY_DATABASE" \
  "SELECT string_agg(flag_key || '=' || mode, ',' ORDER BY flag_key)
   FROM feature_flag_settings
   WHERE flag_key IN (
     'mcp.provider_control_plane',
     'mcp.tool_invocation'
   );")"
FRESH_TABLES="$(psql_database "$EMPTY_DATABASE" \
  "SELECT COUNT(*) FROM unnest(ARRAY[
     'mcp_providers',
     'mcp_provider_versions',
     'mcp_provider_probes',
     'mcp_provider_tools',
     'mcp_provider_audit_events',
     'mcp_tool_calls',
     'mcp_tool_call_receipts'
   ]) AS expected(name)
   WHERE to_regclass('public.' || expected.name) IS NOT NULL;")"
FRESH_COLUMNS="$(psql_database "$EMPTY_DATABASE" \
  "SELECT COUNT(*) FROM information_schema.columns
   WHERE (table_name = 'mcp_provider_tools'
          AND column_name = 'tool_key')
      OR (table_name = 'mcp_tool_calls'
          AND column_name IN (
            'tool_key', 'ticket_id', 'gate_id', 'request_digest',
            'input_summary', 'output_digest', 'lease_token'
          ))
      OR (table_name = 'mcp_tool_call_receipts'
          AND column_name IN (
            'status', 'idempotency_key', 'input_summary',
            'output_summary', 'error_category'
          ));")"
FRESH_TRIGGERS="$(psql_database "$EMPTY_DATABASE" \
  "SELECT COUNT(*) FROM pg_trigger
   WHERE NOT tgisinternal
     AND tgname IN (
       'mcp_providers_mutation_guard',
       'mcp_provider_versions_immutable',
       'mcp_provider_tools_immutable',
       'mcp_provider_tools_key_guard',
       'mcp_provider_audit_seq_guard',
       'mcp_provider_audit_append_only',
       'mcp_tool_calls_mutation_guard',
       'mcp_tool_call_receipts_seq_guard',
       'mcp_tool_call_receipts_append_only'
     );")"

DATABASE_URL="$EMPTY_URL" MIGRATION_TARGET_VERSION=50 \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null
IDEMPOTENT_VERSION="$(psql_database "$EMPTY_DATABASE" \
  "SELECT MAX(version) FROM platform_migrations;")"

DATABASE_URL="$FROM_48_URL" MIGRATION_TARGET_VERSION=48 \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null
psql_database "$FROM_48_DATABASE" "
INSERT INTO principals (
  id, kind, display_name, status, status_authority, source,
  version, created_at, updated_at
) VALUES (
  'm13b-migration-owner', 'human', 'M13b Migration Owner', 'active',
  'system', 'local', 1, NOW(), NOW()
);
INSERT INTO market_assets (
  id, asset_key, kind, name, description, publisher_principal_id,
  origin, sharing_scope, publication_status, availability_status,
  current_version, revision, created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000140100',
  'm13b.migration.old.app',
  'skill',
  'M13b migration old app asset',
  '',
  'm13b-migration-owner',
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
  '00000000-0000-4000-8000-000000140101',
  '00000000-0000-4000-8000-000000140100',
  1,
  repeat('a', 64),
  'm13b-migration-owner',
  '{\"summary\":\"old app\"}'::jsonb,
  '{\"minHostVersion\":\"2.0.0\"}'::jsonb,
  'published',
  NOW()
);"
DATABASE_URL="$FROM_48_URL" MIGRATION_TARGET_VERSION=50 \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null

DATABASE_URL="$FROM_49_URL" MIGRATION_TARGET_VERSION=49 \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null
psql_database "$FROM_49_DATABASE" "
INSERT INTO principals (
  id, kind, display_name, status, status_authority, source,
  version, created_at, updated_at
) VALUES (
  'm13b-migration-owner', 'human', 'M13b Migration Owner', 'active',
  'system', 'local', 1, NOW(), NOW()
);
INSERT INTO mcp_providers (
  id, provider_key, owner_principal_id, name, description, status,
  current_version, current_version_id, health_status, health_checked_at,
  health_version_id, discovery_status, tool_count, revision,
  created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000140300',
  'm13b.migration.provider',
  'm13b-migration-owner',
  'M13b Migration Provider',
  '',
  'active',
  1,
  '00000000-0000-4000-8000-000000140301',
  'healthy',
  NOW(),
  '00000000-0000-4000-8000-000000140301',
  'ready',
  2,
  1,
  NOW(),
  NOW()
);
INSERT INTO mcp_provider_versions (
  id, provider_id, version, transport, endpoint_url, auth_kind,
  credential_ref, credential_header_name, request_timeout_ms,
  config_digest, created_by_principal_id, created_at
) VALUES (
  '00000000-0000-4000-8000-000000140301',
  '00000000-0000-4000-8000-000000140300',
  1,
  'streamable-http',
  'https://m13b-migration.example.test/mcp',
  'bearer',
  'env://M13B_MIGRATION_TOKEN',
  NULL,
  5000,
  repeat('b', 64),
  'm13b-migration-owner',
  NOW()
);
INSERT INTO mcp_provider_probes (
  id, provider_id, provider_version_id, status, trigger_source,
  requested_by_principal_id, duration_ms, tool_count, lease_owner,
  lease_token, requested_at, started_at, completed_at
) VALUES (
  '00000000-0000-4000-8000-000000140302',
  '00000000-0000-4000-8000-000000140300',
  '00000000-0000-4000-8000-000000140301',
  'passed',
  'owner',
  'm13b-migration-owner',
  10,
  2,
  'migration-probe-worker',
  '00000000-0000-4000-8000-000000140303',
  NOW() - INTERVAL '2 minutes',
  NOW() - INTERVAL '1 minute',
  NOW()
);
INSERT INTO mcp_provider_tools (
  id, provider_id, provider_version_id, probe_id, tool_name,
  description, input_schema, output_schema, schema_digest, discovered_at
) VALUES
  (
    '00000000-0000-4000-8000-000000140304',
    '00000000-0000-4000-8000-000000140300',
    '00000000-0000-4000-8000-000000140301',
    '00000000-0000-4000-8000-000000140302',
    'orders.lookup',
    'Lookup order',
    '{\"type\":\"object\"}'::jsonb,
    NULL,
    repeat('c', 64),
    NOW()
  ),
  (
    '00000000-0000-4000-8000-000000140305',
    '00000000-0000-4000-8000-000000140300',
    '00000000-0000-4000-8000-000000140301',
    '00000000-0000-4000-8000-000000140302',
    'orders.refund',
    'Refund order',
    '{\"type\":\"object\"}'::jsonb,
    NULL,
    repeat('d', 64),
    NOW()
  );"
DATABASE_URL="$FROM_49_URL" MIGRATION_TARGET_VERSION=50 \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null

FROM_48_VERSION="$(psql_database "$FROM_48_DATABASE" \
  "SELECT MAX(version) FROM platform_migrations;")"
FROM_48_OLD_APP="$(psql_database "$FROM_48_DATABASE" \
  "SELECT origin || '|' || sharing_scope || '|' ||
          publication_status || '|' || availability_status
   FROM market_assets
   WHERE id = '00000000-0000-4000-8000-000000140100';")"
FROM_49_VERSION="$(psql_database "$FROM_49_DATABASE" \
  "SELECT MAX(version) FROM platform_migrations;")"
BACKFILLED_KEYS="$(psql_database "$FROM_49_DATABASE" \
  "SELECT COUNT(*)
   FROM mcp_provider_tools
   WHERE provider_id = '00000000-0000-4000-8000-000000140300'
     AND tool_key ~ '^[a-f0-9]{64}$';")"
UNIQUE_KEYS="$(psql_database "$FROM_49_DATABASE" \
  "SELECT COUNT(DISTINCT tool_key)
   FROM mcp_provider_tools
   WHERE provider_id = '00000000-0000-4000-8000-000000140300';")"

psql_database "$FROM_49_DATABASE" "
INSERT INTO mcp_provider_tools (
  id, provider_id, provider_version_id, probe_id, tool_name,
  description, input_schema, output_schema, schema_digest, discovered_at
) VALUES (
  '00000000-0000-4000-8000-000000140306',
  '00000000-0000-4000-8000-000000140300',
  '00000000-0000-4000-8000-000000140301',
  '00000000-0000-4000-8000-000000140302',
  'orders.cancel',
  'Cancel order',
  '{\"type\":\"object\"}'::jsonb,
  NULL,
  repeat('e', 64),
  NOW()
);"
OLD_APP_TOOL_KEY="$(psql_database "$FROM_49_DATABASE" \
  "SELECT tool_key
   FROM mcp_provider_tools
   WHERE id = '00000000-0000-4000-8000-000000140306';")"
RECEIPT_GUARD="$(
  psql_database "$FROM_49_DATABASE" \
    "SELECT COUNT(*)
     FROM pg_trigger
     WHERE NOT tgisinternal
       AND tgname = 'mcp_tool_call_receipts_append_only';"
)"

[[ "$FRESH_VERSION" == "50" ]]
[[ "$FRESH_FLAGS" == "mcp.provider_control_plane=off,mcp.tool_invocation=off" ]]
[[ "$FRESH_TABLES" == "7" ]]
[[ "$FRESH_COLUMNS" == "13" ]]
[[ "$FRESH_TRIGGERS" == "9" ]]
[[ "$IDEMPOTENT_VERSION" == "50" ]]
[[ "$FROM_48_VERSION" == "50" ]]
[[ "$FROM_48_OLD_APP" == "user|private|published|active" ]]
[[ "$FROM_49_VERSION" == "50" ]]
[[ "$BACKFILLED_KEYS" == "2" ]]
[[ "$UNIQUE_KEYS" == "2" ]]
[[ "$OLD_APP_TOOL_KEY" =~ ^[a-f0-9]{64}$ ]]
[[ "$RECEIPT_GUARD" == "1" ]]

printf 'm13b_migration_vitest=ok\n'
printf 'fresh_migration=0->50\n'
printf 'upgrade_migration=48->50,49->50\n'
printf 'idempotent_migration=50->50\n'
printf 'flags=mcp.provider_control_plane=off,mcp.tool_invocation=off\n'
printf 'tables=7\n'
printf 'columns=13\n'
printf 'triggers=9\n'
printf 'tool_key_backfill=2\n'
printf 'old_app_tool_insert=ok\n'
printf 'old_app_market_read=%s\n' "$FROM_48_OLD_APP"
