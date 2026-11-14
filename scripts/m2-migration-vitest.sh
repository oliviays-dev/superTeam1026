#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COMPOSE_PROJECT="${M2_MIGRATION_COMPOSE_PROJECT:-pluginmax-m2-migration}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.core-regression.yml}"
PORT="${M2_MIGRATION_POSTGRES_PORT:-54444}"
export CORE_REGRESSION_POSTGRES_PORT="$PORT"
DATABASE_URL_INPUT="${DATABASE_URL:-postgres://pluginmax:pluginmax@127.0.0.1:${PORT}/pluginmax}"
STAMP="$(date -u +%Y%m%d%H%M%S)"
EMPTY_DATABASE="pluginmax_m2_empty_${STAMP}"
UPGRADE_DATABASE="pluginmax_m2_upgrade_${STAMP}"
EMPTY_URL="${DATABASE_URL_INPUT%/*}/${EMPTY_DATABASE}"
UPGRADE_URL="${DATABASE_URL_INPUT%/*}/${UPGRADE_DATABASE}"

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
    "DROP DATABASE IF EXISTS $EMPTY_DATABASE WITH (FORCE);" \
    >/dev/null 2>&1 || true
  psql_database postgres \
    "DROP DATABASE IF EXISTS $UPGRADE_DATABASE WITH (FORCE);" \
    >/dev/null 2>&1 || true
  if [[ "${M2_MIGRATION_KEEP_ENV:-0}" != "1" ]]; then
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
psql_database postgres "CREATE DATABASE $EMPTY_DATABASE;"
psql_database postgres "CREATE DATABASE $UPGRADE_DATABASE;"

DATABASE_URL="$EMPTY_URL" \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null
FRESH_VERSION="$(psql_database "$EMPTY_DATABASE" \
  "SELECT MAX(version) FROM platform_migrations;")"
FRESH_TABLES="$(psql_database "$EMPTY_DATABASE" \
  "SELECT COUNT(*) FROM pg_class
   WHERE relname IN (
     'workflow_instance_assignments',
     'workflow_instance_approvers',
     'project_role_mapping_presets'
   ) AND relkind = 'r';")"
FRESH_FLAGS="$(psql_database "$EMPTY_DATABASE" \
  "SELECT flag_key || '=' || mode
   FROM feature_flag_settings
   WHERE flag_key IN (
     'workflow.assignment_bindings',
     'workflow.platform_templates'
   )
   ORDER BY flag_key;")"

[[ "$FRESH_VERSION" == "40" ]]
[[ "$FRESH_TABLES" == "3" ]]
[[ "$FRESH_FLAGS" == $'workflow.assignment_bindings=off\nworkflow.platform_templates=off' ]]

DATABASE_URL="$UPGRADE_URL" MIGRATION_TARGET_VERSION=37 \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null
psql_database "$UPGRADE_DATABASE" "
INSERT INTO projects (
  id, name, code, description, status, created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000003800',
  'M2 migration snapshot',
  'M2-MIG-38',
  '',
  'active',
  NOW(),
  NOW()
);
INSERT INTO project_roles (
  id, project_id, code, name, category, description, permissions,
  created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000003801',
  '00000000-0000-4000-8000-000000003800',
  'MIGRATION_ROLE',
  'Migration role',
  'execution',
  '',
  '[\"read\",\"write\"]'::jsonb,
  NOW(),
  NOW()
);
INSERT INTO workflow_definitions (
  id, project_id, name, description, steps, source_md, graph, status,
  created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000003802',
  '00000000-0000-4000-8000-000000003800',
  'Legacy workflow',
  'Legacy snapshot compatibility',
  '[]'::jsonb,
  '',
  '{\"key\":\"legacy-m2\",\"version\":1,\"name\":\"Legacy\",\"description\":\"Legacy snapshot\",\"nodes\":[],\"edges\":[],\"startNodeIds\":[],\"warnings\":[]}'::jsonb,
  'active',
  NOW(),
  NOW()
);
INSERT INTO workflow_instances (
  id, workflow_id, project_id, title, status, current_step, steps,
  created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000003803',
  '00000000-0000-4000-8000-000000003802',
  '00000000-0000-4000-8000-000000003800',
  'Legacy instance',
  'active',
  0,
  '[]'::jsonb,
  NOW(),
  NOW()
);"

DATABASE_URL="$UPGRADE_URL" \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null

UPGRADE_VERSION="$(psql_database "$UPGRADE_DATABASE" \
  "SELECT MAX(version) FROM platform_migrations;")"
SNAPSHOT="$(psql_database "$UPGRADE_DATABASE" \
  "SELECT definition_snapshot->>'description'
   FROM workflow_instances
   WHERE id = '00000000-0000-4000-8000-000000003803';")"
LEGACY_READ="$(psql_database "$UPGRADE_DATABASE" \
  "SELECT definition.scope || '|' || definition.origin || '|' ||
          (instance.binding_revision IS NULL)::text
   FROM workflow_instances AS instance
   JOIN workflow_definitions AS definition
     ON definition.id = instance.workflow_id
   WHERE instance.id = '00000000-0000-4000-8000-000000003803';")"
[[ "$UPGRADE_VERSION" == "40" ]]
[[ "$SNAPSHOT" == "Legacy snapshot" ]]
[[ "$LEGACY_READ" == "project|template|t" ]]

psql_database "$UPGRADE_DATABASE" "
DO \$\$
BEGIN
  BEGIN
    INSERT INTO workflow_instance_assignments (
      id, instance_id, node_id, source_kind, source_id, dispatch_mode,
      status, primary_principal_id, candidate_pool, resolved_by,
      resolved_at, source_change_reason, revision, created_at, updated_at
    ) VALUES (
      '00000000-0000-4000-8000-000000003804',
      '00000000-0000-4000-8000-000000003803',
      'execute',
      'role',
      'MIGRATION_ROLE',
      'assigned',
      'resolved',
      NULL,
      '[]'::jsonb,
      'migration-test',
      NOW(),
      '',
      1,
      NOW(),
      NOW()
    );
    RAISE EXCEPTION 'assigned assignment without primary unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END;
\$\$;"

psql_database "$UPGRADE_DATABASE" "
INSERT INTO workflow_instance_assignments (
  id, instance_id, node_id, source_kind, source_id, dispatch_mode,
  status, primary_principal_id, candidate_pool, resolved_by,
  resolved_at, source_change_reason, revision, created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000003805',
  '00000000-0000-4000-8000-000000003803',
  'execute',
  'role',
  'MIGRATION_ROLE',
  'assigned',
  'resolved',
  'principal-migration',
  '[]'::jsonb,
  'migration-test',
  NOW(),
  '',
  1,
  NOW(),
  NOW()
);" >/dev/null

psql_database "$UPGRADE_DATABASE" "
DO \$\$
BEGIN
  BEGIN
    INSERT INTO workflow_instance_assignments (
      id, instance_id, node_id, source_kind, source_id, dispatch_mode,
      status, primary_principal_id, candidate_pool, resolved_by,
      resolved_at, source_change_reason, revision, created_at, updated_at
    ) VALUES (
      '00000000-0000-4000-8000-000000003806',
      '00000000-0000-4000-8000-000000003803',
      'execute',
      'role',
      'MIGRATION_ROLE',
      'assigned',
      'resolved',
      'principal-migration',
      '[]'::jsonb,
      'migration-test',
      NOW(),
      '',
      1,
      NOW(),
      NOW()
    );
    RAISE EXCEPTION 'duplicate assignment unexpectedly succeeded';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;
END;
\$\$;"

psql_database "$UPGRADE_DATABASE" "
INSERT INTO project_role_mapping_presets (
  project_id, role_id, assignees, revision, updated_by_principal_id, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000003800',
  '00000000-0000-4000-8000-000000003801',
  '[\"principal-migration\"]'::jsonb,
  1,
  'migration-test',
  NOW()
);
DELETE FROM project_roles
WHERE id = '00000000-0000-4000-8000-000000003801';" >/dev/null
PRESET_COUNT="$(psql_database "$UPGRADE_DATABASE" \
  "SELECT COUNT(*) FROM project_role_mapping_presets
   WHERE role_id = '00000000-0000-4000-8000-000000003801';")"
[[ "$PRESET_COUNT" == "0" ]]

printf 'fresh_migration=0->%s\n' "$FRESH_VERSION"
printf 'fresh_m2_tables=%s\n' "$FRESH_TABLES"
printf 'fresh_flags=%s\n' "$(printf '%s' "$FRESH_FLAGS" | tr '\n' ',')"
printf 'upgrade_migration=37->%s\n' "$UPGRADE_VERSION"
printf 'definition_snapshot=%s\n' "$SNAPSHOT"
printf 'legacy_app_read=%s\n' "$LEGACY_READ"
printf 'assignment_constraints=assigned_primary+instance_node_unique\n'
printf 'role_preset_cascade=%s\n' "$PRESET_COUNT"
