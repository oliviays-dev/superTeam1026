#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-pluginmax-batch11b}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.batch11b.yml}"
DATABASE_URL_INPUT="${DATABASE_URL:-postgres://pluginmax:pluginmax@127.0.0.1:54418/pluginmax}"
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

database="pluginmax_batch11b_migration_$STAMP"
database_url="${DATABASE_URL_INPUT%/*}/$database"
psql_database postgres "CREATE DATABASE $database;"

cleanup() {
  psql_database postgres \
    "DROP DATABASE IF EXISTS $database WITH (FORCE);" \
    >/dev/null 2>&1 || true
}
trap cleanup EXIT

DATABASE_URL="$database_url" MIGRATION_TARGET_VERSION=17 CI=true \
  pnpm --filter @pluginmax/database exec tsx src/migrate-cli.ts >/dev/null

psql_database "$database" "
  INSERT INTO projects (
    id, name, code, description, status, created_at, updated_at
  ) VALUES (
    '72000000-0000-4000-8000-000000000001',
    'Legacy Batch 11B project',
    'B11B-MIG',
    'migration 18 smoke',
    'active',
    NOW(),
    NOW()
  );
  INSERT INTO project_roles (
    id, project_id, name, description, created_at, updated_at
  ) VALUES (
    '72000000-0000-4000-8000-000000000002',
    '72000000-0000-4000-8000-000000000001',
    'Legacy role',
    'must keep a generated code',
    NOW(),
    NOW()
  );
  INSERT INTO tasks (
    id, project_id, title, description, acceptance, status, agent_id,
    created_at, updated_at
  ) VALUES (
    '72000000-0000-4000-8000-000000000003',
    '72000000-0000-4000-8000-000000000001',
    'Legacy task remains readable',
    'Batch 11A data must survive migration 18',
    '[]'::jsonb,
    'queued',
    '00000000-0000-4000-8000-000000000001',
    NOW(),
    NOW()
  );
  INSERT INTO workflow_definitions (
    id, project_id, name, description, steps, status, created_at, updated_at
  ) VALUES (
    '72000000-0000-4000-8000-000000000004',
    '72000000-0000-4000-8000-000000000001',
    'Legacy workflow',
    '',
    '[]'::jsonb,
    'active',
    NOW(),
    NOW()
  );
"

DATABASE_URL="$database_url" MIGRATION_TARGET_VERSION=18 CI=true \
  pnpm --filter @pluginmax/database exec tsx src/migrate-cli.ts >/dev/null

version="$(psql_database "$database" \
  'SELECT MAX(version) FROM platform_migrations;')"
legacy_task="$(psql_database "$database" \
  "SELECT title FROM tasks WHERE id = '72000000-0000-4000-8000-000000000003';")"
legacy_role_code="$(psql_database "$database" \
  "SELECT code FROM project_roles WHERE id = '72000000-0000-4000-8000-000000000002';")"
legacy_project_template="$(psql_database "$database" \
  "SELECT COALESCE(source_template_id::text, '') || ':' || COALESCE(source_template_revision::text, '') FROM projects WHERE id = '72000000-0000-4000-8000-000000000001';")"
legacy_workflow_template="$(psql_database "$database" \
  "SELECT COALESCE(source_template_id::text, '') || ':' || COALESCE(source_template_version::text, '') FROM workflow_definitions WHERE id = '72000000-0000-4000-8000-000000000004';")"
template_tables="$(psql_database "$database" \
  "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('template_roles','workflow_templates','project_templates','project_template_revisions','project_template_role_refs','project_template_workflow_refs','project_template_grants','project_template_materializations');")"
revision_trigger="$(psql_database "$database" \
  "SELECT COUNT(*) FROM pg_trigger WHERE tgname = 'project_template_revisions_immutable' AND NOT tgisinternal;")"
materialization_unique="$(psql_database "$database" \
  "SELECT COUNT(*) FROM pg_indexes WHERE tablename = 'project_template_materializations' AND indexdef LIKE '%template_id, idempotency_key%';")"
role_fk="$(psql_database "$database" \
  "SELECT COUNT(*) FROM information_schema.table_constraints WHERE table_name = 'project_roles' AND constraint_name = 'project_roles_library_role_id_fkey';")"

if [[ "$version" != "18" ||
      "$legacy_task" != "Legacy task remains readable" ||
      -z "$legacy_role_code" ||
      "$legacy_project_template" != ":" ||
      "$legacy_workflow_template" != ":" ||
      "$template_tables" != "8" ||
      "$revision_trigger" != "1" ||
      "$materialization_unique" != "1" ||
      "$role_fk" != "1" ]]; then
  printf 'v17 to v18 project templates smoke failed: version=%s legacy_task=%s legacy_role_code=%s legacy_project_template=%s legacy_workflow_template=%s template_tables=%s revision_trigger=%s materialization_unique=%s role_fk=%s\n' \
    "$version" "$legacy_task" "$legacy_role_code" "$legacy_project_template" \
    "$legacy_workflow_template" "$template_tables" "$revision_trigger" \
    "$materialization_unique" "$role_fk" >&2
  exit 1
fi

printf 'project_templates_postgres_smoke=ok\n'
printf 'database=%s\n' "$database"
printf 'migration_version=%s\n' "$version"
printf 'legacy_task=%s\n' "$legacy_task"
printf 'legacy_role_code=%s\n' "$legacy_role_code"
printf 'template_tables=%s\n' "$template_tables"
printf 'revision_trigger=%s\n' "$revision_trigger"
