import { randomUUID } from "node:crypto";
import type {
  Agent,
  AgentEvent,
  CreateAgentInput,
  CreateProjectInput,
  CreateTaskInput,
  CreateTaskMessageInput,
  PlatformRunEvent,
  PlatformRunEventType,
  Project,
  Run,
  RunDelta,
  RunInputSnapshot,
  Task,
  TaskMessage,
  TaskStatus,
  UpdateAgentInput,
  UpdateProjectInput,
  UpdateTaskInput,
} from "@pluginmax/contracts";
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
import { WorkflowRuntimeRepository } from "./workflow-runtime-repository.js";

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

  async create(input: CreateProjectInput): Promise<Project> {
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
           id, project_id, name, description, created_at, updated_at
         ) VALUES ($1, $2, '项目负责人', $3, NOW(), NOW())`,
        [roleId, id, responsibility],
      );
      await client.query(
        `INSERT INTO project_members (
           id, project_id, kind, actor_id, name, responsibility,
           status, is_owner, created_at, updated_at
         ) VALUES ($1, $2, 'human', 'local-admin', 'Local Admin', $3,
                   'active', TRUE, NOW(), NOW())`,
        [memberId, id, responsibility],
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
  readonly workflowInstanceId?: string;
  readonly workflowNodeId?: string;
}

export class RunRepository {
  constructor(private readonly database: Database) {}

  async enqueue(input: EnqueueRunInput): Promise<Run> {
    return this.database.transaction(async (client) => {
      const result = await client.query<RunRow>(
        `INSERT INTO runs (
           id, project_id, task_id, agent_id, status, input_snapshot,
           observability, attempt, timeout_at, idempotency_key,
           workflow_instance_id, workflow_node_id, created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, 'queued', $5::jsonb,
           $6::jsonb, $7, $8, $9, $10, $11, NOW(), NOW()
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
        ],
      );
      await client.query(
        `INSERT INTO jobs (
           id, run_id, kind, status, available_at, created_at, updated_at
         ) VALUES ($1, $2, 'agent.run', 'queued', NOW(), NOW(), NOW())`,
        [randomUUID(), input.runId],
      );
      await client.query(
        `INSERT INTO run_events (
           id, run_id, seq, type, visibility, summary, data, created_at
         ) VALUES ($1, $2, 1, 'run.queued', 'public', $3, $4::jsonb, NOW())`,
        [
          randomUUID(),
          input.runId,
          "Run 已进入执行队列",
          JSON.stringify({ taskId: input.task.id }),
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
         id, run_id, seq, type, visibility, summary, data, created_at
       )
       SELECT
         $1,
         $2,
         COALESCE(MAX(seq), 0) + 1,
         $3,
         $4,
         $5,
         $6::jsonb,
         NOW()
       FROM run_events
       WHERE run_id = $2
       RETURNING *`;
    const values = [
      randomUUID(),
      runId,
      type,
      visibility,
      summary,
      data === null ? null : JSON.stringify(data),
    ];
    const result =
      client instanceof Database
        ? await client.query<RunEventRow>(text, values)
        : await client.query<RunEventRow>(text, values);
    return runEventFromRow(result.rows[0]!);
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
      const run = runFromRow(result.rows[0]!);
      await client.query(
        "UPDATE tasks SET status = 'cancelled', updated_at = NOW() WHERE id = $1",
        [run.taskId],
      );
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
}

export class JobRepository {
  constructor(private readonly database: Database) {}

  async claimNext(
    owner: string,
    leaseSeconds: number,
  ): Promise<ClaimedJob | undefined> {
    const result = await this.database.query<{
      id: string;
      run_id: string;
      attempts: number;
    }>(
      `WITH candidate AS (
         SELECT id
         FROM jobs
         WHERE status = 'queued'
            OR (status = 'running' AND lease_expires_at < NOW())
         ORDER BY available_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE jobs AS job
       SET
         status = 'running',
         attempts = job.attempts + 1,
         lease_owner = $1,
         lease_expires_at = NOW() + ($2 || ' seconds')::interval,
         updated_at = NOW()
       FROM candidate
       WHERE job.id = candidate.id
       RETURNING job.id, job.run_id, job.attempts`,
      [owner, leaseSeconds],
    );
    const row = result.rows[0];
    return row === undefined
      ? undefined
      : { id: row.id, runId: row.run_id, attempts: row.attempts };
  }

  async complete(id: string): Promise<void> {
    await this.database.query(
      `UPDATE jobs
       SET status = 'completed', lease_owner = NULL, lease_expires_at = NULL, updated_at = NOW()
       WHERE id = $1 AND status = 'running'`,
      [id],
    );
  }

  async fail(id: string, error: string): Promise<void> {
    await this.database.query(
      `UPDATE jobs
       SET status = 'failed', last_error = $2,
           lease_owner = NULL, lease_expires_at = NULL, updated_at = NOW()
       WHERE id = $1`,
      [id, error.slice(0, 4_000)],
    );
  }
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
  readonly artifacts: ArtifactRepository;
  readonly memory: MemoryRepository;
  readonly reviews: ReviewRepository;
  readonly workflows: WorkflowRepository;
  readonly workflowRuntime: WorkflowRuntimeRepository;
  readonly meetings: MeetingRepository;
  readonly workbench: WorkbenchRepository;

  constructor(database: Database) {
    this.projects = new ProjectRepository(database);
    this.agents = new AgentRepository(database);
    this.tasks = new TaskRepository(database);
    this.taskCollaboration = new TaskCollaborationRepository(database);
    this.runs = new RunRepository(database);
    this.jobs = new JobRepository(database);
    this.contexts = new ContextRepository(database);
    this.projectMemberships = new ProjectMembershipRepository(database);
    this.artifacts = new ArtifactRepository(database);
    this.memory = new MemoryRepository(database);
    this.reviews = new ReviewRepository(database);
    this.workflows = new WorkflowRepository(database);
    this.workflowRuntime = new WorkflowRuntimeRepository(database);
    this.meetings = new MeetingRepository(database);
    this.workbench = new WorkbenchRepository(database);
  }
}
