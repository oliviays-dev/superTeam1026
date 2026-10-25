import type {
  Agent,
  PlatformRunEvent,
  Project,
  Run,
  RunDelta,
  Task,
} from "@pluginmax/contracts";

export interface ProjectRow {
  id: string;
  name: string;
  code: string;
  description: string;
  status: Project["status"];
  created_at: Date;
  updated_at: Date;
}

export interface AgentRow {
  id: string;
  name: string;
  description: string;
  runtime_kind: Agent["runtimeKind"];
  status: Agent["status"];
  created_at: Date;
  updated_at: Date;
}

export interface TaskRow {
  id: string;
  project_id: string;
  title: string;
  description: string;
  acceptance: string[];
  status: Task["status"];
  agent_id: string;
  created_at: Date;
  updated_at: Date;
}

export interface RunRow {
  id: string;
  project_id: string;
  task_id: string;
  agent_id: string;
  status: Run["status"];
  input_snapshot: Run["inputSnapshot"];
  output: string | null;
  error: string | null;
  observability: Run["observability"];
  created_at: Date;
  started_at: Date | null;
  ended_at: Date | null;
  updated_at: Date;
}

export interface RunEventRow {
  id: string;
  run_id: string;
  seq: string;
  type: PlatformRunEvent["type"];
  visibility: PlatformRunEvent["visibility"];
  summary: string;
  data: Record<string, unknown> | null;
  created_at: Date;
}

export interface RunDeltaRow {
  run_id: string;
  seq: string;
  text: string;
  created_at: Date;
}

export function projectFromRow(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    description: row.description,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function agentFromRow(row: AgentRow): Agent {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    runtimeKind: row.runtime_kind,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function taskFromRow(row: TaskRow): Task {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    acceptance: row.acceptance,
    status: row.status,
    agentId: row.agent_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function runFromRow(row: RunRow): Run {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    agentId: row.agent_id,
    status: row.status,
    inputSnapshot: row.input_snapshot,
    output: row.output,
    error: row.error,
    observability: row.observability,
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    endedAt: row.ended_at?.toISOString() ?? null,
    updatedAt: row.updated_at.toISOString(),
  };
}

export function runEventFromRow(row: RunEventRow): PlatformRunEvent {
  return {
    id: row.id,
    runId: row.run_id,
    seq: Number(row.seq),
    type: row.type,
    visibility: row.visibility,
    summary: row.summary,
    data: row.data,
    createdAt: row.created_at.toISOString(),
  };
}

export function runDeltaFromRow(row: RunDeltaRow): RunDelta {
  return {
    runId: row.run_id,
    seq: Number(row.seq),
    text: row.text,
    createdAt: row.created_at.toISOString(),
  };
}
