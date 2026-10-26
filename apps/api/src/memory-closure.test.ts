import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { InjectOptions } from "fastify";
import { Database, PlatformRepositories, migrate } from "@pluginmax/database";
import { buildApi } from "./app.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl === undefined ? describe.skip : describe;

interface Project {
  id: string;
  name: string;
}

interface Agent {
  id: string;
  name: string;
}

interface Meeting {
  id: string;
  projectId: string;
  title: string;
}

interface PublishedMeeting {
  project: Project;
  agent: Agent;
  meeting: Meeting;
  versionId: string;
  sourceMessageId: string;
}

integration("context and memory closure", () => {
  let database: Database;
  let repositories: PlatformRepositories;
  let app: ReturnType<typeof buildApi>["app"];

  beforeAll(async () => {
    database = new Database(databaseUrl!);
    await migrate(database);
    repositories = new PlatformRepositories(database);
    const fileStoreRoot = await mkdtemp(
      join(tmpdir(), "pluginmax-memory-closure-test-"),
    );
    const built = buildApi({
      databaseUrl: databaseUrl!,
      database,
      fileStoreRoot,
      logger: false,
      localActorId: "local-admin",
      expectedMigrationVersion: 16,
    });
    app = built.app;
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  async function request<T>(
    method: "GET" | "POST" | "PUT" | "PATCH",
    url: string,
    payload?: unknown,
    actorId?: string,
  ): Promise<{ statusCode: number; body: T }> {
    const options: InjectOptions = {
      method,
      url,
      ...(actorId === undefined
        ? {}
        : { headers: { "x-pluginmax-actor": actorId } }),
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

  async function createProject(name = "Memory closure"): Promise<Project> {
    const result = await request<Project>("POST", "/api/v1/projects", {
      name: `${name} ${randomUUID().slice(0, 8)}`,
      description: "Batch 10B integration fixture",
    });
    expect(result.statusCode).toBe(201);
    return result.body;
  }

  async function createAgent(name = "Memory agent"): Promise<Agent> {
    const result = await request<Agent>("POST", "/api/v1/agents", {
      name: `${name} ${randomUUID().slice(0, 8)}`,
      runtimeKind: "fake",
    });
    expect(result.statusCode).toBe(201);
    return result.body;
  }

  async function addAgentMember(
    projectId: string,
    agentId: string,
    roleIds: readonly string[] = [],
  ): Promise<string> {
    const result = await request<{ id: string }>(
      "POST",
      `/api/v1/projects/${projectId}/members`,
      {
        kind: "agent",
        agentId,
        responsibility: "Memory closure tests",
        roleIds,
      },
    );
    expect(result.statusCode).toBe(201);
    return result.body.id;
  }

  async function publishMeeting(): Promise<PublishedMeeting> {
    const project = await createProject("Meeting memory");
    const agent = await createAgent("Meeting memory agent");
    await addAgentMember(project.id, agent.id);
    const meetingResult = await request<Meeting>("POST", "/api/v1/meetings", {
      projectId: project.id,
      title: `Memory meeting ${randomUUID().slice(0, 8)}`,
      agenda: "Publish a traceable decision",
      agentIds: [agent.id],
    });
    expect(meetingResult.statusCode).toBe(201);
    const message = await request<{ id: string }>(
      "POST",
      `/api/v1/meetings/${meetingResult.body.id}/messages`,
      { content: "Decision: preserve this traceable decision." },
    );
    expect(message.statusCode).toBe(201);
    const draft = await request<{ revision: number }>(
      "PUT",
      `/api/v1/meetings/${meetingResult.body.id}/minutes/draft`,
      {
        content: "Decision: preserve this traceable decision.",
        decisions: [
          "Preserve this traceable decision",
          "Review before publishing current truth",
        ],
        sourceMessageIds: [message.body.id],
        expectedRevision: 0,
      },
    );
    expect(draft.statusCode).toBe(200);
    const published = await request<{
      version: { id: string };
      minutes: { draft: { revision: number } };
    }>("POST", `/api/v1/meetings/${meetingResult.body.id}/minutes/publish`, {
      expectedRevision: draft.body.revision,
    });
    expect(published.statusCode).toBe(200);
    return {
      project,
      agent,
      meeting: meetingResult.body,
      versionId: published.body.version.id,
      sourceMessageId: message.body.id,
    };
  }

  async function reviewQueue(projectId: string): Promise<{
    items: Array<{
      claim: {
        id: string;
        version: number;
        content: string;
        sourceRefs: Array<{ kind: string; id: string; available: boolean }>;
      };
    }>;
    canManage: boolean;
  }> {
    const result = await request<{
      items: Array<{
        claim: {
          id: string;
          version: number;
          content: string;
          sourceRefs: Array<{ kind: string; id: string; available: boolean }>;
        };
      }>;
      canManage: boolean;
    }>("GET", `/api/v1/projects/${projectId}/memory/reviews`);
    expect(result.statusCode).toBe(200);
    return result.body;
  }

  it("ingests published minutes idempotently and preserves the full source chain", async () => {
    const fixture = await publishMeeting();
    const initialQueue = await reviewQueue(fixture.project.id);
    expect(initialQueue.items).toHaveLength(2);
    const firstClaim = initialQueue.items[0]!.claim;
    expect(firstClaim.sourceRefs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "meeting",
          id: fixture.meeting.id,
        }),
        expect.objectContaining({
          kind: "minutes-version",
          id: fixture.versionId,
        }),
        expect.objectContaining({
          kind: "meeting-message",
          id: fixture.sourceMessageId,
        }),
      ]),
    );

    const retries = await Promise.all([
      request<{
        created: number;
        reused: number;
        claimIds: string[];
      }>("POST", `/api/v1/meetings/${fixture.meeting.id}/memory/ingest`),
      request<{
        created: number;
        reused: number;
        claimIds: string[];
      }>("POST", `/api/v1/meetings/${fixture.meeting.id}/memory/ingest`),
    ]);
    expect(retries.map((result) => result.statusCode)).toEqual([200, 200]);
    expect(retries.map((result) => result.body.created)).toEqual([0, 0]);
    expect(retries.map((result) => result.body.reused)).toEqual([2, 2]);
    const count = await database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM memory_claims
       WHERE project_id = $1 AND source_id = $2`,
      [fixture.project.id, fixture.versionId],
    );
    expect(count.rows[0]?.count).toBe("2");

    const action = await request<{ id: string }>(
      "POST",
      `/api/v1/meetings/${fixture.meeting.id}/action-items`,
      {
        title: "Deliver the traceable meeting decision",
        description: "Carry the decision through task and run evidence.",
        ownerActorId: fixture.agent.id,
        priority: "high",
        sourceType: "minutes_version",
        sourceVersionId: fixture.versionId,
        sourceMessageIds: [fixture.sourceMessageId],
        dedupeKey: `trace-${randomUUID().slice(0, 8)}`,
      },
    );
    expect(action.statusCode).toBe(201);
    const converted = await request<{ task: { id: string } }>(
      "POST",
      `/api/v1/meetings/${fixture.meeting.id}/action-items/${action.body.id}/convert`,
      { assigneeAgentId: fixture.agent.id, dispatch: false },
    );
    expect(converted.statusCode).toBe(200);

    const trace = await request<{
      sources: Array<{ kind: string; id: string; available: boolean }>;
    }>(
      "GET",
      `/api/v1/projects/${fixture.project.id}/memory/claims/${firstClaim.id}`,
    );
    expect(trace.statusCode).toBe(200);
    expect(trace.body.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "action-item",
          id: action.body.id,
          available: true,
        }),
        expect.objectContaining({
          kind: "task",
          id: converted.body.task.id,
          available: true,
        }),
      ]),
    );
  });

  it("reviews claims with optimistic concurrency and immutable audit records", async () => {
    const fixture = await publishMeeting();
    const queue = await reviewQueue(fixture.project.id);
    const claim = queue.items[0]!.claim;
    const reviewBody = {
      decision: "accept",
      reason: "Decisions are backed by published minutes",
      items: [{ claimId: claim.id, expectedVersion: claim.version }],
    };
    const [first, second] = await Promise.all([
      request(
        "POST",
        `/api/v1/projects/${fixture.project.id}/memory/reviews`,
        reviewBody,
      ),
      request(
        "POST",
        `/api/v1/projects/${fixture.project.id}/memory/reviews`,
        reviewBody,
      ),
    ]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 409]);
    const conflict = first.statusCode === 409 ? first : second;
    expect(conflict.body).toMatchObject({ code: "memory_review_conflict" });

    const memory = await request<{
      items: Array<{
        id: string;
        claims: Array<{ id: string; status: string; version: number }>;
        currentTruth: { claimIds: string[]; content: string } | null;
      }>;
    }>("GET", `/api/v1/projects/${fixture.project.id}/memory`);
    expect(memory.statusCode).toBe(200);
    const topic = memory.body.items[0]!;
    expect(topic.claims.find((item) => item.id === claim.id)).toMatchObject({
      status: "confirmed",
      version: 2,
    });
    expect(topic.currentTruth?.claimIds).toContain(claim.id);
    expect(topic.currentTruth?.content).toContain(claim.content);
    const reviewRows = await database.query<{ id: string }>(
      `SELECT id FROM memory_claim_reviews
       WHERE project_id = $1 AND claim_id = $2`,
      [fixture.project.id, claim.id],
    );
    expect(reviewRows.rows).toHaveLength(1);
    await expect(
      database.query(
        "UPDATE memory_claim_reviews SET reason = 'tampered' WHERE id = $1",
        [reviewRows.rows[0]!.id],
      ),
    ).rejects.toThrow(/immutable/);

    const topicId = memory.body.items[0]!.id;
    const manual = await request<{ id: string; version: number }>(
      "POST",
      `/api/v1/projects/${fixture.project.id}/memory/topics/${topicId}/claims`,
      { content: "Manual claim requiring a rejection reason" },
    );
    expect(manual.statusCode).toBe(201);
    const missingReason = await request(
      "POST",
      `/api/v1/projects/${fixture.project.id}/memory/reviews`,
      {
        decision: "reject",
        reason: "",
        items: [
          { claimId: manual.body.id, expectedVersion: manual.body.version },
        ],
      },
    );
    expect(missingReason.statusCode).toBe(400);
    const rejected = await request(
      "POST",
      `/api/v1/projects/${fixture.project.id}/memory/reviews`,
      {
        decision: "reject",
        reason: "The claim has no supporting evidence",
        items: [
          { claimId: manual.body.id, expectedVersion: manual.body.version },
        ],
      },
    );
    expect(rejected.statusCode).toBe(200);
    const rejectedClaim = await request<{
      reviews: Array<{ reason: string }>;
    }>(
      "GET",
      `/api/v1/projects/${fixture.project.id}/memory/claims/${manual.body.id}`,
    );
    expect(rejectedClaim.body.reviews[0]?.reason).toBe(
      "The claim has no supporting evidence",
    );
  });

  it("rejects cross-project and archived memory access", async () => {
    const first = await publishMeeting();
    const second = await createProject("Other memory project");
    const queue = await reviewQueue(first.project.id);
    const claim = queue.items[0]!.claim;

    const outsider = await request(
      "GET",
      `/api/v1/projects/${first.project.id}/memory/reviews`,
      undefined,
      "outside-project",
    );
    expect(outsider.statusCode).toBe(403);
    const crossProject = await request(
      "POST",
      `/api/v1/projects/${second.id}/memory/reviews`,
      {
        decision: "accept",
        items: [{ claimId: claim.id, expectedVersion: claim.version }],
      },
    );
    expect(crossProject.statusCode).toBe(404);
    expect(crossProject.body).toMatchObject({ code: "memory_claim_not_found" });

    const archivedTopic = await request<{ id: string }>(
      "POST",
      `/api/v1/projects/${second.id}/memory/topics`,
      { title: "Archived topic" },
    );
    expect(archivedTopic.statusCode).toBe(201);
    const archivedClaim = await request<{ id: string; version: number }>(
      "POST",
      `/api/v1/projects/${second.id}/memory/topics/${archivedTopic.body.id}/claims`,
      { content: "Claim reviewed after project archival" },
    );
    expect(archivedClaim.statusCode).toBe(201);
    await request("PATCH", `/api/v1/projects/${second.id}`, {
      status: "archived",
    });
    const archivedQueue = await request(
      "POST",
      `/api/v1/projects/${second.id}/memory/reviews`,
      {
        decision: "accept",
        items: [
          {
            claimId: archivedClaim.body.id,
            expectedVersion: archivedClaim.body.version,
          },
        ],
      },
    );
    expect(archivedQueue.statusCode).toBe(409);
    expect(archivedQueue.body).toMatchObject({ code: "project_archived" });
  });

  it("confirms handoffs immutably and resolves unavailable sources", async () => {
    const project = await createProject("Handoff project");
    const otherProject = await createProject("Handoff other project");
    const task = await request<{ id: string; title: string }>(
      "POST",
      "/api/v1/tasks",
      {
        projectId: project.id,
        title: "Handoff source task",
        description: "A task used as a handoff source.",
        acceptance: [],
      },
    );
    expect(task.statusCode).toBe(201);
    const otherTask = await request<{ id: string }>("POST", "/api/v1/tasks", {
      projectId: otherProject.id,
      title: "Cross project source task",
      description: "Must not be accepted by another project.",
      acceptance: [],
    });
    expect(otherTask.statusCode).toBe(201);

    const crossProject = await request(
      "POST",
      `/api/v1/projects/${project.id}/handoffs`,
      {
        title: "Invalid cross project handoff",
        summary: "This source belongs to another project.",
        sourceRefs: [
          {
            kind: "task",
            id: otherTask.body.id,
            projectId: otherProject.id,
            label: "Other task",
          },
        ],
      },
    );
    expect(crossProject.statusCode).toBe(409);
    expect(crossProject.body).toMatchObject({
      code: "source_project_mismatch",
    });
    const unavailable = await request(
      "POST",
      `/api/v1/projects/${project.id}/handoffs`,
      {
        title: "Unavailable source handoff",
        summary: "The source does not exist.",
        sourceRefs: [
          {
            kind: "task",
            id: randomUUID(),
            projectId: project.id,
            label: "Missing task",
          },
        ],
      },
    );
    expect(unavailable.statusCode).toBe(409);
    expect(unavailable.body).toMatchObject({ code: "source_unavailable" });

    const created = await request<{
      id: string;
      status: string;
      version: number;
    }>("POST", `/api/v1/projects/${project.id}/handoffs`, {
      title: "Release execution handoff",
      summary: "Continue from the verified task state.",
      sourceRefs: [
        {
          kind: "task",
          id: task.body.id,
          projectId: project.id,
          label: task.body.title,
        },
      ],
    });
    expect(created.statusCode).toBe(201);
    expect(created.body).toMatchObject({ status: "draft", version: 1 });
    const confirmed = await request<{
      status: string;
      confirmations: Array<{ id: string; version: number }>;
    }>(
      "POST",
      `/api/v1/projects/${project.id}/handoffs/${created.body.id}/confirm`,
      { expectedVersion: created.body.version },
    );
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.body).toMatchObject({
      status: "confirmed",
      confirmations: [{ version: 1 }],
    });
    const updateConfirmed = await request(
      "PATCH",
      `/api/v1/projects/${project.id}/handoffs/${created.body.id}`,
      {
        title: "This must not change",
        expectedVersion: created.body.version,
      },
    );
    expect(updateConfirmed.statusCode).toBe(409);
    expect(updateConfirmed.body).toMatchObject({ code: "handoff_confirmed" });
    await expect(
      database.query(
        "UPDATE handoff_confirmations SET snapshot = '{}'::jsonb WHERE id = $1",
        [confirmed.body.confirmations[0]!.id],
      ),
    ).rejects.toThrow(/immutable/);

    await database.query("DELETE FROM tasks WHERE id = $1", [task.body.id]);
    const handoff = await request<{
      sourceRefs: Array<{ kind: string; available: boolean }>;
    }>("GET", `/api/v1/projects/${project.id}/handoffs/${created.body.id}`);
    expect(handoff.statusCode).toBe(200);
    expect(handoff.body.sourceRefs).toEqual([
      expect.objectContaining({ kind: "task", available: false }),
    ]);
  });

  it("enforces project, agent and visibility filters for episodes and context", async () => {
    const project = await createProject("Episode project");
    const otherProject = await createProject("Episode other project");
    const agent = await createAgent("Episode agent");
    const otherAgent = await createAgent("Episode other agent");
    const readerRole = await request<{ id: string }>(
      "POST",
      `/api/v1/projects/${project.id}/roles`,
      {
        code: "AGENT_READER",
        name: "Agent Reader",
        category: "execution",
        description: "Explicit read grant for episode access",
        permissions: ["read"],
      },
    );
    expect(readerRole.statusCode).toBe(201);
    await addAgentMember(project.id, agent.id, [readerRole.body.id]);
    await addAgentMember(project.id, otherAgent.id);
    await addAgentMember(otherProject.id, agent.id);

    const privateEpisode = await request<{ id: string }>(
      "POST",
      `/api/v1/projects/${project.id}/agent-episodes`,
      {
        agentId: agent.id,
        visibility: "private",
        kind: "reflection",
        summary: "Private planning note",
        content: "Only this agent may read this.",
        sourceRefs: [],
      },
    );
    expect(privateEpisode.statusCode).toBe(201);
    const projectEpisode = await request<{ id: string }>(
      "POST",
      `/api/v1/projects/${project.id}/agent-episodes`,
      {
        agentId: agent.id,
        visibility: "project",
        kind: "decision",
        summary: "Project-visible decision",
        content: "The project may reuse this context.",
        sourceRefs: [],
      },
    );
    expect(projectEpisode.statusCode).toBe(201);
    await request(
      "POST",
      `/api/v1/projects/${otherProject.id}/agent-episodes`,
      {
        agentId: agent.id,
        visibility: "project",
        kind: "observation",
        summary: "Other project episode",
        content: "Must not enter this project's context.",
        sourceRefs: [],
      },
    );

    const ownerView = await request<{
      items: Array<{ id: string; visibility: string }>;
    }>(
      "GET",
      `/api/v1/projects/${project.id}/agent-episodes?agentId=${agent.id}`,
    );
    expect(ownerView.statusCode, JSON.stringify(ownerView.body)).toBe(200);
    expect(ownerView.body.items.map((item) => item.id)).toEqual([
      projectEpisode.body.id,
    ]);
    const agentView = await request<{
      items: Array<{ id: string; visibility: string }>;
    }>(
      "GET",
      `/api/v1/projects/${project.id}/agent-episodes?agentId=${agent.id}`,
      undefined,
      agent.id,
    );
    expect(agentView.statusCode).toBe(403);
    const otherAgentView = await request<{ items: unknown[] }>(
      "GET",
      `/api/v1/projects/${project.id}/agent-episodes?agentId=${agent.id}`,
      undefined,
      otherAgent.id,
    );
    expect(otherAgentView.statusCode).toBe(403);

    const contextEpisodes =
      await repositories.memoryClosure.listEpisodesForContext(
        project.id,
        agent.id,
      );
    expect(contextEpisodes.map((episode) => episode.id).sort()).toEqual(
      [privateEpisode.body.id, projectEpisode.body.id].sort(),
    );
    expect(contextEpisodes).not.toContainEqual(
      expect.objectContaining({ summary: "Other project episode" }),
    );
    expect(
      await repositories.memoryClosure.listEpisodesForContext(
        project.id,
        otherAgent.id,
      ),
    ).toEqual([]);
  });
});
