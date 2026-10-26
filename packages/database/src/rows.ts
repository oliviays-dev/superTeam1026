import type {
  Agent,
  AgentEvent,
  PlatformRunEvent,
  Project,
  Run,
  RunDelta,
  Task,
  TaskMessage,
} from "@pluginmax/contracts";

export interface ProjectRow {
  id: string;
  name: string;
  code: string;
  description: string;
  status: Project["status"];
  source_template_id: string | null;
  source_template_revision: number | null;
  created_at: Date;
  updated_at: Date;
}

export interface AgentRow {
  id: string;
  name: string;
  description: string;
  soul: string;
  scenarios: string[];
  goals: string[];
  tools: string[];
  runtime_kind: Agent["runtimeKind"];
  status: Agent["status"];
  source: Agent["source"];
  owner_id: string;
  version: number;
  created_at: Date;
  updated_at: Date;
}

export interface AgentEventRow {
  id: string;
  agent_id: string;
  seq: string;
  kind: AgentEvent["kind"];
  message: string;
  actor_id: string;
  created_at: Date;
}

export interface TaskRow {
  id: string;
  project_id: string;
  title: string;
  description: string;
  acceptance: string[];
  status: Task["status"];
  agent_id: string;
  role_id: string | null;
  depends_on: string[] | null;
  created_at: Date;
  updated_at: Date;
}

export interface TaskMessageRow {
  id: string;
  task_id: string;
  author_type: TaskMessage["authorType"];
  author_id: string;
  author_name: string;
  content: string;
  reply_to_id: string | null;
  created_at: Date;
}

export interface RunRow {
  id: string;
  project_id: string | null;
  task_id: string | null;
  meeting_turn_id: string | null;
  direct_chat_turn_id: string | null;
  agent_id: string;
  status: Run["status"];
  context_pack_id: string | null;
  input_snapshot: Run["inputSnapshot"];
  output: string | null;
  error: string | null;
  attempt: number;
  timeout_at: Date | null;
  workflow_instance_id: string | null;
  workflow_node_id: string | null;
  trace_id: string | null;
  trace_root_span_id: string | null;
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
  trace_id: string | null;
  span_id: string | null;
  parent_span_id: string | null;
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
    sourceTemplateId: row.source_template_id,
    sourceTemplateRevision: row.source_template_revision,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function agentFromRow(row: AgentRow): Agent {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    soul: row.soul,
    scenarios: row.scenarios,
    goals: row.goals,
    tools: row.tools,
    runtimeKind: row.runtime_kind,
    status: row.status,
    source: row.source,
    ownerId: row.owner_id,
    version: row.version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function agentEventFromRow(row: AgentEventRow): AgentEvent {
  return {
    id: row.id,
    agentId: row.agent_id,
    seq: Number(row.seq),
    kind: row.kind,
    message: row.message,
    actorId: row.actor_id,
    createdAt: row.created_at.toISOString(),
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
    ...(row.role_id === null ? {} : { roleId: row.role_id }),
    dependsOn: row.depends_on ?? [],
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function taskMessageFromRow(row: TaskMessageRow): TaskMessage {
  return {
    id: row.id,
    taskId: row.task_id,
    authorType: row.author_type,
    authorId: row.author_id,
    authorName: row.author_name,
    content: row.content,
    replyToId: row.reply_to_id,
    createdAt: row.created_at.toISOString(),
  };
}

export function runFromRow(row: RunRow): Run {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    meetingTurnId: row.meeting_turn_id,
    directChatTurnId: row.direct_chat_turn_id,
    agentId: row.agent_id,
    status: row.status,
    contextPackId: row.context_pack_id,
    inputSnapshot: row.input_snapshot,
    output: row.output,
    error: row.error,
    attempt: row.attempt,
    timeoutAt: row.timeout_at?.toISOString() ?? null,
    workflowInstanceId: row.workflow_instance_id,
    workflowNodeId: row.workflow_node_id,
    traceId: row.trace_id,
    traceRootSpanId: row.trace_root_span_id,
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
    traceId: row.trace_id,
    spanId: row.span_id,
    parentSpanId: row.parent_span_id,
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
