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
