import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  legacyTaskExecutionPolicy,
  taskExecutionPolicySchema,
  type ActionTicketBundle,
  type Agent,
  type DirectChatSendResult,
  type DirectChatThread,
  type Project,
  type SceneContextContribution,
  type SceneContextReplayResult,
  type SceneContextSnapshot,
  type Task,
  type TaskMessage,
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

integration("Scene Context API and Worker", () => {
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
      join(tmpdir(), "pluginmax-scene-context-files-"),
    );
    const workspaceRoot = await mkdtemp(
      join(tmpdir(), "pluginmax-scene-context-workspaces-"),
    );
    const built = buildApi({
      databaseUrl: databaseUrl!,
      database,
      fileStoreRoot,
      logger: false,
      localActorId: "local-admin",
      expectedMigrationVersion: 31,
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
      body: response.json() as T,
    };
  }

  async function createProject(label: string): Promise<Project> {
    const result = await request<Project>("POST", "/api/v1/projects", {
      name: `${label} ${randomUUID().slice(0, 8)}`,
      description: "Batch 16 Scene Context fixture",
    });
    expect(result.statusCode).toBe(201);
    return result.body;
  }

  async function createAgent(label: string): Promise<Agent> {
    const result = await request<Agent>("POST", "/api/v1/agents", {
      name: `${label} ${randomUUID().slice(0, 8)}`,
      description: "Scene Context worker fixture",
      runtimeKind: "fake",
    });
    expect(result.statusCode).toBe(201);
    return result.body;
  }

  async function addAgent(projectId: string, agentId: string): Promise<void> {
    const result = await request(
      "POST",
      `/api/v1/projects/${projectId}/members`,
      {
        kind: "agent",
        agentId,
        responsibility: "Scene Context execution",
        roleIds: [],
      },
    );
    expect(result.statusCode).toBe(201);
  }

  async function processRun(runId: string): Promise<void> {
    const owner = `scene-worker-${randomUUID()}`;
    const job: ClaimedJob | undefined = await repositories.jobs.claimNext(
      owner,
      60,
      runId,
    );
    expect(job).toBeDefined();
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

  async function sceneContext(
    runId: string,
    actorId = "local-admin",
  ): Promise<{
    scene: SceneContextSnapshot;
    pack: { id: string; logicalDigest?: string; renderedPrompt: string };
  }> {
    const result = await request<{
      scene: SceneContextSnapshot;
      pack: { id: string; logicalDigest?: string; renderedPrompt: string };
    }>("GET", `/api/v1/runs/${runId}/scene-context`, undefined, actorId);
    expect(result.statusCode, JSON.stringify(result.body)).toBe(200);
    return result.body;
  }

  it("waits for a blocking Gate, then persists a deterministic Task Scene receipt", async () => {
    const project = await createProject("Task Scene");
    const agent = await createAgent("Task Scene agent");
    await addAgent(project.id, agent.id);
    const created = await request<Task>("POST", "/api/v1/tasks", {
      projectId: project.id,
      title: "Build a gated Scene",
      description: "Scene context must not bypass the Execution Gate.",
      acceptance: ["Keep an audit receipt"],
      agentId: agent.id,
    });
    expect(created.statusCode).toBe(201);
    const consensus = await request<TaskMessage>(
      "POST",
      `/api/v1/tasks/${created.body.id}/messages`,
      {
        content: "Keep the final report under 1000 words.",
        isKeyConsensus: true,
      },
    );
    expect(consensus.statusCode).toBe(201);
    expect(consensus.body.isKeyConsensus).toBe(true);
    const policy = taskExecutionPolicySchema.parse({
      ...legacyTaskExecutionPolicy(),
      humanGates: [
        {
          id: "scene-context-gate",
          kind: "preflight",
          reason: "Approve Scene-aware execution",
          enforcement: "blocking",
        },
      ],
    });
    const policyResult = await request(
      "PUT",
      `/api/v1/tasks/${created.body.id}/execution-policy`,
      { expectedRevision: 0, policy },
    );
    expect(policyResult.statusCode).toBe(200);
    const dispatch = await request<{ runId: string }>(
      "POST",
      `/api/v1/tasks/${created.body.id}/dispatch`,
    );
    expect(dispatch.statusCode).toBe(202);

    const blockedContext = await request(
      "GET",
      `/api/v1/runs/${dispatch.body.runId}/scene-context`,
    );
    expect(blockedContext.statusCode).toBe(404);
    expect(
      await repositories.jobs.claimNext(
        "blocked-scene-worker",
        30,
        dispatch.body.runId,
      ),
    ).toBeUndefined();

    const ticket = await request<ActionTicketBundle>(
      "GET",
      `/api/v1/runs/${dispatch.body.runId}/action-ticket`,
    );
    expect(ticket.statusCode).toBe(200);
    const gate = ticket.body.gates.find(
      (candidate) => candidate.status === "pending",
    );
    expect(gate).toBeDefined();
    const approval = await request(
      "POST",
      `/api/v1/execution-gates/${gate!.gateId}/decisions`,
      { decision: "approve", basis: "Scene context verified" },
    );
    expect(approval.statusCode).toBe(200);
    await processRun(dispatch.body.runId);

    const first = await sceneContext(dispatch.body.runId);
    const replay = await request<SceneContextReplayResult>(
      "GET",
      `/api/v1/runs/${dispatch.body.runId}/scene-context/replay`,
    );
    const repeated = await sceneContext(dispatch.body.runId);
    expect(first.scene.binding).toMatchObject({
      sceneType: "task",
      sceneId: created.body.id,
      projectId: project.id,
    });
    expect(first.scene.receipt).toMatchObject({
      contextPackId: first.pack.id,
      sceneSessionId: first.scene.binding.id,
      runtimeStateful: false,
    });
    expect(
      first.scene.receipt?.delivered.some(
        (item) =>
          item.kind === "task-comment-consensus" &&
          item.sourceRefs.some(
            (ref) =>
              ref.type === "task-comment" && ref.id === consensus.body.id,
          ),
      ),
    ).toBe(true);
    expect(first.pack.renderedPrompt).toContain(
      "Keep the final report under 1000 words.",
    );
    expect(replay.statusCode).toBe(200);
    expect(replay.body).toMatchObject({
      replayed: true,
      deterministic: true,
      contextPackId: first.pack.id,
      receiptId: first.scene.receipt?.id,
    });
    expect(repeated.pack.id).toBe(first.pack.id);
    expect(repeated.scene.receipt).toEqual(first.scene.receipt);
  }, 15_000);

  it("uses a private Direct Chat channel and keeps Scene handles isolated", async () => {
    const project = await createProject("Chat Scene");
    const agent = await createAgent("Chat Scene agent");
    await addAgent(project.id, agent.id);
    const thread = await request<DirectChatThread>(
      "POST",
      "/api/v1/direct-chats",
      { agentId: agent.id },
    );
    expect(thread.statusCode).toBe(200);
    const sent = await request<DirectChatSendResult>(
      "POST",
      `/api/v1/direct-chats/${thread.body.id}/messages`,
      {
        content: "Private chat Scene input.",
        clientMessageId: randomUUID(),
      },
    );
    expect(sent.statusCode).toBe(202);
    await processRun(sent.body.run.id);

    const chat = await sceneContext(sent.body.run.id);
    expect(chat.scene.binding).toMatchObject({
      sceneType: "direct-chat",
      sceneId: thread.body.id,
      projectId: null,
      ownerPrincipalId: "local-admin",
    });
    expect(chat.scene.channel).toMatchObject({
      sceneId: thread.body.id,
      ownerPrincipalId: "local-admin",
      agentId: agent.id,
    });
    expect(chat.scene.channel?.id).toBe(chat.scene.binding.channelId);
    expect(chat.pack.renderedPrompt).toContain("Private chat Scene input.");

    const privateContribution = await request<SceneContextContribution>(
      "POST",
      `/api/v1/runs/${sent.body.run.id}/scene-context/contributions`,
      {
        kind: "meeting-private-note",
        authority: "evidence",
        visibility: "private",
        sourceKey: `private-chat:${randomUUID()}`,
        version: "1",
        text: "Only this owner and agent Scene may read this note.",
        sourceRefs: [
          {
            type: "direct-chat",
            id: thread.body.id,
            sceneType: "direct-chat",
            sceneId: thread.body.id,
          },
        ],
      },
    );
    expect(privateContribution.statusCode).toBe(201);
    const ownerView = await sceneContext(sent.body.run.id);
    expect(ownerView.scene.contributions.map((item) => item.id)).toContain(
      privateContribution.body.id,
    );
    const outsiderView = await request(
      "GET",
      `/api/v1/runs/${sent.body.run.id}/scene-context`,
      undefined,
      "scene-outsider",
    );
    expect(outsiderView.statusCode).toBe(403);

    const taskSession = await repositories.sceneContext.ensureSession({
      sceneType: "task",
      sceneId: thread.body.id,
      projectId: project.id,
      agentId: agent.id,
      agentPrincipalId: agent.id,
      ownerPrincipalId: null,
      channelId: null,
    });
    expect(taskSession.sessionHandle).not.toBe(
      chat.scene.binding.sessionHandle,
    );
    expect(
      await repositories.sceneContext.listContributions({
        session: taskSession,
        actorPrincipalId: "local-admin",
      }),
    ).toEqual([]);
  });
});
