import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createRootTraceContext,
  type Agent,
  type Project,
  type ProjectMember,
  type ProjectRole,
  type Task,
  type TaskAcceptanceEvidenceProjection,
  type TaskExecutionHealthProjection,
} from "@pluginmax/contracts";
import {
  ApplicationError,
  ExecutionDecisionService,
  PlatformApplication,
  RunExecutor,
} from "@pluginmax/application";
import {
  Database,
  JobRepository,
  LATEST_MIGRATION_VERSION,
  PlatformRepositories,
  migrate,
} from "@pluginmax/database";
import { buildApi } from "./app.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl === undefined ? describe.skip : describe;

integration("M1a execution evidence and anomaly gates", () => {
  let database: Database;
  let repositories: PlatformRepositories;
  let application: PlatformApplication;
  let app: ReturnType<typeof buildApi>["app"];
  let executor: RunExecutor;
  let executionDecisions: ExecutionDecisionService;

  beforeAll(async () => {
    database = new Database(databaseUrl!);
    repositories = new PlatformRepositories(database);
    await migrate(database);
    const fileStoreRoot = await mkdtemp(
      join(tmpdir(), "pluginmax-m1a-evidence-"),
    );
    application = new PlatformApplication(repositories);
    executor = new RunExecutor(repositories, {
      workspaceRoot: join(fileStoreRoot, "workspaces"),
      fileStoreRoot,
      dsh: {
        dshBin: "dsh",
        profile: "default",
        dshHome: join(fileStoreRoot, "dsh-home"),
        provider: "test",
        model: "test",
      },
    });
    executionDecisions = new ExecutionDecisionService(repositories);
    app = buildApi({
      databaseUrl: databaseUrl!,
      database,
      fileStoreRoot,
      logger: false,
      localActorId: "local-admin",
      expectedMigrationVersion: LATEST_MIGRATION_VERSION,
    }).app;
    await app.ready();
  });

  afterAll(async () => {
    await repositories.featureFlags.set({
      flagKey: "task.evidence_review",
      scopeType: "platform",
      scopeId: "platform",
      mode: "observe",
      updatedBy: "test:cleanup",
    });
    await repositories.featureFlags.set({
      flagKey: "task.anomaly",
      scopeType: "platform",
      scopeId: "platform",
      mode: "off",
      updatedBy: "test:cleanup",
    });
    await app.close();
    await database.close();
  });

  async function request<T>(
    method: "GET" | "POST" | "PATCH",
    url: string,
    payload?: unknown,
    actorId = "local-admin",
  ): Promise<{ statusCode: number; body: T }> {
    const options: InjectOptions = {
      method,
      url,
      headers: { "x-pluginmax-actor": actorId },
    };
    if (payload !== undefined) {
      options.payload = payload as Record<string, unknown>;
    }
    const response = await app.inject(options);
    return {
      statusCode: response.statusCode,
      body: response.json() as T,
    };
  }

  async function ensureActor(actorId: string): Promise<void> {
    const response = await request("GET", "/api/v1/auth/me", undefined, actorId);
    expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
  }

  async function createProject(prefix: string): Promise<Project> {
    const response = await request<Project>("POST", "/api/v1/projects", {
      name: `${prefix} ${randomUUID().slice(0, 8)}`,
      description: "M1a evidence fixture",
    });
    expect(response.statusCode, JSON.stringify(response.body)).toBe(201);
    return response.body;
  }

  async function createRole(
    projectId: string,
    permissions: ProjectRole["permissions"],
  ): Promise<ProjectRole> {
    const response = await request<ProjectRole>(
      "POST",
      `/api/v1/projects/${projectId}/roles`,
      {
        code: `M1A_${randomUUID().slice(0, 8).toUpperCase()}`,
        name: `M1a role ${permissions.join("_")}`,
        category: "execution",
        description: "M1a execution evidence fixture",
        permissions,
      },
    );
    expect(response.statusCode, JSON.stringify(response.body)).toBe(201);
    return response.body;
  }

  async function addHumanMember(
    projectId: string,
    actorId: string,
    roleIds: readonly string[],
  ): Promise<ProjectMember> {
    await ensureActor(actorId);
    const response = await request<ProjectMember>(
      "POST",
      `/api/v1/projects/${projectId}/members`,
      {
        kind: "human",
        actorId,
        name: actorId,
        responsibility: "M1a evidence fixture",
        roleIds,
      },
    );
    expect(response.statusCode, JSON.stringify(response.body)).toBe(201);
    return response.body;
  }

  async function createAgent(
    runtimeKind: Agent["runtimeKind"] = "fake",
  ): Promise<Agent> {
    const response = await request<Agent>("POST", "/api/v1/agents", {
      name: `M1a Agent ${randomUUID().slice(0, 8)}`,
      runtimeKind,
    });
    expect(response.statusCode, JSON.stringify(response.body)).toBe(201);
    return response.body;
  }

  async function addAgent(
    projectId: string,
    agentId: string,
  ): Promise<void> {
    const response = await request(
      "POST",
      `/api/v1/projects/${projectId}/members`,
      {
        kind: "agent",
        agentId,
        responsibility: "M1a execution fixture",
        roleIds: [],
      },
    );
    expect(response.statusCode, JSON.stringify(response.body)).toBe(201);
  }

  async function createTask(input: {
    readonly projectId: string;
    readonly agentId: string;
    readonly acceptance?: readonly string[];
    readonly autoSubmit?: boolean;
    readonly autoAccept?: boolean;
  }): Promise<Task> {
    const response = await request<Task>("POST", "/api/v1/tasks", {
      projectId: input.projectId,
      title: `M1a task ${randomUUID().slice(0, 8)}`,
      description: "Verify M1a execution evidence",
      acceptance: input.acceptance ?? ["Required acceptance"],
      agentId: input.agentId,
      autoSubmit: input.autoSubmit ?? true,
      autoAccept: input.autoAccept ?? false,
    });
    expect(response.statusCode, JSON.stringify(response.body)).toBe(201);
    return response.body;
  }

  async function setEnforce(projectId: string): Promise<void> {
    await repositories.featureFlags.set({
      flagKey: "task.evidence_review",
      scopeType: "project",
      scopeId: projectId,
      mode: "enforce",
      updatedBy: "test:m1a",
    });
    await repositories.featureFlags.set({
      flagKey: "task.anomaly",
      scopeType: "project",
      scopeId: projectId,
      mode: "enforce",
      updatedBy: "test:m1a",
    });
  }

  async function dispatch(taskId: string, actorId = "local-admin") {
    return request<{ runId: string }>(
      "POST",
      `/api/v1/tasks/${taskId}/dispatch`,
      undefined,
      actorId,
    );
  }

  async function executeRun(runId: string): Promise<void> {
    const owner = `m1a-worker-${randomUUID().slice(0, 8)}`;
    const claimed = await new JobRepository(database).claimNext(
      owner,
      30,
      runId,
    );
    expect(claimed).toBeDefined();
    await executor.execute(runId, {
      jobId: claimed!.id,
      owner,
      leaseSeconds: 30,
      traceId: claimed!.traceId,
      jobSpanId: claimed!.spanId,
    });
  }

  async function evidence(taskId: string) {
    return request<TaskAcceptanceEvidenceProjection>(
      "GET",
      `/api/v1/tasks/${taskId}/acceptance-evidence`,
    );
  }

  async function confirmItems(input: {
    readonly taskId: string;
    readonly runId: string;
    readonly actorId: string;
    readonly itemIds: readonly string[];
  }) {
    const current = await evidence(input.taskId);
    expect(current.statusCode).toBe(200);
    const items = current.body.items
      .filter((item) => input.itemIds.includes(item.id))
      .map((item) => ({
        acceptanceItemId: item.id,
        acceptanceItemRevision: item.revision,
        evidenceRefs: [
          {
            kind: "run-output" as const,
            refId: input.runId,
          },
        ],
      }));
    return request<TaskAcceptanceEvidenceProjection>(
      "POST",
      `/api/v1/tasks/${input.taskId}/acceptance-evidence/confirmations`,
      {
        runId: input.runId,
        items,
      },
      input.actorId,
    );
  }

  it("G1 rechecks authorization immediately before dispatch", async () => {
    const project = await createProject("G1");
    const role = await createRole(project.id, ["read", "write"]);
    const writer = `m1a-writer-${randomUUID().slice(0, 8)}`;
    const writerMember = await addHumanMember(project.id, writer, [role.id]);
    const readOnlyRole = await createRole(project.id, ["manage_members"]);
    const agent = await createAgent();
    await addAgent(project.id, agent.id);
    const task = await createTask({
      projectId: project.id,
      agentId: agent.id,
    });

    const before = await executionDecisions.decideDispatch({
      projectId: project.id,
      principalId: writer,
      authSource: "local-development",
      permission: "write",
      taskId: task.id,
      agentId: agent.id,
    });
    expect(before.authorization.allowed).toBe(true);
    const replacedRole = await request(
      "PATCH",
      `/api/v1/projects/${project.id}/members/${writerMember.id}`,
      { roleIds: [readOnlyRole.id] },
    );
    expect(replacedRole.statusCode, JSON.stringify(replacedRole.body)).toBe(200);

    await expect(
      application.dispatchTask(
        task.id,
        createRootTraceContext(),
        writer,
        false,
      ),
    ).rejects.toMatchObject({
      code: "execution_authorization_denied",
    } satisfies Partial<ApplicationError>);
    const runs = await database.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM runs WHERE task_id = $1",
      [task.id],
    );
    expect(runs.rows[0]?.count).toBe("0");
  });

  it("repairs a missing acceptance projection before evidence decisions", async () => {
    const project = await createProject("M1a repair");
    const agent = await createAgent();
    await addAgent(project.id, agent.id);
    const taskId = randomUUID();
    await database.query(
      `INSERT INTO tasks (
         id, project_id, title, description, acceptance, status, agent_id,
         created_at, updated_at
       ) VALUES (
         $1, $2, 'Partially written M1a task', 'recover acceptance projection',
         '["Recovered first item","Recovered second item"]'::jsonb,
         'queued', $3, NOW(), NOW()
       )`,
      [taskId, project.id, agent.id],
    );
    const repaired = await evidence(taskId);
    expect(repaired.statusCode).toBe(200);
    expect(repaired.body.items.map((item) => item.requirement)).toEqual([
      "Recovered first item",
      "Recovered second item",
    ]);
  });

  it("G2 stops dispatch when Runtime availability changes", async () => {
    const project = await createProject("G2");
    const agent = await createAgent();
    await addAgent(project.id, agent.id);
    const task = await createTask({
      projectId: project.id,
      agentId: agent.id,
    });
    const before = await executionDecisions.decideDispatch({
      projectId: project.id,
      principalId: "local-admin",
      authSource: "local-development",
      permission: "write",
      taskId: task.id,
      agentId: agent.id,
    });
    expect(before.dispatchEligibility.allowed).toBe(true);
    await database.query(
      "UPDATE agents SET runtime_kind = 'plain-text', updated_at = NOW() WHERE id = $1",
      [agent.id],
    );

    await expect(
      application.dispatchTask(
        task.id,
        createRootTraceContext(),
        "local-admin",
        true,
      ),
    ).rejects.toMatchObject({
      code: "runtime_binding_missing",
    } satisfies Partial<ApplicationError>);
    expect(
      await database.query(
        "SELECT 1 FROM runs WHERE task_id = $1",
        [task.id],
      ),
    ).toMatchObject({ rowCount: 0 });
  });

  it("G3 binds ActionDecision to one resource and Run", async () => {
    const project = await createProject("G3");
    const agent = await createAgent();
    await addAgent(project.id, agent.id);
    const taskA = await createTask({
      projectId: project.id,
      agentId: agent.id,
    });
    const taskB = await createTask({
      projectId: project.id,
      agentId: agent.id,
    });
    const dispatched = await dispatch(taskA.id);
    expect(dispatched.statusCode, JSON.stringify(dispatched.body)).toBe(202);

    const allowed = await executionDecisions.decideAction({
      runId: dispatched.body.runId,
      principalId: "local-admin",
      action: "task.writeback",
      resourceId: `task:${taskA.id}`,
    });
    expect(allowed.allowed).toBe(true);
    const rejected = await executionDecisions.decideAction({
      runId: dispatched.body.runId,
      principalId: "local-admin",
      action: "task.writeback",
      resourceId: `task:${taskB.id}`,
    });
    expect(rejected.allowed).toBe(false);
    expect(rejected.reasons[0]?.code).toBe("action_resource_mismatch");
  });

  it("G7 and G8 keep missing-evidence Runs in progress and record anomaly", async () => {
    for (const autoAccept of [false, true]) {
      const project = await createProject(autoAccept ? "G8" : "G7");
      await setEnforce(project.id);
      const agent = await createAgent();
      await addAgent(project.id, agent.id);
      const task = await createTask({
        projectId: project.id,
        agentId: agent.id,
        autoSubmit: true,
        autoAccept,
      });
      const dispatched = await dispatch(task.id);
      expect(dispatched.statusCode, JSON.stringify(dispatched.body)).toBe(202);
      await executeRun(dispatched.body.runId);

      const current = await request<Task>(
        "GET",
        `/api/v1/tasks/${task.id}`,
      );
      expect(current.body.status).toBe("in_progress");
      const health = await request<TaskExecutionHealthProjection>(
        "GET",
        `/api/v1/tasks/${task.id}/execution-health`,
      );
      expect(health.statusCode).toBe(200);
      expect(health.body.health).toBe("anomaly");
      expect(health.body.activeAnomalies.map((item) => item.code)).toContain(
        "missing_acceptance",
      );
      if (!autoAccept) {
        const run = await repositories.runs.get(dispatched.body.runId);
        expect(run).toBeDefined();
        const repeated = await repositories.taskAnomalies.detect({
          taskId: task.id,
          runId: run!.id,
          runAttempt: run!.attempt,
          code: "missing_acceptance",
          message: "Repeated missing acceptance",
        });
        expect(repeated.occurrence).toBe(2);
        const repeatedHealth = await repositories.taskAnomalies.listActive(
          task.id,
        );
        expect(repeatedHealth).toHaveLength(1);
        const allItems = await evidence(task.id);
        await confirmItems({
          taskId: task.id,
          runId: run!.id,
          actorId: "local-admin",
          itemIds: allItems.body.items.map((item) => item.id),
        });
        const recovered = await request<TaskExecutionHealthProjection>(
          "GET",
          `/api/v1/tasks/${task.id}/execution-health`,
        );
        expect(recovered.body.health).toBe("healthy");
        expect(recovered.body.activeAnomalies).toHaveLength(0);
        const history = await database.query<{
          status: string;
          cleared_reason: string;
        }>(
          `SELECT status, cleared_reason
           FROM task_execution_anomalies
           WHERE task_id = $1
           ORDER BY detected_at`,
          [task.id],
        );
        expect(history.rows).toEqual([
          {
            status: "cleared",
            cleared_reason: "acceptance_evidence_completed",
          },
        ]);
      }
    }
  });

  it("G4 and G5 reject partial, stale-revision, and cross-run evidence", async () => {
    const project = await createProject("G4G5");
    await setEnforce(project.id);
    const role = await createRole(project.id, ["read", "write"]);
    const confirmer = `m1a-confirmer-${randomUUID().slice(0, 8)}`;
    await addHumanMember(project.id, confirmer, [role.id]);
    const agent = await createAgent();
    await addAgent(project.id, agent.id);
    const task = await createTask({
      projectId: project.id,
      agentId: agent.id,
      acceptance: ["First required item", "Second required item"],
      autoSubmit: false,
    });
    const dispatched = await dispatch(task.id);
    expect(dispatched.statusCode, JSON.stringify(dispatched.body)).toBe(202);
    await executeRun(dispatched.body.runId);

    const initial = await evidence(task.id);
    expect(initial.body.items).toHaveLength(2);
    const first = initial.body.items[0]!;
    const confirmed = await confirmItems({
      taskId: task.id,
      runId: dispatched.body.runId,
      actorId: confirmer,
      itemIds: [first.id],
    });
    expect(confirmed.statusCode, JSON.stringify(confirmed.body)).toBe(200);
    expect(confirmed.body.allRequiredConfirmed).toBe(false);

    const partialSubmit = await request<{ code: string }>(
      "POST",
      `/api/v1/tasks/${task.id}/submit`,
      { note: "partial evidence" },
      confirmer,
    );
    expect(partialSubmit.statusCode).toBe(409);
    expect(partialSubmit.body.code).toBe("acceptance_evidence_incomplete");

    await application.updateTask(task.id, {
      acceptance: ["Changed first item", "Second required item"],
    });
    const staleRevision = await request<{ code: string }>(
      "POST",
      `/api/v1/tasks/${task.id}/acceptance-evidence/confirmations`,
      {
        runId: dispatched.body.runId,
        items: [
          {
            acceptanceItemId: first.id,
            acceptanceItemRevision: first.revision,
            evidenceRefs: [
              { kind: "run-output", refId: dispatched.body.runId },
            ],
          },
        ],
      },
      confirmer,
    );
    expect(staleRevision.statusCode).toBe(409);
    expect(staleRevision.body.code).toBe("acceptance_item_not_current");

    const otherProject = await createProject("G5-old-run");
    const otherAgent = await createAgent();
    await addAgent(otherProject.id, otherAgent.id);
    const otherTask = await createTask({
      projectId: otherProject.id,
      agentId: otherAgent.id,
    });
    const otherDispatched = await dispatch(otherTask.id);
    expect(otherDispatched.statusCode).toBe(202);
    await executeRun(otherDispatched.body.runId);
    const currentItems = await evidence(task.id);
    const currentFirst = currentItems.body.items[0]!;
    const crossRun = await request<{ code: string }>(
      "POST",
      `/api/v1/tasks/${task.id}/acceptance-evidence/confirmations`,
      {
        runId: otherDispatched.body.runId,
        items: [
          {
            acceptanceItemId: currentFirst.id,
            acceptanceItemRevision: currentFirst.revision,
            evidenceRefs: [
              { kind: "run-output", refId: otherDispatched.body.runId },
            ],
          },
        ],
      },
      confirmer,
    );
    expect(crossRun.statusCode).toBe(409);
    expect(crossRun.body.code).toBe("acceptance_evidence_invalid");
  });

  it("G6 denies Agent self-approval and records audit", async () => {
    const project = await createProject("G6");
    await setEnforce(project.id);
    const role = await createRole(project.id, ["read", "write", "approve"]);
    const confirmer = `m1a-owner-${randomUUID().slice(0, 8)}`;
    await addHumanMember(project.id, confirmer, [role.id]);
    const agent = await createAgent();
    await addAgent(project.id, agent.id);
    const aiPrincipalId = `principal-ai-${randomUUID().slice(0, 8)}`;
    await database.query(
      `INSERT INTO principals (
         id, kind, display_name, status, status_authority, source,
         version, created_at, updated_at
       ) VALUES ($1, 'ai', 'M1a AI', 'active', 'ai-companion', 'ai-companion',
                 1, NOW(), NOW())`,
      [aiPrincipalId],
    );
    await database.query(
      "UPDATE agents SET principal_id = $2, updated_at = NOW() WHERE id = $1",
      [agent.id, aiPrincipalId],
    );
    const task = await createTask({
      projectId: project.id,
      agentId: agent.id,
      autoSubmit: false,
    });
    const dispatched = await dispatch(task.id);
    expect(dispatched.statusCode, JSON.stringify(dispatched.body)).toBe(202);
    await executeRun(dispatched.body.runId);
    const current = await evidence(task.id);
    await confirmItems({
      taskId: task.id,
      runId: dispatched.body.runId,
      actorId: confirmer,
      itemIds: current.body.items.map((item) => item.id),
    });
    const submitted = await request<Task>(
      "POST",
      `/api/v1/tasks/${task.id}/submit`,
      { note: "ready for independent review" },
      confirmer,
    );
    expect(submitted.statusCode, JSON.stringify(submitted.body)).toBe(200);

    await expect(
      application.reviewTask(
        task.id,
        {
          decision: "approve",
          note: "self approval must fail",
          redispatch: false,
        },
        aiPrincipalId,
      ),
    ).rejects.toMatchObject({
      code: "agent_self_approval_denied",
    } satisfies Partial<ApplicationError>);
    const audit = await database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM identity_audit_events
       WHERE action = 'task.review.agent_self_approval_denied'
         AND actor_principal_id = $1`,
      [aiPrincipalId],
    );
    expect(audit.rows[0]?.count).toBe("1");
  });
});
