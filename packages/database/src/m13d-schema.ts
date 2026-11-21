export const M13D_PROJECT_SOURCE_MCP_SCHEMA_SQL = `
-- M13d adds a Worker-only, read-only MCP project-source path. The browser
-- remains limited to the existing project overview read model.
INSERT INTO feature_flag_settings (
  flag_key, scope_type, scope_id, mode, revision, updated_by, updated_at
) VALUES (
  'project.source.mcp', 'platform', 'platform', 'off', 1,
  'system:migration', NOW()
)
ON CONFLICT (flag_key, scope_type, scope_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS project_source_mcp_reads (
  request_id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  ref_key TEXT NOT NULL
    CHECK (length(btrim(ref_key)) BETWEEN 1 AND 160),
  source_kind TEXT NOT NULL CHECK (source_kind = 'mcp'),
  source_system TEXT NOT NULL
    CHECK (length(btrim(source_system)) BETWEEN 1 AND 120),
  source_object_type TEXT NOT NULL
    CHECK (length(btrim(source_object_type)) BETWEEN 1 AND 120),
  source_object_id TEXT NOT NULL
    CHECK (length(btrim(source_object_id)) BETWEEN 1 AND 240),
  source_path TEXT NOT NULL
    CHECK (length(btrim(source_path)) BETWEEN 1 AND 300),
  source_binding_revision INTEGER NOT NULL
    CHECK (source_binding_revision > 0),
  source_binding_digest TEXT NOT NULL
    CHECK (source_binding_digest ~ '^[a-f0-9]{64}$'),
  provider_id UUID NOT NULL REFERENCES mcp_providers(id) ON DELETE RESTRICT,
  provider_version_id UUID NOT NULL
    REFERENCES mcp_provider_versions(id) ON DELETE RESTRICT,
  provider_revision INTEGER NOT NULL CHECK (provider_revision > 0),
  tool_key TEXT NOT NULL CHECK (tool_key ~ '^[a-f0-9]{64}$'),
  run_id UUID NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
  run_attempt INTEGER NOT NULL CHECK (run_attempt > 0),
  ticket_id UUID NOT NULL,
  gate_id UUID NOT NULL,
  policy_id UUID NOT NULL,
  policy_revision INTEGER NOT NULL CHECK (policy_revision >= 0),
  envelope_id TEXT NOT NULL
    CHECK (length(btrim(envelope_id)) BETWEEN 1 AND 180),
  envelope_digest TEXT NOT NULL
    CHECK (envelope_digest ~ '^[a-f0-9]{64}$'),
  runtime_request_id UUID,
  call_id UUID REFERENCES mcp_tool_calls(id) ON DELETE RESTRICT,
  snapshot_id UUID REFERENCES project_source_snapshots(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL
    CHECK (length(btrim(idempotency_key)) BETWEEN 8 AND 240),
  request_digest TEXT NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  status TEXT NOT NULL
    CHECK (status IN (
      'running', 'succeeded', 'failed', 'timed_out', 'cancelled',
      'interrupted'
    )),
  source_revision TEXT
    CHECK (
      source_revision IS NULL
      OR length(btrim(source_revision)) BETWEEN 1 AND 240
    ),
  error_category TEXT
    CHECK (error_category IS NULL OR length(error_category) <= 80),
  error_code TEXT
    CHECK (error_code IS NULL OR length(error_code) <= 160),
  error_message TEXT
    CHECK (error_message IS NULL OR length(error_message) <= 2000),
  lease_owner TEXT
    CHECK (lease_owner IS NULL OR length(btrim(lease_owner)) <= 180),
  lease_token UUID,
  lease_expires_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (project_id, source_binding_digest, ref_key, idempotency_key),
  UNIQUE (runtime_request_id),
  UNIQUE (snapshot_id),
  CHECK (
    (
      status = 'running'
      AND completed_at IS NULL
      AND lease_owner IS NOT NULL
      AND lease_token IS NOT NULL
      AND lease_expires_at IS NOT NULL
    )
    OR (
      status <> 'running'
      AND completed_at IS NOT NULL
      AND lease_owner IS NULL
      AND lease_token IS NULL
      AND lease_expires_at IS NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS project_source_mcp_reads_project_idx
  ON project_source_mcp_reads(project_id, started_at DESC, request_id);

CREATE INDEX IF NOT EXISTS project_source_mcp_reads_running_idx
  ON project_source_mcp_reads(lease_expires_at, request_id)
  WHERE status = 'running';

CREATE OR REPLACE FUNCTION pluginmax_guard_project_source_mcp_read()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status <> 'running' THEN
      RAISE EXCEPTION 'terminal project source MCP reads are immutable';
    END IF;
    IF NEW.status = 'running' THEN
      RAISE EXCEPTION 'project source MCP read completion must be terminal';
    END IF;
    IF (
      NEW.project_id, NEW.ref_key, NEW.source_binding_revision,
      NEW.source_binding_digest, NEW.provider_id, NEW.provider_version_id,
      NEW.provider_revision, NEW.tool_key, NEW.run_id, NEW.run_attempt,
      NEW.ticket_id, NEW.gate_id, NEW.policy_id, NEW.policy_revision,
      NEW.envelope_id, NEW.envelope_digest, NEW.idempotency_key,
      NEW.request_digest
    ) IS DISTINCT FROM (
      OLD.project_id, OLD.ref_key, OLD.source_binding_revision,
      OLD.source_binding_digest, OLD.provider_id, OLD.provider_version_id,
      OLD.provider_revision, OLD.tool_key, OLD.run_id, OLD.run_attempt,
      OLD.ticket_id, OLD.gate_id, OLD.policy_id, OLD.policy_revision,
      OLD.envelope_id, OLD.envelope_digest, OLD.idempotency_key,
      OLD.request_digest
    ) THEN
      RAISE EXCEPTION 'project source MCP read identity is immutable';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS project_source_mcp_reads_guard
  ON project_source_mcp_reads;
CREATE TRIGGER project_source_mcp_reads_guard
BEFORE INSERT OR UPDATE ON project_source_mcp_reads
FOR EACH ROW
EXECUTE FUNCTION pluginmax_guard_project_source_mcp_read();

CREATE OR REPLACE FUNCTION pluginmax_reject_project_source_mcp_read_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'project source MCP reads must be retained';
END;
$$;

DROP TRIGGER IF EXISTS project_source_mcp_reads_delete_guard
  ON project_source_mcp_reads;
CREATE TRIGGER project_source_mcp_reads_delete_guard
BEFORE DELETE ON project_source_mcp_reads
FOR EACH ROW
EXECUTE FUNCTION pluginmax_reject_project_source_mcp_read_delete();

CREATE TABLE IF NOT EXISTS project_source_mcp_read_events (
  id UUID PRIMARY KEY,
  request_id UUID NOT NULL
    REFERENCES project_source_mcp_reads(request_id) ON DELETE RESTRICT,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  seq BIGINT NOT NULL CHECK (seq > 0),
  status TEXT NOT NULL
    CHECK (status IN (
      'running', 'succeeded', 'failed', 'timed_out', 'cancelled',
      'interrupted'
    )),
  actor_principal_id TEXT NOT NULL
    CHECK (length(btrim(actor_principal_id)) BETWEEN 1 AND 180),
  error_category TEXT
    CHECK (error_category IS NULL OR length(error_category) <= 80),
  error_code TEXT
    CHECK (error_code IS NULL OR length(error_code) <= 160),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (request_id, seq)
);

CREATE INDEX IF NOT EXISTS project_source_mcp_read_events_request_idx
  ON project_source_mcp_read_events(request_id, seq);

CREATE OR REPLACE FUNCTION pluginmax_assign_project_source_mcp_read_event_seq()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('project-source-mcp-read:' || NEW.request_id::text, 0)
  );
  SELECT COALESCE(MAX(seq), 0) + 1
  INTO NEW.seq
  FROM project_source_mcp_read_events
  WHERE request_id = NEW.request_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS project_source_mcp_read_events_seq_guard
  ON project_source_mcp_read_events;
CREATE TRIGGER project_source_mcp_read_events_seq_guard
BEFORE INSERT ON project_source_mcp_read_events
FOR EACH ROW
EXECUTE FUNCTION pluginmax_assign_project_source_mcp_read_event_seq();

CREATE OR REPLACE FUNCTION pluginmax_append_project_source_mcp_read_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO project_source_mcp_read_events (
    id, request_id, project_id, seq, status, actor_principal_id,
    error_category, error_code, created_at
  ) VALUES (
    gen_random_uuid(), NEW.request_id, NEW.project_id, 1, NEW.status,
    'system:project-source-worker', NEW.error_category, NEW.error_code, NOW()
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS project_source_mcp_reads_event_insert
  ON project_source_mcp_reads;
CREATE TRIGGER project_source_mcp_reads_event_insert
AFTER INSERT ON project_source_mcp_reads
FOR EACH ROW
EXECUTE FUNCTION pluginmax_append_project_source_mcp_read_event();

DROP TRIGGER IF EXISTS project_source_mcp_reads_event_terminal
  ON project_source_mcp_reads;
CREATE TRIGGER project_source_mcp_reads_event_terminal
AFTER UPDATE OF status ON project_source_mcp_reads
FOR EACH ROW
WHEN (OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION pluginmax_append_project_source_mcp_read_event();

CREATE OR REPLACE FUNCTION pluginmax_reject_project_source_mcp_read_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'project source MCP read events are append-only';
END;
$$;

DROP TRIGGER IF EXISTS project_source_mcp_read_events_append_only
  ON project_source_mcp_read_events;
CREATE TRIGGER project_source_mcp_read_events_append_only
BEFORE UPDATE OR DELETE ON project_source_mcp_read_events
FOR EACH ROW
EXECUTE FUNCTION pluginmax_reject_project_source_mcp_read_event_mutation();

-- M13d enable state: MCP project source reads remain disabled until an
-- explicit Secret Store adapter and Worker release are configured.
`;
