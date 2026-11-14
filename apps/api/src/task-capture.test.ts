import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  TaskCaptureCandidate,
  TaskCaptureSession,
  TaskDraftBatch,
  TaskDraftCommitResult,
} from "@pluginmax/contracts";
import {
  Database,
  LATEST_MIGRATION_VERSION,
  migrate,
  PlatformRepositories,
} from "@pluginmax/database";
import { buildApi } from "./app.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl === undefined ? describe.skip : describe;

integration("task capture PostgreSQL integration", () => {
  let database: Database;
  let repositories: PlatformRepositories;
  let app: ReturnType<typeof buildApi>["app"];

  beforeAll(async () => {
    database = new Database(databaseUrl!);
    await migrate(database);
    repositories = new PlatformRepositories(database);
    const built = buildApi({
      databaseUrl: databaseUrl!,
      database,
      fileStoreRoot: await mkdtemp(join(tmpdir(), "pluginmax-m5-capture-")),
      logger: process.env.M5_TEST_LOGGER === "1",
      localActorId: "local-admin",
      expectedMigrationVersion: LATEST_MIGRATION_VERSION,
    });
    app = built.app;
    await app.ready();
    await database.query(
      `UPDATE feature_flag_settings
       SET mode = 'on', revision = revision + 1, updated_at = NOW()
       WHERE flag_key = 'task.capture'
         AND scope_type = 'platform'
         AND scope_id = 'platform'`,
    );
  });

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  async function request<T>(
    method: "GET" | "POST" | "PATCH",
    url: string,
    payload?: unknown,
    actorId = "local-admin",
    idempotencyKey?: string,
  ): Promise<{ statusCode: number; body: T }> {
    const headers: Record<string, string> = {
      "x-pluginmax-actor": actorId,
    };
    if (idempotencyKey !== undefined) {
      headers["idempotency-key"] = idempotencyKey;
    }
    const options: InjectOptions = { method, url, headers };
    if (payload !== undefined) {
      options.payload = payload as Record<string, unknown>;
    }
    const response = await app.inject(options);
    return {
      statusCode: response.statusCode,
      body: response.json() as T,
    };
  }

  async function fixture(): Promise<{
    projectId: string;
    agentId: string;
  }> {
    const project = await request<{ id: string }>("POST", "/api/v1/projects", {
      name: `M5 Capture ${randomUUID().slice(0, 8)}`,
      description: "M5 Task Capture",
    });
    expect(project.statusCode).toBe(201);
    const agent = await request<{ id: string }>("POST", "/api/v1/agents", {
      name: `M5 Capture Agent ${randomUUID().slice(0, 8)}`,
      runtimeKind: "fake",
    });
    expect(agent.statusCode).toBe(201);
    const member = await request(
      "POST",
      `/api/v1/projects/${project.body.id}/members`,
      {
        kind: "agent",
        agentId: agent.body.id,
        responsibility: "Task Capture conversion",
        roleIds: [],
      },
    );
    expect(member.statusCode).toBe(201);
    return { projectId: project.body.id, agentId: agent.body.id };
  }

  async function createSession(
    projectId: string,
  ): Promise<TaskCaptureSession> {
    const response = await request<TaskCaptureSession>(
      "POST",
      "/api/v1/task-capture/sessions",
      {
        projectId,
        sourceType: "direct-chat",
        sourceId: `chat-${randomUUID()}`,
        sourceVersion: "1",
      },
    );
    expect(response.statusCode).toBe(201);
    return response.body;
  }

  async function createCandidate(
    sessionId: string,
    excerpt: string,
  ): Promise<TaskCaptureCandidate> {
    const response = await request<TaskCaptureCandidate>(
      "POST",
      `/api/v1/task-capture/sessions/${sessionId}/candidates`,
      {
        sourceId: `message-${randomUUID()}`,
        sourceVersion: "1",
        excerpt,
        sourceRefs: [
          {
            type: "direct-chat-message",
            id: `message-${randomUUID()}`,
            version: "1",
          },
        ],
      },
    );
    expect(response.statusCode).toBe(201);
    return response.body;
  }

  it("keeps drafts outside Task until commit and reuses stable creation keys", async () => {
    const fixtureData = await fixture();
    const session = await createSession(fixtureData.projectId);
    const candidate = await createCandidate(
      session.id,
      "Create a concise release checklist from this conversation.",
    );
    const batch = await request<TaskDraftBatch>(
      "POST",
      `/api/v1/task-capture/sessions/${session.id}/batches`,
      {
        drafts: [
          {
            candidateId: candidate.id,
            title: "Release checklist",
            description: "Capture the checklist without creating a Task yet.",
            acceptance: ["Checklist is complete"],
            priority: "high",
            agentId: fixtureData.agentId,
          },
        ],
      },
    );
    expect(batch.statusCode, JSON.stringify(batch.body)).toBe(201);
    const before = await database.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM tasks WHERE project_id = $1",
      [fixtureData.projectId],
    );
    expect(before.rows[0]?.count).toBe("0");

    const committed = await request<TaskDraftCommitResult>(
      "POST",
      `/api/v1/task-capture/batches/${batch.body.id}/commit`,
      { expectedRevision: batch.body.revision },
      "local-admin",
      `capture-commit-${batch.body.id}`,
    );
    expect(committed.statusCode).toBe(200);
    expect(committed.body).toMatchObject({
      status: "committed",
      items: [
        {
          draftId: batch.body.drafts[0]?.id,
          status: "created",
        },
      ],
    });
    const taskId = committed.body.items[0]?.taskId;
    expect(taskId).toBeTruthy();

    const replay = await request<TaskDraftCommitResult>(
      "POST",
      `/api/v1/task-capture/batches/${batch.body.id}/commit`,
      { expectedRevision: batch.body.revision },
    );
    expect(replay.statusCode).toBe(200);
    expect(replay.body.items[0]?.taskId).toBe(taskId);

    const after = await database.query<{
      count: string;
      creation_key: string;
    }>(
      `SELECT COUNT(*)::text AS count, MIN(creation_key) AS creation_key
       FROM tasks
       WHERE project_id = $1`,
      [fixtureData.projectId],
    );
    expect(after.rows[0]?.count).toBe("1");
    expect(after.rows[0]?.creation_key).toBe(
      `task-capture-draft:${batch.body.drafts[0]?.id}:v1`,
    );
    const origin = await database.query<{ source_kind: string }>(
      "SELECT source_kind FROM task_origins WHERE task_id = $1",
      [taskId],
    );
    expect(origin.rows[0]?.source_kind).toBe("capture");
    const audit = await database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM identity_audit_events
       WHERE action = 'task.capture.batch.committed'
         AND metadata ->> 'batchId' = $1`,
      [batch.body.id],
    );
    expect(audit.rows[0]?.count).toBe("1");
  });

  it("serializes concurrent commits and preserves per-item partial failures", async () => {
    const fixtureData = await fixture();
    const session = await createSession(fixtureData.projectId);
    const first = await createCandidate(session.id, "First captured task");
    const second = await createCandidate(session.id, "Second captured task");
    const outsideAgent = await request<{ id: string }>(
      "POST",
      "/api/v1/agents",
      {
        name: `Outside Capture Agent ${randomUUID().slice(0, 8)}`,
        runtimeKind: "fake",
      },
    );
    expect(outsideAgent.statusCode).toBe(201);
    const batch = await request<TaskDraftBatch>(
      "POST",
      `/api/v1/task-capture/sessions/${session.id}/batches`,
      {
        drafts: [
          {
            candidateId: first.id,
            title: "First captured task",
            description: "This item should be committed.",
            acceptance: ["First accepted"],
            agentId: fixtureData.agentId,
          },
          {
            candidateId: second.id,
            title: "Second captured task",
            description: "This item should fail without hiding the first.",
            acceptance: ["Second accepted"],
            agentId: outsideAgent.body.id,
          },
        ],
      },
    );
    expect(batch.statusCode, JSON.stringify(batch.body)).toBe(201);
    const concurrent = await Promise.all([
      request<TaskDraftCommitResult>(
        "POST",
        `/api/v1/task-capture/batches/${batch.body.id}/commit`,
        { expectedRevision: batch.body.revision },
      ),
      request<TaskDraftCommitResult>(
        "POST",
        `/api/v1/task-capture/batches/${batch.body.id}/commit`,
        { expectedRevision: batch.body.revision },
      ),
    ]);
    expect(concurrent.map((result) => result.statusCode)).toEqual([200, 200]);
    expect(concurrent[0]?.body).toEqual(concurrent[1]?.body);
    expect(concurrent[0]?.body.status).toBe("partial");
    expect(
      concurrent[0]?.body.items.map((item) => item.status).sort(),
    ).toEqual(["created", "failed"]);
    const tasks = await database.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM tasks WHERE project_id = $1",
      [fixtureData.projectId],
    );
    expect(tasks.rows[0]?.count).toBe("1");
  });

  it("rejects invalidated sources and keeps the feature flag closed by default", async () => {
    const fixtureData = await fixture();
    const session = await createSession(fixtureData.projectId);
    const candidate = await createCandidate(session.id, "Invalidated source");
    const batch = await request<TaskDraftBatch>(
      "POST",
      `/api/v1/task-capture/sessions/${session.id}/batches`,
      {
        drafts: [
          {
            candidateId: candidate.id,
            title: "Invalid source task",
            description: "Must not become a Task.",
            acceptance: [],
            agentId: fixtureData.agentId,
          },
        ],
      },
    );
    const invalidated = await request<TaskCaptureCandidate>(
      "POST",
      `/api/v1/task-capture/candidates/${candidate.id}/invalidate`,
      {
        expectedRevision: candidate.revision + 1,
        reason: "Source message was deleted",
      },
    );
    expect(invalidated.statusCode, JSON.stringify(invalidated.body)).toBe(200);
    const committed = await request<TaskDraftCommitResult>(
      "POST",
      `/api/v1/task-capture/batches/${batch.body.id}/commit`,
      { expectedRevision: batch.body.revision },
    );
    expect(committed.statusCode).toBe(200);
    expect(committed.body.status).toBe("failed");
    expect(committed.body.items[0]?.errorCode).toBe(
      "task_capture_candidate_invalid",
    );
    const tasks = await database.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM tasks WHERE project_id = $1",
      [fixtureData.projectId],
    );
    expect(tasks.rows[0]?.count).toBe("0");

    await repositories.featureFlags.set({
      flagKey: "task.capture",
      scopeType: "project",
      scopeId: fixtureData.projectId,
      mode: "off",
      updatedBy: "local-admin",
    });
    const disabled = await request(
      "POST",
      "/api/v1/task-capture/sessions",
      {
        projectId: fixtureData.projectId,
        sourceType: "manual",
        sourceId: `manual-${randomUUID()}`,
        sourceVersion: "1",
      },
    );
    expect(disabled.statusCode).toBe(409);
    expect(disabled.body).toMatchObject({ code: "feature_disabled" });
  });
});
