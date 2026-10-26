#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-pluginmax-batch13}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.batch13.yml}"
DATABASE_URL_INPUT="${DATABASE_URL:-postgres://pluginmax:pluginmax@127.0.0.1:54422/pluginmax}"
STAMP="$(date -u +%Y%m%d%H%M%S)"
CREATED_DATABASES=()

compose() {
  "$ROOT/scripts/db-compose.sh" -p "$COMPOSE_PROJECT" -f "$ROOT/$COMPOSE_FILE" "$@"
}

psql_database() {
  local database="$1"
  local sql="$2"
  compose exec -T postgres psql -U pluginmax -d "$database" \
    -qAt -v ON_ERROR_STOP=1 -c "$sql"
}

migrate_database() {
  local database="$1"
  local target_version="$2"
  local database_url="${DATABASE_URL_INPUT%/*}/$database"
  DATABASE_URL="$database_url" MIGRATION_TARGET_VERSION="$target_version" CI=true \
    pnpm --filter @pluginmax/database exec tsx src/migrate-cli.ts >/dev/null
}

create_database() {
  local database="$1"
  psql_database postgres "CREATE DATABASE $database;" >/dev/null
  CREATED_DATABASES+=("$database")
}

cleanup() {
  local database
  for database in "${CREATED_DATABASES[@]:-}"; do
    psql_database postgres \
      "DROP DATABASE IF EXISTS $database WITH (FORCE);" \
      >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT

assert_json() {
  local payload="$1"
  local expression="$2"
  local label="$3"
  if ! printf '%s' "$payload" | jq -e "$expression" >/dev/null; then
    printf '%s failed: %s\n' "$label" "$payload" >&2
    exit 1
  fi
}

compose up -d postgres >/dev/null
for _ in {1..60}; do
  if compose exec -T postgres pg_isready \
    -U pluginmax -d pluginmax >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

fresh_database="pluginmax_batch13_fresh_$STAMP"
create_database "$fresh_database"
migrate_database "$fresh_database" 23
fresh_state="$(psql_database "$fresh_database" "
  SELECT json_build_object(
    'version', (SELECT MAX(version) FROM platform_migrations),
    'migrationCount', (SELECT COUNT(*) FROM platform_migrations),
    'externalTables', (
      SELECT COUNT(*)
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN (
          'external_runtimes',
          'external_runtime_probes',
          'external_runtime_capabilities',
          'external_runtime_events',
          'runtime_probe_jobs',
          'agent_runtime_bindings'
        )
    ),
    'executionColumn', (
      SELECT COUNT(*)
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'runs'
        AND column_name = 'execution_snapshot'
    ),
    'defaultAgents', (
      SELECT COUNT(*)
      FROM agents
      WHERE id IN (
        '00000000-0000-4000-8000-000000000001',
        '00000000-0000-4000-8000-000000000002'
      )
    ),
    'importedRuntimes', (SELECT COUNT(*) FROM external_runtimes)
  )::text;
")"
assert_json "$fresh_state" \
  '.version == 23 and .migrationCount == 23 and .externalTables == 6 and
   .executionColumn == 1 and .defaultAgents == 2 and .importedRuntimes == 0' \
  'fresh 0 to 23 migration'

legacy_database="pluginmax_batch13_legacy_$STAMP"
create_database "$legacy_database"
migrate_database "$legacy_database" 20
psql_database "$legacy_database" "
  INSERT INTO projects (
    id, name, code, description, status, created_at, updated_at
  ) VALUES (
    '13000000-0000-4000-8000-000000000001',
    'Batch 13 legacy project',
    'B13-LEGACY',
    'Legacy fixture for migration 20 to 23',
    'active',
    NOW(),
    NOW()
  );

  INSERT INTO agents (
    id, name, description, runtime_kind, status, created_at, updated_at
  ) VALUES (
    '13000000-0000-4000-8000-000000000002',
    'Batch 13 legacy agent',
    'Legacy Agent data',
    'dsh-sdk',
    'disabled',
    NOW(),
    NOW()
  );

  INSERT INTO tasks (
    id, project_id, title, description, acceptance, status, agent_id,
    created_at, updated_at
  ) VALUES (
    '13000000-0000-4000-8000-000000000003',
    '13000000-0000-4000-8000-000000000001',
    'Legacy task',
    'Legacy Task data',
    '[\"legacy acceptance\"]'::jsonb,
    'review',
    '13000000-0000-4000-8000-000000000002',
    NOW(),
    NOW()
  );

  INSERT INTO runs (
    id, project_id, task_id, agent_id, status, context_pack_id,
    input_snapshot, output, error, observability, created_at, started_at,
    ended_at, updated_at, trace_id, trace_root_span_id
  ) VALUES (
    '13000000-0000-4000-8000-000000000004',
    '13000000-0000-4000-8000-000000000001',
    '13000000-0000-4000-8000-000000000003',
    '13000000-0000-4000-8000-000000000002',
    'completed',
    '13000000-0000-4000-8000-000000000005',
    '{\"instruction\":\"Legacy Run data\"}'::jsonb,
    'legacy-output-preserved',
    NULL,
    '{}'::jsonb,
    NOW(),
    NOW(),
    NOW(),
    NOW(),
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'bbbbbbbbbbbbbbbb'
  );

  INSERT INTO run_events (
    id, run_id, seq, type, visibility, summary, data, created_at,
    trace_id, span_id, parent_span_id
  ) VALUES (
    '13000000-0000-4000-8000-000000000006',
    '13000000-0000-4000-8000-000000000004',
    1,
    'legacy.completed',
    'project',
    'Legacy Trace data',
    '{}'::jsonb,
    NOW(),
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'cccccccccccccccc',
    'bbbbbbbbbbbbbbbb'
  );

  INSERT INTO jobs (
    id, run_id, kind, status, attempts, available_at, created_at,
    updated_at, trace_id
  ) VALUES (
    '13000000-0000-4000-8000-000000000007',
    '13000000-0000-4000-8000-000000000004',
    'agent.execute',
    'completed',
    1,
    NOW(),
    NOW(),
    NOW(),
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  );

  INSERT INTO job_attempts (
    id, job_id, attempt, worker_id, lease_token, status, started_at,
    heartbeat_at, ended_at, trace_id, span_id
  ) VALUES (
    '13000000-0000-4000-8000-000000000008',
    '13000000-0000-4000-8000-000000000007',
    1,
    'legacy-worker',
    '13000000-0000-4000-8000-000000000012',
    'completed',
    NOW(),
    NOW(),
    NOW(),
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'dddddddddddddddd'
  );

  INSERT INTO context_packs (
    id, run_id, project_id, task_id, agent_id, pack, receipt,
    content_hash, created_at
  ) VALUES (
    '13000000-0000-4000-8000-000000000005',
    '13000000-0000-4000-8000-000000000004',
    '13000000-0000-4000-8000-000000000001',
    '13000000-0000-4000-8000-000000000003',
    '13000000-0000-4000-8000-000000000002',
    '{\"sources\":[\"legacy-context\"]}'::jsonb,
    '{}'::jsonb,
    'legacy-context-hash',
    NOW()
  );

  INSERT INTO meetings (
    id, project_id, title, agenda, status, participants, summary,
    created_at, updated_at
  ) VALUES (
    '13000000-0000-4000-8000-000000000009',
    '13000000-0000-4000-8000-000000000001',
    'Legacy meeting',
    'Legacy Meeting data',
    'closed',
    '[{\"kind\":\"agent\",\"id\":\"13000000-0000-4000-8000-000000000002\"}]'::jsonb,
    'Legacy meeting summary',
    NOW(),
    NOW()
  );

  INSERT INTO meeting_messages (
    id, meeting_id, author_type, author_id, author_name, content, created_at
  ) VALUES (
    '13000000-0000-4000-8000-00000000000a',
    '13000000-0000-4000-8000-000000000009',
    'agent',
    '13000000-0000-4000-8000-000000000002',
    'Legacy agent',
    'Legacy meeting message',
    NOW()
  );

  INSERT INTO direct_chat_threads (
    id, owner_id, agent_id, created_at, updated_at
  ) VALUES (
    '13000000-0000-4000-8000-00000000000b',
    'local-admin',
    '13000000-0000-4000-8000-000000000002',
    NOW(),
    NOW()
  );

  INSERT INTO direct_chat_messages (
    id, thread_id, sequence, sender_type, sender_id, sender_name, content,
    created_at
  ) VALUES (
    '13000000-0000-4000-8000-00000000000c',
    '13000000-0000-4000-8000-00000000000b',
    1,
    'owner',
    'local-admin',
    'Local Admin',
    'Legacy direct chat message',
    NOW()
  );

  INSERT INTO memory_topics (id, project_id, title, created_at, updated_at)
  VALUES (
    '13000000-0000-4000-8000-00000000000d',
    '13000000-0000-4000-8000-000000000001',
    'Legacy memory topic',
    NOW(),
    NOW()
  );

  INSERT INTO memory_truths (
    id, topic_id, project_id, content, version, source_type, source_id,
    created_at
  ) VALUES (
    '13000000-0000-4000-8000-00000000000e',
    '13000000-0000-4000-8000-00000000000d',
    '13000000-0000-4000-8000-000000000001',
    'Legacy memory truth',
    1,
    'manual',
    'legacy-fixture',
    NOW()
  );

  INSERT INTO memory_claims (
    id, topic_id, project_id, content, status, source_type, source_id,
    created_at, updated_at
  ) VALUES (
    '13000000-0000-4000-8000-00000000000f',
    '13000000-0000-4000-8000-00000000000d',
    '13000000-0000-4000-8000-000000000001',
    'Legacy memory claim',
    'confirmed',
    'manual',
    'legacy-fixture',
    NOW(),
    NOW()
  );

  INSERT INTO memory_truth_claims (truth_id, claim_id)
  VALUES (
    '13000000-0000-4000-8000-00000000000e',
    '13000000-0000-4000-8000-00000000000f'
  );

  INSERT INTO template_roles (
    id, code, name, category, description, permissions, status, revision,
    created_at, updated_at
  ) VALUES (
    '13000000-0000-4000-8000-000000000010',
    'LEGACY_ROLE',
    'Legacy template role',
    'execution',
    'Legacy Template data',
    '[\"read\"]'::jsonb,
    'active',
    1,
    NOW(),
    NOW()
  );

  INSERT INTO project_templates (
    id, name, code, type, description, status, revision, created_by,
    updated_by, created_at, updated_at
  ) VALUES (
    '13000000-0000-4000-8000-000000000011',
    'Legacy project template',
    'LEGACY_TEMPLATE',
    'project',
    'Legacy Template data',
    'active',
    1,
    'local-admin',
    'local-admin',
    NOW(),
    NOW()
  );

  INSERT INTO project_template_revisions (
    template_id, revision, snapshot, change_summary, status, actor_id,
    created_at
  ) VALUES (
    '13000000-0000-4000-8000-000000000011',
    1,
    '{\"name\":\"Legacy project template\"}'::jsonb,
    'Legacy revision',
    'active',
    'local-admin',
    NOW()
  );

  UPDATE projects
  SET
    source_template_id = '13000000-0000-4000-8000-000000000011',
    source_template_revision = 1
  WHERE id = '13000000-0000-4000-8000-000000000001';
" >/dev/null
migrate_database "$legacy_database" 23
legacy_state="$(psql_database "$legacy_database" "
  SELECT json_build_object(
    'version', (SELECT MAX(version) FROM platform_migrations),
    'agent', (
      SELECT COUNT(*) FROM agents
      WHERE id = '13000000-0000-4000-8000-000000000002'
        AND status = 'disabled'
    ),
    'taskStatus', (
      SELECT status FROM tasks
      WHERE id = '13000000-0000-4000-8000-000000000003'
    ),
    'runStatus', (
      SELECT status FROM runs
      WHERE id = '13000000-0000-4000-8000-000000000004'
    ),
    'runOutput', (
      SELECT output FROM runs
      WHERE id = '13000000-0000-4000-8000-000000000004'
    ),
    'runExecutionIsNull', (
      SELECT execution_snapshot IS NULL FROM runs
      WHERE id = '13000000-0000-4000-8000-000000000004'
    ),
    'runTrace', (
      SELECT trace_id FROM runs
      WHERE id = '13000000-0000-4000-8000-000000000004'
    ),
    'runEventTrace', (
      SELECT trace_id FROM run_events
      WHERE id = '13000000-0000-4000-8000-000000000006'
    ),
    'contextHash', (
      SELECT content_hash FROM context_packs
      WHERE id = '13000000-0000-4000-8000-000000000005'
    ),
    'meeting', (
      SELECT COUNT(*) FROM meetings
      WHERE id = '13000000-0000-4000-8000-000000000009'
        AND summary = 'Legacy meeting summary'
    ),
    'meetingMessage', (
      SELECT COUNT(*) FROM meeting_messages
      WHERE id = '13000000-0000-4000-8000-00000000000a'
        AND content = 'Legacy meeting message'
    ),
    'directChat', (
      SELECT COUNT(*) FROM direct_chat_messages
      WHERE id = '13000000-0000-4000-8000-00000000000c'
        AND content = 'Legacy direct chat message'
    ),
    'memoryTruth', (
      SELECT COUNT(*) FROM memory_truths
      WHERE id = '13000000-0000-4000-8000-00000000000e'
        AND content = 'Legacy memory truth'
    ),
    'template', (
      SELECT COUNT(*)
      FROM project_templates AS template
      JOIN project_template_revisions AS revision
        ON revision.template_id = template.id
      WHERE template.id = '13000000-0000-4000-8000-000000000011'
        AND template.code = 'LEGACY_TEMPLATE'
        AND revision.revision = 1
    ),
    'projectTemplateSource', (
      SELECT source_template_id FROM projects
      WHERE id = '13000000-0000-4000-8000-000000000001'
    )
  )::text;
")"
assert_json "$legacy_state" \
  '.version == 23 and .agent == 1 and .taskStatus == "review" and
   .runStatus == "completed" and .runOutput == "legacy-output-preserved" and
   .runExecutionIsNull == true and
   .runTrace == "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" and
   .runEventTrace == "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" and
   .contextHash == "legacy-context-hash" and .meeting == 1 and
   .meetingMessage == 1 and .directChat == 1 and .memoryTruth == 1 and
   .template == 1 and
   .projectTemplateSource == "13000000-0000-4000-8000-000000000011"' \
  'migration 20 to 23 legacy data'

runtime_database="pluginmax_batch13_runtime_$STAMP"
create_database "$runtime_database"
migrate_database "$runtime_database" 22
psql_database "$runtime_database" "
  INSERT INTO projects (
    id, name, code, description, status, created_at, updated_at
  ) VALUES (
    '13200000-0000-4000-8000-000000000001',
    'Batch 13 runtime project',
    'B13-RUNTIME',
    'Runtime fixture for migration 22 to 23',
    'active',
    NOW(),
    NOW()
  );

  INSERT INTO agents (
    id, name, description, runtime_kind, status, created_at, updated_at
  ) VALUES (
    '13200000-0000-4000-8000-000000000002',
    'Batch 13 runtime agent',
    'Runtime Agent data',
    'codex-jsonl',
    'active',
    NOW(),
    NOW()
  );

  INSERT INTO tasks (
    id, project_id, title, description, acceptance, status, agent_id,
    created_at, updated_at
  ) VALUES (
    '13200000-0000-4000-8000-000000000003',
    '13200000-0000-4000-8000-000000000001',
    'Migration 22 runtime task',
    'Existing Run before migration 23',
    '[]'::jsonb,
    'review',
    '13200000-0000-4000-8000-000000000002',
    NOW(),
    NOW()
  );

  INSERT INTO external_runtimes (
    id, name, provider, protocol, command, managed_args, custom_args,
    supported_models, default_model, supported_tools, network_mode,
    sandbox_mode, status, visibility, owner_id, revision, command_digest,
    args_digest, created_at, updated_at
  ) VALUES (
    '13200000-0000-4000-8000-000000000005',
    'Migration 22 runtime',
    'codex',
    'codex-jsonl',
    'legacy-runtime',
    '[]'::jsonb,
    '[]'::jsonb,
    '[]'::jsonb,
    NULL,
    '[]'::jsonb,
    'restricted',
    'read-only',
    'active',
    'owner',
    'local-admin',
    2,
    repeat('a', 64),
    repeat('b', 64),
    NOW(),
    NOW()
  );

  INSERT INTO agent_runtime_bindings (
    id, agent_id, runtime_id, execution_mode, status, revision, bound_by,
    created_at, updated_at
  ) VALUES (
    '13200000-0000-4000-8000-000000000006',
    '13200000-0000-4000-8000-000000000002',
    '13200000-0000-4000-8000-000000000005',
    'external',
    'active',
    2,
    'local-admin',
    NOW(),
    NOW()
  );

  INSERT INTO runs (
    id, project_id, task_id, agent_id, status, input_snapshot, output,
    error, observability, created_at, started_at, ended_at, updated_at,
    trace_id, trace_root_span_id
  ) VALUES (
    '13200000-0000-4000-8000-000000000004',
    '13200000-0000-4000-8000-000000000001',
    '13200000-0000-4000-8000-000000000003',
    '13200000-0000-4000-8000-000000000002',
    'completed',
    '{\"instruction\":\"Runtime Run before migration 23\"}'::jsonb,
    'migration-22-run-output',
    NULL,
    '{}'::jsonb,
    NOW(),
    NOW(),
    NOW(),
    NOW(),
    'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    'ffffffffffffffff'
  );
" >/dev/null
migrate_database "$runtime_database" 23
runtime_state="$(psql_database "$runtime_database" "
  SELECT json_build_object(
    'version', (SELECT MAX(version) FROM platform_migrations),
    'runtime', (
      SELECT COUNT(*) FROM external_runtimes
      WHERE id = '13200000-0000-4000-8000-000000000005'
        AND revision = 2
    ),
    'binding', (
      SELECT COUNT(*) FROM agent_runtime_bindings
      WHERE id = '13200000-0000-4000-8000-000000000006'
        AND status = 'active'
        AND revision = 2
    ),
    'runOutput', (
      SELECT output FROM runs
      WHERE id = '13200000-0000-4000-8000-000000000004'
    ),
    'runExecutionIsNull', (
      SELECT execution_snapshot IS NULL FROM runs
      WHERE id = '13200000-0000-4000-8000-000000000004'
    ),
    'executionColumn', (
      SELECT COUNT(*)
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'runs'
        AND column_name = 'execution_snapshot'
    )
  )::text;
")"
assert_json "$runtime_state" \
  '.version == 23 and .runtime == 1 and .binding == 1 and
   .runOutput == "migration-22-run-output" and
   .runExecutionIsNull == true and .executionColumn == 1' \
  'migration 22 to 23 runtime data'

printf 'external_runtime_postgres_smoke=ok\n'
printf 'fresh_migration=%s\n' "$fresh_state"
printf 'legacy_migration=%s\n' "$legacy_state"
printf 'runtime_migration=%s\n' "$runtime_state"
