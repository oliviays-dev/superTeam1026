import { randomUUID } from "node:crypto";
import type {
  ActionTicket,
  Agent,
  AgentEvent,
  ClaimTaskInput,
  CreateAgentInput,
  CreateProjectInput,
  CreateTaskInput,
  CreateTaskMessageInput,
  ExternalRunExecutionSnapshot,
  ExecutionGateRequest,
  Job,
  PlatformRunEvent,
  PlatformRunEventType,
  Project,
  Run,
  RunDelta,
  RunExecutionEnvelope,
  RunInputSnapshot,
  RunObservability,
  Task,
  TaskClaim,
  TaskExecutionKind,
  TaskMessage,
  TaskQueueItem,
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
import {
  cancelDirectChatRunWithClient,
  DirectChatRepository,
  failDirectChatTurnWithClient,
} from "./direct-chat-repository.js";
import { RuntimeTraceRepository } from "./runtime-trace-repository.js";
import { MeetingDecisionsRepository } from "./meeting-decisions-repository.js";
import {
  failMeetingTurnWithClient,
  MeetingAiRepository,
} from "./meeting-ai-repository.js";
import { MemoryClosureRepository } from "./memory-closure-repository.js";
import { WorkbenchReportsRepository } from "./workbench-reports-repository.js";
import { ProjectTemplatesRepository } from "./project-templates-repository.js";
import { ExternalRuntimeRepository } from "./external-runtime-repository.js";
import { AgentRuntimeBindingRepository } from "./agent-runtime-binding-repository.js";
import { AuthorizationRepository } from "./authorization-repository.js";
import { TaskExecutionPolicyRepository } from "./task-execution-policy-repository.js";
import { ActionTicketRepository } from "./action-ticket-repository.js";
import { SceneContextRepository } from "./scene-context-repository.js";
import { RuntimeEconomicsRepository } from "./runtime-economics-repository.js";
import { TeammateRepository } from "./teammate-repository.js";
import { MeetingCollaborationRepository } from "./meeting-collaboration-repository.js";

export class ProjectRepository {
  private readonly authorization: AuthorizationRepository;

  constructor(
    private readonly database: Database,
    authorization?: AuthorizationRepository,
  ) {
    this.authorization = authorization ?? new AuthorizationRepository(database);
  }

  async list(projectIds?: readonly string[]): Promise<Project[]> {
    const result =
      projectIds === undefined
        ? await this.database.query<ProjectRow>(
            "SELECT * FROM projects ORDER BY updated_at DESC",
          )
        : await this.database.query<ProjectRow>(
            `SELECT * FROM projects
             WHERE id = ANY($1::uuid[])
             ORDER BY updated_at DESC`,
            [projectIds],
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
      const principal = await client.query<{ id: string }>(
        "SELECT id FROM principals WHERE id = $1",
        [actorId],
      );
      const principalId = principal.rows[0]?.id ?? null;
      if (principalId === null) {
        throw new Error("project creator Principal does not exist");
      }
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
           id, project_id, kind, actor_id, principal_id, name, responsibility,
           status, is_owner, created_at, updated_at
         ) VALUES ($1, $2, 'human', $4, $6, $5, $3,
                   'active', TRUE, NOW(), NOW())`,
        [memberId, id, responsibility, actorId, actorName, principalId],
      );
      await client.query(
        `INSERT INTO project_member_roles (project_member_id, role_id)
         VALUES ($1, $2)`,
        [memberId, roleId],
      );
      await this.authorization.syncProjectMemberGrantsWithClient(
        client,
        id,
        memberId,
        principalId,
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

  async list(
    projectId?: string,
    readableProjectIds?: readonly string[],
  ): Promise<Task[]> {
    const result =
      projectId === undefined
        ? readableProjectIds === undefined
          ? await this.database.query<TaskRow>(
              `${this.selectSql} ORDER BY task.updated_at DESC`,
            )
          : await this.database.query<TaskRow>(
              `${this.selectSql}
               WHERE task.project_id = ANY($1::uuid[])
               ORDER BY task.updated_at DESC`,
              [readableProjectIds],
            )
        : await this.database.query<TaskRow>(
            `${this.selectSql}
             WHERE task.project_id = $1
             ORDER BY task.updated_at DESC`,
            [projectId],
          );
    return result.rows.map(taskFromRow);
  }

  async listQueue(projectId: string): Promise<TaskQueueItem[]> {
    const result = await this.database.query<
      TaskRow & {
        project_status: Project["status"];
        dependency_blocked: boolean;
        active_run: boolean;
        active_claim: boolean;
      }
    >(
      `SELECT
         task.*,
         project.status AS project_status,
         ARRAY(
           SELECT dependency.depends_on_task_id::text
           FROM task_dependencies AS dependency
           WHERE dependency.task_id = task.id
           ORDER BY dependency.created_at, dependency.depends_on_task_id
         ) AS depends_on
       FROM tasks AS task
       JOIN projects AS project ON project.id = task.project_id
       WHERE task.project_id = $1
         AND task.status IN ('queued', 'paused', 'blocked', 'needs_input')
       ORDER BY
         CASE task.priority
           WHEN 'urgent' THEN 4
           WHEN 'high' THEN 3
           WHEN 'medium' THEN 2
           ELSE 1
         END DESC,
         task.created_at,
         task.id`,
      [projectId],
    );
    const dependencyResult = await this.database.query<{
      task_id: string;
      blocked: boolean;
    }>(
      `SELECT
         task_id,
         EXISTS (
           SELECT 1
           FROM task_dependencies AS dependency
           JOIN tasks AS prerequisite
             ON prerequisite.id = dependency.depends_on_task_id
           WHERE dependency.task_id = task_dependencies.task_id
             AND prerequisite.status <> 'done'
         ) AS blocked
       FROM task_dependencies
       WHERE project_id = $1`,
      [projectId],
    );
    const runResult = await this.database.query<{
      task_id: string;
    }>(
      `SELECT DISTINCT task_id
       FROM runs
       WHERE project_id = $1
         AND status IN ('queued', 'running', 'waiting_approval', 'interrupted')
         AND task_id IS NOT NULL`,
      [projectId],
    );
    const blockedDependencies = new Set(
      dependencyResult.rows
        .filter((row) => row.blocked)
        .map((row) => row.task_id),
    );
    const activeRuns = new Set(runResult.rows.map((row) => row.task_id));
    return result.rows.map((row, index) => {
      const task = taskFromRow(row);
      const blockedReasons: TaskQueueItem["blockedReasons"] = [];
      if (row.project_status !== "active")
        blockedReasons.push("project-archived");
      if (task.status === "paused") blockedReasons.push("paused");
      if (task.status === "blocked") blockedReasons.push("blocked");
      if (task.status === "needs_input") blockedReasons.push("needs-input");
      if (blockedDependencies.has(task.id)) blockedReasons.push("dependency");
      if (activeRuns.has(task.id)) blockedReasons.push("active-run");
      if (
        task.claimedBy !== null &&
        task.claimExpiresAt !== null &&
        Date.parse(task.claimExpiresAt) > Date.now()
      ) {
        blockedReasons.push("active-claim");
      }
      return {
        task,
        eligible: task.status === "queued" && blockedReasons.length === 0,
        blockedReasons,
        position: index + 1,
      };
    });
  }

  async claimNext(
    projectId: string,
    input: ClaimTaskInput,
  ): Promise<TaskClaim | undefined> {
    return this.database.transaction(async (client) => {
      await client.query(
        `UPDATE tasks
         SET
           execution_claim_token = NULL,
           execution_claim_owner = NULL,
           execution_claim_expires_at = NULL,
           revision = revision + 1,
           updated_at = NOW()
         WHERE project_id = $1
           AND execution_claim_token IS NOT NULL
           AND execution_claim_expires_at <= NOW()`,
        [projectId],
      );
      const candidate = await client.query<TaskRow>(
        `${this.selectSql}
         JOIN projects AS project ON project.id = task.project_id
         WHERE task.project_id = $1
           AND task.status = 'queued'
           AND project.status = 'active'
           AND task.execution_claim_token IS NULL
           AND NOT EXISTS (
             SELECT 1
             FROM task_dependencies AS dependency
             JOIN tasks AS prerequisite
               ON prerequisite.id = dependency.depends_on_task_id
             WHERE dependency.task_id = task.id
               AND prerequisite.status <> 'done'
           )
           AND NOT EXISTS (
             SELECT 1
             FROM runs
             WHERE runs.task_id = task.id
               AND runs.status IN (
                 'queued',
                 'running',
                 'waiting_approval',
                 'interrupted'
               )
           )
         ORDER BY
           CASE task.priority
             WHEN 'urgent' THEN 4
             WHEN 'high' THEN 3
             WHEN 'medium' THEN 2
             ELSE 1
           END DESC,
           task.created_at,
           task.id
         FOR UPDATE OF task SKIP LOCKED
         LIMIT 1`,
        [projectId],
      );
      const row = candidate.rows[0];
      if (row === undefined) return undefined;
      const claimToken = randomUUID();
      const updated = await client.query<TaskRow>(
        `UPDATE tasks
         SET
           execution_claim_token = $2,
           execution_claim_owner = $3,
           execution_claim_expires_at =
             NOW() + ($4 || ' seconds')::interval,
           revision = revision + 1,
           updated_at = NOW()
         WHERE id = $1
           AND execution_claim_token IS NULL
         RETURNING *`,
        [row.id, claimToken, input.ownerId, input.leaseSeconds],
      );
      const claimed = updated.rows[0];
      if (claimed === undefined) return undefined;
      await client.query(
        `INSERT INTO task_events (
           id, task_id, kind, actor_id, actor_name, summary, data, created_at
         ) VALUES (
           $1, $2, 'claim', $3, $3, $4, $5::jsonb, NOW()
         )`,
        [
          randomUUID(),
          row.id,
          input.ownerId,
          `任务已由 ${input.ownerId} 领取`,
          JSON.stringify({ claimToken, leaseSeconds: input.leaseSeconds }),
        ],
      );
      const task = taskFromRow({
        ...claimed,
        depends_on: row.depends_on,
      });
      return {
        task,
        claimToken,
        ownerId: input.ownerId,
        expiresAt: task.claimExpiresAt!,
        revision: task.revision,
      };
    });
  }

  async releaseClaim(
    id: string,
    claimToken: string,
  ): Promise<Task | undefined> {
    const result = await this.database.query<TaskRow>(
      `UPDATE tasks
       SET
         execution_claim_token = NULL,
         execution_claim_owner = NULL,
         execution_claim_expires_at = NULL,
         revision = revision + 1,
         updated_at = NOW()
       WHERE id = $1
         AND execution_claim_token = $2
       RETURNING *`,
      [id, claimToken],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return this.get(id);
  }

  async transitionControl(input: {
    readonly id: string;
    readonly from: readonly TaskStatus[];
    readonly to: TaskStatus;
    readonly expectedRevision?: number;
    readonly needsInputPrompt?: string | null;
    readonly blockedReason?: string | null;
    readonly pausedReason?: string | null;
  }): Promise<Task | undefined> {
    const result = await this.database.query<TaskRow>(
      `UPDATE tasks
       SET
         status = $3,
         needs_input_prompt = $4,
         blocked_reason = $5,
         paused_reason = $6,
         execution_claim_token = NULL,
         execution_claim_owner = NULL,
         execution_claim_expires_at = NULL,
         revision = revision + 1,
         updated_at = NOW()
       WHERE id = $1
         AND status = ANY($2::text[])
         AND ($7::integer IS NULL OR revision = $7)
       RETURNING *`,
      [
        input.id,
        [...input.from],
        input.to,
        input.needsInputPrompt ?? null,
        input.blockedReason ?? null,
        input.pausedReason ?? null,
        input.expectedRevision ?? null,
      ],
    );
    if (result.rows[0] === undefined) return undefined;
    return this.get(input.id);
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
           agent_id, role_id, priority, auto_submit, auto_accept,
           auto_redispatch_on_return, created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5::jsonb, 'queued', $6, $7, $8, $9, $10, $11,
           NOW(), NOW()
         )`,
        [
          taskId,
          input.projectId,
          input.title,
          input.description,
          JSON.stringify(input.acceptance),
          agentId,
          roleId ?? null,
          input.priority ?? "medium",
          input.autoSubmit ?? true,
          input.autoAccept ?? false,
          input.autoRedispatchOnReturn ?? false,
        ],
      );
      await this.replaceDependenciesWithClient(
        client,
        taskId,
        input.projectId,
        input.dependsOn ?? [],
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
           priority = COALESCE($5, priority),
           auto_submit = COALESCE($6, auto_submit),
           auto_accept = COALESCE($7, auto_accept),
           auto_redispatch_on_return =
             COALESCE($8, auto_redispatch_on_return),
           revision = revision + 1,
           updated_at = NOW()
         WHERE id = $1`,
        [
          id,
          input.title ?? null,
          input.description ?? null,
          input.acceptance === undefined
            ? null
            : JSON.stringify(input.acceptance),
          input.priority ?? null,
          input.autoSubmit ?? null,
          input.autoAccept ?? null,
          input.autoRedispatchOnReturn ?? null,
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
       SET
         agent_id = $2,
         role_id = $3,
         revision = revision + 1,
         updated_at = NOW()
       WHERE id = $1
         AND status IN (
           'queued',
           'in_progress',
           'review',
           'paused',
           'blocked',
           'needs_input'
         )
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
         content, reply_to_id, is_key_consensus, delivery_target,
         mention_agent_ids, created_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::uuid[], NOW()
       )
       RETURNING *`,
      [
        randomUUID(),
        id,
        authorType,
        authorId,
        authorName,
        input.content,
        input.replyToId ?? null,
        input.isKeyConsensus ?? false,
        input.deliveryTarget ?? null,
        input.mentions ?? [],
      ],
    );
    return taskMessageFromRow(result.rows[0]!);
  }

  async setMessageTriggeredRuns(
    id: string,
    runIds: readonly string[],
  ): Promise<TaskMessage | undefined> {
    const result = await this.database.query<TaskMessageRow>(
      `UPDATE task_messages
       SET triggered_run_ids = $2::uuid[]
       WHERE id = $1
       RETURNING *`,
      [id, runIds],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : taskMessageFromRow(row);
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
  readonly agentId?: string;
  readonly taskExecutionKind?: TaskExecutionKind;
  readonly taskTriggerMessageId?: string;
  readonly inputSnapshot: RunInputSnapshot;
  readonly executionSnapshot?: ExternalRunExecutionSnapshot;
  readonly executionEnvelope?: RunExecutionEnvelope;
  readonly actionTicket?: ActionTicket;
  readonly executionGates?: readonly ExecutionGateRequest[];
  readonly executionStatus?: "queued" | "waiting_approval";
  readonly observability?: RunObservability;
  readonly attempt?: number;
  readonly timeoutAt?: string;
  readonly idempotencyKey?: string;
  readonly maxAttempts?: number;
  readonly workflowInstanceId?: string;
  readonly workflowNodeId?: string;
  readonly trace?: TraceContext;
}

export class RunRepository {
  constructor(
    private readonly database: Database,
    private readonly actionTickets = new ActionTicketRepository(database),
  ) {}

  async enqueue(input: EnqueueRunInput): Promise<Run> {
    const trace = input.trace ?? createRootTraceContext();
    return this.database.transaction(async (client) => {
      const result = await client.query<RunRow>(
        `INSERT INTO runs (
           id, project_id, task_id, agent_id, task_execution_kind,
           task_trigger_message_id, status, input_snapshot,
           execution_snapshot, execution_context_type, execution_context_id,
           execution_policy_id, execution_policy_revision,
           execution_binding_revision, execution_runtime_revision,
           execution_envelope_snapshot, external_runtime_id, external_runtime_revision,
           external_runtime_provider, external_runtime_protocol,
           observability, attempt, timeout_at, idempotency_key,
           workflow_instance_id, workflow_node_id, trace_id,
           trace_root_span_id, created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8::jsonb,
           $9::jsonb, $10, $11, $12, $13, $14, $15, $16::jsonb,
           $17, $18, $19, $20, $21::jsonb,
           $22, $23, $24, $25, $26, $27, $28, NOW(), NOW()
         )
         RETURNING *`,
        [
          input.runId,
          input.task.projectId,
          input.task.id,
          input.agentId ?? input.task.agentId,
          input.taskExecutionKind ?? "owner",
          input.taskTriggerMessageId ?? null,
          input.executionStatus ?? "queued",
          JSON.stringify(input.inputSnapshot),
          input.executionSnapshot === undefined
            ? null
            : JSON.stringify(input.executionSnapshot),
          input.executionEnvelope?.contextType ?? null,
          input.executionEnvelope?.contextId ?? null,
          input.executionEnvelope?.policy.id ?? null,
          input.executionEnvelope?.policy.revision ?? null,
          input.executionEnvelope?.binding.revision ?? null,
          input.executionEnvelope?.runtime.revision ?? null,
          input.executionEnvelope === undefined
            ? null
            : JSON.stringify(input.executionEnvelope),
          input.executionSnapshot?.runtime.id ?? null,
          input.executionSnapshot?.runtime.revision ?? null,
          input.executionSnapshot?.runtime.provider ?? null,
          input.executionSnapshot?.runtime.protocol ?? null,
          JSON.stringify(
            input.observability ?? {
              planVisibility: "structured",
              toolEventCompleteness: "complete",
              textStreaming: "delta",
              subagentVisibility: "none",
            },
          ),
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
      if (input.actionTicket !== undefined) {
        await this.actionTickets.issueWithClient(client, input.actionTicket);
        await this.actionTickets.issueGatesWithClient(
          client,
          input.executionGates ?? [],
        );
      } else if ((input.executionGates ?? []).length > 0) {
        throw new Error("execution gates require an Action Ticket");
      }
      if ((input.taskExecutionKind ?? "owner") === "owner") {
        await client.query(
          `UPDATE tasks
           SET
             status = CASE
               WHEN status IN ('queued', 'paused', 'blocked', 'needs_input')
                 THEN 'in_progress'
               ELSE status
             END,
             execution_claim_token = NULL,
             execution_claim_owner = NULL,
             execution_claim_expires_at = NULL,
             revision = revision + 1,
             updated_at = NOW()
           WHERE id = $1`,
          [input.task.id],
        );
      }
      await TeammateRepository.attributeRunWithClient(client, input.runId);
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

  async markExternalStarted(id: string): Promise<void> {
    await this.database.query(
      `UPDATE runs
       SET external_started_at = COALESCE(external_started_at, NOW()),
           updated_at = NOW()
       WHERE id = $1
         AND external_runtime_id IS NOT NULL`,
      [id],
    );
  }

  async recordExternalCompletion(
    id: string,
    input: {
      readonly provider: string;
      readonly runtimeVersion: string;
      readonly sessionId?: string;
    },
  ): Promise<void> {
    await this.database.query(
      `UPDATE runs
       SET
         external_runtime_provider = $2,
         external_runtime_version = $3,
         external_session_id = $4,
         updated_at = NOW()
       WHERE id = $1
         AND external_runtime_id IS NOT NULL`,
      [
        id,
        input.provider.slice(0, 120),
        input.runtimeVersion.slice(0, 240),
        input.sessionId?.slice(0, 500) ?? null,
      ],
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

  async cancel(
    id: string,
    actorId = "system:run-cancel",
    reason = "Run cancelled by the platform",
  ): Promise<boolean> {
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
      } else if (run.directChatTurnId !== null) {
        await cancelDirectChatRunWithClient(
          client,
          run.id,
          "direct chat run cancelled",
        );
      }
      await this.actionTickets.cancelPendingForRunWithClient(client, {
        runId: id,
        decidedByPrincipalId: actorId,
        basis: reason,
      });
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
        task_execution_kind: TaskExecutionKind;
        task_status: Task["status"] | null;
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
           run.task_execution_kind,
           task.status AS task_status,
           COALESCE(job.trace_id, run.trace_id) AS trace_id,
           run.trace_root_span_id
         FROM jobs AS job
         JOIN runs AS run ON run.id = job.run_id
         LEFT JOIN tasks AS task ON task.id = run.task_id
         LEFT JOIN projects AS project ON project.id = run.project_id
         WHERE job.status = 'queued'
           AND job.available_at <= NOW()
           AND job.attempts < job.max_attempts
           AND (
             run.status IN ('queued', 'interrupted')
             OR (
               run.status = 'completed'
               AND EXISTS (
                 SELECT 1
                 FROM runtime_effect_receipts AS effect
                 WHERE effect.run_id = run.id
                   AND effect.status = 'completed'
               )
             )
           )
           AND (
             run.task_id IS NULL
             OR (
               task.status IN ('queued', 'in_progress')
               AND project.status = 'active'
               AND NOT EXISTS (
                 SELECT 1
                 FROM task_dependencies AS dependency
                 JOIN tasks AS prerequisite
                   ON prerequisite.id = dependency.depends_on_task_id
                 WHERE dependency.task_id = task.id
                   AND prerequisite.status <> 'done'
               )
             )
           )
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
      if (row.task_id !== null && row.task_execution_kind === "owner") {
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
      readonly retryable?: boolean;
    } = {},
  ): Promise<FailedJobResult> {
    return this.database.transaction(async (client) => {
      const current = await client.query<{
        run_id: string;
        attempts: number;
        max_attempts: number;
        task_id: string | null;
        meeting_turn_id: string | null;
        direct_chat_turn_id: string | null;
      }>(
        `SELECT
           job.run_id,
           job.attempts,
           job.max_attempts,
           run.task_id,
           run.meeting_turn_id,
           run.direct_chat_turn_id
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
      const hasAttempts =
        options.retryable !== false && row.attempts < row.max_attempts;
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
      } else if (row.direct_chat_turn_id !== null) {
        await failDirectChatTurnWithClient(
          client,
          row.run_id,
          "direct_chat_runtime_failed",
          safeError,
        );
      } else if (row.meeting_turn_id !== null) {
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
        meeting_turn_id: string | null;
        direct_chat_turn_id: string | null;
      }>(
        `SELECT
           job.run_id,
           job.attempts,
           job.max_attempts,
           run.task_id,
           run.meeting_turn_id,
           run.direct_chat_turn_id
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
        if (row.direct_chat_turn_id !== null) {
          await failDirectChatTurnWithClient(
            client,
            row.run_id,
            "direct_chat_interrupted",
            reason,
          );
        } else if (row.meeting_turn_id !== null) {
          await failMeetingTurnWithClient(
            client,
            row.run_id,
            "meeting_ai_interrupted",
            reason,
          );
        }
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
        const interrupted = await client.query<{
          task_id: string | null;
          meeting_turn_id: string | null;
          direct_chat_turn_id: string | null;
        }>(
          `UPDATE runs
           SET
             status = 'interrupted',
             error = 'worker lease expired',
             ended_at = NOW(),
             updated_at = NOW()
           WHERE id = $1 AND status IN ('queued', 'running')
           RETURNING task_id, meeting_turn_id, direct_chat_turn_id`,
          [job.run_id],
        );
        const interruptedRun = interrupted.rows[0];
        const taskId = interruptedRun?.task_id;
        if (taskId !== undefined) {
          if (taskId === null && outcome === "dead_letter") {
            if (interruptedRun?.direct_chat_turn_id !== null) {
              await failDirectChatTurnWithClient(
                client,
                job.run_id,
                "direct_chat_lease_expired",
                "Worker lease expired after all retry attempts",
              );
            } else if (interruptedRun?.meeting_turn_id !== null) {
              await failMeetingTurnWithClient(
                client,
                job.run_id,
                "meeting_ai_lease_expired",
                "Worker lease expired after all retry attempts",
              );
            }
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
  readonly actionTickets: ActionTicketRepository;
  readonly authorization: AuthorizationRepository;
  readonly taskExecutionPolicies: TaskExecutionPolicyRepository;
  readonly projects: ProjectRepository;
  readonly agents: AgentRepository;
  readonly tasks: TaskRepository;
  readonly taskCollaboration: TaskCollaborationRepository;
  readonly runs: RunRepository;
  readonly jobs: JobRepository;
  readonly contexts: ContextRepository;
  readonly sceneContext: SceneContextRepository;
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
  readonly meetingCollaboration: MeetingCollaborationRepository;
  readonly meetingAi: MeetingAiRepository;
  readonly directChats: DirectChatRepository;
  readonly meetingDecisions: MeetingDecisionsRepository;
  readonly workbench: WorkbenchRepository;
  readonly workbenchReports: WorkbenchReportsRepository;
  readonly runtimeReliability: RuntimeReliabilityRepository;
  readonly runtimeEffects: RuntimeEffectRepository;
  readonly runtimeEconomics: RuntimeEconomicsRepository;
  readonly teammates: TeammateRepository;
  readonly traces: RuntimeTraceRepository;
  readonly externalRuntimes: ExternalRuntimeRepository;
  readonly agentRuntimeBindings: AgentRuntimeBindingRepository;

  constructor(database: Database) {
    this.actionTickets = new ActionTicketRepository(database);
    this.authorization = new AuthorizationRepository(database);
    this.taskExecutionPolicies = new TaskExecutionPolicyRepository(database);
    this.projects = new ProjectRepository(database, this.authorization);
    this.agents = new AgentRepository(database);
    this.tasks = new TaskRepository(database);
    this.taskCollaboration = new TaskCollaborationRepository(database);
    this.runs = new RunRepository(database, this.actionTickets);
    this.jobs = new JobRepository(database);
    this.contexts = new ContextRepository(database);
    this.sceneContext = new SceneContextRepository(database);
    this.projectMemberships = new ProjectMembershipRepository(
      database,
      this.authorization,
    );
    this.projectTemplates = new ProjectTemplatesRepository(
      database,
      this.authorization,
    );
    this.artifacts = new ArtifactRepository(database);
    this.memory = new MemoryRepository(database);
    this.memoryClosure = new MemoryClosureRepository(database, this.memory);
    this.reviews = new ReviewRepository(database);
    this.workflows = new WorkflowRepository(database);
    this.workflowRuntime = new WorkflowRuntimeRepository(database);
    this.workflowIdempotency = new WorkflowIdempotencyRepository(database);
    this.meetings = new MeetingRepository(database);
    this.meetingCollaboration = new MeetingCollaborationRepository(database);
    this.meetingAi = new MeetingAiRepository(database, this.actionTickets);
    this.directChats = new DirectChatRepository(database, this.actionTickets);
    this.meetingDecisions = new MeetingDecisionsRepository(database);
    this.workbench = new WorkbenchRepository(database);
    this.workbenchReports = new WorkbenchReportsRepository(
      database,
      this.authorization,
    );
    this.runtimeReliability = new RuntimeReliabilityRepository(database);
    this.runtimeEffects = new RuntimeEffectRepository(database);
    this.runtimeEconomics = new RuntimeEconomicsRepository(database);
    this.teammates = new TeammateRepository(database);
    this.traces = new RuntimeTraceRepository(database);
    this.externalRuntimes = new ExternalRuntimeRepository(database);
    this.agentRuntimeBindings = new AgentRuntimeBindingRepository(database);
  }
}
