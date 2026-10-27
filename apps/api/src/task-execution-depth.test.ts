import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Agent,
  type Project,
  type SceneContextSnapshot,
  type SceneSessionResetResult,
  type Task,
  type TaskClaim,
  type TaskDetail,
  type TaskDocumentDiscovery,
  type TaskMessage,
  type TaskQueueItem,
  type RevealTaskDocumentResult,
} from "@pluginmax/contracts";
import { RunExecutor } from "@pluginmax/application";
import {
  Database,
  migrate,
  PlatformRepositories,
  type ClaimedJob,
} from "@pluginmax/database";
import { buildApi } from "./app.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl === undefined ? describe.skip : describe;

integration("Batch 17A task execution depth", () => {
  let database: Database;
  let repositories: PlatformRepositories;
  let app: ReturnType<typeof buildApi>["app"];
  let executor: RunExecutor;

  beforeAll(async () => {
    database = new Database(databaseUrl!);
    await migrate(database);
    repositories = new PlatformRepositories(database);
    await repositories.authorization.ensureDevelopmentPrincipal(
      "local-admin",
      true,
    );
    const fileStoreRoot = await mkdtemp(
      join(tmpdir(), "pluginmax-batch17a-files-"),
    );
    const workspaceRoot = await mkdtemp(
      join(tmpdir(), "pluginmax-batch17a-workspaces-"),
    );
    const built = buildApi({
      databaseUrl: databaseUrl!,
      database,
      fileStoreRoot,
      logger: { level: "error" },
      localActorId: "local-admin",
      expectedMigrationVersion: 28,
    });
    app = built.app;
    await app.ready();
    executor = new RunExecutor(repositories, {
      workspaceRoot,
      fileStoreRoot,
      dsh: {
        dshBin: "dsh",
        profile: "sdk",
        dshHome: join(workspaceRoot, "dsh-home"),
        provider: "test",
        model: "test",
      },
      runtimeEffectPollIntervalMs: 50,
    });
  });

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  async function request<T>(
    method: "GET" | "POST" | "PUT" | "PATCH",
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
      body: response.payload === "" ? (undefined as T) : (response.json() as T),
    };
  }

  async function createProject(label: string): Promise<Project> {
    const result = await request<Project>("POST", "/api/v1/projects", {
      name: `${label} ${randomUUID().slice(0, 8)}`,
      description: "Batch 17A execution-depth fixture",
    });
    expect(result.statusCode, JSON.stringify(result.body)).toBe(201);
    return result.body;
  }

  async function createAgent(label: string): Promise<Agent> {
    const result = await request<Agent>("POST", "/api/v1/agents", {
      name: `${label} ${randomUUID().slice(0, 8)}`,
      description: "Batch 17A task execution fixture",
      runtimeKind: "fake",
    });
    expect(result.statusCode, JSON.stringify(result.body)).toBe(201);
    return result.body;
  }

  async function addAgent(projectId: string, agentId: string): Promise<void> {
    const result = await request(
      "POST",
      `/api/v1/projects/${projectId}/members`,
      {
        kind: "agent",
        agentId,
        responsibility: "Batch 17A execution",
        roleIds: [],
      },
    );
    expect(result.statusCode, JSON.stringify(result.body)).toBe(201);
  }

  async function createTask(
    projectId: string,
    agentId: string,
    input: {
      readonly title: string;
      readonly priority?: Task["priority"];
      readonly dependsOn?: readonly string[];
      readonly autoSubmit?: boolean;
      readonly autoAccept?: boolean;
      readonly autoRedispatchOnReturn?: boolean;
    },
  ): Promise<Task> {
    const result = await request<Task>("POST", "/api/v1/tasks", {
      projectId,
      title: input.title,
      description: `${input.title} execution-depth fixture`,
      acceptance: ["Return a deterministic result"],
      agentId,
      priority: input.priority ?? "medium",
      dependsOn: input.dependsOn ?? [],
      autoSubmit: input.autoSubmit ?? true,
      autoAccept: input.autoAccept ?? false,
      autoRedispatchOnReturn: input.autoRedispatchOnReturn ?? false,
    });
    expect(result.statusCode, JSON.stringify(result.body)).toBe(201);
    return result.body;
  }

  async function processRun(runId: string): Promise<void> {
    const owner = `batch17a-worker-${randomUUID()}`;
    const job: ClaimedJob | undefined = await repositories.jobs.claimNext(
      owner,
      60,
      runId,
    );
    expect(job, `claim ${runId}`).toBeDefined();
    await executor.execute(job!.runId, {
      jobId: job!.id,
      owner,
      leaseSeconds: 60,
      traceId: job!.traceId,
      jobSpanId: job!.spanId,
      assertLease: async () => undefined,
    });
    expect(
      await repositories.jobs.complete(job!.id, owner, job!.leaseToken),
    ).toBe(true);
  }

  async function setDependencyDone(taskId: string): Promise<void> {
    await database.query(
      "UPDATE tasks SET status = 'done', updated_at = NOW() WHERE id = $1",
      [taskId],
    );
  }

  it("sorts by priority, blocks dependencies, and recovers concurrent Claims", async () => {
    const project = await createProject("Queue project");
    const agent = await createAgent("Queue agent");
    await addAgent(project.id, agent.id);
    const low = await createTask(project.id, agent.id, {
      title: "Low queue",
      priority: "low",
    });
    const urgentBlocked = await createTask(project.id, agent.id, {
      title: "Urgent blocked",
      priority: "urgent",
      dependsOn: [low.id],
    });
    const medium = await createTask(project.id, agent.id, {
      title: "Medium queue",
      priority: "medium",
    });
    const high = await createTask(project.id, agent.id, {
      title: "High queue",
      priority: "high",
    });

    const queue = await request<{ items: TaskQueueItem[] }>(
      "GET",
      `/api/v1/projects/${project.id}/task-queue`,
    );
    expect(queue.statusCode).toBe(200);
    expect(queue.body.items.map((item) => item.task.id)).toEqual([
      urgentBlocked.id,
      high.id,
      medium.id,
      low.id,
    ]);
    expect(
      queue.body.items.find((item) => item.task.id === urgentBlocked.id),
    ).toMatchObject({
      eligible: false,
      blockedReasons: ["dependency"],
    });

    const claimProject = await createProject("Single claim project");
    const onlyClaimable = await createTask(claimProject.id, agent.id, {
      title: "Only claimable task",
      priority: "urgent",
    });
    const [first, second] = await Promise.all([
      request<TaskClaim | undefined>(
        "POST",
        `/api/v1/projects/${claimProject.id}/task-queue/claim`,
        { ownerId: "queue-worker-a", leaseSeconds: 30 },
      ),
      request<TaskClaim | undefined>(
        "POST",
        `/api/v1/projects/${claimProject.id}/task-queue/claim`,
        { ownerId: "queue-worker-b", leaseSeconds: 30 },
      ),
    ]);
    const claims = [first, second].filter(
      (result) => result.statusCode === 200,
    );
    expect(claims).toHaveLength(1);
    const claim = claims[0]!.body;
    expect(claim).toBeDefined();
    if (claim === undefined) throw new Error("claim fixture is missing");
    expect(claim.task.id).toBe(onlyClaimable.id);
    expect(claim.claimToken).toBeTruthy();

    await database.query(
      `UPDATE tasks
       SET execution_claim_expires_at = NOW() - INTERVAL '1 second'
       WHERE id = $1`,
      [onlyClaimable.id],
    );
    const recovered = await request<TaskClaim>(
      "POST",
      `/api/v1/projects/${claimProject.id}/task-queue/claim`,
      { ownerId: "queue-worker-c", leaseSeconds: 30 },
    );
    expect(recovered.statusCode).toBe(200);
    expect(recovered.body.task.id).toBe(onlyClaimable.id);
    expect(recovered.body.claimToken).not.toBe(claim.claimToken);

    await setDependencyDone(low.id);
    const released = await request<Task>(
      "POST",
      `/api/v1/tasks/${onlyClaimable.id}/claim/release`,
      { claimToken: recovered.body.claimToken },
    );
    expect(released.statusCode, JSON.stringify(released.body)).toBe(200);
    const next = await request<TaskClaim>(
      "POST",
      `/api/v1/projects/${claimProject.id}/task-queue/claim`,
      { ownerId: "queue-worker-d", leaseSeconds: 30 },
    );
    expect(next.statusCode).toBe(200);
    expect(next.body.task.id).toBe(onlyClaimable.id);
    const unblockedQueue = await request<{ items: TaskQueueItem[] }>(
      "GET",
      `/api/v1/projects/${project.id}/task-queue`,
    );
    expect(
      unblockedQueue.body.items.find(
        (item) => item.task.id === urgentBlocked.id,
      )?.eligible,
    ).toBe(true);
  });

  it("pauses, blocks, waits for input, resumes idempotently, and resets Sessions by generation", async () => {
    const project = await createProject("Control project");
    const agent = await createAgent("Control agent");
    await addAgent(project.id, agent.id);
    const task = await createTask(project.id, agent.id, {
      title: "Controlled execution",
    });

    const paused = await request<Task>(
      "POST",
      `/api/v1/tasks/${task.id}/pause`,
      {
        reason: "Pause for dependency review",
        expectedRevision: task.revision,
      },
    );
    expect(paused.statusCode, JSON.stringify(paused.body)).toBe(200);
    expect(paused.body).toMatchObject({
      status: "paused",
      pausedReason: "Pause for dependency review",
    });
    const resumed = await request<Task>(
      "POST",
      `/api/v1/tasks/${task.id}/resume`,
      { note: "Review complete", expectedRevision: paused.body.revision },
    );
    expect(resumed.statusCode).toBe(200);
    const resumedAgain = await request<Task>(
      "POST",
      `/api/v1/tasks/${task.id}/resume`,
      { note: "Duplicate recovery" },
    );
    expect(resumedAgain.statusCode).toBe(200);
    expect(resumedAgain.body.status).toBe("queued");

    const blocked = await request<Task>(
      "POST",
      `/api/v1/tasks/${task.id}/block`,
      {
        reason: "External data unavailable",
        expectedRevision: resumed.body.revision,
      },
    );
    expect(blocked.statusCode).toBe(200);
    expect(blocked.body.status).toBe("blocked");
    const unblocked = await request<Task>(
      "POST",
      `/api/v1/tasks/${task.id}/resume`,
      { note: "Data restored", expectedRevision: blocked.body.revision },
    );
    expect(unblocked.statusCode).toBe(200);

    const needsInput = await request<TaskDetail>(
      "POST",
      `/api/v1/tasks/${task.id}/request-input`,
      {
        prompt: "Provide the missing account list",
        expectedRevision: unblocked.body.revision,
      },
    );
    expect(needsInput.statusCode).toBe(200);
    expect(needsInput.body.task.status).toBe("needs_input");
    const provided = await request<TaskDetail>(
      "POST",
      `/api/v1/tasks/${task.id}/input`,
      {
        content: "The account list is attached in this thread.",
        expectedRevision: needsInput.body.task.revision,
      },
    );
    expect(provided.statusCode).toBe(200);
    expect(provided.body.task.status).toBe("queued");
    expect(provided.body.messages.at(-1)).toMatchObject({
      deliveryTarget: "receiver",
      content: "The account list is attached in this thread.",
    });

    const firstDispatch = await request<{ runId: string }>(
      "POST",
      `/api/v1/tasks/${task.id}/dispatch`,
    );
    expect(firstDispatch.statusCode).toBe(202);
    await processRun(firstDispatch.body.runId);
    const firstContext = await request<{
      scene: SceneContextSnapshot;
    }>("GET", `/api/v1/runs/${firstDispatch.body.runId}/scene-context`);
    expect(firstContext.statusCode).toBe(200);
    expect(firstContext.body.scene.binding.generation).toBe(0);

    const reset = await request<SceneSessionResetResult>(
      "POST",
      `/api/v1/tasks/${task.id}/session-reset`,
      { reason: "Start a clean persistent Session" },
    );
    expect(reset.statusCode, JSON.stringify(reset.body)).toBe(200);
    expect(reset.body.session.generation).toBe(1);
    expect(reset.body.session.id).not.toBe(firstContext.body.scene.binding.id);

    const oldContext = await request<{
      scene: SceneContextSnapshot;
    }>("GET", `/api/v1/runs/${firstDispatch.body.runId}/scene-context`);
    expect(oldContext.body.scene.binding.generation).toBe(0);
    const returned = await request<Task>(
      "POST",
      `/api/v1/tasks/${task.id}/review`,
      { decision: "return", note: "Use the reset Session", redispatch: true },
    );
    expect(returned.statusCode, JSON.stringify(returned.body)).toBe(200);
    const runs = await repositories.runs.listByTask(task.id);
    const secondRun = runs.find((run) => run.id !== firstDispatch.body.runId);
    expect(secondRun).toBeDefined();
    await processRun(secondRun!.id);
    const secondContext = await request<{
      scene: SceneContextSnapshot;
    }>("GET", `/api/v1/runs/${secondRun!.id}/scene-context`);
    expect(secondContext.body.scene.binding.generation).toBe(1);
    expect(secondContext.body.scene.binding.id).toBe(reset.body.session.id);
  });

  it("discovers, reveals, uploads, archives, and project-scopes task documents", async () => {
    const project = await createProject("Documents project");
    const agent = await createAgent("Documents agent");
    await addAgent(project.id, agent.id);
    const task = await createTask(project.id, agent.id, {
      title: "Document execution",
    });
    const content = Buffer.from("batch 17a evidence", "utf8").toString(
      "base64",
    );
    const documentPath = `documents/${task.id}/evidence/requirements.md`;
    const uploaded = await request<TaskDetail["attachments"][number]>(
      "POST",
      `/api/v1/tasks/${task.id}/attachments`,
      {
        name: "requirements.md",
        mimeType: "text/markdown",
        contentBase64: content,
        documentPath,
      },
    );
    expect(uploaded.statusCode, JSON.stringify(uploaded.body)).toBe(201);
    expect(uploaded.body.documentPath).toBe(documentPath);

    const forbidden = await request(
      "POST",
      `/api/v1/tasks/${task.id}/attachments`,
      {
        name: "escape.md",
        mimeType: "text/markdown",
        contentBase64: content,
        documentPath: `documents/${randomUUID()}/escape.md`,
      },
    );
    expect(forbidden.statusCode).toBe(403);
    const traversal = await request(
      "POST",
      `/api/v1/tasks/${task.id}/attachments`,
      {
        name: "traversal.md",
        mimeType: "text/markdown",
        contentBase64: content,
        documentPath: `documents/${task.id}/../escape.md`,
      },
    );
    expect(traversal.statusCode).toBe(400);

    const discovered = await request<TaskDocumentDiscovery>(
      "GET",
      `/api/v1/tasks/${task.id}/documents`,
    );
    expect(discovered.statusCode).toBe(200);
    expect(discovered.body).toMatchObject({
      scope: "task",
      includeArchived: false,
    });
    expect(discovered.body.items.map((item) => item.documentPath)).toEqual([
      documentPath,
    ]);
    const revealed = await request<RevealTaskDocumentResult>(
      "POST",
      `/api/v1/tasks/${task.id}/documents/${uploaded.body.id}/reveal`,
    );
    expect(revealed.statusCode).toBe(200);
    expect(revealed.body.revealPath).toBe(documentPath);
    expect(revealed.body.scopedTo).toEqual({
      projectId: project.id,
      taskId: task.id,
    });

    const outsider = await request<TaskDocumentDiscovery>(
      "GET",
      `/api/v1/tasks/${task.id}/documents`,
      undefined,
      "outsider",
    );
    expect(outsider.statusCode).toBe(403);

    const archived = await request(
      "POST",
      `/api/v1/attachments/${uploaded.body.id}/archive`,
      { archived: true },
    );
    expect(archived.statusCode).toBe(200);
    const afterArchive = await request<TaskDocumentDiscovery>(
      "GET",
      `/api/v1/tasks/${task.id}/documents`,
    );
    expect(afterArchive.body.items).toHaveLength(0);
    const archivedReveal = await request(
      "POST",
      `/api/v1/tasks/${task.id}/documents/${uploaded.body.id}/reveal`,
    );
    expect(archivedReveal.statusCode).toBe(409);
  });

  it("auto-submits, auto-accepts, and returns Review feedback to the receiver", async () => {
    const project = await createProject("Review project");
    const agent = await createAgent("Review agent");
    await addAgent(project.id, agent.id);

    const manualSubmit = await createTask(project.id, agent.id, {
      title: "Manual submit",
      autoSubmit: false,
    });
    const manualRun = await request<{ runId: string }>(
      "POST",
      `/api/v1/tasks/${manualSubmit.id}/dispatch`,
    );
    await processRun(manualRun.body.runId);
    expect((await repositories.tasks.get(manualSubmit.id))?.status).toBe(
      "in_progress",
    );
    const manualReview = await request<Task>(
      "POST",
      `/api/v1/tasks/${manualSubmit.id}/submit`,
      { note: "Manual submission after review of the output" },
    );
    expect(manualReview.statusCode, JSON.stringify(manualReview.body)).toBe(
      200,
    );
    expect(manualReview.body.status).toBe("review");

    const automatic = await createTask(project.id, agent.id, {
      title: "Automatic acceptance",
      autoSubmit: true,
      autoAccept: true,
    });
    const automaticRun = await request<{ runId: string }>(
      "POST",
      `/api/v1/tasks/${automatic.id}/dispatch`,
    );
    await processRun(automaticRun.body.runId);
    expect((await repositories.tasks.get(automatic.id))?.status).toBe("done");
    const reviews = await database.query<{ actor_id: string }>(
      "SELECT actor_id FROM task_reviews WHERE task_id = $1",
      [automatic.id],
    );
    expect(reviews.rows.map((row) => row.actor_id)).toContain(
      "system:auto-accept",
    );

    const returnedTask = await createTask(project.id, agent.id, {
      title: "Return review",
    });
    const returnedRun = await request<{ runId: string }>(
      "POST",
      `/api/v1/tasks/${returnedTask.id}/dispatch`,
    );
    await processRun(returnedRun.body.runId);
    expect((await repositories.tasks.get(returnedTask.id))?.status).toBe(
      "review",
    );
    const returned = await request<Task>(
      "POST",
      `/api/v1/tasks/${returnedTask.id}/review`,
      { decision: "return", note: "Add one competitor comparison" },
    );
    expect(returned.statusCode).toBe(200);
    expect(returned.body.status).toBe("queued");
    const detail = await request<TaskDetail>(
      "GET",
      `/api/v1/tasks/${returnedTask.id}/detail`,
    );
    expect(detail.body.messages.at(-1)).toMatchObject({
      content: "Add one competitor comparison",
      deliveryTarget: "receiver",
    });
  });

  it("dispatches deliveryTarget mentions without advancing collaborator Runs to Review", async () => {
    const project = await createProject("Delivery project");
    const owner = await createAgent("Delivery owner");
    const collaboratorA = await createAgent("Delivery collaborator A");
    const collaboratorB = await createAgent("Delivery collaborator B");
    await addAgent(project.id, owner.id);
    await addAgent(project.id, collaboratorA.id);
    await addAgent(project.id, collaboratorB.id);
    const task = await createTask(project.id, owner.id, {
      title: "Cross Agent task",
    });

    const comment = await request<TaskMessage>(
      "POST",
      `/api/v1/tasks/${task.id}/messages`,
      {
        content: "Review the requirement for development readiness",
        mentions: [collaboratorA.id, collaboratorB.id],
        deliveryTarget: "collaborators",
      },
    );
    expect(comment.statusCode, JSON.stringify(comment.body)).toBe(201);
    expect(comment.body.deliveryTarget).toBe("collaborators");
    expect(comment.body.triggeredRunIds).toHaveLength(2);
    const collaboratorRuns = await repositories.runs.listByTask(task.id);
    expect(
      collaboratorRuns.map((run) => ({
        agentId: run.agentId,
        kind: run.taskExecutionKind,
      })),
    ).toEqual(
      expect.arrayContaining([
        { agentId: collaboratorA.id, kind: "collaborator" },
        { agentId: collaboratorB.id, kind: "collaborator" },
      ]),
    );
    expect((await repositories.tasks.get(task.id))?.status).toBe("queued");
    await processRun(comment.body.triggeredRunIds[0]!);
    expect((await repositories.tasks.get(task.id))?.status).toBe("queued");

    const discussion = await request<TaskMessage>(
      "POST",
      `/api/v1/tasks/${task.id}/messages`,
      { content: "Human-only discussion does not dispatch" },
    );
    expect(discussion.statusCode).toBe(201);
    expect(discussion.body.deliveryTarget).toBeNull();
    expect(discussion.body.triggeredRunIds).toEqual([]);
    expect(await repositories.runs.listByTask(task.id)).toHaveLength(2);
  });
});
