import { randomUUID } from "node:crypto";
import type {
  ContextPack,
  ContextReceipt,
  SceneContextContribution,
  SceneContextReceipt,
} from "@pluginmax/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Database,
  migrate,
  PlatformRepositories,
  SceneContextRepositoryError,
} from "./index.js";
import { DEFAULT_AGENT_ID } from "./schema.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl === undefined ? describe.skip : describe;

integration("scene context repository", () => {
  let database: Database;
  let repositories: PlatformRepositories;

  beforeAll(async () => {
    database = new Database(databaseUrl!);
    await migrate(database);
    repositories = new PlatformRepositories(database);
    await repositories.authorization.ensureDevelopmentPrincipal(
      "local-admin",
      true,
    );
  });

  afterAll(async () => {
    await database.close();
  });

  async function project(label: string): Promise<string> {
    const created = await repositories.projects.create(
      {
        name: `${label} ${randomUUID().slice(0, 8)}`,
        description: "Batch 16 Scene Context fixture",
      },
      "local-admin",
      "Local Admin",
    );
    return created.id;
  }

  function contributionSnapshot(
    contribution: SceneContextContribution,
  ): SceneContextReceipt["delivered"][number] {
    return {
      id: contribution.id,
      sourceKey: contribution.sourceKey,
      kind: contribution.kind,
      version: contribution.version,
      authority: contribution.authority,
      visibility: contribution.visibility,
      textDigest: "a".repeat(64),
      sourceRefs: contribution.sourceRefs,
      sequence: contribution.sequence,
    };
  }

  it("binds Task, Workflow Node, Meeting and Direct Chat to isolated handles", async () => {
    const projectId = await project("Scene bindings");
    const taskSession = await repositories.sceneContext.ensureSession({
      sceneType: "task",
      sceneId: randomUUID(),
      projectId,
      agentId: DEFAULT_AGENT_ID,
      agentPrincipalId: DEFAULT_AGENT_ID,
      ownerPrincipalId: null,
      channelId: null,
    });
    const workflowSession = await repositories.sceneContext.ensureSession({
      sceneType: "workflow-node",
      sceneId: `${randomUUID()}:review`,
      projectId,
      agentId: DEFAULT_AGENT_ID,
      agentPrincipalId: DEFAULT_AGENT_ID,
      ownerPrincipalId: null,
      channelId: null,
    });
    const meetingSession = await repositories.sceneContext.ensureSession({
      sceneType: "meeting",
      sceneId: randomUUID(),
      projectId,
      agentId: DEFAULT_AGENT_ID,
      agentPrincipalId: DEFAULT_AGENT_ID,
      ownerPrincipalId: null,
      channelId: null,
    });
    const channel = await repositories.sceneContext.ensureChatChannel({
      sceneId: randomUUID(),
      projectId: null,
      ownerPrincipalId: "local-admin",
      agentId: DEFAULT_AGENT_ID,
      agentPrincipalId: DEFAULT_AGENT_ID,
    });
    const chatSession = await repositories.sceneContext.ensureSession({
      sceneType: "direct-chat",
      sceneId: channel.sceneId,
      projectId: null,
      agentId: DEFAULT_AGENT_ID,
      agentPrincipalId: DEFAULT_AGENT_ID,
      ownerPrincipalId: "local-admin",
      channelId: channel.id,
    });

    expect(
      new Set(
        [taskSession, workflowSession, meetingSession, chatSession].map(
          (session) => session.sessionHandle,
        ),
      ).size,
    ).toBe(4);
    expect(chatSession.channelId).toBe(channel.id);
    expect(chatSession.sceneType).toBe("direct-chat");

    const repeated = await repositories.sceneContext.ensureSession({
      sceneType: "task",
      sceneId: taskSession.sceneId,
      projectId,
      agentId: DEFAULT_AGENT_ID,
      agentPrincipalId: DEFAULT_AGENT_ID,
      ownerPrincipalId: null,
      channelId: null,
    });
    expect(repeated.id).toBe(taskSession.id);
    expect(repeated.sessionHandle).toBe(taskSession.sessionHandle);
  });

  it("isolates contributions by Scene and private owner", async () => {
    const projectId = await project("Contribution isolation");
    const sharedSceneId = randomUUID();
    const first = await repositories.sceneContext.ensureSession({
      sceneType: "meeting",
      sceneId: sharedSceneId,
      projectId,
      agentId: DEFAULT_AGENT_ID,
      agentPrincipalId: DEFAULT_AGENT_ID,
      ownerPrincipalId: null,
      channelId: null,
    });
    const second = await repositories.sceneContext.ensureSession({
      sceneType: "task",
      sceneId: sharedSceneId,
      projectId,
      agentId: DEFAULT_AGENT_ID,
      agentPrincipalId: DEFAULT_AGENT_ID,
      ownerPrincipalId: null,
      channelId: null,
    });
    const publicContribution = await repositories.sceneContext.addContribution({
      session: first,
      sourceKey: "task-comment:public",
      kind: "task-comment-consensus",
      version: "1",
      authority: "evidence",
      visibility: "project",
      text: "Only the meeting Scene may include this.",
      sourceRefs: [
        {
          type: "meeting",
          id: first.sceneId,
          projectId,
          sceneType: "meeting",
          sceneId: first.sceneId,
        },
      ],
      createdBy: "local-admin",
    });
    const privateContribution = await repositories.sceneContext.addContribution(
      {
        session: first,
        sourceKey: "meeting-private-note:1",
        kind: "meeting-private-note",
        version: "1",
        authority: "evidence",
        visibility: "private",
        text: "Private meeting note for Local Admin.",
        sourceRefs: [
          {
            type: "meeting",
            id: first.sceneId,
            projectId,
            sceneType: "meeting",
            sceneId: first.sceneId,
          },
        ],
        createdBy: "local-admin",
        ownerPrincipalId: "local-admin",
      },
    );

    const firstVisible = await repositories.sceneContext.listContributions({
      session: first,
      actorPrincipalId: "local-admin",
    });
    const secondVisible = await repositories.sceneContext.listContributions({
      session: second,
      actorPrincipalId: "local-admin",
    });
    const outsiderVisible = await repositories.sceneContext.listContributions({
      session: first,
      actorPrincipalId: "another-principal",
    });

    expect(firstVisible.map((item) => item.id)).toEqual([
      publicContribution.id,
      privateContribution.id,
    ]);
    expect(secondVisible).toEqual([]);
    expect(outsiderVisible.map((item) => item.id)).toEqual([
      publicContribution.id,
    ]);
    await expect(
      repositories.sceneContext.addContribution({
        session: first,
        sourceKey: "task-comment:public",
        kind: "task-comment-consensus",
        version: "1",
        authority: "evidence",
        visibility: "project",
        text: "A conflicting mutation.",
        sourceRefs: [],
        createdBy: "local-admin",
      }),
    ).rejects.toBeInstanceOf(SceneContextRepositoryError);
    await expect(
      database.query(
        "UPDATE scene_context_contributions SET text = 'mutated' WHERE id = $1",
        [publicContribution.id],
      ),
    ).rejects.toThrow("immutable");
  });

  it("commits deterministic receipts, advances cursors and replays once", async () => {
    const projectId = await project("Receipt replay");
    const task = await repositories.tasks.create(
      {
        projectId,
        title: "Scene receipt task",
        description: "Exercise deterministic Scene receipts.",
        acceptance: [],
        dependsOn: [],
      },
      DEFAULT_AGENT_ID,
    );
    const runId = randomUUID();
    await database.query(
      `INSERT INTO runs (
         id, project_id, task_id, agent_id, status, input_snapshot,
         observability, attempt, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, 'queued',
         '{"taskTitle":"Scene receipt task","taskDescription":"fixture","acceptance":[],"instruction":"fixture","agentName":"Fake Research Agent","runtimeKind":"fake"}'::jsonb,
         '{"planVisibility":"structured","toolEventCompleteness":"complete","textStreaming":"delta","subagentVisibility":"none"}'::jsonb,
         1, NOW(), NOW()
       )`,
      [runId, projectId, task.id, DEFAULT_AGENT_ID],
    );
    const binding = await repositories.sceneContext.ensureSession({
      sceneType: "task",
      sceneId: task.id,
      projectId,
      agentId: DEFAULT_AGENT_ID,
      agentPrincipalId: DEFAULT_AGENT_ID,
      ownerPrincipalId: null,
      channelId: null,
    });
    const contribution = await repositories.sceneContext.addContribution({
      session: binding,
      sourceKey: "task-comment:consensus",
      kind: "task-comment-consensus",
      version: "1",
      authority: "evidence",
      visibility: "project",
      text: "Deterministic Scene contribution.",
      sourceRefs: [
        {
          type: "task-comment",
          id: "00000000-0000-4000-8000-000000009001",
          projectId,
          sceneType: "task",
          sceneId: task.id,
        },
      ],
      createdBy: "local-admin",
    });
    const packId = randomUUID();
    const receiptId = randomUUID();
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    const pack: ContextPack = {
      id: packId,
      runId,
      projectId,
      taskId: task.id,
      meetingTurnId: null,
      directChatTurnId: null,
      agentId: DEFAULT_AGENT_ID,
      identity: { name: "Fake Research Agent", runtimeKind: "fake" },
      sources: [
        {
          type: "comment",
          id: contribution.id,
          label: contribution.text,
          projectId,
          sceneType: "task",
          sceneId: task.id,
        },
      ],
      renderedPrompt: "Scene prompt",
      contentHash: "b".repeat(64),
      createdAt: createdAt.toISOString(),
      sceneType: "task",
      sceneId: task.id,
      sceneSessionId: binding.id,
      sessionHandle: binding.sessionHandle,
      agentPrincipalId: DEFAULT_AGENT_ID,
      contributions: [contribution],
      logicalDigest: "c".repeat(64),
      rendererVersion: "scene-context-v1",
      asOf: createdAt.toISOString(),
    };
    const legacyReceipt: ContextReceipt = {
      contextPackId: pack.id,
      runId,
      usedSources: pack.sources,
      excludedSources: [],
      reason: "fixture",
      createdAt: createdAt.toISOString(),
      id: receiptId,
      sceneType: "task",
      sceneId: task.id,
      sceneSessionId: binding.id,
      agentPrincipalId: DEFAULT_AGENT_ID,
      logicalDigest: pack.logicalDigest,
      rendererVersion: pack.rendererVersion,
      runtimeStateful: true,
      cursorBefore: 0,
      cursorAfter: contribution.sequence,
      deliveredContributions: [contributionSnapshot(contribution)],
      reusedContributions: [],
      sceneExcludedSources: [],
      sourceRefs: contribution.sourceRefs,
    };
    const receipt: SceneContextReceipt = {
      id: receiptId,
      runId,
      contextPackId: pack.id,
      sceneSessionId: binding.id,
      sceneType: "task",
      sceneId: task.id,
      projectId,
      agentId: DEFAULT_AGENT_ID,
      principalId: "local-admin",
      agentPrincipalId: DEFAULT_AGENT_ID,
      logicalDigest: pack.logicalDigest!,
      contentHash: pack.contentHash,
      rendererVersion: pack.rendererVersion!,
      runtimeStateful: true,
      cursorBefore: 0,
      cursorAfter: contribution.sequence,
      delivered: [contributionSnapshot(contribution)],
      reused: [],
      sourceRefs: contribution.sourceRefs,
      excluded: [],
      createdAt: createdAt.toISOString(),
    };

    const persisted = await repositories.sceneContext.saveDelivery({
      pack,
      legacyReceipt,
      receipt,
    });
    const replay = await repositories.sceneContext.saveDelivery({
      pack,
      legacyReceipt,
      receipt,
    });
    expect(persisted).toEqual(receipt);
    expect(replay).toEqual(receipt);
    expect(
      (await repositories.sceneContext.cursor(binding.id))?.cursorSequence,
    ).toBe(contribution.sequence);
    expect(
      (await repositories.sceneContext.snapshotForRun(runId, "local-admin"))
        ?.receipt?.logicalDigest,
    ).toBe(pack.logicalDigest);
    await expect(
      database.query(
        "UPDATE context_packs SET content_hash = $2 WHERE run_id = $1",
        [runId, "d".repeat(64)],
      ),
    ).rejects.toThrow("immutable");
    await expect(
      database.query(
        "UPDATE scene_context_receipts SET logical_digest = $2 WHERE run_id = $1",
        [runId, "d".repeat(64)],
      ),
    ).rejects.toThrow("immutable");
  });

  it("keeps cross-project memory and private episodes inside their Scene", async () => {
    const firstProjectId = await project("Memory Scene A");
    const secondProjectId = await project("Memory Scene B");
    const firstEpisode = await repositories.memoryClosure.createEpisode({
      projectId: firstProjectId,
      actorId: DEFAULT_AGENT_ID,
      data: {
        agentId: DEFAULT_AGENT_ID,
        visibility: "private",
        kind: "reflection",
        summary: "Project A private episode",
        content: "Only Project A and this agent may see it.",
        sourceRefs: [],
      },
    });
    const secondEpisode = await repositories.memoryClosure.createEpisode({
      projectId: secondProjectId,
      actorId: DEFAULT_AGENT_ID,
      data: {
        agentId: DEFAULT_AGENT_ID,
        visibility: "private",
        kind: "reflection",
        summary: "Project B private episode",
        content: "Only Project B and this agent may see it.",
        sourceRefs: [],
      },
    });
    const firstSession = await repositories.sceneContext.ensureSession({
      sceneType: "task",
      sceneId: randomUUID(),
      projectId: firstProjectId,
      agentId: DEFAULT_AGENT_ID,
      agentPrincipalId: DEFAULT_AGENT_ID,
      ownerPrincipalId: null,
      channelId: null,
    });
    const secondSession = await repositories.sceneContext.ensureSession({
      sceneType: "task",
      sceneId: randomUUID(),
      projectId: secondProjectId,
      agentId: DEFAULT_AGENT_ID,
      agentPrincipalId: DEFAULT_AGENT_ID,
      ownerPrincipalId: null,
      channelId: null,
    });
    await repositories.sceneContext.addContribution({
      session: firstSession,
      sourceKey: `agent-episode:${firstEpisode.id}`,
      kind: "agent-memory",
      version: firstEpisode.createdAt,
      authority: "evidence",
      visibility: "private",
      text: firstEpisode.summary,
      sourceRefs: [
        {
          type: "agent-episode",
          id: firstEpisode.id,
          projectId: firstProjectId,
          sceneType: "task",
          sceneId: firstSession.sceneId,
        },
      ],
      createdBy: DEFAULT_AGENT_ID,
      ownerPrincipalId: "local-admin",
    });

    expect(
      (
        await repositories.memoryClosure.listEpisodesForContext(
          firstProjectId,
          DEFAULT_AGENT_ID,
        )
      ).map((episode) => episode.id),
    ).toEqual([firstEpisode.id]);
    expect(
      (
        await repositories.memoryClosure.listEpisodesForContext(
          secondProjectId,
          DEFAULT_AGENT_ID,
        )
      ).map((episode) => episode.id),
    ).toEqual([secondEpisode.id]);
    expect(
      (
        await repositories.sceneContext.listContributions({
          session: firstSession,
          actorPrincipalId: "local-admin",
        })
      ).map((item) => item.text),
    ).toEqual([firstEpisode.summary]);
    expect(
      await repositories.sceneContext.listContributions({
        session: secondSession,
        actorPrincipalId: "local-admin",
      }),
    ).toEqual([]);
  });
});
