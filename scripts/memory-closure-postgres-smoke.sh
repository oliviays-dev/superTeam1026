#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-pluginmax-batch10b}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.batch10b.yml}"
DATABASE_URL_INPUT="${DATABASE_URL:-postgres://pluginmax:pluginmax@127.0.0.1:54410/pluginmax}"
STAMP="$(date -u +%Y%m%d%H%M%S)"

compose() {
  "$ROOT/scripts/db-compose.sh" -p "$COMPOSE_PROJECT" -f "$ROOT/$COMPOSE_FILE" "$@"
}

psql_database() {
  local database="$1"
  local sql="$2"
  compose exec -T postgres psql -U pluginmax -d "$database" \
    -qAt -v ON_ERROR_STOP=1 -c "$sql"
}

compose up -d postgres >/dev/null
for _ in {1..60}; do
  if compose exec -T postgres pg_isready \
    -U pluginmax -d pluginmax >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

database="pluginmax_batch10b_migration_$STAMP"
database_url="${DATABASE_URL_INPUT%/*}/$database"
psql_database postgres "CREATE DATABASE $database;"

cleanup() {
  psql_database postgres \
    "DROP DATABASE IF EXISTS $database WITH (FORCE);" \
    >/dev/null 2>&1 || true
}
trap cleanup EXIT

DATABASE_URL="$database_url" MIGRATION_TARGET_VERSION=15 CI=true \
  pnpm --filter @pluginmax/database exec tsx src/migrate-cli.ts >/dev/null

psql_database "$database" "
  INSERT INTO projects (
    id, name, code, description, status, created_at, updated_at
  ) VALUES (
    '60000000-0000-4000-8000-000000000001',
    'Legacy memory closure',
    'B10B-MIG',
    'migration 16 smoke',
    'active',
    NOW(),
    NOW()
  );
  INSERT INTO memory_topics (
    id, project_id, title, created_at, updated_at
  ) VALUES (
    '60000000-0000-4000-8000-000000000002',
    '60000000-0000-4000-8000-000000000001',
    'Legacy topic',
    NOW(),
    NOW()
  );
  INSERT INTO memory_claims (
    id, topic_id, project_id, content, status, source_type, source_id,
    created_at, updated_at
  ) VALUES (
    '60000000-0000-4000-8000-000000000003',
    '60000000-0000-4000-8000-000000000002',
    '60000000-0000-4000-8000-000000000001',
    'Legacy claim remains readable',
    'proposed',
    'manual',
    'local-admin',
    NOW(),
    NOW()
  );
"

DATABASE_URL="$database_url" MIGRATION_TARGET_VERSION=16 CI=true \
  pnpm --filter @pluginmax/database exec tsx src/migrate-cli.ts >/dev/null

version="$(psql_database "$database" \
  'SELECT MAX(version) FROM platform_migrations;')"
legacy_version="$(psql_database "$database" \
  "SELECT version FROM memory_claims WHERE id = '60000000-0000-4000-8000-000000000003';")"
legacy_sources="$(psql_database "$database" \
  "SELECT jsonb_array_length(source_refs) FROM memory_claims WHERE id = '60000000-0000-4000-8000-000000000003';")"
review_trigger="$(psql_database "$database" \
  "SELECT COUNT(*) FROM pg_trigger WHERE tgname = 'memory_claim_reviews_immutable' AND NOT tgisinternal;")"
handoff_trigger="$(psql_database "$database" \
  "SELECT COUNT(*) FROM pg_trigger WHERE tgname = 'handoff_confirmations_immutable' AND NOT tgisinternal;")"
episode_table="$(psql_database "$database" \
  "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'agent_episodes';")"

if [[ "$version" != "16" ||
      "$legacy_version" != "1" ||
      "$legacy_sources" != "0" ||
      "$review_trigger" != "1" ||
      "$handoff_trigger" != "1" ||
      "$episode_table" != "1" ]]; then
  printf 'v15 to v16 memory closure smoke failed: version=%s legacy_version=%s legacy_sources=%s review_trigger=%s handoff_trigger=%s episode_table=%s\n' \
    "$version" "$legacy_version" "$legacy_sources" "$review_trigger" \
    "$handoff_trigger" "$episode_table" >&2
  exit 1
fi

printf 'memory_closure_postgres_smoke=ok\n'
printf 'database=%s\n' "$database"
printf 'migration_version=%s\n' "$version"
printf 'legacy_claim_version=%s\n' "$legacy_version"
printf 'legacy_source_refs=%s\n' "$legacy_sources"
printf 'review_trigger=%s\n' "$review_trigger"
printf 'handoff_trigger=%s\n' "$handoff_trigger"
printf 'episode_table=%s\n' "$episode_table"
