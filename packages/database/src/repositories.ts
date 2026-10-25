import { randomUUID } from "node:crypto";
import type {
  Agent,
  CreateProjectInput,
  CreateTaskInput,
  PlatformRunEvent,
  PlatformRunEventType,
  Project,
  Run,
  RunDelta,
  RunInputSnapshot,
  Task,
  TaskStatus,
} from "@pluginmax/contracts";
import type { PoolClient } from "pg";
import { Database } from "./database.js";
import {
  agentFromRow,
  projectFromRow,
  runDeltaFromRow,
  runEventFromRow,
  runFromRow,
  taskFromRow,
  type AgentRow,
  type ProjectRow,
  type RunDeltaRow,
  type RunEventRow,
  type RunRow,
  type TaskRow,
} from "./rows.js";
import { DEFAULT_AGENT_ID } from "./schema.js";
import { ContextRepository } from "./context-repository.js";
import {
  ArtifactRepository,
  MeetingRepository,
  MemoryRepository,
  ReviewRepository,
  WorkbenchRepository,
  WorkflowRepository,
} from "./collaboration-repositories.js";

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
    const result = await this.database.query<ProjectRow>(
      `INSERT INTO projects (
         id, name, code, description, status, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, 'active', NOW(), NOW())
       RETURNING *`,
      [id, input.name, code, input.description],
    );
    return projectFromRow(result.rows[0]!);
  }
}

export class AgentRepository {
  constructor(private readonly database: Database) {}

  async list(): Promise<Agent[]> {
    const result = await this.database.query<AgentRow>(
      `SELECT * FROM agents
       WHERE status = 'active'
       ORDER BY CASE runtime_kind WHEN 'fake' THEN 0 ELSE 1 END, name`,
    );
    return result.rows.map(agentFromRow);
  }

  async get(id: string): Promise<Agent | undefined> {
    const result = await this.database.query<AgentRow>(
      "SELECT * FROM agents WHERE id = $1 AND status = 'active'",
      [id],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : agentFromRow(row);
  }

  async default(): Promise<Agent> {
    const agent = await this.get(DEFAULT_AGENT_ID);
    if (agent === undefined) {
      throw new Error("default fake agent is not configured");
    }
    return agent;
  }
}

export class TaskRepository {
  constructor(private readonly database: Database) {}

  async list(projectId?: string): Promise<Task[]> {
    const result =
      projectId === undefined
        ? await this.database.query<TaskRow>(
            "SELECT * FROM tasks ORDER BY updated_at DESC",
          )
        : await this.database.query<TaskRow>(
            "SELECT * FROM tasks WHERE project_id = $1 ORDER BY updated_at DESC",
            [projectId],
          );
    return result.rows.map(taskFromRow);
  }

  async get(id: string): Promise<Task | undefined> {
    const result = await this.database.query<TaskRow>(
      "SELECT * FROM tasks WHERE id = $1",
      [id],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : taskFromRow(row);
  }

  async create(input: CreateTaskInput, agentId: string): Promise<Task> {
    const result = await this.database.query<TaskRow>(
      `INSERT INTO tasks (
         id, project_id, title, description, acceptance, status,
         agent_id, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5::jsonb, 'queued', $6, NOW(), NOW())
       RETURNING *`,
      [
        randomUUID(),
        input.projectId,
        input.title,
        input.description,
        JSON.stringify(input.acceptance),
        agentId,
      ],
    );
    return taskFromRow(result.rows[0]!);
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
}

export interface EnqueueRunInput {
  readonly runId: string;
  readonly task: Task;
  readonly inputSnapshot: RunInputSnapshot;
}

export class RunRepository {
  constructor(private readonly database: Database) {}

  async enqueue(input: EnqueueRunInput): Promise<Run> {
    return this.database.transaction(async (client) => {
      const result = await client.query<RunRow>(
        `INSERT INTO runs (
           id, project_id, task_id, agent_id, status, input_snapshot,
           observability, created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, 'queued', $5::jsonb,
           $6::jsonb, NOW(), NOW()
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
    status: "completed" | "failed" | "cancelled",
    output: string | null,
    error: string | null,
  ): Promise<void> {
    await this.database.query(
      `UPDATE runs
       SET status = $2, output = $3, error = $4, ended_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND status NOT IN ('completed', 'failed', 'cancelled')`,
      [id, status, output, error],
    );
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
  readonly runs: RunRepository;
  readonly jobs: JobRepository;
  readonly contexts: ContextRepository;
  readonly artifacts: ArtifactRepository;
  readonly memory: MemoryRepository;
  readonly reviews: ReviewRepository;
  readonly workflows: WorkflowRepository;
  readonly meetings: MeetingRepository;
  readonly workbench: WorkbenchRepository;

  constructor(database: Database) {
    this.projects = new ProjectRepository(database);
    this.agents = new AgentRepository(database);
    this.tasks = new TaskRepository(database);
    this.runs = new RunRepository(database);
    this.jobs = new JobRepository(database);
    this.contexts = new ContextRepository(database);
    this.artifacts = new ArtifactRepository(database);
    this.memory = new MemoryRepository(database);
    this.reviews = new ReviewRepository(database);
    this.workflows = new WorkflowRepository(database);
    this.meetings = new MeetingRepository(database);
    this.workbench = new WorkbenchRepository(database);
  }
}
