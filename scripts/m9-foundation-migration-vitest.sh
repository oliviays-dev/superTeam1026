#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COMPOSE_PROJECT="${M9_MIGRATION_COMPOSE_PROJECT:-pluginmax-m9-migration}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.core-regression.yml}"
PORT="${M9_MIGRATION_POSTGRES_PORT:-54459}"
export CORE_REGRESSION_POSTGRES_PORT="$PORT"
DATABASE_URL_INPUT="${DATABASE_URL:-postgres://pluginmax:pluginmax@127.0.0.1:${PORT}/pluginmax}"
STAMP="$(date -u +%Y%m%d%H%M%S)"
EMPTY_DATABASE="pluginmax_m9_empty_${STAMP}"
UPGRADE_DATABASE="pluginmax_m9_upgrade_${STAMP}"
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
  if [[ "${M9_MIGRATION_KEEP_ENV:-0}" != "1" ]]; then
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

DATABASE_URL="$EMPTY_URL" MIGRATION_TARGET_VERSION=45 \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null
FRESH_VERSION="$(psql_database "$EMPTY_DATABASE" \
  "SELECT MAX(version) FROM platform_migrations;")"
FRESH_COLUMNS="$(psql_database "$EMPTY_DATABASE" \
  "SELECT COUNT(*) FROM information_schema.columns
   WHERE (table_name = 'tasks' AND column_name = 'parent_task_id')
      OR (table_name = 'skill_versions' AND column_name = 'instructions_hash')
      OR (table_name = 'teammate_template_skill_bindings'
          AND column_name IN ('mode', 'scenes'))
      OR (table_name = 'teammate_instance_skill_extensions'
          AND column_name IN ('mode', 'scenes'));")"
FRESH_TRIGGERS="$(psql_database "$EMPTY_DATABASE" \
  "SELECT COUNT(*) FROM pg_trigger
   WHERE NOT tgisinternal
     AND tgname IN (
       'tasks_hierarchy_guard',
       'teammates_template_version_matches',
       'teammate_template_versions_immutable'
     );")"
FRESH_NULLABILITY="$(psql_database "$EMPTY_DATABASE" \
  "SELECT COUNT(*) FROM information_schema.columns
   WHERE (
     (table_name = 'teammate_templates'
      AND column_name IN ('project_id', 'workspace_id'))
     OR
     (table_name = 'teammate_template_versions'
      AND column_name = 'project_id')
   )
   AND is_nullable = 'YES';")"

[[ "$FRESH_VERSION" == "45" ]]
[[ "$FRESH_COLUMNS" == "6" ]]
[[ "$FRESH_TRIGGERS" == "3" ]]
[[ "$FRESH_NULLABILITY" == "3" ]]

DATABASE_URL="$UPGRADE_URL" MIGRATION_TARGET_VERSION=44 \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null
psql_database "$UPGRADE_DATABASE" "
INSERT INTO principals (
  id, kind, display_name, status, status_authority, source,
  version, created_at, updated_at
) VALUES (
  'local-admin', 'human', 'Local Admin', 'active', 'system', 'local',
  1, NOW(), NOW()
);
INSERT INTO projects (
  id, name, code, description, status, created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000009000',
  'M9 migration snapshot',
  'M9-MIG-45',
  '',
  'active',
  NOW(),
  NOW()
);
INSERT INTO tasks (
  id, project_id, title, description, acceptance, status, agent_id,
  created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000009001',
  '00000000-0000-4000-8000-000000009000',
  'M9 snapshot task',
  'preserve before migration 45',
  '[]'::jsonb,
  'queued',
  '00000000-0000-4000-8000-000000000001',
  NOW(),
  NOW()
);
INSERT INTO teammate_templates (
  id, project_id, workspace_id, scope, owner_principal_id, status,
  current_version, definition, created_by, created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000009010',
  '00000000-0000-4000-8000-000000009000',
  '00000000-0000-4000-8000-000000009000',
  'platform',
  NULL,
  'active',
  1,
  '{\"name\":\"M9 Platform Template\",\"role\":\"\",\"description\":\"\",\"soul\":\"\",\"scenarios\":[],\"goals\":[],\"tools\":[]}'::jsonb,
  'local-admin',
  NOW(),
  NOW()
);
INSERT INTO teammate_template_versions (
  id, template_id, project_id, version, definition, content_digest,
  created_by, created_at
) VALUES (
  '00000000-0000-4000-8000-000000009011',
  '00000000-0000-4000-8000-000000009010',
  '00000000-0000-4000-8000-000000009000',
  1,
  '{\"name\":\"M9 Platform Template\",\"role\":\"\",\"description\":\"\",\"soul\":\"\",\"scenarios\":[],\"goals\":[],\"tools\":[]}'::jsonb,
  repeat('b', 64),
  'local-admin',
  NOW()
);
INSERT INTO skill_definitions (
  id, key, name, description, status, current_version,
  created_by_principal_id, created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000009020',
  'm9-migration-skill',
  'M9 migration Skill',
  '',
  'active',
  1,
  'local-admin',
  NOW(),
  NOW()
);
INSERT INTO skill_versions (
  id, skill_id, version, digest, publisher_principal_id, trust_level,
  instructions, manifest, permissions, triggers, status, protected,
  created_at
) VALUES (
  '00000000-0000-4000-8000-000000009021',
  '00000000-0000-4000-8000-000000009020',
  1,
  repeat('c', 64),
  'local-admin',
  'official',
  'Historical Skill instructions',
  '{}'::jsonb,
  '[]'::jsonb,
  '[]'::jsonb,
  'published',
  FALSE,
  NOW()
);
INSERT INTO skill_installations (
  id, principal_id, skill_id, version_id, status, revision,
  installed_by_principal_id, installed_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000009022',
  'local-admin',
  '00000000-0000-4000-8000-000000009020',
  '00000000-0000-4000-8000-000000009021',
  'active',
  1,
  'local-admin',
  NOW(),
  NOW()
);
INSERT INTO teammate_template_skill_bindings (
  id, template_id, skill_id, skill_version_id, installation_id,
  required, enabled, bound_by_principal_id, created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000009023',
  '00000000-0000-4000-8000-000000009010',
  '00000000-0000-4000-8000-000000009020',
  '00000000-0000-4000-8000-000000009021',
  '00000000-0000-4000-8000-000000009022',
  TRUE,
  TRUE,
  'local-admin',
  NOW(),
  NOW()
);"

DATABASE_URL="$UPGRADE_URL" MIGRATION_TARGET_VERSION=45 \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null

UPGRADE_VERSION="$(psql_database "$UPGRADE_DATABASE" \
  "SELECT MAX(version) FROM platform_migrations;")"
LEGACY_READ="$(psql_database "$UPGRADE_DATABASE" \
  "SELECT task.title || '|' || (task.parent_task_id IS NULL)::text
   FROM tasks AS task
   WHERE task.id = '00000000-0000-4000-8000-000000009001';")"
TEMPLATE_SCOPE="$(psql_database "$UPGRADE_DATABASE" \
  "SELECT
     (template.project_id IS NULL) || '|' ||
     (template.workspace_id IS NULL) || '|' ||
     (version.project_id IS NULL)
   FROM teammate_templates AS template
   JOIN teammate_template_versions AS version
     ON version.template_id = template.id
   WHERE template.id = '00000000-0000-4000-8000-000000009010';")"
SKILL_METADATA="$(psql_database "$UPGRADE_DATABASE" \
  "SELECT binding.mode || '|' || binding.scenes::text || '|' ||
          (version.instructions_hash IS NULL)
   FROM teammate_template_skill_bindings AS binding
   JOIN skill_versions AS version
     ON version.id = binding.skill_version_id
   WHERE binding.id = '00000000-0000-4000-8000-000000009023';")"

psql_database "$UPGRADE_DATABASE" "
INSERT INTO tasks (
  id, project_id, parent_task_id, title, description, acceptance, status,
  agent_id, created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000009030',
  '00000000-0000-4000-8000-000000009000',
  NULL,
  'M9 hierarchy parent',
  'parent',
  '[]'::jsonb,
  'queued',
  '00000000-0000-4000-8000-000000000001',
  NOW(),
  NOW()
), (
  '00000000-0000-4000-8000-000000009031',
  '00000000-0000-4000-8000-000000009000',
  '00000000-0000-4000-8000-000000009030',
  'M9 hierarchy child',
  'child',
  '[]'::jsonb,
  'queued',
  '00000000-0000-4000-8000-000000000001',
  NOW(),
  NOW()
);" >/dev/null

set +e
psql_database "$UPGRADE_DATABASE" "
INSERT INTO tasks (
  id, project_id, parent_task_id, title, description, acceptance, status,
  agent_id, created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000009032',
  '00000000-0000-4000-8000-000000009000',
  '00000000-0000-4000-8000-000000009031',
  'M9 hierarchy grandchild',
  'must fail',
  '[]'::jsonb,
  'queued',
  '00000000-0000-4000-8000-000000000001',
  NOW(),
  NOW()
);" >/dev/null 2>&1
GRANDCHILD_STATUS=$?
set -e

[[ "$UPGRADE_VERSION" == "45" ]]
[[ "$LEGACY_READ" == "M9 snapshot task|t" ]]
[[ "$TEMPLATE_SCOPE" == "t|t|t" ]]
[[ "$SKILL_METADATA" == 'required|["task-execution"]|t' ]]
[[ "$GRANDCHILD_STATUS" != "0" ]]

printf 'm9_migration_vitest=ok\n'
printf 'fresh_migration=0->45\n'
printf 'upgrade_migration=44->45\n'
printf 'legacy_read=%s\n' "$LEGACY_READ"
printf 'template_scope=%s\n' "$TEMPLATE_SCOPE"
printf 'skill_metadata=%s\n' "$SKILL_METADATA"
printf 'grandchild_insert=rejected\n'
