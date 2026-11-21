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

export const WORKBENCH_REPORTS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS project_reports (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  report_date DATE NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  content_hash TEXT NOT NULL,
  snapshot JSONB NOT NULL,
  generated_by TEXT NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (project_id, report_date, version),
  UNIQUE (project_id, report_date, content_hash)
);

CREATE INDEX IF NOT EXISTS project_reports_project_idx
  ON project_reports(project_id, report_date DESC, version DESC);

CREATE OR REPLACE FUNCTION pluginmax_reject_project_report_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'project reports are immutable';
END;
$$;

DROP TRIGGER IF EXISTS project_reports_immutable ON project_reports;

CREATE TRIGGER project_reports_immutable
BEFORE UPDATE OR DELETE ON project_reports
FOR EACH ROW
EXECUTE FUNCTION pluginmax_reject_project_report_mutation();

CREATE TABLE IF NOT EXISTS project_report_sources (
  report_id UUID NOT NULL
    REFERENCES project_reports(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT '',
  route TEXT NOT NULL,
  target_id TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (report_id, source_kind, source_id)
);

CREATE INDEX IF NOT EXISTS project_report_sources_project_idx
  ON project_report_sources(project_id, source_kind, source_id);

CREATE TABLE IF NOT EXISTS project_report_reads (
  report_id UUID NOT NULL
    REFERENCES project_reports(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL,
  read_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (report_id, actor_id)
);

CREATE TABLE IF NOT EXISTS workbench_briefs (
  id UUID PRIMARY KEY,
  actor_id TEXT NOT NULL,
  brief_date DATE NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  content_hash TEXT NOT NULL,
  snapshot JSONB NOT NULL,
  generated_by TEXT NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (actor_id, brief_date, version),
  UNIQUE (actor_id, brief_date, content_hash)
);

CREATE INDEX IF NOT EXISTS workbench_briefs_actor_idx
  ON workbench_briefs(actor_id, brief_date DESC, version DESC);

CREATE OR REPLACE FUNCTION pluginmax_reject_workbench_brief_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'workbench briefs are immutable';
END;
$$;

DROP TRIGGER IF EXISTS workbench_briefs_immutable ON workbench_briefs;

CREATE TRIGGER workbench_briefs_immutable
BEFORE UPDATE OR DELETE ON workbench_briefs
FOR EACH ROW
EXECUTE FUNCTION pluginmax_reject_workbench_brief_mutation();

CREATE TABLE IF NOT EXISTS workbench_brief_reads (
  brief_id UUID NOT NULL
    REFERENCES workbench_briefs(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL,
  read_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (brief_id, actor_id)
);

CREATE TABLE IF NOT EXISTS workbench_brief_settings (
  actor_id TEXT PRIMARY KEY,
  frequency TEXT NOT NULL DEFAULT 'daily-0800'
    CHECK (frequency IN (
      'daily-0800',
      'daily-0800-1300',
      'every-4-hours',
      'weekly-monday-0800'
    )),
  silent_start TIME,
  silent_end TIME,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS workbench_follows (
  actor_id TEXT NOT NULL,
  target_type TEXT NOT NULL
    CHECK (target_type IN ('task', 'workflow', 'project', 'meeting')),
  target_id UUID NOT NULL,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (actor_id, target_type, target_id)
);

CREATE INDEX IF NOT EXISTS workbench_follows_project_idx
  ON workbench_follows(project_id, target_type, target_id);

CREATE TABLE IF NOT EXISTS supply_exceptions (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('high', 'medium', 'watch')),
  suggested_action TEXT NOT NULL DEFAULT '',
  owner_actor_id TEXT NOT NULL,
  due_at TIMESTAMPTZ,
  impact_scope TEXT NOT NULL DEFAULT '',
  source_task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  source_workflow_instance_id UUID
    REFERENCES workflow_instances(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'acknowledged', 'resolved')),
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS supply_exceptions_project_idx
  ON supply_exceptions(project_id, status, due_at);

CREATE TABLE IF NOT EXISTS supplier_risks (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  supplier_name TEXT NOT NULL,
  risk_type TEXT NOT NULL,
  risk_score INTEGER NOT NULL CHECK (risk_score BETWEEN 0 AND 100),
  commitment_rate NUMERIC(5, 2)
    CHECK (commitment_rate IS NULL OR commitment_rate BETWEEN 0 AND 100),
  quality_metric TEXT NOT NULL DEFAULT '',
  purchase_share NUMERIC(5, 2)
    CHECK (purchase_share IS NULL OR purchase_share BETWEEN 0 AND 100),
  suggested_action TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'monitoring'
    CHECK (status IN ('open', 'monitoring', 'closed')),
  source_note TEXT NOT NULL DEFAULT '',
  data_updated_at TIMESTAMPTZ NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS supplier_risks_project_idx
  ON supplier_risks(project_id, status, risk_score DESC);
`;

export const PROJECT_TEMPLATES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS template_roles (
  id UUID PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN (
    'management',
    'execution',
    'review',
    'approval',
    'planning',
    'procurement',
    'support'
  )),
  description TEXT NOT NULL DEFAULT '',
  permissions JSONB NOT NULL DEFAULT '["read"]'::jsonb,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS template_roles_status_idx
  ON template_roles(status, category, name);

CREATE TABLE IF NOT EXISTS workflow_templates (
  id UUID PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  definition JSONB NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived')),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS workflow_templates_status_idx
  ON workflow_templates(status, name);

CREATE TABLE IF NOT EXISTS project_templates (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS project_templates_status_idx
  ON project_templates(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS project_template_revisions (
  template_id UUID NOT NULL
    REFERENCES project_templates(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK (revision > 0),
  snapshot JSONB NOT NULL,
  change_summary TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  actor_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (template_id, revision)
);

CREATE OR REPLACE FUNCTION pluginmax_reject_project_template_revision_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'project template revisions are immutable';
END;
$$;

DROP TRIGGER IF EXISTS project_template_revisions_immutable
  ON project_template_revisions;

CREATE TRIGGER project_template_revisions_immutable
BEFORE UPDATE OR DELETE ON project_template_revisions
FOR EACH ROW
EXECUTE FUNCTION pluginmax_reject_project_template_revision_mutation();

CREATE TABLE IF NOT EXISTS project_template_role_refs (
  template_id UUID NOT NULL
    REFERENCES project_templates(id) ON DELETE CASCADE,
  role_id UUID NOT NULL
    REFERENCES template_roles(id) ON DELETE RESTRICT,
  PRIMARY KEY (template_id, role_id)
);

CREATE INDEX IF NOT EXISTS project_template_role_refs_role_idx
  ON project_template_role_refs(role_id, template_id);

CREATE TABLE IF NOT EXISTS project_template_workflow_refs (
  template_id UUID NOT NULL
    REFERENCES project_templates(id) ON DELETE CASCADE,
  workflow_template_id UUID NOT NULL
    REFERENCES workflow_templates(id) ON DELETE RESTRICT,
  workflow_version INTEGER NOT NULL CHECK (workflow_version > 0),
  key_snapshot TEXT NOT NULL,
  name_snapshot TEXT NOT NULL,
  PRIMARY KEY (template_id, workflow_template_id)
);

CREATE INDEX IF NOT EXISTS project_template_workflow_refs_workflow_idx
  ON project_template_workflow_refs(workflow_template_id, template_id);

CREATE TABLE IF NOT EXISTS project_template_grants (
  template_id UUID NOT NULL
    REFERENCES project_templates(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL,
  PRIMARY KEY (template_id, actor_id)
);

CREATE INDEX IF NOT EXISTS project_template_grants_actor_idx
  ON project_template_grants(actor_id, template_id);

CREATE TABLE IF NOT EXISTS project_template_materializations (
  id UUID PRIMARY KEY,
  template_id UUID NOT NULL
    REFERENCES project_templates(id) ON DELETE RESTRICT,
  template_revision INTEGER NOT NULL CHECK (template_revision > 0),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  project_id UUID NOT NULL UNIQUE
    REFERENCES projects(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (template_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS project_template_materializations_template_idx
  ON project_template_materializations(template_id, created_at DESC);

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS source_template_id UUID
    REFERENCES project_templates(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS source_template_revision INTEGER;

CREATE INDEX IF NOT EXISTS projects_source_template_idx
  ON projects(source_template_id, source_template_revision);

ALTER TABLE project_roles
  ADD COLUMN IF NOT EXISTS code TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'execution',
  ADD COLUMN IF NOT EXISTS permissions JSONB NOT NULL DEFAULT '["read"]'::jsonb,
  ADD COLUMN IF NOT EXISTS library_role_id UUID
    REFERENCES template_roles(id) ON DELETE RESTRICT;

UPDATE project_roles
SET code = CASE
  WHEN name = '项目负责人' THEN 'PROJECT_OWNER'
  ELSE 'PROJECT_ROLE_' || UPPER(SUBSTRING(REPLACE(id::text, '-', '') FROM 1 FOR 8))
END
WHERE code = '';

CREATE INDEX IF NOT EXISTS project_roles_library_role_idx
  ON project_roles(library_role_id)
  WHERE library_role_id IS NOT NULL;

ALTER TABLE workflow_definitions
  ADD COLUMN IF NOT EXISTS source_template_id UUID
    REFERENCES workflow_templates(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS source_template_version INTEGER;

CREATE INDEX IF NOT EXISTS workflow_definitions_source_template_idx
  ON workflow_definitions(source_template_id, source_template_version);
`;

export const MEETING_AI_PARTICIPATION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meeting_ai_policies (
  id UUID PRIMARY KEY,
  meeting_id UUID NOT NULL UNIQUE
    REFERENCES meetings(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'paused'
    CHECK (status IN ('active', 'paused', 'terminated')),
  trigger_kinds JSONB NOT NULL DEFAULT '["mention"]'::jsonb,
  cooldown_seconds INTEGER NOT NULL DEFAULT 30
    CHECK (cooldown_seconds BETWEEN 0 AND 3600),
  max_rounds INTEGER NOT NULL DEFAULT 6
    CHECK (max_rounds BETWEEN 1 AND 100),
  max_messages INTEGER NOT NULL DEFAULT 12
    CHECK (max_messages BETWEEN 1 AND 500),
  run_budget_ms INTEGER NOT NULL DEFAULT 60000
    CHECK (run_budget_ms BETWEEN 1000 AND 1800000),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  last_error_code TEXT,
  last_error_message TEXT,
  last_error_at TIMESTAMPTZ,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS meeting_ai_policies_project_idx
  ON meeting_ai_policies(project_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS meeting_ai_participants (
  meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'removed')),
  joined_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (meeting_id, agent_id)
);

CREATE INDEX IF NOT EXISTS meeting_ai_participants_agent_idx
  ON meeting_ai_participants(agent_id, status);

CREATE TABLE IF NOT EXISTS meeting_ai_rounds (
  id UUID PRIMARY KEY,
  meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  round_number INTEGER NOT NULL CHECK (round_number > 0),
  trigger_kind TEXT NOT NULL
    CHECK (trigger_kind IN ('mention', 'round', 'agenda', 'summary')),
  trigger_reason TEXT NOT NULL,
  source_message_id UUID REFERENCES meeting_messages(id) ON DELETE SET NULL,
  agenda_item TEXT,
  dedupe_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (meeting_id, round_number),
  UNIQUE (meeting_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS meeting_ai_rounds_meeting_idx
  ON meeting_ai_rounds(meeting_id, round_number DESC);

CREATE TABLE IF NOT EXISTS meeting_ai_turns (
  id UUID PRIMARY KEY,
  round_id UUID NOT NULL
    REFERENCES meeting_ai_rounds(id) ON DELETE CASCADE,
  meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  policy_id UUID NOT NULL
    REFERENCES meeting_ai_policies(id) ON DELETE RESTRICT,
  policy_revision INTEGER NOT NULL CHECK (policy_revision > 0),
  trigger_kind TEXT NOT NULL
    CHECK (trigger_kind IN ('mention', 'round', 'agenda', 'summary')),
  trigger_reason TEXT NOT NULL,
  source_message_id UUID REFERENCES meeting_messages(id) ON DELETE SET NULL,
  agenda_item TEXT,
  dedupe_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN (
      'queued',
      'running',
      'completed',
      'failed',
      'cancelled',
      'skipped'
    )),
  run_id UUID UNIQUE REFERENCES runs(id) ON DELETE SET NULL,
  message_id UUID UNIQUE REFERENCES meeting_messages(id) ON DELETE SET NULL,
  error_code TEXT,
  error_message TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (meeting_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS meeting_ai_turns_meeting_idx
  ON meeting_ai_turns(meeting_id, created_at DESC);

CREATE INDEX IF NOT EXISTS meeting_ai_turns_run_idx
  ON meeting_ai_turns(run_id)
  WHERE run_id IS NOT NULL;

ALTER TABLE runs
  ALTER COLUMN task_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS meeting_turn_id UUID
    REFERENCES meeting_ai_turns(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS runs_meeting_turn_idx
  ON runs(meeting_turn_id)
  WHERE meeting_turn_id IS NOT NULL;

ALTER TABLE context_packs
  ALTER COLUMN task_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS meeting_turn_id UUID
    REFERENCES meeting_ai_turns(id) ON DELETE SET NULL;

ALTER TABLE meeting_messages
  ADD COLUMN IF NOT EXISTS turn_id UUID,
  ADD COLUMN IF NOT EXISTS policy_id UUID
    REFERENCES meeting_ai_policies(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS policy_revision INTEGER,
  ADD COLUMN IF NOT EXISTS trigger_kind TEXT
    CHECK (trigger_kind IN ('mention', 'round', 'agenda', 'summary')),
  ADD COLUMN IF NOT EXISTS trigger_reason TEXT,
  ADD COLUMN IF NOT EXISTS run_id UUID REFERENCES runs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS trace_id TEXT,
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'sent'
    CHECK (status IN ('sent', 'failed')),
  ADD COLUMN IF NOT EXISTS error_code TEXT,
  ADD COLUMN IF NOT EXISTS error_message TEXT;

ALTER TABLE meeting_messages
  DROP CONSTRAINT IF EXISTS meeting_messages_turn_id_fkey;

ALTER TABLE meeting_messages
  ADD CONSTRAINT meeting_messages_turn_id_fkey
  FOREIGN KEY (turn_id) REFERENCES meeting_ai_turns(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS meeting_messages_turn_idx
  ON meeting_messages(turn_id)
  WHERE turn_id IS NOT NULL;

INSERT INTO meeting_ai_policies (
  id, meeting_id, project_id, status, trigger_kinds, cooldown_seconds,
  max_rounds, max_messages, run_budget_ms, revision, created_by, updated_by,
  created_at, updated_at
)
SELECT
  gen_random_uuid(),
  meeting.id,
  meeting.project_id,
  'paused',
  '["mention"]'::jsonb,
  30,
  6,
  12,
  60000,
  1,
  'local-admin',
  'local-admin',
  meeting.created_at,
  meeting.updated_at
FROM meetings AS meeting
ON CONFLICT (meeting_id) DO NOTHING;

INSERT INTO meeting_ai_participants (
  meeting_id, project_id, agent_id, status, joined_at, updated_at
)
SELECT
  meeting.id,
  meeting.project_id,
  (participant.value ->> 'id')::uuid,
  'active',
  meeting.created_at,
  meeting.updated_at
FROM meetings AS meeting
CROSS JOIN LATERAL jsonb_array_elements(meeting.participants) AS participant(value)
WHERE participant.value ->> 'kind' = 'agent'
  AND participant.value ->> 'id'
    ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
ON CONFLICT (meeting_id, agent_id) DO NOTHING;
`;

export const AI_DIRECT_CHAT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS direct_chat_threads (
  id UUID PRIMARY KEY,
  owner_id TEXT NOT NULL,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (owner_id, agent_id)
);

CREATE INDEX IF NOT EXISTS direct_chat_threads_owner_idx
  ON direct_chat_threads(owner_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS direct_chat_messages (
  id UUID PRIMARY KEY,
  thread_id UUID NOT NULL
    REFERENCES direct_chat_threads(id) ON DELETE CASCADE,
  sequence BIGINT NOT NULL CHECK (sequence > 0),
  sender_type TEXT NOT NULL
    CHECK (sender_type IN ('owner', 'agent', 'system')),
  sender_id TEXT NOT NULL,
  sender_name TEXT NOT NULL,
  content TEXT NOT NULL,
  client_message_id UUID,
  turn_id UUID,
  run_id UUID REFERENCES runs(id) ON DELETE SET NULL,
  trace_id TEXT,
  status TEXT NOT NULL DEFAULT 'sent'
    CHECK (status IN ('sent', 'failed', 'cancelled')),
  error_code TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (thread_id, sequence)
);

CREATE UNIQUE INDEX IF NOT EXISTS direct_chat_messages_client_idx
  ON direct_chat_messages(thread_id, client_message_id)
  WHERE client_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS direct_chat_messages_thread_idx
  ON direct_chat_messages(thread_id, created_at, sequence);

CREATE TABLE IF NOT EXISTS direct_chat_turns (
  id UUID PRIMARY KEY,
  thread_id UUID NOT NULL
    REFERENCES direct_chat_threads(id) ON DELETE CASCADE,
  source_message_id UUID NOT NULL
    REFERENCES direct_chat_messages(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt > 0),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN (
      'queued',
      'running',
      'completed',
      'failed',
      'cancelled'
    )),
  run_id UUID UNIQUE REFERENCES runs(id) ON DELETE SET NULL,
  response_message_id UUID UNIQUE
    REFERENCES direct_chat_messages(id) ON DELETE SET NULL,
  error_code TEXT,
  error_message TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (thread_id, source_message_id, attempt)
);

CREATE UNIQUE INDEX IF NOT EXISTS direct_chat_turns_active_source_idx
  ON direct_chat_turns(source_message_id)
  WHERE status IN ('queued', 'running', 'completed');

CREATE INDEX IF NOT EXISTS direct_chat_turns_thread_idx
  ON direct_chat_turns(thread_id, created_at DESC);

ALTER TABLE direct_chat_messages
  DROP CONSTRAINT IF EXISTS direct_chat_messages_turn_id_fkey;

ALTER TABLE direct_chat_messages
  ADD CONSTRAINT direct_chat_messages_turn_id_fkey
  FOREIGN KEY (turn_id) REFERENCES direct_chat_turns(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS direct_chat_messages_turn_idx
  ON direct_chat_messages(turn_id)
  WHERE turn_id IS NOT NULL;

ALTER TABLE runs
  ALTER COLUMN project_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS direct_chat_turn_id UUID
    REFERENCES direct_chat_turns(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS runs_direct_chat_turn_idx
  ON runs(direct_chat_turn_id)
  WHERE direct_chat_turn_id IS NOT NULL;

ALTER TABLE context_packs
  ALTER COLUMN project_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS direct_chat_turn_id UUID
    REFERENCES direct_chat_turns(id) ON DELETE SET NULL;
`;

export const EXTERNAL_RUNTIME_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS external_runtimes (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 160),
  provider TEXT NOT NULL
    CHECK (provider IN ('codex', 'workbuddy', 'command')),
  protocol TEXT NOT NULL
    CHECK (protocol IN ('codex-jsonl', 'plain-text')),
  command TEXT NOT NULL CHECK (length(btrim(command)) BETWEEN 1 AND 500),
  managed_args JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(managed_args) = 'array'),
  custom_args JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(custom_args) = 'array'),
  supported_models JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(supported_models) = 'array'),
  default_model TEXT,
  context_window_tokens INTEGER
    CHECK (context_window_tokens IS NULL OR context_window_tokens > 0),
  supported_tools JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(supported_tools) = 'array'),
  network_mode TEXT NOT NULL DEFAULT 'unknown'
    CHECK (network_mode IN ('none', 'restricted', 'public', 'unknown')),
  sandbox_mode TEXT NOT NULL DEFAULT 'unknown'
    CHECK (sandbox_mode IN (
      'read-only',
      'workspace-write',
      'danger-full-access',
      'custom',
      'unknown'
    )),
  status TEXT NOT NULL DEFAULT 'disabled'
    CHECK (status IN ('disabled', 'active', 'archived')),
  visibility TEXT NOT NULL DEFAULT 'owner'
    CHECK (visibility IN ('platform', 'owner')),
  owner_id TEXT NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 180),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  command_digest TEXT NOT NULL CHECK (length(command_digest) = 64),
  args_digest TEXT NOT NULL CHECK (length(args_digest) = 64),
  last_probe_id UUID,
  last_probe_at TIMESTAMPTZ,
  last_probe_ok BOOLEAN,
  last_probe_message TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  archived_at TIMESTAMPTZ,
  CHECK (
    default_model IS NULL
    OR supported_models ? default_model
  )
);

CREATE INDEX IF NOT EXISTS external_runtimes_list_idx
  ON external_runtimes(status, visibility, updated_at DESC);

CREATE INDEX IF NOT EXISTS external_runtimes_owner_idx
  ON external_runtimes(owner_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS external_runtime_probes (
  id UUID PRIMARY KEY,
  runtime_id UUID NOT NULL
    REFERENCES external_runtimes(id) ON DELETE CASCADE,
  runtime_revision INTEGER NOT NULL CHECK (runtime_revision > 0),
  requested_by TEXT NOT NULL CHECK (length(requested_by) BETWEEN 1 AND 180),
  status TEXT NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'running', 'passed', 'failed')),
  command_digest TEXT NOT NULL CHECK (length(command_digest) = 64),
  args_digest TEXT NOT NULL CHECK (length(args_digest) = 64),
  requested_at TIMESTAMPTZ NOT NULL,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  exit_code INTEGER,
  timed_out BOOLEAN NOT NULL DEFAULT FALSE,
  runtime_version TEXT,
  stdout_excerpt TEXT,
  stderr_excerpt TEXT,
  error_code TEXT,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS external_runtime_probes_runtime_idx
  ON external_runtime_probes(runtime_id, requested_at DESC);

CREATE TABLE IF NOT EXISTS external_runtime_capabilities (
  id UUID PRIMARY KEY,
  runtime_id UUID NOT NULL
    REFERENCES external_runtimes(id) ON DELETE CASCADE,
  runtime_revision INTEGER NOT NULL CHECK (runtime_revision > 0),
  probe_id UUID NOT NULL
    REFERENCES external_runtime_probes(id) ON DELETE CASCADE,
  adapter_profile JSONB NOT NULL,
  declared_profile JSONB NOT NULL,
  probe_profile JSONB NOT NULL,
  effective_profile JSONB NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS external_runtime_capabilities_runtime_idx
  ON external_runtime_capabilities(runtime_id, runtime_revision DESC, captured_at DESC);

CREATE TABLE IF NOT EXISTS external_runtime_events (
  id UUID PRIMARY KEY,
  runtime_id UUID NOT NULL
    REFERENCES external_runtimes(id) ON DELETE CASCADE,
  kind TEXT NOT NULL
    CHECK (kind IN (
      'registered',
      'updated',
      'probed',
      'enabled',
      'disabled',
      'archived',
      'restored'
    )),
  actor_id TEXT NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 180),
  previous_status TEXT
    CHECK (previous_status IS NULL OR previous_status IN (
      'disabled',
      'active',
      'archived'
    )),
  next_status TEXT NOT NULL
    CHECK (next_status IN ('disabled', 'active', 'archived')),
  changed_fields JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(changed_fields) = 'array'),
  previous_state JSONB,
  next_state JSONB NOT NULL,
  message TEXT NOT NULL CHECK (length(btrim(message)) BETWEEN 1 AND 4000),
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS external_runtime_events_runtime_idx
  ON external_runtime_events(runtime_id, created_at, id);

CREATE TABLE IF NOT EXISTS runtime_probe_jobs (
  id UUID PRIMARY KEY,
  runtime_id UUID NOT NULL
    REFERENCES external_runtimes(id) ON DELETE CASCADE,
  probe_id UUID NOT NULL UNIQUE
    REFERENCES external_runtime_probes(id) ON DELETE CASCADE,
  outbox_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'dead_letter')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  available_at TIMESTAMPTZ NOT NULL,
  lease_owner TEXT,
  lease_token UUID,
  lease_expires_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS runtime_probe_jobs_claim_idx
  ON runtime_probe_jobs(status, available_at, lease_expires_at);

CREATE UNIQUE INDEX IF NOT EXISTS runtime_probe_jobs_active_runtime_idx
  ON runtime_probe_jobs(runtime_id)
  WHERE status IN ('queued', 'running');

CREATE OR REPLACE FUNCTION pluginmax_reject_runtime_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'external_runtime_events is append-only';
END;
$$;

DROP TRIGGER IF EXISTS external_runtime_events_append_only
  ON external_runtime_events;
CREATE TRIGGER external_runtime_events_append_only
BEFORE UPDATE OR DELETE ON external_runtime_events
FOR EACH ROW
EXECUTE FUNCTION pluginmax_reject_runtime_event_mutation();

CREATE OR REPLACE FUNCTION pluginmax_reject_completed_probe_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status IN ('passed', 'failed') THEN
    RAISE EXCEPTION 'completed external runtime probes are immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS external_runtime_probes_terminal_immutable
  ON external_runtime_probes;
CREATE TRIGGER external_runtime_probes_terminal_immutable
BEFORE UPDATE ON external_runtime_probes
FOR EACH ROW
EXECUTE FUNCTION pluginmax_reject_completed_probe_mutation();

CREATE OR REPLACE FUNCTION pluginmax_reject_capability_snapshot_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'external runtime capability snapshots are immutable';
END;
$$;

DROP TRIGGER IF EXISTS external_runtime_capabilities_immutable
  ON external_runtime_capabilities;
CREATE TRIGGER external_runtime_capabilities_immutable
BEFORE UPDATE ON external_runtime_capabilities
FOR EACH ROW
EXECUTE FUNCTION pluginmax_reject_capability_snapshot_mutation();
`;

export const AGENT_RUNTIME_BINDING_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS agent_runtime_bindings (
  id UUID PRIMARY KEY,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  runtime_id UUID NOT NULL REFERENCES external_runtimes(id) ON DELETE CASCADE,
  execution_mode TEXT NOT NULL DEFAULT 'external'
    CHECK (execution_mode = 'external'),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  bound_by TEXT NOT NULL CHECK (length(bound_by) BETWEEN 1 AND 180),
  disabled_by TEXT CHECK (
    disabled_by IS NULL OR length(disabled_by) BETWEEN 1 AND 180
  ),
  disabled_reason TEXT CHECK (
    disabled_reason IS NULL OR length(btrim(disabled_reason)) BETWEEN 1 AND 1000
  ),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  disabled_at TIMESTAMPTZ,
  CHECK (
    (status = 'active' AND disabled_at IS NULL)
    OR (status = 'disabled' AND disabled_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_runtime_bindings_active_agent_idx
  ON agent_runtime_bindings(agent_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS agent_runtime_bindings_agent_history_idx
  ON agent_runtime_bindings(agent_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS agent_runtime_bindings_runtime_active_idx
  ON agent_runtime_bindings(runtime_id, status)
  WHERE status = 'active';

ALTER TABLE external_runtime_events
  ADD COLUMN IF NOT EXISTS agent_id UUID
    REFERENCES agents(id) ON DELETE SET NULL;

ALTER TABLE external_runtime_events
  DROP CONSTRAINT IF EXISTS external_runtime_events_kind_check;

ALTER TABLE external_runtime_events
  ADD CONSTRAINT external_runtime_events_kind_check
  CHECK (kind IN (
    'registered',
    'updated',
    'probed',
    'enabled',
    'disabled',
    'archived',
    'restored',
    'bound',
    'unbound'
  ));

CREATE INDEX IF NOT EXISTS external_runtime_events_agent_idx
  ON external_runtime_events(agent_id, created_at DESC)
  WHERE agent_id IS NOT NULL;
`;

export const EXTERNAL_RUN_EXECUTION_SCHEMA_SQL = `
ALTER TABLE runs
  ADD COLUMN IF NOT EXISTS execution_snapshot JSONB,
  ADD COLUMN IF NOT EXISTS external_runtime_id UUID
    REFERENCES external_runtimes(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS external_runtime_revision INTEGER
    CHECK (external_runtime_revision IS NULL OR external_runtime_revision > 0),
  ADD COLUMN IF NOT EXISTS external_runtime_provider TEXT,
  ADD COLUMN IF NOT EXISTS external_runtime_protocol TEXT,
  ADD COLUMN IF NOT EXISTS external_session_id TEXT,
  ADD COLUMN IF NOT EXISTS external_runtime_version TEXT,
  ADD COLUMN IF NOT EXISTS external_started_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS runs_external_runtime_idx
  ON runs(external_runtime_id, external_runtime_revision)
  WHERE external_runtime_id IS NOT NULL;
`;

export const IDENTITY_PRINCIPAL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS principals (
  id TEXT PRIMARY KEY
    CHECK (
      length(id) BETWEEN 1 AND 180
      AND id ~ '^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$'
    ),
  kind TEXT NOT NULL CHECK (kind IN ('human', 'ai')),
  display_name TEXT NOT NULL
    CHECK (length(btrim(display_name)) BETWEEN 1 AND 160),
  status TEXT NOT NULL
    CHECK (status IN ('active', 'suspended', 'archived')),
  status_authority TEXT NOT NULL
    CHECK (status_authority IN (
      'account',
      'ai-companion',
      'hrm',
      'legacy',
      'system'
    )),
  source TEXT NOT NULL
    CHECK (source IN (
      'local',
      'account',
      'ai-companion',
      'agent',
      'hrm',
      'system'
    )),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS principals_kind_status_idx
  ON principals(kind, status, display_name);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 180),
  principal_id TEXT NOT NULL UNIQUE REFERENCES principals(id),
  login_id TEXT NOT NULL CHECK (length(btrim(login_id)) BETWEEN 1 AND 180),
  status TEXT NOT NULL
    CHECK (status IN ('active', 'pending', 'disabled')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS accounts_login_id_unique_idx
  ON accounts(lower(login_id));

CREATE OR REPLACE FUNCTION pluginmax_assert_human_account_principal()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  principal_kind TEXT;
BEGIN
  SELECT kind INTO principal_kind
  FROM principals
  WHERE id = NEW.principal_id;

  IF principal_kind IS DISTINCT FROM 'human' THEN
    RAISE EXCEPTION 'accounts require a human principal';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS accounts_human_principal_only ON accounts;
CREATE TRIGGER accounts_human_principal_only
BEFORE INSERT OR UPDATE OF principal_id ON accounts
FOR EACH ROW
EXECUTE FUNCTION pluginmax_assert_human_account_principal();

CREATE TABLE IF NOT EXISTS account_credentials (
  id UUID PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  credential_type TEXT NOT NULL
    CHECK (credential_type IN ('password', 'sso')),
  secret_scheme TEXT,
  secret_hash TEXT,
  status TEXT NOT NULL
    CHECK (status IN ('pending', 'active', 'disabled', 'revoked')),
  expires_at TIMESTAMPTZ,
  last_authenticated_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (updated_at >= created_at),
  CHECK (
    credential_type <> 'password'
    OR (secret_scheme IS NOT NULL AND secret_hash IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS account_credentials_active_type_idx
  ON account_credentials(account_id, credential_type)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS account_credentials_account_idx
  ON account_credentials(account_id, status);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id UUID PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  status TEXT NOT NULL
    CHECK (status IN ('active', 'expired', 'revoked')),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  CHECK (
    (status = 'revoked' AND revoked_at IS NOT NULL)
    OR (status <> 'revoked' AND revoked_at IS NULL)
  )
);

CREATE OR REPLACE FUNCTION pluginmax_assert_session_principal_matches_account()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  account_principal_id TEXT;
BEGIN
  SELECT principal_id INTO account_principal_id
  FROM accounts
  WHERE id = NEW.account_id;

  IF account_principal_id IS DISTINCT FROM NEW.principal_id THEN
    RAISE EXCEPTION 'session principal must match account principal';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS auth_sessions_principal_matches_account
  ON auth_sessions;
CREATE TRIGGER auth_sessions_principal_matches_account
BEFORE INSERT OR UPDATE OF account_id, principal_id ON auth_sessions
FOR EACH ROW
EXECUTE FUNCTION pluginmax_assert_session_principal_matches_account();

CREATE INDEX IF NOT EXISTS auth_sessions_principal_active_idx
  ON auth_sessions(principal_id, expires_at DESC)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS workspace_members (
  id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) BETWEEN 1 AND 180),
  principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive')),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (workspace_id, principal_id),
  CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS workspace_members_principal_idx
  ON workspace_members(principal_id, status);

CREATE TABLE IF NOT EXISTS external_identity_links (
  id UUID PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (length(btrim(provider)) BETWEEN 1 AND 80),
  external_subject_id TEXT NOT NULL
    CHECK (length(btrim(external_subject_id)) BETWEEN 1 AND 240),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'retired')),
  sync_version TEXT NOT NULL
    CHECK (length(btrim(sync_version)) BETWEEN 1 AND 120),
  synced_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (provider, external_subject_id),
  CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS external_identity_links_principal_idx
  ON external_identity_links(principal_id, status);

CREATE TABLE IF NOT EXISTS principal_aliases (
  id UUID PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  alias_type TEXT NOT NULL
    CHECK (alias_type IN (
      'auth-user',
      'employee',
      'teammate',
      'agent',
      'runtime-profile',
      'legacy-actor',
      'external'
    )),
  alias_value TEXT NOT NULL
    CHECK (length(btrim(alias_value)) BETWEEN 1 AND 240),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'retired')),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (alias_type, alias_value),
  CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS principal_aliases_principal_idx
  ON principal_aliases(principal_id, status);

CREATE TABLE IF NOT EXISTS role_grants (
  id UUID PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL
    CHECK (scope_type IN ('platform', 'workspace', 'project')),
  scope_id TEXT NOT NULL CHECK (length(scope_id) BETWEEN 1 AND 180),
  role_key TEXT NOT NULL
    CHECK (
      length(role_key) BETWEEN 1 AND 180
      AND role_key ~ '^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$'
    ),
  permissions JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(permissions) = 'array'),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked', 'expired')),
  source_kind TEXT NOT NULL
    CHECK (source_kind IN (
      'manual',
      'platform-role',
      'workspace-role',
      'project-role',
      'employee-role',
      'template'
    )),
  source_ref TEXT CHECK (
    source_ref IS NULL OR length(btrim(source_ref)) BETWEEN 1 AND 240
  ),
  granted_by_principal_id TEXT
    REFERENCES principals(id) ON DELETE SET NULL,
  revoked_by_principal_id TEXT
    REFERENCES principals(id) ON DELETE SET NULL,
  granted_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (scope_type <> 'platform' OR scope_id = 'platform'),
  CHECK (expires_at IS NULL OR expires_at > granted_at),
  CHECK (
    (status = 'revoked' AND revoked_at IS NOT NULL)
    OR (status <> 'revoked' AND revoked_at IS NULL)
  ),
  CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS role_grants_active_scope_role_idx
  ON role_grants(principal_id, scope_type, scope_id, role_key)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS role_grants_scope_idx
  ON role_grants(scope_type, scope_id, status, role_key);

CREATE INDEX IF NOT EXISTS role_grants_principal_idx
  ON role_grants(principal_id, status, scope_type);

CREATE TABLE IF NOT EXISTS identity_audit_events (
  id UUID PRIMARY KEY,
  action TEXT NOT NULL
    CHECK (length(btrim(action)) BETWEEN 1 AND 160),
  decision TEXT NOT NULL CHECK (decision IN ('allowed', 'denied')),
  actor_principal_id TEXT
    REFERENCES principals(id) ON DELETE SET NULL,
  subject_principal_id TEXT
    REFERENCES principals(id) ON DELETE SET NULL,
  account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  session_id UUID REFERENCES auth_sessions(id) ON DELETE SET NULL,
  grant_id UUID REFERENCES role_grants(id) ON DELETE SET NULL,
  reason TEXT NOT NULL DEFAULT ''
    CHECK (length(reason) <= 1000),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(metadata) = 'object'),
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS identity_audit_actor_idx
  ON identity_audit_events(actor_principal_id, created_at DESC);

CREATE INDEX IF NOT EXISTS identity_audit_subject_idx
  ON identity_audit_events(subject_principal_id, created_at DESC);

CREATE OR REPLACE FUNCTION pluginmax_reject_identity_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'identity_audit_events is append-only';
END;
$$;

DROP TRIGGER IF EXISTS identity_audit_events_append_only
  ON identity_audit_events;
CREATE TRIGGER identity_audit_events_append_only
BEFORE UPDATE OR DELETE ON identity_audit_events
FOR EACH ROW
EXECUTE FUNCTION pluginmax_reject_identity_audit_mutation();

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS principal_id TEXT
    REFERENCES principals(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS agents_principal_idx
  ON agents(principal_id)
  WHERE principal_id IS NOT NULL;

ALTER TABLE project_members
  ADD COLUMN IF NOT EXISTS principal_id TEXT
    REFERENCES principals(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS project_members_principal_idx
  ON project_members(principal_id, status)
  WHERE principal_id IS NOT NULL;

ALTER TABLE runs
  ADD COLUMN IF NOT EXISTS agent_principal_id TEXT
    REFERENCES principals(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS initiated_by_principal_id TEXT
    REFERENCES principals(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS runs_agent_principal_idx
  ON runs(agent_principal_id, created_at DESC)
  WHERE agent_principal_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS runs_initiated_by_principal_idx
  ON runs(initiated_by_principal_id, created_at DESC)
  WHERE initiated_by_principal_id IS NOT NULL;
`;

export const TASK_EXECUTION_POLICY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS task_execution_policies (
  id UUID PRIMARY KEY,
  context_type TEXT NOT NULL
    CHECK (context_type IN ('project', 'task', 'meeting', 'direct-chat')),
  context_id TEXT NOT NULL
    CHECK (length(btrim(context_id)) BETWEEN 1 AND 180),
  project_id UUID REFERENCES projects(id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  policy JSONB NOT NULL
    CHECK (jsonb_typeof(policy) = 'object'),
  created_by TEXT NOT NULL
    CHECK (length(btrim(created_by)) BETWEEN 1 AND 180),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (context_type, context_id, revision),
  CHECK (
    (context_type = 'project' AND project_id::text = context_id)
    OR (context_type IN ('task', 'meeting') AND project_id IS NOT NULL)
    OR (context_type = 'direct-chat' AND project_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS task_execution_policies_context_idx
  ON task_execution_policies(context_type, context_id, revision DESC);

CREATE INDEX IF NOT EXISTS task_execution_policies_project_idx
  ON task_execution_policies(project_id, context_type, revision DESC)
  WHERE project_id IS NOT NULL;

CREATE OR REPLACE FUNCTION pluginmax_reject_task_execution_policy_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'task_execution_policies revisions are immutable';
END;
$$;

DROP TRIGGER IF EXISTS task_execution_policies_immutable
  ON task_execution_policies;
CREATE TRIGGER task_execution_policies_immutable
BEFORE UPDATE OR DELETE ON task_execution_policies
FOR EACH ROW
EXECUTE FUNCTION pluginmax_reject_task_execution_policy_mutation();

ALTER TABLE runs
  ADD COLUMN IF NOT EXISTS execution_context_type TEXT
    CHECK (
      execution_context_type IS NULL
      OR execution_context_type IN (
        'task',
        'workflow-task',
        'meeting',
        'direct-chat'
      )
    ),
  ADD COLUMN IF NOT EXISTS execution_context_id TEXT
    CHECK (
      execution_context_id IS NULL
      OR length(btrim(execution_context_id)) BETWEEN 1 AND 180
    ),
  ADD COLUMN IF NOT EXISTS execution_policy_id UUID
    REFERENCES task_execution_policies(id),
  ADD COLUMN IF NOT EXISTS execution_policy_revision INTEGER
    CHECK (
      execution_policy_revision IS NULL
      OR execution_policy_revision >= 0
    ),
  ADD COLUMN IF NOT EXISTS execution_binding_revision INTEGER
    CHECK (
      execution_binding_revision IS NULL
      OR execution_binding_revision >= 0
    ),
  ADD COLUMN IF NOT EXISTS execution_runtime_revision INTEGER
    CHECK (
      execution_runtime_revision IS NULL
      OR execution_runtime_revision > 0
    ),
  ADD COLUMN IF NOT EXISTS execution_envelope_snapshot JSONB
    CHECK (
      execution_envelope_snapshot IS NULL
      OR jsonb_typeof(execution_envelope_snapshot) = 'object'
    );

CREATE INDEX IF NOT EXISTS runs_execution_policy_idx
  ON runs(execution_policy_id, execution_policy_revision)
  WHERE execution_policy_id IS NOT NULL;

CREATE OR REPLACE FUNCTION pluginmax_reject_run_execution_envelope_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.execution_context_type IS DISTINCT FROM NEW.execution_context_type
    OR OLD.execution_context_id IS DISTINCT FROM NEW.execution_context_id
    OR OLD.execution_policy_id IS DISTINCT FROM NEW.execution_policy_id
    OR OLD.execution_policy_revision IS DISTINCT FROM NEW.execution_policy_revision
    OR OLD.execution_binding_revision IS DISTINCT FROM NEW.execution_binding_revision
    OR OLD.execution_runtime_revision IS DISTINCT FROM NEW.execution_runtime_revision
    OR OLD.execution_envelope_snapshot IS DISTINCT FROM NEW.execution_envelope_snapshot
  THEN
    RAISE EXCEPTION 'run execution envelope is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS runs_execution_envelope_immutable ON runs;
CREATE TRIGGER runs_execution_envelope_immutable
BEFORE UPDATE ON runs
FOR EACH ROW
EXECUTE FUNCTION pluginmax_reject_run_execution_envelope_mutation();
`;

export const ACTION_TICKET_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS action_tickets (
  id UUID PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  ticket_version INTEGER NOT NULL CHECK (ticket_version = 1),
  principal_id TEXT NOT NULL REFERENCES principals(id),
  workspace_id TEXT NOT NULL
    CHECK (length(btrim(workspace_id)) BETWEEN 1 AND 180),
  context_type TEXT NOT NULL
    CHECK (context_type IN ('task', 'workflow-task', 'meeting', 'direct-chat')),
  context_id TEXT NOT NULL
    CHECK (length(btrim(context_id)) BETWEEN 1 AND 180),
  task_id TEXT NOT NULL
    CHECK (length(btrim(task_id)) BETWEEN 1 AND 180),
  run_id UUID NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
  allowed_actions TEXT[] NOT NULL
    CHECK (
      cardinality(allowed_actions) > 0
      AND allowed_actions <@ ARRAY[
        'agent.execute',
        'task.writeback',
        'workflow.writeback',
        'meeting.writeback',
        'direct-chat.writeback'
      ]::text[]
    ),
  denied_actions TEXT[] NOT NULL DEFAULT '{}'
    CHECK (
      denied_actions <@ ARRAY[
        'agent.execute',
        'task.writeback',
        'workflow.writeback',
        'meeting.writeback',
        'direct-chat.writeback'
      ]::text[]
    ),
  resource_scopes TEXT[] NOT NULL
    CHECK (cardinality(resource_scopes) > 0),
  policy_id UUID REFERENCES task_execution_policies(id),
  policy_revision INTEGER NOT NULL CHECK (policy_revision >= 0),
  envelope_id TEXT NOT NULL
    CHECK (length(btrim(envelope_id)) BETWEEN 1 AND 180),
  envelope_digest TEXT NOT NULL
    CHECK (envelope_digest ~ '^[a-f0-9]{64}$'),
  authorization_snapshot JSONB NOT NULL
    CHECK (jsonb_typeof(authorization_snapshot) = 'object'),
  execution_envelope JSONB NOT NULL
    CHECK (jsonb_typeof(execution_envelope) = 'object'),
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  issued_by TEXT NOT NULL
    CHECK (length(btrim(issued_by)) BETWEEN 1 AND 180),
  CHECK (expires_at > issued_at),
  CHECK (
    (policy_revision = 0 AND policy_id IS NULL)
    OR (policy_revision > 0 AND policy_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS action_tickets_principal_idx
  ON action_tickets(principal_id, issued_at DESC);

CREATE INDEX IF NOT EXISTS action_tickets_context_idx
  ON action_tickets(context_type, context_id, issued_at DESC);

CREATE INDEX IF NOT EXISTS action_tickets_expiry_idx
  ON action_tickets(expires_at);

CREATE OR REPLACE FUNCTION pluginmax_reject_action_ticket_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'action tickets are immutable';
END;
$$;

DROP TRIGGER IF EXISTS action_tickets_immutable ON action_tickets;
CREATE TRIGGER action_tickets_immutable
BEFORE UPDATE OR DELETE ON action_tickets
FOR EACH ROW
EXECUTE FUNCTION pluginmax_reject_action_ticket_mutation();

CREATE TABLE IF NOT EXISTS execution_gate_requests (
  gate_id UUID PRIMARY KEY,
  ticket_id UUID NOT NULL REFERENCES action_tickets(id) ON DELETE CASCADE,
  run_id UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL
    CHECK (length(btrim(task_id)) BETWEEN 1 AND 180),
  project_id UUID REFERENCES projects(id),
  gate_key TEXT NOT NULL
    CHECK (length(btrim(gate_key)) BETWEEN 1 AND 180),
  kind TEXT NOT NULL
    CHECK (
      kind IN (
        'preflight',
        'tool-approval',
        'data-source',
        'external-send',
        'budget',
        'runtime-switch'
      )
    ),
  enforcement TEXT NOT NULL
    CHECK (enforcement IN ('blocking', 'non-blocking')),
  reason TEXT NOT NULL
    CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  requested_tool_category TEXT,
  requested_source_class TEXT,
  resource_scopes TEXT[] NOT NULL
    CHECK (cardinality(resource_scopes) > 0),
  policy_id UUID REFERENCES task_execution_policies(id),
  policy_revision INTEGER NOT NULL CHECK (policy_revision >= 0),
  envelope_id TEXT NOT NULL
    CHECK (length(btrim(envelope_id)) BETWEEN 1 AND 180),
  envelope_digest TEXT NOT NULL
    CHECK (envelope_digest ~ '^[a-f0-9]{64}$'),
  requested_by_principal_id TEXT NOT NULL
    CHECK (length(btrim(requested_by_principal_id)) BETWEEN 1 AND 180),
  requested_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  UNIQUE (ticket_id, gate_key),
  CHECK (expires_at > requested_at),
  CHECK (project_id IS NOT NULL OR ticket_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS execution_gate_requests_run_idx
  ON execution_gate_requests(run_id, requested_at);

CREATE INDEX IF NOT EXISTS execution_gate_requests_ticket_idx
  ON execution_gate_requests(ticket_id, requested_at);

CREATE INDEX IF NOT EXISTS execution_gate_requests_expiry_idx
  ON execution_gate_requests(expires_at);

CREATE OR REPLACE FUNCTION pluginmax_reject_execution_gate_request_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'execution gate requests are immutable';
END;
$$;

DROP TRIGGER IF EXISTS execution_gate_requests_immutable
  ON execution_gate_requests;
CREATE TRIGGER execution_gate_requests_immutable
BEFORE UPDATE OR DELETE ON execution_gate_requests
FOR EACH ROW
EXECUTE FUNCTION pluginmax_reject_execution_gate_request_mutation();

CREATE TABLE IF NOT EXISTS execution_gate_decisions (
  decision_id UUID PRIMARY KEY,
  gate_id UUID NOT NULL UNIQUE
    REFERENCES execution_gate_requests(gate_id) ON DELETE CASCADE,
  decision TEXT NOT NULL
    CHECK (decision IN ('approve', 'reject', 'timeout', 'cancel')),
  decided_by_principal_id TEXT NOT NULL
    CHECK (length(btrim(decided_by_principal_id)) BETWEEN 1 AND 180),
  basis TEXT NOT NULL
    CHECK (length(btrim(basis)) BETWEEN 1 AND 4000),
  decided_at TIMESTAMPTZ NOT NULL,
  policy_revision INTEGER NOT NULL CHECK (policy_revision >= 0),
  envelope_id TEXT NOT NULL
    CHECK (length(btrim(envelope_id)) BETWEEN 1 AND 180),
  envelope_digest TEXT NOT NULL
    CHECK (envelope_digest ~ '^[a-f0-9]{64}$')
);

CREATE INDEX IF NOT EXISTS execution_gate_decisions_decided_idx
  ON execution_gate_decisions(decided_at DESC);

CREATE OR REPLACE FUNCTION pluginmax_reject_execution_gate_decision_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'execution gate decisions are immutable';
END;
$$;

DROP TRIGGER IF EXISTS execution_gate_decisions_immutable
  ON execution_gate_decisions;
CREATE TRIGGER execution_gate_decisions_immutable
BEFORE UPDATE OR DELETE ON execution_gate_decisions
FOR EACH ROW
EXECUTE FUNCTION pluginmax_reject_execution_gate_decision_mutation();

CREATE TABLE IF NOT EXISTS action_ticket_usages (
  ticket_id UUID NOT NULL REFERENCES action_tickets(id) ON DELETE CASCADE,
  action TEXT NOT NULL
    CHECK (
      action IN (
        'agent.execute',
        'task.writeback',
        'workflow.writeback',
        'meeting.writeback',
        'direct-chat.writeback'
      )
    ),
  idempotency_key TEXT NOT NULL
    CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 240),
  run_id UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'started'
    CHECK (status IN ('started', 'completed', 'failed')),
  result JSONB
    CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (ticket_id, action, idempotency_key),
  CHECK (
    (status = 'started' AND completed_at IS NULL)
    OR (status IN ('completed', 'failed') AND completed_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS action_ticket_usages_run_idx
  ON action_ticket_usages(run_id, action, started_at DESC);

CREATE OR REPLACE FUNCTION pluginmax_guard_action_ticket_usage_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'action ticket usages cannot be deleted';
  END IF;
  IF OLD.ticket_id IS DISTINCT FROM NEW.ticket_id
    OR OLD.action IS DISTINCT FROM NEW.action
    OR OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key
    OR OLD.run_id IS DISTINCT FROM NEW.run_id
    OR OLD.started_at IS DISTINCT FROM NEW.started_at
  THEN
    RAISE EXCEPTION 'action ticket usage identity is immutable';
  END IF;
  IF OLD.status <> 'started' AND OLD.status IS DISTINCT FROM NEW.status THEN
    RAISE EXCEPTION 'terminal action ticket usage is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS action_ticket_usages_identity_immutable
  ON action_ticket_usages;
CREATE TRIGGER action_ticket_usages_identity_immutable
BEFORE UPDATE OR DELETE ON action_ticket_usages
FOR EACH ROW
EXECUTE FUNCTION pluginmax_guard_action_ticket_usage_mutation();
`;

export const SCENE_CONTEXT_SCHEMA_SQL = `
ALTER TABLE task_messages
  ADD COLUMN IF NOT EXISTS is_key_consensus BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS task_messages_key_consensus_idx
  ON task_messages(task_id, created_at, id)
  WHERE is_key_consensus = TRUE;

CREATE TABLE IF NOT EXISTS scene_chat_channels (
  id UUID PRIMARY KEY,
  channel_key TEXT NOT NULL UNIQUE
    CHECK (length(btrim(channel_key)) BETWEEN 1 AND 800),
  scene_type TEXT NOT NULL
    CHECK (scene_type = 'direct-chat'),
  scene_id TEXT NOT NULL
    CHECK (length(btrim(scene_id)) BETWEEN 1 AND 240),
  project_id UUID REFERENCES projects(id) ON DELETE RESTRICT,
  owner_principal_id TEXT NOT NULL
    CHECK (length(btrim(owner_principal_id)) BETWEEN 1 AND 180),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  agent_principal_id TEXT
    CHECK (
      agent_principal_id IS NULL
      OR length(btrim(agent_principal_id)) BETWEEN 1 AND 180
    ),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived')),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (scene_type, scene_id, owner_principal_id, agent_id)
);

CREATE TABLE IF NOT EXISTS scene_sessions (
  id UUID PRIMARY KEY,
  scene_type TEXT NOT NULL
    CHECK (scene_type IN ('task', 'workflow-node', 'meeting', 'direct-chat')),
  scene_id TEXT NOT NULL
    CHECK (length(btrim(scene_id)) BETWEEN 1 AND 240),
  project_id UUID REFERENCES projects(id) ON DELETE RESTRICT,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  agent_principal_id TEXT
    CHECK (
      agent_principal_id IS NULL
      OR length(btrim(agent_principal_id)) BETWEEN 1 AND 180
    ),
  owner_principal_id TEXT
    CHECK (
      owner_principal_id IS NULL
      OR length(btrim(owner_principal_id)) BETWEEN 1 AND 180
    ),
  principal_scope TEXT NOT NULL DEFAULT ''
    CHECK (length(principal_scope) <= 180),
  channel_id UUID REFERENCES scene_chat_channels(id) ON DELETE RESTRICT,
  session_handle TEXT NOT NULL UNIQUE
    CHECK (length(btrim(session_handle)) BETWEEN 1 AND 240),
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived', 'reset')),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (scene_type, scene_id, agent_id, principal_scope, generation),
  UNIQUE (id, scene_type, scene_id)
);

CREATE INDEX IF NOT EXISTS scene_sessions_project_idx
  ON scene_sessions(project_id, scene_type, updated_at DESC);

CREATE INDEX IF NOT EXISTS scene_sessions_scene_idx
  ON scene_sessions(scene_type, scene_id, agent_id, generation DESC);

CREATE TABLE IF NOT EXISTS scene_context_contributions (
  id UUID PRIMARY KEY,
  scene_session_id UUID NOT NULL,
  scene_type TEXT NOT NULL
    CHECK (scene_type IN ('task', 'workflow-node', 'meeting', 'direct-chat')),
  scene_id TEXT NOT NULL
    CHECK (length(btrim(scene_id)) BETWEEN 1 AND 240),
  project_id UUID REFERENCES projects(id) ON DELETE RESTRICT,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  agent_principal_id TEXT
    CHECK (
      agent_principal_id IS NULL
      OR length(btrim(agent_principal_id)) BETWEEN 1 AND 180
    ),
  owner_principal_id TEXT
    CHECK (
      owner_principal_id IS NULL
      OR length(btrim(owner_principal_id)) BETWEEN 1 AND 180
    ),
  source_key TEXT NOT NULL
    CHECK (length(btrim(source_key)) BETWEEN 1 AND 240),
  kind TEXT NOT NULL CHECK (kind IN (
    'task-comment-consensus',
    'task-dependency',
    'task-attachment',
    'workflow-node',
    'meeting-minutes',
    'meeting-private-note',
    'direct-chat-message',
    'agent-memory',
    'project-memory',
    'manual'
  )),
  version TEXT NOT NULL DEFAULT '1'
    CHECK (length(btrim(version)) BETWEEN 1 AND 120),
  authority TEXT NOT NULL
    CHECK (authority IN ('mandatory', 'instruction', 'evidence')),
  visibility TEXT NOT NULL
    CHECK (visibility IN ('scene', 'project', 'private')),
  text TEXT NOT NULL
    CHECK (length(btrim(text)) BETWEEN 1 AND 20000),
  source_refs JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(source_refs) = 'array'),
  delivery_sequence BIGSERIAL UNIQUE,
  created_by TEXT NOT NULL
    CHECK (length(btrim(created_by)) BETWEEN 1 AND 180),
  created_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (scene_session_id, scene_type, scene_id)
    REFERENCES scene_sessions(id, scene_type, scene_id)
    ON DELETE RESTRICT,
  UNIQUE (scene_session_id, source_key, version)
);

CREATE INDEX IF NOT EXISTS scene_context_contributions_session_idx
  ON scene_context_contributions(
    scene_session_id,
    delivery_sequence,
    id
  );

CREATE INDEX IF NOT EXISTS scene_context_contributions_project_idx
  ON scene_context_contributions(project_id, created_at DESC);

CREATE OR REPLACE FUNCTION pluginmax_reject_scene_context_contribution_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'scene context contributions are immutable';
END;
$$;

DROP TRIGGER IF EXISTS scene_context_contributions_immutable
  ON scene_context_contributions;
CREATE TRIGGER scene_context_contributions_immutable
BEFORE UPDATE OR DELETE ON scene_context_contributions
FOR EACH ROW
EXECUTE FUNCTION pluginmax_reject_scene_context_contribution_mutation();

ALTER TABLE context_packs
  ADD COLUMN IF NOT EXISTS scene_session_id UUID,
  ADD COLUMN IF NOT EXISTS scene_type TEXT,
  ADD COLUMN IF NOT EXISTS scene_id TEXT,
  ADD COLUMN IF NOT EXISTS agent_principal_id TEXT,
  ADD COLUMN IF NOT EXISTS logical_digest TEXT,
  ADD COLUMN IF NOT EXISTS renderer_version TEXT,
  ADD COLUMN IF NOT EXISTS as_of TIMESTAMPTZ;

ALTER TABLE context_packs
  DROP CONSTRAINT IF EXISTS context_packs_scene_type_check,
  DROP CONSTRAINT IF EXISTS context_packs_scene_session_fkey;

ALTER TABLE context_packs
  ADD CONSTRAINT context_packs_scene_type_check
    CHECK (
      scene_type IS NULL
      OR scene_type IN ('task', 'workflow-node', 'meeting', 'direct-chat')
    ),
  ADD CONSTRAINT context_packs_scene_session_fkey
    FOREIGN KEY (scene_session_id, scene_type, scene_id)
    REFERENCES scene_sessions(id, scene_type, scene_id)
    ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS context_packs_scene_session_idx
  ON context_packs(scene_session_id, created_at DESC)
  WHERE scene_session_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS scene_context_receipts (
  id UUID PRIMARY KEY,
  run_id UUID NOT NULL UNIQUE REFERENCES runs(id) ON DELETE RESTRICT,
  context_pack_id UUID NOT NULL UNIQUE
    REFERENCES context_packs(id) ON DELETE RESTRICT,
  scene_session_id UUID NOT NULL,
  scene_type TEXT NOT NULL
    CHECK (scene_type IN ('task', 'workflow-node', 'meeting', 'direct-chat')),
  scene_id TEXT NOT NULL
    CHECK (length(btrim(scene_id)) BETWEEN 1 AND 240),
  project_id UUID REFERENCES projects(id) ON DELETE RESTRICT,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  principal_id TEXT NOT NULL
    CHECK (length(btrim(principal_id)) BETWEEN 1 AND 180),
  agent_principal_id TEXT
    CHECK (
      agent_principal_id IS NULL
      OR length(btrim(agent_principal_id)) BETWEEN 1 AND 180
    ),
  logical_digest TEXT NOT NULL CHECK (logical_digest ~ '^[a-f0-9]{64}$'),
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  renderer_version TEXT NOT NULL,
  runtime_stateful BOOLEAN NOT NULL,
  cursor_before BIGINT NOT NULL CHECK (cursor_before >= 0),
  cursor_after BIGINT NOT NULL CHECK (cursor_after >= cursor_before),
  delivered JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(delivered) = 'array'),
  reused JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(reused) = 'array'),
  source_refs JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(source_refs) = 'array'),
  excluded JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(excluded) = 'array'),
  created_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (scene_session_id, scene_type, scene_id)
    REFERENCES scene_sessions(id, scene_type, scene_id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS scene_context_receipts_session_idx
  ON scene_context_receipts(scene_session_id, created_at DESC);

CREATE OR REPLACE FUNCTION pluginmax_reject_scene_context_receipt_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'scene context receipts are immutable';
END;
$$;

DROP TRIGGER IF EXISTS scene_context_receipts_immutable
  ON scene_context_receipts;
CREATE TRIGGER scene_context_receipts_immutable
BEFORE UPDATE OR DELETE ON scene_context_receipts
FOR EACH ROW
EXECUTE FUNCTION pluginmax_reject_scene_context_receipt_mutation();

CREATE TABLE IF NOT EXISTS scene_context_delivery_cursors (
  scene_session_id UUID PRIMARY KEY
    REFERENCES scene_sessions(id) ON DELETE RESTRICT,
  cursor_sequence BIGINT NOT NULL DEFAULT 0 CHECK (cursor_sequence >= 0),
  delivered_contribution_ids UUID[] NOT NULL DEFAULT '{}'::uuid[],
  last_run_id UUID REFERENCES runs(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE OR REPLACE FUNCTION pluginmax_guard_scene_session_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.id IS DISTINCT FROM NEW.id
    OR OLD.scene_type IS DISTINCT FROM NEW.scene_type
    OR OLD.scene_id IS DISTINCT FROM NEW.scene_id
    OR OLD.agent_id IS DISTINCT FROM NEW.agent_id
    OR OLD.agent_principal_id IS DISTINCT FROM NEW.agent_principal_id
    OR OLD.owner_principal_id IS DISTINCT FROM NEW.owner_principal_id
    OR OLD.channel_id IS DISTINCT FROM NEW.channel_id
    OR OLD.session_handle IS DISTINCT FROM NEW.session_handle
    OR OLD.generation IS DISTINCT FROM NEW.generation
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
  THEN
    RAISE EXCEPTION 'scene session identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS scene_sessions_identity_immutable ON scene_sessions;
CREATE TRIGGER scene_sessions_identity_immutable
BEFORE UPDATE ON scene_sessions
FOR EACH ROW
EXECUTE FUNCTION pluginmax_guard_scene_session_identity();

CREATE OR REPLACE FUNCTION pluginmax_guard_scene_context_pack_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.scene_session_id IS NOT NULL THEN
    RAISE EXCEPTION 'scene context packs are immutable';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS context_packs_scene_immutable ON context_packs;
CREATE TRIGGER context_packs_scene_immutable
BEFORE UPDATE OR DELETE ON context_packs
FOR EACH ROW
EXECUTE FUNCTION pluginmax_guard_scene_context_pack_mutation();
`;

export const TASK_EXECUTION_DEPTH_SCHEMA_SQL = `
ALTER TABLE tasks
  DROP CONSTRAINT IF EXISTS tasks_status_check;

ALTER TABLE tasks
  ADD CONSTRAINT tasks_status_check
  CHECK (status IN (
    'queued',
    'in_progress',
    'review',
    'paused',
    'blocked',
    'needs_input',
    'done',
    'cancelled'
  ));

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'medium'
    CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  ADD COLUMN IF NOT EXISTS auto_submit BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS auto_accept BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS auto_redispatch_on_return BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1
    CHECK (revision > 0),
  ADD COLUMN IF NOT EXISTS needs_input_prompt TEXT,
  ADD COLUMN IF NOT EXISTS blocked_reason TEXT,
  ADD COLUMN IF NOT EXISTS paused_reason TEXT,
  ADD COLUMN IF NOT EXISTS execution_claim_token UUID,
  ADD COLUMN IF NOT EXISTS execution_claim_owner TEXT
    CHECK (
      execution_claim_owner IS NULL
      OR length(btrim(execution_claim_owner)) BETWEEN 1 AND 180
    ),
  ADD COLUMN IF NOT EXISTS execution_claim_expires_at TIMESTAMPTZ;

ALTER TABLE tasks
  DROP CONSTRAINT IF EXISTS tasks_claim_fields_check;

ALTER TABLE tasks
  ADD CONSTRAINT tasks_claim_fields_check
  CHECK (
    (execution_claim_token IS NULL
      AND execution_claim_owner IS NULL
      AND execution_claim_expires_at IS NULL)
    OR
    (execution_claim_token IS NOT NULL
      AND execution_claim_owner IS NOT NULL
      AND execution_claim_expires_at IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS tasks_execution_queue_idx
  ON tasks(
    project_id,
    priority,
    created_at,
    id
  )
  WHERE status IN ('queued', 'paused', 'blocked', 'needs_input');

CREATE INDEX IF NOT EXISTS tasks_active_claim_idx
  ON tasks(execution_claim_expires_at)
  WHERE execution_claim_token IS NOT NULL;

ALTER TABLE runs
  ADD COLUMN IF NOT EXISTS task_execution_kind TEXT NOT NULL DEFAULT 'owner'
    CHECK (task_execution_kind IN ('owner', 'collaborator')),
  ADD COLUMN IF NOT EXISTS task_trigger_message_id UUID;

ALTER TABLE runs
  DROP CONSTRAINT IF EXISTS runs_task_trigger_message_fkey;

ALTER TABLE runs
  ADD CONSTRAINT runs_task_trigger_message_fkey
    FOREIGN KEY (task_trigger_message_id)
    REFERENCES task_messages(id)
    ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS runs_task_trigger_message_idx
  ON runs(task_trigger_message_id)
  WHERE task_trigger_message_id IS NOT NULL;

ALTER TABLE task_messages
  ADD COLUMN IF NOT EXISTS delivery_target TEXT
    CHECK (
      delivery_target IS NULL
      OR delivery_target IN ('receiver', 'collaborators', 'broadcast')
    ),
  ADD COLUMN IF NOT EXISTS mention_agent_ids UUID[] NOT NULL DEFAULT '{}'::uuid[],
  ADD COLUMN IF NOT EXISTS triggered_run_ids UUID[] NOT NULL DEFAULT '{}'::uuid[];

CREATE INDEX IF NOT EXISTS task_messages_delivery_target_idx
  ON task_messages(task_id, delivery_target, created_at)
  WHERE delivery_target IS NOT NULL;

ALTER TABLE task_attachments
  ADD COLUMN IF NOT EXISTS document_path TEXT;

UPDATE task_attachments
SET document_path = 'documents/' || id::text || '/content'
WHERE document_path IS NULL;

ALTER TABLE task_attachments
  ALTER COLUMN document_path SET NOT NULL;

ALTER TABLE task_attachments
  DROP CONSTRAINT IF EXISTS task_attachments_document_path_check;

ALTER TABLE task_attachments
  ADD CONSTRAINT task_attachments_document_path_check
  CHECK (
    length(document_path) BETWEEN 1 AND 800
    AND document_path !~ '(^|/)\\.\\.?(/|$)'
    AND document_path !~ '^/'
    AND document_path !~ '\\\\'
  );

CREATE UNIQUE INDEX IF NOT EXISTS task_attachments_project_path_idx
  ON task_attachments(project_id, document_path);

ALTER TABLE scene_sessions
  ADD COLUMN IF NOT EXISTS reset_reason TEXT,
  ADD COLUMN IF NOT EXISTS reset_by TEXT
    CHECK (
      reset_by IS NULL
      OR length(btrim(reset_by)) BETWEEN 1 AND 180
    ),
  ADD COLUMN IF NOT EXISTS reset_at TIMESTAMPTZ;

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
    'transfer',
    'claim',
    'control',
    'input',
    'session'
  ));
`;

export const RUNTIME_ECONOMICS_SCHEMA_SQL = `
ALTER TABLE external_runtimes
  ADD COLUMN IF NOT EXISTS workspace_id TEXT
    CHECK (
      workspace_id IS NULL
      OR (
        length(workspace_id) BETWEEN 1 AND 180
        AND workspace_id !~ '(^|/)\\\\.\\\\.?(/|$)'
        AND workspace_id !~ '^/'
        AND workspace_id !~ '\\\\\\\\'
      )
    );

ALTER TABLE external_runtimes
  DROP CONSTRAINT IF EXISTS external_runtimes_visibility_check,
  DROP CONSTRAINT IF EXISTS external_runtimes_workspace_visibility_check;

ALTER TABLE external_runtimes
  ADD CONSTRAINT external_runtimes_visibility_check
    CHECK (visibility IN ('platform', 'workspace', 'owner')),
  ADD CONSTRAINT external_runtimes_workspace_visibility_check
    CHECK (visibility <> 'workspace' OR workspace_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS external_runtimes_workspace_visibility_idx
  ON external_runtimes(workspace_id, status, updated_at DESC)
  WHERE visibility = 'workspace';

CREATE INDEX IF NOT EXISTS runs_execution_workspace_created_idx
  ON runs(
    (
      COALESCE(
        execution_envelope_snapshot ->> 'workspaceId',
        project_id::text
      )
    ),
    created_at DESC,
    id DESC
  );

CREATE TABLE IF NOT EXISTS run_runtime_usage_receipts (
  id UUID PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  run_attempt INTEGER NOT NULL CHECK (run_attempt > 0),
  job_id UUID REFERENCES jobs(id) ON DELETE SET NULL,
  job_attempt INTEGER CHECK (job_attempt IS NULL OR job_attempt > 0),
  workspace_id TEXT NOT NULL
    CHECK (length(btrim(workspace_id)) BETWEEN 1 AND 180),
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  context_type TEXT NOT NULL
    CHECK (context_type IN ('task', 'workflow-task', 'meeting', 'direct-chat')),
  context_id TEXT NOT NULL
    CHECK (length(btrim(context_id)) BETWEEN 1 AND 240),
  runtime_id TEXT NOT NULL
    CHECK (length(btrim(runtime_id)) BETWEEN 1 AND 180),
  runtime_revision INTEGER
    CHECK (runtime_revision IS NULL OR runtime_revision > 0),
  provider TEXT
    CHECK (provider IS NULL OR length(btrim(provider)) BETWEEN 1 AND 120),
  model TEXT
    CHECK (model IS NULL OR length(btrim(model)) BETWEEN 1 AND 160),
  input_tokens BIGINT CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens BIGINT CHECK (output_tokens IS NULL OR output_tokens >= 0),
  total_tokens BIGINT CHECK (total_tokens IS NULL OR total_tokens >= 0),
  cached_input_tokens BIGINT
    CHECK (cached_input_tokens IS NULL OR cached_input_tokens >= 0),
  reasoning_tokens BIGINT
    CHECK (reasoning_tokens IS NULL OR reasoning_tokens >= 0),
  cost_amount NUMERIC(20, 8)
    CHECK (cost_amount IS NULL OR cost_amount >= 0),
  cost_currency TEXT
    CHECK (
      cost_currency IS NULL
      OR length(btrim(cost_currency)) BETWEEN 1 AND 12
    ),
  usage_source TEXT NOT NULL
    CHECK (usage_source IN (
      'runtime-reported',
      'derived',
      'unavailable',
      'mixed'
    )),
  unknown_fields TEXT[] NOT NULL DEFAULT '{}'::text[],
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  payload_digest TEXT NOT NULL CHECK (payload_digest ~ '^[a-f0-9]{64}$'),
  recorded_at TIMESTAMPTZ NOT NULL,
  UNIQUE (run_id, run_attempt),
  CHECK (
    (cost_amount IS NULL AND cost_currency IS NULL)
    OR (cost_amount IS NOT NULL AND cost_currency IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS run_runtime_usage_workspace_idx
  ON run_runtime_usage_receipts(
    workspace_id,
    recorded_at DESC,
    runtime_id
  );

CREATE INDEX IF NOT EXISTS run_runtime_usage_run_idx
  ON run_runtime_usage_receipts(run_id, run_attempt);

CREATE UNIQUE INDEX IF NOT EXISTS runtime_usage_outbox_idempotency_idx
  ON domain_outbox(
    (payload ->> 'runId'),
    (payload ->> 'runAttempt')
  )
  WHERE topic = 'runtime.usage.recorded';

CREATE OR REPLACE FUNCTION pluginmax_reject_runtime_usage_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'runtime usage receipts are immutable';
END;
$$;

DROP TRIGGER IF EXISTS run_runtime_usage_receipts_immutable
  ON run_runtime_usage_receipts;
CREATE TRIGGER run_runtime_usage_receipts_immutable
BEFORE UPDATE OR DELETE ON run_runtime_usage_receipts
FOR EACH ROW
EXECUTE FUNCTION pluginmax_reject_runtime_usage_mutation();
`;

export const AI_TEAMMATE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS teammate_templates (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  workspace_id TEXT NOT NULL
    CHECK (length(btrim(workspace_id)) BETWEEN 1 AND 180),
  scope TEXT NOT NULL CHECK (scope IN ('platform', 'personal')),
  owner_principal_id TEXT REFERENCES principals(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled', 'archived')),
  current_version INTEGER NOT NULL CHECK (current_version > 0),
  definition JSONB NOT NULL
    CHECK (jsonb_typeof(definition) = 'object'),
  created_by TEXT NOT NULL
    CHECK (length(btrim(created_by)) BETWEEN 1 AND 180),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (updated_at >= created_at),
  CHECK (scope <> 'personal' OR owner_principal_id IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS teammate_templates_active_name_idx
  ON teammate_templates(
    workspace_id,
    scope,
    lower(btrim(definition ->> 'name'))
  )
  WHERE status <> 'archived';

CREATE INDEX IF NOT EXISTS teammate_templates_project_idx
  ON teammate_templates(project_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS teammate_template_versions (
  id UUID PRIMARY KEY,
  template_id UUID NOT NULL
    REFERENCES teammate_templates(id) ON DELETE RESTRICT,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version > 0),
  definition JSONB NOT NULL
    CHECK (jsonb_typeof(definition) = 'object'),
  content_digest TEXT NOT NULL
    CHECK (content_digest ~ '^[a-f0-9]{64}$'),
  created_by TEXT NOT NULL
    CHECK (length(btrim(created_by)) BETWEEN 1 AND 180),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (template_id, version)
);

CREATE INDEX IF NOT EXISTS teammate_template_versions_template_idx
  ON teammate_template_versions(template_id, version DESC);

CREATE OR REPLACE FUNCTION pluginmax_reject_teammate_template_version_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'teammate template versions are immutable';
END;
$$;

DROP TRIGGER IF EXISTS teammate_template_versions_immutable
  ON teammate_template_versions;
CREATE TRIGGER teammate_template_versions_immutable
BEFORE UPDATE OR DELETE ON teammate_template_versions
FOR EACH ROW
EXECUTE FUNCTION pluginmax_reject_teammate_template_version_mutation();

CREATE TABLE IF NOT EXISTS teammates (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  workspace_id TEXT NOT NULL
    CHECK (length(btrim(workspace_id)) BETWEEN 1 AND 180),
  template_id UUID NOT NULL
    REFERENCES teammate_templates(id) ON DELETE RESTRICT,
  template_version_id UUID NOT NULL
    REFERENCES teammate_template_versions(id) ON DELETE RESTRICT,
  template_version INTEGER NOT NULL CHECK (template_version > 0),
  agent_id UUID NOT NULL UNIQUE REFERENCES agents(id) ON DELETE RESTRICT,
  ai_principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  owner_principal_id TEXT NOT NULL
    REFERENCES principals(id) ON DELETE RESTRICT,
  name TEXT NOT NULL
    CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'inactive', 'archived')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  auto_execute BOOLEAN NOT NULL DEFAULT FALSE,
  auto_run_lease_token UUID,
  auto_run_lease_expires_at TIMESTAMPTZ,
  created_by TEXT NOT NULL
    CHECK (length(btrim(created_by)) BETWEEN 1 AND 180),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (updated_at >= created_at),
  CHECK (
    (auto_run_lease_token IS NULL AND auto_run_lease_expires_at IS NULL)
    OR
    (auto_run_lease_token IS NOT NULL AND auto_run_lease_expires_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS teammates_active_name_idx
  ON teammates(workspace_id, lower(btrim(name)))
  WHERE status <> 'archived';

CREATE INDEX IF NOT EXISTS teammates_project_status_idx
  ON teammates(project_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS teammates_owner_idx
  ON teammates(owner_principal_id, status);

CREATE INDEX IF NOT EXISTS teammates_auto_execute_idx
  ON teammates(auto_run_lease_expires_at, updated_at)
  WHERE status = 'active' AND auto_execute = TRUE;

CREATE OR REPLACE FUNCTION pluginmax_assert_teammate_template_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  template_project_id UUID;
  template_workspace_id TEXT;
  template_scope TEXT;
  template_status TEXT;
  version_number INTEGER;
  version_project_id UUID;
BEGIN
  SELECT project_id, workspace_id, scope, status
    INTO template_project_id, template_workspace_id, template_scope,
         template_status
  FROM teammate_templates
  WHERE id = NEW.template_id;

  SELECT version, project_id
    INTO version_number, version_project_id
  FROM teammate_template_versions
  WHERE id = NEW.template_version_id
    AND template_id = NEW.template_id;

  IF template_project_id IS DISTINCT FROM NEW.project_id
    OR template_workspace_id IS DISTINCT FROM NEW.workspace_id
    OR version_project_id IS DISTINCT FROM NEW.project_id
    OR version_number IS DISTINCT FROM NEW.template_version
  THEN
    RAISE EXCEPTION 'teammate template version does not match instance scope';
  END IF;
  IF template_status = 'archived' AND TG_OP = 'INSERT' THEN
    RAISE EXCEPTION 'archived teammate template cannot create an instance';
  END IF;
  IF template_scope = 'personal' AND TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM teammate_templates
      WHERE id = NEW.template_id
        AND owner_principal_id = NEW.created_by
    ) THEN
      RAISE EXCEPTION 'personal teammate template requires its owner';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS teammates_template_version_matches
  ON teammates;
CREATE TRIGGER teammates_template_version_matches
BEFORE INSERT OR UPDATE OF template_id, template_version_id, template_version,
  project_id, workspace_id
ON teammates
FOR EACH ROW
EXECUTE FUNCTION pluginmax_assert_teammate_template_version();

CREATE TABLE IF NOT EXISTS teammate_transfers (
  id UUID PRIMARY KEY,
  teammate_id UUID NOT NULL REFERENCES teammates(id) ON DELETE RESTRICT,
  from_owner_principal_id TEXT NOT NULL
    REFERENCES principals(id) ON DELETE RESTRICT,
  to_owner_principal_id TEXT NOT NULL
    REFERENCES principals(id) ON DELETE RESTRICT,
  transferred_by_principal_id TEXT NOT NULL
    REFERENCES principals(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 4000),
  created_at TIMESTAMPTZ NOT NULL,
  CHECK (from_owner_principal_id <> to_owner_principal_id)
);

CREATE INDEX IF NOT EXISTS teammate_transfers_teammate_idx
  ON teammate_transfers(teammate_id, created_at DESC);

CREATE OR REPLACE FUNCTION pluginmax_reject_teammate_transfer_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'teammate transfers are append-only';
END;
$$;

DROP TRIGGER IF EXISTS teammate_transfers_append_only
  ON teammate_transfers;
CREATE TRIGGER teammate_transfers_append_only
BEFORE UPDATE OR DELETE ON teammate_transfers
FOR EACH ROW
EXECUTE FUNCTION pluginmax_reject_teammate_transfer_mutation();

CREATE TABLE IF NOT EXISTS teammate_events (
  id UUID PRIMARY KEY,
  teammate_id UUID NOT NULL REFERENCES teammates(id) ON DELETE RESTRICT,
  seq BIGINT NOT NULL CHECK (seq > 0),
  kind TEXT NOT NULL CHECK (kind IN (
    'created',
    'template',
    'status',
    'transfer',
    'work-plan',
    'queue',
    'auto-run',
    'report',
    'archive'
  )),
  actor_principal_id TEXT NOT NULL
    CHECK (length(btrim(actor_principal_id)) BETWEEN 1 AND 180),
  summary TEXT NOT NULL CHECK (length(btrim(summary)) BETWEEN 1 AND 4000),
  data JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(data) = 'object'),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (teammate_id, seq)
);

CREATE INDEX IF NOT EXISTS teammate_events_teammate_idx
  ON teammate_events(teammate_id, created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION pluginmax_reject_teammate_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'teammate events are append-only';
END;
$$;

DROP TRIGGER IF EXISTS teammate_events_append_only ON teammate_events;
CREATE TRIGGER teammate_events_append_only
BEFORE UPDATE OR DELETE ON teammate_events
FOR EACH ROW
EXECUTE FUNCTION pluginmax_reject_teammate_event_mutation();

CREATE TABLE IF NOT EXISTS teammate_work_plans (
  id UUID PRIMARY KEY,
  teammate_id UUID NOT NULL REFERENCES teammates(id) ON DELETE RESTRICT,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  instruction TEXT NOT NULL CHECK (length(btrim(instruction)) BETWEEN 1 AND 20000),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived')),
  created_by TEXT NOT NULL
    CHECK (length(btrim(created_by)) BETWEEN 1 AND 180),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS teammate_work_plans_teammate_idx
  ON teammate_work_plans(teammate_id, created_at DESC);

CREATE TABLE IF NOT EXISTS teammate_work_items (
  id UUID PRIMARY KEY,
  teammate_id UUID NOT NULL REFERENCES teammates(id) ON DELETE RESTRICT,
  plan_id UUID REFERENCES teammate_work_plans(id) ON DELETE RESTRICT,
  task_id UUID NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE RESTRICT,
  queue_seq INTEGER NOT NULL CHECK (queue_seq > 0),
  auto_execute_eligible BOOLEAN NOT NULL DEFAULT FALSE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(metadata) = 'object'),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'removed')),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS teammate_work_items_queue_seq_idx
  ON teammate_work_items(teammate_id, queue_seq)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS teammate_work_items_teammate_idx
  ON teammate_work_items(teammate_id, status, queue_seq);

CREATE TABLE IF NOT EXISTS teammate_run_attributions (
  id UUID PRIMARY KEY,
  run_id UUID NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
  teammate_id UUID NOT NULL REFERENCES teammates(id) ON DELETE RESTRICT,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  template_id UUID NOT NULL REFERENCES teammate_templates(id) ON DELETE RESTRICT,
  template_version_id UUID NOT NULL
    REFERENCES teammate_template_versions(id) ON DELETE RESTRICT,
  template_version INTEGER NOT NULL CHECK (template_version > 0),
  ai_principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  owner_principal_id TEXT NOT NULL
    REFERENCES principals(id) ON DELETE RESTRICT,
  scene_session_id UUID REFERENCES scene_sessions(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS teammate_run_attributions_teammate_idx
  ON teammate_run_attributions(teammate_id, created_at DESC);

CREATE INDEX IF NOT EXISTS teammate_run_attributions_principal_idx
  ON teammate_run_attributions(ai_principal_id, created_at DESC);

CREATE OR REPLACE FUNCTION pluginmax_reject_teammate_run_attribution_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.scene_session_id IS NULL
    AND NEW.scene_session_id IS NOT NULL
    AND OLD.id = NEW.id
    AND OLD.run_id = NEW.run_id
    AND OLD.teammate_id = NEW.teammate_id
    AND OLD.project_id = NEW.project_id
    AND OLD.template_id = NEW.template_id
    AND OLD.template_version_id = NEW.template_version_id
    AND OLD.template_version = NEW.template_version
    AND OLD.ai_principal_id = NEW.ai_principal_id
    AND OLD.owner_principal_id = NEW.owner_principal_id
    AND OLD.created_at = NEW.created_at
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'teammate run attributions are immutable';
END;
$$;

DROP TRIGGER IF EXISTS teammate_run_attributions_immutable
  ON teammate_run_attributions;
CREATE TRIGGER teammate_run_attributions_immutable
BEFORE UPDATE ON teammate_run_attributions
FOR EACH ROW
EXECUTE FUNCTION pluginmax_reject_teammate_run_attribution_mutation();

CREATE TABLE IF NOT EXISTS teammate_weekly_reports (
  id UUID PRIMARY KEY,
  teammate_id UUID NOT NULL REFERENCES teammates(id) ON DELETE RESTRICT,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  week_start DATE NOT NULL,
  week_end DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'generated'
    CHECK (status IN ('generated', 'stale')),
  summary JSONB NOT NULL CHECK (jsonb_typeof(summary) = 'object'),
  statistics JSONB NOT NULL CHECK (jsonb_typeof(statistics) = 'object'),
  generated_by TEXT NOT NULL
    CHECK (length(btrim(generated_by)) BETWEEN 1 AND 180),
  generated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (teammate_id, week_start),
  CHECK (week_end >= week_start)
);

CREATE INDEX IF NOT EXISTS teammate_weekly_reports_project_idx
  ON teammate_weekly_reports(project_id, week_start DESC);

ALTER TABLE runtime_maintenance_runs
  DROP CONSTRAINT IF EXISTS runtime_maintenance_runs_kind_check;
ALTER TABLE runtime_maintenance_runs
  ADD CONSTRAINT runtime_maintenance_runs_kind_check
  CHECK (kind IN (
    'idempotency_cleanup',
    'approval_sla',
    'lease_recovery',
    'effect_recovery',
    'teammate_queue'
  ));

ALTER TABLE runtime_maintenance_schedules
  DROP CONSTRAINT IF EXISTS runtime_maintenance_schedules_kind_check;
ALTER TABLE runtime_maintenance_schedules
  ADD CONSTRAINT runtime_maintenance_schedules_kind_check
  CHECK (kind IN (
    'idempotency_cleanup',
    'approval_sla',
    'lease_recovery',
    'effect_recovery',
    'teammate_queue'
  ));

INSERT INTO runtime_maintenance_schedules (
  kind, enabled, interval_seconds, next_run_at,
  consecutive_failures, created_at, updated_at
) VALUES (
  'teammate_queue', TRUE, 60, NOW(), 0, NOW(), NOW()
)
ON CONFLICT (kind) DO NOTHING;
`;

export const MEETING_COLLABORATION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meeting_collaboration_states (
  meeting_id UUID PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  facilitator_principal_id TEXT NOT NULL
    CHECK (length(btrim(facilitator_principal_id)) BETWEEN 1 AND 180),
  lifecycle_status TEXT NOT NULL DEFAULT 'active'
    CHECK (lifecycle_status IN ('active', 'archived')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  facilitator_assigned_by TEXT
    CHECK (
      facilitator_assigned_by IS NULL
      OR length(btrim(facilitator_assigned_by)) BETWEEN 1 AND 180
    ),
  facilitator_assigned_at TIMESTAMPTZ NOT NULL,
  archived_by TEXT
    CHECK (
      archived_by IS NULL
      OR length(btrim(archived_by)) BETWEEN 1 AND 180
    ),
  archived_at TIMESTAMPTZ,
  archive_reason TEXT
    CHECK (archive_reason IS NULL OR length(btrim(archive_reason)) <= 4000),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (
    (lifecycle_status = 'active'
      AND archived_by IS NULL
      AND archived_at IS NULL
      AND archive_reason IS NULL)
    OR
    (lifecycle_status = 'archived'
      AND archived_by IS NOT NULL
      AND archived_at IS NOT NULL
      AND archive_reason IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS meeting_collaboration_states_project_idx
  ON meeting_collaboration_states(project_id, lifecycle_status, updated_at DESC);

CREATE OR REPLACE FUNCTION pluginmax_guard_meeting_collaboration_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.meeting_id IS DISTINCT FROM NEW.meeting_id
    OR OLD.project_id IS DISTINCT FROM NEW.project_id
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
  THEN
    RAISE EXCEPTION 'meeting collaboration identity is immutable';
  END IF;
  IF NEW.revision < OLD.revision
    OR (OLD.lifecycle_status = 'archived'
      AND NEW.lifecycle_status = 'active'
      AND NEW.archived_at IS NOT NULL)
  THEN
    RAISE EXCEPTION 'meeting collaboration revision cannot move backwards';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS meeting_collaboration_states_identity_guard
  ON meeting_collaboration_states;
CREATE TRIGGER meeting_collaboration_states_identity_guard
BEFORE UPDATE ON meeting_collaboration_states
FOR EACH ROW
EXECUTE FUNCTION pluginmax_guard_meeting_collaboration_identity();

CREATE TABLE IF NOT EXISTS meeting_facilitator_handoffs (
  id UUID PRIMARY KEY,
  meeting_id UUID NOT NULL
    REFERENCES meeting_collaboration_states(meeting_id) ON DELETE CASCADE,
  from_principal_id TEXT
    CHECK (
      from_principal_id IS NULL
      OR length(btrim(from_principal_id)) BETWEEN 1 AND 180
    ),
  to_principal_id TEXT NOT NULL
    CHECK (length(btrim(to_principal_id)) BETWEEN 1 AND 180),
  actor_principal_id TEXT NOT NULL
    CHECK (length(btrim(actor_principal_id)) BETWEEN 1 AND 180),
  reason TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 4000),
  resulting_revision INTEGER NOT NULL CHECK (resulting_revision > 0),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (meeting_id, resulting_revision)
);

CREATE INDEX IF NOT EXISTS meeting_facilitator_handoffs_meeting_idx
  ON meeting_facilitator_handoffs(meeting_id, resulting_revision DESC);

CREATE OR REPLACE FUNCTION pluginmax_reject_meeting_handoff_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'meeting facilitator handoffs are append-only';
END;
$$;

DROP TRIGGER IF EXISTS meeting_facilitator_handoffs_append_only
  ON meeting_facilitator_handoffs;
CREATE TRIGGER meeting_facilitator_handoffs_append_only
BEFORE UPDATE OR DELETE ON meeting_facilitator_handoffs
FOR EACH ROW
EXECUTE FUNCTION pluginmax_reject_meeting_handoff_mutation();

CREATE TABLE IF NOT EXISTS meeting_delegates (
  id UUID PRIMARY KEY,
  meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  delegator_principal_id TEXT NOT NULL
    CHECK (length(btrim(delegator_principal_id)) BETWEEN 1 AND 180),
  representative_kind TEXT NOT NULL
    CHECK (representative_kind IN ('human', 'agent')),
  representative_principal_id TEXT NOT NULL
    CHECK (length(btrim(representative_principal_id)) BETWEEN 1 AND 180),
  agent_id UUID REFERENCES agents(id) ON DELETE RESTRICT,
  allowed_actions TEXT[] NOT NULL DEFAULT ARRAY['speak']::text[]
    CHECK (
      cardinality(allowed_actions) > 0
      AND allowed_actions <@ ARRAY[
        'speak',
        'read_private',
        'attach_file',
        'summarize'
      ]::text[]
    ),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked', 'expired')),
  reason TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 4000),
  expires_at TIMESTAMPTZ,
  created_by TEXT NOT NULL
    CHECK (length(btrim(created_by)) BETWEEN 1 AND 180),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  revoked_by TEXT
    CHECK (
      revoked_by IS NULL
      OR length(btrim(revoked_by)) BETWEEN 1 AND 180
    ),
  revoked_at TIMESTAMPTZ,
  CHECK (
    (representative_kind = 'agent' AND agent_id IS NOT NULL)
    OR (representative_kind = 'human' AND agent_id IS NULL)
  ),
  CHECK (
    (status = 'revoked' AND revoked_by IS NOT NULL AND revoked_at IS NOT NULL)
    OR (status <> 'revoked' AND revoked_by IS NULL AND revoked_at IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS meeting_delegates_active_scope_idx
  ON meeting_delegates(
    meeting_id,
    delegator_principal_id,
    representative_principal_id
  )
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS meeting_delegates_meeting_idx
  ON meeting_delegates(meeting_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS meeting_delegates_representative_idx
  ON meeting_delegates(representative_principal_id, status);

CREATE TABLE IF NOT EXISTS meeting_private_briefings (
  id UUID PRIMARY KEY,
  meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner_principal_id TEXT NOT NULL
    CHECK (length(btrim(owner_principal_id)) BETWEEN 1 AND 180),
  audience_principal_id TEXT NOT NULL
    CHECK (length(btrim(audience_principal_id)) BETWEEN 1 AND 180),
  audience_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  content TEXT NOT NULL CHECK (length(btrim(content)) BETWEEN 1 AND 20000),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by TEXT NOT NULL
    CHECK (length(btrim(created_by)) BETWEEN 1 AND 180),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS meeting_private_briefings_owner_idx
  ON meeting_private_briefings(
    meeting_id,
    owner_principal_id,
    status,
    updated_at DESC
  );

CREATE INDEX IF NOT EXISTS meeting_private_briefings_audience_idx
  ON meeting_private_briefings(
    meeting_id,
    audience_principal_id,
    status,
    updated_at DESC
  );

CREATE INDEX IF NOT EXISTS meeting_private_briefings_agent_idx
  ON meeting_private_briefings(audience_agent_id, status)
  WHERE audience_agent_id IS NOT NULL;

ALTER TABLE meeting_messages
  ADD COLUMN IF NOT EXISTS client_message_id TEXT
    CHECK (
      client_message_id IS NULL
      OR (
        length(btrim(client_message_id)) BETWEEN 1 AND 160
        AND client_message_id ~ '^[a-zA-Z0-9_.:-]+$'
      )
    ),
  ADD COLUMN IF NOT EXISTS delegate_id UUID
    REFERENCES meeting_delegates(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS sender_principal_id TEXT
    CHECK (
      sender_principal_id IS NULL
      OR length(btrim(sender_principal_id)) BETWEEN 1 AND 180
    );

CREATE UNIQUE INDEX IF NOT EXISTS meeting_messages_client_id_idx
  ON meeting_messages(meeting_id, client_message_id)
  WHERE client_message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS meeting_message_deliveries (
  id UUID PRIMARY KEY,
  meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  message_id UUID NOT NULL REFERENCES meeting_messages(id) ON DELETE CASCADE,
  recipient_principal_id TEXT NOT NULL
    CHECK (length(btrim(recipient_principal_id)) BETWEEN 1 AND 180),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'delivered', 'read', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  idempotency_key TEXT NOT NULL
    CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 240),
  last_error TEXT CHECK (last_error IS NULL OR length(last_error) <= 4000),
  delivered_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (message_id, recipient_principal_id),
  UNIQUE (message_id, idempotency_key),
  CHECK (
    (status = 'pending' AND delivered_at IS NULL AND read_at IS NULL)
    OR (status = 'failed' AND delivered_at IS NULL AND read_at IS NULL)
    OR (status = 'delivered'
      AND delivered_at IS NOT NULL
      AND read_at IS NULL)
    OR (status = 'read'
      AND delivered_at IS NOT NULL
      AND read_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS meeting_message_deliveries_recipient_idx
  ON meeting_message_deliveries(
    recipient_principal_id,
    status,
    updated_at DESC
  );

CREATE INDEX IF NOT EXISTS meeting_message_deliveries_message_idx
  ON meeting_message_deliveries(message_id, status);

CREATE OR REPLACE FUNCTION pluginmax_guard_meeting_delivery_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'meeting deliveries cannot be deleted';
  END IF;
  IF OLD.id IS DISTINCT FROM NEW.id
    OR OLD.meeting_id IS DISTINCT FROM NEW.meeting_id
    OR OLD.message_id IS DISTINCT FROM NEW.message_id
    OR OLD.recipient_principal_id IS DISTINCT FROM NEW.recipient_principal_id
    OR OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
  THEN
    RAISE EXCEPTION 'meeting delivery identity is immutable';
  END IF;
  IF OLD.status = 'read' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'read meeting deliveries are terminal';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS meeting_message_deliveries_identity_guard
  ON meeting_message_deliveries;
CREATE TRIGGER meeting_message_deliveries_identity_guard
BEFORE UPDATE OR DELETE ON meeting_message_deliveries
FOR EACH ROW
EXECUTE FUNCTION pluginmax_guard_meeting_delivery_identity();

CREATE TABLE IF NOT EXISTS meeting_read_positions (
  meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  principal_id TEXT NOT NULL
    CHECK (length(btrim(principal_id)) BETWEEN 1 AND 180),
  last_read_message_id UUID
    REFERENCES meeting_messages(id) ON DELETE SET NULL,
  last_read_at TIMESTAMPTZ NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (meeting_id, principal_id)
);

CREATE TABLE IF NOT EXISTS meeting_files (
  id UUID PRIMARY KEY,
  meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 240),
  mime_type TEXT NOT NULL CHECK (length(btrim(mime_type)) BETWEEN 1 AND 160),
  size BIGINT NOT NULL CHECK (size >= 0),
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  storage_key TEXT NOT NULL
    CHECK (
      length(storage_key) BETWEEN 1 AND 800
      AND storage_key !~ '(^|/)\\.\\.?(/|$)'
      AND storage_key !~ '^/'
      AND storage_key !~ '\\\\'
    ),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived')),
  uploaded_by TEXT NOT NULL
    CHECK (length(btrim(uploaded_by)) BETWEEN 1 AND 180),
  archived_by TEXT
    CHECK (
      archived_by IS NULL
      OR length(btrim(archived_by)) BETWEEN 1 AND 180
    ),
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  CHECK (
    (status = 'active' AND archived_by IS NULL AND archived_at IS NULL)
    OR (status = 'archived'
      AND archived_by IS NOT NULL
      AND archived_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS meeting_files_meeting_idx
  ON meeting_files(meeting_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS meeting_minutes_confirmations (
  version_id UUID PRIMARY KEY
    REFERENCES meeting_minutes_versions(id) ON DELETE RESTRICT,
  meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  confirmed_by TEXT NOT NULL
    CHECK (length(btrim(confirmed_by)) BETWEEN 1 AND 180),
  note TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 4000),
  confirmed_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS meeting_minutes_confirmations_meeting_idx
  ON meeting_minutes_confirmations(meeting_id, confirmed_at DESC);

CREATE OR REPLACE FUNCTION pluginmax_reject_minutes_confirmation_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'meeting minutes confirmations are immutable';
END;
$$;

DROP TRIGGER IF EXISTS meeting_minutes_confirmations_immutable
  ON meeting_minutes_confirmations;
CREATE TRIGGER meeting_minutes_confirmations_immutable
BEFORE UPDATE OR DELETE ON meeting_minutes_confirmations
FOR EACH ROW
EXECUTE FUNCTION pluginmax_reject_minutes_confirmation_mutation();

CREATE TABLE IF NOT EXISTS meeting_tasks (
  id UUID PRIMARY KEY,
  meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id UUID NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE RESTRICT,
  source_type TEXT NOT NULL
    CHECK (source_type IN (
      'manual',
      'message',
      'minutes_version',
      'action_item'
    )),
  source_id TEXT NOT NULL CHECK (length(btrim(source_id)) BETWEEN 1 AND 180),
  idempotency_key TEXT NOT NULL
    CHECK (
      length(btrim(idempotency_key)) BETWEEN 1 AND 200
      AND idempotency_key ~ '^[a-zA-Z0-9_.:-]+$'
    ),
  created_by TEXT NOT NULL
    CHECK (length(btrim(created_by)) BETWEEN 1 AND 180),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (meeting_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS meeting_tasks_meeting_idx
  ON meeting_tasks(meeting_id, created_at DESC);

CREATE OR REPLACE FUNCTION pluginmax_reject_meeting_task_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'meeting task links are immutable';
END;
$$;

DROP TRIGGER IF EXISTS meeting_tasks_immutable ON meeting_tasks;
CREATE TRIGGER meeting_tasks_immutable
BEFORE UPDATE OR DELETE ON meeting_tasks
FOR EACH ROW
EXECUTE FUNCTION pluginmax_reject_meeting_task_mutation();

CREATE TABLE IF NOT EXISTS meeting_collaboration_events (
  id UUID PRIMARY KEY,
  meeting_id UUID NOT NULL
    REFERENCES meeting_collaboration_states(meeting_id) ON DELETE CASCADE,
  seq BIGINT NOT NULL CHECK (seq > 0),
  kind TEXT NOT NULL CHECK (kind IN (
    'facilitator',
    'delegate',
    'private-briefing',
    'delivery',
    'archive',
    'restore',
    'file',
    'minutes',
    'task',
    'read-position'
  )),
  actor_principal_id TEXT NOT NULL
    CHECK (length(btrim(actor_principal_id)) BETWEEN 1 AND 180),
  summary TEXT NOT NULL CHECK (length(btrim(summary)) BETWEEN 1 AND 4000),
  data JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(data) = 'object'),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (meeting_id, seq)
);

CREATE INDEX IF NOT EXISTS meeting_collaboration_events_meeting_idx
  ON meeting_collaboration_events(meeting_id, created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION pluginmax_reject_meeting_collaboration_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'meeting collaboration events are append-only';
END;
$$;

DROP TRIGGER IF EXISTS meeting_collaboration_events_append_only
  ON meeting_collaboration_events;
CREATE TRIGGER meeting_collaboration_events_append_only
BEFORE UPDATE OR DELETE ON meeting_collaboration_events
FOR EACH ROW
EXECUTE FUNCTION pluginmax_reject_meeting_collaboration_event_mutation();

INSERT INTO meeting_collaboration_states (
  meeting_id,
  project_id,
  facilitator_principal_id,
  lifecycle_status,
  revision,
  facilitator_assigned_by,
  facilitator_assigned_at,
  archived_by,
  archived_at,
  archive_reason,
  created_at,
  updated_at
)
SELECT
  meeting.id,
  meeting.project_id,
  COALESCE(
    NULLIF(
      (
        SELECT participant.value ->> 'id'
        FROM jsonb_array_elements(meeting.participants) AS participant(value)
        WHERE participant.value ->> 'kind' = 'human'
          AND participant.value ->> 'id'
            ~ '^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,179}$'
        LIMIT 1
      ),
      ''
    ),
    'local-admin'
  ),
  'active',
  1,
  NULL,
  meeting.created_at,
  NULL,
  NULL,
  NULL,
  meeting.created_at,
  meeting.updated_at
FROM meetings AS meeting
ON CONFLICT (meeting_id) DO NOTHING;

INSERT INTO meeting_facilitator_handoffs (
  id,
  meeting_id,
  from_principal_id,
  to_principal_id,
  actor_principal_id,
  reason,
  resulting_revision,
  created_at
)
SELECT
  gen_random_uuid(),
  state.meeting_id,
  NULL,
  state.facilitator_principal_id,
  state.facilitator_principal_id,
  'Batch 18 additive facilitator backfill',
  state.revision,
  state.created_at
FROM meeting_collaboration_states AS state
WHERE NOT EXISTS (
  SELECT 1
  FROM meeting_facilitator_handoffs AS handoff
  WHERE handoff.meeting_id = state.meeting_id
);

INSERT INTO meeting_collaboration_events (
  id,
  meeting_id,
  seq,
  kind,
  actor_principal_id,
  summary,
  data,
  created_at
)
SELECT
  gen_random_uuid(),
  state.meeting_id,
  1,
  'facilitator',
  state.facilitator_principal_id,
  'Facilitator initialized from the meeting creator',
  jsonb_build_object(
    'facilitatorPrincipalId',
    state.facilitator_principal_id
  ),
  state.created_at
FROM meeting_collaboration_states AS state
WHERE NOT EXISTS (
  SELECT 1
  FROM meeting_collaboration_events AS event
  WHERE event.meeting_id = state.meeting_id
);

INSERT INTO meeting_tasks (
  id,
  meeting_id,
  project_id,
  task_id,
  source_type,
  source_id,
  idempotency_key,
  created_by,
  created_at
)
SELECT
  gen_random_uuid(),
  item.meeting_id,
  item.project_id,
  item.task_id,
  'action_item',
  item.id::text,
  'action-item:' || item.id::text,
  COALESCE(item.converted_by, item.owner_actor_id),
  COALESCE(item.converted_at, item.updated_at)
FROM meeting_action_items AS item
WHERE item.task_id IS NOT NULL
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION pluginmax_seed_meeting_message_deliveries()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO meeting_message_deliveries (
    id,
    meeting_id,
    message_id,
    recipient_principal_id,
    status,
    attempts,
    idempotency_key,
    last_error,
    delivered_at,
    read_at,
    created_at,
    updated_at
  )
  SELECT
    gen_random_uuid(),
    NEW.meeting_id,
    NEW.id,
    recipients.principal_id,
    'delivered',
    1,
    'message:' || NEW.id::text || ':recipient:' || recipients.principal_id,
    NULL,
    NEW.created_at,
    NULL,
    NEW.created_at,
    NEW.created_at
  FROM (
    SELECT participant.value ->> 'id' AS principal_id
    FROM meetings AS meeting
    CROSS JOIN LATERAL jsonb_array_elements(meeting.participants)
      AS participant(value)
    WHERE meeting.id = NEW.meeting_id
      AND participant.value ->> 'kind' = 'human'
    UNION
    SELECT state.facilitator_principal_id
    FROM meeting_collaboration_states AS state
    WHERE state.meeting_id = NEW.meeting_id
      AND state.lifecycle_status = 'active'
    UNION
    SELECT delegate.representative_principal_id
    FROM meeting_delegates AS delegate
    WHERE delegate.meeting_id = NEW.meeting_id
      AND delegate.status = 'active'
      AND (delegate.expires_at IS NULL OR delegate.expires_at > NOW())
  ) AS recipients(principal_id)
  JOIN principals AS principal ON principal.id = recipients.principal_id
  WHERE principal.status = 'active'
    AND recipients.principal_id <> COALESCE(
      NEW.sender_principal_id,
      NEW.author_id
    )
  ON CONFLICT (message_id, recipient_principal_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS meeting_messages_seed_deliveries
  ON meeting_messages;
CREATE TRIGGER meeting_messages_seed_deliveries
AFTER INSERT ON meeting_messages
FOR EACH ROW
EXECUTE FUNCTION pluginmax_seed_meeting_message_deliveries();
`;

export const IDENTITY_ADMINISTRATION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY
    CHECK (
      length(id) BETWEEN 1 AND 180
      AND id ~ '^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$'
    ),
  display_name TEXT NOT NULL
    CHECK (length(btrim(display_name)) BETWEEN 1 AND 160),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived')),
  created_by_principal_id TEXT
    REFERENCES principals(id) ON DELETE SET NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS workspaces_status_name_idx
  ON workspaces(status, display_name, id);

ALTER TABLE workspace_members
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1
    CHECK (version > 0);

CREATE INDEX IF NOT EXISTS accounts_status_login_idx
  ON accounts(status, lower(login_id));

CREATE INDEX IF NOT EXISTS identity_audit_account_idx
  ON identity_audit_events(account_id, created_at DESC)
  WHERE account_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS identity_audit_action_idx
  ON identity_audit_events(action, created_at DESC);

INSERT INTO workspaces (
  id, display_name, status, created_by_principal_id, version,
  created_at, updated_at
)
SELECT
  workspace_ref.workspace_id,
  workspace_ref.workspace_id,
  'active',
  NULL,
  1,
  NOW(),
  NOW()
FROM (
  SELECT DISTINCT workspace_id
  FROM workspace_members
  UNION
  SELECT DISTINCT scope_id AS workspace_id
  FROM role_grants
  WHERE scope_type = 'workspace'
  UNION
  SELECT DISTINCT workspace_id
  FROM external_runtimes
  WHERE workspace_id IS NOT NULL
) AS workspace_ref
WHERE length(btrim(workspace_ref.workspace_id)) BETWEEN 1 AND 180
  AND workspace_ref.workspace_id ~ '^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$'
ON CONFLICT (id) DO NOTHING;
`;

export const SHARED_SPACE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS shared_space_roots (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE RESTRICT,
  storage_prefix TEXT NOT NULL UNIQUE
    CHECK (storage_prefix ~ '^shared/[a-f0-9]{32}$'),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived')),
  default_read BOOLEAN NOT NULL DEFAULT TRUE,
  default_write BOOLEAN NOT NULL DEFAULT FALSE CHECK (default_write = FALSE),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (updated_at >= created_at)
);

CREATE TABLE IF NOT EXISTS shared_space_policies (
  id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES shared_space_roots(workspace_id)
    ON DELETE RESTRICT,
  subject_kind TEXT NOT NULL
    CHECK (subject_kind IN ('principal', 'workspace-role')),
  subject_id TEXT NOT NULL CHECK (length(btrim(subject_id)) BETWEEN 1 AND 180),
  path_pattern TEXT NOT NULL
    CHECK (
      length(path_pattern) BETWEEN 1 AND 500
      AND path_pattern !~ '[\\\\\\x00-\\x1f\\x7f]'
      AND left(path_pattern, 1) <> '/'
      AND path_pattern !~ '(^|/)\\.\\.?(/|$)'
    ),
  permissions TEXT[] NOT NULL
    CHECK (
      cardinality(permissions) > 0
      AND permissions <@ ARRAY['list', 'read', 'write', 'delete']::text[]
    ),
  effect TEXT NOT NULL CHECK (effect IN ('allow', 'deny')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked')),
  expires_at TIMESTAMPTZ,
  created_by TEXT NOT NULL REFERENCES principals(id),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (expires_at IS NULL OR expires_at > created_at),
  CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS shared_space_policies_workspace_idx
  ON shared_space_policies(workspace_id, status, subject_kind, subject_id);

CREATE TABLE IF NOT EXISTS shared_space_entries (
  id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES shared_space_roots(workspace_id)
    ON DELETE RESTRICT,
  path TEXT NOT NULL
    CHECK (
      length(path) BETWEEN 1 AND 500
      AND path !~ '[\\\\\\x00-\\x1f\\x7f]'
      AND left(path, 1) <> '/'
      AND path !~ '(^|/)\\.\\.?(/|$)'
    ),
  kind TEXT NOT NULL CHECK (kind IN ('file', 'directory')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived')),
  current_version INTEGER NOT NULL DEFAULT 0 CHECK (current_version >= 0),
  sha256 TEXT CHECK (sha256 IS NULL OR sha256 ~ '^[a-f0-9]{64}$'),
  size BIGINT NOT NULL DEFAULT 0 CHECK (size >= 0),
  mime_type TEXT CHECK (
    mime_type IS NULL OR length(mime_type) BETWEEN 1 AND 180
  ),
  storage_key TEXT CHECK (
    storage_key IS NULL
    OR (
      length(storage_key) BETWEEN 1 AND 800
      AND storage_key !~ '[\\\\\\x00-\\x1f\\x7f]'
      AND left(storage_key, 1) <> '/'
    )
  ),
  created_by TEXT NOT NULL REFERENCES principals(id),
  updated_by TEXT NOT NULL REFERENCES principals(id),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (updated_at >= created_at),
  CHECK (
    (kind = 'directory' AND current_version = 0 AND sha256 IS NULL
      AND storage_key IS NULL AND mime_type IS NULL AND size = 0)
    OR
    (kind = 'file' AND current_version > 0 AND sha256 IS NOT NULL
      AND storage_key IS NOT NULL AND mime_type IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS shared_space_entries_workspace_path_idx
  ON shared_space_entries(workspace_id, lower(path));

CREATE INDEX IF NOT EXISTS shared_space_entries_directory_idx
  ON shared_space_entries(workspace_id, status, kind, path);

CREATE TABLE IF NOT EXISTS shared_space_versions (
  id UUID PRIMARY KEY,
  entry_id UUID NOT NULL REFERENCES shared_space_entries(id)
    ON DELETE RESTRICT,
  workspace_id TEXT NOT NULL REFERENCES shared_space_roots(workspace_id)
    ON DELETE RESTRICT,
  path TEXT NOT NULL CHECK (length(path) BETWEEN 1 AND 500),
  version INTEGER NOT NULL CHECK (version > 0),
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  size BIGINT NOT NULL CHECK (size >= 0),
  mime_type TEXT NOT NULL CHECK (length(mime_type) BETWEEN 1 AND 180),
  storage_key TEXT NOT NULL CHECK (
    length(storage_key) BETWEEN 1 AND 800
    AND storage_key !~ '[\\\\\\x00-\\x1f\\x7f]'
    AND left(storage_key, 1) <> '/'
  ),
  created_by TEXT NOT NULL REFERENCES principals(id),
  source_run_id UUID REFERENCES runs(id) ON DELETE SET NULL,
  ticket_id UUID REFERENCES action_tickets(id) ON DELETE SET NULL,
  gate_id UUID REFERENCES execution_gate_requests(gate_id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (entry_id, version)
);

CREATE INDEX IF NOT EXISTS shared_space_versions_workspace_idx
  ON shared_space_versions(workspace_id, created_at DESC);

CREATE OR REPLACE FUNCTION pluginmax_reject_shared_space_version_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'shared space versions are append-only';
END;
$$;

DROP TRIGGER IF EXISTS shared_space_versions_append_only
  ON shared_space_versions;
CREATE TRIGGER shared_space_versions_append_only
BEFORE UPDATE OR DELETE ON shared_space_versions
FOR EACH ROW
EXECUTE FUNCTION pluginmax_reject_shared_space_version_mutation();

CREATE TABLE IF NOT EXISTS shared_space_locks (
  id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES shared_space_roots(workspace_id)
    ON DELETE RESTRICT,
  path TEXT NOT NULL CHECK (length(path) BETWEEN 1 AND 500),
  owner_principal_id TEXT NOT NULL REFERENCES principals(id),
  owner_session_id TEXT CHECK (
    owner_session_id IS NULL OR length(owner_session_id) BETWEEN 1 AND 240
  ),
  run_id UUID REFERENCES runs(id) ON DELETE SET NULL,
  mode TEXT NOT NULL CHECK (mode IN ('exclusive', 'shared')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'released', 'expired')),
  lease_expires_at TIMESTAMPTZ NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  acquired_at TIMESTAMPTZ NOT NULL,
  released_at TIMESTAMPTZ,
  CHECK (lease_expires_at > acquired_at),
  CHECK (
    (status IN ('released', 'expired') AND released_at IS NOT NULL)
    OR (status = 'active' AND released_at IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS shared_space_locks_active_path_idx
  ON shared_space_locks(workspace_id, lower(path))
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS shared_space_locks_lease_idx
  ON shared_space_locks(status, lease_expires_at);

CREATE TABLE IF NOT EXISTS shared_space_claims (
  id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES shared_space_roots(workspace_id)
    ON DELETE RESTRICT,
  path TEXT NOT NULL CHECK (length(path) BETWEEN 1 AND 500),
  owner_principal_id TEXT NOT NULL REFERENCES principals(id),
  owner_session_id TEXT NOT NULL CHECK (
    length(owner_session_id) BETWEEN 1 AND 240
  ),
  run_id UUID REFERENCES runs(id) ON DELETE SET NULL,
  note TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 500),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'released', 'expired')),
  lease_expires_at TIMESTAMPTZ NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  claimed_at TIMESTAMPTZ NOT NULL,
  released_at TIMESTAMPTZ,
  CHECK (lease_expires_at > claimed_at),
  CHECK (
    (status IN ('released', 'expired') AND released_at IS NOT NULL)
    OR (status = 'active' AND released_at IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS shared_space_claims_active_path_idx
  ON shared_space_claims(workspace_id, lower(path))
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS shared_space_claims_lease_idx
  ON shared_space_claims(status, lease_expires_at);

CREATE TABLE IF NOT EXISTS shared_space_write_requests (
  id UUID PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('workspace', 'global')),
  operation TEXT NOT NULL DEFAULT 'write'
    CHECK (operation IN ('write', 'move', 'delete')),
  source_workspace_id TEXT NOT NULL REFERENCES workspaces(id)
    ON DELETE RESTRICT,
  actor_principal_id TEXT NOT NULL REFERENCES principals(id),
  target_path TEXT NOT NULL CHECK (length(target_path) BETWEEN 1 AND 500),
  source_entry_id UUID REFERENCES shared_space_entries(id) ON DELETE SET NULL,
  name TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 240),
  mime_type TEXT NOT NULL CHECK (length(mime_type) BETWEEN 1 AND 180),
  size BIGINT NOT NULL CHECK (size >= 0),
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  storage_key TEXT NOT NULL CHECK (
    length(storage_key) BETWEEN 1 AND 800
    AND left(storage_key, 1) <> '/'
  ),
  purpose TEXT NOT NULL CHECK (length(btrim(purpose)) BETWEEN 3 AND 1000),
  expected_version INTEGER NOT NULL CHECK (expected_version >= 0),
  policy_revision INTEGER NOT NULL CHECK (policy_revision >= 0),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'consumed')),
  run_id UUID REFERENCES runs(id) ON DELETE RESTRICT,
  scene_session_id UUID REFERENCES scene_sessions(id) ON DELETE RESTRICT,
  ticket_id UUID REFERENCES action_tickets(id) ON DELETE RESTRICT,
  gate_id UUID REFERENCES execution_gate_requests(gate_id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL CHECK (
    length(btrim(idempotency_key)) BETWEEN 1 AND 240
  ),
  requested_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  decided_by_principal_id TEXT REFERENCES principals(id) ON DELETE SET NULL,
  decision_reason TEXT CHECK (
    decision_reason IS NULL OR length(decision_reason) <= 2000
  ),
  decided_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ,
  result_entry_id UUID REFERENCES shared_space_entries(id) ON DELETE SET NULL,
  result_version INTEGER CHECK (result_version IS NULL OR result_version > 0),
  UNIQUE (source_workspace_id, actor_principal_id, idempotency_key),
  CHECK (expires_at > requested_at),
  CHECK (
    (scope = 'workspace' AND run_id IS NOT NULL AND scene_session_id IS NOT NULL
      AND ticket_id IS NOT NULL AND gate_id IS NOT NULL)
    OR scope = 'global'
  ),
  CHECK (
    (status = 'pending' AND decided_at IS NULL AND consumed_at IS NULL)
    OR (status = 'approved' AND decided_at IS NOT NULL AND consumed_at IS NULL)
    OR (status = 'rejected' AND decided_at IS NOT NULL AND consumed_at IS NULL)
    OR (status = 'expired' AND consumed_at IS NULL)
    OR (status = 'consumed' AND decided_at IS NOT NULL
      AND consumed_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS shared_space_write_requests_status_idx
  ON shared_space_write_requests(scope, status, expires_at);

CREATE INDEX IF NOT EXISTS shared_space_write_requests_workspace_idx
  ON shared_space_write_requests(source_workspace_id, requested_at DESC);

CREATE OR REPLACE FUNCTION pluginmax_guard_shared_space_write_request()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.id IS DISTINCT FROM NEW.id
    OR OLD.scope IS DISTINCT FROM NEW.scope
    OR OLD.operation IS DISTINCT FROM NEW.operation
    OR OLD.source_workspace_id IS DISTINCT FROM NEW.source_workspace_id
    OR OLD.actor_principal_id IS DISTINCT FROM NEW.actor_principal_id
    OR OLD.target_path IS DISTINCT FROM NEW.target_path
    OR OLD.source_entry_id IS DISTINCT FROM NEW.source_entry_id
    OR OLD.storage_key IS DISTINCT FROM NEW.storage_key
    OR OLD.sha256 IS DISTINCT FROM NEW.sha256
    OR OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key
    OR OLD.requested_at IS DISTINCT FROM NEW.requested_at
    OR OLD.expires_at IS DISTINCT FROM NEW.expires_at
  THEN
    RAISE EXCEPTION 'shared space write request identity is immutable';
  END IF;
  IF OLD.status = 'consumed' THEN
    RAISE EXCEPTION 'consumed shared space write requests are immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS shared_space_write_requests_guard
  ON shared_space_write_requests;
CREATE TRIGGER shared_space_write_requests_guard
BEFORE UPDATE OR DELETE ON shared_space_write_requests
FOR EACH ROW
EXECUTE FUNCTION pluginmax_guard_shared_space_write_request();

CREATE TABLE IF NOT EXISTS shared_space_global_files (
  id UUID PRIMARY KEY,
  request_id UUID NOT NULL UNIQUE REFERENCES shared_space_write_requests(id)
    ON DELETE RESTRICT,
  path TEXT NOT NULL CHECK (length(path) BETWEEN 1 AND 500),
  name TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 240),
  mime_type TEXT NOT NULL CHECK (length(mime_type) BETWEEN 1 AND 180),
  size BIGINT NOT NULL CHECK (size >= 0),
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  storage_key TEXT NOT NULL CHECK (
    length(storage_key) BETWEEN 1 AND 800
    AND left(storage_key, 1) <> '/'
  ),
  created_by TEXT NOT NULL REFERENCES principals(id),
  created_at TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS shared_space_global_files_path_idx
  ON shared_space_global_files(lower(path));

CREATE TABLE IF NOT EXISTS shared_space_events (
  id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  actor_principal_id TEXT REFERENCES principals(id) ON DELETE SET NULL,
  action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 80),
  path TEXT CHECK (path IS NULL OR length(path) BETWEEN 1 AND 500),
  entry_id UUID REFERENCES shared_space_entries(id) ON DELETE SET NULL,
  version INTEGER CHECK (version IS NULL OR version >= 0),
  decision TEXT NOT NULL CHECK (decision IN ('allowed', 'denied')),
  reason TEXT NOT NULL DEFAULT '' CHECK (length(reason) <= 1000),
  run_id UUID REFERENCES runs(id) ON DELETE SET NULL,
  scene_session_id UUID REFERENCES scene_sessions(id) ON DELETE SET NULL,
  ticket_id UUID REFERENCES action_tickets(id) ON DELETE SET NULL,
  gate_id UUID REFERENCES execution_gate_requests(gate_id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(metadata) = 'object'),
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS shared_space_events_workspace_idx
  ON shared_space_events(workspace_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS shared_space_events_action_idx
  ON shared_space_events(workspace_id, action, created_at DESC);

CREATE OR REPLACE FUNCTION pluginmax_reject_shared_space_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'shared space events are append-only';
END;
$$;

DROP TRIGGER IF EXISTS shared_space_events_append_only
  ON shared_space_events;
CREATE TRIGGER shared_space_events_append_only
BEFORE UPDATE OR DELETE ON shared_space_events
FOR EACH ROW
EXECUTE FUNCTION pluginmax_reject_shared_space_event_mutation();

CREATE TABLE IF NOT EXISTS shared_space_digests (
  id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  scene_session_id UUID REFERENCES scene_sessions(id) ON DELETE RESTRICT,
  digest_date DATE NOT NULL,
  content TEXT NOT NULL CHECK (length(btrim(content)) BETWEEN 1 AND 40000),
  event_from UUID REFERENCES shared_space_events(id) ON DELETE SET NULL,
  event_to UUID REFERENCES shared_space_events(id) ON DELETE SET NULL,
  generated_by TEXT NOT NULL REFERENCES principals(id),
  generated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS shared_space_digests_workspace_idx
  ON shared_space_digests(workspace_id, generated_at DESC);

CREATE OR REPLACE FUNCTION pluginmax_reject_shared_space_digest_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'shared space digests are append-only';
END;
$$;

DROP TRIGGER IF EXISTS shared_space_digests_append_only
  ON shared_space_digests;
CREATE TRIGGER shared_space_digests_append_only
BEFORE UPDATE OR DELETE ON shared_space_digests
FOR EACH ROW
EXECUTE FUNCTION pluginmax_reject_shared_space_digest_mutation();

INSERT INTO shared_space_roots (
  workspace_id, storage_prefix, status, default_read, default_write,
  version, created_at, updated_at
)
SELECT
  workspace.id,
  'shared/' || md5(workspace.id),
  'active',
  TRUE,
  FALSE,
  1,
  NOW(),
  NOW()
FROM workspaces AS workspace
ON CONFLICT (workspace_id) DO NOTHING;
`;

export const HUMAN_AVATAR_DELEGATION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS delegations (
  id UUID PRIMARY KEY,
  owner_principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  representative_principal_id TEXT NOT NULL
    REFERENCES principals(id) ON DELETE RESTRICT,
  representative_kind TEXT NOT NULL
    CHECK (representative_kind IN ('human', 'ai')),
  representative_agent_id UUID REFERENCES agents(id) ON DELETE RESTRICT,
  workspace_id TEXT NOT NULL
    CHECK (length(btrim(workspace_id)) BETWEEN 1 AND 180),
  project_id UUID REFERENCES projects(id) ON DELETE RESTRICT,
  context_type TEXT NOT NULL
    CHECK (context_type IN (
      'meeting',
      'task',
      'workflow_instance',
      'workflow_node'
    )),
  context_id TEXT NOT NULL
    CHECK (length(btrim(context_id)) BETWEEN 1 AND 180),
  display_name TEXT NOT NULL
    CHECK (length(btrim(display_name)) BETWEEN 1 AND 240),
  objective TEXT NOT NULL
    CHECK (length(btrim(objective)) BETWEEN 1 AND 4000),
  stance TEXT NOT NULL DEFAULT ''
    CHECK (length(stance) <= 4000),
  watch_items JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(watch_items) = 'array'),
  material_scopes JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(material_scopes) = 'array'),
  allowed_actions TEXT[] NOT NULL
    CHECK (
      cardinality(allowed_actions) > 0
      AND allowed_actions <@ ARRAY[
        'read_context',
        'read_materials',
        'comment',
        'ask_question',
        'record_risk',
        'summarize',
        'submit_draft',
        'submit_deliverable',
        'update_status',
        'reassign',
        'approve',
        'reject',
        'archive',
        'delete'
      ]::text[]
    ),
  denied_actions TEXT[] NOT NULL DEFAULT '{}'
    CHECK (
      denied_actions <@ ARRAY[
        'read_context',
        'read_materials',
        'comment',
        'ask_question',
        'record_risk',
        'summarize',
        'submit_draft',
        'submit_deliverable',
        'update_status',
        'reassign',
        'approve',
        'reject',
        'archive',
        'delete'
      ]::text[]
    ),
  approval_policy TEXT NOT NULL DEFAULT 'suggest-only'
    CHECK (approval_policy IN (
      'suggest-only',
      'require-confirmation',
      'auto-within-rules'
    )),
  auto_participation TEXT NOT NULL DEFAULT 'mentions'
    CHECK (auto_participation IN ('manual', 'mentions', 'all')),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN (
      'draft',
      'active',
      'paused',
      'completed',
      'revoked',
      'expired'
    )),
  expires_at TIMESTAMPTZ NOT NULL,
  report_required BOOLEAN NOT NULL DEFAULT TRUE,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  last_failure TEXT CHECK (last_failure IS NULL OR length(last_failure) <= 4000),
  created_by TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  activated_at TIMESTAMPTZ,
  paused_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revoked_by TEXT REFERENCES principals(id) ON DELETE RESTRICT,
  CHECK (
    (representative_kind = 'human' AND representative_agent_id IS NULL)
    OR (representative_kind = 'ai' AND representative_agent_id IS NOT NULL)
  ),
  CHECK (
    (status = 'revoked' AND revoked_at IS NOT NULL AND revoked_by IS NOT NULL)
    OR (status <> 'revoked' AND revoked_at IS NULL AND revoked_by IS NULL)
  ),
  CHECK (
    (status = 'completed' AND completed_at IS NOT NULL)
    OR (status <> 'completed' AND completed_at IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS delegations_active_scope_idx
  ON delegations(owner_principal_id, context_type, context_id,
                 representative_principal_id)
  WHERE status IN ('draft', 'active', 'paused');

CREATE INDEX IF NOT EXISTS delegations_owner_idx
  ON delegations(owner_principal_id, status, expires_at, updated_at DESC);

CREATE INDEX IF NOT EXISTS delegations_representative_idx
  ON delegations(representative_principal_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS delegations_expiry_idx
  ON delegations(status, expires_at);

CREATE TABLE IF NOT EXISTS delegation_events (
  id UUID PRIMARY KEY,
  delegation_id UUID NOT NULL REFERENCES delegations(id) ON DELETE RESTRICT,
  seq BIGINT NOT NULL CHECK (seq > 0),
  kind TEXT NOT NULL CHECK (kind IN (
    'created',
    'updated',
    'activated',
    'paused',
    'resumed',
    'extended',
    'completed',
    'revoked',
    'expired',
    'run_started',
    'run_finished',
    'confirmation_requested',
    'confirmation_decided',
    'report_ready',
    'report_failed',
    'expiry_notice'
  )),
  actor_principal_id TEXT NOT NULL
    CHECK (length(btrim(actor_principal_id)) BETWEEN 1 AND 180),
  before_revision INTEGER NOT NULL CHECK (before_revision >= 0),
  after_revision INTEGER NOT NULL CHECK (after_revision > 0),
  reason TEXT CHECK (reason IS NULL OR length(reason) <= 2000),
  data JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(data) = 'object'),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (delegation_id, seq)
);

CREATE INDEX IF NOT EXISTS delegation_events_timeline_idx
  ON delegation_events(delegation_id, seq DESC);

CREATE OR REPLACE FUNCTION pluginmax_reject_delegation_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'delegation events are append-only';
END;
$$;

DROP TRIGGER IF EXISTS delegation_events_append_only ON delegation_events;
CREATE TRIGGER delegation_events_append_only
BEFORE UPDATE OR DELETE ON delegation_events
FOR EACH ROW
EXECUTE FUNCTION pluginmax_reject_delegation_event_mutation();

CREATE TABLE IF NOT EXISTS delegation_runs (
  delegation_id UUID NOT NULL REFERENCES delegations(id) ON DELETE RESTRICT,
  run_id UUID NOT NULL UNIQUE REFERENCES runs(id) ON DELETE RESTRICT,
  scene_session_id UUID REFERENCES scene_sessions(id) ON DELETE SET NULL,
  ticket_id UUID REFERENCES action_tickets(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN (
    'queued',
    'running',
    'waiting_approval',
    'completed',
    'failed',
    'cancelled',
    'timeout',
    'interrupted'
  )),
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (delegation_id, run_id)
);

CREATE INDEX IF NOT EXISTS delegation_runs_timeline_idx
  ON delegation_runs(delegation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS delegation_reports (
  delegation_id UUID PRIMARY KEY REFERENCES delegations(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'generating', 'ready', 'failed')),
  summary TEXT NOT NULL DEFAULT '' CHECK (length(summary) <= 20000),
  key_process JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(key_process) = 'array'),
  positions JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(positions) = 'array'),
  risks JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(risks) = 'array'),
  open_questions JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(open_questions) = 'array'),
  next_steps JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(next_steps) = 'array'),
  information_gaps JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(information_gaps) = 'array'),
  source_event_cursor BIGINT NOT NULL DEFAULT 0
    CHECK (source_event_cursor >= 0),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  error_code TEXT,
  error_message TEXT,
  generated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS delegation_notifications (
  id UUID PRIMARY KEY,
  owner_principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  delegation_id UUID NOT NULL REFERENCES delegations(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN (
    'expiry_soon',
    'confirmation_required',
    'report_ready',
    'anomaly'
  )),
  dedupe_key TEXT NOT NULL UNIQUE
    CHECK (length(btrim(dedupe_key)) BETWEEN 1 AND 300),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'acknowledged')),
  due_at TIMESTAMPTZ NOT NULL,
  acknowledged_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS delegation_notifications_owner_idx
  ON delegation_notifications(owner_principal_id, status, due_at);

CREATE TABLE IF NOT EXISTS delegation_confirmation_requests (
  id UUID PRIMARY KEY,
  delegation_id UUID NOT NULL REFERENCES delegations(id) ON DELETE RESTRICT,
  owner_principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  representative_principal_id TEXT NOT NULL
    REFERENCES principals(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (action IN (
    'read_context',
    'read_materials',
    'comment',
    'ask_question',
    'record_risk',
    'summarize',
    'submit_draft',
    'submit_deliverable',
    'update_status',
    'reassign',
    'approve',
    'reject',
    'archive',
    'delete'
  )),
  target_type TEXT NOT NULL
    CHECK (length(btrim(target_type)) BETWEEN 1 AND 120),
  target_id TEXT NOT NULL
    CHECK (length(btrim(target_id)) BETWEEN 1 AND 240),
  proposed_payload_hash TEXT NOT NULL
    CHECK (proposed_payload_hash ~ '^[a-f0-9]{64}$'),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  decided_by_principal_id TEXT REFERENCES principals(id) ON DELETE RESTRICT,
  decision_reason TEXT CHECK (
    decision_reason IS NULL OR length(decision_reason) <= 2000
  ),
  expires_at TIMESTAMPTZ NOT NULL,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  CHECK (
    (status = 'pending' AND decided_by_principal_id IS NULL
      AND decision_reason IS NULL AND decided_at IS NULL)
    OR (status IN ('approved', 'rejected')
      AND decided_by_principal_id IS NOT NULL
      AND decision_reason IS NOT NULL AND decided_at IS NOT NULL)
    OR (status = 'expired' AND decided_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS delegation_confirmations_pending_idx
  ON delegation_confirmation_requests(
    delegation_id,
    status,
    expires_at
  );

ALTER TABLE meeting_delegates
  ADD COLUMN IF NOT EXISTS delegation_id UUID
    REFERENCES delegations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS meeting_delegates_delegation_idx
  ON meeting_delegates(delegation_id)
  WHERE delegation_id IS NOT NULL;

ALTER TABLE action_tickets
  ADD COLUMN IF NOT EXISTS delegation_id UUID
    REFERENCES delegations(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS delegation_revision INTEGER,
  ADD COLUMN IF NOT EXISTS delegation_context_hash TEXT,
  ADD COLUMN IF NOT EXISTS owner_principal_id TEXT,
  ADD COLUMN IF NOT EXISTS representative_principal_id TEXT;

ALTER TABLE action_tickets
  DROP CONSTRAINT IF EXISTS action_tickets_delegation_binding_check;

ALTER TABLE action_tickets
  ADD CONSTRAINT action_tickets_delegation_binding_check
  CHECK (
    (
      delegation_id IS NULL
      AND delegation_revision IS NULL
      AND delegation_context_hash IS NULL
      AND owner_principal_id IS NULL
      AND representative_principal_id IS NULL
    )
    OR (
      delegation_id IS NOT NULL
      AND delegation_revision IS NOT NULL
      AND delegation_revision > 0
      AND delegation_context_hash ~ '^[a-f0-9]{64}$'
      AND owner_principal_id IS NOT NULL
      AND representative_principal_id IS NOT NULL
    )
  ),
  ADD CONSTRAINT action_tickets_delegation_revision_check
  CHECK (delegation_revision IS NULL OR delegation_revision > 0);

CREATE INDEX IF NOT EXISTS action_tickets_delegation_idx
  ON action_tickets(delegation_id, issued_at DESC)
  WHERE delegation_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS delegation_ticket_revocations (
  ticket_id UUID PRIMARY KEY REFERENCES action_tickets(id) ON DELETE RESTRICT,
  delegation_id UUID NOT NULL REFERENCES delegations(id) ON DELETE RESTRICT,
  revoked_by_principal_id TEXT NOT NULL
    CHECK (length(btrim(revoked_by_principal_id)) BETWEEN 1 AND 180),
  reason TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  revoked_at TIMESTAMPTZ NOT NULL
);

CREATE OR REPLACE FUNCTION pluginmax_reject_delegation_ticket_revocation_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'delegation ticket revocations are append-only';
END;
$$;

DROP TRIGGER IF EXISTS delegation_ticket_revocations_append_only
  ON delegation_ticket_revocations;
CREATE TRIGGER delegation_ticket_revocations_append_only
BEFORE UPDATE OR DELETE ON delegation_ticket_revocations
FOR EACH ROW
EXECUTE FUNCTION pluginmax_reject_delegation_ticket_revocation_mutation();

ALTER TABLE scene_sessions
  ADD COLUMN IF NOT EXISTS delegation_id UUID
    REFERENCES delegations(id) ON DELETE RESTRICT;

ALTER TABLE scene_sessions
  DROP CONSTRAINT IF EXISTS scene_sessions_scene_type_check,
  ADD CONSTRAINT scene_sessions_scene_type_check
    CHECK (scene_type IN (
      'task',
      'workflow-node',
      'meeting',
      'direct-chat',
      'delegation'
    ));

CREATE INDEX IF NOT EXISTS scene_sessions_delegation_idx
  ON scene_sessions(delegation_id, updated_at DESC)
  WHERE delegation_id IS NOT NULL;

ALTER TABLE scene_context_contributions
  ADD COLUMN IF NOT EXISTS delegation_id UUID
    REFERENCES delegations(id) ON DELETE RESTRICT;

ALTER TABLE scene_context_contributions
  DROP CONSTRAINT IF EXISTS scene_context_contributions_scene_type_check,
  DROP CONSTRAINT IF EXISTS scene_context_contributions_kind_check,
  ADD CONSTRAINT scene_context_contributions_scene_type_check
    CHECK (scene_type IN (
      'task',
      'workflow-node',
      'meeting',
      'direct-chat',
      'delegation'
    )),
  ADD CONSTRAINT scene_context_contributions_kind_check
    CHECK (kind IN (
      'task-comment-consensus',
      'task-dependency',
      'task-attachment',
      'workflow-node',
      'meeting-minutes',
      'meeting-private-note',
      'delegation-brief',
      'direct-chat-message',
      'agent-memory',
      'project-memory',
      'manual'
    ));

ALTER TABLE scene_context_receipts
  ADD COLUMN IF NOT EXISTS delegation_id UUID
    REFERENCES delegations(id) ON DELETE RESTRICT;

ALTER TABLE scene_context_receipts
  DROP CONSTRAINT IF EXISTS scene_context_receipts_scene_type_check,
  ADD CONSTRAINT scene_context_receipts_scene_type_check
    CHECK (scene_type IN (
      'task',
      'workflow-node',
      'meeting',
      'direct-chat',
      'delegation'
    ));

ALTER TABLE context_packs
  DROP CONSTRAINT IF EXISTS context_packs_scene_type_check,
  ADD CONSTRAINT context_packs_scene_type_check
    CHECK (
      scene_type IS NULL
      OR scene_type IN (
        'task',
        'workflow-node',
        'meeting',
        'direct-chat',
        'delegation'
      )
    );

CREATE INDEX IF NOT EXISTS scene_context_receipts_delegation_idx
  ON scene_context_receipts(delegation_id, created_at DESC)
  WHERE delegation_id IS NOT NULL;
`;

export const TASK_EXECUTION_EVIDENCE_SCHEMA_SQL = `
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;

CREATE TABLE IF NOT EXISTS feature_flag_settings (
  flag_key TEXT NOT NULL CHECK (length(btrim(flag_key)) BETWEEN 1 AND 160),
  scope_type TEXT NOT NULL CHECK (scope_type IN ('platform', 'project')),
  scope_id TEXT NOT NULL CHECK (length(btrim(scope_id)) BETWEEN 1 AND 180),
  mode TEXT NOT NULL CHECK (mode IN ('off', 'observe', 'enforce', 'on')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_by TEXT NOT NULL
    CHECK (length(btrim(updated_by)) BETWEEN 1 AND 180),
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (flag_key, scope_type, scope_id)
);

INSERT INTO feature_flag_settings (
  flag_key, scope_type, scope_id, mode, revision, updated_by, updated_at
) VALUES
  ('task.evidence_review', 'platform', 'platform', 'observe', 1,
   'system:migration', NOW()),
  ('task.anomaly', 'platform', 'platform', 'off', 1,
   'system:migration', NOW())
ON CONFLICT (flag_key, scope_type, scope_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS task_acceptance_items (
  id UUID PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position >= 0),
  requirement TEXT NOT NULL
    CHECK (length(btrim(requirement)) BETWEEN 1 AND 1000),
  required BOOLEAN NOT NULL DEFAULT TRUE,
  current_revision INTEGER NOT NULL DEFAULT 1
    CHECK (current_revision > 0),
  content_digest TEXT NOT NULL
    CHECK (content_digest ~ '^[a-f0-9]{64}$'),
  deprecated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS task_acceptance_items_current_position_idx
  ON task_acceptance_items(task_id, position)
  WHERE deprecated_at IS NULL;

CREATE INDEX IF NOT EXISTS task_acceptance_items_task_idx
  ON task_acceptance_items(task_id, deprecated_at, position);

CREATE TABLE IF NOT EXISTS task_acceptance_item_revisions (
  id UUID PRIMARY KEY,
  acceptance_item_id UUID NOT NULL
    REFERENCES task_acceptance_items(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK (revision > 0),
  requirement TEXT NOT NULL
    CHECK (length(btrim(requirement)) BETWEEN 1 AND 1000),
  required BOOLEAN NOT NULL,
  content_digest TEXT NOT NULL
    CHECK (content_digest ~ '^[a-f0-9]{64}$'),
  superseded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (acceptance_item_id, revision)
);

CREATE INDEX IF NOT EXISTS task_acceptance_revisions_item_idx
  ON task_acceptance_item_revisions(acceptance_item_id, revision DESC);

CREATE OR REPLACE FUNCTION pluginmax_reject_acceptance_revision_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.superseded_at IS NOT NULL
     AND OLD.superseded_at IS NULL
     AND NEW.id = OLD.id
     AND NEW.acceptance_item_id = OLD.acceptance_item_id
     AND NEW.revision = OLD.revision
     AND NEW.requirement = OLD.requirement
     AND NEW.required = OLD.required
     AND NEW.content_digest = OLD.content_digest
     AND NEW.created_at = OLD.created_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'task acceptance revisions are immutable';
END;
$$;

DROP TRIGGER IF EXISTS task_acceptance_revisions_immutable
  ON task_acceptance_item_revisions;
CREATE TRIGGER task_acceptance_revisions_immutable
BEFORE UPDATE OR DELETE ON task_acceptance_item_revisions
FOR EACH ROW
EXECUTE FUNCTION pluginmax_reject_acceptance_revision_mutation();

CREATE TABLE IF NOT EXISTS task_acceptance_confirmations (
  id UUID PRIMARY KEY,
  acceptance_item_id UUID NOT NULL
    REFERENCES task_acceptance_items(id) ON DELETE RESTRICT,
  acceptance_item_revision INTEGER NOT NULL
    CHECK (acceptance_item_revision > 0),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  run_id UUID NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
  run_attempt INTEGER NOT NULL CHECK (run_attempt > 0),
  confirmed_by_principal_id TEXT NOT NULL
    CHECK (length(btrim(confirmed_by_principal_id)) BETWEEN 1 AND 180),
  confirmation_tool TEXT NOT NULL
    CHECK (confirmation_tool = 'task_submit_deliverable'),
  evidence_refs JSONB NOT NULL
    CHECK (
      jsonb_typeof(evidence_refs) = 'array'
      AND jsonb_array_length(evidence_refs) > 0
    ),
  confirmed_at TIMESTAMPTZ NOT NULL,
  superseded_at TIMESTAMPTZ,
  superseded_reason TEXT
    CHECK (superseded_reason IS NULL OR length(superseded_reason) <= 2000),
  CHECK (
    (superseded_at IS NULL AND superseded_reason IS NULL)
    OR (superseded_at IS NOT NULL AND superseded_reason IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS task_acceptance_confirmations_current_idx
  ON task_acceptance_confirmations(acceptance_item_id, run_id)
  WHERE superseded_at IS NULL;

CREATE INDEX IF NOT EXISTS task_acceptance_confirmations_task_idx
  ON task_acceptance_confirmations(task_id, run_id, superseded_at);

CREATE OR REPLACE FUNCTION pluginmax_guard_acceptance_confirmation_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'task acceptance confirmations cannot be deleted';
  END IF;
  IF NEW.id <> OLD.id
     OR NEW.acceptance_item_id <> OLD.acceptance_item_id
     OR NEW.acceptance_item_revision <> OLD.acceptance_item_revision
     OR NEW.task_id <> OLD.task_id
     OR NEW.run_id <> OLD.run_id
     OR NEW.run_attempt <> OLD.run_attempt
     OR NEW.confirmed_by_principal_id <> OLD.confirmed_by_principal_id
     OR NEW.confirmation_tool <> OLD.confirmation_tool
     OR NEW.evidence_refs <> OLD.evidence_refs
     OR NEW.confirmed_at <> OLD.confirmed_at THEN
    RAISE EXCEPTION 'task acceptance confirmation facts are immutable';
  END IF;
  IF OLD.superseded_at IS NOT NULL
     AND (
       NEW.superseded_at IS DISTINCT FROM OLD.superseded_at
       OR NEW.superseded_reason IS DISTINCT FROM OLD.superseded_reason
     ) THEN
    RAISE EXCEPTION 'superseded acceptance confirmations are immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS task_acceptance_confirmations_guard
  ON task_acceptance_confirmations;
CREATE TRIGGER task_acceptance_confirmations_guard
BEFORE UPDATE OR DELETE ON task_acceptance_confirmations
FOR EACH ROW
EXECUTE FUNCTION pluginmax_guard_acceptance_confirmation_mutation();

CREATE TABLE IF NOT EXISTS task_execution_anomalies (
  id UUID PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  run_id UUID REFERENCES runs(id) ON DELETE RESTRICT,
  run_attempt INTEGER CHECK (run_attempt IS NULL OR run_attempt > 0),
  code TEXT NOT NULL CHECK (code IN (
    'run_failed',
    'run_timeout',
    'run_interrupted',
    'tool_failed',
    'plan_failed',
    'dependency_unmet',
    'runtime_unavailable',
    'missing_acceptance',
    'missing_execution_evidence'
  )),
  message TEXT NOT NULL CHECK (length(btrim(message)) BETWEEN 1 AND 4000),
  event_id UUID REFERENCES run_events(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'cleared')),
  occurrence INTEGER NOT NULL DEFAULT 1 CHECK (occurrence > 0),
  detected_at TIMESTAMPTZ NOT NULL,
  cleared_at TIMESTAMPTZ,
  cleared_reason TEXT
    CHECK (cleared_reason IS NULL OR length(cleared_reason) <= 4000),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  CHECK (
    (status = 'active' AND cleared_at IS NULL AND cleared_reason IS NULL)
    OR (
      status = 'cleared'
      AND cleared_at IS NOT NULL
      AND cleared_reason IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS task_execution_anomalies_active_idx
  ON task_execution_anomalies(
    task_id,
    COALESCE(run_id, '00000000-0000-0000-0000-000000000000'::uuid),
    code
  )
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS task_execution_anomalies_task_idx
  ON task_execution_anomalies(task_id, status, detected_at DESC);

CREATE INDEX IF NOT EXISTS task_execution_anomalies_run_idx
  ON task_execution_anomalies(run_id, run_attempt, code)
  WHERE run_id IS NOT NULL;
`;

export const TASK_EXECUTION_EVIDENCE_BACKFILL_SQL = `
INSERT INTO task_acceptance_items (
  id, task_id, position, requirement, required, current_revision,
  content_digest, deprecated_at, created_at, updated_at
)
SELECT
  gen_random_uuid(),
  task.id,
  item.position - 1,
  item.requirement,
  TRUE,
  1,
  encode(public.digest(item.requirement, 'sha256'), 'hex'),
  NULL,
  NOW(),
  NOW()
FROM tasks AS task
CROSS JOIN LATERAL jsonb_array_elements_text(task.acceptance)
  WITH ORDINALITY AS item(requirement, position)
WHERE jsonb_typeof(task.acceptance) = 'array'
  AND NOT EXISTS (
    SELECT 1
    FROM task_acceptance_items AS existing
    WHERE existing.task_id = task.id
      AND existing.deprecated_at IS NULL
  );

INSERT INTO task_acceptance_item_revisions (
  id, acceptance_item_id, revision, requirement, required,
  content_digest, superseded_at, created_at
)
SELECT
  gen_random_uuid(),
  item.id,
  item.current_revision,
  item.requirement,
  item.required,
  item.content_digest,
  NULL,
  item.created_at
FROM task_acceptance_items AS item
ON CONFLICT (acceptance_item_id, revision) DO NOTHING;

DO $$
DECLARE
  mismatch_count INTEGER;
BEGIN
  SELECT COUNT(*)
  INTO mismatch_count
  FROM tasks AS task
  WHERE jsonb_typeof(task.acceptance) = 'array'
    AND jsonb_array_length(task.acceptance) <> (
      SELECT COUNT(*)
      FROM task_acceptance_items AS item
      WHERE item.task_id = task.id
        AND item.deprecated_at IS NULL
    );

  IF mismatch_count > 0 THEN
    RAISE EXCEPTION
      'task acceptance backfill validation failed for % tasks',
      mismatch_count;
  END IF;
END;
$$;
`;

export const AGENT_TASK_TOOLS_SCHEMA_SQL = `
INSERT INTO feature_flag_settings (
  flag_key, scope_type, scope_id, mode, revision, updated_by, updated_at
) VALUES
  ('agent.task_tools', 'platform', 'platform', 'off', 1,
   'system:migration', NOW()),
  ('agent.workspace_files', 'platform', 'platform', 'off', 1,
   'system:migration', NOW())
ON CONFLICT (flag_key, scope_type, scope_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS tool_invocations (
  id UUID PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
  run_attempt INTEGER NOT NULL CHECK (run_attempt > 0),
  scene_session_id UUID REFERENCES scene_sessions(id) ON DELETE RESTRICT,
  task_id UUID REFERENCES tasks(id) ON DELETE RESTRICT,
  project_id UUID REFERENCES projects(id) ON DELETE RESTRICT,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  agent_principal_id TEXT
    CHECK (
      agent_principal_id IS NULL
      OR length(btrim(agent_principal_id)) BETWEEN 1 AND 180
    ),
  envelope_id TEXT
    CHECK (
      envelope_id IS NULL
      OR length(btrim(envelope_id)) BETWEEN 1 AND 180
    ),
  envelope_digest TEXT
    CHECK (
      envelope_digest IS NULL
      OR envelope_digest ~ '^[a-f0-9]{64}$'
    ),
  ticket_id UUID REFERENCES action_tickets(id) ON DELETE RESTRICT,
  gate_id UUID REFERENCES execution_gate_requests(gate_id) ON DELETE RESTRICT,
  tool_name TEXT NOT NULL CHECK (tool_name IN (
    'task_query',
    'task_submit_deliverable',
    'task_request_input',
    'task_comment',
    'read_file',
    'write_file',
    'list_files'
  )),
  tool_category TEXT NOT NULL CHECK (tool_category IN (
    'task.read',
    'task.write',
    'fs.read',
    'fs.write'
  )),
  request_digest TEXT NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  idempotency_key TEXT NOT NULL
    CHECK (length(btrim(idempotency_key)) BETWEEN 8 AND 240),
  status TEXT NOT NULL DEFAULT 'started'
    CHECK (status IN ('started', 'succeeded', 'failed')),
  result JSONB CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
  rejection_code TEXT
    CHECK (
      rejection_code IS NULL
      OR length(btrim(rejection_code)) BETWEEN 1 AND 180
    ),
  rejection_reason TEXT
    CHECK (rejection_reason IS NULL OR length(rejection_reason) <= 4000),
  path_digest TEXT
    CHECK (path_digest IS NULL OR path_digest ~ '^[a-f0-9]{64}$'),
  path_summary TEXT
    CHECK (path_summary IS NULL OR length(path_summary) <= 500),
  byte_count BIGINT CHECK (byte_count IS NULL OR byte_count >= 0),
  created_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (run_id, idempotency_key),
  UNIQUE (gate_id),
  CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS tool_invocations_run_idx
  ON tool_invocations(run_id, created_at, id);

CREATE INDEX IF NOT EXISTS tool_invocations_task_idx
  ON tool_invocations(task_id, created_at DESC)
  WHERE task_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS tool_invocations_status_idx
  ON tool_invocations(run_id, status, updated_at DESC);
`;

export const M2_WORKFLOW_ASSIGNMENT_SCHEMA_SQL = `
INSERT INTO feature_flag_settings (
  flag_key, scope_type, scope_id, mode, revision, updated_by, updated_at
) VALUES
  ('workflow.assignment_bindings', 'platform', 'platform', 'off', 1,
   'system:migration', NOW()),
  ('workflow.platform_templates', 'platform', 'platform', 'off', 1,
   'system:migration', NOW())
ON CONFLICT (flag_key, scope_type, scope_id) DO NOTHING;

ALTER TABLE workflow_definitions
  ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'project',
  ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'template',
  ADD COLUMN IF NOT EXISTS published_by_principal_id TEXT,
  ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1;

ALTER TABLE workflow_definitions
  DROP CONSTRAINT IF EXISTS workflow_definitions_scope_check;

ALTER TABLE workflow_definitions
  ADD CONSTRAINT workflow_definitions_scope_check
  CHECK (scope IN ('project', 'platform'));

ALTER TABLE workflow_definitions
  DROP CONSTRAINT IF EXISTS workflow_definitions_origin_check;

ALTER TABLE workflow_definitions
  ADD CONSTRAINT workflow_definitions_origin_check
  CHECK (origin IN ('template', 'router', 'manual'));

ALTER TABLE workflow_definitions
  DROP CONSTRAINT IF EXISTS workflow_definitions_revision_check;

ALTER TABLE workflow_definitions
  ADD CONSTRAINT workflow_definitions_revision_check
  CHECK (revision > 0);

CREATE INDEX IF NOT EXISTS workflow_definitions_platform_idx
  ON workflow_definitions(scope, status, published_at DESC)
  WHERE scope = 'platform';

DO $$
DECLARE
  conflict_count INTEGER;
BEGIN
  SELECT COUNT(*)
  INTO conflict_count
  FROM (
    SELECT project_id, lower(btrim(code))
    FROM project_roles
    WHERE btrim(code) <> ''
    GROUP BY project_id, lower(btrim(code))
    HAVING COUNT(*) > 1
  ) AS conflicts;

  IF conflict_count > 0 THEN
    RAISE EXCEPTION
      'project role code conflict preflight found % duplicate codes',
      conflict_count;
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS project_roles_project_code_idx
  ON project_roles(project_id, lower(btrim(code)))
  WHERE btrim(code) <> '';

ALTER TABLE workflow_instances
  ADD COLUMN IF NOT EXISTS definition_snapshot JSONB,
  ADD COLUMN IF NOT EXISTS binding_revision TEXT;

UPDATE workflow_instances AS instance
SET definition_snapshot = definition.graph
FROM workflow_definitions AS definition
WHERE definition.id = instance.workflow_id
  AND instance.definition_snapshot IS NULL;

ALTER TABLE workflow_instances
  DROP CONSTRAINT IF EXISTS workflow_instances_binding_revision_check;

ALTER TABLE workflow_instances
  ADD CONSTRAINT workflow_instances_binding_revision_check
  CHECK (
    binding_revision IS NULL
    OR binding_revision ~ '^[a-f0-9]{64}$'
  );

CREATE TABLE IF NOT EXISTS workflow_instance_assignments (
  id UUID PRIMARY KEY,
  instance_id UUID NOT NULL
    REFERENCES workflow_instances(id) ON DELETE RESTRICT,
  task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  node_id TEXT NOT NULL
    CHECK (length(btrim(node_id)) BETWEEN 1 AND 160),
  source_kind TEXT NOT NULL
    CHECK (source_kind IN ('role', 'user', 'agent', 'employee', 'system')),
  source_id TEXT NOT NULL
    CHECK (length(btrim(source_id)) BETWEEN 1 AND 180),
  source_role_code TEXT
    CHECK (
      source_role_code IS NULL
      OR length(btrim(source_role_code)) BETWEEN 1 AND 80
    ),
  source_label TEXT
    CHECK (source_label IS NULL OR length(btrim(source_label)) <= 160),
  dispatch_mode TEXT NOT NULL
    CHECK (dispatch_mode IN ('assigned', 'claim')),
  status TEXT NOT NULL
    CHECK (status IN ('resolved', 'unresolved', 'overridden')),
  primary_principal_id TEXT
    CHECK (
      primary_principal_id IS NULL
      OR length(btrim(primary_principal_id)) BETWEEN 1 AND 180
    ),
  candidate_pool JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(candidate_pool) = 'array'),
  resolved_by TEXT NOT NULL
    CHECK (length(btrim(resolved_by)) BETWEEN 1 AND 180),
  resolved_at TIMESTAMPTZ NOT NULL,
  source_change_reason TEXT NOT NULL DEFAULT ''
    CHECK (length(source_change_reason) <= 2000),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (instance_id, node_id),
  CHECK (
    dispatch_mode <> 'assigned'
    OR status = 'unresolved'
    OR primary_principal_id IS NOT NULL
  ),
  CHECK (
    dispatch_mode <> 'claim'
    OR status = 'unresolved'
    OR jsonb_array_length(candidate_pool) > 0
  ),
  CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS workflow_instance_assignments_task_idx
  ON workflow_instance_assignments(task_id)
  WHERE task_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS workflow_instance_assignments_instance_idx
  ON workflow_instance_assignments(instance_id, node_id);

CREATE TABLE IF NOT EXISTS workflow_instance_approvers (
  id UUID PRIMARY KEY,
  instance_id UUID NOT NULL
    REFERENCES workflow_instances(id) ON DELETE RESTRICT,
  node_id TEXT NOT NULL
    CHECK (length(btrim(node_id)) BETWEEN 1 AND 160),
  principal_id TEXT NOT NULL
    CHECK (length(btrim(principal_id)) BETWEEN 1 AND 180),
  source_kind TEXT NOT NULL
    CHECK (source_kind IN ('role', 'user', 'agent', 'employee', 'system')),
  source_id TEXT NOT NULL
    CHECK (length(btrim(source_id)) BETWEEN 1 AND 180),
  source_role_code TEXT
    CHECK (
      source_role_code IS NULL
      OR length(btrim(source_role_code)) BETWEEN 1 AND 80
    ),
  status TEXT NOT NULL
    CHECK (status IN ('resolved', 'unresolved', 'overridden')),
  resolved_by TEXT NOT NULL
    CHECK (length(btrim(resolved_by)) BETWEEN 1 AND 180),
  resolved_at TIMESTAMPTZ NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (instance_id, node_id, principal_id),
  CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS workflow_instance_approvers_instance_idx
  ON workflow_instance_approvers(instance_id, node_id, principal_id);

CREATE TABLE IF NOT EXISTS project_role_mapping_presets (
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  role_id UUID NOT NULL REFERENCES project_roles(id) ON DELETE CASCADE,
  assignees JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(assignees) = 'array'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_by_principal_id TEXT NOT NULL
    CHECK (length(btrim(updated_by_principal_id)) BETWEEN 1 AND 180),
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (project_id, role_id)
);

CREATE INDEX IF NOT EXISTS project_role_mapping_presets_project_idx
  ON project_role_mapping_presets(project_id, updated_at DESC);
`;

export const M3_WORKFLOW_PLAN_SCHEMA_SQL = `
INSERT INTO feature_flag_settings (
  flag_key, scope_type, scope_id, mode, revision, updated_by, updated_at
) VALUES
  ('workflow.router_worker', 'platform', 'platform', 'off', 1,
   'system:migration', NOW())
ON CONFLICT (flag_key, scope_type, scope_id) DO NOTHING;

ALTER TABLE teammate_templates
  ADD COLUMN IF NOT EXISTS protected BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS workflow_feature_gate_epochs (
  flag_key TEXT NOT NULL,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('platform', 'project')),
  scope_id TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  epoch INTEGER NOT NULL DEFAULT 1 CHECK (epoch > 0),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_by TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (flag_key, scope_type, scope_id)
);

CREATE TABLE IF NOT EXISTS router_agents (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  teammate_id UUID NOT NULL UNIQUE
    REFERENCES teammates(id) ON DELETE RESTRICT,
  agent_id UUID NOT NULL UNIQUE REFERENCES agents(id) ON DELETE RESTRICT,
  ai_principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  template_id UUID NOT NULL
    REFERENCES teammate_templates(id) ON DELETE RESTRICT,
  template_version_id UUID NOT NULL
    REFERENCES teammate_template_versions(id) ON DELETE RESTRICT,
  template_version INTEGER NOT NULL CHECK (template_version > 0),
  contract_tools JSONB NOT NULL
    CHECK (
      jsonb_typeof(contract_tools) = 'array'
      AND jsonb_array_length(contract_tools) = 2
    ),
  contract_digest TEXT NOT NULL
    CHECK (contract_digest ~ '^[a-f0-9]{64}$'),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled')),
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS router_agents_project_idx
  ON router_agents(project_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS workflow_plans (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  root_task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  source TEXT NOT NULL CHECK (source IN ('template', 'router', 'manual')),
  current_version INTEGER NOT NULL CHECK (current_version > 0),
  status TEXT NOT NULL CHECK (status IN (
    'draft',
    'proposed',
    'approved',
    'active',
    'finalizing',
    'completed',
    'cancelled',
    'failed',
    'paused',
    'resume_required'
  )),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  confirmed_by_principal_id TEXT,
  confirmed_by_role TEXT,
  confirmed_at TIMESTAMPTZ,
  router_agent_id UUID REFERENCES router_agents(id) ON DELETE RESTRICT,
  workflow_definition_id UUID
    REFERENCES workflow_definitions(id) ON DELETE RESTRICT,
  workflow_instance_id UUID REFERENCES workflow_instances(id)
    ON DELETE RESTRICT,
  gate_epoch INTEGER CHECK (gate_epoch IS NULL OR gate_epoch > 0),
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (updated_at >= created_at),
  CHECK (
    (status IN ('approved', 'active', 'finalizing', 'completed')
      AND confirmed_by_principal_id IS NOT NULL
      AND confirmed_at IS NOT NULL)
    OR status NOT IN ('approved', 'active', 'finalizing', 'completed')
  ),
  CHECK (
    (lease_owner IS NULL AND lease_expires_at IS NULL)
    OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
  ),
  CHECK (source <> 'router' OR router_agent_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS workflow_plans_project_idx
  ON workflow_plans(project_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS workflow_plans_reconcile_idx
  ON workflow_plans(
    status,
    lease_expires_at,
    updated_at
  )
  WHERE status IN ('approved', 'active', 'finalizing', 'resume_required');

ALTER TABLE workflow_definitions
  ADD COLUMN IF NOT EXISTS plan_id UUID
    REFERENCES workflow_plans(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS plan_version INTEGER
    CHECK (plan_version IS NULL OR plan_version > 0);

CREATE UNIQUE INDEX IF NOT EXISTS workflow_definitions_plan_version_idx
  ON workflow_definitions(plan_id, plan_version)
  WHERE plan_id IS NOT NULL;

ALTER TABLE workflow_instances
  ADD COLUMN IF NOT EXISTS plan_id UUID
    REFERENCES workflow_plans(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS plan_version INTEGER
    CHECK (plan_version IS NULL OR plan_version > 0);

CREATE UNIQUE INDEX IF NOT EXISTS workflow_instances_plan_version_idx
  ON workflow_instances(plan_id, plan_version)
  WHERE plan_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS workflow_plan_versions (
  id UUID PRIMARY KEY,
  plan_id UUID NOT NULL REFERENCES workflow_plans(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version > 0),
  graph JSONB NOT NULL CHECK (jsonb_typeof(graph) = 'object'),
  settings JSONB NOT NULL CHECK (jsonb_typeof(settings) = 'object'),
  source TEXT NOT NULL CHECK (source IN ('template', 'router', 'manual')),
  reason TEXT NOT NULL DEFAULT '',
  router_agent_id UUID REFERENCES router_agents(id) ON DELETE RESTRICT,
  router_project_id UUID,
  router_teammate_id UUID,
  router_agent_agent_id UUID,
  router_agent_name TEXT,
  router_ai_principal_id TEXT,
  router_template_id UUID,
  router_template_version_id UUID,
  router_template_version INTEGER,
  router_contract_tools JSONB
    CHECK (
      router_contract_tools IS NULL
      OR (
        jsonb_typeof(router_contract_tools) = 'array'
        AND jsonb_array_length(router_contract_tools) = 2
      )
    ),
  router_contract_digest TEXT
    CHECK (
      router_contract_digest IS NULL
      OR router_contract_digest ~ '^[a-f0-9]{64}$'
    ),
  content_digest TEXT NOT NULL
    CHECK (content_digest ~ '^[a-f0-9]{64}$'),
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (plan_id, version),
  CHECK (source <> 'router' OR router_agent_id IS NOT NULL)
);

CREATE OR REPLACE FUNCTION pluginmax_reject_plan_version_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'workflow plan versions are immutable';
END;
$$;

DROP TRIGGER IF EXISTS workflow_plan_versions_immutable
  ON workflow_plan_versions;
CREATE TRIGGER workflow_plan_versions_immutable
BEFORE UPDATE OR DELETE ON workflow_plan_versions
FOR EACH ROW
EXECUTE FUNCTION pluginmax_reject_plan_version_mutation();

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS creation_key TEXT;

ALTER TABLE tasks
  DROP CONSTRAINT IF EXISTS tasks_creation_key_check;

ALTER TABLE tasks
  ADD CONSTRAINT tasks_creation_key_check
  CHECK (
    creation_key IS NULL
    OR length(btrim(creation_key)) BETWEEN 8 AND 300
  );

CREATE UNIQUE INDEX IF NOT EXISTS tasks_creation_key_idx
  ON tasks(creation_key)
  WHERE creation_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS task_origins (
  task_id UUID PRIMARY KEY REFERENCES tasks(id) ON DELETE RESTRICT,
  source_kind TEXT NOT NULL CHECK (source_kind IN (
    'manual',
    'workflow',
    'router',
    'meeting',
    'capture'
  )),
  source_id TEXT NOT NULL,
  parent_task_id UUID REFERENCES tasks(id) ON DELETE RESTRICT,
  root_task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  created_by_principal_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(metadata) = 'object'),
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS task_origins_root_idx
  ON task_origins(root_task_id, created_at);

CREATE OR REPLACE FUNCTION pluginmax_reject_task_origin_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'task origins are immutable';
END;
$$;

DROP TRIGGER IF EXISTS task_origins_immutable ON task_origins;
CREATE TRIGGER task_origins_immutable
BEFORE UPDATE OR DELETE ON task_origins
FOR EACH ROW
EXECUTE FUNCTION pluginmax_reject_task_origin_mutation();

CREATE TABLE IF NOT EXISTS plan_materializations (
  id UUID PRIMARY KEY,
  plan_id UUID NOT NULL REFERENCES workflow_plans(id) ON DELETE RESTRICT,
  plan_version INTEGER NOT NULL CHECK (plan_version > 0),
  node_id TEXT NOT NULL,
  creation_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending',
    'materializing',
    'materialized',
    'failed'
  )),
  task_id UUID REFERENCES tasks(id) ON DELETE RESTRICT,
  last_error TEXT,
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (plan_id, plan_version, node_id),
  CHECK (updated_at >= created_at),
  CHECK (
    (lease_owner IS NULL AND lease_expires_at IS NULL)
    OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
  ),
  CHECK (status <> 'materialized' OR task_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS plan_materializations_recovery_idx
  ON plan_materializations(status, lease_expires_at, updated_at)
  WHERE status <> 'materialized';

CREATE TABLE IF NOT EXISTS workflow_plan_outbox_messages (
  message_id TEXT PRIMARY KEY,
  plan_id UUID NOT NULL REFERENCES workflow_plans(id) ON DELETE RESTRICT,
  plan_version INTEGER NOT NULL CHECK (plan_version > 0),
  node_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN (
    'materialize_node',
    'dispatch_node',
    'final_draft'
  )),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(payload) = 'object'),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending',
    'processing',
    'processed',
    'failed',
    'cancelled'
  )),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  processed_at TIMESTAMPTZ,
  CHECK (updated_at >= created_at),
  CHECK (
    (lease_owner IS NULL AND lease_expires_at IS NULL)
    OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS workflow_plan_outbox_claim_idx
  ON workflow_plan_outbox_messages(status, lease_expires_at, created_at)
  WHERE status IN ('pending', 'processing');

CREATE TABLE IF NOT EXISTS workflow_plan_audit_events (
  id UUID PRIMARY KEY,
  plan_id UUID NOT NULL REFERENCES workflow_plans(id) ON DELETE RESTRICT,
  seq BIGINT NOT NULL CHECK (seq > 0),
  kind TEXT NOT NULL CHECK (kind IN (
    'plan.created',
    'plan.updated',
    'plan.approved',
    'plan.materialized',
    'plan.reconciled',
    'plan.finalized',
    'plan.failed',
    'plan.resume_required',
    'router_agent.registered',
    'feature_gate.updated'
  )),
  actor_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  data JSONB CHECK (data IS NULL OR jsonb_typeof(data) = 'object'),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (plan_id, seq)
);

CREATE INDEX IF NOT EXISTS workflow_plan_audit_plan_idx
  ON workflow_plan_audit_events(plan_id, seq);
`;

export const M4_SKILL_PLATFORM_SCHEMA_SQL = `
-- M4 expand: immutable definitions, versions, installations, bindings,
-- instance extensions, run snapshots, and audit.
INSERT INTO feature_flag_settings (
  flag_key, scope_type, scope_id, mode, revision, updated_by, updated_at
) VALUES
  ('skills.platform', 'platform', 'platform', 'off', 1,
   'system:migration', NOW())
ON CONFLICT (flag_key, scope_type, scope_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS skill_definitions (
  id UUID PRIMARY KEY,
  key TEXT NOT NULL UNIQUE
    CHECK (key ~ '^[a-z0-9][a-z0-9._-]{1,79}$'),
  name TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 160),
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled', 'archived')),
  current_version INTEGER NOT NULL DEFAULT 1 CHECK (current_version > 0),
  created_by_principal_id TEXT NOT NULL
    REFERENCES principals(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (updated_at >= created_at)
);

CREATE TABLE IF NOT EXISTS skill_versions (
  id UUID PRIMARY KEY,
  skill_id UUID NOT NULL
    REFERENCES skill_definitions(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version > 0),
  digest TEXT NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  publisher_principal_id TEXT NOT NULL
    REFERENCES principals(id) ON DELETE RESTRICT,
  trust_level TEXT NOT NULL
    CHECK (trust_level IN ('official', 'verified', 'private')),
  instructions TEXT NOT NULL CHECK (length(btrim(instructions)) BETWEEN 1 AND 200000),
  manifest JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(manifest) = 'object'),
  permissions JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(permissions) = 'array'),
  triggers JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(triggers) = 'array'),
  status TEXT NOT NULL DEFAULT 'published'
    CHECK (status IN ('published', 'deprecated', 'revoked')),
  protected BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (skill_id, version),
  UNIQUE (skill_id, digest)
);

CREATE INDEX IF NOT EXISTS skill_versions_installable_idx
  ON skill_versions(skill_id, status, version DESC);

CREATE TABLE IF NOT EXISTS skill_installations (
  id UUID PRIMARY KEY,
  principal_id TEXT NOT NULL
    REFERENCES principals(id) ON DELETE RESTRICT,
  skill_id UUID NOT NULL
    REFERENCES skill_definitions(id) ON DELETE RESTRICT,
  version_id UUID NOT NULL
    REFERENCES skill_versions(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  installed_by_principal_id TEXT NOT NULL
    REFERENCES principals(id) ON DELETE RESTRICT,
  installed_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (principal_id, skill_id),
  CHECK (updated_at >= installed_at)
);

CREATE INDEX IF NOT EXISTS skill_installations_principal_idx
  ON skill_installations(principal_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS teammate_template_skill_bindings (
  id UUID PRIMARY KEY,
  template_id UUID NOT NULL
    REFERENCES teammate_templates(id) ON DELETE RESTRICT,
  skill_id UUID NOT NULL
    REFERENCES skill_definitions(id) ON DELETE RESTRICT,
  skill_version_id UUID NOT NULL
    REFERENCES skill_versions(id) ON DELETE RESTRICT,
  installation_id UUID NOT NULL
    REFERENCES skill_installations(id) ON DELETE RESTRICT,
  required BOOLEAN NOT NULL DEFAULT FALSE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  bound_by_principal_id TEXT NOT NULL
    REFERENCES principals(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (template_id, skill_id),
  CHECK (updated_at >= created_at),
  CHECK (NOT required OR enabled)
);

CREATE INDEX IF NOT EXISTS teammate_template_skill_bindings_template_idx
  ON teammate_template_skill_bindings(template_id, required DESC, created_at);

CREATE TABLE IF NOT EXISTS teammate_instance_skill_extensions (
  id UUID PRIMARY KEY,
  teammate_id UUID NOT NULL
    REFERENCES teammates(id) ON DELETE RESTRICT,
  skill_id UUID NOT NULL
    REFERENCES skill_definitions(id) ON DELETE RESTRICT,
  skill_version_id UUID NOT NULL
    REFERENCES skill_versions(id) ON DELETE RESTRICT,
  installation_id UUID NOT NULL
    REFERENCES skill_installations(id) ON DELETE RESTRICT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  added_by_principal_id TEXT NOT NULL
    REFERENCES principals(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (teammate_id, skill_id),
  CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS teammate_instance_skill_extensions_teammate_idx
  ON teammate_instance_skill_extensions(teammate_id, enabled, created_at);

CREATE TABLE IF NOT EXISTS run_skill_snapshots (
  run_id UUID PRIMARY KEY
    REFERENCES runs(id) ON DELETE RESTRICT,
  teammate_id UUID
    REFERENCES teammates(id) ON DELETE RESTRICT,
  template_id UUID
    REFERENCES teammate_templates(id) ON DELETE RESTRICT,
  template_version_id UUID
    REFERENCES teammate_template_versions(id) ON DELETE RESTRICT,
  platform_safety_rules JSONB NOT NULL
    CHECK (jsonb_typeof(platform_safety_rules) = 'array'),
  skills JSONB NOT NULL
    CHECK (jsonb_typeof(skills) = 'array'),
  snapshot_digest TEXT NOT NULL
    CHECK (snapshot_digest ~ '^[a-f0-9]{64}$'),
  captured_at TIMESTAMPTZ NOT NULL,
  CHECK (
    (teammate_id IS NULL AND template_id IS NULL AND template_version_id IS NULL)
    OR
    (teammate_id IS NOT NULL AND template_id IS NOT NULL AND template_version_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS run_skill_snapshots_teammate_idx
  ON run_skill_snapshots(teammate_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS skill_audit_events (
  id UUID PRIMARY KEY,
  seq BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  resource_type TEXT NOT NULL
    CHECK (resource_type IN ('skill', 'template', 'teammate', 'run')),
  resource_id TEXT NOT NULL
    CHECK (length(btrim(resource_id)) BETWEEN 1 AND 180),
  kind TEXT NOT NULL CHECK (kind IN (
    'skill.definition.created',
    'skill.version.published',
    'skill.installed',
    'skill.uninstalled',
    'skills.bound',
    'skills.unbound',
    'skills.extension.added',
    'skills.extension.removed',
    'run.skills.snapshot'
  )),
  actor_principal_id TEXT NOT NULL
    REFERENCES principals(id) ON DELETE RESTRICT,
  summary TEXT NOT NULL CHECK (length(btrim(summary)) BETWEEN 1 AND 4000),
  data JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(data) = 'object'),
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS skill_audit_events_resource_idx
  ON skill_audit_events(resource_type, resource_id, seq DESC);

-- M4 backfill / validate: historical Runs remain untouched. Existing rows
-- receive no synthetic Skill Snapshot; the next newly-created Run captures one.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM skill_definitions AS definition
    LEFT JOIN skill_versions AS version
      ON version.skill_id = definition.id
     AND version.version = definition.current_version
    WHERE version.id IS NULL
      AND EXISTS (
        SELECT 1 FROM skill_versions WHERE skill_id = definition.id
      )
  ) THEN
    RAISE EXCEPTION 'M4 Skill Definition current_version is inconsistent';
  END IF;
END;
$$;

-- M4 enforce: immutable versions and snapshots, protected required bindings,
-- append-only extensions, and append-only Skill audit.
CREATE OR REPLACE FUNCTION pluginmax_reject_skill_version_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'skill versions are immutable';
END;
$$;

DROP TRIGGER IF EXISTS skill_versions_immutable ON skill_versions;
CREATE TRIGGER skill_versions_immutable
BEFORE UPDATE OR DELETE ON skill_versions
FOR EACH ROW
EXECUTE FUNCTION pluginmax_reject_skill_version_mutation();

CREATE OR REPLACE FUNCTION pluginmax_reject_run_skill_snapshot_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'run Skill snapshots are immutable';
END;
$$;

DROP TRIGGER IF EXISTS run_skill_snapshots_immutable ON run_skill_snapshots;
CREATE TRIGGER run_skill_snapshots_immutable
BEFORE UPDATE OR DELETE ON run_skill_snapshots
FOR EACH ROW
EXECUTE FUNCTION pluginmax_reject_run_skill_snapshot_mutation();

CREATE OR REPLACE FUNCTION pluginmax_protect_required_skill_binding()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.required THEN
    RAISE EXCEPTION 'required Skill bindings cannot be deleted';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.required AND (
    NEW.template_id IS DISTINCT FROM OLD.template_id
    OR NEW.skill_id IS DISTINCT FROM OLD.skill_id
    OR NEW.required = FALSE
    OR NEW.enabled = FALSE
  ) THEN
    RAISE EXCEPTION 'required Skill bindings cannot be disabled or shadowed';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS teammate_template_skill_bindings_required_protected
  ON teammate_template_skill_bindings;
CREATE TRIGGER teammate_template_skill_bindings_required_protected
BEFORE UPDATE OR DELETE ON teammate_template_skill_bindings
FOR EACH ROW
EXECUTE FUNCTION pluginmax_protect_required_skill_binding();

CREATE OR REPLACE FUNCTION pluginmax_assert_skill_extension_not_shadowing()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM teammates AS teammate
    JOIN teammate_template_skill_bindings AS binding
      ON binding.template_id = teammate.template_id
     AND binding.skill_id = NEW.skill_id
     AND binding.required = TRUE
    WHERE teammate.id = NEW.teammate_id
  ) THEN
    RAISE EXCEPTION 'instance Skill extension cannot shadow a required Skill';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS teammate_instance_skill_extensions_no_shadow
  ON teammate_instance_skill_extensions;
CREATE TRIGGER teammate_instance_skill_extensions_no_shadow
BEFORE INSERT OR UPDATE OF skill_id, teammate_id
ON teammate_instance_skill_extensions
FOR EACH ROW
EXECUTE FUNCTION pluginmax_assert_skill_extension_not_shadowing();

CREATE OR REPLACE FUNCTION pluginmax_protect_required_skill_installation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (TG_OP = 'DELETE' OR NEW.status = 'disabled')
    AND EXISTS (
      SELECT 1
      FROM teammate_template_skill_bindings
      WHERE installation_id = OLD.id
        AND required = TRUE
    )
  THEN
    RAISE EXCEPTION 'required Skill installations cannot be disabled or deleted';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS skill_installations_required_protected
  ON skill_installations;
CREATE TRIGGER skill_installations_required_protected
BEFORE UPDATE OR DELETE ON skill_installations
FOR EACH ROW
EXECUTE FUNCTION pluginmax_protect_required_skill_installation();

CREATE OR REPLACE FUNCTION pluginmax_reject_skill_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Skill audit events are append-only';
END;
$$;

DROP TRIGGER IF EXISTS skill_audit_events_append_only
  ON skill_audit_events;
CREATE TRIGGER skill_audit_events_append_only
BEFORE UPDATE OR DELETE ON skill_audit_events
FOR EACH ROW
EXECUTE FUNCTION pluginmax_reject_skill_audit_mutation();
`;

export const M5_COLLABORATION_CONTEXT_SCHEMA_SQL = `
-- M5 expand: collaboration capture, participant-bound Scene Sessions,
-- versioned Context Policy, Runtime-consumed Context commits, and Meeting AI
-- multi-participant controls.
INSERT INTO feature_flag_settings (
  flag_key, scope_type, scope_id, mode, revision, updated_by, updated_at
) VALUES
  ('task.capture', 'platform', 'platform', 'off', 1,
   'system:migration', NOW()),
  ('context.group_policy', 'platform', 'platform', 'off', 1,
   'system:migration', NOW())
ON CONFLICT (flag_key, scope_type, scope_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS scene_participant_bindings (
  id UUID PRIMARY KEY,
  scene_type TEXT NOT NULL CHECK (scene_type IN ('group', 'meeting')),
  scene_id TEXT NOT NULL
    CHECK (length(btrim(scene_id)) BETWEEN 1 AND 240),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  participant_kind TEXT NOT NULL DEFAULT 'ai'
    CHECK (participant_kind = 'ai'),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  agent_principal_id TEXT NOT NULL
    CHECK (length(btrim(agent_principal_id)) BETWEEN 1 AND 180),
  principal_id TEXT NOT NULL
    CHECK (length(btrim(principal_id)) BETWEEN 1 AND 180),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'left', 'removed')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  joined_at TIMESTAMPTZ NOT NULL,
  left_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (scene_type, scene_id, agent_id, principal_id),
  CHECK (
    (status IN ('left', 'removed') AND left_at IS NOT NULL)
    OR (status IN ('active', 'paused') AND left_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS scene_participant_bindings_scene_idx
  ON scene_participant_bindings(scene_type, scene_id, status, joined_at);

CREATE INDEX IF NOT EXISTS scene_participant_bindings_project_idx
  ON scene_participant_bindings(project_id, updated_at DESC);

ALTER TABLE scene_sessions
  ADD COLUMN IF NOT EXISTS participant_binding_id UUID
    REFERENCES scene_participant_bindings(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS last_context_seq BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS context_usage_ratio NUMERIC(8, 6)
    NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS compaction_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE scene_sessions
  DROP CONSTRAINT IF EXISTS scene_sessions_status_check;
ALTER TABLE scene_sessions
  ADD CONSTRAINT scene_sessions_status_check
  CHECK (status IN ('preparing', 'active', 'archived', 'reset'));

ALTER TABLE scene_sessions
  DROP CONSTRAINT IF EXISTS scene_sessions_scene_type_check;
ALTER TABLE scene_sessions
  ADD CONSTRAINT scene_sessions_scene_type_check
  CHECK (scene_type IN (
    'task',
    'workflow-node',
    'meeting',
    'direct-chat',
    'delegation',
    'group'
  ));

ALTER TABLE scene_sessions
  DROP CONSTRAINT IF EXISTS scene_sessions_revision_check,
  DROP CONSTRAINT IF EXISTS scene_sessions_last_context_seq_check,
  DROP CONSTRAINT IF EXISTS scene_sessions_context_usage_ratio_check,
  DROP CONSTRAINT IF EXISTS scene_sessions_compaction_count_check;

ALTER TABLE scene_sessions
  ADD CONSTRAINT scene_sessions_revision_check CHECK (revision > 0),
  ADD CONSTRAINT scene_sessions_last_context_seq_check
    CHECK (last_context_seq >= 0),
  ADD CONSTRAINT scene_sessions_context_usage_ratio_check
    CHECK (context_usage_ratio >= 0),
  ADD CONSTRAINT scene_sessions_compaction_count_check
    CHECK (compaction_count >= 0);

INSERT INTO scene_participant_bindings (
  id, scene_type, scene_id, project_id, participant_kind, agent_id,
  agent_principal_id, principal_id, status, revision, joined_at, left_at,
  updated_at
)
SELECT
  gen_random_uuid(),
  CASE
    WHEN session.scene_type = 'meeting' THEN 'meeting'
    ELSE 'group'
  END,
  session.scene_id,
  session.project_id,
  'ai',
  session.agent_id,
  COALESCE(session.agent_principal_id, session.agent_id::text),
  COALESCE(
    session.owner_principal_id,
    session.agent_principal_id,
    session.agent_id::text
  ),
  'active',
  1,
  session.created_at,
  NULL,
  session.updated_at
FROM scene_sessions AS session
WHERE session.project_id IS NOT NULL
  AND session.scene_type IN ('meeting', 'group')
  AND NOT EXISTS (
    SELECT 1
    FROM scene_participant_bindings AS binding
    WHERE binding.scene_type =
        CASE
          WHEN session.scene_type = 'meeting' THEN 'meeting'
          ELSE 'group'
        END
      AND binding.scene_id = session.scene_id
      AND binding.agent_id = session.agent_id
      AND binding.principal_id = COALESCE(
        session.owner_principal_id,
        session.agent_principal_id,
        session.agent_id::text
      )
  )
ON CONFLICT (scene_type, scene_id, agent_id, principal_id) DO NOTHING;

UPDATE scene_sessions AS session
SET participant_binding_id = binding.id
FROM scene_participant_bindings AS binding
WHERE session.participant_binding_id IS NULL
  AND session.scene_type IN ('meeting', 'group')
  AND binding.scene_type =
    CASE
      WHEN session.scene_type = 'meeting' THEN 'meeting'
      ELSE 'group'
    END
  AND binding.scene_id = session.scene_id
  AND binding.agent_id = session.agent_id
  AND binding.principal_id = COALESCE(
    session.owner_principal_id,
    session.agent_principal_id,
    session.agent_id::text
  );

UPDATE scene_sessions AS session
SET
  last_context_seq = COALESCE(cursor.cursor_sequence, 0),
  status = CASE
    WHEN session.status = 'active' AND COALESCE(cursor.cursor_sequence, 0) = 0
      THEN 'preparing'
    ELSE session.status
  END
FROM (
  SELECT
    scene_session_id,
    cursor_sequence
  FROM scene_context_delivery_cursors
) AS cursor
WHERE cursor.scene_session_id = session.id
  AND session.last_context_seq = 0;

ALTER TABLE scene_sessions
  DROP CONSTRAINT IF EXISTS
    scene_sessions_scene_type_scene_id_agent_id_principal_scope_generation_key;

CREATE UNIQUE INDEX IF NOT EXISTS
  scene_sessions_participant_binding_generation_idx
  ON scene_sessions(
    scene_type,
    scene_id,
    participant_binding_id,
    agent_id,
    principal_scope,
    generation
  )
  WHERE participant_binding_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS scene_sessions_legacy_generation_idx
  ON scene_sessions(
    scene_type,
    scene_id,
    agent_id,
    principal_scope,
    generation
  )
  WHERE participant_binding_id IS NULL;

CREATE OR REPLACE FUNCTION pluginmax_guard_scene_session_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.id IS DISTINCT FROM NEW.id
    OR OLD.scene_type IS DISTINCT FROM NEW.scene_type
    OR OLD.scene_id IS DISTINCT FROM NEW.scene_id
    OR OLD.participant_binding_id IS DISTINCT FROM NEW.participant_binding_id
    OR OLD.agent_id IS DISTINCT FROM NEW.agent_id
    OR OLD.agent_principal_id IS DISTINCT FROM NEW.agent_principal_id
    OR OLD.owner_principal_id IS DISTINCT FROM NEW.owner_principal_id
    OR OLD.channel_id IS DISTINCT FROM NEW.channel_id
    OR OLD.session_handle IS DISTINCT FROM NEW.session_handle
    OR OLD.generation IS DISTINCT FROM NEW.generation
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
  THEN
    RAISE EXCEPTION 'scene session identity is immutable';
  END IF;
  IF NEW.revision < OLD.revision
    OR NEW.last_context_seq < OLD.last_context_seq
    OR NEW.compaction_count < OLD.compaction_count
  THEN
    RAISE EXCEPTION 'scene session progress cannot move backwards';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS context_policy_heads (
  scope_type TEXT NOT NULL CHECK (scope_type IN ('platform', 'project')),
  scope_id TEXT NOT NULL
    CHECK (length(btrim(scope_id)) BETWEEN 1 AND 180),
  scene_type TEXT NOT NULL
    CHECK (scene_type IN ('default', 'direct-chat', 'group', 'meeting')),
  warning_ratio NUMERIC(8, 6) NOT NULL CHECK (
    warning_ratio >= 0 AND warning_ratio <= 1
  ),
  compact_ratio NUMERIC(8, 6) NOT NULL CHECK (
    compact_ratio >= warning_ratio AND compact_ratio <= 1
  ),
  rollover_ratio NUMERIC(8, 6) NOT NULL CHECK (
    rollover_ratio >= compact_ratio AND rollover_ratio <= 1
  ),
  preserve_recent_messages INTEGER NOT NULL
    CHECK (preserve_recent_messages >= 0),
  max_trigger_depth INTEGER NOT NULL CHECK (max_trigger_depth > 0),
  max_concurrent_agents_per_scene INTEGER NOT NULL
    CHECK (max_concurrent_agents_per_scene > 0),
  max_context_chars INTEGER NOT NULL CHECK (max_context_chars > 0),
  revision INTEGER NOT NULL CHECK (revision > 0),
  updated_by TEXT NOT NULL
    CHECK (length(btrim(updated_by)) BETWEEN 1 AND 180),
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (scope_type, scope_id, scene_type)
);

CREATE TABLE IF NOT EXISTS context_policy_versions (
  id UUID PRIMARY KEY,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('platform', 'project')),
  scope_id TEXT NOT NULL
    CHECK (length(btrim(scope_id)) BETWEEN 1 AND 180),
  scene_type TEXT NOT NULL
    CHECK (scene_type IN ('default', 'direct-chat', 'group', 'meeting')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  warning_ratio NUMERIC(8, 6) NOT NULL,
  compact_ratio NUMERIC(8, 6) NOT NULL,
  rollover_ratio NUMERIC(8, 6) NOT NULL,
  preserve_recent_messages INTEGER NOT NULL,
  max_trigger_depth INTEGER NOT NULL,
  max_concurrent_agents_per_scene INTEGER NOT NULL,
  max_context_chars INTEGER NOT NULL,
  source TEXT NOT NULL
    CHECK (source IN ('update', 'reset', 'seed')),
  updated_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (scope_type, scope_id, scene_type, revision)
);

CREATE INDEX IF NOT EXISTS context_policy_versions_scope_idx
  ON context_policy_versions(scope_type, scope_id, scene_type, revision DESC);

CREATE OR REPLACE FUNCTION pluginmax_reject_context_policy_version_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Context Policy versions are immutable';
END;
$$;

DROP TRIGGER IF EXISTS context_policy_versions_immutable
  ON context_policy_versions;
CREATE TRIGGER context_policy_versions_immutable
BEFORE UPDATE OR DELETE ON context_policy_versions
FOR EACH ROW
EXECUTE FUNCTION pluginmax_reject_context_policy_version_mutation();

INSERT INTO context_policy_heads (
  scope_type, scope_id, scene_type, warning_ratio, compact_ratio,
  rollover_ratio, preserve_recent_messages, max_trigger_depth,
  max_concurrent_agents_per_scene, max_context_chars, revision,
  updated_by, updated_at
)
SELECT
  'platform',
  'platform',
  scene_type,
  0.7,
  0.85,
  0.95,
  12,
  3,
  3,
  32000,
  1,
  'system:migration',
  NOW()
FROM (VALUES ('default'), ('direct-chat'), ('group'), ('meeting'))
  AS scenes(scene_type)
ON CONFLICT (scope_type, scope_id, scene_type) DO NOTHING;

INSERT INTO context_policy_versions (
  id, scope_type, scope_id, scene_type, revision, warning_ratio,
  compact_ratio, rollover_ratio, preserve_recent_messages,
  max_trigger_depth, max_concurrent_agents_per_scene, max_context_chars,
  source, updated_by, created_at
)
SELECT
  gen_random_uuid(),
  head.scope_type,
  head.scope_id,
  head.scene_type,
  head.revision,
  head.warning_ratio,
  head.compact_ratio,
  head.rollover_ratio,
  head.preserve_recent_messages,
  head.max_trigger_depth,
  head.max_concurrent_agents_per_scene,
  head.max_context_chars,
  'seed',
  head.updated_by,
  head.updated_at
FROM context_policy_heads AS head
WHERE head.scope_type = 'platform'
  AND head.scope_id = 'platform'
ON CONFLICT (scope_type, scope_id, scene_type, revision) DO NOTHING;

ALTER TABLE context_packs
  ADD COLUMN IF NOT EXISTS context_boundary_seq BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS context_policy_version INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS context_usage_ratio NUMERIC(8, 6)
    NOT NULL DEFAULT 0;

ALTER TABLE scene_context_receipts
  ADD COLUMN IF NOT EXISTS context_boundary_seq BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS context_policy_version INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS context_usage_ratio NUMERIC(8, 6)
    NOT NULL DEFAULT 0;

ALTER TABLE context_packs
  DROP CONSTRAINT IF EXISTS context_packs_context_boundary_seq_check,
  DROP CONSTRAINT IF EXISTS context_packs_context_policy_version_check,
  DROP CONSTRAINT IF EXISTS context_packs_context_usage_ratio_check;

ALTER TABLE context_packs
  ADD CONSTRAINT context_packs_context_boundary_seq_check
    CHECK (context_boundary_seq IS NULL OR context_boundary_seq >= 0),
  ADD CONSTRAINT context_packs_context_policy_version_check
    CHECK (context_policy_version IS NULL OR context_policy_version >= 0),
  ADD CONSTRAINT context_packs_context_usage_ratio_check
    CHECK (context_usage_ratio IS NULL OR context_usage_ratio >= 0);

ALTER TABLE scene_context_receipts
  DROP CONSTRAINT IF EXISTS
    scene_context_receipts_context_boundary_seq_check,
  DROP CONSTRAINT IF EXISTS
    scene_context_receipts_context_policy_version_check,
  DROP CONSTRAINT IF EXISTS
    scene_context_receipts_context_usage_ratio_check;

ALTER TABLE scene_context_receipts
  ADD CONSTRAINT scene_context_receipts_context_boundary_seq_check
    CHECK (context_boundary_seq >= 0),
  ADD CONSTRAINT scene_context_receipts_context_policy_version_check
    CHECK (context_policy_version >= 0),
  ADD CONSTRAINT scene_context_receipts_context_usage_ratio_check
    CHECK (context_usage_ratio >= 0);

CREATE TABLE IF NOT EXISTS scene_context_commit_receipts (
  id UUID PRIMARY KEY,
  run_id UUID NOT NULL UNIQUE REFERENCES runs(id) ON DELETE RESTRICT,
  context_pack_id UUID NOT NULL UNIQUE
    REFERENCES context_packs(id) ON DELETE RESTRICT,
  scene_session_id UUID NOT NULL
    REFERENCES scene_sessions(id) ON DELETE RESTRICT,
  context_boundary_seq BIGINT NOT NULL CHECK (context_boundary_seq >= 0),
  previous_context_seq BIGINT NOT NULL CHECK (previous_context_seq >= 0),
  context_policy_version INTEGER NOT NULL
    CHECK (context_policy_version >= 0),
  context_usage_ratio NUMERIC(8, 6) NOT NULL
    CHECK (context_usage_ratio >= 0),
  runtime_success BOOLEAN NOT NULL CHECK (runtime_success = TRUE),
  committed_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS scene_context_commit_receipts_session_idx
  ON scene_context_commit_receipts(scene_session_id, committed_at DESC);

CREATE OR REPLACE FUNCTION pluginmax_reject_scene_context_commit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Scene Context commit receipts are immutable';
END;
$$;

DROP TRIGGER IF EXISTS scene_context_commit_receipts_immutable
  ON scene_context_commit_receipts;
CREATE TRIGGER scene_context_commit_receipts_immutable
BEFORE UPDATE OR DELETE ON scene_context_commit_receipts
FOR EACH ROW
EXECUTE FUNCTION pluginmax_reject_scene_context_commit_mutation();

ALTER TABLE scene_context_contributions
  DROP CONSTRAINT IF EXISTS scene_context_contributions_scene_type_check;
ALTER TABLE scene_context_contributions
  ADD CONSTRAINT scene_context_contributions_scene_type_check
  CHECK (scene_type IN (
    'task',
    'workflow-node',
    'meeting',
    'direct-chat',
    'delegation',
    'group'
  ));

ALTER TABLE scene_context_receipts
  DROP CONSTRAINT IF EXISTS scene_context_receipts_scene_type_check;
ALTER TABLE scene_context_receipts
  ADD CONSTRAINT scene_context_receipts_scene_type_check
  CHECK (scene_type IN (
    'task',
    'workflow-node',
    'meeting',
    'direct-chat',
    'delegation',
    'group'
  ));

ALTER TABLE context_packs
  DROP CONSTRAINT IF EXISTS context_packs_scene_type_check;
ALTER TABLE context_packs
  ADD CONSTRAINT context_packs_scene_type_check
  CHECK (
    scene_type IS NULL
    OR scene_type IN (
      'task',
      'workflow-node',
      'meeting',
      'direct-chat',
      'delegation',
      'group'
    )
  );

CREATE TABLE IF NOT EXISTS task_capture_sessions (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  source_type TEXT NOT NULL CHECK (source_type IN (
    'direct-chat',
    'meeting',
    'workbench',
    'workflow',
    'manual'
  )),
  source_id TEXT NOT NULL
    CHECK (length(btrim(source_id)) BETWEEN 1 AND 240),
  source_version TEXT NOT NULL
    CHECK (length(btrim(source_version)) BETWEEN 1 AND 120),
  owner_principal_id TEXT NOT NULL
    CHECK (length(btrim(owner_principal_id)) BETWEEN 1 AND 180),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived', 'expired')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (project_id, source_type, source_id, source_version, owner_principal_id)
);

CREATE INDEX IF NOT EXISTS task_capture_sessions_project_idx
  ON task_capture_sessions(project_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS task_capture_candidates (
  id UUID PRIMARY KEY,
  session_id UUID NOT NULL
    REFERENCES task_capture_sessions(id) ON DELETE RESTRICT,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  source_type TEXT NOT NULL CHECK (source_type IN (
    'direct-chat',
    'meeting',
    'workbench',
    'workflow',
    'manual'
  )),
  source_id TEXT NOT NULL
    CHECK (length(btrim(source_id)) BETWEEN 1 AND 240),
  source_version TEXT NOT NULL
    CHECK (length(btrim(source_version)) BETWEEN 1 AND 120),
  source_refs JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(source_refs) = 'array'),
  excerpt TEXT NOT NULL
    CHECK (length(btrim(excerpt)) BETWEEN 1 AND 20000),
  excerpt_hash TEXT NOT NULL CHECK (excerpt_hash ~ '^[a-f0-9]{64}$'),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN (
      'pending',
      'drafting',
      'converted',
      'dismissed',
      'invalidated'
    )),
  invalidation_reason TEXT
    CHECK (
      invalidation_reason IS NULL
      OR length(invalidation_reason) <= 2000
    ),
  invalidated_at TIMESTAMPTZ,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (session_id, source_id, source_version, excerpt_hash),
  CHECK (
    (status = 'invalidated'
      AND invalidation_reason IS NOT NULL
      AND invalidated_at IS NOT NULL)
    OR (status <> 'invalidated'
      AND invalidation_reason IS NULL
      AND invalidated_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS task_capture_candidates_session_idx
  ON task_capture_candidates(session_id, status, created_at);

CREATE TABLE IF NOT EXISTS task_draft_batches (
  id UUID PRIMARY KEY,
  session_id UUID NOT NULL
    REFERENCES task_capture_sessions(id) ON DELETE RESTRICT,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'preparing'
    CHECK (status IN (
      'preparing',
      'committing',
      'committed',
      'partial',
      'failed'
    )),
  creation_key TEXT NOT NULL UNIQUE
    CHECK (
      length(btrim(creation_key)) BETWEEN 8 AND 300
      AND creation_key ~ '^[a-zA-Z0-9_.:-]+$'
    ),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by_principal_id TEXT NOT NULL
    CHECK (length(btrim(created_by_principal_id)) BETWEEN 1 AND 180),
  result JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(result) = 'object'),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS task_draft_batches_session_idx
  ON task_draft_batches(session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS task_drafts (
  id UUID PRIMARY KEY,
  batch_id UUID NOT NULL
    REFERENCES task_draft_batches(id) ON DELETE RESTRICT,
  session_id UUID NOT NULL
    REFERENCES task_capture_sessions(id) ON DELETE RESTRICT,
  candidate_id UUID NOT NULL
    REFERENCES task_capture_candidates(id) ON DELETE RESTRICT,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  title TEXT NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 240),
  description TEXT NOT NULL
    CHECK (length(btrim(description)) BETWEEN 1 AND 20000),
  acceptance JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(acceptance) = 'array'),
  priority TEXT NOT NULL DEFAULT 'medium'
    CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  agent_id UUID REFERENCES agents(id) ON DELETE RESTRICT,
  role_id UUID REFERENCES project_roles(id) ON DELETE RESTRICT,
  creation_key TEXT NOT NULL UNIQUE
    CHECK (
      length(btrim(creation_key)) BETWEEN 8 AND 300
      AND creation_key ~ '^[a-zA-Z0-9_.:-]+$'
    ),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN (
      'draft',
      'committing',
      'committed',
      'failed',
      'discarded',
      'invalidated'
    )),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  source_type TEXT NOT NULL CHECK (source_type IN (
    'direct-chat',
    'meeting',
    'workbench',
    'workflow',
    'manual'
  )),
  source_id TEXT NOT NULL
    CHECK (length(btrim(source_id)) BETWEEN 1 AND 240),
  source_version TEXT NOT NULL
    CHECK (length(btrim(source_version)) BETWEEN 1 AND 120),
  excerpt_hash TEXT NOT NULL CHECK (excerpt_hash ~ '^[a-f0-9]{64}$'),
  invalidation_reason TEXT
    CHECK (
      invalidation_reason IS NULL
      OR length(invalidation_reason) <= 2000
    ),
  invalidated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (batch_id, candidate_id),
  CHECK (agent_id IS NULL OR role_id IS NULL),
  CHECK (
    (status = 'invalidated'
      AND invalidation_reason IS NOT NULL
      AND invalidated_at IS NOT NULL)
    OR (status <> 'invalidated'
      AND invalidation_reason IS NULL
      AND invalidated_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS task_drafts_batch_idx
  ON task_drafts(batch_id, created_at, id);

CREATE TABLE IF NOT EXISTS task_draft_conversions (
  id UUID PRIMARY KEY,
  draft_id UUID NOT NULL UNIQUE
    REFERENCES task_drafts(id) ON DELETE RESTRICT,
  creation_key TEXT NOT NULL UNIQUE
    CHECK (length(btrim(creation_key)) BETWEEN 8 AND 300),
  status TEXT NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing', 'committed', 'reused', 'failed')),
  task_id UUID REFERENCES tasks(id) ON DELETE RESTRICT,
  error_code TEXT,
  error_message TEXT
    CHECK (error_message IS NULL OR length(error_message) <= 4000),
  attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt > 0),
  result JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(result) = 'object'),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (
    (status IN ('committed', 'reused') AND task_id IS NOT NULL)
    OR (status <> 'committed' AND status <> 'reused')
  )
);

CREATE OR REPLACE FUNCTION pluginmax_guard_task_capture_session_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Task Capture source facts cannot be deleted';
  END IF;
  IF OLD.project_id IS DISTINCT FROM NEW.project_id
    OR OLD.source_type IS DISTINCT FROM NEW.source_type
    OR OLD.source_id IS DISTINCT FROM NEW.source_id
    OR OLD.source_version IS DISTINCT FROM NEW.source_version
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
  THEN
    RAISE EXCEPTION 'Task Capture source identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION pluginmax_guard_task_capture_candidate_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Task Capture source facts cannot be deleted';
  END IF;
  IF OLD.project_id IS DISTINCT FROM NEW.project_id
    OR OLD.source_type IS DISTINCT FROM NEW.source_type
    OR OLD.source_id IS DISTINCT FROM NEW.source_id
    OR OLD.source_version IS DISTINCT FROM NEW.source_version
    OR OLD.excerpt_hash IS DISTINCT FROM NEW.excerpt_hash
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
  THEN
    RAISE EXCEPTION 'Task Capture source identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION pluginmax_guard_task_draft_source_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Task Capture source facts cannot be deleted';
  END IF;
  IF OLD.project_id IS DISTINCT FROM NEW.project_id
    OR OLD.source_type IS DISTINCT FROM NEW.source_type
    OR OLD.source_id IS DISTINCT FROM NEW.source_id
    OR OLD.source_version IS DISTINCT FROM NEW.source_version
    OR OLD.excerpt_hash IS DISTINCT FROM NEW.excerpt_hash
    OR OLD.creation_key IS DISTINCT FROM NEW.creation_key
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
  THEN
    RAISE EXCEPTION 'Task Capture source identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS task_capture_sessions_source_immutable
  ON task_capture_sessions;
CREATE TRIGGER task_capture_sessions_source_immutable
BEFORE UPDATE OR DELETE ON task_capture_sessions
FOR EACH ROW
EXECUTE FUNCTION pluginmax_guard_task_capture_session_identity();

DROP TRIGGER IF EXISTS task_capture_candidates_source_immutable
  ON task_capture_candidates;
CREATE TRIGGER task_capture_candidates_source_immutable
BEFORE UPDATE OR DELETE ON task_capture_candidates
FOR EACH ROW
EXECUTE FUNCTION pluginmax_guard_task_capture_candidate_identity();

DROP TRIGGER IF EXISTS task_drafts_source_immutable ON task_drafts;
CREATE TRIGGER task_drafts_source_immutable
BEFORE UPDATE OR DELETE ON task_drafts
FOR EACH ROW
EXECUTE FUNCTION pluginmax_guard_task_draft_source_identity();

ALTER TABLE meeting_ai_policies
  ADD COLUMN IF NOT EXISTS auto_speak TEXT NOT NULL DEFAULT 'mentions',
  ADD COLUMN IF NOT EXISTS max_trigger_depth INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS max_concurrent_agents_per_scene INTEGER
    NOT NULL DEFAULT 3;

ALTER TABLE meeting_ai_policies
  DROP CONSTRAINT IF EXISTS meeting_ai_policies_auto_speak_check,
  DROP CONSTRAINT IF EXISTS meeting_ai_policies_max_trigger_depth_check,
  DROP CONSTRAINT IF EXISTS
    meeting_ai_policies_max_concurrent_agents_per_scene_check;

ALTER TABLE meeting_ai_policies
  ADD CONSTRAINT meeting_ai_policies_auto_speak_check
    CHECK (auto_speak IN ('all', 'mentions', 'manual')),
  ADD CONSTRAINT meeting_ai_policies_max_trigger_depth_check
    CHECK (max_trigger_depth > 0),
  ADD CONSTRAINT meeting_ai_policies_max_concurrent_agents_per_scene_check
    CHECK (max_concurrent_agents_per_scene > 0);

ALTER TABLE meeting_ai_participants
  ADD COLUMN IF NOT EXISTS participant_binding_id UUID
    REFERENCES scene_participant_bindings(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS agent_principal_id TEXT,
  ADD COLUMN IF NOT EXISTS principal_id TEXT,
  ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS updated_by TEXT;

ALTER TABLE meeting_ai_participants
  DROP CONSTRAINT IF EXISTS meeting_ai_participants_revision_check;
ALTER TABLE meeting_ai_participants
  ADD CONSTRAINT meeting_ai_participants_revision_check
  CHECK (revision > 0);

INSERT INTO scene_participant_bindings (
  id, scene_type, scene_id, project_id, participant_kind, agent_id,
  agent_principal_id, principal_id, status, revision, joined_at, left_at,
  updated_at
)
SELECT
  gen_random_uuid(),
  'meeting',
  participant.meeting_id::text,
  participant.project_id,
  'ai',
  participant.agent_id,
  COALESCE(agent_principal.id, participant.agent_id::text),
  COALESCE(agent_principal.id, participant.agent_id::text),
  CASE participant.status
    WHEN 'active' THEN 'active'
    WHEN 'paused' THEN 'paused'
    ELSE 'removed'
  END,
  1,
  participant.joined_at,
  CASE WHEN participant.status = 'removed' THEN participant.updated_at END,
  participant.updated_at
FROM meeting_ai_participants AS participant
LEFT JOIN LATERAL (
  SELECT principal.id
  FROM agents AS agent
  JOIN principals AS principal
    ON principal.id = agent.id::text
  WHERE agent.id = participant.agent_id
  LIMIT 1
) AS agent_principal ON TRUE
WHERE NOT EXISTS (
  SELECT 1
  FROM scene_participant_bindings AS binding
  WHERE binding.scene_type = 'meeting'
    AND binding.scene_id = participant.meeting_id::text
    AND binding.agent_id = participant.agent_id
)
ON CONFLICT (scene_type, scene_id, agent_id, principal_id) DO NOTHING;

UPDATE meeting_ai_participants AS participant
SET
  participant_binding_id = binding.id,
  agent_principal_id = binding.agent_principal_id,
  principal_id = binding.principal_id,
  revision = GREATEST(participant.revision, binding.revision),
  updated_by = COALESCE(participant.updated_by, 'system:migration')
FROM scene_participant_bindings AS binding
WHERE participant.participant_binding_id IS NULL
  AND binding.scene_type = 'meeting'
  AND binding.scene_id = participant.meeting_id::text
  AND binding.agent_id = participant.agent_id;

ALTER TABLE meeting_messages
  ADD COLUMN IF NOT EXISTS sequence BIGINT,
  ADD COLUMN IF NOT EXISTS trigger_depth INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS participant_binding_id UUID
    REFERENCES scene_participant_bindings(id) ON DELETE SET NULL;

WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY meeting_id
      ORDER BY created_at, id
    ) AS sequence
  FROM meeting_messages
)
UPDATE meeting_messages AS message
SET sequence = ranked.sequence
FROM ranked
WHERE ranked.id = message.id
  AND message.sequence IS NULL;

ALTER TABLE meeting_messages
  ALTER COLUMN sequence SET NOT NULL;

ALTER TABLE meeting_messages
  DROP CONSTRAINT IF EXISTS meeting_messages_sequence_check,
  DROP CONSTRAINT IF EXISTS meeting_messages_trigger_depth_check;

ALTER TABLE meeting_messages
  ADD CONSTRAINT meeting_messages_sequence_check CHECK (sequence > 0),
  ADD CONSTRAINT meeting_messages_trigger_depth_check
    CHECK (trigger_depth >= 0);

CREATE UNIQUE INDEX IF NOT EXISTS meeting_messages_sequence_idx
  ON meeting_messages(meeting_id, sequence);

CREATE OR REPLACE FUNCTION pluginmax_assign_meeting_message_sequence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.sequence IS NULL THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('meeting-message-sequence:' || NEW.meeting_id::text, 0)
    );
    SELECT COALESCE(MAX(sequence), 0) + 1
    INTO NEW.sequence
    FROM meeting_messages
    WHERE meeting_id = NEW.meeting_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS meeting_messages_assign_sequence
  ON meeting_messages;
CREATE TRIGGER meeting_messages_assign_sequence
BEFORE INSERT ON meeting_messages
FOR EACH ROW
EXECUTE FUNCTION pluginmax_assign_meeting_message_sequence();

ALTER TABLE meeting_ai_turns
  ADD COLUMN IF NOT EXISTS participant_binding_id UUID
    REFERENCES scene_participant_bindings(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS agent_principal_id TEXT,
  ADD COLUMN IF NOT EXISTS trigger_depth INTEGER NOT NULL DEFAULT 0;

ALTER TABLE meeting_ai_turns
  DROP CONSTRAINT IF EXISTS meeting_ai_turns_trigger_depth_check;
ALTER TABLE meeting_ai_turns
  ADD CONSTRAINT meeting_ai_turns_trigger_depth_check
  CHECK (trigger_depth >= 0);

UPDATE meeting_ai_turns AS turn
SET
  participant_binding_id = participant.participant_binding_id,
  agent_principal_id = participant.agent_principal_id
FROM meeting_ai_participants AS participant
WHERE turn.participant_binding_id IS NULL
  AND participant.meeting_id = turn.meeting_id
  AND participant.agent_id = turn.agent_id;

UPDATE meeting_ai_turns AS turn
SET trigger_depth = message.trigger_depth
FROM meeting_messages AS message
WHERE message.id = turn.source_message_id
  AND turn.trigger_depth = 0;
`;

export const M6_PROJECT_OPERATIONS_SCHEMA_SQL = `
-- M6 expand: project-scoped AI PM provisioning state and report metadata.
INSERT INTO feature_flag_settings (
  flag_key, scope_type, scope_id, mode, revision, updated_by, updated_at
) VALUES
  ('project.ai_pm', 'platform', 'platform', 'off', 1,
   'system:migration', NOW())
ON CONFLICT (flag_key, scope_type, scope_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS project_ai_pms (
  project_id UUID PRIMARY KEY REFERENCES projects(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'provisioning'
    CHECK (status IN ('provisioning', 'ready', 'failed')),
  role_id UUID REFERENCES project_roles(id) ON DELETE RESTRICT,
  member_id UUID REFERENCES project_members(id) ON DELETE RESTRICT,
  agent_id UUID UNIQUE REFERENCES agents(id) ON DELETE RESTRICT,
  agent_principal_id TEXT REFERENCES principals(id) ON DELETE RESTRICT,
  teammate_id UUID UNIQUE REFERENCES teammates(id) ON DELETE RESTRICT,
  template_id UUID UNIQUE REFERENCES teammate_templates(id) ON DELETE RESTRICT,
  template_version_id UUID
    REFERENCES teammate_template_versions(id) ON DELETE RESTRICT,
  skill_id UUID REFERENCES skill_definitions(id) ON DELETE RESTRICT,
  skill_version_id UUID REFERENCES skill_versions(id) ON DELETE RESTRICT,
  skill_installation_id UUID
    REFERENCES skill_installations(id) ON DELETE RESTRICT,
  skill_binding_id UUID
    REFERENCES teammate_template_skill_bindings(id) ON DELETE RESTRICT,
  runtime_profile_id TEXT
    CHECK (
      runtime_profile_id IS NULL
      OR length(btrim(runtime_profile_id)) BETWEEN 1 AND 180
    ),
  runtime_profile_kind TEXT NOT NULL DEFAULT 'builtin'
    CHECK (runtime_profile_kind IN ('builtin', 'external')),
  last_error TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (updated_at >= created_at),
  CHECK (
    status <> 'ready'
    OR (
      role_id IS NOT NULL
      AND member_id IS NOT NULL
      AND agent_id IS NOT NULL
      AND agent_principal_id IS NOT NULL
      AND teammate_id IS NOT NULL
      AND template_id IS NOT NULL
      AND template_version_id IS NOT NULL
      AND skill_id IS NOT NULL
      AND skill_version_id IS NOT NULL
      AND skill_installation_id IS NOT NULL
      AND skill_binding_id IS NOT NULL
      AND runtime_profile_id IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS project_ai_pms_agent_principal_idx
  ON project_ai_pms(agent_principal_id)
  WHERE agent_principal_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS project_ai_pms_runtime_profile_idx
  ON project_ai_pms(runtime_profile_id)
  WHERE runtime_profile_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS project_ai_pms_status_idx
  ON project_ai_pms(status, updated_at);

ALTER TABLE project_reports
  ADD COLUMN IF NOT EXISTS report_kind TEXT,
  ADD COLUMN IF NOT EXISTS period_start TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS period_end TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS generated_by_principal_id TEXT
    REFERENCES principals(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS run_id UUID
    REFERENCES runs(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS skill_id UUID
    REFERENCES skill_definitions(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS skill_version INTEGER
    CHECK (skill_version IS NULL OR skill_version > 0),
  ADD COLUMN IF NOT EXISTS skill_digest TEXT
    CHECK (skill_digest IS NULL OR skill_digest ~ '^[a-f0-9]{64}$'),
  ADD COLUMN IF NOT EXISTS trigger_source TEXT,
  ADD COLUMN IF NOT EXISTS source_digest TEXT
    CHECK (source_digest IS NULL OR source_digest ~ '^[a-f0-9]{64}$'),
  ADD COLUMN IF NOT EXISTS source_cutoff_at TIMESTAMPTZ;

ALTER TABLE project_report_sources
  ADD COLUMN IF NOT EXISTS cutoff_at TIMESTAMPTZ;

-- Suspend the immutable trigger only inside this migration transaction.
DROP TRIGGER IF EXISTS project_reports_immutable ON project_reports;

UPDATE project_reports AS report
SET
  report_kind = COALESCE(report.report_kind, 'daily'),
  period_start = COALESCE(
    report.period_start,
    report.report_date::timestamp AT TIME ZONE 'Asia/Shanghai'
  ),
  period_end = COALESCE(
    report.period_end,
    (
      report.report_date::timestamp AT TIME ZONE 'Asia/Shanghai'
      + INTERVAL '1 day'
    )
  ),
  generated_by_principal_id = COALESCE(
    report.generated_by_principal_id,
    principal.id
  ),
  trigger_source = COALESCE(report.trigger_source, 'legacy'),
  source_digest = COALESCE(report.source_digest, report.content_hash),
  source_cutoff_at = COALESCE(report.source_cutoff_at, report.generated_at)
FROM principals AS principal
WHERE principal.id = report.generated_by
  AND (
    report.report_kind IS NULL
    OR report.period_start IS NULL
    OR report.period_end IS NULL
    OR report.generated_by_principal_id IS NULL
    OR report.trigger_source IS NULL
    OR report.source_digest IS NULL
    OR report.source_cutoff_at IS NULL
  );

UPDATE project_reports AS report
SET
  report_kind = COALESCE(report.report_kind, 'daily'),
  period_start = COALESCE(
    report.period_start,
    report.report_date::timestamp AT TIME ZONE 'Asia/Shanghai'
  ),
  period_end = COALESCE(
    report.period_end,
    (
      report.report_date::timestamp AT TIME ZONE 'Asia/Shanghai'
      + INTERVAL '1 day'
    )
  ),
  trigger_source = COALESCE(report.trigger_source, 'legacy'),
  source_digest = COALESCE(report.source_digest, report.content_hash),
  source_cutoff_at = COALESCE(report.source_cutoff_at, report.generated_at)
WHERE report.report_kind IS NULL
   OR report.period_start IS NULL
   OR report.period_end IS NULL
   OR report.trigger_source IS NULL
   OR report.source_digest IS NULL
   OR report.source_cutoff_at IS NULL;

UPDATE project_report_sources AS source
SET cutoff_at = report.source_cutoff_at
FROM project_reports AS report
WHERE report.id = source.report_id
  AND source.cutoff_at IS NULL;

-- Validate the future identity before enforcing the new unique constraints.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM project_reports
    GROUP BY project_id, report_kind, report_date, version
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'M6 project report kind/date/version conflict';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM project_reports
    GROUP BY project_id, report_kind, report_date, content_hash
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'M6 project report kind/date/content conflict';
  END IF;
END;
$$;

ALTER TABLE project_reports
  DROP CONSTRAINT IF EXISTS project_reports_project_id_report_date_version_key,
  DROP CONSTRAINT IF EXISTS project_reports_project_id_report_date_content_hash_key;

ALTER TABLE project_reports
  ALTER COLUMN report_kind SET DEFAULT 'daily',
  ALTER COLUMN report_kind SET NOT NULL,
  ALTER COLUMN trigger_source SET DEFAULT 'manual',
  ALTER COLUMN trigger_source SET NOT NULL,
  ALTER COLUMN source_cutoff_at SET DEFAULT NOW(),
  ALTER COLUMN source_cutoff_at SET NOT NULL;

ALTER TABLE project_reports
  DROP CONSTRAINT IF EXISTS project_reports_kind_check,
  DROP CONSTRAINT IF EXISTS project_reports_period_check,
  DROP CONSTRAINT IF EXISTS project_reports_trace_fields_check,
  ADD CONSTRAINT project_reports_kind_check
    CHECK (report_kind IN ('daily', 'weekly', 'progress')),
  ADD CONSTRAINT project_reports_period_check
    CHECK (
      period_start IS NULL
      OR period_end IS NULL
      OR period_end > period_start
    ),
  ADD CONSTRAINT project_reports_trace_fields_check
    CHECK (
      (run_id IS NULL
        AND skill_id IS NULL
        AND skill_version IS NULL
        AND skill_digest IS NULL)
      OR
      (run_id IS NOT NULL
        AND skill_id IS NOT NULL
        AND skill_version IS NOT NULL
        AND skill_digest IS NOT NULL)
    );

ALTER TABLE project_reports
  ADD CONSTRAINT project_reports_project_kind_date_version_key
    UNIQUE (project_id, report_kind, report_date, version),
  ADD CONSTRAINT project_reports_project_kind_date_content_key
    UNIQUE (project_id, report_kind, report_date, content_hash);

CREATE INDEX IF NOT EXISTS project_reports_project_kind_idx
  ON project_reports(
    project_id,
    report_kind,
    report_date DESC,
    version DESC
  );

CREATE TRIGGER project_reports_immutable
BEFORE UPDATE OR DELETE ON project_reports
FOR EACH ROW
EXECUTE FUNCTION pluginmax_reject_project_report_mutation();

-- M6 enable state: the Flag remains off until explicit release activation.
`;

export const M7_DATA_FABRIC_SCHEMA_SQL = `
-- M7 expand: read-only Data Fabric catalog, immutable metric/policy versions,
-- QueryRun/QueryResult, and Data Agent conversation facts.
INSERT INTO feature_flag_settings (
  flag_key, scope_type, scope_id, mode, revision, updated_by, updated_at
) VALUES
  ('data_fabric', 'platform', 'platform', 'off', 1,
   'system:migration', NOW())
ON CONFLICT (flag_key, scope_type, scope_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS data_connections (
  id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 160),
  provider TEXT NOT NULL DEFAULT 'fixture'
    CHECK (provider = 'fixture'),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  allowed_runtime_profile_ids JSONB NOT NULL
    CHECK (
      jsonb_typeof(allowed_runtime_profile_ids) = 'array'
      AND jsonb_array_length(allowed_runtime_profile_ids) BETWEEN 1 AND 100
    ),
  max_rows INTEGER NOT NULL DEFAULT 500
    CHECK (max_rows BETWEEN 1 AND 1000),
  timeout_ms INTEGER NOT NULL DEFAULT 10000
    CHECK (timeout_ms BETWEEN 1 AND 60000),
  data_cutoff_at TIMESTAMPTZ,
  created_by_principal_id TEXT NOT NULL
    REFERENCES principals(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS data_connections_scope_name_idx
  ON data_connections(
    workspace_id,
    project_id,
    lower(btrim(name))
  );

CREATE INDEX IF NOT EXISTS data_connections_project_idx
  ON data_connections(project_id, workspace_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS datasets (
  id UUID PRIMARY KEY,
  connection_id UUID NOT NULL
    REFERENCES data_connections(id) ON DELETE RESTRICT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  dataset_key TEXT NOT NULL
    CHECK (dataset_key ~ '^[a-z0-9][a-z0-9._-]{1,119}$'),
  name TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 160),
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  max_rows INTEGER NOT NULL DEFAULT 500
    CHECK (max_rows BETWEEN 1 AND 1000),
  timeout_ms INTEGER NOT NULL DEFAULT 10000
    CHECK (timeout_ms BETWEEN 1 AND 60000),
  created_by_principal_id TEXT NOT NULL
    REFERENCES principals(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (connection_id, dataset_key),
  CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS datasets_project_idx
  ON datasets(project_id, workspace_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS dataset_columns (
  id UUID PRIMARY KEY,
  dataset_id UUID NOT NULL REFERENCES datasets(id) ON DELETE RESTRICT,
  name TEXT NOT NULL
    CHECK (
      length(name) BETWEEN 1 AND 120
      AND name ~ '^[a-zA-Z_][a-zA-Z0-9_]*$'
    ),
  data_type TEXT NOT NULL
    CHECK (data_type IN ('string', 'number', 'boolean', 'date')),
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 1000),
  sensitive BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (dataset_id, position)
);

CREATE INDEX IF NOT EXISTS dataset_columns_dataset_idx
  ON dataset_columns(dataset_id, position);

CREATE UNIQUE INDEX IF NOT EXISTS dataset_columns_dataset_name_idx
  ON dataset_columns(dataset_id, lower(name));

CREATE TABLE IF NOT EXISTS semantic_metrics (
  id UUID PRIMARY KEY,
  dataset_id UUID NOT NULL REFERENCES datasets(id) ON DELETE RESTRICT,
  metric_key TEXT NOT NULL
    CHECK (metric_key ~ '^[a-z0-9][a-z0-9._-]{1,119}$'),
  title TEXT NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 160),
  current_version INTEGER NOT NULL DEFAULT 1
    CHECK (current_version > 0),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'retired')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by_principal_id TEXT NOT NULL
    REFERENCES principals(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (dataset_id, metric_key),
  CHECK (updated_at >= created_at)
);

CREATE TABLE IF NOT EXISTS semantic_metric_versions (
  id UUID PRIMARY KEY,
  metric_id UUID NOT NULL REFERENCES semantic_metrics(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version > 0),
  aggregation TEXT NOT NULL
    CHECK (aggregation IN ('count', 'sum', 'avg', 'min', 'max')),
  column_name TEXT NOT NULL
    CHECK (
      length(column_name) BETWEEN 1 AND 120
      AND column_name ~ '^[a-zA-Z_][a-zA-Z0-9_]*$'
    ),
  description TEXT NOT NULL DEFAULT '',
  format TEXT NOT NULL DEFAULT 'integer'
    CHECK (format IN ('integer', 'decimal', 'text')),
  digest TEXT NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  created_by_principal_id TEXT NOT NULL
    REFERENCES principals(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (metric_id, version),
  UNIQUE (metric_id, digest)
);

CREATE INDEX IF NOT EXISTS semantic_metric_versions_metric_idx
  ON semantic_metric_versions(metric_id, version DESC);

CREATE TABLE IF NOT EXISTS data_policies (
  id UUID PRIMARY KEY,
  dataset_id UUID NOT NULL REFERENCES datasets(id) ON DELETE RESTRICT,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('workspace', 'project')),
  scope_id TEXT NOT NULL CHECK (length(btrim(scope_id)) BETWEEN 1 AND 180),
  current_version INTEGER NOT NULL DEFAULT 1
    CHECK (current_version > 0),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'retired')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by_principal_id TEXT NOT NULL
    REFERENCES principals(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (dataset_id, scope_type, scope_id),
  CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS data_policies_dataset_idx
  ON data_policies(dataset_id, status, scope_type, scope_id);

CREATE TABLE IF NOT EXISTS data_policy_versions (
  id UUID PRIMARY KEY,
  policy_id UUID NOT NULL REFERENCES data_policies(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version > 0),
  row_filters JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(row_filters) = 'array'),
  allowed_columns JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(allowed_columns) = 'array'),
  denied_columns JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(denied_columns) = 'array'),
  max_rows INTEGER NOT NULL CHECK (max_rows BETWEEN 1 AND 1000),
  timeout_ms INTEGER NOT NULL CHECK (timeout_ms BETWEEN 1 AND 60000),
  data_cutoff_at TIMESTAMPTZ,
  digest TEXT NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  created_by_principal_id TEXT NOT NULL
    REFERENCES principals(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (policy_id, version),
  UNIQUE (policy_id, digest)
);

CREATE INDEX IF NOT EXISTS data_policy_versions_policy_idx
  ON data_policy_versions(policy_id, version DESC);

-- Fixture rows are intentionally read-only from the application. A production
-- connector must replace this adapter behind the independent security review.
CREATE TABLE IF NOT EXISTS dataset_rows (
  id UUID PRIMARY KEY,
  dataset_id UUID NOT NULL REFERENCES datasets(id) ON DELETE RESTRICT,
  row_key TEXT NOT NULL CHECK (length(btrim(row_key)) BETWEEN 1 AND 180),
  row_data JSONB NOT NULL CHECK (jsonb_typeof(row_data) = 'object'),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (dataset_id, row_key)
);

CREATE INDEX IF NOT EXISTS dataset_rows_dataset_idx
  ON dataset_rows(dataset_id, row_key);

CREATE TABLE IF NOT EXISTS data_agent_conversations (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  run_id UUID NOT NULL UNIQUE REFERENCES runs(id) ON DELETE RESTRICT,
  context_pack_id UUID
    REFERENCES context_packs(id) ON DELETE RESTRICT,
  skill_snapshot_digest TEXT
    CHECK (
      skill_snapshot_digest IS NULL
      OR skill_snapshot_digest ~ '^[a-f0-9]{64}$'
    ),
  runtime_profile_id TEXT NOT NULL
    CHECK (length(btrim(runtime_profile_id)) BETWEEN 1 AND 180),
  requester_principal_id TEXT NOT NULL
    REFERENCES principals(id) ON DELETE RESTRICT,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  agent_principal_id TEXT NOT NULL
    REFERENCES principals(id) ON DELETE RESTRICT,
  title TEXT NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 240),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived')),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS data_agent_conversations_requester_idx
  ON data_agent_conversations(
    requester_principal_id,
    status,
    updated_at DESC
  );

CREATE TABLE IF NOT EXISTS query_runs (
  id UUID PRIMARY KEY,
  conversation_id UUID NOT NULL
    REFERENCES data_agent_conversations(id) ON DELETE RESTRICT,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  run_id UUID NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
  context_pack_id UUID
    REFERENCES context_packs(id) ON DELETE RESTRICT,
  skill_snapshot_digest TEXT
    CHECK (
      skill_snapshot_digest IS NULL
      OR skill_snapshot_digest ~ '^[a-f0-9]{64}$'
    ),
  connection_id UUID NOT NULL
    REFERENCES data_connections(id) ON DELETE RESTRICT,
  connection_version INTEGER NOT NULL CHECK (connection_version > 0),
  dataset_id UUID NOT NULL REFERENCES datasets(id) ON DELETE RESTRICT,
  dataset_version INTEGER NOT NULL CHECK (dataset_version > 0),
  metric_id UUID REFERENCES semantic_metrics(id) ON DELETE RESTRICT,
  metric_version INTEGER CHECK (
    metric_version IS NULL OR metric_version > 0
  ),
  runtime_profile_id TEXT NOT NULL
    CHECK (length(btrim(runtime_profile_id)) BETWEEN 1 AND 180),
  mode TEXT NOT NULL CHECK (mode IN ('explain', 'metric', 'dataset')),
  query_spec JSONB NOT NULL CHECK (jsonb_typeof(query_spec) = 'object'),
  requester_principal_id TEXT NOT NULL
    REFERENCES principals(id) ON DELETE RESTRICT,
  agent_principal_id TEXT NOT NULL
    REFERENCES principals(id) ON DELETE RESTRICT,
  row_filters JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(row_filters) = 'array'),
  denied_columns JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(denied_columns) = 'array'),
  allowed_columns JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(allowed_columns) = 'array'),
  max_rows INTEGER NOT NULL CHECK (max_rows BETWEEN 1 AND 1000),
  timeout_ms INTEGER NOT NULL CHECK (timeout_ms BETWEEN 1 AND 60000),
  data_cutoff_at TIMESTAMPTZ,
  permission_summary JSONB NOT NULL
    CHECK (jsonb_typeof(permission_summary) = 'object'),
  policy_snapshot JSONB NOT NULL
    CHECK (
      jsonb_typeof(policy_snapshot) = 'array'
      AND jsonb_array_length(policy_snapshot) > 0
    ),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN (
      'queued',
      'running',
      'completed',
      'failed',
      'cancelled',
      'timeout'
    )),
  scan_count BIGINT CHECK (scan_count IS NULL OR scan_count >= 0),
  row_count BIGINT CHECK (row_count IS NULL OR row_count >= 0),
  result_digest TEXT
    CHECK (result_digest IS NULL OR result_digest ~ '^[a-f0-9]{64}$'),
  error_code TEXT CHECK (
    error_code IS NULL OR length(btrim(error_code)) BETWEEN 1 AND 160
  ),
  error_message TEXT CHECK (
    error_message IS NULL OR length(btrim(error_message)) BETWEEN 1 AND 4000
  ),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (
    (metric_id IS NULL AND metric_version IS NULL)
    OR (metric_id IS NOT NULL AND metric_version IS NOT NULL)
  ),
  CHECK (
    (status IN ('completed', 'failed', 'cancelled', 'timeout')
      AND completed_at IS NOT NULL)
    OR (status IN ('queued', 'running') AND completed_at IS NULL)
  ),
  CHECK (
    (status = 'completed'
      AND scan_count IS NOT NULL
      AND row_count IS NOT NULL
      AND result_digest IS NOT NULL
      AND error_code IS NULL)
    OR (status <> 'completed'
      AND result_digest IS NULL
      AND row_count IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS query_runs_conversation_idx
  ON query_runs(conversation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS query_runs_dataset_idx
  ON query_runs(dataset_id, data_cutoff_at DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS query_results (
  query_run_id UUID PRIMARY KEY
    REFERENCES query_runs(id) ON DELETE RESTRICT,
  columns JSONB NOT NULL
    CHECK (
      jsonb_typeof(columns) = 'array'
      AND jsonb_array_length(columns) <= 100
    ),
  rows JSONB NOT NULL
    CHECK (
      jsonb_typeof(rows) = 'array'
      AND jsonb_array_length(rows) <= 1000
    ),
  digest TEXT NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS data_agent_messages (
  id UUID PRIMARY KEY,
  conversation_id UUID NOT NULL
    REFERENCES data_agent_conversations(id) ON DELETE RESTRICT,
  sequence BIGINT NOT NULL CHECK (sequence > 0),
  role TEXT NOT NULL CHECK (role IN ('user', 'agent', 'system')),
  content TEXT NOT NULL CHECK (
    length(content) BETWEEN 1 AND 200000
  ),
  query_run_id UUID REFERENCES query_runs(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (conversation_id, sequence)
);

CREATE INDEX IF NOT EXISTS data_agent_messages_conversation_idx
  ON data_agent_messages(conversation_id, sequence);

CREATE TABLE IF NOT EXISTS data_agent_context_refs (
  id UUID PRIMARY KEY,
  conversation_id UUID NOT NULL
    REFERENCES data_agent_conversations(id) ON DELETE RESTRICT,
  message_id UUID
    REFERENCES data_agent_messages(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL
    CHECK (kind IN (
      'run',
      'context-pack',
      'skill-snapshot',
      'project-report',
      'query-run'
    )),
  ref_id TEXT NOT NULL CHECK (length(btrim(ref_id)) BETWEEN 1 AND 180),
  version INTEGER CHECK (version IS NULL OR version > 0),
  digest TEXT CHECK (digest IS NULL OR digest ~ '^[a-f0-9]{64}$'),
  cutoff_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS data_agent_context_refs_conversation_idx
  ON data_agent_context_refs(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS data_agent_answers (
  id UUID PRIMARY KEY,
  conversation_id UUID NOT NULL
    REFERENCES data_agent_conversations(id) ON DELETE RESTRICT,
  message_id UUID NOT NULL UNIQUE
    REFERENCES data_agent_messages(id) ON DELETE RESTRICT,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  run_id UUID NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
  context_pack_id UUID
    REFERENCES context_packs(id) ON DELETE RESTRICT,
  skill_snapshot_digest TEXT
    CHECK (
      skill_snapshot_digest IS NULL
      OR skill_snapshot_digest ~ '^[a-f0-9]{64}$'
    ),
  requester_principal_id TEXT NOT NULL
    REFERENCES principals(id) ON DELETE RESTRICT,
  agent_principal_id TEXT NOT NULL
    REFERENCES principals(id) ON DELETE RESTRICT,
  project_report_id UUID
    REFERENCES project_reports(id) ON DELETE RESTRICT,
  content TEXT NOT NULL CHECK (
    length(content) BETWEEN 1 AND 200000
  ),
  digest TEXT NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS data_agent_answer_query_runs (
  answer_id UUID NOT NULL
    REFERENCES data_agent_answers(id) ON DELETE RESTRICT,
  query_run_id UUID NOT NULL
    REFERENCES query_runs(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (answer_id, query_run_id),
  UNIQUE (answer_id, position)
);

CREATE TABLE IF NOT EXISTS data_agent_answer_context_refs (
  answer_id UUID NOT NULL
    REFERENCES data_agent_answers(id) ON DELETE RESTRICT,
  context_ref_id UUID NOT NULL
    REFERENCES data_agent_context_refs(id) ON DELETE RESTRICT,
  PRIMARY KEY (answer_id, context_ref_id)
);

-- M7 backfill / validate: this domain has no historical rows. Validate all
-- version heads before exposing immutable version constraints.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM semantic_metrics AS metric
    LEFT JOIN semantic_metric_versions AS version
      ON version.metric_id = metric.id
     AND version.version = metric.current_version
    WHERE version.id IS NULL
  ) THEN
    RAISE EXCEPTION 'M7 semantic metric current_version is inconsistent';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM data_policies AS policy
    LEFT JOIN data_policy_versions AS version
      ON version.policy_id = policy.id
     AND version.version = policy.current_version
    WHERE version.id IS NULL
  ) THEN
    RAISE EXCEPTION 'M7 data policy current_version is inconsistent';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM query_runs
    WHERE status = 'completed'
      AND (
        scan_count IS NULL
        OR row_count IS NULL
        OR result_digest IS NULL
      )
  ) THEN
    RAISE EXCEPTION 'M7 completed QueryRun is missing result metadata';
  END IF;
END;
$$;

-- M7 enforce: versions, results, context refs and answers are immutable.
CREATE OR REPLACE FUNCTION pluginmax_reject_data_fabric_version_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'data fabric versions and facts are immutable';
END;
$$;

DROP TRIGGER IF EXISTS semantic_metric_versions_immutable
  ON semantic_metric_versions;
CREATE TRIGGER semantic_metric_versions_immutable
BEFORE UPDATE OR DELETE ON semantic_metric_versions
FOR EACH ROW
EXECUTE FUNCTION pluginmax_reject_data_fabric_version_mutation();

DROP TRIGGER IF EXISTS data_policy_versions_immutable
  ON data_policy_versions;
CREATE TRIGGER data_policy_versions_immutable
BEFORE UPDATE OR DELETE ON data_policy_versions
FOR EACH ROW
EXECUTE FUNCTION pluginmax_reject_data_fabric_version_mutation();

DROP TRIGGER IF EXISTS query_results_immutable ON query_results;
CREATE TRIGGER query_results_immutable
BEFORE UPDATE OR DELETE ON query_results
FOR EACH ROW
EXECUTE FUNCTION pluginmax_reject_data_fabric_version_mutation();

DROP TRIGGER IF EXISTS data_agent_messages_immutable
  ON data_agent_messages;
CREATE TRIGGER data_agent_messages_immutable
BEFORE UPDATE OR DELETE ON data_agent_messages
FOR EACH ROW
EXECUTE FUNCTION pluginmax_reject_data_fabric_version_mutation();

DROP TRIGGER IF EXISTS data_agent_context_refs_immutable
  ON data_agent_context_refs;
CREATE TRIGGER data_agent_context_refs_immutable
BEFORE UPDATE OR DELETE ON data_agent_context_refs
FOR EACH ROW
EXECUTE FUNCTION pluginmax_reject_data_fabric_version_mutation();

DROP TRIGGER IF EXISTS data_agent_answers_immutable
  ON data_agent_answers;
CREATE TRIGGER data_agent_answers_immutable
BEFORE UPDATE OR DELETE ON data_agent_answers
FOR EACH ROW
EXECUTE FUNCTION pluginmax_reject_data_fabric_version_mutation();

DROP TRIGGER IF EXISTS data_agent_answer_query_runs_immutable
  ON data_agent_answer_query_runs;
CREATE TRIGGER data_agent_answer_query_runs_immutable
BEFORE UPDATE OR DELETE ON data_agent_answer_query_runs
FOR EACH ROW
EXECUTE FUNCTION pluginmax_reject_data_fabric_version_mutation();

DROP TRIGGER IF EXISTS data_agent_answer_context_refs_immutable
  ON data_agent_answer_context_refs;
CREATE TRIGGER data_agent_answer_context_refs_immutable
BEFORE UPDATE OR DELETE ON data_agent_answer_context_refs
FOR EACH ROW
EXECUTE FUNCTION pluginmax_reject_data_fabric_version_mutation();

CREATE OR REPLACE FUNCTION pluginmax_guard_query_run_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status IN ('completed', 'failed', 'cancelled', 'timeout') THEN
    RAISE EXCEPTION 'terminal QueryRun is immutable';
  END IF;
  IF NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.connection_id IS DISTINCT FROM OLD.connection_id
    OR NEW.connection_version IS DISTINCT FROM OLD.connection_version
    OR NEW.dataset_id IS DISTINCT FROM OLD.dataset_id
    OR NEW.dataset_version IS DISTINCT FROM OLD.dataset_version
    OR NEW.metric_id IS DISTINCT FROM OLD.metric_id
    OR NEW.metric_version IS DISTINCT FROM OLD.metric_version
    OR NEW.requester_principal_id IS DISTINCT FROM OLD.requester_principal_id
    OR NEW.agent_principal_id IS DISTINCT FROM OLD.agent_principal_id
    OR NEW.policy_snapshot IS DISTINCT FROM OLD.policy_snapshot
    OR NEW.permission_summary IS DISTINCT FROM OLD.permission_summary
  THEN
    RAISE EXCEPTION 'QueryRun identity and permission snapshots are immutable';
  END IF;
  IF OLD.status <> 'queued'
    AND NEW.status NOT IN (
      'completed',
      'failed',
      'cancelled',
      'timeout'
    )
  THEN
    RAISE EXCEPTION 'invalid QueryRun transition';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS query_runs_guard_transition ON query_runs;
CREATE TRIGGER query_runs_guard_transition
BEFORE UPDATE ON query_runs
FOR EACH ROW
EXECUTE FUNCTION pluginmax_guard_query_run_transition();

-- M7 enable state: data_fabric stays off until the independent security gate
-- and an explicit release activation.
`;

export const M8_WORKBENCH_MARKET_SCHEMA_SQL = `
-- M8 expand: personal Workbench instances and versions, server layouts,
-- trusted static panel placements, Resource Market assets and entitlements.
INSERT INTO feature_flag_settings (
  flag_key, scope_type, scope_id, mode, revision, updated_by, updated_at
) VALUES
  ('workbench.v2', 'platform', 'platform', 'off', 1,
   'system:migration', NOW()),
  ('market', 'platform', 'platform', 'off', 1,
   'system:migration', NOW())
ON CONFLICT (flag_key, scope_type, scope_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS market_assets (
  id UUID PRIMARY KEY,
  asset_key TEXT NOT NULL UNIQUE
    CHECK (
      length(asset_key) BETWEEN 2 AND 120
      AND asset_key ~ '^[a-z0-9][a-z0-9._-]+$'
    ),
  kind TEXT NOT NULL CHECK (kind IN (
    'panel',
    'skill',
    'mcp',
    'workbench-template',
    'plugin'
  )),
  name TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 160),
  description TEXT NOT NULL DEFAULT ''
    CHECK (length(description) <= 4000),
  publisher_principal_id TEXT NOT NULL
    REFERENCES principals(id) ON DELETE RESTRICT,
  trust_level TEXT NOT NULL
    CHECK (trust_level IN ('official', 'verified', 'private')),
  visibility TEXT NOT NULL
    CHECK (visibility IN ('public', 'private', 'workspace', 'project')),
  visibility_scope_id TEXT
    CHECK (
      visibility_scope_id IS NULL
      OR length(btrim(visibility_scope_id)) BETWEEN 1 AND 180
    ),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'delisted', 'archived')),
  current_version INTEGER NOT NULL DEFAULT 1
    CHECK (current_version > 0),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (updated_at >= created_at),
  CHECK (
    (visibility IN ('workspace', 'project')
      AND visibility_scope_id IS NOT NULL)
    OR
    (visibility IN ('public', 'private')
      AND visibility_scope_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS market_assets_catalog_idx
  ON market_assets(kind, status, trust_level, updated_at DESC);

CREATE INDEX IF NOT EXISTS market_assets_visibility_idx
  ON market_assets(visibility, visibility_scope_id, status);

CREATE TABLE IF NOT EXISTS market_asset_versions (
  id UUID PRIMARY KEY,
  asset_id UUID NOT NULL
    REFERENCES market_assets(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version > 0),
  digest TEXT NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  publisher_principal_id TEXT NOT NULL
    REFERENCES principals(id) ON DELETE RESTRICT,
  manifest JSONB NOT NULL CHECK (jsonb_typeof(manifest) = 'object'),
  compatibility JSONB NOT NULL
    CHECK (jsonb_typeof(compatibility) = 'object'),
  status TEXT NOT NULL DEFAULT 'published'
    CHECK (status IN ('published', 'deprecated', 'revoked')),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (asset_id, version),
  UNIQUE (asset_id, digest)
);

CREATE INDEX IF NOT EXISTS market_asset_versions_asset_idx
  ON market_asset_versions(asset_id, version DESC);

CREATE INDEX IF NOT EXISTS market_asset_versions_panel_idx
  ON market_asset_versions((manifest ->> 'panelPluginId'))
  WHERE manifest ? 'panelPluginId';

CREATE TABLE IF NOT EXISTS market_templates (
  id UUID PRIMARY KEY,
  asset_id UUID NOT NULL UNIQUE
    REFERENCES market_assets(id) ON DELETE RESTRICT,
  template_key TEXT NOT NULL UNIQUE
    CHECK (
      length(template_key) BETWEEN 2 AND 120
      AND template_key ~ '^[a-z0-9][a-z0-9._-]+$'
    ),
  name TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 160),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived')),
  current_version INTEGER NOT NULL DEFAULT 1
    CHECK (current_version > 0),
  created_by_principal_id TEXT NOT NULL
    REFERENCES principals(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (updated_at >= created_at)
);

CREATE TABLE IF NOT EXISTS market_template_dependencies (
  template_id UUID NOT NULL
    REFERENCES market_templates(id) ON DELETE RESTRICT,
  asset_version_id UUID NOT NULL
    REFERENCES market_asset_versions(id) ON DELETE RESTRICT,
  dependency_asset_id UUID NOT NULL
    REFERENCES market_assets(id) ON DELETE RESTRICT,
  minimum_version INTEGER NOT NULL DEFAULT 1
    CHECK (minimum_version > 0),
  required BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (template_id, asset_version_id, dependency_asset_id),
  CHECK (template_id <> dependency_asset_id)
);

CREATE INDEX IF NOT EXISTS market_template_dependencies_asset_idx
  ON market_template_dependencies(
    dependency_asset_id,
    template_id,
    asset_version_id
  );

CREATE TABLE IF NOT EXISTS market_entitlements (
  id UUID PRIMARY KEY,
  principal_id TEXT NOT NULL
    REFERENCES principals(id) ON DELETE RESTRICT,
  asset_id UUID NOT NULL
    REFERENCES market_assets(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  granted_by_principal_id TEXT NOT NULL
    REFERENCES principals(id) ON DELETE RESTRICT,
  granted_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (principal_id, asset_id),
  CHECK (updated_at >= granted_at)
);

CREATE INDEX IF NOT EXISTS market_entitlements_principal_idx
  ON market_entitlements(principal_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS market_installations (
  id UUID PRIMARY KEY,
  principal_id TEXT NOT NULL
    REFERENCES principals(id) ON DELETE RESTRICT,
  asset_id UUID NOT NULL
    REFERENCES market_assets(id) ON DELETE RESTRICT,
  asset_version_id UUID NOT NULL
    REFERENCES market_asset_versions(id) ON DELETE RESTRICT,
  entitlement_id UUID NOT NULL
    REFERENCES market_entitlements(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'uninstalled')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  idempotency_key TEXT NOT NULL
    CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 200),
  config JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(config) = 'object'),
  installed_by_principal_id TEXT NOT NULL
    REFERENCES principals(id) ON DELETE RESTRICT,
  installed_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (principal_id, asset_id),
  CHECK (updated_at >= installed_at)
);

CREATE INDEX IF NOT EXISTS market_installations_principal_idx
  ON market_installations(principal_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS market_template_copies (
  id UUID PRIMARY KEY,
  principal_id TEXT NOT NULL
    REFERENCES principals(id) ON DELETE RESTRICT,
  template_id UUID NOT NULL
    REFERENCES market_templates(id) ON DELETE RESTRICT,
  asset_version_id UUID NOT NULL
    REFERENCES market_asset_versions(id) ON DELETE RESTRICT,
  workbench_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'uninstalled')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  idempotency_key TEXT NOT NULL
    CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 200),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (principal_id, template_id),
  CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS market_template_copies_principal_idx
  ON market_template_copies(principal_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS workbenches (
  id UUID PRIMARY KEY,
  owner_principal_id TEXT NOT NULL
    REFERENCES principals(id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived')),
  current_version INTEGER NOT NULL DEFAULT 1
    CHECK (current_version > 0),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS workbenches_owner_name_idx
  ON workbenches(owner_principal_id, lower(btrim(name)))
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS workbenches_owner_idx
  ON workbenches(owner_principal_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS workbench_layouts (
  id UUID PRIMARY KEY,
  workbench_id UUID NOT NULL
    REFERENCES workbenches(id) ON DELETE RESTRICT,
  owner_principal_id TEXT NOT NULL
    REFERENCES principals(id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  is_factory_default BOOLEAN NOT NULL DEFAULT FALSE,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived')),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS workbench_layouts_workbench_name_idx
  ON workbench_layouts(workbench_id, lower(btrim(name)))
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS workbench_panels (
  plugin_id TEXT PRIMARY KEY
    CHECK (
      length(plugin_id) BETWEEN 1 AND 120
      AND plugin_id ~ '^[a-z0-9][a-z0-9._-]*$'
    ),
  version TEXT NOT NULL CHECK (length(btrim(version)) BETWEEN 1 AND 40),
  title TEXT NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 160),
  trusted_build BOOLEAN NOT NULL DEFAULT TRUE CHECK (trusted_build),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled')),
  default_width INTEGER NOT NULL CHECK (default_width BETWEEN 1 AND 6),
  min_height INTEGER NOT NULL CHECK (min_height BETWEEN 190 AND 900),
  max_height INTEGER NOT NULL CHECK (max_height BETWEEN 190 AND 900),
  refreshable BOOLEAN NOT NULL DEFAULT TRUE,
  build_digest TEXT NOT NULL CHECK (build_digest ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (max_height >= min_height),
  CHECK (updated_at >= created_at)
);

CREATE TABLE IF NOT EXISTS workbench_panel_instances (
  id UUID PRIMARY KEY,
  layout_id UUID NOT NULL
    REFERENCES workbench_layouts(id) ON DELETE RESTRICT,
  plugin_id TEXT NOT NULL
    REFERENCES workbench_panels(plugin_id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position >= 0),
  width INTEGER NOT NULL CHECK (width BETWEEN 1 AND 6),
  height INTEGER CHECK (height BETWEEN 190 AND 900),
  config JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(config) = 'object'),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (layout_id, plugin_id),
  UNIQUE (layout_id, position),
  CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS workbench_panel_instances_layout_idx
  ON workbench_panel_instances(layout_id, position);

CREATE TABLE IF NOT EXISTS workbench_layout_versions (
  id UUID PRIMARY KEY,
  layout_id UUID NOT NULL
    REFERENCES workbench_layouts(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK (revision > 0),
  document JSONB NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  digest TEXT NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  changed_by_principal_id TEXT NOT NULL
    REFERENCES principals(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (layout_id, revision)
);

CREATE TABLE IF NOT EXISTS workbench_versions (
  id UUID PRIMARY KEY,
  workbench_id UUID NOT NULL
    REFERENCES workbenches(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version > 0),
  layout_id UUID NOT NULL
    REFERENCES workbench_layouts(id) ON DELETE RESTRICT,
  layout_revision INTEGER NOT NULL CHECK (layout_revision > 0),
  document JSONB NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  digest TEXT NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  created_by_principal_id TEXT NOT NULL
    REFERENCES principals(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (workbench_id, version)
);

-- M8 backfill: seed the trusted panel metadata and create one factory
-- Workbench for every active human Principal that predates this migration.
INSERT INTO workbench_panels (
  plugin_id, version, title, trusted_build, status, default_width,
  min_height, max_height, refreshable, build_digest, created_at, updated_at
) VALUES
  ('metrics', '1.0.0', 'Metrics', TRUE, 'active', 6, 190, 360, TRUE,
   encode(public.digest('metrics:1.0.0', 'sha256'), 'hex'), NOW(), NOW()),
  ('brief', '1.0.0', 'Daily Brief', TRUE, 'active', 6, 260, 900, TRUE,
   encode(public.digest('brief:1.0.0', 'sha256'), 'hex'), NOW(), NOW()),
  ('todo', '1.0.0', 'My Todos', TRUE, 'active', 4, 260, 900, TRUE,
   encode(public.digest('todo:1.0.0', 'sha256'), 'hex'), NOW(), NOW()),
  ('focus', '1.0.0', 'Focus', TRUE, 'active', 2, 260, 900, TRUE,
   encode(public.digest('focus:1.0.0', 'sha256'), 'hex'), NOW(), NOW()),
  ('meeting-minutes', '1.0.0', 'Meeting Minutes', TRUE, 'active', 3, 240,
   900, TRUE, encode(public.digest('meeting-minutes:1.0.0', 'sha256'), 'hex'),
   NOW(), NOW()),
  ('control', '1.0.0', 'Run Exceptions', TRUE, 'active', 3, 240, 900, TRUE,
   encode(public.digest('control:1.0.0', 'sha256'), 'hex'), NOW(), NOW()),
  ('supply', '1.0.0', 'Supply Exceptions', TRUE, 'active', 3, 240, 900,
   TRUE, encode(public.digest('supply:1.0.0', 'sha256'), 'hex'), NOW(), NOW()),
  ('supplier', '1.0.0', 'Supplier Risks', TRUE, 'active', 3, 240, 900,
   TRUE, encode(public.digest('supplier:1.0.0', 'sha256'), 'hex'), NOW(), NOW()),
  ('reports', '1.0.0', 'Project Reports', TRUE, 'active', 6, 240, 900,
   TRUE, encode(public.digest('reports:1.0.0', 'sha256'), 'hex'), NOW(), NOW()),
  ('market.sample', '1.0.0', 'Market Sample Panel', TRUE, 'active', 3, 240,
   600, TRUE, encode(public.digest('market.sample:1.0.0', 'sha256'), 'hex'),
   NOW(), NOW())
ON CONFLICT (plugin_id) DO NOTHING;

INSERT INTO workbenches (
  id, owner_principal_id, name, status, current_version, revision,
  created_at, updated_at
)
SELECT
  gen_random_uuid(), principal.id, 'My Workbench', 'active', 1, 1,
  NOW(), NOW()
FROM principals AS principal
WHERE principal.kind = 'human'
  AND principal.status = 'active'
  AND NOT EXISTS (
    SELECT 1 FROM workbenches AS existing
    WHERE existing.owner_principal_id = principal.id
      AND existing.status = 'active'
  );

INSERT INTO workbench_layouts (
  id, workbench_id, owner_principal_id, name, is_default,
  is_factory_default, revision, status, created_at, updated_at
)
SELECT
  gen_random_uuid(), workbench.id, workbench.owner_principal_id,
  'Default', TRUE, TRUE, 1, 'active', NOW(), NOW()
FROM workbenches AS workbench
WHERE workbench.status = 'active'
  AND NOT EXISTS (
    SELECT 1 FROM workbench_layouts AS layout
    WHERE layout.workbench_id = workbench.id
      AND layout.status = 'active'
  );

INSERT INTO workbench_panel_instances (
  id, layout_id, plugin_id, position, width, height, config, enabled,
  created_at, updated_at
)
SELECT
  gen_random_uuid(), layout.id, panel.plugin_id, seed.position, panel.default_width,
  NULL, '{}'::jsonb, TRUE, NOW(), NOW()
FROM workbench_layouts AS layout
CROSS JOIN (
  VALUES
    ('metrics', 0),
    ('brief', 1),
    ('todo', 2),
    ('focus', 3),
    ('meeting-minutes', 4),
    ('control', 5),
    ('supply', 6),
    ('supplier', 7),
    ('reports', 8)
) AS seed(plugin_id, position)
JOIN workbench_panels AS panel ON panel.plugin_id = seed.plugin_id
WHERE layout.is_factory_default
  AND NOT EXISTS (
    SELECT 1 FROM workbench_panel_instances AS existing
    WHERE existing.layout_id = layout.id
  );

INSERT INTO workbench_layout_versions (
  id, layout_id, revision, document, digest, changed_by_principal_id,
  created_at
)
SELECT
  gen_random_uuid(),
  layout.id,
  layout.revision,
  jsonb_build_object(
    'version', 1,
    'panels', COALESCE(
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            'instanceId', instance.id,
            'pluginId', instance.plugin_id,
            'position', instance.position,
            'width', instance.width,
            'height', instance.height,
            'config', instance.config,
            'enabled', instance.enabled
          )
          ORDER BY instance.position, instance.plugin_id
        )
        FROM workbench_panel_instances AS instance
        WHERE instance.layout_id = layout.id
      ),
      '[]'::jsonb
    )
  ),
  encode(public.digest(
    jsonb_build_object(
      'version', 1,
      'panels', COALESCE(
        (
          SELECT jsonb_agg(
            jsonb_build_object(
              'instanceId', instance.id,
              'pluginId', instance.plugin_id,
              'position', instance.position,
              'width', instance.width,
              'height', instance.height,
              'config', instance.config,
              'enabled', instance.enabled
            )
            ORDER BY instance.position, instance.plugin_id
          )
          FROM workbench_panel_instances AS instance
          WHERE instance.layout_id = layout.id
        ),
        '[]'::jsonb
      )
    )::text,
    'sha256'
  ), 'hex'),
  layout.owner_principal_id,
  NOW()
FROM workbench_layouts AS layout
WHERE layout.is_factory_default
  AND NOT EXISTS (
    SELECT 1 FROM workbench_layout_versions AS version
    WHERE version.layout_id = layout.id
      AND version.revision = layout.revision
  );

INSERT INTO workbench_versions (
  id, workbench_id, version, layout_id, layout_revision, document, digest,
  created_by_principal_id, created_at
)
SELECT
  gen_random_uuid(),
  workbench.id,
  workbench.current_version,
  layout.id,
  layout.revision,
  version.document,
  version.digest,
  workbench.owner_principal_id,
  NOW()
FROM workbenches AS workbench
JOIN workbench_layouts AS layout
  ON layout.workbench_id = workbench.id
 AND layout.is_default
 AND layout.status = 'active'
JOIN workbench_layout_versions AS version
  ON version.layout_id = layout.id
 AND version.revision = layout.revision
WHERE NOT EXISTS (
  SELECT 1 FROM workbench_versions AS existing
  WHERE existing.workbench_id = workbench.id
    AND existing.version = workbench.current_version
);

-- Validate defaults and version heads before creating unique/default indexes.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM workbench_layouts
    WHERE is_default AND status = 'active'
    GROUP BY owner_principal_id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'M8 Principal has more than one default Workbench layout';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM workbench_layouts AS layout
    JOIN workbenches AS workbench ON workbench.id = layout.workbench_id
    WHERE layout.owner_principal_id <> workbench.owner_principal_id
  ) THEN
    RAISE EXCEPTION 'M8 Workbench layout owner mismatch';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM workbench_layouts AS layout
    LEFT JOIN workbench_layout_versions AS version
      ON version.layout_id = layout.id
     AND version.revision = layout.revision
    WHERE version.id IS NULL
  ) THEN
    RAISE EXCEPTION 'M8 Workbench layout version head is inconsistent';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM workbenches AS workbench
    LEFT JOIN workbench_versions AS version
      ON version.workbench_id = workbench.id
     AND version.version = workbench.current_version
    WHERE version.id IS NULL
  ) THEN
    RAISE EXCEPTION 'M8 Workbench version head is inconsistent';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM market_assets AS asset
    LEFT JOIN market_asset_versions AS version
      ON version.asset_id = asset.id
     AND version.version = asset.current_version
    WHERE version.id IS NULL
  ) THEN
    RAISE EXCEPTION 'M8 Market asset version head is inconsistent';
  END IF;
END;
$$;

-- M8 enforce: one default layout per Principal, owner consistency, immutable
-- versions, immutable asset identity/digest, and Cross-Principal safeguards.
CREATE UNIQUE INDEX IF NOT EXISTS workbench_layouts_owner_default_idx
  ON workbench_layouts(owner_principal_id)
  WHERE is_default AND status = 'active';

CREATE OR REPLACE FUNCTION pluginmax_assert_workbench_layout_owner()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expected_owner TEXT;
BEGIN
  SELECT owner_principal_id INTO expected_owner
  FROM workbenches
  WHERE id = NEW.workbench_id;
  IF expected_owner IS NULL OR expected_owner <> NEW.owner_principal_id THEN
    RAISE EXCEPTION 'Workbench layout owner must match Workbench owner';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS workbench_layouts_owner_guard ON workbench_layouts;
CREATE TRIGGER workbench_layouts_owner_guard
BEFORE INSERT OR UPDATE OF workbench_id, owner_principal_id
ON workbench_layouts
FOR EACH ROW
EXECUTE FUNCTION pluginmax_assert_workbench_layout_owner();

CREATE OR REPLACE FUNCTION pluginmax_reject_workbench_version_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Workbench versions are immutable';
END;
$$;

DROP TRIGGER IF EXISTS workbench_layout_versions_immutable
  ON workbench_layout_versions;
CREATE TRIGGER workbench_layout_versions_immutable
BEFORE UPDATE OR DELETE ON workbench_layout_versions
FOR EACH ROW
EXECUTE FUNCTION pluginmax_reject_workbench_version_mutation();

DROP TRIGGER IF EXISTS workbench_versions_immutable ON workbench_versions;
CREATE TRIGGER workbench_versions_immutable
BEFORE UPDATE OR DELETE ON workbench_versions
FOR EACH ROW
EXECUTE FUNCTION pluginmax_reject_workbench_version_mutation();

CREATE OR REPLACE FUNCTION pluginmax_guard_market_asset_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Market asset versions cannot be deleted';
  END IF;
  IF NEW.asset_id IS DISTINCT FROM OLD.asset_id
    OR NEW.version IS DISTINCT FROM OLD.version
    OR NEW.digest IS DISTINCT FROM OLD.digest
    OR NEW.publisher_principal_id IS DISTINCT FROM OLD.publisher_principal_id
    OR NEW.manifest IS DISTINCT FROM OLD.manifest
    OR NEW.compatibility IS DISTINCT FROM OLD.compatibility
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'Market asset version identity and digest are immutable';
  END IF;
  IF OLD.status = 'revoked' AND NEW.status <> 'revoked' THEN
    RAISE EXCEPTION 'Revoked Market asset versions cannot be restored';
  END IF;
  IF OLD.status = 'deprecated'
    AND NEW.status NOT IN ('deprecated', 'revoked')
  THEN
    RAISE EXCEPTION 'Deprecated Market asset versions can only be revoked';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS market_asset_versions_guard
  ON market_asset_versions;
CREATE TRIGGER market_asset_versions_guard
BEFORE UPDATE OR DELETE ON market_asset_versions
FOR EACH ROW
EXECUTE FUNCTION pluginmax_guard_market_asset_version();

CREATE OR REPLACE FUNCTION pluginmax_assert_market_installation_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  entitlement_principal TEXT;
  entitlement_asset UUID;
  version_asset UUID;
BEGIN
  SELECT principal_id, asset_id
  INTO entitlement_principal, entitlement_asset
  FROM market_entitlements
  WHERE id = NEW.entitlement_id;
  SELECT asset_id INTO version_asset
  FROM market_asset_versions
  WHERE id = NEW.asset_version_id;
  IF entitlement_principal IS NULL
    OR entitlement_principal <> NEW.principal_id
    OR entitlement_asset IS NULL
    OR entitlement_asset <> NEW.asset_id
    OR version_asset IS NULL
    OR version_asset <> NEW.asset_id
  THEN
    RAISE EXCEPTION 'Market installation scope does not match entitlement';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS market_installations_scope_guard
  ON market_installations;
CREATE TRIGGER market_installations_scope_guard
BEFORE INSERT OR UPDATE OF principal_id, asset_id, asset_version_id, entitlement_id
ON market_installations
FOR EACH ROW
EXECUTE FUNCTION pluginmax_assert_market_installation_scope();

CREATE OR REPLACE FUNCTION pluginmax_assert_market_template_copy_owner()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  workbench_owner TEXT;
BEGIN
  SELECT owner_principal_id INTO workbench_owner
  FROM workbenches
  WHERE id = NEW.workbench_id;
  IF workbench_owner IS NULL OR workbench_owner <> NEW.principal_id THEN
    RAISE EXCEPTION 'Market template copy Workbench owner mismatch';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS market_template_copies_owner_guard
  ON market_template_copies;
CREATE TRIGGER market_template_copies_owner_guard
BEFORE INSERT OR UPDATE OF principal_id, workbench_id
ON market_template_copies
FOR EACH ROW
EXECUTE FUNCTION pluginmax_assert_market_template_copy_owner();

CREATE OR REPLACE FUNCTION pluginmax_reject_market_template_dependency_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Market template dependencies are immutable';
END;
$$;

DROP TRIGGER IF EXISTS market_template_dependencies_immutable
  ON market_template_dependencies;
CREATE TRIGGER market_template_dependencies_immutable
BEFORE UPDATE OR DELETE ON market_template_dependencies
FOR EACH ROW
EXECUTE FUNCTION pluginmax_reject_market_template_dependency_mutation();

-- M8 enable state: workbench.v2 and market remain off until explicit release
-- activation and the M8 observation window completes.
`;

export const M9_FOUNDATION_SCHEMA_SQL = `
-- M9 expand: task hierarchy, global Teammate template scope, and scene-aware
-- Skill binding metadata. Product behaviour remains feature-gated in the app.
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS parent_task_id UUID
    REFERENCES tasks(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS tasks_parent_task_idx
  ON tasks(project_id, parent_task_id, status)
  WHERE parent_task_id IS NOT NULL;

CREATE OR REPLACE FUNCTION pluginmax_assert_task_hierarchy()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_project_id UUID;
  parent_status TEXT;
  parent_parent_task_id UUID;
BEGIN
  IF NEW.parent_task_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.parent_task_id = NEW.id THEN
    RAISE EXCEPTION 'a task cannot be its own parent';
  END IF;
  SELECT project_id, status, parent_task_id
  INTO parent_project_id, parent_status, parent_parent_task_id
  FROM tasks
  WHERE id = NEW.parent_task_id;
  IF parent_project_id IS NULL THEN
    RAISE EXCEPTION 'parent task does not exist';
  END IF;
  IF parent_project_id <> NEW.project_id THEN
    RAISE EXCEPTION 'parent and child tasks must belong to the same project';
  END IF;
  IF parent_status IN ('done', 'cancelled') THEN
    RAISE EXCEPTION 'completed or cancelled tasks cannot receive child tasks';
  END IF;
  IF parent_parent_task_id IS NOT NULL THEN
    RAISE EXCEPTION 'task hierarchy depth is limited to one level';
  END IF;
  IF EXISTS (
    SELECT 1 FROM tasks WHERE parent_task_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'a task with children cannot become a child task';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tasks_hierarchy_guard ON tasks;
CREATE TRIGGER tasks_hierarchy_guard
BEFORE INSERT OR UPDATE OF parent_task_id, project_id
ON tasks
FOR EACH ROW
EXECUTE FUNCTION pluginmax_assert_task_hierarchy();

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
    'hierarchy',
    'attachment',
    'dispatch',
    'transfer',
    'claim',
    'control',
    'input',
    'session'
  ));

-- Templates are definitions shared by projects, not project-owned assets.
-- project_id and workspace_id remain for N-1 compatibility but are nullable.
ALTER TABLE teammate_templates
  ALTER COLUMN project_id DROP NOT NULL,
  ALTER COLUMN workspace_id DROP NOT NULL;

ALTER TABLE teammate_template_versions
  ALTER COLUMN project_id DROP NOT NULL;

UPDATE teammate_templates
SET project_id = NULL, workspace_id = NULL
WHERE project_id IS NOT NULL OR workspace_id IS NOT NULL;

DROP TRIGGER IF EXISTS teammate_template_versions_immutable
  ON teammate_template_versions;

UPDATE teammate_template_versions
SET project_id = NULL
WHERE project_id IS NOT NULL;

CREATE TRIGGER teammate_template_versions_immutable
BEFORE UPDATE OR DELETE ON teammate_template_versions
FOR EACH ROW
EXECUTE FUNCTION pluginmax_reject_teammate_template_version_mutation();

DROP INDEX IF EXISTS teammate_templates_active_name_idx;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM teammate_templates
    WHERE scope = 'platform' AND status <> 'archived'
    GROUP BY lower(btrim(definition ->> 'name'))
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'platform teammate template names must be globally unique';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM teammate_templates
    WHERE scope = 'personal' AND status <> 'archived'
    GROUP BY owner_principal_id, lower(btrim(definition ->> 'name'))
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'personal teammate template names must be unique per owner';
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS teammate_templates_platform_name_idx
  ON teammate_templates(lower(btrim(definition ->> 'name')))
  WHERE scope = 'platform' AND status <> 'archived';

CREATE UNIQUE INDEX IF NOT EXISTS teammate_templates_personal_owner_name_idx
  ON teammate_templates(
    owner_principal_id,
    lower(btrim(definition ->> 'name'))
  )
  WHERE scope = 'personal' AND status <> 'archived';

CREATE OR REPLACE FUNCTION pluginmax_assert_teammate_template_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  template_project_id UUID;
  template_scope TEXT;
  template_status TEXT;
  template_owner_principal_id TEXT;
  version_number INTEGER;
  version_project_id UUID;
BEGIN
  SELECT project_id, scope, status, owner_principal_id
  INTO template_project_id, template_scope, template_status,
       template_owner_principal_id
  FROM teammate_templates
  WHERE id = NEW.template_id;

  SELECT version, project_id
  INTO version_number, version_project_id
  FROM teammate_template_versions
  WHERE id = NEW.template_version_id
    AND template_id = NEW.template_id;

  IF version_project_id IS DISTINCT FROM template_project_id
    OR version_number IS DISTINCT FROM NEW.template_version
  THEN
    RAISE EXCEPTION 'teammate template version does not match template scope';
  END IF;
  IF template_status = 'archived' AND TG_OP = 'INSERT' THEN
    RAISE EXCEPTION 'archived teammate template cannot create an instance';
  END IF;
  IF template_scope = 'personal' AND TG_OP = 'INSERT' THEN
    IF template_owner_principal_id IS NULL
      OR template_owner_principal_id <> NEW.owner_principal_id
    THEN
      RAISE EXCEPTION 'personal teammate template requires its owner';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE skill_versions
  ADD COLUMN IF NOT EXISTS instructions_hash TEXT
    CHECK (
      instructions_hash IS NULL
      OR instructions_hash ~ '^[a-f0-9]{64}$'
    );

ALTER TABLE teammate_template_skill_bindings
  ADD COLUMN IF NOT EXISTS mode TEXT,
  ADD COLUMN IF NOT EXISTS scenes JSONB NOT NULL
    DEFAULT '["task-execution"]'::jsonb
    CHECK (
      jsonb_typeof(scenes) = 'array'
      AND jsonb_array_length(scenes) BETWEEN 1 AND 8
    );

UPDATE teammate_template_skill_bindings
SET
  mode = CASE WHEN required THEN 'required' ELSE 'default' END,
  scenes = '["task-execution"]'::jsonb
WHERE mode IS NULL;

ALTER TABLE teammate_template_skill_bindings
  ALTER COLUMN mode SET NOT NULL;

ALTER TABLE teammate_template_skill_bindings
  DROP CONSTRAINT IF EXISTS teammate_template_skill_bindings_mode_check;

ALTER TABLE teammate_template_skill_bindings
  ADD CONSTRAINT teammate_template_skill_bindings_mode_check
  CHECK (mode IN ('required', 'default', 'additive', 'primary'));

ALTER TABLE teammate_template_skill_bindings
  DROP CONSTRAINT IF EXISTS teammate_template_skill_bindings_mode_required_check;

ALTER TABLE teammate_template_skill_bindings
  ADD CONSTRAINT teammate_template_skill_bindings_mode_required_check
  CHECK (
    (required AND mode = 'required')
    OR (NOT required AND mode IN ('default', 'additive', 'primary'))
  );

ALTER TABLE teammate_instance_skill_extensions
  ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'additive',
  ADD COLUMN IF NOT EXISTS scenes JSONB NOT NULL
    DEFAULT '["task-execution"]'::jsonb
    CHECK (
      jsonb_typeof(scenes) = 'array'
      AND jsonb_array_length(scenes) BETWEEN 1 AND 8
    );

ALTER TABLE teammate_instance_skill_extensions
  DROP CONSTRAINT IF EXISTS teammate_instance_skill_extensions_mode_check;

ALTER TABLE teammate_instance_skill_extensions
  ADD CONSTRAINT teammate_instance_skill_extensions_mode_check
  CHECK (mode = 'additive');

-- M9 enable state: no runtime flag is opened by this migration.
`;

export const M10_PLANNING_RUNTIME_SCHEMA_SQL = `
-- M10 expand: Planning control-plane policy, runs, trigger receipts,
-- immutable artifacts, append-only events, and quality snapshots.
INSERT INTO feature_flag_settings (
  flag_key, scope_type, scope_id, mode, revision, updated_by, updated_at
) VALUES
  ('planning.manual', 'platform', 'platform', 'off', 1,
   'system:migration', NOW()),
  ('planning.autopilot', 'platform', 'platform', 'off', 1,
   'system:migration', NOW())
ON CONFLICT (flag_key, scope_type, scope_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS planning_policies (
  id UUID PRIMARY KEY,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('platform', 'project')),
  scope_id TEXT NOT NULL
    CHECK (length(btrim(scope_id)) BETWEEN 1 AND 180),
  config JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(config) = 'object'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_by TEXT NOT NULL
    CHECK (length(btrim(updated_by)) BETWEEN 1 AND 180),
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (scope_type, scope_id)
);

INSERT INTO planning_policies (
  id, scope_type, scope_id, config, revision, updated_by, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000000046',
  'platform',
  'platform',
  '{
    "minScore": 80,
    "autoApprove": false,
    "highRiskReview": true,
    "requireHumanReview": true,
    "maxNodes": 100,
    "maxDepth": 32,
    "triggerPolicy": {
      "agentAssigned": false,
      "taskSpecChanged": false,
      "agentRequested": false,
      "replanRequested": true
    }
  }'::jsonb,
  1,
  'system:migration',
  NOW()
)
ON CONFLICT (scope_type, scope_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS planning_runs (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  root_task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN (
    'queued',
    'preparing',
    'understanding',
    'clarifying',
    'drafting',
    'critiquing',
    'validating',
    'review_required',
    'succeeded',
    'failed',
    'cancelled',
    'paused'
  )),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  trigger_kind TEXT NOT NULL CHECK (trigger_kind IN (
    'human-manual',
    'agent-assigned',
    'task-spec-changed',
    'agent-requested',
    'replan-requested'
  )),
  root_task_revision INTEGER NOT NULL CHECK (root_task_revision > 0),
  policy_revision INTEGER NOT NULL CHECK (policy_revision > 0),
  source_run_id UUID REFERENCES planning_runs(id) ON DELETE RESTRICT,
  workflow_plan_id UUID
    REFERENCES workflow_plans(id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  trigger_count INTEGER NOT NULL DEFAULT 1 CHECK (trigger_count > 0),
  created_by_principal_id TEXT NOT NULL
    REFERENCES principals(id) ON DELETE RESTRICT,
  blocked_reason TEXT,
  failure_code TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  started_at TIMESTAMPTZ,
  paused_at TIMESTAMPTZ,
  terminal_at TIMESTAMPTZ,
  CHECK (updated_at >= created_at),
  CHECK (
    (status = 'paused' AND paused_at IS NOT NULL)
    OR (status <> 'paused' AND paused_at IS NULL)
  ),
  CHECK (
    (status IN ('succeeded', 'failed', 'cancelled')
      AND terminal_at IS NOT NULL)
    OR (status NOT IN ('succeeded', 'failed', 'cancelled')
      AND terminal_at IS NULL)
  ),
  CHECK (status <> 'succeeded' OR workflow_plan_id IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS planning_runs_active_root_idx
  ON planning_runs(root_task_id)
  WHERE status NOT IN ('succeeded', 'failed', 'cancelled');

CREATE UNIQUE INDEX IF NOT EXISTS planning_runs_workflow_plan_idx
  ON planning_runs(workflow_plan_id)
  WHERE workflow_plan_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS planning_runs_project_status_idx
  ON planning_runs(project_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS planning_runs_root_created_idx
  ON planning_runs(root_task_id, created_at DESC);

CREATE OR REPLACE FUNCTION pluginmax_assert_planning_run_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  task_project_id UUID;
  task_parent_id UUID;
BEGIN
  SELECT project_id, parent_task_id
  INTO task_project_id, task_parent_id
  FROM tasks
  WHERE id = NEW.root_task_id;

  IF task_project_id IS NULL THEN
    RAISE EXCEPTION 'planning root task does not exist';
  END IF;
  IF task_project_id <> NEW.project_id THEN
    RAISE EXCEPTION 'planning root task must belong to its project';
  END IF;
  IF task_parent_id IS NOT NULL THEN
    RAISE EXCEPTION 'planning may only start from a root task';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS planning_runs_scope_guard ON planning_runs;
CREATE TRIGGER planning_runs_scope_guard
BEFORE INSERT OR UPDATE OF project_id, root_task_id
ON planning_runs
FOR EACH ROW
EXECUTE FUNCTION pluginmax_assert_planning_run_scope();

CREATE OR REPLACE FUNCTION pluginmax_assert_planning_run_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  transition_allowed BOOLEAN := FALSE;
BEGIN
  IF NEW.status = OLD.status THEN
    IF NEW.revision <> OLD.revision + 1 THEN
      RAISE EXCEPTION 'planning run revision must advance by one';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status IN ('succeeded', 'failed', 'cancelled') THEN
    RAISE EXCEPTION 'terminal planning runs are immutable';
  END IF;
  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'planning run revision must advance by one';
  END IF;

  transition_allowed := CASE
    WHEN OLD.status = 'queued'
      AND NEW.status IN ('preparing', 'paused', 'cancelled', 'failed')
      THEN TRUE
    WHEN OLD.status = 'preparing'
      AND NEW.status IN (
        'understanding', 'clarifying', 'drafting', 'critiquing',
        'validating', 'review_required', 'paused', 'cancelled', 'failed'
      )
      THEN TRUE
    WHEN OLD.status = 'understanding'
      AND NEW.status IN (
        'clarifying', 'drafting', 'critiquing', 'validating',
        'review_required', 'paused', 'cancelled', 'failed'
      )
      THEN TRUE
    WHEN OLD.status = 'clarifying'
      AND NEW.status IN (
        'understanding', 'drafting', 'review_required',
        'paused', 'cancelled', 'failed'
      )
      THEN TRUE
    WHEN OLD.status = 'drafting'
      AND NEW.status IN (
        'critiquing', 'validating', 'review_required',
        'paused', 'cancelled', 'failed'
      )
      THEN TRUE
    WHEN OLD.status = 'critiquing'
      AND NEW.status IN (
        'drafting', 'validating', 'review_required',
        'paused', 'cancelled', 'failed'
      )
      THEN TRUE
    WHEN OLD.status = 'validating'
      AND NEW.status IN (
        'review_required', 'succeeded', 'paused', 'cancelled', 'failed'
      )
      THEN TRUE
    WHEN OLD.status = 'review_required'
      AND NEW.status IN ('preparing', 'succeeded', 'cancelled', 'failed')
      THEN TRUE
    WHEN OLD.status = 'paused'
      AND NEW.status IN ('preparing', 'cancelled', 'failed')
      THEN TRUE
    ELSE FALSE
  END;

  IF NOT transition_allowed THEN
    RAISE EXCEPTION 'illegal planning run transition: % -> %',
      OLD.status, NEW.status;
  END IF;
  IF NEW.status = 'succeeded' AND NEW.workflow_plan_id IS NULL THEN
    RAISE EXCEPTION 'succeeded planning run must bind a workflow plan';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS planning_runs_transition_guard ON planning_runs;
CREATE TRIGGER planning_runs_transition_guard
BEFORE UPDATE ON planning_runs
FOR EACH ROW
EXECUTE FUNCTION pluginmax_assert_planning_run_transition();

CREATE TABLE IF NOT EXISTS planning_trigger_receipts (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  root_task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  planning_run_id UUID NOT NULL
    REFERENCES planning_runs(id) ON DELETE RESTRICT,
  trigger_kind TEXT NOT NULL CHECK (trigger_kind IN (
    'human-manual',
    'agent-assigned',
    'task-spec-changed',
    'agent-requested',
    'replan-requested'
  )),
  root_task_revision INTEGER NOT NULL CHECK (root_task_revision > 0),
  event_key TEXT NOT NULL CHECK (event_key ~ '^[a-f0-9]{64}$'),
  request_digest TEXT NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  status TEXT NOT NULL CHECK (status IN ('accepted', 'merged', 'discarded')),
  reason TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (project_id, root_task_id, event_key)
);

CREATE INDEX IF NOT EXISTS planning_trigger_receipts_run_idx
  ON planning_trigger_receipts(planning_run_id, created_at);

CREATE OR REPLACE FUNCTION pluginmax_reject_planning_trigger_receipt_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'planning trigger receipts are immutable';
END;
$$;

DROP TRIGGER IF EXISTS planning_trigger_receipts_immutable
  ON planning_trigger_receipts;
CREATE TRIGGER planning_trigger_receipts_immutable
BEFORE UPDATE OR DELETE ON planning_trigger_receipts
FOR EACH ROW
EXECUTE FUNCTION pluginmax_reject_planning_trigger_receipt_mutation();

CREATE TABLE IF NOT EXISTS planning_artifacts (
  id UUID PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES planning_runs(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN (
    'requirement-brief',
    'facts-ledger',
    'critic',
    'context-pack',
    'plan-draft',
    'skill-snapshot',
    'knowledge-receipt'
  )),
  version INTEGER NOT NULL CHECK (version > 0),
  content_digest TEXT NOT NULL CHECK (content_digest ~ '^[a-f0-9]{64}$'),
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  created_by_principal_id TEXT NOT NULL
    REFERENCES principals(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (run_id, kind, version)
);

CREATE INDEX IF NOT EXISTS planning_artifacts_run_idx
  ON planning_artifacts(run_id, kind, version DESC);

CREATE OR REPLACE FUNCTION pluginmax_reject_planning_artifact_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'planning artifacts are immutable';
END;
$$;

DROP TRIGGER IF EXISTS planning_artifacts_immutable ON planning_artifacts;
CREATE TRIGGER planning_artifacts_immutable
BEFORE UPDATE OR DELETE ON planning_artifacts
FOR EACH ROW
EXECUTE FUNCTION pluginmax_reject_planning_artifact_mutation();

CREATE TABLE IF NOT EXISTS planning_events (
  id UUID PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES planning_runs(id) ON DELETE RESTRICT,
  seq BIGINT NOT NULL CHECK (seq > 0),
  kind TEXT NOT NULL CHECK (kind IN (
    'run.created',
    'trigger.merged',
    'run.started',
    'run.paused',
    'run.cancelled',
    'run.review_required',
    'run.retried',
    'run.succeeded',
    'run.failed',
    'artifact.recorded',
    'quality.recorded'
  )),
  event_key TEXT NOT NULL CHECK (event_key ~ '^[a-f0-9]{64}$'),
  actor_principal_id TEXT NOT NULL
    REFERENCES principals(id) ON DELETE RESTRICT,
  summary TEXT NOT NULL,
  data JSONB CHECK (data IS NULL OR jsonb_typeof(data) = 'object'),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (run_id, seq),
  UNIQUE (event_key)
);

CREATE INDEX IF NOT EXISTS planning_events_run_idx
  ON planning_events(run_id, seq);

CREATE OR REPLACE FUNCTION pluginmax_reject_planning_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'planning events are append-only';
END;
$$;

DROP TRIGGER IF EXISTS planning_events_append_only ON planning_events;
CREATE TRIGGER planning_events_append_only
BEFORE UPDATE OR DELETE ON planning_events
FOR EACH ROW
EXECUTE FUNCTION pluginmax_reject_planning_event_mutation();

CREATE TABLE IF NOT EXISTS planning_quality_metrics (
  id UUID PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES planning_runs(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version > 0),
  critic_score NUMERIC(5, 2)
    CHECK (critic_score IS NULL OR critic_score BETWEEN 0 AND 100),
  validator_error_count INTEGER NOT NULL DEFAULT 0
    CHECK (validator_error_count >= 0),
  acceptance_coverage NUMERIC(5, 4)
    CHECK (
      acceptance_coverage IS NULL
      OR acceptance_coverage BETWEEN 0 AND 1
    ),
  node_count INTEGER NOT NULL DEFAULT 0 CHECK (node_count >= 0),
  depth INTEGER NOT NULL DEFAULT 0 CHECK (depth >= 0),
  human_review_required BOOLEAN NOT NULL,
  auto_approve_eligible BOOLEAN NOT NULL,
  recorded_by_principal_id TEXT NOT NULL
    REFERENCES principals(id) ON DELETE RESTRICT,
  recorded_at TIMESTAMPTZ NOT NULL,
  UNIQUE (run_id, version)
);

CREATE INDEX IF NOT EXISTS planning_quality_metrics_run_idx
  ON planning_quality_metrics(run_id, version DESC);

CREATE OR REPLACE FUNCTION pluginmax_reject_planning_quality_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'planning quality metrics are immutable';
END;
$$;

DROP TRIGGER IF EXISTS planning_quality_metrics_immutable
  ON planning_quality_metrics;
CREATE TRIGGER planning_quality_metrics_immutable
BEFORE UPDATE OR DELETE ON planning_quality_metrics
FOR EACH ROW
EXECUTE FUNCTION pluginmax_reject_planning_quality_mutation();

ALTER TABLE workflow_plans
  ADD COLUMN IF NOT EXISTS planning_run_id UUID
    REFERENCES planning_runs(id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  ADD COLUMN IF NOT EXISTS planning_source_legacy_unverified BOOLEAN
    NOT NULL DEFAULT FALSE;

-- Planning-generated Router plans are produced by the Planning Runtime and do
-- not require an M3 Router Agent. Preserve the original constraint for legacy
-- callers while allowing a server-verified Planning Run to prove provenance.
ALTER TABLE workflow_plans
  DROP CONSTRAINT IF EXISTS workflow_plans_check3;
ALTER TABLE workflow_plans
  DROP CONSTRAINT IF EXISTS workflow_plans_router_agent_required;
ALTER TABLE workflow_plans
  ADD CONSTRAINT workflow_plans_router_agent_required
  CHECK (
    source <> 'router'
    OR router_agent_id IS NOT NULL
    OR planning_run_id IS NOT NULL
  );

-- Legacy Router plans predate Planning Runs. They remain readable without
-- fabricating provenance. New rows cannot opt into this compatibility marker.
UPDATE workflow_plans
SET planning_source_legacy_unverified = TRUE
WHERE source = 'router' AND planning_run_id IS NULL;

ALTER TABLE workflow_plans
  DROP CONSTRAINT IF EXISTS workflow_plans_planning_run_key;
ALTER TABLE workflow_plans
  ADD CONSTRAINT workflow_plans_planning_run_key
  UNIQUE (planning_run_id);

-- Validate before enforcement: only rows classified above may omit a run.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM workflow_plans
    WHERE source = 'router'
      AND planning_run_id IS NULL
      AND NOT planning_source_legacy_unverified
  ) THEN
    RAISE EXCEPTION 'router plan provenance precheck failed';
  END IF;
END;
$$;

ALTER TABLE workflow_plans
  DROP CONSTRAINT IF EXISTS workflow_plans_router_planning_run_check;
ALTER TABLE workflow_plans
  ADD CONSTRAINT workflow_plans_router_planning_run_check
  CHECK (
    source <> 'router'
    OR planning_run_id IS NOT NULL
    OR planning_source_legacy_unverified
  )
  NOT VALID;

ALTER TABLE workflow_plans
  VALIDATE CONSTRAINT workflow_plans_router_planning_run_check;

CREATE OR REPLACE FUNCTION pluginmax_assert_workflow_plan_planning_source()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  run_project_id UUID;
  run_root_task_id UUID;
  run_status TEXT;
BEGIN
  IF NEW.source = 'router'
    AND NEW.planning_run_id IS NULL
    AND NOT NEW.planning_source_legacy_unverified
  THEN
    RAISE EXCEPTION 'router plans require a planning run';
  END IF;
  IF NEW.planning_run_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT project_id, root_task_id, status
  INTO run_project_id, run_root_task_id, run_status
  FROM planning_runs
  WHERE id = NEW.planning_run_id;

  IF run_project_id IS NULL THEN
    RAISE EXCEPTION 'planning run does not exist';
  END IF;
  IF run_project_id <> NEW.project_id
    OR run_root_task_id <> NEW.root_task_id
  THEN
    RAISE EXCEPTION 'planning run scope does not match workflow plan';
  END IF;
  IF run_status NOT IN ('review_required', 'succeeded') THEN
    RAISE EXCEPTION 'planning run is not ready to bind a workflow plan';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION pluginmax_guard_planning_legacy_source()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.planning_source_legacy_unverified THEN
    RAISE EXCEPTION 'legacy planning provenance is migration-only';
  END IF;
  IF TG_OP = 'UPDATE'
    AND NEW.planning_source_legacy_unverified
    AND NOT OLD.planning_source_legacy_unverified
  THEN
    RAISE EXCEPTION 'legacy planning provenance is migration-only';
  END IF;
  RETURN NEW;
END;
$$;

-- Plan Versions are immutable. A Router version may omit Router Agent metadata
-- only when its parent Plan is bound to a Planning Run.
DO $$
DECLARE
  constraint_name TEXT;
BEGIN
  FOR constraint_name IN
    SELECT constraint_entry.conname
    FROM pg_constraint AS constraint_entry
    WHERE constraint_entry.conrelid =
      'workflow_plan_versions'::regclass
      AND constraint_entry.contype = 'c'
      AND pg_get_constraintdef(constraint_entry.oid)
        LIKE '%router_agent_id IS NOT NULL%'
  LOOP
    EXECUTE format(
      'ALTER TABLE workflow_plan_versions DROP CONSTRAINT %I',
      constraint_name
    );
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION pluginmax_assert_workflow_plan_version_source()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_planning_run_id UUID;
  parent_legacy_unverified BOOLEAN;
  parent_project_id UUID;
  parent_root_task_id UUID;
  version_project_id UUID;
  version_root_task_id UUID;
BEGIN
  IF NEW.source = 'router' AND NEW.router_agent_id IS NULL THEN
    SELECT planning_run_id, planning_source_legacy_unverified,
           project_id, root_task_id
    INTO parent_planning_run_id, parent_legacy_unverified,
         parent_project_id, parent_root_task_id
    FROM workflow_plans
    WHERE id = NEW.plan_id;
    IF parent_project_id IS NULL THEN
      RAISE EXCEPTION 'workflow plan version parent is missing';
    END IF;
    IF parent_planning_run_id IS NULL THEN
      RAISE EXCEPTION 'router plan versions require planning provenance';
    END IF;
    IF parent_legacy_unverified THEN
      RAISE EXCEPTION 'legacy router plans cannot receive new versions';
    END IF;
    SELECT project_id, root_task_id
    INTO version_project_id, version_root_task_id
    FROM workflow_plans
    WHERE id = NEW.plan_id;
    IF version_project_id IS DISTINCT FROM parent_project_id
      OR version_root_task_id IS DISTINCT FROM parent_root_task_id
    THEN
      RAISE EXCEPTION 'workflow plan version scope changed';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS workflow_plan_versions_planning_source_guard
  ON workflow_plan_versions;
CREATE TRIGGER workflow_plan_versions_planning_source_guard
BEFORE INSERT OR UPDATE OF source, router_agent_id, plan_id
ON workflow_plan_versions
FOR EACH ROW
EXECUTE FUNCTION pluginmax_assert_workflow_plan_version_source();

DROP TRIGGER IF EXISTS workflow_plans_planning_legacy_guard
  ON workflow_plans;
CREATE TRIGGER workflow_plans_planning_legacy_guard
BEFORE INSERT OR UPDATE OF planning_source_legacy_unverified
ON workflow_plans
FOR EACH ROW
EXECUTE FUNCTION pluginmax_guard_planning_legacy_source();

DROP TRIGGER IF EXISTS workflow_plans_planning_source_guard
  ON workflow_plans;
CREATE TRIGGER workflow_plans_planning_source_guard
BEFORE INSERT OR UPDATE OF
  source, planning_run_id, project_id, root_task_id
ON workflow_plans
FOR EACH ROW
EXECUTE FUNCTION pluginmax_assert_workflow_plan_planning_source();

-- M10 enable state: planning.manual and planning.autopilot remain off.
`;

export const M11_PROJECT_BUSINESS_CHAIN_SCHEMA_SQL = `
-- M11 expand: business-chain definitions, project bindings, immutable source
-- snapshots, and stable project alerts. The overview remains a read model and
-- is deliberately not persisted.
INSERT INTO feature_flag_settings (
  flag_key, scope_type, scope_id, mode, revision, updated_by, updated_at
) VALUES
  ('project.business_chain', 'platform', 'platform', 'off', 1,
   'system:migration', NOW()),
  ('project.source.mock', 'platform', 'platform', 'off', 1,
   'system:migration', NOW())
ON CONFLICT (flag_key, scope_type, scope_id) DO NOTHING;

ALTER TABLE workflow_definitions
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'workflow',
  ADD COLUMN IF NOT EXISTS chain_key TEXT,
  ADD COLUMN IF NOT EXISTS business_chain_metadata JSONB,
  ADD COLUMN IF NOT EXISTS business_chain_nodes JSONB NOT NULL
    DEFAULT '[]'::jsonb;

ALTER TABLE workflow_definitions
  DROP CONSTRAINT IF EXISTS workflow_definitions_kind_check;
ALTER TABLE workflow_definitions
  ADD CONSTRAINT workflow_definitions_kind_check
  CHECK (kind IN ('workflow', 'business-chain'));

ALTER TABLE workflow_definitions
  DROP CONSTRAINT IF EXISTS workflow_definitions_business_chain_check;
ALTER TABLE workflow_definitions
  ADD CONSTRAINT workflow_definitions_business_chain_check
  CHECK (
    (
      kind = 'workflow'
      AND chain_key IS NULL
      AND business_chain_metadata IS NULL
      AND business_chain_nodes = '[]'::jsonb
    )
    OR (
      kind = 'business-chain'
      AND chain_key IS NOT NULL
      AND business_chain_metadata IS NOT NULL
      AND jsonb_typeof(business_chain_metadata) = 'object'
      AND business_chain_metadata ->> 'chainKey' = chain_key
      AND jsonb_typeof(business_chain_nodes) = 'array'
      AND jsonb_array_length(business_chain_nodes) > 0
    )
  );

CREATE INDEX IF NOT EXISTS workflow_definitions_business_chain_idx
  ON workflow_definitions(scope, status, chain_key, revision DESC)
  WHERE kind = 'business-chain';

CREATE OR REPLACE FUNCTION pluginmax_assert_business_chain_definition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  metadata_chain_key TEXT;
  duplicate_stage_count INTEGER;
  duplicate_sequence_count INTEGER;
BEGIN
  IF NEW.kind <> 'business-chain' THEN
    RETURN NEW;
  END IF;
  metadata_chain_key := NEW.business_chain_metadata ->> 'chainKey';
  IF metadata_chain_key IS DISTINCT FROM NEW.chain_key THEN
    RAISE EXCEPTION 'business chain key must match definition metadata';
  END IF;
  IF NEW.scope = 'platform'
    AND (NEW.status <> 'active' OR NEW.published_at IS NULL)
  THEN
    RAISE EXCEPTION 'platform business chain definitions must be published';
  END IF;

  SELECT COUNT(*)
  INTO duplicate_stage_count
  FROM (
    SELECT node ->> 'stageCode'
    FROM jsonb_array_elements(NEW.business_chain_nodes) AS node
    GROUP BY node ->> 'stageCode'
    HAVING COUNT(*) > 1
  ) AS duplicate_stage;
  IF duplicate_stage_count > 0 THEN
    RAISE EXCEPTION 'business chain stageCode values must be unique';
  END IF;

  SELECT COUNT(*)
  INTO duplicate_sequence_count
  FROM (
    SELECT (node ->> 'sequence')::integer
    FROM jsonb_array_elements(NEW.business_chain_nodes) AS node
    GROUP BY (node ->> 'sequence')::integer
    HAVING COUNT(*) > 1
  ) AS duplicate_sequence;
  IF duplicate_sequence_count > 0 THEN
    RAISE EXCEPTION 'business chain sequence values must be unique';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS workflow_definitions_business_chain_guard
  ON workflow_definitions;
CREATE TRIGGER workflow_definitions_business_chain_guard
BEFORE INSERT OR UPDATE OF
  kind, chain_key, business_chain_metadata, business_chain_nodes,
  scope, status, published_at
ON workflow_definitions
FOR EACH ROW
EXECUTE FUNCTION pluginmax_assert_business_chain_definition();

ALTER TABLE project_templates
  ADD COLUMN IF NOT EXISTS business_chain_policy JSONB NOT NULL
    DEFAULT '{
      "mode": "none",
      "defaultBusinessChainKey": null,
      "allowedBusinessChainKeys": [],
      "versionPolicy": "latest-active"
    }'::jsonb;

ALTER TABLE project_templates
  DROP CONSTRAINT IF EXISTS project_templates_business_chain_policy_check;
ALTER TABLE project_templates
  ADD CONSTRAINT project_templates_business_chain_policy_check
  CHECK (
    jsonb_typeof(business_chain_policy) = 'object'
    AND business_chain_policy ->> 'mode' IN ('required', 'optional', 'none')
    AND business_chain_policy ->> 'versionPolicy' IN (
      'pin-at-project-create',
      'latest-active'
    )
    AND jsonb_typeof(
      business_chain_policy -> 'allowedBusinessChainKeys'
    ) = 'array'
  );

CREATE TABLE IF NOT EXISTS project_template_business_chain_refs (
  template_id UUID NOT NULL
    REFERENCES project_templates(id) ON DELETE CASCADE,
  workflow_definition_id UUID NOT NULL
    REFERENCES workflow_definitions(id) ON DELETE RESTRICT,
  workflow_definition_version INTEGER NOT NULL
    CHECK (workflow_definition_version > 0),
  definition_snapshot JSONB NOT NULL
    CHECK (jsonb_typeof(definition_snapshot) = 'object'),
  chain_key_snapshot TEXT NOT NULL
    CHECK (length(btrim(chain_key_snapshot)) BETWEEN 1 AND 120),
  display_name_snapshot TEXT NOT NULL
    CHECK (length(btrim(display_name_snapshot)) BETWEEN 1 AND 160),
  required BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (template_id, workflow_definition_id)
);

CREATE INDEX IF NOT EXISTS project_template_business_chain_refs_definition_idx
  ON project_template_business_chain_refs(
    workflow_definition_id,
    workflow_definition_version
  );

CREATE OR REPLACE FUNCTION pluginmax_assert_project_template_business_chain_ref()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  definition_kind TEXT;
  definition_scope TEXT;
  definition_status TEXT;
  definition_published_at TIMESTAMPTZ;
BEGIN
  SELECT kind, scope, status, published_at
  INTO definition_kind, definition_scope, definition_status,
       definition_published_at
  FROM workflow_definitions
  WHERE id = NEW.workflow_definition_id;
  IF definition_kind IS NULL THEN
    RAISE EXCEPTION 'business chain definition does not exist';
  END IF;
  IF definition_kind <> 'business-chain' THEN
    RAISE EXCEPTION 'project template references must be business chains';
  END IF;
  IF definition_scope <> 'platform'
    OR definition_status <> 'active'
    OR definition_published_at IS NULL
  THEN
    RAISE EXCEPTION 'project template references require published platform chains';
  END IF;
  IF NEW.definition_snapshot ->> 'id' <>
      NEW.workflow_definition_id::text
    OR (NEW.definition_snapshot ->> 'version')::integer <>
      NEW.workflow_definition_version
    OR NEW.definition_snapshot -> 'metadata' ->> 'chainKey' <>
      NEW.chain_key_snapshot
  THEN
    RAISE EXCEPTION 'project template business chain reference is stale';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS project_template_business_chain_refs_guard
  ON project_template_business_chain_refs;
CREATE TRIGGER project_template_business_chain_refs_guard
BEFORE INSERT OR UPDATE ON project_template_business_chain_refs
FOR EACH ROW
EXECUTE FUNCTION pluginmax_assert_project_template_business_chain_ref();

CREATE TABLE IF NOT EXISTS project_business_chain_binding_revisions (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK (revision > 0),
  operation TEXT NOT NULL CHECK (operation IN ('bind', 'upgrade', 'unbind')),
  project_template_id UUID
    REFERENCES project_templates(id) ON DELETE RESTRICT,
  source_template_revision INTEGER
    CHECK (source_template_revision IS NULL OR source_template_revision > 0),
  workflow_definition_id UUID
    REFERENCES workflow_definitions(id) ON DELETE RESTRICT,
  workflow_definition_version INTEGER
    CHECK (
      workflow_definition_version IS NULL
      OR workflow_definition_version > 0
    ),
  definition_snapshot JSONB,
  chain_key TEXT,
  binding_mode TEXT
    CHECK (binding_mode IS NULL OR binding_mode IN ('template', 'manual', 'upgrade')),
  node_bindings JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(node_bindings) = 'array'),
  binding_digest TEXT
    CHECK (binding_digest IS NULL OR binding_digest ~ '^[a-f0-9]{64}$'),
  actor_principal_id TEXT NOT NULL
    CHECK (length(btrim(actor_principal_id)) BETWEEN 1 AND 180),
  reason TEXT NOT NULL DEFAULT ''
    CHECK (length(reason) <= 2000),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (project_id, revision),
  CHECK (
    (
      operation IN ('bind', 'upgrade')
      AND workflow_definition_id IS NOT NULL
      AND workflow_definition_version IS NOT NULL
      AND definition_snapshot IS NOT NULL
      AND jsonb_typeof(definition_snapshot) = 'object'
      AND chain_key IS NOT NULL
      AND binding_mode IS NOT NULL
      AND binding_digest IS NOT NULL
    )
    OR (
      operation = 'unbind'
      AND workflow_definition_id IS NULL
      AND workflow_definition_version IS NULL
      AND definition_snapshot IS NULL
      AND chain_key IS NULL
      AND binding_mode IS NULL
      AND binding_digest IS NULL
      AND jsonb_array_length(node_bindings) = 0
    )
  )
);

CREATE INDEX IF NOT EXISTS project_business_chain_binding_revisions_project_idx
  ON project_business_chain_binding_revisions(project_id, revision DESC);

CREATE OR REPLACE FUNCTION pluginmax_reject_project_business_chain_revision_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'project business chain revisions are immutable';
END;
$$;

DROP TRIGGER IF EXISTS project_business_chain_binding_revisions_immutable
  ON project_business_chain_binding_revisions;
CREATE TRIGGER project_business_chain_binding_revisions_immutable
BEFORE UPDATE OR DELETE ON project_business_chain_binding_revisions
FOR EACH ROW
EXECUTE FUNCTION pluginmax_reject_project_business_chain_revision_mutation();

CREATE TABLE IF NOT EXISTS project_business_chain_bindings (
  project_id UUID PRIMARY KEY REFERENCES projects(id) ON DELETE RESTRICT,
  project_template_id UUID
    REFERENCES project_templates(id) ON DELETE RESTRICT,
  source_template_revision INTEGER
    CHECK (source_template_revision IS NULL OR source_template_revision > 0),
  workflow_definition_id UUID
    REFERENCES workflow_definitions(id) ON DELETE RESTRICT,
  workflow_definition_version INTEGER
    CHECK (
      workflow_definition_version IS NULL
      OR workflow_definition_version > 0
    ),
  definition_snapshot JSONB,
  chain_key TEXT,
  binding_mode TEXT
    CHECK (binding_mode IS NULL OR binding_mode IN ('template', 'manual', 'upgrade')),
  node_bindings JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(node_bindings) = 'array'),
  binding_digest TEXT
    CHECK (binding_digest IS NULL OR binding_digest ~ '^[a-f0-9]{64}$'),
  active BOOLEAN NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  bound_by_principal_id TEXT
    CHECK (
      bound_by_principal_id IS NULL
      OR length(btrim(bound_by_principal_id)) BETWEEN 1 AND 180
    ),
  bound_at TIMESTAMPTZ,
  unbound_by_principal_id TEXT
    CHECK (
      unbound_by_principal_id IS NULL
      OR length(btrim(unbound_by_principal_id)) BETWEEN 1 AND 180
    ),
  unbound_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (project_id, revision),
  FOREIGN KEY (project_id, revision)
    REFERENCES project_business_chain_binding_revisions(project_id, revision)
    ON DELETE RESTRICT,
  CHECK (
    (
      active
      AND workflow_definition_id IS NOT NULL
      AND workflow_definition_version IS NOT NULL
      AND definition_snapshot IS NOT NULL
      AND jsonb_typeof(definition_snapshot) = 'object'
      AND chain_key IS NOT NULL
      AND binding_mode IS NOT NULL
      AND binding_digest IS NOT NULL
      AND bound_by_principal_id IS NOT NULL
      AND bound_at IS NOT NULL
      AND unbound_by_principal_id IS NULL
      AND unbound_at IS NULL
    )
    OR (
      NOT active
      AND workflow_definition_id IS NULL
      AND workflow_definition_version IS NULL
      AND definition_snapshot IS NULL
      AND chain_key IS NULL
      AND binding_mode IS NULL
      AND binding_digest IS NULL
      AND jsonb_array_length(node_bindings) = 0
      AND unbound_by_principal_id IS NOT NULL
      AND unbound_at IS NOT NULL
    )
  )
);

CREATE OR REPLACE FUNCTION pluginmax_assert_project_business_chain_binding()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  definition_kind TEXT;
  definition_scope TEXT;
  definition_project_id UUID;
  definition_chain_key TEXT;
  definition_version INTEGER;
  project_scope TEXT;
  project_source_template_id UUID;
  project_source_template_revision INTEGER;
  policy_mode TEXT;
  allowed_keys JSONB;
BEGIN
  IF NOT NEW.active THEN
    RETURN NEW;
  END IF;

  SELECT kind, scope, project_id, chain_key, revision
  INTO definition_kind, definition_scope, definition_project_id,
       definition_chain_key, definition_version
  FROM workflow_definitions
  WHERE id = NEW.workflow_definition_id;
  IF definition_kind IS NULL THEN
    RAISE EXCEPTION 'business chain definition does not exist';
  END IF;
  IF definition_kind <> 'business-chain' THEN
    RAISE EXCEPTION 'project binding must reference a business chain';
  END IF;
  IF NEW.definition_snapshot ->> 'id' <>
      NEW.workflow_definition_id::text
    OR (NEW.definition_snapshot ->> 'version')::integer <>
      NEW.workflow_definition_version
    OR NEW.definition_snapshot -> 'metadata' ->> 'chainKey' <>
      NEW.chain_key
  THEN
    RAISE EXCEPTION 'project binding definition snapshot is invalid';
  END IF;
  IF definition_scope = 'project'
    AND definition_project_id <> NEW.project_id
  THEN
    RAISE EXCEPTION 'project business chain definition scope mismatch';
  END IF;

  SELECT
    CASE status WHEN 'active' THEN 'active' ELSE 'archived' END,
    source_template_id,
    source_template_revision
  INTO project_scope, project_source_template_id,
       project_source_template_revision
  FROM projects
  WHERE id = NEW.project_id;
  IF project_scope IS NULL THEN
    RAISE EXCEPTION 'project binding project does not exist';
  END IF;
  IF NEW.project_template_id IS DISTINCT FROM project_source_template_id
    OR NEW.source_template_revision IS DISTINCT FROM
      project_source_template_revision
  THEN
    RAISE EXCEPTION 'project binding template scope mismatch';
  END IF;
  IF NEW.project_template_id IS NOT NULL THEN
    SELECT business_chain_policy ->> 'mode',
           business_chain_policy -> 'allowedBusinessChainKeys'
    INTO policy_mode, allowed_keys
    FROM project_templates
    WHERE id = NEW.project_template_id;
    IF policy_mode IS NULL THEN
      RAISE EXCEPTION 'project template does not exist';
    END IF;
    IF policy_mode = 'none' THEN
      RAISE EXCEPTION 'project template does not allow a business chain';
    END IF;
    IF NOT allowed_keys ? NEW.chain_key THEN
      RAISE EXCEPTION 'business chain is outside the project template policy';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS project_business_chain_bindings_guard
  ON project_business_chain_bindings;
CREATE TRIGGER project_business_chain_bindings_guard
BEFORE INSERT OR UPDATE OF
  project_id, workflow_definition_id, workflow_definition_version,
  chain_key, binding_mode, node_bindings, binding_digest, active
ON project_business_chain_bindings
FOR EACH ROW
EXECUTE FUNCTION pluginmax_assert_project_business_chain_binding();

CREATE OR REPLACE FUNCTION pluginmax_assert_project_business_chain_revision_increment()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.project_id <> OLD.project_id THEN
    RAISE EXCEPTION 'project binding project is immutable';
  END IF;
  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'project binding revision must advance by one';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS project_business_chain_bindings_revision_guard
  ON project_business_chain_bindings;
CREATE TRIGGER project_business_chain_bindings_revision_guard
BEFORE UPDATE ON project_business_chain_bindings
FOR EACH ROW
EXECUTE FUNCTION pluginmax_assert_project_business_chain_revision_increment();

CREATE OR REPLACE FUNCTION pluginmax_reject_project_business_chain_binding_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'project business chain bindings must be unbound, not deleted';
END;
$$;

DROP TRIGGER IF EXISTS project_business_chain_bindings_delete_guard
  ON project_business_chain_bindings;
CREATE TRIGGER project_business_chain_bindings_delete_guard
BEFORE DELETE ON project_business_chain_bindings
FOR EACH ROW
EXECUTE FUNCTION pluginmax_reject_project_business_chain_binding_delete();

CREATE TABLE IF NOT EXISTS project_source_snapshots (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  ref_key TEXT NOT NULL
    CHECK (length(btrim(ref_key)) BETWEEN 1 AND 160),
  source_kind TEXT NOT NULL
    CHECK (length(btrim(source_kind)) BETWEEN 1 AND 80),
  source_system TEXT NOT NULL
    CHECK (length(btrim(source_system)) BETWEEN 1 AND 120),
  source_object_type TEXT NOT NULL
    CHECK (length(btrim(source_object_type)) BETWEEN 1 AND 120),
  source_object_id TEXT NOT NULL
    CHECK (length(btrim(source_object_id)) BETWEEN 1 AND 240),
  source_revision TEXT
    CHECK (
      source_revision IS NULL
      OR length(btrim(source_revision)) BETWEEN 1 AND 240
    ),
  version INTEGER NOT NULL CHECK (version > 0),
  status TEXT NOT NULL CHECK (status IN ('fresh', 'stale', 'error')),
  observed_at TIMESTAMPTZ NOT NULL,
  effective_at TIMESTAMPTZ,
  fresh_until TIMESTAMPTZ,
  payload_digest TEXT
    CHECK (payload_digest IS NULL OR payload_digest ~ '^[a-f0-9]{64}$'),
  payload JSONB,
  failure_reason TEXT
    CHECK (failure_reason IS NULL OR length(failure_reason) <= 2000),
  is_mock BOOLEAN NOT NULL DEFAULT FALSE,
  created_by_principal_id TEXT NOT NULL
    CHECK (length(btrim(created_by_principal_id)) BETWEEN 1 AND 180),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (project_id, ref_key, version),
  CHECK (
    (
      status <> 'error'
      AND payload_digest IS NOT NULL
      AND payload IS NOT NULL
      AND failure_reason IS NULL
    )
    OR (
      status = 'error'
      AND payload_digest IS NULL
      AND payload IS NULL
      AND failure_reason IS NOT NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS project_source_snapshots_active_idx
  ON project_source_snapshots(project_id, ref_key, version DESC);

CREATE INDEX IF NOT EXISTS project_source_snapshots_observed_idx
  ON project_source_snapshots(project_id, observed_at DESC, id);

CREATE OR REPLACE FUNCTION pluginmax_assign_project_source_snapshot_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtext(NEW.project_id::text || ':' || NEW.ref_key)
  );
  SELECT COALESCE(MAX(version), 0) + 1
  INTO NEW.version
  FROM project_source_snapshots
  WHERE project_id = NEW.project_id
    AND ref_key = NEW.ref_key;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS project_source_snapshots_version_guard
  ON project_source_snapshots;
CREATE TRIGGER project_source_snapshots_version_guard
BEFORE INSERT ON project_source_snapshots
FOR EACH ROW
EXECUTE FUNCTION pluginmax_assign_project_source_snapshot_version();

CREATE OR REPLACE FUNCTION pluginmax_reject_project_source_snapshot_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'project source snapshots are immutable';
END;
$$;

DROP TRIGGER IF EXISTS project_source_snapshots_immutable
  ON project_source_snapshots;
CREATE TRIGGER project_source_snapshots_immutable
BEFORE UPDATE OR DELETE ON project_source_snapshots
FOR EACH ROW
EXECUTE FUNCTION pluginmax_reject_project_source_snapshot_mutation();

CREATE TABLE IF NOT EXISTS project_alerts (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  condition_key TEXT NOT NULL CHECK (condition_key ~ '^[a-f0-9]{64}$'),
  source_system TEXT NOT NULL,
  source_object_type TEXT NOT NULL,
  source_object_id TEXT NOT NULL,
  condition_code TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  lifecycle TEXT NOT NULL DEFAULT 'open'
    CHECK (lifecycle IN ('open', 'acknowledged', 'suppressed', 'resolved')),
  source_revision TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by_principal_id TEXT,
  suppression_until TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  resolved_by_principal_id TEXT,
  assignee_principal_id TEXT,
  linked_node_ids JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(linked_node_ids) = 'array'),
  linked_task_ids JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(linked_task_ids) = 'array'),
  follow_target_id TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (project_id, condition_key),
  CHECK (
    lifecycle <> 'acknowledged'
    OR (acknowledged_at IS NOT NULL AND acknowledged_by_principal_id IS NOT NULL)
  ),
  CHECK (
    lifecycle <> 'suppressed'
    OR suppression_until IS NOT NULL
  ),
  CHECK (
    lifecycle <> 'resolved'
    OR (resolved_at IS NOT NULL AND resolved_by_principal_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS project_alerts_project_lifecycle_idx
  ON project_alerts(project_id, lifecycle, severity, updated_at DESC);

CREATE OR REPLACE FUNCTION pluginmax_assert_project_alert_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.project_id <> OLD.project_id
    OR NEW.condition_key <> OLD.condition_key
  THEN
    RAISE EXCEPTION 'project alert identity is immutable';
  END IF;
  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'project alert revision must advance by one';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS project_alerts_revision_guard ON project_alerts;
CREATE TRIGGER project_alerts_revision_guard
BEFORE UPDATE ON project_alerts
FOR EACH ROW
EXECUTE FUNCTION pluginmax_assert_project_alert_revision();

CREATE OR REPLACE FUNCTION pluginmax_reject_project_alert_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'project alerts must be resolved, not deleted';
END;
$$;

DROP TRIGGER IF EXISTS project_alerts_delete_guard ON project_alerts;
CREATE TRIGGER project_alerts_delete_guard
BEFORE DELETE ON project_alerts
FOR EACH ROW
EXECUTE FUNCTION pluginmax_reject_project_alert_delete();

CREATE TABLE IF NOT EXISTS project_alert_events (
  id UUID PRIMARY KEY,
  alert_id UUID NOT NULL REFERENCES project_alerts(id) ON DELETE RESTRICT,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  seq BIGINT NOT NULL CHECK (seq > 0),
  kind TEXT NOT NULL CHECK (kind IN (
    'alert.opened',
    'alert.observed',
    'alert.acknowledged',
    'alert.suppressed',
    'alert.assigned',
    'alert.resolved',
    'alert.reopened',
    'alert.severity_changed'
  )),
  actor_principal_id TEXT NOT NULL
    CHECK (length(btrim(actor_principal_id)) BETWEEN 1 AND 180),
  from_lifecycle TEXT
    CHECK (
      from_lifecycle IS NULL
      OR from_lifecycle IN ('open', 'acknowledged', 'suppressed', 'resolved')
    ),
  to_lifecycle TEXT
    CHECK (
      to_lifecycle IS NULL
      OR to_lifecycle IN ('open', 'acknowledged', 'suppressed', 'resolved')
    ),
  summary TEXT NOT NULL,
  data JSONB CHECK (data IS NULL OR jsonb_typeof(data) = 'object'),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (alert_id, seq)
);

CREATE INDEX IF NOT EXISTS project_alert_events_project_idx
  ON project_alert_events(project_id, created_at DESC, id);

CREATE OR REPLACE FUNCTION pluginmax_assign_project_alert_event_seq()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  SELECT COALESCE(MAX(seq), 0) + 1
  INTO NEW.seq
  FROM project_alert_events
  WHERE alert_id = NEW.alert_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS project_alert_events_seq_guard
  ON project_alert_events;
CREATE TRIGGER project_alert_events_seq_guard
BEFORE INSERT ON project_alert_events
FOR EACH ROW
EXECUTE FUNCTION pluginmax_assign_project_alert_event_seq();

CREATE OR REPLACE FUNCTION pluginmax_reject_project_alert_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'project alert events are append-only';
END;
$$;

DROP TRIGGER IF EXISTS project_alert_events_append_only
  ON project_alert_events;
CREATE TRIGGER project_alert_events_append_only
BEFORE UPDATE OR DELETE ON project_alert_events
FOR EACH ROW
EXECUTE FUNCTION pluginmax_reject_project_alert_event_mutation();

-- M11 enable state: project business-chain and mock source flags remain off.
`;

export const M12_MARKET_GOVERNANCE_SCHEMA_SQL = `
-- M12 expand: separate Market origin, sharing, publication and availability
-- from owner-scoped installation state. Existing Market columns remain
-- readable for N-1 applications for at least one release cycle.
INSERT INTO feature_flag_settings (
  flag_key, scope_type, scope_id, mode, revision, updated_by, updated_at
) VALUES
  ('market.governance_v2', 'platform', 'platform', 'off', 1,
   'system:migration', NOW()),
  ('market.shared_supply', 'platform', 'platform', 'off', 1,
   'system:migration', NOW())
ON CONFLICT (flag_key, scope_type, scope_id) DO NOTHING;

ALTER TABLE market_assets
  ALTER COLUMN trust_level SET DEFAULT 'private',
  ALTER COLUMN visibility SET DEFAULT 'private';

ALTER TABLE market_assets
  ADD COLUMN IF NOT EXISTS origin TEXT,
  ADD COLUMN IF NOT EXISTS sharing_scope TEXT,
  ADD COLUMN IF NOT EXISTS sharing_scope_id TEXT,
  ADD COLUMN IF NOT EXISTS publication_status TEXT,
  ADD COLUMN IF NOT EXISTS availability_status TEXT,
  ADD COLUMN IF NOT EXISTS admin_locked BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS admin_locked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS admin_locked_by_principal_id TEXT,
  ADD COLUMN IF NOT EXISTS admin_lock_reason TEXT,
  ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS delisted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS suspended_reason TEXT,
  ADD COLUMN IF NOT EXISTS publication_changed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS availability_changed_at TIMESTAMPTZ;

UPDATE market_assets
SET
  origin = CASE
    WHEN trust_level IN ('official', 'verified') THEN 'platform'
    ELSE 'user'
  END,
  sharing_scope = CASE visibility
    WHEN 'public' THEN 'platform'
    ELSE visibility
  END,
  sharing_scope_id = visibility_scope_id,
  publication_status = CASE status
    WHEN 'active' THEN 'published'
    WHEN 'delisted' THEN 'delisted'
    ELSE 'archived'
  END,
  availability_status = 'active',
  published_at = CASE
    WHEN status = 'active' THEN updated_at
    ELSE NULL
  END,
  delisted_at = CASE
    WHEN status = 'delisted' THEN updated_at
    ELSE NULL
  END,
  archived_at = CASE
    WHEN status = 'archived' THEN updated_at
    ELSE NULL
  END,
  publication_changed_at = updated_at,
  availability_changed_at = updated_at
WHERE origin IS NULL
   OR sharing_scope IS NULL
   OR publication_status IS NULL
   OR availability_status IS NULL;

ALTER TABLE market_assets
  DROP CONSTRAINT IF EXISTS market_assets_origin_check,
  DROP CONSTRAINT IF EXISTS market_assets_sharing_scope_check,
  DROP CONSTRAINT IF EXISTS market_assets_publication_status_check,
  DROP CONSTRAINT IF EXISTS market_assets_availability_status_check,
  DROP CONSTRAINT IF EXISTS market_assets_admin_lock_check,
  DROP CONSTRAINT IF EXISTS market_assets_governance_scope_check;

ALTER TABLE market_assets
  ADD CONSTRAINT market_assets_origin_check
    CHECK (origin IN ('platform', 'user')),
  ADD CONSTRAINT market_assets_sharing_scope_check
    CHECK (sharing_scope IN ('private', 'project', 'workspace', 'platform')),
  ADD CONSTRAINT market_assets_publication_status_check
    CHECK (publication_status IN ('draft', 'published', 'delisted', 'archived')),
  ADD CONSTRAINT market_assets_availability_status_check
    CHECK (availability_status IN ('active', 'suspended')),
  ADD CONSTRAINT market_assets_admin_lock_check
    CHECK (
      (
        NOT admin_locked
        AND admin_locked_at IS NULL
        AND admin_locked_by_principal_id IS NULL
        AND admin_lock_reason IS NULL
      )
      OR (
        admin_locked
        AND admin_locked_at IS NOT NULL
        AND admin_locked_by_principal_id IS NOT NULL
        AND length(btrim(admin_locked_by_principal_id)) BETWEEN 1 AND 180
        AND admin_lock_reason IS NOT NULL
        AND length(btrim(admin_lock_reason)) BETWEEN 1 AND 2000
      )
    ),
  ADD CONSTRAINT market_assets_governance_scope_check
    CHECK (
      origin IS NOT NULL
      AND sharing_scope IS NOT NULL
      AND publication_status IS NOT NULL
      AND availability_status IS NOT NULL
      AND publication_changed_at IS NOT NULL
      AND availability_changed_at IS NOT NULL
      AND (
        (sharing_scope IN ('project', 'workspace')
          AND sharing_scope_id IS NOT NULL
          AND length(btrim(sharing_scope_id)) BETWEEN 1 AND 180)
        OR
        (sharing_scope IN ('private', 'platform')
          AND sharing_scope_id IS NULL)
      )
    );

CREATE INDEX IF NOT EXISTS market_assets_governance_catalog_idx
  ON market_assets(
    publication_status,
    availability_status,
    sharing_scope,
    kind,
    updated_at DESC
  );

CREATE INDEX IF NOT EXISTS market_assets_owner_governance_idx
  ON market_assets(publisher_principal_id, publication_status, updated_at DESC);

CREATE OR REPLACE FUNCTION pluginmax_market_legacy_publication_status(
  publication TEXT,
  availability TEXT
)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN publication = 'archived' THEN 'archived'
    WHEN publication = 'published' AND availability = 'active' THEN 'active'
    ELSE 'delisted'
  END;
$$;

CREATE OR REPLACE FUNCTION pluginmax_sync_market_asset_governance_projection()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  legacy_changed BOOLEAN := FALSE;
  governance_changed BOOLEAN := FALSE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.origin IS NULL
      OR NEW.sharing_scope IS NULL
      OR NEW.publication_status IS NULL
      OR NEW.availability_status IS NULL
    THEN
      NEW.origin := CASE
        WHEN NEW.trust_level IN ('official', 'verified') THEN 'platform'
        ELSE 'user'
      END;
      NEW.sharing_scope := CASE NEW.visibility
        WHEN 'public' THEN 'platform'
        ELSE NEW.visibility
      END;
      NEW.sharing_scope_id := NEW.visibility_scope_id;
      NEW.publication_status := CASE NEW.status
        WHEN 'active' THEN 'published'
        WHEN 'delisted' THEN 'delisted'
        ELSE 'archived'
      END;
      NEW.availability_status := 'active';
    ELSE
      NEW.visibility := CASE NEW.sharing_scope
        WHEN 'platform' THEN 'public'
        ELSE NEW.sharing_scope
      END;
      NEW.visibility_scope_id := CASE
        WHEN NEW.sharing_scope IN ('project', 'workspace')
          THEN NEW.sharing_scope_id
        ELSE NULL
      END;
      NEW.status := pluginmax_market_legacy_publication_status(
        NEW.publication_status,
        NEW.availability_status
      );
      NEW.trust_level := CASE NEW.origin
        WHEN 'platform' THEN 'official'
        ELSE 'private'
      END;
    END IF;
    NEW.publication_changed_at := COALESCE(
      NEW.publication_changed_at,
      NEW.updated_at,
      NOW()
    );
    NEW.availability_changed_at := COALESCE(
      NEW.availability_changed_at,
      NEW.updated_at,
      NOW()
    );
    IF NEW.publication_status = 'published' THEN
      NEW.published_at := COALESCE(NEW.published_at, NOW());
    ELSIF NEW.publication_status = 'delisted' THEN
      NEW.delisted_at := COALESCE(NEW.delisted_at, NOW());
    ELSIF NEW.publication_status = 'archived' THEN
      NEW.archived_at := COALESCE(NEW.archived_at, NOW());
    END IF;
    IF NEW.availability_status = 'suspended' THEN
      NEW.suspended_at := COALESCE(NEW.suspended_at, NOW());
    END IF;
    RETURN NEW;
  END IF;

  legacy_changed :=
    NEW.visibility IS DISTINCT FROM OLD.visibility
    OR NEW.visibility_scope_id IS DISTINCT FROM OLD.visibility_scope_id
    OR NEW.status IS DISTINCT FROM OLD.status
    OR NEW.trust_level IS DISTINCT FROM OLD.trust_level;
  governance_changed :=
    NEW.origin IS DISTINCT FROM OLD.origin
    OR NEW.sharing_scope IS DISTINCT FROM OLD.sharing_scope
    OR NEW.sharing_scope_id IS DISTINCT FROM OLD.sharing_scope_id
    OR NEW.publication_status IS DISTINCT FROM OLD.publication_status
    OR NEW.availability_status IS DISTINCT FROM OLD.availability_status;

  IF legacy_changed AND NOT governance_changed THEN
    NEW.origin := CASE
      WHEN NEW.trust_level IN ('official', 'verified') THEN 'platform'
      ELSE 'user'
    END;
    NEW.sharing_scope := CASE NEW.visibility
      WHEN 'public' THEN 'platform'
      ELSE NEW.visibility
    END;
    NEW.sharing_scope_id := NEW.visibility_scope_id;
    NEW.publication_status := CASE NEW.status
      WHEN 'active' THEN 'published'
      WHEN 'delisted' THEN 'delisted'
      ELSE 'archived'
    END;
    IF NEW.status = 'active' AND OLD.availability_status = 'suspended' THEN
      NEW.availability_status := 'suspended';
    ELSE
      NEW.availability_status := 'active';
    END IF;
  ELSIF governance_changed AND NOT legacy_changed THEN
    NEW.visibility := CASE NEW.sharing_scope
      WHEN 'platform' THEN 'public'
      ELSE NEW.sharing_scope
    END;
    NEW.visibility_scope_id := CASE
      WHEN NEW.sharing_scope IN ('project', 'workspace')
        THEN NEW.sharing_scope_id
      ELSE NULL
    END;
    NEW.status := pluginmax_market_legacy_publication_status(
      NEW.publication_status,
      NEW.availability_status
    );
    NEW.trust_level := CASE
      WHEN NEW.origin = 'platform' AND OLD.trust_level = 'verified'
        THEN 'verified'
      WHEN NEW.origin = 'platform' THEN 'official'
      ELSE 'private'
    END;
  ELSIF legacy_changed AND governance_changed THEN
    IF NEW.visibility IS DISTINCT FROM (
        CASE
          WHEN NEW.sharing_scope = 'platform' THEN 'public'
          ELSE NEW.sharing_scope
        END
      )
      OR NEW.status IS DISTINCT FROM (
        pluginmax_market_legacy_publication_status(
          NEW.publication_status,
          NEW.availability_status
        )
      )
    THEN
      RAISE EXCEPTION 'conflicting Market legacy and governance projections';
    END IF;
  END IF;

  IF NEW.publication_status IS DISTINCT FROM OLD.publication_status THEN
    NEW.publication_changed_at := NOW();
    IF NEW.publication_status = 'published' THEN
      NEW.published_at := NOW();
    ELSIF NEW.publication_status = 'delisted' THEN
      NEW.delisted_at := NOW();
    ELSIF NEW.publication_status = 'archived' THEN
      NEW.archived_at := NOW();
    END IF;
  END IF;
  IF NEW.availability_status IS DISTINCT FROM OLD.availability_status THEN
    NEW.availability_changed_at := NOW();
    IF NEW.availability_status = 'suspended' THEN
      NEW.suspended_at := NOW();
    ELSE
      NEW.suspended_at := NULL;
      NEW.suspended_reason := NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS market_assets_governance_projection
  ON market_assets;
CREATE TRIGGER market_assets_governance_projection
BEFORE INSERT OR UPDATE OF
  origin, sharing_scope, sharing_scope_id, publication_status,
  availability_status, visibility, visibility_scope_id, status, trust_level
ON market_assets
FOR EACH ROW
EXECUTE FUNCTION pluginmax_sync_market_asset_governance_projection();

CREATE TABLE IF NOT EXISTS market_governance_audit_events (
  id UUID PRIMARY KEY,
  asset_id UUID NOT NULL
    REFERENCES market_assets(id) ON DELETE RESTRICT,
  seq BIGINT NOT NULL CHECK (seq > 0),
  action TEXT NOT NULL
    CHECK (length(btrim(action)) BETWEEN 1 AND 120),
  actor_principal_id TEXT NOT NULL
    CHECK (length(btrim(actor_principal_id)) BETWEEN 1 AND 180),
  actor_role TEXT NOT NULL
    CHECK (actor_role IN ('owner', 'platform-admin', 'system')),
  reason TEXT NOT NULL DEFAULT '' CHECK (length(reason) <= 2000),
  from_state JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(from_state) = 'object'),
  to_state JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(to_state) = 'object'),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (asset_id, seq)
);

CREATE INDEX IF NOT EXISTS market_governance_audit_asset_idx
  ON market_governance_audit_events(asset_id, seq DESC);

CREATE OR REPLACE FUNCTION pluginmax_reject_market_governance_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Market governance audit is append-only';
END;
$$;

DROP TRIGGER IF EXISTS market_governance_audit_append_only
  ON market_governance_audit_events;
CREATE TRIGGER market_governance_audit_append_only
BEFORE UPDATE OR DELETE ON market_governance_audit_events
FOR EACH ROW
EXECUTE FUNCTION pluginmax_reject_market_governance_audit_mutation();

CREATE TABLE IF NOT EXISTS market_asset_resource_bindings (
  id UUID PRIMARY KEY,
  asset_id UUID NOT NULL
    REFERENCES market_assets(id) ON DELETE RESTRICT,
  asset_version_id UUID NOT NULL
    REFERENCES market_asset_versions(id) ON DELETE RESTRICT,
  resource_kind TEXT NOT NULL CHECK (resource_kind IN (
    'skill_version',
    'mcp_provider',
    'workflow_template_version',
    'workbench_template_version',
    'trusted_panel'
  )),
  resource_id TEXT NOT NULL
    CHECK (length(btrim(resource_id)) BETWEEN 1 AND 180),
  resource_version_id TEXT
    CHECK (
      resource_version_id IS NULL
      OR length(btrim(resource_version_id)) BETWEEN 1 AND 180
    ),
  created_by_principal_id TEXT NOT NULL
    CHECK (length(btrim(created_by_principal_id)) BETWEEN 1 AND 180),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (
    asset_version_id,
    resource_kind,
    resource_id,
    resource_version_id
  )
);

CREATE INDEX IF NOT EXISTS market_asset_resource_bindings_asset_idx
  ON market_asset_resource_bindings(asset_id, asset_version_id);

CREATE INDEX IF NOT EXISTS market_asset_resource_bindings_resource_idx
  ON market_asset_resource_bindings(
    resource_kind,
    resource_id,
    resource_version_id
  );

CREATE OR REPLACE FUNCTION pluginmax_validate_market_resource_binding()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  version_asset UUID;
  panel_version TEXT;
  resource_exists BOOLEAN := FALSE;
BEGIN
  SELECT asset_id INTO version_asset
  FROM market_asset_versions
  WHERE id = NEW.asset_version_id;
  IF version_asset IS NULL OR version_asset <> NEW.asset_id THEN
    RAISE EXCEPTION 'Market resource binding asset version mismatch';
  END IF;

  IF NEW.resource_kind = 'skill_version' THEN
    IF NEW.resource_version_id IS NULL THEN
      RAISE EXCEPTION 'Skill resource binding requires a version id';
    END IF;
    SELECT EXISTS (
      SELECT 1
      FROM skill_versions AS version
      JOIN skill_definitions AS definition
        ON definition.id = version.skill_id
      WHERE definition.id::text = NEW.resource_id
        AND version.id::text = NEW.resource_version_id
    ) INTO resource_exists;
  ELSIF NEW.resource_kind = 'workflow_template_version' THEN
    SELECT EXISTS (
      SELECT 1
      FROM workflow_templates
      WHERE id::text = NEW.resource_id
        AND (
          NEW.resource_version_id IS NULL
          OR NEW.resource_version_id = id::text
          OR NEW.resource_version_id = version::text
        )
    ) INTO resource_exists;
  ELSIF NEW.resource_kind = 'workbench_template_version' THEN
    SELECT EXISTS (
      SELECT 1
      FROM market_templates AS template
      JOIN market_asset_versions AS version
        ON version.asset_id = template.asset_id
       AND version.version = template.current_version
      WHERE template.id::text = NEW.resource_id
        AND (
          NEW.resource_version_id IS NULL
          OR NEW.resource_version_id = version.id::text
        )
    ) INTO resource_exists;
  ELSIF NEW.resource_kind = 'trusted_panel' THEN
    SELECT version, TRUE
    INTO panel_version, resource_exists
    FROM workbench_panels
    WHERE plugin_id = NEW.resource_id;
    IF resource_exists AND NEW.resource_version_id IS NULL THEN
      NEW.resource_version_id := panel_version;
    END IF;
    IF resource_exists
      AND NEW.resource_version_id IS NOT NULL
      AND NEW.resource_version_id <> panel_version
    THEN
      resource_exists := FALSE;
    END IF;
  ELSIF NEW.resource_kind = 'mcp_provider' THEN
    -- M12 binds to an existing MCP catalogue identity. Provider connection,
    -- health checks and Tool invocation remain M13 responsibilities.
    SELECT EXISTS (
      SELECT 1
      FROM market_assets AS asset
      JOIN market_asset_versions AS version
        ON version.asset_id = asset.id
       AND version.version = asset.current_version
       AND version.status = 'published'
      WHERE asset.kind = 'mcp'
        AND asset.publication_status = 'published'
        AND asset.availability_status = 'active'
        AND (
          asset.id::text = NEW.resource_id
          OR asset.asset_key = NEW.resource_id
        )
        AND (
          NEW.resource_version_id IS NULL
          OR NEW.resource_version_id = version.id::text
          OR NEW.resource_version_id = version.version::text
        )
    ) INTO resource_exists;
  ELSE
    resource_exists := FALSE;
  END IF;

  IF NOT resource_exists THEN
    RAISE EXCEPTION 'Market resource binding target does not exist';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS market_asset_resource_bindings_guard
  ON market_asset_resource_bindings;
CREATE TRIGGER market_asset_resource_bindings_guard
BEFORE INSERT OR UPDATE ON market_asset_resource_bindings
FOR EACH ROW
EXECUTE FUNCTION pluginmax_validate_market_resource_binding();

CREATE OR REPLACE FUNCTION pluginmax_reject_market_resource_binding_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Market resource bindings are immutable';
END;
$$;

DROP TRIGGER IF EXISTS market_asset_resource_bindings_immutable
  ON market_asset_resource_bindings;
CREATE TRIGGER market_asset_resource_bindings_immutable
BEFORE UPDATE OR DELETE ON market_asset_resource_bindings
FOR EACH ROW
EXECUTE FUNCTION pluginmax_reject_market_resource_binding_mutation();

-- Backfill only bindings whose platform resource identity is already proven.
INSERT INTO market_asset_resource_bindings (
  id, asset_id, asset_version_id, resource_kind, resource_id,
  resource_version_id, created_by_principal_id, created_at
)
SELECT
  gen_random_uuid(),
  asset.id,
  version.id,
  'trusted_panel',
  panel.plugin_id,
  panel.version,
  'system:migration',
  NOW()
FROM market_assets AS asset
JOIN market_asset_versions AS version
  ON version.asset_id = asset.id
 AND version.version = asset.current_version
JOIN workbench_panels AS panel
  ON panel.plugin_id = version.manifest ->> 'panelPluginId'
WHERE asset.kind = 'panel'
ON CONFLICT DO NOTHING;

INSERT INTO market_asset_resource_bindings (
  id, asset_id, asset_version_id, resource_kind, resource_id,
  resource_version_id, created_by_principal_id, created_at
)
SELECT
  gen_random_uuid(),
  asset.id,
  version.id,
  'workbench_template_version',
  template.id::text,
  version.id::text,
  'system:migration',
  NOW()
FROM market_assets AS asset
JOIN market_asset_versions AS version
  ON version.asset_id = asset.id
 AND version.version = asset.current_version
JOIN market_templates AS template
  ON template.asset_id = asset.id
WHERE asset.kind = 'workbench-template'
ON CONFLICT DO NOTHING;

-- M12 enable state: governance and shared supply remain off until the M12
-- observation gate and explicit release activation.
`;

export const M13A_MCP_PROVIDER_CONTROL_PLANE_SCHEMA_SQL = `
-- M13a adds the MCP Provider control plane. Provider connections remain
-- server-side facts; Market can reference identity only.
INSERT INTO feature_flag_settings (
  flag_key, scope_type, scope_id, mode, revision, updated_by, updated_at
) VALUES (
  'mcp.provider_control_plane', 'platform', 'platform', 'off', 1,
  'system:migration', NOW()
)
ON CONFLICT (flag_key, scope_type, scope_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS mcp_providers (
  id UUID PRIMARY KEY,
  provider_key TEXT NOT NULL UNIQUE
    CHECK (provider_key ~ '^[a-z0-9][a-z0-9._-]{1,119}$'),
  owner_principal_id TEXT NOT NULL
    REFERENCES principals(id) ON DELETE RESTRICT
    CHECK (length(btrim(owner_principal_id)) BETWEEN 1 AND 180),
  name TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 160),
  description TEXT NOT NULL DEFAULT ''
    CHECK (length(description) <= 2000),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'active', 'disabled', 'archived')),
  current_version INTEGER NOT NULL CHECK (current_version > 0),
  current_version_id UUID NOT NULL,
  health_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (health_status IN ('unknown', 'probing', 'healthy', 'unhealthy')),
  health_checked_at TIMESTAMPTZ,
  health_version_id UUID,
  discovery_status TEXT NOT NULL DEFAULT 'not_discovered'
    CHECK (
      discovery_status IN (
        'not_discovered', 'discovering', 'ready', 'failed'
      )
    ),
  tool_count INTEGER NOT NULL DEFAULT 0 CHECK (tool_count >= 0),
  last_error_category TEXT
    CHECK (
      last_error_category IS NULL
      OR last_error_category IN (
        'timeout', 'dns', 'tls', 'authentication', 'authorization',
        'http_status', 'protocol', 'schema', 'network', 'credential',
        'unknown'
      )
    ),
  last_error_code TEXT
    CHECK (
      last_error_code IS NULL
      OR length(btrim(last_error_code)) BETWEEN 1 AND 160
    ),
  last_error_message TEXT
    CHECK (
      last_error_message IS NULL
      OR length(last_error_message) <= 2000
    ),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (
    health_version_id IS NULL
    OR health_version_id = current_version_id
  )
);

CREATE INDEX IF NOT EXISTS mcp_providers_owner_idx
  ON mcp_providers(owner_principal_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS mcp_providers_health_idx
  ON mcp_providers(status, health_status, updated_at DESC);

CREATE TABLE IF NOT EXISTS mcp_provider_versions (
  id UUID PRIMARY KEY,
  provider_id UUID NOT NULL
    REFERENCES mcp_providers(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version > 0),
  transport TEXT NOT NULL
    CHECK (transport IN ('streamable-http')),
  endpoint_url TEXT NOT NULL
    CHECK (
      length(btrim(endpoint_url)) BETWEEN 1 AND 2000
      AND endpoint_url ~ '^https?://'
    ),
  auth_kind TEXT NOT NULL
    CHECK (auth_kind IN ('none', 'bearer', 'header')),
  credential_ref TEXT
    CHECK (
      credential_ref IS NULL
      OR (
        length(credential_ref) BETWEEN 9 AND 500
        AND credential_ref ~ '^(env|secret)://[A-Za-z0-9][A-Za-z0-9._:/-]*$'
      )
    ),
  credential_header_name TEXT
    CHECK (
      credential_header_name IS NULL
      OR (
        length(credential_header_name) BETWEEN 1 AND 120
        AND credential_header_name ~ '^[A-Za-z0-9-]+$'
      )
    ),
  request_timeout_ms INTEGER NOT NULL
    CHECK (request_timeout_ms BETWEEN 1000 AND 30000),
  config_digest TEXT NOT NULL CHECK (config_digest ~ '^[a-f0-9]{64}$'),
  created_by_principal_id TEXT NOT NULL
    CHECK (length(btrim(created_by_principal_id)) BETWEEN 1 AND 180),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (provider_id, version),
  CHECK (
    (auth_kind = 'none'
      AND credential_ref IS NULL
      AND credential_header_name IS NULL)
    OR
    (auth_kind = 'bearer'
      AND credential_ref IS NOT NULL
      AND credential_header_name IS NULL)
    OR
    (auth_kind = 'header'
      AND credential_ref IS NOT NULL
      AND credential_header_name IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS mcp_provider_versions_provider_idx
  ON mcp_provider_versions(provider_id, version DESC);

CREATE TABLE IF NOT EXISTS mcp_provider_probes (
  id UUID PRIMARY KEY,
  provider_id UUID NOT NULL
    REFERENCES mcp_providers(id) ON DELETE RESTRICT,
  provider_version_id UUID NOT NULL
    REFERENCES mcp_provider_versions(id) ON DELETE RESTRICT,
  status TEXT NOT NULL
    CHECK (status IN ('queued', 'running', 'passed', 'failed')),
  trigger_source TEXT NOT NULL
    CHECK (trigger_source IN ('owner', 'admin', 'system')),
  requested_by_principal_id TEXT NOT NULL
    CHECK (length(btrim(requested_by_principal_id)) BETWEEN 1 AND 180),
  error_category TEXT
    CHECK (
      error_category IS NULL
      OR error_category IN (
        'timeout', 'dns', 'tls', 'authentication', 'authorization',
        'http_status', 'protocol', 'schema', 'network', 'credential',
        'unknown'
      )
    ),
  error_code TEXT
    CHECK (
      error_code IS NULL
      OR length(btrim(error_code)) BETWEEN 1 AND 160
    ),
  error_message TEXT
    CHECK (error_message IS NULL OR length(error_message) <= 2000),
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  tool_count INTEGER CHECK (tool_count IS NULL OR tool_count >= 0),
  lease_owner TEXT,
  lease_token UUID,
  lease_expires_at TIMESTAMPTZ,
  requested_at TIMESTAMPTZ NOT NULL,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  CHECK (
    status NOT IN ('running', 'passed', 'failed')
    OR (started_at IS NOT NULL AND lease_owner IS NOT NULL
        AND lease_token IS NOT NULL)
  ),
  CHECK (
    status NOT IN ('passed', 'failed')
    OR completed_at IS NOT NULL
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS mcp_provider_probes_active_idx
  ON mcp_provider_probes(provider_id)
  WHERE status IN ('queued', 'running');

CREATE INDEX IF NOT EXISTS mcp_provider_probes_provider_idx
  ON mcp_provider_probes(provider_id, requested_at DESC);

CREATE INDEX IF NOT EXISTS mcp_provider_probes_claim_idx
  ON mcp_provider_probes(status, lease_expires_at, requested_at);

CREATE TABLE IF NOT EXISTS mcp_provider_tools (
  id UUID PRIMARY KEY,
  provider_id UUID NOT NULL
    REFERENCES mcp_providers(id) ON DELETE RESTRICT,
  provider_version_id UUID NOT NULL
    REFERENCES mcp_provider_versions(id) ON DELETE RESTRICT,
  probe_id UUID NOT NULL
    REFERENCES mcp_provider_probes(id) ON DELETE RESTRICT,
  tool_name TEXT NOT NULL CHECK (length(btrim(tool_name)) BETWEEN 1 AND 240),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 4000),
  input_schema JSONB NOT NULL
    CHECK (jsonb_typeof(input_schema) = 'object'),
  output_schema JSONB
    CHECK (output_schema IS NULL OR jsonb_typeof(output_schema) = 'object'),
  schema_digest TEXT NOT NULL CHECK (schema_digest ~ '^[a-f0-9]{64}$'),
  discovered_at TIMESTAMPTZ NOT NULL,
  UNIQUE (probe_id, tool_name)
);

CREATE INDEX IF NOT EXISTS mcp_provider_tools_version_idx
  ON mcp_provider_tools(provider_version_id, discovered_at DESC);

CREATE TABLE IF NOT EXISTS mcp_provider_audit_events (
  id UUID PRIMARY KEY,
  provider_id UUID NOT NULL
    REFERENCES mcp_providers(id) ON DELETE RESTRICT,
  seq BIGINT NOT NULL CHECK (seq > 0),
  action TEXT NOT NULL CHECK (length(btrim(action)) BETWEEN 1 AND 120),
  actor_principal_id TEXT NOT NULL
    CHECK (length(btrim(actor_principal_id)) BETWEEN 1 AND 180),
  actor_role TEXT NOT NULL
    CHECK (actor_role IN ('owner', 'platform-admin', 'system')),
  reason TEXT NOT NULL DEFAULT '' CHECK (length(reason) <= 2000),
  from_state JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(from_state) = 'object'),
  to_state JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(to_state) = 'object'),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (provider_id, seq)
);

CREATE INDEX IF NOT EXISTS mcp_provider_audit_provider_idx
  ON mcp_provider_audit_events(provider_id, seq DESC);

CREATE OR REPLACE FUNCTION pluginmax_assert_mcp_provider_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.revision <> 1 OR NEW.current_version <> 1 THEN
      RAISE EXCEPTION 'MCP Provider must start at revision and version one';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.provider_key <> OLD.provider_key
    OR NEW.owner_principal_id <> OLD.owner_principal_id
  THEN
    RAISE EXCEPTION 'MCP Provider identity is immutable';
  END IF;
  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'MCP Provider revision must advance by one';
  END IF;
  IF NEW.current_version < OLD.current_version THEN
    RAISE EXCEPTION 'MCP Provider version cannot move backwards';
  END IF;
  IF NEW.status <> OLD.status
    AND NOT (
      (OLD.status = 'draft' AND NEW.status IN ('active', 'disabled', 'archived'))
      OR (OLD.status = 'active' AND NEW.status IN ('draft', 'disabled', 'archived'))
      OR (OLD.status = 'disabled' AND NEW.status IN ('active', 'archived'))
    )
  THEN
    RAISE EXCEPTION 'invalid MCP Provider status transition';
  END IF;
  IF NEW.status = 'active' AND OLD.status <> 'active' THEN
    IF NEW.health_status <> 'healthy'
      OR NEW.discovery_status <> 'ready'
      OR NEW.health_version_id IS DISTINCT FROM NEW.current_version_id
    THEN
      RAISE EXCEPTION 'MCP Provider activation requires a healthy current version';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS mcp_providers_mutation_guard ON mcp_providers;
CREATE TRIGGER mcp_providers_mutation_guard
BEFORE INSERT OR UPDATE ON mcp_providers
FOR EACH ROW
EXECUTE FUNCTION pluginmax_assert_mcp_provider_mutation();

CREATE OR REPLACE FUNCTION pluginmax_reject_mcp_provider_version_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'MCP Provider versions are immutable';
END;
$$;

DROP TRIGGER IF EXISTS mcp_provider_versions_immutable
  ON mcp_provider_versions;
CREATE TRIGGER mcp_provider_versions_immutable
BEFORE UPDATE OR DELETE ON mcp_provider_versions
FOR EACH ROW
EXECUTE FUNCTION pluginmax_reject_mcp_provider_version_mutation();

CREATE OR REPLACE FUNCTION pluginmax_reject_mcp_provider_tool_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'MCP Provider tool schemas are immutable';
END;
$$;

DROP TRIGGER IF EXISTS mcp_provider_tools_immutable ON mcp_provider_tools;
CREATE TRIGGER mcp_provider_tools_immutable
BEFORE UPDATE OR DELETE ON mcp_provider_tools
FOR EACH ROW
EXECUTE FUNCTION pluginmax_reject_mcp_provider_tool_mutation();

CREATE OR REPLACE FUNCTION pluginmax_assign_mcp_provider_audit_seq()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  SELECT COALESCE(MAX(seq), 0) + 1
  INTO NEW.seq
  FROM mcp_provider_audit_events
  WHERE provider_id = NEW.provider_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS mcp_provider_audit_seq_guard
  ON mcp_provider_audit_events;
CREATE TRIGGER mcp_provider_audit_seq_guard
BEFORE INSERT ON mcp_provider_audit_events
FOR EACH ROW
EXECUTE FUNCTION pluginmax_assign_mcp_provider_audit_seq();

CREATE OR REPLACE FUNCTION pluginmax_reject_mcp_provider_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'MCP Provider audit is append-only';
END;
$$;

DROP TRIGGER IF EXISTS mcp_provider_audit_append_only
  ON mcp_provider_audit_events;
CREATE TRIGGER mcp_provider_audit_append_only
BEFORE UPDATE OR DELETE ON mcp_provider_audit_events
FOR EACH ROW
EXECUTE FUNCTION pluginmax_reject_mcp_provider_audit_mutation();

-- Migration 49 extends the M12 binding resolver with a Provider identity
-- branch. The existing MCP Catalogue branch remains byte-for-byte compatible.
CREATE OR REPLACE FUNCTION pluginmax_validate_market_resource_binding()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  version_asset UUID;
  panel_version TEXT;
  resource_exists BOOLEAN := FALSE;
BEGIN
  SELECT asset_id INTO version_asset
  FROM market_asset_versions
  WHERE id = NEW.asset_version_id;
  IF version_asset IS NULL OR version_asset <> NEW.asset_id THEN
    RAISE EXCEPTION 'Market resource binding asset version mismatch';
  END IF;

  IF NEW.resource_kind = 'skill_version' THEN
    IF NEW.resource_version_id IS NULL THEN
      RAISE EXCEPTION 'Skill resource binding requires a version id';
    END IF;
    SELECT EXISTS (
      SELECT 1
      FROM skill_versions AS version
      JOIN skill_definitions AS definition
        ON definition.id = version.skill_id
      WHERE definition.id::text = NEW.resource_id
        AND version.id::text = NEW.resource_version_id
    ) INTO resource_exists;
  ELSIF NEW.resource_kind = 'workflow_template_version' THEN
    SELECT EXISTS (
      SELECT 1
      FROM workflow_templates
      WHERE id::text = NEW.resource_id
        AND (
          NEW.resource_version_id IS NULL
          OR NEW.resource_version_id = id::text
          OR NEW.resource_version_id = version::text
        )
    ) INTO resource_exists;
  ELSIF NEW.resource_kind = 'workbench_template_version' THEN
    SELECT EXISTS (
      SELECT 1
      FROM market_templates AS template
      JOIN market_asset_versions AS version
        ON version.asset_id = template.asset_id
       AND version.version = template.current_version
      WHERE template.id::text = NEW.resource_id
        AND (
          NEW.resource_version_id IS NULL
          OR NEW.resource_version_id = version.id::text
        )
    ) INTO resource_exists;
  ELSIF NEW.resource_kind = 'trusted_panel' THEN
    SELECT version, TRUE
    INTO panel_version, resource_exists
    FROM workbench_panels
    WHERE plugin_id = NEW.resource_id;
    IF resource_exists AND NEW.resource_version_id IS NULL THEN
      NEW.resource_version_id := panel_version;
    END IF;
    IF resource_exists
      AND NEW.resource_version_id IS NOT NULL
      AND NEW.resource_version_id <> panel_version
    THEN
      resource_exists := FALSE;
    END IF;
  ELSIF NEW.resource_kind = 'mcp_provider' THEN
    -- M13a binds a Market entry to the Provider control-plane identity.
    -- Legacy M12 bindings to MCP Catalogue identities remain accepted.
    SELECT EXISTS (
      SELECT 1
      FROM mcp_providers AS provider
      JOIN mcp_provider_versions AS version
        ON version.id = provider.current_version_id
       AND version.provider_id = provider.id
      WHERE provider.status = 'active'
        AND (
          provider.id::text = NEW.resource_id
          OR provider.provider_key = NEW.resource_id
        )
        AND (
          NEW.resource_version_id IS NULL
          OR NEW.resource_version_id = version.id::text
          OR NEW.resource_version_id = version.version::text
        )
    ) INTO resource_exists;
    IF NOT resource_exists THEN
      SELECT EXISTS (
        SELECT 1
        FROM market_assets AS asset
        JOIN market_asset_versions AS version
          ON version.asset_id = asset.id
         AND version.version = asset.current_version
         AND version.status = 'published'
        WHERE asset.kind = 'mcp'
          AND asset.publication_status = 'published'
          AND asset.availability_status = 'active'
          AND (
            asset.id::text = NEW.resource_id
            OR asset.asset_key = NEW.resource_id
          )
          AND (
            NEW.resource_version_id IS NULL
            OR NEW.resource_version_id = version.id::text
            OR NEW.resource_version_id = version.version::text
          )
      ) INTO resource_exists;
    END IF;
  ELSE
    resource_exists := FALSE;
  END IF;

  IF NOT resource_exists THEN
    RAISE EXCEPTION 'Market resource binding target does not exist';
  END IF;
  RETURN NEW;
END;
$$;

-- M13a enable state: the MCP Provider control plane remains off until the
-- observation gate and explicit release activation.
`;

export const M13B_MCP_TOOL_INVOCATION_SCHEMA_SQL = `
-- M13b adds server-side MCP Tool execution and durable receipts. The public
-- browser surface remains read-only; only Workers can call a Provider.
INSERT INTO feature_flag_settings (
  flag_key, scope_type, scope_id, mode, revision, updated_by, updated_at
) VALUES (
  'mcp.tool_invocation', 'platform', 'platform', 'off', 1,
  'system:migration', NOW()
)
ON CONFLICT (flag_key, scope_type, scope_id) DO NOTHING;

ALTER TABLE mcp_provider_tools
  ADD COLUMN IF NOT EXISTS tool_key TEXT;

-- Existing M13a rows predate the stable key. The immutability trigger is
-- restored immediately after this one-time backfill.
ALTER TABLE mcp_provider_tools
  DISABLE TRIGGER mcp_provider_tools_immutable;

UPDATE mcp_provider_tools
SET tool_key =
  md5(
    provider_id::text || ':' || provider_version_id::text || ':' ||
    tool_name || ':' || schema_digest
  ) ||
  md5(
    'm13b:' || provider_id::text || ':' || provider_version_id::text ||
    ':' || tool_name || ':' || schema_digest
  )
WHERE tool_key IS NULL;

ALTER TABLE mcp_provider_tools
  ENABLE TRIGGER mcp_provider_tools_immutable;

ALTER TABLE mcp_provider_tools
  ALTER COLUMN tool_key SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS mcp_provider_tools_key_idx
  ON mcp_provider_tools(tool_key);

CREATE OR REPLACE FUNCTION pluginmax_assign_mcp_provider_tool_key()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.tool_key IS NULL THEN
    NEW.tool_key :=
      md5(
        NEW.provider_id::text || ':' || NEW.provider_version_id::text ||
        ':' || NEW.tool_name || ':' || NEW.schema_digest
      ) ||
      md5(
        'm13b:' || NEW.provider_id::text || ':' ||
        NEW.provider_version_id::text || ':' || NEW.tool_name || ':' ||
        NEW.schema_digest
      );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS mcp_provider_tools_key_guard
  ON mcp_provider_tools;
CREATE TRIGGER mcp_provider_tools_key_guard
BEFORE INSERT ON mcp_provider_tools
FOR EACH ROW
EXECUTE FUNCTION pluginmax_assign_mcp_provider_tool_key();

CREATE TABLE IF NOT EXISTS mcp_tool_calls (
  id UUID PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
  run_attempt INTEGER NOT NULL CHECK (run_attempt > 0),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  agent_principal_id TEXT
    CHECK (
      agent_principal_id IS NULL
      OR length(btrim(agent_principal_id)) BETWEEN 1 AND 180
    ),
  provider_id UUID NOT NULL
    REFERENCES mcp_providers(id) ON DELETE RESTRICT,
  provider_key TEXT NOT NULL
    CHECK (length(btrim(provider_key)) BETWEEN 2 AND 120),
  provider_version_id UUID NOT NULL
    REFERENCES mcp_provider_versions(id) ON DELETE RESTRICT,
  provider_version INTEGER NOT NULL CHECK (provider_version > 0),
  provider_revision INTEGER NOT NULL CHECK (provider_revision > 0),
  tool_catalog_id UUID NOT NULL
    REFERENCES mcp_provider_tools(id) ON DELETE RESTRICT,
  tool_key TEXT NOT NULL CHECK (tool_key ~ '^[a-f0-9]{64}$'),
  tool_name TEXT NOT NULL CHECK (length(btrim(tool_name)) BETWEEN 1 AND 240),
  tool_schema_digest TEXT NOT NULL
    CHECK (tool_schema_digest ~ '^[a-f0-9]{64}$'),
  ticket_id UUID NOT NULL
    REFERENCES action_tickets(id) ON DELETE RESTRICT,
  gate_id UUID NOT NULL UNIQUE
    REFERENCES execution_gate_requests(gate_id) ON DELETE RESTRICT,
  policy_id UUID REFERENCES task_execution_policies(id),
  policy_revision INTEGER NOT NULL CHECK (policy_revision >= 0),
  envelope_id TEXT NOT NULL
    CHECK (length(btrim(envelope_id)) BETWEEN 1 AND 180),
  envelope_digest TEXT NOT NULL
    CHECK (envelope_digest ~ '^[a-f0-9]{64}$'),
  idempotency_key TEXT NOT NULL
    CHECK (length(btrim(idempotency_key)) BETWEEN 8 AND 240),
  request_digest TEXT NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (
      status IN (
        'running', 'succeeded', 'failed', 'timed_out', 'cancelled',
        'interrupted'
      )
    ),
  input_summary JSONB NOT NULL
    CHECK (jsonb_typeof(input_summary) = 'object'),
  output_summary JSONB
    CHECK (
      output_summary IS NULL OR jsonb_typeof(output_summary) = 'object'
    ),
  output_digest TEXT
    CHECK (output_digest IS NULL OR output_digest ~ '^[a-f0-9]{64}$'),
  error_category TEXT
    CHECK (
      error_category IS NULL
      OR error_category IN (
        'timeout', 'cancelled', 'dns', 'tls', 'authentication',
        'authorization', 'http_status', 'protocol', 'schema', 'tool',
        'network', 'credential', 'unknown'
      )
    ),
  error_code TEXT
    CHECK (
      error_code IS NULL
      OR length(btrim(error_code)) BETWEEN 1 AND 160
    ),
  error_message TEXT
    CHECK (error_message IS NULL OR length(error_message) <= 2000),
  lease_owner TEXT,
  lease_token UUID,
  lease_expires_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (run_id, idempotency_key),
  CHECK (
    status = 'running'
    OR (
      completed_at IS NOT NULL
      AND lease_owner IS NULL
      AND lease_token IS NULL
      AND lease_expires_at IS NULL
    )
  ),
  CHECK (updated_at >= created_at),
  CHECK (completed_at IS NULL OR completed_at >= started_at)
);

CREATE INDEX IF NOT EXISTS mcp_tool_calls_run_idx
  ON mcp_tool_calls(run_id, started_at, id);

CREATE INDEX IF NOT EXISTS mcp_tool_calls_provider_idx
  ON mcp_tool_calls(provider_id, started_at DESC);

CREATE INDEX IF NOT EXISTS mcp_tool_calls_lease_idx
  ON mcp_tool_calls(status, lease_expires_at)
  WHERE status = 'running';

CREATE OR REPLACE FUNCTION pluginmax_guard_mcp_tool_call_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'MCP Tool calls cannot be deleted';
  END IF;
  IF OLD.id IS DISTINCT FROM NEW.id
    OR OLD.run_id IS DISTINCT FROM NEW.run_id
    OR OLD.run_attempt IS DISTINCT FROM NEW.run_attempt
    OR OLD.task_id IS DISTINCT FROM NEW.task_id
    OR OLD.project_id IS DISTINCT FROM NEW.project_id
    OR OLD.agent_id IS DISTINCT FROM NEW.agent_id
    OR OLD.agent_principal_id IS DISTINCT FROM NEW.agent_principal_id
    OR OLD.provider_id IS DISTINCT FROM NEW.provider_id
    OR OLD.provider_key IS DISTINCT FROM NEW.provider_key
    OR OLD.provider_version_id IS DISTINCT FROM NEW.provider_version_id
    OR OLD.provider_version IS DISTINCT FROM NEW.provider_version
    OR OLD.provider_revision IS DISTINCT FROM NEW.provider_revision
    OR OLD.tool_catalog_id IS DISTINCT FROM NEW.tool_catalog_id
    OR OLD.tool_key IS DISTINCT FROM NEW.tool_key
    OR OLD.tool_name IS DISTINCT FROM NEW.tool_name
    OR OLD.tool_schema_digest IS DISTINCT FROM NEW.tool_schema_digest
    OR OLD.ticket_id IS DISTINCT FROM NEW.ticket_id
    OR OLD.gate_id IS DISTINCT FROM NEW.gate_id
    OR OLD.policy_id IS DISTINCT FROM NEW.policy_id
    OR OLD.policy_revision IS DISTINCT FROM NEW.policy_revision
    OR OLD.envelope_id IS DISTINCT FROM NEW.envelope_id
    OR OLD.envelope_digest IS DISTINCT FROM NEW.envelope_digest
    OR OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key
    OR OLD.request_digest IS DISTINCT FROM NEW.request_digest
    OR OLD.input_summary IS DISTINCT FROM NEW.input_summary
    OR OLD.started_at IS DISTINCT FROM NEW.started_at
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
  THEN
    RAISE EXCEPTION 'MCP Tool call identity is immutable';
  END IF;
  IF OLD.status <> 'running' THEN
    RAISE EXCEPTION 'terminal MCP Tool calls are immutable';
  END IF;
  IF OLD.status = 'running' AND NEW.status = 'running'
    AND (
      OLD.lease_token IS DISTINCT FROM NEW.lease_token
      OR OLD.lease_owner IS DISTINCT FROM NEW.lease_owner
    )
  THEN
    RAISE EXCEPTION 'MCP Tool call lease identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS mcp_tool_calls_mutation_guard ON mcp_tool_calls;
CREATE TRIGGER mcp_tool_calls_mutation_guard
BEFORE UPDATE OR DELETE ON mcp_tool_calls
FOR EACH ROW
EXECUTE FUNCTION pluginmax_guard_mcp_tool_call_mutation();

CREATE TABLE IF NOT EXISTS mcp_tool_call_receipts (
  id UUID PRIMARY KEY,
  call_id UUID NOT NULL
    REFERENCES mcp_tool_calls(id) ON DELETE RESTRICT,
  seq BIGINT NOT NULL CHECK (seq > 0),
  status TEXT NOT NULL
    CHECK (
      status IN (
        'started', 'succeeded', 'failed', 'timed_out', 'cancelled',
        'interrupted'
      )
    ),
  idempotency_key TEXT NOT NULL
    CHECK (length(btrim(idempotency_key)) BETWEEN 8 AND 240),
  input_summary JSONB NOT NULL
    CHECK (jsonb_typeof(input_summary) = 'object'),
  output_summary JSONB
    CHECK (
      output_summary IS NULL OR jsonb_typeof(output_summary) = 'object'
    ),
  output_digest TEXT
    CHECK (output_digest IS NULL OR output_digest ~ '^[a-f0-9]{64}$'),
  error_category TEXT
    CHECK (
      error_category IS NULL
      OR error_category IN (
        'timeout', 'cancelled', 'dns', 'tls', 'authentication',
        'authorization', 'http_status', 'protocol', 'schema', 'tool',
        'network', 'credential', 'unknown'
      )
    ),
  error_code TEXT
    CHECK (
      error_code IS NULL
      OR length(btrim(error_code)) BETWEEN 1 AND 160
    ),
  error_message TEXT
    CHECK (error_message IS NULL OR length(error_message) <= 2000),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (call_id, seq)
);

CREATE INDEX IF NOT EXISTS mcp_tool_call_receipts_call_idx
  ON mcp_tool_call_receipts(call_id, seq);

CREATE OR REPLACE FUNCTION pluginmax_assign_mcp_tool_receipt_seq()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  SELECT COALESCE(MAX(seq), 0) + 1
  INTO NEW.seq
  FROM mcp_tool_call_receipts
  WHERE call_id = NEW.call_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS mcp_tool_call_receipts_seq_guard
  ON mcp_tool_call_receipts;
CREATE TRIGGER mcp_tool_call_receipts_seq_guard
BEFORE INSERT ON mcp_tool_call_receipts
FOR EACH ROW
EXECUTE FUNCTION pluginmax_assign_mcp_tool_receipt_seq();

CREATE OR REPLACE FUNCTION pluginmax_reject_mcp_tool_receipt_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'MCP Tool call receipts are append-only';
END;
$$;

DROP TRIGGER IF EXISTS mcp_tool_call_receipts_append_only
  ON mcp_tool_call_receipts;
CREATE TRIGGER mcp_tool_call_receipts_append_only
BEFORE UPDATE OR DELETE ON mcp_tool_call_receipts
FOR EACH ROW
EXECUTE FUNCTION pluginmax_reject_mcp_tool_receipt_mutation();

-- M13b enable state: Tool invocation remains disabled until the M13b
-- observation gate and explicit release activation.
`;

export const M13C_RUNTIME_TOOL_REQUEST_BRIDGE_SCHEMA_SQL = `
-- M13c bridges structured Agent Runtime Tool Requests to the existing M13b
-- Worker-only execution port. Raw arguments and result bodies never enter
-- these tables.
INSERT INTO feature_flag_settings (
  flag_key, scope_type, scope_id, mode, revision, updated_by, updated_at
) VALUES (
  'mcp.runtime_tool_bridge', 'platform', 'platform', 'off', 1,
  'system:migration', NOW()
)
ON CONFLICT (flag_key, scope_type, scope_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS runtime_tool_requests (
  request_id UUID PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
  run_attempt INTEGER NOT NULL CHECK (run_attempt > 0),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  agent_principal_id TEXT
    CHECK (
      agent_principal_id IS NULL
      OR length(btrim(agent_principal_id)) BETWEEN 1 AND 180
    ),
  tool_key TEXT NOT NULL CHECK (tool_key ~ '^[a-f0-9]{64}$'),
  ticket_id UUID NOT NULL
    REFERENCES action_tickets(id) ON DELETE RESTRICT,
  gate_id UUID NOT NULL UNIQUE
    REFERENCES execution_gate_requests(gate_id) ON DELETE RESTRICT,
  policy_id UUID NOT NULL
    REFERENCES task_execution_policies(id) ON DELETE RESTRICT,
  policy_revision INTEGER NOT NULL CHECK (policy_revision >= 0),
  envelope_id TEXT NOT NULL
    CHECK (length(btrim(envelope_id)) BETWEEN 1 AND 180),
  envelope_digest TEXT NOT NULL
    CHECK (envelope_digest ~ '^[a-f0-9]{64}$'),
  call_id UUID UNIQUE REFERENCES mcp_tool_calls(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL
    CHECK (length(btrim(idempotency_key)) BETWEEN 8 AND 240),
  request_digest TEXT NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (
      status IN (
        'running', 'succeeded', 'failed', 'timed_out', 'cancelled',
        'interrupted'
      )
    ),
  input_summary JSONB NOT NULL
    CHECK (jsonb_typeof(input_summary) = 'object'),
  output_summary JSONB
    CHECK (
      output_summary IS NULL OR jsonb_typeof(output_summary) = 'object'
    ),
  output_digest TEXT
    CHECK (output_digest IS NULL OR output_digest ~ '^[a-f0-9]{64}$'),
  error_category TEXT
    CHECK (
      error_category IS NULL
      OR error_category IN (
        'timeout', 'cancelled', 'dns', 'tls', 'authentication',
        'authorization', 'http_status', 'protocol', 'schema', 'tool',
        'network', 'credential', 'unknown'
      )
    ),
  error_code TEXT
    CHECK (
      error_code IS NULL
      OR length(btrim(error_code)) BETWEEN 1 AND 160
    ),
  error_message TEXT
    CHECK (error_message IS NULL OR length(error_message) <= 2000),
  lease_owner TEXT,
  lease_token UUID,
  lease_expires_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (run_id, idempotency_key),
  CHECK (
    status = 'running'
    OR (
      completed_at IS NOT NULL
      AND lease_owner IS NULL
      AND lease_token IS NULL
      AND lease_expires_at IS NULL
    )
  ),
  CHECK (
    status <> 'running'
    OR (
      lease_owner IS NOT NULL
      AND lease_token IS NOT NULL
      AND lease_expires_at IS NOT NULL
    )
  ),
  CHECK (updated_at >= created_at),
  CHECK (completed_at IS NULL OR completed_at >= started_at)
);

CREATE INDEX IF NOT EXISTS runtime_tool_requests_run_idx
  ON runtime_tool_requests(run_id, started_at, request_id);

CREATE INDEX IF NOT EXISTS runtime_tool_requests_status_idx
  ON runtime_tool_requests(status, lease_expires_at)
  WHERE status = 'running';

CREATE OR REPLACE FUNCTION pluginmax_assert_runtime_tool_request_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  run_task_id UUID;
  run_project_id UUID;
  run_agent_id UUID;
  run_attempt INTEGER;
  run_status TEXT;
  run_envelope_id TEXT;
  run_envelope_digest TEXT;
BEGIN
  SELECT
    task_id,
    project_id,
    agent_id,
    attempt,
    status,
    execution_envelope_snapshot ->> 'id',
    execution_envelope_snapshot ->> 'digest'
  INTO
    run_task_id,
    run_project_id,
    run_agent_id,
    run_attempt,
    run_status,
    run_envelope_id,
    run_envelope_digest
  FROM runs
  WHERE id = NEW.run_id;

  IF run_task_id IS NULL THEN
    RAISE EXCEPTION 'Runtime Tool Request Run does not exist';
  END IF;
  IF run_status <> 'running' THEN
    RAISE EXCEPTION 'Runtime Tool Requests require a running Run';
  END IF;
  IF run_task_id IS DISTINCT FROM NEW.task_id
    OR run_project_id IS DISTINCT FROM NEW.project_id
    OR run_agent_id IS DISTINCT FROM NEW.agent_id
    OR run_attempt IS DISTINCT FROM NEW.run_attempt
    OR run_envelope_id IS DISTINCT FROM NEW.envelope_id
    OR run_envelope_digest IS DISTINCT FROM NEW.envelope_digest
  THEN
    RAISE EXCEPTION 'Runtime Tool Request binding does not match its Run';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS runtime_tool_requests_scope_guard
  ON runtime_tool_requests;
CREATE TRIGGER runtime_tool_requests_scope_guard
BEFORE INSERT ON runtime_tool_requests
FOR EACH ROW
EXECUTE FUNCTION pluginmax_assert_runtime_tool_request_scope();

CREATE OR REPLACE FUNCTION pluginmax_guard_runtime_tool_request_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Runtime Tool Requests cannot be deleted';
  END IF;
  IF OLD.request_id IS DISTINCT FROM NEW.request_id
    OR OLD.run_id IS DISTINCT FROM NEW.run_id
    OR OLD.run_attempt IS DISTINCT FROM NEW.run_attempt
    OR OLD.task_id IS DISTINCT FROM NEW.task_id
    OR OLD.project_id IS DISTINCT FROM NEW.project_id
    OR OLD.agent_id IS DISTINCT FROM NEW.agent_id
    OR OLD.agent_principal_id IS DISTINCT FROM NEW.agent_principal_id
    OR OLD.tool_key IS DISTINCT FROM NEW.tool_key
    OR OLD.ticket_id IS DISTINCT FROM NEW.ticket_id
    OR OLD.gate_id IS DISTINCT FROM NEW.gate_id
    OR OLD.policy_id IS DISTINCT FROM NEW.policy_id
    OR OLD.policy_revision IS DISTINCT FROM NEW.policy_revision
    OR OLD.envelope_id IS DISTINCT FROM NEW.envelope_id
    OR OLD.envelope_digest IS DISTINCT FROM NEW.envelope_digest
    OR OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key
    OR OLD.request_digest IS DISTINCT FROM NEW.request_digest
    OR OLD.input_summary IS DISTINCT FROM NEW.input_summary
    OR OLD.started_at IS DISTINCT FROM NEW.started_at
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
  THEN
    RAISE EXCEPTION 'Runtime Tool Request identity is immutable';
  END IF;
  IF OLD.status <> 'running' THEN
    RAISE EXCEPTION 'terminal Runtime Tool Requests are immutable';
  END IF;
  IF NEW.status = 'running' THEN
    RAISE EXCEPTION 'Runtime Tool Requests must transition to a terminal state';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS runtime_tool_requests_mutation_guard
  ON runtime_tool_requests;
CREATE TRIGGER runtime_tool_requests_mutation_guard
BEFORE UPDATE OR DELETE ON runtime_tool_requests
FOR EACH ROW
EXECUTE FUNCTION pluginmax_guard_runtime_tool_request_mutation();

CREATE TABLE IF NOT EXISTS runtime_tool_request_receipts (
  id UUID PRIMARY KEY,
  request_id UUID NOT NULL
    REFERENCES runtime_tool_requests(request_id) ON DELETE RESTRICT,
  seq BIGINT NOT NULL CHECK (seq > 0),
  status TEXT NOT NULL
    CHECK (
      status IN (
        'running', 'succeeded', 'failed', 'timed_out', 'cancelled',
        'interrupted'
      )
    ),
  request_digest TEXT NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  input_summary JSONB NOT NULL
    CHECK (jsonb_typeof(input_summary) = 'object'),
  output_summary JSONB
    CHECK (
      output_summary IS NULL OR jsonb_typeof(output_summary) = 'object'
    ),
  output_digest TEXT
    CHECK (output_digest IS NULL OR output_digest ~ '^[a-f0-9]{64}$'),
  error_category TEXT
    CHECK (
      error_category IS NULL
      OR error_category IN (
        'timeout', 'cancelled', 'dns', 'tls', 'authentication',
        'authorization', 'http_status', 'protocol', 'schema', 'tool',
        'network', 'credential', 'unknown'
      )
    ),
  error_code TEXT
    CHECK (
      error_code IS NULL
      OR length(btrim(error_code)) BETWEEN 1 AND 160
    ),
  error_message TEXT
    CHECK (error_message IS NULL OR length(error_message) <= 2000),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (request_id, seq)
);

CREATE INDEX IF NOT EXISTS runtime_tool_request_receipts_request_idx
  ON runtime_tool_request_receipts(request_id, seq);

CREATE OR REPLACE FUNCTION pluginmax_assign_runtime_tool_receipt_seq()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  SELECT COALESCE(MAX(seq), 0) + 1
  INTO NEW.seq
  FROM runtime_tool_request_receipts
  WHERE request_id = NEW.request_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS runtime_tool_request_receipts_seq_guard
  ON runtime_tool_request_receipts;
CREATE TRIGGER runtime_tool_request_receipts_seq_guard
BEFORE INSERT ON runtime_tool_request_receipts
FOR EACH ROW
EXECUTE FUNCTION pluginmax_assign_runtime_tool_receipt_seq();

CREATE OR REPLACE FUNCTION pluginmax_append_runtime_tool_request_receipt()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO runtime_tool_request_receipts (
    id, request_id, seq, status, request_digest, input_summary,
    output_summary, output_digest, error_category, error_code,
    error_message, created_at
  ) VALUES (
    gen_random_uuid(), NEW.request_id, 1, NEW.status, NEW.request_digest,
    NEW.input_summary, NEW.output_summary, NEW.output_digest,
    NEW.error_category, NEW.error_code, NEW.error_message, NOW()
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS runtime_tool_requests_receipt_insert
  ON runtime_tool_requests;
CREATE TRIGGER runtime_tool_requests_receipt_insert
AFTER INSERT ON runtime_tool_requests
FOR EACH ROW
EXECUTE FUNCTION pluginmax_append_runtime_tool_request_receipt();

DROP TRIGGER IF EXISTS runtime_tool_requests_receipt_terminal
  ON runtime_tool_requests;
CREATE TRIGGER runtime_tool_requests_receipt_terminal
AFTER UPDATE OF status ON runtime_tool_requests
FOR EACH ROW
WHEN (OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION pluginmax_append_runtime_tool_request_receipt();

CREATE OR REPLACE FUNCTION pluginmax_reject_runtime_tool_receipt_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Runtime Tool Request receipts are append-only';
END;
$$;

DROP TRIGGER IF EXISTS runtime_tool_request_receipts_append_only
  ON runtime_tool_request_receipts;
CREATE TRIGGER runtime_tool_request_receipts_append_only
BEFORE UPDATE OR DELETE ON runtime_tool_request_receipts
FOR EACH ROW
EXECUTE FUNCTION pluginmax_reject_runtime_tool_receipt_mutation();

-- Concurrent M13c requests may hit the same Run and Provider. Serialize
-- append-only sequence allocation without changing the event payloads.
CREATE OR REPLACE FUNCTION pluginmax_assign_run_event_seq()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('run-events:' || NEW.run_id::text, 0)
  );
  SELECT COALESCE(MAX(seq), 0) + 1
  INTO NEW.seq
  FROM run_events
  WHERE run_id = NEW.run_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS run_events_seq_guard ON run_events;
CREATE TRIGGER run_events_seq_guard
BEFORE INSERT ON run_events
FOR EACH ROW
EXECUTE FUNCTION pluginmax_assign_run_event_seq();

CREATE OR REPLACE FUNCTION pluginmax_assign_mcp_provider_audit_seq()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('mcp-provider-audit:' || NEW.provider_id::text, 0)
  );
  SELECT COALESCE(MAX(seq), 0) + 1
  INTO NEW.seq
  FROM mcp_provider_audit_events
  WHERE provider_id = NEW.provider_id;
  RETURN NEW;
END;
$$;

-- M13c enable state: Runtime Tool Request bridging remains disabled until
-- the M13c observation gate and explicit release activation.
`;
