export const DEFAULT_AGENT_ID = "00000000-0000-4000-8000-000000000001";
export const DSH_AGENT_ID = "00000000-0000-4000-8000-000000000002";

export const INITIAL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  runtime_kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  acceptance JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'in_progress', 'review', 'done', 'cancelled')),
  agent_id UUID NOT NULL REFERENCES agents(id),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id),
  task_id UUID NOT NULL REFERENCES tasks(id),
  agent_id UUID NOT NULL REFERENCES agents(id),
  status TEXT NOT NULL
    CHECK (status IN (
      'queued',
      'running',
      'waiting_approval',
      'completed',
      'failed',
      'cancelled',
      'timeout',
      'interrupted'
    )),
  context_pack_id UUID,
  input_snapshot JSONB NOT NULL,
  output TEXT,
  error TEXT,
  observability JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS run_events (
  id UUID PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq BIGINT NOT NULL,
  type TEXT NOT NULL,
  visibility TEXT NOT NULL,
  summary TEXT NOT NULL,
  data JSONB,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (run_id, seq)
);

CREATE INDEX IF NOT EXISTS run_events_run_seq_idx
  ON run_events(run_id, seq);

CREATE TABLE IF NOT EXISTS run_deltas (
  run_id UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq BIGINT NOT NULL,
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY,
  run_id UUID NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL,
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS jobs_claim_idx
  ON jobs(status, available_at, lease_expires_at);

CREATE TABLE IF NOT EXISTS domain_outbox (
  id UUID PRIMARY KEY,
  topic TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL,
  published_at TIMESTAMPTZ
);

INSERT INTO agents (
  id,
  name,
  description,
  runtime_kind,
  status,
  created_at,
  updated_at
) VALUES (
  '${DEFAULT_AGENT_ID}',
  'Fake Research Agent',
  'Deterministic local agent used to validate the platform execution loop.',
  'fake',
  'active',
  NOW(),
  NOW()
)
ON CONFLICT (id) DO NOTHING;
`;

export const CONTEXT_SCHEMA_SQL = `
ALTER TABLE runs
  ADD COLUMN IF NOT EXISTS context_pack_id UUID;

CREATE TABLE IF NOT EXISTS context_packs (
  id UUID PRIMARY KEY,
  run_id UUID NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id),
  task_id UUID NOT NULL REFERENCES tasks(id),
  agent_id UUID NOT NULL REFERENCES agents(id),
  pack JSONB NOT NULL,
  receipt JSONB NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

INSERT INTO agents (
  id,
  name,
  description,
  runtime_kind,
  status,
  created_at,
  updated_at
) VALUES (
  '${DSH_AGENT_ID}',
  'DSH SDK Agent',
  'Executes tasks through a pinned DeepSeek Harness SDK runtime.',
  'dsh-sdk',
  'active',
  NOW(),
  NOW()
)
ON CONFLICT (id) DO NOTHING;
`;

export const COLLABORATION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS artifacts (
  id UUID PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size BIGINT NOT NULL,
  sha256 TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS artifacts_run_idx ON artifacts(run_id);

CREATE TABLE IF NOT EXISTS task_reviews (
  id UUID PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  decision TEXT NOT NULL CHECK (decision IN ('approve', 'return')),
  note TEXT NOT NULL DEFAULT '',
  actor_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_topics (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_truths (
  id UUID PRIMARY KEY,
  topic_id UUID NOT NULL REFERENCES memory_topics(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id),
  content TEXT NOT NULL,
  version INTEGER NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS memory_truth_topic_idx
  ON memory_truths(topic_id, version DESC);

CREATE TABLE IF NOT EXISTS workflow_definitions (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  steps JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_instances (
  id UUID PRIMARY KEY,
  workflow_id UUID NOT NULL REFERENCES workflow_definitions(id),
  project_id UUID NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'completed')),
  current_step INTEGER NOT NULL DEFAULT 0,
  steps JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS meetings (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  agenda TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
  participants JSONB NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS meeting_messages (
  id UUID PRIMARY KEY,
  meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  author_type TEXT NOT NULL CHECK (author_type IN ('human', 'agent')),
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS meeting_messages_meeting_idx
  ON meeting_messages(meeting_id, created_at);
`;

export const AGENT_MANAGEMENT_SCHEMA_SQL = `
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS soul TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS scenarios JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS goals JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS tools JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'personal',
  ADD COLUMN IF NOT EXISTS owner_id TEXT NOT NULL DEFAULT 'local-admin',
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS agent_events (
  id UUID PRIMARY KEY,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  seq BIGINT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('created', 'updated', 'status')),
  message TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (agent_id, seq)
);

CREATE INDEX IF NOT EXISTS agent_events_agent_seq_idx
  ON agent_events(agent_id, seq);

INSERT INTO agent_events (
  id, agent_id, seq, kind, message, actor_id, created_at
)
SELECT
  gen_random_uuid(),
  id,
  1,
  'created',
  'Agent 由平台初始化',
  'system',
  created_at
FROM agents
WHERE NOT EXISTS (
  SELECT 1 FROM agent_events WHERE agent_events.agent_id = agents.id
);
`;

export const TASK_COLLABORATION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS task_messages (
  id UUID PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_type TEXT NOT NULL CHECK (author_type IN ('human', 'agent', 'system')),
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  content TEXT NOT NULL,
  reply_to_id UUID REFERENCES task_messages(id),
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS task_messages_task_idx
  ON task_messages(task_id, created_at);
`;

export const PROJECT_MEMBERSHIP_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS project_roles (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (project_id, name)
);

CREATE TABLE IF NOT EXISTS project_members (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('human', 'agent')),
  actor_id TEXT NOT NULL,
  name TEXT NOT NULL,
  responsibility TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive')),
  is_owner BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (project_id, kind, actor_id)
);

CREATE TABLE IF NOT EXISTS project_member_roles (
  project_member_id UUID NOT NULL
    REFERENCES project_members(id) ON DELETE CASCADE,
  role_id UUID NOT NULL
    REFERENCES project_roles(id) ON DELETE CASCADE,
  PRIMARY KEY (project_member_id, role_id)
);

CREATE INDEX IF NOT EXISTS project_members_project_idx
  ON project_members(project_id, status);

CREATE INDEX IF NOT EXISTS project_member_roles_role_idx
  ON project_member_roles(role_id);

INSERT INTO project_roles (
  id, project_id, name, description, created_at, updated_at
)
SELECT
  gen_random_uuid(),
  project.id,
  '项目负责人',
  '负责项目目标、范围、成员和最终验收。',
  NOW(),
  NOW()
FROM projects AS project
ON CONFLICT (project_id, name) DO NOTHING;

INSERT INTO project_members (
  id, project_id, kind, actor_id, name, responsibility,
  status, is_owner, created_at, updated_at
)
SELECT
  gen_random_uuid(),
  project.id,
  'human',
  'local-admin',
  'Local Admin',
  '负责项目目标、范围、成员和最终验收。',
  'active',
  TRUE,
  NOW(),
  NOW()
FROM projects AS project
ON CONFLICT (project_id, kind, actor_id) DO NOTHING;

INSERT INTO project_member_roles (project_member_id, role_id)
SELECT member.id, role.id
FROM project_members AS member
JOIN project_roles AS role
  ON role.project_id = member.project_id
 AND role.name = '项目负责人'
WHERE member.kind = 'human'
  AND member.actor_id = 'local-admin'
ON CONFLICT DO NOTHING;
`;

export const TASK_DEPENDENCY_MEMORY_SCHEMA_SQL = `
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS role_id UUID REFERENCES project_roles(id)
    ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (task_id, depends_on_task_id),
  CHECK (task_id <> depends_on_task_id)
);

CREATE INDEX IF NOT EXISTS task_dependencies_prerequisite_idx
  ON task_dependencies(depends_on_task_id);

CREATE TABLE IF NOT EXISTS memory_claims (
  id UUID PRIMARY KEY,
  topic_id UUID NOT NULL REFERENCES memory_topics(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed', 'confirmed', 'rejected')),
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS memory_claims_topic_idx
  ON memory_claims(topic_id, created_at);

CREATE TABLE IF NOT EXISTS memory_truth_claims (
  truth_id UUID NOT NULL REFERENCES memory_truths(id) ON DELETE CASCADE,
  claim_id UUID NOT NULL REFERENCES memory_claims(id) ON DELETE CASCADE,
  PRIMARY KEY (truth_id, claim_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS memory_truth_topic_version_idx
  ON memory_truths(topic_id, version);
`;

export const TASK_COLLABORATION_ASSET_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS task_events (
  id UUID PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN (
    'created',
    'updated',
    'status',
    'message',
    'review',
    'dependency',
    'attachment',
    'dispatch'
  )),
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  summary TEXT NOT NULL,
  data JSONB,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS task_events_task_idx
  ON task_events(task_id, created_at, id);

CREATE TABLE IF NOT EXISTS task_attachments (
  id UUID PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size BIGINT NOT NULL,
  sha256 TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  uploaded_by TEXT NOT NULL,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS task_attachments_task_idx
  ON task_attachments(task_id, created_at DESC);
`;

export const WORKFLOW_MARKDOWN_SCHEMA_SQL = `
ALTER TABLE workflow_definitions
  ADD COLUMN IF NOT EXISTS source_md TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS graph JSONB;
`;

export const WORKFLOW_RUNTIME_SCHEMA_SQL = `
ALTER TABLE workflow_instances
  DROP CONSTRAINT IF EXISTS workflow_instances_status_check;

ALTER TABLE workflow_instances
  ADD CONSTRAINT workflow_instances_status_check
  CHECK (status IN (
    'active',
    'waiting',
    'blocked',
    'paused',
    'completed',
    'failed',
    'cancelled'
  ));

ALTER TABLE workflow_instances
  ADD COLUMN IF NOT EXISTS definition_key TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS definition_version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS parent_instance_id UUID
    REFERENCES workflow_instances(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS parent_node_id TEXT,
  ADD COLUMN IF NOT EXISTS runtime_context JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS runtime_nodes JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS runtime_edges JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS failure_reason TEXT,
  ADD COLUMN IF NOT EXISTS paused_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS start_idempotency_key TEXT;

UPDATE workflow_instances AS instance
SET
  definition_key = COALESCE(
    NULLIF(instance.definition_key, ''),
    definition.graph->>'key',
    definition.name
  ),
  definition_version = COALESCE(
    NULLIF(definition.graph->>'version', '')::integer,
    instance.definition_version,
    1
  )
FROM workflow_definitions AS definition
WHERE definition.id = instance.workflow_id
  AND (
    instance.definition_key = ''
    OR instance.definition_version = 1
  );

CREATE UNIQUE INDEX IF NOT EXISTS workflow_instance_start_idempotency_idx
  ON workflow_instances(workflow_id, start_idempotency_key)
  WHERE start_idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS workflow_instances_project_idx
  ON workflow_instances(project_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS workflow_instances_parent_idx
  ON workflow_instances(parent_instance_id)
  WHERE parent_instance_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS workflow_approvals (
  id UUID PRIMARY KEY,
  instance_id UUID NOT NULL
    REFERENCES workflow_instances(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  round INTEGER NOT NULL DEFAULT 1,
  approver_id TEXT NOT NULL,
  approver_role_id UUID REFERENCES project_roles(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'transferred')),
  note TEXT NOT NULL DEFAULT '',
  acted_by TEXT,
  acted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (instance_id, node_id, round, approver_id)
);

CREATE INDEX IF NOT EXISTS workflow_approvals_instance_idx
  ON workflow_approvals(instance_id, node_id, created_at);

CREATE TABLE IF NOT EXISTS workflow_audit_events (
  id UUID PRIMARY KEY,
  instance_id UUID NOT NULL
    REFERENCES workflow_instances(id) ON DELETE CASCADE,
  node_id TEXT,
  seq BIGINT NOT NULL,
  kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  data JSONB,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (instance_id, seq)
);

CREATE INDEX IF NOT EXISTS workflow_audit_instance_idx
  ON workflow_audit_events(instance_id, seq);

CREATE TABLE IF NOT EXISTS workflow_command_receipts (
  id UUID PRIMARY KEY,
  instance_id UUID NOT NULL
    REFERENCES workflow_instances(id) ON DELETE CASCADE,
  command_key TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (instance_id, command_key, idempotency_key)
);

ALTER TABLE runs
  ADD COLUMN IF NOT EXISTS attempt INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS timeout_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS workflow_instance_id UUID
    REFERENCES workflow_instances(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS workflow_node_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS runs_workflow_attempt_idx
  ON runs(workflow_instance_id, workflow_node_id, attempt)
  WHERE workflow_instance_id IS NOT NULL
    AND workflow_node_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS runs_idempotency_idx
  ON runs(idempotency_key)
  WHERE idempotency_key IS NOT NULL;
`;

export const WORKFLOW_GOVERNANCE_SCHEMA_SQL = `
ALTER TABLE workflow_instances
  ADD COLUMN IF NOT EXISTS last_reconciled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sweep_lease_owner TEXT,
  ADD COLUMN IF NOT EXISTS sweep_lease_expires_at TIMESTAMPTZ;

UPDATE workflow_instances
SET last_reconciled_at = updated_at
WHERE last_reconciled_at IS NULL;

CREATE INDEX IF NOT EXISTS workflow_instances_sweep_idx
  ON workflow_instances(
    status,
    sweep_lease_expires_at,
    last_reconciled_at,
    updated_at
  )
  WHERE status NOT IN ('completed', 'failed', 'cancelled', 'paused');

ALTER TABLE workflow_approvals
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'primary'
    CHECK (kind IN ('primary', 'cosign')),
  ADD COLUMN IF NOT EXISTS delegated_from TEXT,
  ADD COLUMN IF NOT EXISTS transferred_to TEXT,
  ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS workflow_approvals_pending_actor_idx
  ON workflow_approvals(approver_id, status, instance_id);

ALTER TABLE workflow_command_receipts
  ADD COLUMN IF NOT EXISTS request_hash TEXT NOT NULL DEFAULT 'legacy-v10',
  ADD COLUMN IF NOT EXISTS response_status INTEGER,
  ADD COLUMN IF NOT EXISTS response_body JSONB,
  ADD COLUMN IF NOT EXISTS state TEXT NOT NULL DEFAULT 'completed',
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

DELETE FROM workflow_command_receipts AS duplicate
USING workflow_command_receipts AS keeper
WHERE duplicate.instance_id = keeper.instance_id
  AND duplicate.idempotency_key = keeper.idempotency_key
  AND duplicate.created_at > keeper.created_at;

CREATE UNIQUE INDEX IF NOT EXISTS workflow_command_idempotency_idx
  ON workflow_command_receipts(instance_id, idempotency_key);

CREATE TABLE IF NOT EXISTS workflow_idempotency_keys (
  id UUID PRIMARY KEY,
  scope TEXT NOT NULL,
  operation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'completed', 'failed')),
  response_status INTEGER,
  response_body JSONB,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  UNIQUE (scope, idempotency_key)
);

CREATE INDEX IF NOT EXISTS workflow_idempotency_pending_idx
  ON workflow_idempotency_keys(state, updated_at)
  WHERE state = 'pending';

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS jobs_expired_lease_idx
  ON jobs(lease_expires_at)
  WHERE status = 'running';

CREATE INDEX IF NOT EXISTS workflow_audit_project_idx
  ON workflow_audit_events(instance_id, kind, created_at DESC);

CREATE INDEX IF NOT EXISTS workflow_audit_actor_idx
  ON workflow_audit_events(actor_id, created_at DESC);
`;

export const RUNTIME_RELIABILITY_SCHEMA_SQL = `
ALTER TABLE jobs
  DROP CONSTRAINT IF EXISTS jobs_status_check;

ALTER TABLE jobs
  ADD CONSTRAINT jobs_status_check
  CHECK (status IN (
    'queued',
    'running',
    'completed',
    'failed',
    'cancelled',
    'dead_letter'
  ));

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS max_attempts INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS lease_token UUID,
  ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS dead_letter_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS recovery_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS manual_recovery_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE jobs
  DROP CONSTRAINT IF EXISTS jobs_max_attempts_check;

ALTER TABLE jobs
  ADD CONSTRAINT jobs_max_attempts_check
  CHECK (max_attempts BETWEEN 1 AND 100);

UPDATE jobs
SET max_attempts = GREATEST(attempts, 3)
WHERE max_attempts < attempts;

CREATE INDEX IF NOT EXISTS jobs_available_claim_idx
  ON jobs(status, available_at, created_at)
  WHERE status = 'queued';

CREATE INDEX IF NOT EXISTS jobs_dead_letter_idx
  ON jobs(dead_letter_at DESC)
  WHERE status = 'dead_letter';

CREATE TABLE IF NOT EXISTS job_attempts (
  id UUID PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL,
  worker_id TEXT NOT NULL,
  lease_token UUID NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN (
      'running',
      'completed',
      'failed',
      'dead_letter',
      'interrupted'
    )),
  error TEXT,
  started_at TIMESTAMPTZ NOT NULL,
  heartbeat_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  UNIQUE (job_id, attempt)
);

CREATE INDEX IF NOT EXISTS job_attempts_job_idx
  ON job_attempts(job_id, attempt DESC);

CREATE INDEX IF NOT EXISTS job_attempts_worker_idx
  ON job_attempts(worker_id, started_at DESC);

CREATE TABLE IF NOT EXISTS runtime_workers (
  id TEXT PRIMARY KEY,
  hostname TEXT NOT NULL,
  pid INTEGER NOT NULL,
  concurrency INTEGER NOT NULL CHECK (concurrency BETWEEN 1 AND 128),
  status TEXT NOT NULL
    CHECK (status IN ('starting', 'running', 'draining', 'stopped')),
  started_at TIMESTAMPTZ NOT NULL,
  heartbeat_at TIMESTAMPTZ NOT NULL,
  stopping_at TIMESTAMPTZ,
  stopped_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS runtime_workers_heartbeat_idx
  ON runtime_workers(heartbeat_at DESC);

ALTER TABLE workflow_approvals
  DROP CONSTRAINT IF EXISTS workflow_approvals_status_check;

ALTER TABLE workflow_approvals
  ADD CONSTRAINT workflow_approvals_status_check
  CHECK (status IN (
    'pending',
    'approved',
    'rejected',
    'transferred',
    'expired'
  ));

ALTER TABLE workflow_approvals
  DROP CONSTRAINT IF EXISTS workflow_approvals_kind_check;

ALTER TABLE workflow_approvals
  ADD CONSTRAINT workflow_approvals_kind_check
  CHECK (kind IN ('primary', 'cosign', 'escalation'));

ALTER TABLE workflow_approvals
  ADD COLUMN IF NOT EXISTS due_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS remind_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reminded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS escalate_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS escalated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS escalation_role_id UUID
    REFERENCES project_roles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS expired_at TIMESTAMPTZ;

UPDATE workflow_approvals
SET
  due_at = created_at + INTERVAL '1 hour',
  remind_at = created_at + INTERVAL '30 minutes',
  expires_at = created_at + INTERVAL '2 hours'
WHERE status = 'pending'
  AND due_at IS NULL;

CREATE INDEX IF NOT EXISTS workflow_approvals_sla_idx
  ON workflow_approvals(status, remind_at, escalate_at, expires_at)
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS workflow_idempotency_archive (
  id UUID PRIMARY KEY,
  original_id UUID NOT NULL,
  scope TEXT NOT NULL,
  operation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  state TEXT NOT NULL,
  response_status INTEGER,
  response_body JSONB,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  archived_at TIMESTAMPTZ NOT NULL,
  archive_reason TEXT NOT NULL,
  UNIQUE (original_id)
);

CREATE INDEX IF NOT EXISTS workflow_idempotency_archive_scope_idx
  ON workflow_idempotency_archive(scope, archived_at DESC);

CREATE TABLE IF NOT EXISTS runtime_maintenance_runs (
  id UUID PRIMARY KEY,
  kind TEXT NOT NULL
    CHECK (kind IN ('idempotency_cleanup', 'approval_sla', 'lease_recovery')),
  status TEXT NOT NULL CHECK (status IN ('completed', 'failed')),
  processed_count INTEGER NOT NULL DEFAULT 0,
  archived_count INTEGER NOT NULL DEFAULT 0,
  deleted_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS runtime_maintenance_kind_idx
  ON runtime_maintenance_runs(kind, completed_at DESC);
`;

export const RUNTIME_MAINTENANCE_EFFECTS_SCHEMA_SQL = `
ALTER TABLE runtime_maintenance_runs
  ADD COLUMN IF NOT EXISTS trigger_source TEXT NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS scheduled_for TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS duration_ms INTEGER;

ALTER TABLE runtime_maintenance_runs
  DROP CONSTRAINT IF EXISTS runtime_maintenance_trigger_check;

ALTER TABLE runtime_maintenance_runs
  DROP CONSTRAINT IF EXISTS runtime_maintenance_runs_kind_check;

ALTER TABLE runtime_maintenance_runs
  ADD CONSTRAINT runtime_maintenance_runs_kind_check
  CHECK (kind IN (
    'idempotency_cleanup',
    'approval_sla',
    'lease_recovery',
    'effect_recovery'
  ));

ALTER TABLE runtime_maintenance_runs
  ADD CONSTRAINT runtime_maintenance_trigger_check
  CHECK (trigger_source IN ('scheduler', 'manual', 'api', 'legacy'));

ALTER TABLE job_attempts
  ADD COLUMN IF NOT EXISTS lease_renew_interval_ms INTEGER,
  ADD COLUMN IF NOT EXISTS lease_jitter_ms DOUBLE PRECISION;

CREATE TABLE IF NOT EXISTS runtime_maintenance_schedules (
  kind TEXT PRIMARY KEY
    CHECK (kind IN (
      'idempotency_cleanup',
      'approval_sla',
      'lease_recovery',
      'effect_recovery'
    )),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  interval_seconds INTEGER NOT NULL
    CHECK (interval_seconds BETWEEN 5 AND 604800),
  next_run_at TIMESTAMPTZ NOT NULL,
  lease_owner TEXT,
  lease_token UUID,
  lease_expires_at TIMESTAMPTZ,
  last_started_at TIMESTAMPTZ,
  last_completed_at TIMESTAMPTZ,
  last_status TEXT
    CHECK (last_status IN ('running', 'completed', 'failed')),
  last_error TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0
    CHECK (consecutive_failures >= 0),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

INSERT INTO runtime_maintenance_schedules (
  kind, enabled, interval_seconds, next_run_at,
  consecutive_failures, created_at, updated_at
) VALUES
  ('lease_recovery', TRUE, 5, NOW(), 0, NOW(), NOW()),
  ('approval_sla', TRUE, 60, NOW(), 0, NOW(), NOW()),
  ('idempotency_cleanup', TRUE, 3600, NOW(), 0, NOW(), NOW()),
  ('effect_recovery', TRUE, 5, NOW(), 0, NOW(), NOW())
ON CONFLICT (kind) DO NOTHING;

CREATE INDEX IF NOT EXISTS runtime_maintenance_due_idx
  ON runtime_maintenance_schedules(enabled, next_run_at)
  WHERE enabled = TRUE;

CREATE TABLE IF NOT EXISTS runtime_effect_receipts (
  id UUID PRIMARY KEY,
  effect_key TEXT NOT NULL UNIQUE,
  run_id UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  job_id UUID REFERENCES jobs(id) ON DELETE SET NULL,
  operation TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  lease_owner TEXT,
  lease_token UUID,
  lease_expires_at TIMESTAMPTZ,
  replay_count INTEGER NOT NULL DEFAULT 0 CHECK (replay_count >= 0),
  result JSONB,
  error TEXT,
  cancel_requested_at TIMESTAMPTZ,
  cancel_acknowledged_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (run_id, operation)
);

CREATE INDEX IF NOT EXISTS runtime_effect_status_idx
  ON runtime_effect_receipts(status, lease_expires_at);

CREATE INDEX IF NOT EXISTS runtime_effect_cancel_idx
  ON runtime_effect_receipts(cancel_requested_at)
  WHERE cancel_requested_at IS NOT NULL
    AND status = 'running';
`;

export const PRODUCTION_READINESS_SCHEMA_SQL = `
ALTER TABLE runs
  ADD COLUMN IF NOT EXISTS trace_id TEXT,
  ADD COLUMN IF NOT EXISTS trace_root_span_id TEXT;

ALTER TABLE run_events
  ADD COLUMN IF NOT EXISTS trace_id TEXT,
  ADD COLUMN IF NOT EXISTS span_id TEXT,
  ADD COLUMN IF NOT EXISTS parent_span_id TEXT;

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS trace_id TEXT;

ALTER TABLE job_attempts
  ADD COLUMN IF NOT EXISTS trace_id TEXT,
  ADD COLUMN IF NOT EXISTS span_id TEXT;

ALTER TABLE runtime_effect_receipts
  ADD COLUMN IF NOT EXISTS trace_id TEXT;

ALTER TABLE runtime_maintenance_runs
  ADD COLUMN IF NOT EXISTS trace_id TEXT,
  ADD COLUMN IF NOT EXISTS span_id TEXT;

UPDATE runs
SET
  trace_id = md5(id::text),
  trace_root_span_id = substring(md5('root-span:' || id::text), 1, 16)
WHERE trace_id IS NULL;

UPDATE jobs AS job
SET trace_id = run.trace_id
FROM runs AS run
WHERE job.run_id = run.id
  AND job.trace_id IS NULL;

UPDATE run_events AS event
SET
  trace_id = run.trace_id,
  span_id = substring(md5('event-span:' || event.id::text), 1, 16),
  parent_span_id = run.trace_root_span_id
FROM runs AS run
WHERE event.run_id = run.id
  AND event.trace_id IS NULL;

UPDATE job_attempts AS attempt
SET
  trace_id = job.trace_id,
  span_id = substring(md5('attempt-span:' || attempt.id::text), 1, 16)
FROM jobs AS job
WHERE attempt.job_id = job.id
  AND attempt.trace_id IS NULL;

UPDATE runtime_effect_receipts AS effect
SET trace_id = run.trace_id
FROM runs AS run
WHERE effect.run_id = run.id
  AND effect.trace_id IS NULL;

UPDATE runtime_maintenance_runs
SET
  trace_id = md5(id::text),
  span_id = substring(md5('maintenance-span:' || id::text), 1, 16)
WHERE trace_id IS NULL;

ALTER TABLE runs
  DROP CONSTRAINT IF EXISTS runs_trace_id_check,
  DROP CONSTRAINT IF EXISTS runs_trace_root_span_id_check,
  ADD CONSTRAINT runs_trace_id_check
    CHECK (trace_id ~ '^[0-9a-f]{32}$'),
  ADD CONSTRAINT runs_trace_root_span_id_check
    CHECK (trace_root_span_id ~ '^[0-9a-f]{16}$');

ALTER TABLE run_events
  DROP CONSTRAINT IF EXISTS run_events_trace_id_check,
  DROP CONSTRAINT IF EXISTS run_events_span_id_check,
  DROP CONSTRAINT IF EXISTS run_events_parent_span_id_check,
  ADD CONSTRAINT run_events_trace_id_check
    CHECK (trace_id ~ '^[0-9a-f]{32}$'),
  ADD CONSTRAINT run_events_span_id_check
    CHECK (span_id ~ '^[0-9a-f]{16}$'),
  ADD CONSTRAINT run_events_parent_span_id_check
    CHECK (parent_span_id ~ '^[0-9a-f]{16}$');

ALTER TABLE jobs
  DROP CONSTRAINT IF EXISTS jobs_trace_id_check,
  ADD CONSTRAINT jobs_trace_id_check
    CHECK (trace_id ~ '^[0-9a-f]{32}$');

ALTER TABLE job_attempts
  DROP CONSTRAINT IF EXISTS job_attempts_trace_id_check,
  DROP CONSTRAINT IF EXISTS job_attempts_span_id_check,
  ADD CONSTRAINT job_attempts_trace_id_check
    CHECK (trace_id ~ '^[0-9a-f]{32}$'),
  ADD CONSTRAINT job_attempts_span_id_check
    CHECK (span_id ~ '^[0-9a-f]{16}$');

ALTER TABLE runtime_effect_receipts
  DROP CONSTRAINT IF EXISTS runtime_effect_receipts_trace_id_check,
  ADD CONSTRAINT runtime_effect_receipts_trace_id_check
    CHECK (trace_id ~ '^[0-9a-f]{32}$');

ALTER TABLE runtime_maintenance_runs
  DROP CONSTRAINT IF EXISTS runtime_maintenance_runs_trace_id_check,
  DROP CONSTRAINT IF EXISTS runtime_maintenance_runs_span_id_check,
  ADD CONSTRAINT runtime_maintenance_runs_trace_id_check
    CHECK (trace_id ~ '^[0-9a-f]{32}$'),
  ADD CONSTRAINT runtime_maintenance_runs_span_id_check
    CHECK (span_id ~ '^[0-9a-f]{16}$');

CREATE INDEX IF NOT EXISTS runs_trace_idx
  ON runs(trace_id);

CREATE INDEX IF NOT EXISTS run_events_trace_idx
  ON run_events(trace_id, created_at);

CREATE INDEX IF NOT EXISTS jobs_trace_idx
  ON jobs(trace_id);

CREATE INDEX IF NOT EXISTS job_attempts_trace_idx
  ON job_attempts(trace_id);

CREATE INDEX IF NOT EXISTS runtime_effect_trace_idx
  ON runtime_effect_receipts(trace_id);

CREATE INDEX IF NOT EXISTS runtime_maintenance_trace_idx
  ON runtime_maintenance_runs(trace_id);

ALTER TABLE task_events
  DROP CONSTRAINT IF EXISTS task_events_kind_check;

ALTER TABLE task_events
  ADD CONSTRAINT task_events_kind_check
  CHECK (kind IN (
    'created',
    'updated',
    'status',
    'message',
    'review',
    'dependency',
    'attachment',
    'dispatch',
    'transfer'
  ));
`;

export const MEETING_DECISIONS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meeting_minutes_drafts (
  id UUID PRIMARY KEY,
  meeting_id UUID NOT NULL UNIQUE REFERENCES meetings(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  content TEXT NOT NULL DEFAULT '',
  decisions JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_message_ids UUID[] NOT NULL DEFAULT '{}'::uuid[],
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS meeting_minutes_versions (
  id UUID PRIMARY KEY,
  meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  content TEXT NOT NULL,
  decisions JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_message_ids UUID[] NOT NULL DEFAULT '{}'::uuid[],
  published_by TEXT NOT NULL,
  published_at TIMESTAMPTZ NOT NULL,
  UNIQUE (meeting_id, version)
);

CREATE INDEX IF NOT EXISTS meeting_minutes_versions_meeting_idx
  ON meeting_minutes_versions(meeting_id, version DESC);

CREATE OR REPLACE FUNCTION pluginmax_reject_minutes_version_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'meeting minutes versions are immutable';
END;
$$;

DROP TRIGGER IF EXISTS meeting_minutes_versions_immutable
  ON meeting_minutes_versions;

CREATE TRIGGER meeting_minutes_versions_immutable
BEFORE UPDATE ON meeting_minutes_versions
FOR EACH ROW
EXECUTE FUNCTION pluginmax_reject_minutes_version_update();

CREATE TABLE IF NOT EXISTS meeting_action_items (
  id UUID PRIMARY KEY,
  meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('human', 'agent')),
  owner_actor_id TEXT NOT NULL,
  owner_name TEXT NOT NULL,
  due_at TIMESTAMPTZ,
  priority TEXT NOT NULL DEFAULT 'medium'
    CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  source_type TEXT NOT NULL
    CHECK (source_type IN ('manual', 'message', 'minutes_version')),
  source_id TEXT NOT NULL,
  source_version_id UUID
    REFERENCES meeting_minutes_versions(id) ON DELETE SET NULL,
  source_message_ids UUID[] NOT NULL DEFAULT '{}'::uuid[],
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'in_progress', 'done', 'cancelled')),
  dedupe_key TEXT NOT NULL,
  task_id UUID UNIQUE REFERENCES tasks(id) ON DELETE SET NULL,
  converted_by TEXT,
  converted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS meeting_action_items_dedupe_idx
  ON meeting_action_items(meeting_id, lower(dedupe_key));

CREATE INDEX IF NOT EXISTS meeting_action_items_meeting_idx
  ON meeting_action_items(meeting_id, status, created_at);

CREATE INDEX IF NOT EXISTS meeting_action_items_task_idx
  ON meeting_action_items(task_id)
  WHERE task_id IS NOT NULL;

INSERT INTO meeting_minutes_drafts (
  id, meeting_id, project_id, content, decisions, source_message_ids,
  revision, updated_by, created_at, updated_at
)
SELECT
  gen_random_uuid(),
  meeting.id,
  meeting.project_id,
  meeting.summary,
  '[]'::jsonb,
  '{}'::uuid[],
  CASE WHEN meeting.summary = '' THEN 0 ELSE 1 END,
  'local-admin',
  meeting.created_at,
  meeting.updated_at
FROM meetings AS meeting
ON CONFLICT (meeting_id) DO NOTHING;

INSERT INTO meeting_minutes_versions (
  id, meeting_id, project_id, version, content, decisions,
  source_message_ids, published_by, published_at
)
SELECT
  gen_random_uuid(),
  meeting.id,
  meeting.project_id,
  1,
  meeting.summary,
  '[]'::jsonb,
  '{}'::uuid[],
  'local-admin',
  meeting.updated_at
FROM meetings AS meeting
WHERE meeting.summary <> ''
  AND NOT EXISTS (
    SELECT 1
    FROM meeting_minutes_versions AS version
    WHERE version.meeting_id = meeting.id
  );
`;

export const MEMORY_CLOSURE_SCHEMA_SQL = `
ALTER TABLE memory_topics
  ADD COLUMN IF NOT EXISTS origin_type TEXT,
  ADD COLUMN IF NOT EXISTS origin_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS memory_topics_origin_idx
  ON memory_topics(project_id, origin_type, origin_id)
  WHERE origin_type IS NOT NULL AND origin_id IS NOT NULL;

ALTER TABLE memory_claims
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS dedupe_key TEXT,
  ADD COLUMN IF NOT EXISTS source_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS reviewed_by TEXT,
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS memory_claims_dedupe_idx
  ON memory_claims(project_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS memory_claims_project_status_idx
  ON memory_claims(project_id, status, created_at);

CREATE TABLE IF NOT EXISTS memory_claim_reviews (
  id UUID PRIMARY KEY,
  claim_id UUID NOT NULL REFERENCES memory_claims(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  decision TEXT NOT NULL CHECK (decision IN ('accept', 'reject')),
  reason TEXT NOT NULL DEFAULT '',
  actor_id TEXT NOT NULL,
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  claim_version INTEGER NOT NULL CHECK (claim_version > 0),
  source_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS memory_claim_reviews_claim_idx
  ON memory_claim_reviews(claim_id, created_at DESC);

CREATE OR REPLACE FUNCTION pluginmax_reject_memory_review_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'memory review records are immutable';
END;
$$;

DROP TRIGGER IF EXISTS memory_claim_reviews_immutable
  ON memory_claim_reviews;

CREATE TRIGGER memory_claim_reviews_immutable
BEFORE UPDATE OR DELETE ON memory_claim_reviews
FOR EACH ROW
EXECUTE FUNCTION pluginmax_reject_memory_review_mutation();

CREATE TABLE IF NOT EXISTS handoff_cards (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'confirmed')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  source_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by TEXT NOT NULL,
  confirmed_by TEXT,
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS handoff_cards_project_idx
  ON handoff_cards(project_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS handoff_confirmations (
  id UUID PRIMARY KEY,
  handoff_id UUID NOT NULL REFERENCES handoff_cards(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  actor_id TEXT NOT NULL,
  snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (handoff_id, version)
);

CREATE OR REPLACE FUNCTION pluginmax_reject_handoff_confirmation_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'handoff confirmations are immutable';
END;
$$;

DROP TRIGGER IF EXISTS handoff_confirmations_immutable
  ON handoff_confirmations;

CREATE TRIGGER handoff_confirmations_immutable
BEFORE UPDATE OR DELETE ON handoff_confirmations
FOR EACH ROW
EXECUTE FUNCTION pluginmax_reject_handoff_confirmation_mutation();

CREATE OR REPLACE FUNCTION pluginmax_reject_confirmed_handoff_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'confirmed' THEN
    RAISE EXCEPTION 'confirmed handoff cards are immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS handoff_cards_confirmed_immutable
  ON handoff_cards;

CREATE TRIGGER handoff_cards_confirmed_immutable
BEFORE UPDATE ON handoff_cards
FOR EACH ROW
EXECUTE FUNCTION pluginmax_reject_confirmed_handoff_update();

CREATE TABLE IF NOT EXISTS agent_episodes (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  visibility TEXT NOT NULL CHECK (visibility IN ('private', 'project')),
  kind TEXT NOT NULL
    CHECK (kind IN ('observation', 'decision', 'reflection', 'handoff')),
  summary TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  source_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS agent_episodes_scope_idx
  ON agent_episodes(project_id, agent_id, visibility, created_at DESC);
`;
