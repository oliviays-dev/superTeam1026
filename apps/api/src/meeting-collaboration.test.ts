import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Database, PlatformRepositories, migrate } from "@pluginmax/database";
import { buildApi } from "./app.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl === undefined ? describe.skip : describe;

integration("meeting collaboration", () => {
  let database: Database;
  let app: ReturnType<typeof buildApi>["app"];

  beforeAll(async () => {
    database = new Database(databaseUrl!);
    await migrate(database);
    app = buildApi({
      databaseUrl: databaseUrl!,
      database,
      fileStoreRoot: await mkdtemp(
        join(tmpdir(), "pluginmax-meeting-collaboration-"),
      ),
      logger: false,
      localActorId: "local-admin",
      expectedMigrationVersion: 31,
    }).app;
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  async function request(
    method: "GET" | "POST" | "PUT" | "PATCH",
    url: string,
    payload?: unknown,
    actor = "local-admin",
  ) {
    return app.inject({
      method,
      url,
      headers: { "x-pluginmax-actor": actor },
      ...(payload === undefined
        ? {}
        : { payload: payload as Record<string, unknown> }),
    });
  }

  async function createProject(): Promise<{ id: string; name: string }> {
    const stamp = randomUUID().slice(0, 8);
    const response = await request("POST", "/api/v1/projects", {
      name: `Meeting collaboration ${stamp}`,
      description: "Batch 18 integration fixture",
    });
    expect(response.statusCode).toBe(201);
    return response.json() as { id: string; name: string };
  }

  async function createAgent(): Promise<{ id: string; name: string }> {
    const response = await request("POST", "/api/v1/agents", {
      name: `Collaboration Agent ${randomUUID().slice(0, 8)}`,
      description: "AI delegate fixture",
      runtimeKind: "fake",
    });
    expect(response.statusCode).toBe(201);
    return response.json() as { id: string; name: string };
  }

  async function createRole(
    projectId: string,
    permissions: string[] = ["read", "write"],
  ): Promise<{ id: string }> {
    const response = await request(
      "POST",
      `/api/v1/projects/${projectId}/roles`,
      {
        name: `Collaboration role ${randomUUID().slice(0, 8)}`,
        permissions,
      },
    );
    expect(response.statusCode).toBe(201);
    return response.json() as { id: string };
  }

  async function addHuman(
    projectId: string,
    actorId: string,
    roleIds: string[] = [],
  ): Promise<void> {
    await request("GET", "/api/v1/projects", undefined, actorId);
    const response = await request(
      "POST",
      `/api/v1/projects/${projectId}/members`,
      {
        kind: "human",
        actorId,
        name: actorId,
        responsibility: "Meeting collaboration fixture",
        roleIds,
      },
    );
    expect(response.statusCode).toBe(201);
  }

  async function addAgent(
    projectId: string,
    agentId: string,
    roleIds: string[] = [],
  ): Promise<void> {
    const response = await request(
      "POST",
      `/api/v1/projects/${projectId}/members`,
      {
        kind: "agent",
        agentId,
        responsibility: "AI delegate execution",
        roleIds,
      },
    );
    expect(response.statusCode).toBe(201);
  }

  async function createMeeting(
    projectId: string,
    agentIds: string[] = [],
  ): Promise<{ id: string; projectId: string }> {
    const response = await request("POST", "/api/v1/meetings", {
      projectId,
      title: `Meeting ${randomUUID().slice(0, 8)}`,
      agenda: "Confirm collaboration boundaries",
      agentIds,
    });
    expect(response.statusCode).toBe(201);
    return response.json() as { id: string; projectId: string };
  }

  it("hands off the facilitator and enforces archive/restore read-only boundaries", async () => {
    const project = await createProject();
    await addHuman(project.id, "facilitator-next");
    const meeting = await createMeeting(project.id);
    const collaboration = await request(
      "GET",
      `/api/v1/meetings/${meeting.id}/collaboration`,
    );
    expect(collaboration.statusCode).toBe(200);
    expect(collaboration.json()).toMatchObject({
      facilitator: { principalId: "local-admin" },
      lifecycleStatus: "active",
      revision: 1,
    });

    const handoff = await request(
      "POST",
      `/api/v1/meetings/${meeting.id}/facilitator/handoff`,
      {
        expectedRevision: 1,
        facilitatorPrincipalId: "facilitator-next",
        reason: "Shift facilitation to the next owner",
      },
    );
    expect(handoff.statusCode).toBe(200);
    expect(handoff.json()).toMatchObject({
      facilitator: { principalId: "facilitator-next" },
      revision: 2,
    });
    const staleHandoff = await request(
      "POST",
      `/api/v1/meetings/${meeting.id}/facilitator/handoff`,
      {
        expectedRevision: 1,
        facilitatorPrincipalId: "local-admin",
        reason: "Stale request",
      },
    );
    expect(staleHandoff.statusCode).toBe(409);

    const archived = await request(
      "POST",
      `/api/v1/meetings/${meeting.id}/archive`,
      {
        expectedRevision: 2,
        reason: "Close collaboration without deleting history",
      },
    );
    expect(archived.statusCode).toBe(200);
    expect(archived.json()).toMatchObject({
      lifecycleStatus: "archived",
      revision: 3,
    });
    const blockedMessage = await request(
      "POST",
      `/api/v1/meetings/${meeting.id}/messages`,
      { content: "Archived meetings must reject writes" },
    );
    expect(blockedMessage.statusCode).toBe(409);
    expect(blockedMessage.json()).toMatchObject({ code: "meeting_archived" });

    const restored = await request(
      "POST",
      `/api/v1/meetings/${meeting.id}/restore`,
      { expectedRevision: 3 },
    );
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toMatchObject({
      lifecycleStatus: "active",
      revision: 4,
    });
    const history = await request(
      "GET",
      `/api/v1/meetings/${meeting.id}/facilitator/history`,
    );
    expect(history.json().items).toHaveLength(2);
  });

  it("isolates private briefings, enforces delegates and keeps delivery retries closed", async () => {
    const project = await createProject();
    const agent = await createAgent();
    const readerRole = await createRole(project.id, ["read"]);
    await addHuman(project.id, "meeting-reader", [readerRole.id]);
    await addAgent(project.id, agent.id);
    const meeting = await createMeeting(project.id, [agent.id]);

    const delegation = await request(
      "POST",
      `/api/v1/meetings/${meeting.id}/delegates`,
      {
        representativeKind: "agent",
        agentId: agent.id,
        allowedActions: ["speak", "read_private"],
        reason: "Represent the facilitator for meeting discussion",
      },
    );
    expect(delegation.statusCode).toBe(201);
    const delegate = delegation.json() as {
      id: string;
      representativePrincipalId: string;
    };
    expect(delegate.representativePrincipalId).toContain("principal-ai-agent");

    const briefing = await request(
      "POST",
      `/api/v1/meetings/${meeting.id}/private-briefings`,
      {
        audiencePrincipalId: delegate.representativePrincipalId,
        content: "Only the designated AI delegate may see this constraint.",
      },
    );
    expect(briefing.statusCode).toBe(201);
    expect(
      (
        await request("GET", `/api/v1/meetings/${meeting.id}/private-briefings`)
      ).json().items,
    ).toHaveLength(1);
    expect(
      (
        await request(
          "GET",
          `/api/v1/meetings/${meeting.id}/private-briefings`,
          undefined,
          "meeting-reader",
        )
      ).json().items,
    ).toHaveLength(0);
    const repositories = new PlatformRepositories(database);
    expect(
      await repositories.meetingCollaboration.listBriefingsForContext({
        meetingId: meeting.id,
        principalId: "local-admin",
        agentId: agent.id,
        agentPrincipalId: delegate.representativePrincipalId,
      }),
    ).toHaveLength(1);
    expect(
      await repositories.meetingCollaboration.listBriefingsForContext({
        meetingId: meeting.id,
        principalId: "local-admin",
        agentId: randomUUID(),
        agentPrincipalId: delegate.representativePrincipalId,
      }),
    ).toHaveLength(0);
    const concurrentBriefings = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        request("POST", `/api/v1/meetings/${meeting.id}/private-briefings`, {
          content: `Concurrent private briefing ${index}`,
        }),
      ),
    );
    expect(concurrentBriefings.map((response) => response.statusCode)).toEqual([
      201, 201, 201, 201, 201, 201,
    ]);

    const firstMessageResponses = await Promise.all(
      Array.from({ length: 4 }, () =>
        request(
          "POST",
          `/api/v1/meetings/${meeting.id}/delegates/${delegate.id}/messages`,
          {
            content: "The delegate is speaking within the authorized boundary.",
            clientMessageId: "delegate-message-1",
          },
        ),
      ),
    );
    expect(
      firstMessageResponses.map((response) => response.statusCode),
    ).toEqual([201, 201, 201, 201]);
    const message = firstMessageResponses[0]!.json() as {
      id: string;
      delegateId: string;
    };
    expect(
      new Set(
        firstMessageResponses.map(
          (response) => (response.json() as { id: string }).id,
        ),
      ).size,
    ).toBe(1);
    expect(message.delegateId).toBe(delegate.id);
    const replay = await request(
      "POST",
      `/api/v1/meetings/${meeting.id}/delegates/${delegate.id}/messages`,
      {
        content: "The delegate is speaking within the authorized boundary.",
        clientMessageId: "delegate-message-1",
      },
    );
    expect(replay.statusCode).toBe(201);
    expect(replay.json().id).toBe(message.id);
    const conflict = await request(
      "POST",
      `/api/v1/meetings/${meeting.id}/delegates/${delegate.id}/messages`,
      {
        content: "Different content for the same client id",
        clientMessageId: "delegate-message-1",
      },
    );
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().code).toBe("meeting_message_idempotency_conflict");

    const deliveries = await request(
      "GET",
      `/api/v1/meetings/${meeting.id}/messages/${message.id}/deliveries`,
    );
    expect(deliveries.statusCode).toBe(200);
    expect(deliveries.json().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recipientPrincipalId: delegate.representativePrincipalId,
          status: "delivered",
        }),
      ]),
    );
    const delivery = (
      deliveries.json().items as {
        readonly id: string;
        readonly recipientPrincipalId: string;
      }[]
    ).find(
      (candidate) =>
        candidate.recipientPrincipalId === delegate.representativePrincipalId,
    )!;
    const duplicateRetry = await request(
      "POST",
      `/api/v1/meetings/${meeting.id}/messages/${message.id}/deliveries/${delivery.id}/retry`,
    );
    expect(duplicateRetry.statusCode).toBe(409);
    expect(duplicateRetry.json().code).toBe("meeting_delivery_not_retryable");
    await database.query(
      `UPDATE meeting_message_deliveries
       SET status = 'failed', delivered_at = NULL, read_at = NULL,
           last_error = 'fixture delivery failure', updated_at = NOW()
       WHERE id = $1`,
      [delivery.id],
    );
    const retried = await request(
      "POST",
      `/api/v1/meetings/${meeting.id}/messages/${message.id}/deliveries/${delivery.id}/retry`,
    );
    expect(retried.statusCode).toBe(200);
    expect(retried.json()).toMatchObject({
      status: "delivered",
      attempts: 2,
      lastError: null,
    });
    const markedRead = await request(
      "POST",
      `/api/v1/meetings/${meeting.id}/messages/${message.id}/deliveries/${delivery.id}/read`,
    );
    expect(markedRead.statusCode).toBe(200);
    expect(markedRead.json()).toMatchObject({ status: "read" });
    const readPosition = await request(
      "PUT",
      `/api/v1/meetings/${meeting.id}/read-position`,
      { messageId: message.id },
    );
    expect(readPosition.statusCode).toBe(200);
    expect(readPosition.json()).toMatchObject({
      principalId: "local-admin",
      lastReadMessageId: message.id,
    });
    expect(
      (
        await request("GET", `/api/v1/meetings/${meeting.id}/read-position`)
      ).json(),
    ).toMatchObject({ lastReadMessageId: message.id });

    const revoked = await request(
      "POST",
      `/api/v1/meetings/${meeting.id}/delegates/${delegate.id}/revoke`,
      { reason: "Delegate mandate completed" },
    );
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toMatchObject({ status: "revoked" });
    const revokedSpeech = await request(
      "POST",
      `/api/v1/meetings/${meeting.id}/delegates/${delegate.id}/messages`,
      {
        content: "This must be rejected after revoke",
        clientMessageId: "delegate-message-revoked",
      },
    );
    expect(revokedSpeech.statusCode).toBe(409);
    expect(revokedSpeech.json().code).toBe("meeting_delegate_inactive");
  });

  it("generates and confirms versioned minutes without leaking private briefings", async () => {
    const project = await createProject();
    const meeting = await createMeeting(project.id);
    const publicMessage = await request(
      "POST",
      `/api/v1/meetings/${meeting.id}/messages`,
      {
        content: "Decision: publish the verified collaboration summary.",
        clientMessageId: "minutes-source-1",
      },
    );
    expect(publicMessage.statusCode).toBe(201);
    const privateBriefing = await request(
      "POST",
      `/api/v1/meetings/${meeting.id}/private-briefings`,
      {
        content: "Private reservation must never enter generated minutes.",
      },
    );
    expect(privateBriefing.statusCode).toBe(201);

    const generated = await request(
      "POST",
      `/api/v1/meetings/${meeting.id}/minutes/generate`,
      { expectedRevision: 0 },
    );
    expect(generated.statusCode).toBe(200);
    expect(generated.json()).toMatchObject({
      revision: 1,
      decisions: ["publish the verified collaboration summary."],
      sourceMessageIds: [publicMessage.json().id],
    });
    expect(generated.json().content).not.toContain("Private reservation");

    const confirmed = await request(
      "POST",
      `/api/v1/meetings/${meeting.id}/minutes/confirm`,
      {
        expectedRevision: 1,
        note: "Facilitator confirmed the generated minutes",
      },
    );
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toMatchObject({
      version: { version: 1 },
      confirmation: {
        confirmedBy: "local-admin",
        note: "Facilitator confirmed the generated minutes",
      },
    });
    const staleConfirm = await request(
      "POST",
      `/api/v1/meetings/${meeting.id}/minutes/confirm`,
      { expectedRevision: 1, note: "Stale confirmation" },
    );
    expect(staleConfirm.statusCode).toBe(409);
    await expect(
      database.query(
        `UPDATE meeting_minutes_confirmations
         SET note = 'tampered'
         WHERE version_id = $1`,
        [confirmed.json().version.id],
      ),
    ).rejects.toThrow(/immutable/);
  });

  it("creates idempotent meeting tasks and stores files through the controlled FileStore", async () => {
    const project = await createProject();
    const agent = await createAgent();
    const role = await createRole(project.id);
    await addAgent(project.id, agent.id, [role.id]);
    const meeting = await createMeeting(project.id, [agent.id]);

    const taskInput = {
      title: "Deliver meeting follow-up",
      description: "Use the meeting source as the task boundary",
      assigneeAgentId: agent.id,
      priority: "high",
      sourceType: "manual",
      sourceMessageIds: [],
      idempotencyKey: "meeting-task-1",
      dispatch: false,
    };
    const firstTasks = await Promise.all(
      Array.from({ length: 3 }, () =>
        request("POST", `/api/v1/meetings/${meeting.id}/tasks`, taskInput),
      ),
    );
    expect(firstTasks.map((response) => response.statusCode)).toEqual([
      201, 201, 201,
    ]);
    const taskIds = new Set(
      firstTasks.map(
        (response) => (response.json() as { taskId: string }).taskId,
      ),
    );
    expect(taskIds.size).toBe(1);
    expect(
      firstTasks.filter(
        (response) => (response.json() as { reused: boolean }).reused,
      ),
    ).toHaveLength(2);

    const uploaded = await request(
      "POST",
      `/api/v1/meetings/${meeting.id}/files`,
      {
        name: "agenda.txt",
        mimeType: "text/plain",
        contentBase64: Buffer.from("controlled meeting file").toString(
          "base64",
        ),
      },
    );
    expect(uploaded.statusCode).toBe(201);
    const file = uploaded.json() as { id: string; sha256: string };
    expect(file.sha256).toMatch(/^[a-f0-9]{64}$/);
    const download = await request(
      "GET",
      `/api/v1/meetings/${meeting.id}/files/${file.id}/download`,
    );
    expect(download.statusCode).toBe(200);
    expect(download.body).toBe("controlled meeting file");
    const archived = await request(
      "POST",
      `/api/v1/meetings/${meeting.id}/files/${file.id}/archive`,
      { archived: false },
    );
    expect(archived.statusCode).toBe(200);
    expect(archived.json()).toMatchObject({ status: "archived" });
  });
});
