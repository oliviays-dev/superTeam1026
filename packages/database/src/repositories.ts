import { randomUUID } from "node:crypto";
import type {
  Agent,
  AgentEvent,
  CreateAgentInput,
  CreateProjectInput,
  CreateTaskInput,
  CreateTaskMessageInput,
  Job,
  PlatformRunEvent,
  PlatformRunEventType,
  Project,
  Run,
  RunDelta,
  RunInputSnapshot,
  Task,
  TaskMessage,
  TaskStatus,
  TraceContext,
  UpdateAgentInput,
  UpdateProjectInput,
  UpdateTaskInput,
} from "@pluginmax/contracts";
import { createRootTraceContext, newSpanId } from "@pluginmax/contracts";
import type { PoolClient } from "pg";
import { Database } from "./database.js";
import {
  agentEventFromRow,
  agentFromRow,
  projectFromRow,
  runDeltaFromRow,
  runEventFromRow,
  runFromRow,
  taskMessageFromRow,
  taskFromRow,
  type AgentRow,
  type AgentEventRow,
  type ProjectRow,
  type RunDeltaRow,
  type RunEventRow,
  type RunRow,
  type TaskRow,
  type TaskMessageRow,
} from "./rows.js";
import { DEFAULT_AGENT_ID } from "./schema.js";
import { ContextRepository } from "./context-repository.js";
import { ProjectMembershipRepository } from "./project-membership-repository.js";
import {
  ArtifactRepository,
  MeetingRepository,
  MemoryRepository,
  ReviewRepository,
  WorkbenchRepository,
  WorkflowRepository,
} from "./collaboration-repositories.js";
import { TaskCollaborationRepository } from "./task-collaboration-repository.js";
import { WorkflowIdempotencyRepository } from "./workflow-idempotency-repository.js";
import { WorkflowRuntimeRepository } from "./workflow-runtime-repository.js";
import { RuntimeReliabilityRepository } from "./runtime-reliability-repository.js";
import { RuntimeEffectRepository } from "./runtime-effect-repository.js";
import { RuntimeTraceRepository } from "./runtime-trace-repository.js";
import { MeetingDecisionsRepository } from "./meeting-decisions-repository.js";
import {
  failMeetingTurnWithClient,
  MeetingAiRepository,
} from "./meeting-ai-repository.js";
import { MemoryClosureRepository } from "./memory-closure-repository.js";
import { WorkbenchReportsRepository } from "./workbench-reports-repository.js";
import { ProjectTemplatesRepository } from "./project-templates-repository.js";

export class ProjectRepository {
  constructor(private readonly database: Database) {}

  async list(): Promise<Project[]> {
    const result = await this.database.query<ProjectRow>(
      "SELECT * FROM projects ORDER BY updated_at DESC",
    );
    return result.rows.map(projectFromRow);
  }

  async get(id: string): Promise<Project | undefined> {
    const result = await this.database.query<ProjectRow>(
      "SELECT * FROM projects WHERE id = $1",
      [id],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : projectFromRow(row);
  }

  async create(
    input: CreateProjectInput,
    actorId = "local-admin",
    actorName = "Local Admin",
  ): Promise<Project> {
    const id = randomUUID();
    const code =
      input.code ?? `PRJ-${Date.now().toString(36).toUpperCase().slice(-6)}`;
    return this.database.transaction(async (client) => {
      const result = await client.query<ProjectRow>(
        `INSERT INTO projects (
           id, name, code, description, status, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, 'active', NOW(), NOW())
         RETURNING *`,
        [id, input.name, code, input.description],
      );
      const roleId = randomUUID();
      const memberId = randomUUID();
      const responsibility = "负责项目目标、范围、成员和最终验收。";
      await client.query(
        `INSERT INTO project_roles (
           id, project_id, code, name, category, description, permissions,
           created_at, updated_at
         ) VALUES (
           $1, $2, 'PROJECT_OWNER', '项目负责人', 'management', $3,
           '["read","write","approve","manage_members","manage_roles"]'::jsonb,
           NOW(), NOW()
         )`,
        [roleId, id, responsibility],
      );
      await client.query(
        `INSERT INTO project_members (
           id, project_id, kind, actor_id, name, responsibility,
           status, is_owner, created_at, updated_at
         ) VALUES ($1, $2, 'human', $4, $5, $3,
                   'active', TRUE, NOW(), NOW())`,
        [memberId, id, responsibility, actorId, actorName],
      );
      await client.query(
        `INSERT INTO project_member_roles (project_member_id, role_id)
         VALUES ($1, $2)`,
        [memberId, roleId],
      );
      return projectFromRow(result.rows[0]!);
    });
  }

  async update(
    id: string,
    input: UpdateProjectInput,
  ): Promise<Project | undefined> {
    const result = await this.database.query<ProjectRow>(
      `UPDATE projects
       SET
         name = COALESCE($2, name),
         code = COALESCE($3, code),
         description = COALESCE($4, description),
         status = COALESCE($5, status),
         updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [
        id,
        input.name ?? null,
        input.code ?? null,
        input.description ?? null,
        input.status ?? null,
      ],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : projectFromRow(row);
  }
}

export class AgentRepository {
  constructor(private readonly database: Database) {}

  async list(includeDisabled = false): Promise<Agent[]> {
    const result = await this.database.query<AgentRow>(
      `SELECT * FROM agents
       WHERE ($1::boolean OR status = 'active')
       ORDER BY
         CASE runtime_kind WHEN 'fake' THEN 0 ELSE 1 END,
         status,
         name`,
      [includeDisabled],
    );
    return result.rows.map(agentFromRow);
  }

  async get(id: string, includeDisabled = false): Promise<Agent | undefined> {
    const result = await this.database.query<AgentRow>(
      `SELECT * FROM agents
       WHERE id = $1 AND ($2::boolean OR status = 'active')`,
      [id, includeDisabled],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : agentFromRow(row);
  }

  async create(
    input: CreateAgentInput,
    ownerId: string,
    actorId: string,
  ): Promise<Agent> {
    return this.database.transaction(async (client) => {
      const result = await client.query<AgentRow>(
        `INSERT INTO agents (
           id, name, description, soul, scenarios, goals, tools,
           runtime_kind, status, source, owner_id, version, created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb,
           $8, 'active', $9, $10, 1, NOW(), NOW()
         )
         RETURNING *`,
        [
          randomUUID(),
          input.name,
          input.description,
          input.soul,
          JSON.stringify(input.scenarios),
          JSON.stringify(input.goals),
          JSON.stringify(input.tools),
          input.runtimeKind,
          input.source,
          ownerId,
        ],
      );
      const agent = agentFromRow(result.rows[0]!);
      await this.appendEventWithClient(
        client,
        agent.id,
        "created",
        `创建 AI 伙伴“${agent.name}”`,
        actorId,
      );
      return agent;
    });
  }

  async update(
    id: string,
    input: UpdateAgentInput,
    actorId: string,
  ): Promise<Agent | undefined> {
    return this.database.transaction(async (client) => {
      const result = await client.query<AgentRow>(
        `UPDATE agents
         SET
           name = COALESCE($2, name),
           description = COALESCE($3, description),
           soul = COALESCE($4, soul),
           scenarios = COALESCE($5::jsonb, scenarios),
           goals = COALESCE($6::jsonb, goals),
           tools = COALESCE($7::jsonb, tools),
           runtime_kind = COALESCE($8, runtime_kind),
           source = COALESCE($9, source),
           status = COALESCE($10, status),
           version = version + 1,
           updated_at = NOW()
         WHERE id = $1
           AND ($11::integer IS NULL OR version = $11)
         RETURNING *`,
        [
          id,
          input.name ?? null,
          input.description ?? null,
          input.soul ?? null,
          input.scenarios === undefined
            ? null
            : JSON.stringify(input.scenarios),
          input.goals === undefined ? null : JSON.stringify(input.goals),
          input.tools === undefined ? null : JSON.stringify(input.tools),
          input.runtimeKind ?? null,
          input.source ?? null,
          input.status ?? null,
          input.expectedVersion ?? null,
        ],
      );
      const row = result.rows[0];
      if (row === undefined) return undefined;
      const agent = agentFromRow(row);
      await this.appendEventWithClient(
        client,
        id,
        "updated",
        `更新 AI 伙伴“${agent.name}”至 v${agent.version}`,
        actorId,
      );
      return agent;
    });
  }

  async setStatus(
    id: string,
    status: Agent["status"],
    actorId: string,
  ): Promise<Agent | undefined> {
    return this.database.transaction(async (client) => {
      const result = await client.query<AgentRow>(
        `UPDATE agents
         SET status = $2, version = version + 1, updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [id, status],
      );
      const row = result.rows[0];
      if (row === undefined) return undefined;
      const agent = agentFromRow(row);
      await this.appendEventWithClient(
        client,
        id,
        "status",
        status === "active" ? "AI 伙伴已启用" : "AI 伙伴已停用",
        actorId,
      );
      return agent;
    });
  }

  async listEvents(id: string): Promise<AgentEvent[]> {
    const result = await this.database.query<AgentEventRow>(
      `SELECT * FROM agent_events
       WHERE agent_id = $1
       ORDER BY seq DESC`,
      [id],
    );
    return result.rows.map(agentEventFromRow);
  }

  async default(): Promise<Agent> {
    const agent = await this.get(DEFAULT_AGENT_ID);
    if (agent === undefined) {
      throw new Error("default fake agent is not configured");
    }
    return agent;
  }

  private async appendEventWithClient(
    client: PoolClient,
    agentId: string,
    kind: AgentEvent["kind"],
    message: string,
    actorId: string,
  ): Promise<void> {
    await client.query(
      `INSERT INTO agent_events (
         id, agent_id, seq, kind, message, actor_id, created_at
       )
       SELECT $1, $2, COALESCE(MAX(seq), 0) + 1, $3, $4, $5, NOW()
       FROM agent_events
       WHERE agent_id = $2`,
      [randomUUID(), agentId, kind, message, actorId],
    );
  }
}

export class TaskRepository {
  constructor(private readonly database: Database) {}

  private readonly selectSql = `SELECT
    task.*,
    ARRAY(
      SELECT dependency.depends_on_task_id::text
      FROM task_dependencies AS dependency
      WHERE dependency.task_id = task.id
      ORDER BY dependency.created_at, dependency.depends_on_task_id
    ) AS depends_on
  FROM tasks AS task`;

  async list(projectId?: string): Promise<Task[]> {
    const result =
      projectId === undefined
        ? await this.database.query<TaskRow>(
            `${this.selectSql} ORDER BY task.updated_at DESC`,
          )
        : await this.database.query<TaskRow>(
            `${this.selectSql}
             WHERE task.project_id = $1
             ORDER BY task.updated_at DESC`,
            [projectId],
          );
    return result.rows.map(taskFromRow);
  }

  async get(id: string): Promise<Task | undefined> {
    const result = await this.database.query<TaskRow>(
      `${this.selectSql} WHERE task.id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : taskFromRow(row);
  }

  async create(
    input: CreateTaskInput,
    agentId: string,
    roleId?: string,
  ): Promise<Task> {
    const taskId = randomUUID();
    await this.database.transaction(async (client) => {
      await client.query(
        `INSERT INTO tasks (
           id, project_id, title, description, acceptance, status,
           agent_id, role_id, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5::jsonb, 'queued', $6, $7, NOW(), NOW())`,
        [
          taskId,
          input.projectId,
          input.title,
          input.description,
          JSON.stringify(input.acceptance),
          agentId,
          roleId ?? null,
        ],
      );
      await this.replaceDependenciesWithClient(
        client,
        taskId,
        input.projectId,
        input.dependsOn,
      );
    });
    const task = await this.get(taskId);
    if (task === undefined) throw new Error("created task is missing");
    return task;
  }

  async update(id: string, input: UpdateTaskInput): Promise<Task | undefined> {
    const existing = await this.get(id);
    if (existing === undefined) return undefined;
    await this.database.transaction(async (client) => {
      await client.query(
        `UPDATE tasks
         SET
           title = COALESCE($2, title),
           description = COALESCE($3, description),
           acceptance = COALESCE($4::jsonb, acceptance),
           updated_at = NOW()
         WHERE id = $1`,
        [
          id,
          input.title ?? null,
          input.description ?? null,
          input.acceptance === undefined
            ? null
            : JSON.stringify(input.acceptance),
        ],
      );
      if (input.dependsOn !== undefined) {
        await this.replaceDependenciesWithClient(
          client,
          id,
          existing.projectId,
          input.dependsOn,
        );
      }
    });
    return this.get(id);
  }

  async listMessages(id: string): Promise<TaskMessage[]> {
    const result = await this.database.query<TaskMessageRow>(
      `SELECT * FROM task_messages
       WHERE task_id = $1
       ORDER BY created_at, id`,
      [id],
    );
    return result.rows.map(taskMessageFromRow);
  }

  async transferAssignee(
    id: string,
    agentId: string,
    roleId?: string,
  ): Promise<Task | undefined> {
    const result = await this.database.query(
      `UPDATE tasks
       SET agent_id = $2, role_id = $3, updated_at = NOW()
       WHERE id = $1
         AND status IN ('queued', 'in_progress', 'review')
         AND NOT EXISTS (
           SELECT 1
           FROM runs
           WHERE runs.task_id = tasks.id
             AND runs.status IN (
               'queued',
               'running',
               'waiting_approval',
               'interrupted'
             )
         )
       RETURNING id`,
      [id, agentId, roleId ?? null],
    );
    return (result.rowCount ?? 0) === 0 ? undefined : this.get(id);
  }

  async addMessage(
    id: string,
    input: CreateTaskMessageInput,
    authorType: TaskMessage["authorType"],
    authorId: string,
    authorName: string,
  ): Promise<TaskMessage> {
    const result = await this.database.query<TaskMessageRow>(
      `INSERT INTO task_messages (
         id, task_id, author_type, author_id, author_name,
         content, reply_to_id, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       RETURNING *`,
      [
        randomUUID(),
        id,
        authorType,
        authorId,
        authorName,
        input.content,
        input.replyToId ?? null,
      ],
    );
    return taskMessageFromRow(result.rows[0]!);
  }

  async setStatus(
    id: string,
    status: TaskStatus,
    client: PoolClient | Database = this.database,
  ): Promise<void> {
    const text =
      "UPDATE tasks SET status = $2, updated_at = NOW() WHERE id = $1";
    if (client instanceof Database) {
      await client.query(text, [id, status]);
    } else {
      await client.query(text, [id, status]);
    }
  }

  private async replaceDependenciesWithClient(
    client: PoolClient,
    taskId: string,
    projectId: string,
    dependsOn: readonly string[],
  ): Promise<void> {
    await client.query("DELETE FROM task_dependencies WHERE task_id = $1", [
      taskId,
    ]);
    for (const dependencyId of dependsOn) {
      await client.query(
        `INSERT INTO task_dependencies (
           task_id, depends_on_task_id, project_id, created_at
         ) VALUES ($1, $2, $3, NOW())`,
        [taskId, dependencyId, projectId],
      );
    }
  }
}

export interface EnqueueRunInput {
  readonly runId: string;
  readonly task: Task;
  readonly inputSnapshot: RunInputSnapshot;
  readonly attempt?: number;
  readonly timeoutAt?: string;
  readonly idempotencyKey?: string;
  readonly maxAttempts?: number;
  readonly workflowInstanceId?: string;
  readonly workflowNodeId?: string;
  readonly trace?: TraceContext;
}

export class RunRepository {
  constructor(private readonly database: Database) {}

  async enqueue(input: EnqueueRunInput): Promise<Run> {
    const trace = input.trace ?? createRootTraceContext();
    return this.database.transaction(async (client) => {
      const result = await client.query<RunRow>(
        `INSERT INTO runs (
           id, project_id, task_id, agent_id, status, input_snapshot,
           observability, attempt, timeout_at, idempotency_key,
           workflow_instance_id, workflow_node_id, trace_id,
           trace_root_span_id, created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, 'queued', $5::jsonb,
           $6::jsonb, $7, $8, $9, $10, $11, $12, $13, NOW(), NOW()
         )
         RETURNING *`,
        [
          input.runId,
          input.task.projectId,
          input.task.id,
          input.task.agentId,
          JSON.stringify(input.inputSnapshot),
          JSON.stringify({
            planVisibility: "structured",
            toolEventCompleteness: "complete",
            textStreaming: "delta",
            subagentVisibility: "none",
          }),
          input.attempt ?? 1,
          input.timeoutAt ?? null,
          input.idempotencyKey ?? null,
          input.workflowInstanceId ?? null,
          input.workflowNodeId ?? null,
          trace.traceId,
          trace.spanId,
        ],
      );
      await client.query(
        `INSERT INTO jobs (
           id, run_id, kind, status, available_at, max_attempts, trace_id,
           created_at, updated_at
         ) VALUES (
           $1, $2, 'agent.run', 'queued', NOW(), $3, $4, NOW(), NOW()
         )`,
        [randomUUID(), input.runId, input.maxAttempts ?? 3, trace.traceId],
      );
      await client.query(
        `INSERT INTO run_events (
           id, run_id, seq, type, visibility, summary, data,
           trace_id, span_id, parent_span_id, created_at
         ) VALUES (
           $1, $2, 1, 'run.queued', 'public', $3, $4::jsonb,
           $5, $6, $7, NOW()
         )`,
        [
          randomUUID(),
          input.runId,
          "Run 已进入执行队列",
          JSON.stringify({ taskId: input.task.id }),
          trace.traceId,
          newSpanId(),
          trace.spanId,
        ],
      );
      await client.query(
        "UPDATE tasks SET status = 'in_progress', updated_at = NOW() WHERE id = $1",
        [input.task.id],
      );
      return runFromRow(result.rows[0]!);
    });
  }

  async get(id: string): Promise<Run | undefined> {
    const result = await this.database.query<RunRow>(
      "SELECT * FROM runs WHERE id = $1",
      [id],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : runFromRow(row);
  }

  async listByTask(taskId: string): Promise<Run[]> {
    const result = await this.database.query<RunRow>(
      "SELECT * FROM runs WHERE task_id = $1 ORDER BY created_at DESC",
      [taskId],
    );
    return result.rows.map(runFromRow);
  }

  async extendWorkflowDeadlines(
    workflowInstanceId: string,
    shiftMs: number,
  ): Promise<void> {
    if (shiftMs <= 0) return;
    await this.database.query(
      `UPDATE runs
       SET
         timeout_at =
           timeout_at + ($2 || ' milliseconds')::interval,
         updated_at = NOW()
       WHERE workflow_instance_id = $1
         AND status IN ('queued', 'running')
         AND timeout_at IS NOT NULL`,
      [workflowInstanceId, shiftMs],
    );
  }

  async markRunning(id: string): Promise<void> {
    await this.database.query(
      `UPDATE runs
       SET status = 'running', started_at = COALESCE(started_at, NOW()), updated_at = NOW()
       WHERE id = $1 AND status = 'queued'`,
      [id],
    );
  }

  async finish(
    id: string,
    status: "completed" | "failed" | "cancelled" | "timeout" | "interrupted",
    output: string | null,
    error: string | null,
  ): Promise<void> {
    await this.database.query(
      `UPDATE runs
       SET status = $2, output = $3, error = $4, ended_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND status IN ('queued', 'running')`,
      [id, status, output, error],
    );
  }

  async timeout(id: string, error: string): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE runs
       SET status = 'timeout', error = $2, ended_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND status IN ('queued', 'running')`,
      [id, error.slice(0, 4_000)],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async appendEvent(
    runId: string,
    type: PlatformRunEventType,
    summary: string,
    data: Record<string, unknown> | null = null,
    visibility: PlatformRunEvent["visibility"] = "public",
    client: PoolClient | Database = this.database,
  ): Promise<PlatformRunEvent> {
    const text = `INSERT INTO run_events (
         id, run_id, seq, type, visibility, summary, data,
         trace_id, span_id, parent_span_id, created_at
       )
       SELECT
         $1,
         $2,
         COALESCE(MAX(event.seq), 0) + 1,
         $3,
         $4,
         $5,
         $6::jsonb,
         run.trace_id,
         $7,
         run.trace_root_span_id,
         NOW()
       FROM runs AS run
       LEFT JOIN run_events AS event ON event.run_id = run.id
       WHERE run.id = $2
       GROUP BY run.id, run.trace_id, run.trace_root_span_id
       RETURNING *`;
    const values = [
      randomUUID(),
      runId,
      type,
      visibility,
      summary,
      data === null ? null : JSON.stringify(data),
      newSpanId(),
    ];
    const result =
      client instanceof Database
        ? await client.query<RunEventRow>(text, values)
        : await client.query<RunEventRow>(text, values);
    return runEventFromRow(result.rows[0]!);
  }

  async appendEventIfAbsent(
    runId: string,
    type: PlatformRunEventType,
    summary: string,
    data: Record<string, unknown> | null = null,
  ): Promise<boolean> {
    return this.database.transaction(async (client) => {
      const existing = await client.query(
        `SELECT 1 FROM run_events
         WHERE run_id = $1 AND type = $2
         LIMIT 1`,
        [runId, type],
      );
      if ((existing.rowCount ?? 0) > 0) return false;
      await this.appendEvent(runId, type, summary, data, "public", client);
      return true;
    });
  }

  async appendDelta(runId: string, text: string): Promise<RunDelta> {
    const result = await this.database.query<RunDeltaRow>(
      `INSERT INTO run_deltas (run_id, seq, text, created_at)
       SELECT $1, COALESCE(MAX(seq), 0) + 1, $2, NOW()
       FROM run_deltas
       WHERE run_id = $1
       RETURNING *`,
      [runId, text],
    );
    return runDeltaFromRow(result.rows[0]!);
  }

  async listEvents(runId: string, afterSeq = 0): Promise<PlatformRunEvent[]> {
    const result = await this.database.query<RunEventRow>(
      `SELECT * FROM run_events
       WHERE run_id = $1 AND seq > $2
       ORDER BY seq`,
      [runId, afterSeq],
    );
    return result.rows.map(runEventFromRow);
  }

  async listDeltas(runId: string, afterSeq = 0): Promise<RunDelta[]> {
    const result = await this.database.query<RunDeltaRow>(
      `SELECT * FROM run_deltas
       WHERE run_id = $1 AND seq > $2
       ORDER BY seq`,
      [runId, afterSeq],
    );
    return result.rows.map(runDeltaFromRow);
  }

  async cancel(id: string): Promise<boolean> {
    return this.database.transaction(async (client) => {
      const result = await client.query<RunRow>(
        `UPDATE runs
         SET status = 'cancelled', ended_at = NOW(), updated_at = NOW()
         WHERE id = $1
           AND status NOT IN ('completed', 'failed', 'cancelled')
         RETURNING *`,
        [id],
      );
      if (result.rowCount === 0) return false;
      await client.query(
        `UPDATE jobs SET status = 'cancelled', updated_at = NOW()
         WHERE run_id = $1 AND status IN ('queued', 'running')`,
        [id],
      );
      await client.query(
        `UPDATE runtime_effect_receipts
         SET
           cancel_requested_at = COALESCE(cancel_requested_at, NOW()),
           updated_at = NOW()
         WHERE run_id = $1 AND status = 'running'`,
        [id],
      );
      const run = runFromRow(result.rows[0]!);
      if (run.taskId !== null) {
        await client.query(
          "UPDATE tasks SET status = 'cancelled', updated_at = NOW() WHERE id = $1",
          [run.taskId],
        );
      }
      await this.appendEvent(
        id,
        "run.cancelled",
        "用户取消了本次 Run",
        null,
        "public",
        client,
      );
      return true;
    });
  }
}

export interface ClaimedJob {
  readonly id: string;
  readonly runId: string;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly leaseToken: string;
  readonly recoveredRun: boolean;
  readonly traceId: string;
  readonly spanId: string;
}

export interface RecoveredExpiredJob {
  readonly jobId: string;
  readonly runId: string;
  readonly attempts: number;
  readonly outcome: "retry_scheduled" | "dead_letter";
}

export interface FailedJobResult {
  readonly outcome: "retry_scheduled" | "dead_letter" | "ignored";
  readonly availableAt?: string;
}

interface JobRow {
  id: string;
  run_id: string;
  kind: string;
  status: Job["status"];
  attempts: number;
  max_attempts: number;
  trace_id: string | null;
  available_at: Date;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  last_heartbeat_at: Date | null;
  last_error: string | null;
  recovery_count: number;
  manual_recovery_count: number;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
  dead_letter_at: Date | null;
}

function jobFromRow(row: JobRow): Job {
  return {
    id: row.id,
    runId: row.run_id,
    kind: row.kind,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    traceId: row.trace_id,
    availableAt: row.available_at.toISOString(),
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at?.toISOString() ?? null,
    lastHeartbeatAt: row.last_heartbeat_at?.toISOString() ?? null,
    lastError: row.last_error,
    recoveryCount: row.recovery_count,
    manualRecoveryCount: row.manual_recovery_count,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
    deadLetterAt: row.dead_letter_at?.toISOString() ?? null,
  };
}

export function jobRetryDelayMs(
  attempts: number,
  baseDelayMs: number,
  maxDelayMs: number,
): number {
  const exponent = Math.max(0, attempts - 1);
  return Math.min(maxDelayMs, baseDelayMs * 2 ** exponent);
}

export class JobRepository {
  constructor(private readonly database: Database) {}

  async claimNext(
    owner: string,
    leaseSeconds: number,
    runId?: string,
  ): Promise<ClaimedJob | undefined> {
    return this.database.transaction(async (client) => {
      const candidate = await client.query<{
        id: string;
        run_id: string;
        attempts: number;
        max_attempts: number;
        run_status: string;
        task_id: string | null;
        trace_id: string | null;
        trace_root_span_id: string | null;
      }>(
        `SELECT
           job.id,
           job.run_id,
           job.attempts,
           job.max_attempts,
           run.status AS run_status,
           run.task_id,
           COALESCE(job.trace_id, run.trace_id) AS trace_id,
           run.trace_root_span_id
         FROM jobs AS job
         JOIN runs AS run ON run.id = job.run_id
         WHERE job.status = 'queued'
           AND job.available_at <= NOW()
           AND job.attempts < job.max_attempts
           AND ($1::uuid IS NULL OR job.run_id = $1)
         ORDER BY job.available_at, job.created_at
         FOR UPDATE OF job SKIP LOCKED
         LIMIT 1`,
        [runId ?? null],
      );
      const row = candidate.rows[0];
      if (row === undefined) return undefined;
      const leaseToken = randomUUID();
      const traceId =
        row.trace_id ??
        (
          await client.query<{ trace_id: string }>(
            "SELECT trace_id FROM runs WHERE id = $1",
            [row.run_id],
          )
        ).rows[0]?.trace_id;
      if (traceId === undefined) {
        throw new Error("claimed job is missing a trace id");
      }
      const spanId = newSpanId();
      await client.query(
        "UPDATE jobs SET trace_id = COALESCE(trace_id, $2) WHERE id = $1",
        [row.id, traceId],
      );
      const claimed = await client.query<{
        attempts: number;
      }>(
        `UPDATE jobs
         SET
           status = 'running',
           attempts = attempts + 1,
           lease_owner = $2,
           lease_token = $3,
           lease_expires_at = NOW() + ($4 || ' seconds')::interval,
           last_attempt_at = NOW(),
           last_heartbeat_at = NOW(),
           updated_at = NOW()
         WHERE id = $1
         RETURNING attempts`,
        [row.id, owner, leaseToken, leaseSeconds],
      );
      const attempts = claimed.rows[0]!.attempts;
      await client.query(
        `INSERT INTO job_attempts (
           id, job_id, attempt, worker_id, lease_token, status,
           trace_id, span_id,
           started_at, heartbeat_at
         ) VALUES ($1, $2, $3, $4, $5, 'running', $6, $7, NOW(), NOW())`,
        [randomUUID(), row.id, attempts, owner, leaseToken, traceId, spanId],
      );
      if (row.run_status === "interrupted") {
        await client.query(
          `UPDATE runs
           SET status = 'queued', error = NULL, ended_at = NULL, updated_at = NOW()
           WHERE id = $1 AND status = 'interrupted'`,
          [row.run_id],
        );
        await client.query(
          `INSERT INTO run_events (
             id, run_id, seq, type, visibility, summary, data,
             trace_id, span_id, parent_span_id, created_at
           )
           SELECT
             $1, $2, COALESCE(MAX(seq), 0) + 1,
             'run.recovered', 'public', $3, $4::jsonb,
             $5, $6, $7, NOW()
           FROM run_events
           WHERE run_id = $2`,
          [
            randomUUID(),
            row.run_id,
            "Run 已由新的 Worker 租约恢复",
            JSON.stringify({ workerId: owner, attempt: attempts }),
            traceId,
            newSpanId(),
            row.trace_root_span_id,
          ],
        );
      }
      if (row.task_id !== null) {
        await client.query(
          `UPDATE tasks
           SET status = 'in_progress', updated_at = NOW()
           WHERE id = $1 AND status = 'queued'`,
          [row.task_id],
        );
      }
      return {
        id: row.id,
        runId: row.run_id,
        attempts,
        maxAttempts: row.max_attempts,
        leaseToken,
        recoveredRun: row.run_status === "interrupted",
        traceId,
        spanId,
      };
    });
  }

  async renewLease(
    id: string,
    owner: string,
    leaseToken: string,
    leaseSeconds: number,
    options: {
      readonly expectedRenewIntervalMs?: number;
    } = {},
  ): Promise<boolean> {
    return this.database.transaction(async (client) => {
      const result = await client.query(
        `UPDATE jobs
         SET
           lease_expires_at = NOW() + ($4 || ' seconds')::interval,
           last_heartbeat_at = NOW(),
           updated_at = NOW()
         WHERE id = $1
           AND status = 'running'
           AND lease_owner = $2
           AND lease_token = $3
         RETURNING id`,
        [id, owner, leaseToken, leaseSeconds],
      );
      if ((result.rowCount ?? 0) === 0) return false;
      await client.query(
        `UPDATE job_attempts
         SET
           heartbeat_at = NOW(),
           lease_renew_interval_ms =
             COALESCE($3, lease_renew_interval_ms),
           lease_jitter_ms =
             CASE
               WHEN $3 IS NULL THEN lease_jitter_ms
               ELSE ABS(
                 EXTRACT(EPOCH FROM (NOW() - heartbeat_at)) * 1000 - $3
               )
             END
         WHERE job_id = $1 AND lease_token = $2 AND status = 'running'`,
        [id, leaseToken, options.expectedRenewIntervalMs ?? null],
      );
      return true;
    });
  }

  async hasLease(
    id: string,
    owner: string,
    leaseToken: string,
  ): Promise<boolean> {
    const result = await this.database.query(
      `SELECT 1
       FROM jobs
       WHERE id = $1
         AND status = 'running'
         AND lease_owner = $2
         AND lease_token = $3
         AND lease_expires_at > NOW()`,
      [id, owner, leaseToken],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async complete(
    id: string,
    owner: string,
    leaseToken: string,
  ): Promise<boolean> {
    return this.database.transaction(async (client) => {
      const result = await client.query(
        `UPDATE jobs
         SET
           status = 'completed',
           lease_owner = NULL,
           lease_token = NULL,
           lease_expires_at = NULL,
           completed_at = NOW(),
           updated_at = NOW()
         WHERE id = $1
           AND status = 'running'
           AND lease_owner = $2
           AND lease_token = $3
         RETURNING id`,
        [id, owner, leaseToken],
      );
      if ((result.rowCount ?? 0) === 0) return false;
      await client.query(
        `UPDATE job_attempts
         SET status = 'completed', ended_at = NOW(), heartbeat_at = NOW()
         WHERE job_id = $1 AND lease_token = $2 AND status = 'running'`,
        [id, leaseToken],
      );
      return true;
    });
  }

  async fail(
    id: string,
    owner: string,
    leaseToken: string,
    error: string,
    options: {
      readonly baseBackoffMs?: number;
      readonly maxBackoffMs?: number;
    } = {},
  ): Promise<FailedJobResult> {
    return this.database.transaction(async (client) => {
      const current = await client.query<{
        run_id: string;
        attempts: number;
        max_attempts: number;
        task_id: string | null;
      }>(
        `SELECT
           job.run_id,
           job.attempts,
           job.max_attempts,
           run.task_id
         FROM jobs AS job
         JOIN runs AS run ON run.id = job.run_id
         WHERE job.id = $1
           AND job.status = 'running'
           AND job.lease_owner = $2
           AND job.lease_token = $3
         FOR UPDATE OF job`,
        [id, owner, leaseToken],
      );
      const row = current.rows[0];
      if (row === undefined) return { outcome: "ignored" };
      const safeError = error.slice(0, 4_000);
      const hasAttempts = row.attempts < row.max_attempts;
      if (hasAttempts) {
        const delayMs = jobRetryDelayMs(
          row.attempts,
          options.baseBackoffMs ?? 1_000,
          options.maxBackoffMs ?? 60_000,
        );
        const updated = await client.query<{ available_at: Date }>(
          `UPDATE jobs
           SET
             status = 'queued',
             available_at = NOW() + ($2 || ' milliseconds')::interval,
             last_error = $3,
             lease_owner = NULL,
             lease_token = NULL,
             lease_expires_at = NULL,
             updated_at = NOW()
           WHERE id = $1
           RETURNING available_at`,
          [id, delayMs, safeError],
        );
        await client.query(
          `UPDATE runs
           SET status = 'queued', error = NULL, ended_at = NULL, updated_at = NOW()
           WHERE id = $1 AND status IN ('queued', 'running')`,
          [row.run_id],
        );
        await client.query(
          `UPDATE job_attempts
           SET status = 'failed', error = $3, ended_at = NOW()
           WHERE job_id = $1 AND lease_token = $2 AND status = 'running'`,
          [id, leaseToken, safeError],
        );
        await appendRunEventWithClient(
          client,
          row.run_id,
          "job.retry_scheduled",
          "Job 执行失败，已按退避策略重新排队",
          {
            jobId: id,
            attempt: row.attempts,
            maxAttempts: row.max_attempts,
            retryDelayMs: delayMs,
            error: safeError,
          },
        );
        return {
          outcome: "retry_scheduled",
          availableAt: updated.rows[0]!.available_at.toISOString(),
        };
      }
      await client.query(
        `UPDATE jobs
         SET
           status = 'dead_letter',
           last_error = $2,
           lease_owner = NULL,
           lease_token = NULL,
           lease_expires_at = NULL,
           dead_letter_at = NOW(),
           updated_at = NOW()
         WHERE id = $1`,
        [id, safeError],
      );
      await client.query(
        `UPDATE job_attempts
         SET status = 'dead_letter', error = $3, ended_at = NOW()
         WHERE job_id = $1 AND lease_token = $2 AND status = 'running'`,
        [id, leaseToken, safeError],
      );
      await client.query(
        `UPDATE runs
         SET status = 'failed', error = $2, ended_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND status IN ('queued', 'running')`,
        [row.run_id, safeError],
      );
      if (row.task_id !== null) {
        await client.query(
          `UPDATE tasks
           SET status = 'queued', updated_at = NOW()
           WHERE id = $1 AND status = 'in_progress'`,
          [row.task_id],
        );
      } else {
        await failMeetingTurnWithClient(
          client,
          row.run_id,
          "meeting_ai_runtime_failed",
          safeError,
        );
      }
      await appendRunEventWithClient(
        client,
        row.run_id,
        "job.dead_lettered",
        "Job 已达到最大尝试次数并进入死信队列",
        {
          jobId: id,
          attempts: row.attempts,
          maxAttempts: row.max_attempts,
          error: safeError,
        },
      );
      return { outcome: "dead_letter" };
    });
  }

  async interrupt(
    id: string,
    owner: string,
    leaseToken: string,
    reason: string,
  ): Promise<boolean> {
    return this.database.transaction(async (client) => {
      const current = await client.query<{
        run_id: string;
        attempts: number;
        max_attempts: number;
        task_id: string | null;
      }>(
        `SELECT
           job.run_id,
           job.attempts,
           job.max_attempts,
           run.task_id
         FROM jobs AS job
         JOIN runs AS run ON run.id = job.run_id
         WHERE job.id = $1
           AND job.status = 'running'
           AND job.lease_owner = $2
           AND job.lease_token = $3
         FOR UPDATE OF job`,
        [id, owner, leaseToken],
      );
      const row = current.rows[0];
      if (row === undefined) return false;
      const exhausted = row.attempts >= row.max_attempts;
      await client.query(
        `UPDATE jobs
         SET
           status = $2,
           last_error = $3,
           lease_owner = NULL,
           lease_token = NULL,
           lease_expires_at = NULL,
           dead_letter_at = CASE WHEN $2 = 'dead_letter' THEN NOW() ELSE NULL END,
           updated_at = NOW()
         WHERE id = $1`,
        [id, exhausted ? "dead_letter" : "queued", reason.slice(0, 4_000)],
      );
      await client.query(
        `UPDATE job_attempts
         SET status = $3, error = $4, ended_at = NOW()
         WHERE job_id = $1 AND lease_token = $2 AND status = 'running'`,
        [
          id,
          leaseToken,
          exhausted ? "dead_letter" : "interrupted",
          reason.slice(0, 4_000),
        ],
      );
      await client.query(
        `UPDATE runs
         SET status = 'interrupted', error = $2, ended_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND status IN ('queued', 'running')`,
        [row.run_id, reason.slice(0, 4_000)],
      );
      if (row.task_id !== null) {
        await client.query(
          `UPDATE tasks
           SET status = 'queued', updated_at = NOW()
           WHERE id = $1 AND status = 'in_progress'`,
          [row.task_id],
        );
      } else if (exhausted) {
        await failMeetingTurnWithClient(
          client,
          row.run_id,
          "meeting_ai_interrupted",
          reason,
        );
      }
      await appendRunEventWithClient(
        client,
        row.run_id,
        "run.interrupted",
        exhausted
          ? "Worker 强制停机，Job 已进入死信队列"
          : "Worker 强制停机，Job 已安全释放以便恢复",
        { reason, jobId: id, attempts: row.attempts },
      );
      return true;
    });
  }

  async recoverExpiredLeases(
    limit: number,
    options: {
      readonly baseBackoffMs?: number;
      readonly maxBackoffMs?: number;
    } = {},
  ): Promise<RecoveredExpiredJob[]> {
    return this.database.transaction(async (client) => {
      const expired = await client.query<JobRow>(
        `SELECT job.*
         FROM jobs AS job
         WHERE job.status = 'running'
           AND job.lease_expires_at <= NOW()
         ORDER BY job.lease_expires_at
         FOR UPDATE SKIP LOCKED
         LIMIT $1`,
        [limit],
      );
      const recovered: RecoveredExpiredJob[] = [];
      for (const job of expired.rows) {
        const outcome =
          job.attempts < job.max_attempts ? "retry_scheduled" : "dead_letter";
        const delayMs =
          outcome === "retry_scheduled"
            ? jobRetryDelayMs(
                job.attempts,
                options.baseBackoffMs ?? 1_000,
                options.maxBackoffMs ?? 60_000,
              )
            : 0;
        await client.query(
          `UPDATE jobs
           SET
             status = $2,
             available_at =
               CASE WHEN $2 = 'queued'
                 THEN NOW() + ($3 || ' milliseconds')::interval
                 ELSE available_at
               END,
             last_error = 'worker lease expired',
             lease_owner = NULL,
             lease_token = NULL,
             lease_expires_at = NULL,
             recovery_count = recovery_count + 1,
             dead_letter_at = CASE WHEN $2 = 'dead_letter' THEN NOW() ELSE NULL END,
             updated_at = NOW()
           WHERE id = $1`,
          [
            job.id,
            outcome === "retry_scheduled" ? "queued" : "dead_letter",
            delayMs,
          ],
        );
        await client.query(
          `UPDATE job_attempts
           SET status = 'interrupted', ended_at = NOW(),
               error = COALESCE(error, 'worker lease expired')
           WHERE job_id = $1 AND status = 'running'`,
          [job.id],
        );
        const interrupted = await client.query<{ task_id: string }>(
          `UPDATE runs
           SET
             status = 'interrupted',
             error = 'worker lease expired',
             ended_at = NOW(),
             updated_at = NOW()
           WHERE id = $1 AND status IN ('queued', 'running')
           RETURNING task_id`,
          [job.run_id],
        );
        const taskId = interrupted.rows[0]?.task_id;
        if (taskId !== undefined) {
          if (taskId === null && outcome === "dead_letter") {
            await failMeetingTurnWithClient(
              client,
              job.run_id,
              "meeting_ai_lease_expired",
              "Worker lease expired after all retry attempts",
            );
          } else if (taskId !== null) {
            await client.query(
              `UPDATE tasks
               SET status = 'queued', updated_at = NOW()
               WHERE id = $1`,
              [taskId],
            );
          }
        }
        await appendRunEventWithClient(
          client,
          job.run_id,
          "run.interrupted",
          "Worker 租约过期，Run 已标记为中断",
          {
            reason: "worker lease expired",
            jobId: job.id,
            attempt: job.attempts,
            outcome,
          },
        );
        await appendRunEventWithClient(
          client,
          job.run_id,
          outcome === "retry_scheduled"
            ? "job.retry_scheduled"
            : "job.dead_lettered",
          outcome === "retry_scheduled"
            ? "过期 Job 已按退避策略恢复排队"
            : "过期 Job 已达到最大尝试次数并进入死信队列",
          {
            jobId: job.id,
            attempts: job.attempts,
            maxAttempts: job.max_attempts,
            retryDelayMs: delayMs,
          },
        );
        recovered.push({
          jobId: job.id,
          runId: job.run_id,
          attempts: job.attempts,
          outcome,
        });
      }
      return recovered;
    });
  }

  async recoverDeadLetter(
    id: string,
    actorId: string,
    reason: string,
  ): Promise<Job | undefined> {
    return this.database.transaction(async (client) => {
      const current = await client.query<JobRow & { task_id: string | null }>(
        `SELECT job.*, run.task_id
         FROM jobs AS job
         JOIN runs AS run ON run.id = job.run_id
         WHERE job.id = $1
           AND job.status IN ('dead_letter', 'failed')
         FOR UPDATE OF job`,
        [id],
      );
      const job = current.rows[0];
      if (job === undefined) return undefined;
      const updated = await client.query<JobRow>(
        `UPDATE jobs
         SET
           status = 'queued',
           max_attempts = LEAST(100, GREATEST(max_attempts + 1, attempts + 1)),
           available_at = NOW(),
           last_error = NULL,
           lease_owner = NULL,
           lease_token = NULL,
           lease_expires_at = NULL,
           dead_letter_at = NULL,
           manual_recovery_count = manual_recovery_count + 1,
           updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [id],
      );
      await client.query(
        `UPDATE runs
         SET status = 'queued', error = NULL, ended_at = NULL, updated_at = NOW()
         WHERE id = $1 AND status IN ('failed', 'interrupted')`,
        [job.run_id],
      );
      if (job.task_id !== null) {
        await client.query(
          `UPDATE tasks
           SET status = 'in_progress', updated_at = NOW()
           WHERE id = $1 AND status = 'queued'`,
          [job.task_id],
        );
      }
      await appendRunEventWithClient(
        client,
        job.run_id,
        "job.manually_recovered",
        "死信 Job 已由人工恢复",
        { jobId: id, actorId, reason },
      );
      await appendRunEventWithClient(
        client,
        job.run_id,
        "run.recovered",
        "Run 已由人工恢复并重新进入执行队列",
        { jobId: id, actorId },
      );
      return jobFromRow(updated.rows[0]!);
    });
  }

  async get(id: string): Promise<Job | undefined> {
    const result = await this.database.query<JobRow>(
      "SELECT * FROM jobs WHERE id = $1",
      [id],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : jobFromRow(row);
  }

  async list(input: {
    readonly status?: Job["status"];
    readonly limit?: number;
  }): Promise<Job[]> {
    const result = await this.database.query<JobRow>(
      `SELECT *
       FROM jobs
       WHERE ($1::text IS NULL OR status = $1)
       ORDER BY updated_at DESC
       LIMIT $2`,
      [input.status ?? null, input.limit ?? 50],
    );
    return result.rows.map(jobFromRow);
  }
}

async function appendRunEventWithClient(
  client: PoolClient,
  runId: string,
  type: PlatformRunEventType,
  summary: string,
  data: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO run_events (
       id, run_id, seq, type, visibility, summary, data,
       trace_id, span_id, parent_span_id, created_at
     )
     SELECT
       $1, $2, COALESCE(MAX(event.seq), 0) + 1, $3, 'public', $4, $5::jsonb,
       run.trace_id, $6, run.trace_root_span_id, NOW()
     FROM runs AS run
     LEFT JOIN run_events AS event ON event.run_id = run.id
     WHERE run.id = $2
     GROUP BY run.id, run.trace_id, run.trace_root_span_id`,
    [randomUUID(), runId, type, summary, JSON.stringify(data), newSpanId()],
  );
}

export class PlatformRepositories {
  readonly projects: ProjectRepository;
  readonly agents: AgentRepository;
  readonly tasks: TaskRepository;
  readonly taskCollaboration: TaskCollaborationRepository;
  readonly runs: RunRepository;
  readonly jobs: JobRepository;
  readonly contexts: ContextRepository;
  readonly projectMemberships: ProjectMembershipRepository;
  readonly projectTemplates: ProjectTemplatesRepository;
  readonly artifacts: ArtifactRepository;
  readonly memory: MemoryRepository;
  readonly memoryClosure: MemoryClosureRepository;
  readonly reviews: ReviewRepository;
  readonly workflows: WorkflowRepository;
  readonly workflowRuntime: WorkflowRuntimeRepository;
  readonly workflowIdempotency: WorkflowIdempotencyRepository;
  readonly meetings: MeetingRepository;
  readonly meetingAi: MeetingAiRepository;
  readonly meetingDecisions: MeetingDecisionsRepository;
  readonly workbench: WorkbenchRepository;
  readonly workbenchReports: WorkbenchReportsRepository;
  readonly runtimeReliability: RuntimeReliabilityRepository;
  readonly runtimeEffects: RuntimeEffectRepository;
  readonly traces: RuntimeTraceRepository;

  constructor(database: Database) {
    this.projects = new ProjectRepository(database);
    this.agents = new AgentRepository(database);
    this.tasks = new TaskRepository(database);
    this.taskCollaboration = new TaskCollaborationRepository(database);
    this.runs = new RunRepository(database);
    this.jobs = new JobRepository(database);
    this.contexts = new ContextRepository(database);
    this.projectMemberships = new ProjectMembershipRepository(database);
    this.projectTemplates = new ProjectTemplatesRepository(database);
    this.artifacts = new ArtifactRepository(database);
    this.memory = new MemoryRepository(database);
    this.memoryClosure = new MemoryClosureRepository(database, this.memory);
    this.reviews = new ReviewRepository(database);
    this.workflows = new WorkflowRepository(database);
    this.workflowRuntime = new WorkflowRuntimeRepository(database);
    this.workflowIdempotency = new WorkflowIdempotencyRepository(database);
    this.meetings = new MeetingRepository(database);
    this.meetingAi = new MeetingAiRepository(database);
    this.meetingDecisions = new MeetingDecisionsRepository(database);
    this.workbench = new WorkbenchRepository(database);
    this.workbenchReports = new WorkbenchReportsRepository(database);
    this.runtimeReliability = new RuntimeReliabilityRepository(database);
    this.runtimeEffects = new RuntimeEffectRepository(database);
    this.traces = new RuntimeTraceRepository(database);
  }
}
