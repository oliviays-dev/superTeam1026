import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Database, migrate } from "@pluginmax/database";
import { buildApi } from "./app.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl === undefined ? describe.skip : describe;

integration("meeting decisions and action items", () => {
  let database: Database;
  let app: ReturnType<typeof buildApi>["app"];

  beforeAll(async () => {
    database = new Database(databaseUrl!);
    await migrate(database);
    const fileStoreRoot = await mkdtemp(
      join(tmpdir(), "pluginmax-meeting-test-"),
    );
    const built = buildApi({
      databaseUrl: databaseUrl!,
      database,
      fileStoreRoot,
      logger: false,
      localActorId: "local-admin",
      expectedMigrationVersion: 27,
    });
    app = built.app;
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  async function createProject(): Promise<{ id: string; name: string }> {
    const stamp = randomUUID().slice(0, 8);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: {
        name: `Meeting decisions ${stamp}`,
        description: "Batch 10A integration fixture",
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json() as { id: string; name: string };
  }

  async function createAgent(): Promise<{ id: string; name: string }> {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agents",
      payload: {
        name: `Meeting agent ${randomUUID().slice(0, 8)}`,
        runtimeKind: "fake",
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json() as { id: string; name: string };
  }

  async function addAgentMember(
    projectId: string,
    agentId: string,
  ): Promise<void> {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/members`,
      payload: {
        kind: "agent",
        agentId,
        responsibility: "Action item execution",
        roleIds: [],
      },
    });
    expect(response.statusCode).toBe(201);
  }

  async function createMeeting(
    projectId: string,
    agentId?: string,
  ): Promise<{ id: string; projectId: string }> {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/meetings",
      payload: {
        projectId,
        title: `Decision meeting ${randomUUID().slice(0, 8)}`,
        agenda: "Confirm decisions and owners",
        agentIds: agentId === undefined ? [] : [agentId],
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json() as { id: string; projectId: string };
  }

  async function postMeetingMessage(
    meetingId: string,
    content: string,
  ): Promise<{ id: string }> {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/meetings/${meetingId}/messages`,
      payload: { content },
    });
    expect(response.statusCode).toBe(201);
    return response.json() as { id: string };
  }

  async function createActionItem(
    meetingId: string,
    input: {
      readonly title?: string;
      readonly dedupeKey?: string;
      readonly sourceMessageIds?: string[];
    } = {},
  ): Promise<{ id: string; taskId: string | null }> {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/meetings/${meetingId}/action-items`,
      payload: {
        title: input.title ?? `Action ${randomUUID().slice(0, 8)}`,
        description: "Deliver the meeting decision",
        ownerActorId: "local-admin",
        priority: "high",
        sourceType: "manual",
        sourceMessageIds: input.sourceMessageIds ?? [],
        ...(input.dedupeKey === undefined
          ? {}
          : { dedupeKey: input.dedupeKey }),
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json() as { id: string; taskId: string | null };
  }

  it("version-publishes minutes and rejects concurrent stale revisions", async () => {
    const project = await createProject();
    const meeting = await createMeeting(project.id);
    const source = await postMeetingMessage(
      meeting.id,
      "Decision: ship the approval workflow this week.",
    );
    const saved = await app.inject({
      method: "PUT",
      url: `/api/v1/meetings/${meeting.id}/minutes/draft`,
      payload: {
        content: "Decision: ship the approval workflow this week.",
        decisions: ["Ship the approval workflow this week"],
        sourceMessageIds: [source.id],
        expectedRevision: 0,
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({
      revision: 1,
      sourceMessageIds: [source.id],
    });

    const [first, second] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/api/v1/meetings/${meeting.id}/minutes/publish`,
        payload: { expectedRevision: 1 },
      }),
      app.inject({
        method: "POST",
        url: `/api/v1/meetings/${meeting.id}/minutes/publish`,
        payload: { expectedRevision: 1 },
      }),
    ]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 409]);
    const conflict = first.statusCode === 409 ? first : second;
    expect(conflict.json().code).toBe("meeting_minutes_revision_conflict");

    const minutes = await app.inject({
      method: "GET",
      url: `/api/v1/meetings/${meeting.id}/minutes`,
    });
    expect(minutes.statusCode).toBe(200);
    expect(minutes.json()).toMatchObject({
      draft: {
        revision: 2,
        content: "Decision: ship the approval workflow this week.",
      },
      versions: [
        {
          version: 1,
          sourceMessageIds: [source.id],
          decisions: ["Ship the approval workflow this week"],
        },
      ],
    });

    const revision = await app.inject({
      method: "PUT",
      url: `/api/v1/meetings/${meeting.id}/minutes/draft`,
      payload: {
        content: "Decision updated after risk review.",
        decisions: ["Ship after risk review"],
        sourceMessageIds: [source.id],
        expectedRevision: 2,
      },
    });
    expect(revision.statusCode).toBe(200);
    const publishedAgain = await app.inject({
      method: "POST",
      url: `/api/v1/meetings/${meeting.id}/minutes/publish`,
      payload: { expectedRevision: revision.json().revision },
    });
    expect(publishedAgain.statusCode).toBe(200);
    expect(publishedAgain.json()).toMatchObject({
      version: { version: 2, content: "Decision updated after risk review." },
    });
    const history = await app.inject({
      method: "GET",
      url: `/api/v1/meetings/${meeting.id}/minutes`,
    });
    expect(history.json().versions).toHaveLength(2);

    const versionId = publishedAgain.json().version.id as string;
    await expect(
      database.query(
        "UPDATE meeting_minutes_versions SET content = 'tampered' WHERE id = $1",
        [versionId],
      ),
    ).rejects.toThrow(/immutable/);
  });

  it("blocks unauthorized meetings and cross-project action-item access", async () => {
    const projectA = await createProject();
    const projectB = await createProject();
    const meetingA = await createMeeting(projectA.id);
    const meetingB = await createMeeting(projectB.id);
    const item = await createActionItem(meetingA.id);

    const forbiddenRead = await app.inject({
      method: "GET",
      url: `/api/v1/meetings/${meetingA.id}`,
      headers: { "x-pluginmax-actor": "project-outsider" },
    });
    expect(forbiddenRead.statusCode).toBe(403);
    expect(forbiddenRead.json().code).toBe("forbidden");

    const forbiddenPublish = await app.inject({
      method: "PUT",
      url: `/api/v1/meetings/${meetingA.id}/minutes/draft`,
      headers: { "x-pluginmax-actor": "project-outsider" },
      payload: {
        content: "Unauthorized revision",
        decisions: [],
        sourceMessageIds: [],
        expectedRevision: 0,
      },
    });
    expect(forbiddenPublish.statusCode).toBe(403);

    const crossProject = await app.inject({
      method: "PATCH",
      url: `/api/v1/meetings/${meetingB.id}/action-items/${item.id}`,
      payload: { status: "done" },
    });
    expect(crossProject.statusCode).toBe(404);
    expect(crossProject.json().code).toBe("action_item_not_found");
  });

  it("deduplicates action items and converts them exactly once", async () => {
    const project = await createProject();
    const agent = await createAgent();
    await addAgentMember(project.id, agent.id);
    const meeting = await createMeeting(project.id, agent.id);
    const dedupeKey = `decision-${randomUUID().slice(0, 8)}`;
    const item = await createActionItem(meeting.id, { dedupeKey });

    const duplicate = await app.inject({
      method: "POST",
      url: `/api/v1/meetings/${meeting.id}/action-items`,
      payload: {
        title: "Duplicate action",
        description: "",
        ownerActorId: "local-admin",
        priority: "medium",
        sourceType: "manual",
        sourceMessageIds: [],
        dedupeKey,
      },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({
      code: "action_item_duplicate",
      details: { existingActionItemId: item.id },
    });

    const [first, second] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/api/v1/meetings/${meeting.id}/action-items/${item.id}/convert`,
        payload: { assigneeAgentId: agent.id, dispatch: false },
      }),
      app.inject({
        method: "POST",
        url: `/api/v1/meetings/${meeting.id}/action-items/${item.id}/convert`,
        payload: { assigneeAgentId: agent.id, dispatch: false },
      }),
    ]);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const taskIds = new Set([
      first.json().task.id as string,
      second.json().task.id as string,
    ]);
    expect(taskIds.size).toBe(1);
    expect([first.json().reused, second.json().reused].sort()).toEqual([
      false,
      true,
    ]);
    expect(
      await database.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM meeting_action_items
         WHERE task_id = $1`,
        [[...taskIds][0]],
      ),
    ).toMatchObject({ rows: [{ count: "1" }] });

    const trace = await app.inject({
      method: "GET",
      url: `/api/v1/meetings/${meeting.id}/traceability`,
    });
    expect(trace.statusCode).toBe(200);
    expect(trace.json()).toMatchObject({
      actionItems: [
        {
          id: item.id,
          taskId: [...taskIds][0],
          status: "in_progress",
        },
      ],
    });
  });

  it("rejects archived projects and disabled AI action-item conversion", async () => {
    const archivedProject = await createProject();
    const archivedAgent = await createAgent();
    await addAgentMember(archivedProject.id, archivedAgent.id);
    const archivedMeeting = await createMeeting(
      archivedProject.id,
      archivedAgent.id,
    );
    const archivedItem = await createActionItem(archivedMeeting.id);
    await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${archivedProject.id}`,
      payload: { status: "archived" },
    });
    const archivedConversion = await app.inject({
      method: "POST",
      url: `/api/v1/meetings/${archivedMeeting.id}/action-items/${archivedItem.id}/convert`,
      payload: { assigneeAgentId: archivedAgent.id },
    });
    expect(archivedConversion.statusCode).toBe(409);
    expect(archivedConversion.json().code).toBe("project_archived");

    const disabledProject = await createProject();
    const disabledAgent = await createAgent();
    await addAgentMember(disabledProject.id, disabledAgent.id);
    const disabledMeeting = await createMeeting(
      disabledProject.id,
      disabledAgent.id,
    );
    const disabledItem = await createActionItem(disabledMeeting.id);
    await app.inject({
      method: "POST",
      url: `/api/v1/agents/${disabledAgent.id}/status`,
      payload: { status: "disabled" },
    });
    const disabledConversion = await app.inject({
      method: "POST",
      url: `/api/v1/meetings/${disabledMeeting.id}/action-items/${disabledItem.id}/convert`,
      payload: { assigneeAgentId: disabledAgent.id },
    });
    expect(disabledConversion.statusCode).toBe(409);
    expect(disabledConversion.json().code).toBe("agent_unavailable");
  });
});
