import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RunExecutor, SceneContextService } from "@pluginmax/application";
import type {
  ContextPolicy,
  SceneParticipantBinding,
  SceneSessionBinding,
  Task,
} from "@pluginmax/contracts";
import {
  Database,
  LATEST_MIGRATION_VERSION,
  migrate,
  PlatformRepositories,
  type ClaimedJob,
} from "@pluginmax/database";
import { buildApi } from "./app.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl === undefined ? describe.skip : describe;

integration("group scene and context PostgreSQL integration", () => {
  let database: Database;
  let repositories: PlatformRepositories;
  let app: ReturnType<typeof buildApi>["app"];
  let executor: RunExecutor;

  beforeAll(async () => {
    database = new Database(databaseUrl!);
    await migrate(database);
    repositories = new PlatformRepositories(database);
    const fileStoreRoot = await mkdtemp(
      join(tmpdir(), "pluginmax-m5-group-files-"),
    );
    const workspaceRoot = await mkdtemp(
      join(tmpdir(), "pluginmax-m5-group-workspaces-"),
    );
    const built = buildApi({
      databaseUrl: databaseUrl!,
      database,
      fileStoreRoot,
      logger: process.env.M5_TEST_LOGGER === "1",
      localActorId: "local-admin",
      expectedMigrationVersion: LATEST_MIGRATION_VERSION,
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
    });
    await database.query(
      `UPDATE feature_flag_settings
       SET mode = 'on', revision = revision + 1, updated_at = NOW()
       WHERE flag_key = 'context.group_policy'
         AND scope_type = 'platform'
         AND scope_id = 'platform'`,
    );
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

  async function createAgent(name: string): Promise<string> {
    const result = await request<{ id: string }>("POST", "/api/v1/agents", {
      name,
      runtimeKind: "fake",
    });
    expect(result.statusCode).toBe(201);
    return result.body.id;
  }

  async function createProjectFixture(): Promise<{
    projectId: string;
    agentIds: [string, string];
  }> {
    const project = await request<{ id: string }>("POST", "/api/v1/projects", {
      name: `M5 Group ${randomUUID().slice(0, 8)}`,
      description: "Group Scene isolation",
    });
    expect(project.statusCode).toBe(201);
    const first = await createAgent(`Group AI ${randomUUID().slice(0, 8)}`);
    const second = await createAgent(`Group AI ${randomUUID().slice(0, 8)}`);
    for (const agentId of [first, second]) {
      const member = await request(
        "POST",
        `/api/v1/projects/${project.body.id}/members`,
        {
          kind: "agent",
          agentId,
          responsibility: "Group Scene participant",
          roleIds: [],
        },
      );
      expect(member.statusCode).toBe(201);
    }
    return { projectId: project.body.id, agentIds: [first, second] };
  }

  async function addParticipant(
    sceneId: string,
    projectId: string,
    agentId: string,
  ): Promise<SceneParticipantBinding> {
    const result = await request<SceneParticipantBinding>(
      "POST",
      `/api/v1/group-scenes/${sceneId}/participants`,
      {
        projectId,
        agentId,
        agentPrincipalId: agentId,
        principalId: agentId,
      },
    );
    expect(result.statusCode).toBe(201);
    return result.body;
  }

  async function createSession(
    sceneId: string,
    projectId: string,
    participantBindingId: string,
  ): Promise<SceneSessionBinding> {
    const result = await request<SceneSessionBinding>(
      "POST",
      `/api/v1/group-scenes/${sceneId}/sessions`,
      { projectId, participantBindingId },
    );
    expect(result.statusCode).toBe(201);
    return result.body;
  }

  async function processJob(
    job: ClaimedJob,
    expectFailure = false,
  ): Promise<void> {
    let failed = false;
    try {
      await executor.execute(job.runId, {
        jobId: job.id,
        owner: "m5-group-worker",
        leaseSeconds: 60,
        traceId: job.traceId,
        jobSpanId: job.spanId,
        assertLease: async () => undefined,
      });
    } catch {
      failed = true;
      await repositories.jobs.fail(
        job.id,
        "m5-group-worker",
        job.leaseToken,
        "runtime failed",
      );
    }
    if (!failed) {
      await repositories.jobs.complete(job.id, "m5-group-worker", job.leaseToken);
    }
    expect(failed).toBe(expectFailure);
  }

  it("isolates sessions by group participant and resets generation on leave/rejoin", async () => {
    const fixture = await createProjectFixture();
    const sceneId = `group-${randomUUID()}`;
    const firstParticipant = await addParticipant(
      sceneId,
      fixture.projectId,
      fixture.agentIds[0],
    );
    const secondParticipant = await addParticipant(
      sceneId,
      fixture.projectId,
      fixture.agentIds[1],
    );
    const firstSession = await createSession(
      sceneId,
      fixture.projectId,
      firstParticipant.id,
    );
    const secondSession = await createSession(
      sceneId,
      fixture.projectId,
      secondParticipant.id,
    );
    expect(firstSession.id).not.toBe(secondSession.id);
    expect(firstSession.participantBindingId).toBe(firstParticipant.id);
    expect(secondSession.participantBindingId).toBe(secondParticipant.id);
    expect(firstSession.sessionHandle).not.toBe(secondSession.sessionHandle);
    expect(firstSession.generation).toBe(0);
    expect(secondSession.generation).toBe(0);

    await repositories.sceneContext.addContribution({
      session: firstSession,
      sourceKey: "group:first-secret",
      kind: "manual",
      version: "1",
      authority: "evidence",
      visibility: "scene",
      text: "Only the first AI should receive this context.",
      sourceRefs: [],
      createdBy: "local-admin",
    });
    const firstContributions =
      await repositories.sceneContext.listContributions({
        session: firstSession,
        actorPrincipalId: fixture.agentIds[0],
      });
    const secondContributions =
      await repositories.sceneContext.listContributions({
        session: secondSession,
        actorPrincipalId: fixture.agentIds[1],
      });
    expect(firstContributions).toHaveLength(1);
    expect(secondContributions).toHaveLength(0);

    const paused = await request<SceneParticipantBinding>(
      "PATCH",
      `/api/v1/group-scenes/${sceneId}/participants/${firstParticipant.id}`,
      {
        expectedRevision: firstParticipant.revision,
        status: "paused",
      },
    );
    expect(paused.statusCode).toBe(200);
    const resetSession = await repositories.sceneContext.session(firstSession.id);
    expect(resetSession?.status).toBe("reset");
    const resumed = await request<SceneParticipantBinding>(
      "PATCH",
      `/api/v1/group-scenes/${sceneId}/participants/${firstParticipant.id}`,
      {
        expectedRevision: paused.body.revision,
        status: "active",
      },
    );
    expect(resumed.statusCode).toBe(200);
    const reentered = await createSession(
      sceneId,
      fixture.projectId,
      firstParticipant.id,
    );
    expect(reentered.id).not.toBe(firstSession.id);
    expect(reentered.generation).toBe(1);
    expect(reentered.lastContextSeq).toBe(0);
  });

  it("applies Context Policy CAS, scene overrides and reset without rewriting history", async () => {
    const fixture = await createProjectFixture();
    const initial = await request<ContextPolicy>(
      "GET",
      `/api/v1/context-policy?projectId=${fixture.projectId}&sceneType=group`,
    );
    expect(initial.statusCode).toBe(200);
    expect(initial.body.revision).toBe(1);
    expect(initial.body.settings.warningRatio).toBe(0.7);
    const updated = await request<ContextPolicy>(
      "PUT",
      "/api/v1/context-policy",
      {
        scopeType: "project",
        projectId: fixture.projectId,
        sceneType: "group",
        expectedVersion: initial.body.revision,
        settings: {
          warningRatio: 0.4,
          compactRatio: 0.6,
          rolloverRatio: 0.8,
          preserveRecentMessages: 6,
          maxTriggerDepth: 2,
          maxConcurrentAgentsPerScene: 2,
          maxContextChars: 12_000,
        },
      },
    );
    expect(updated.statusCode).toBe(200);
    expect(updated.body.revision).toBe(2);
    const stale = await request(
      "PUT",
      "/api/v1/context-policy",
      {
        scopeType: "project",
        projectId: fixture.projectId,
        sceneType: "group",
        expectedVersion: initial.body.revision,
        settings: updated.body.settings,
      },
    );
    expect(stale.statusCode).toBe(409);
    expect(stale.body).toMatchObject({
      code: "context_policy_revision_conflict",
    });
    const directChat = await request<ContextPolicy>(
      "GET",
      `/api/v1/context-policy?projectId=${fixture.projectId}&sceneType=direct-chat`,
    );
    expect(directChat.body.sceneType).toBe("direct-chat");
    expect(directChat.body.settings.warningRatio).toBe(0.7);
    const reset = await request<ContextPolicy>(
      "POST",
      "/api/v1/context-policy/reset",
      {
        scopeType: "project",
        projectId: fixture.projectId,
        sceneType: "group",
        expectedVersion: updated.body.revision,
      },
    );
    expect(reset.statusCode).toBe(200);
    expect(reset.body.revision).toBe(3);
    expect(reset.body.settings.warningRatio).toBe(0.7);
    const versions = await database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM context_policy_versions
       WHERE scope_type = 'project'
         AND scope_id = $1
         AND scene_type = 'group'`,
      [fixture.projectId],
    );
    expect(versions.rows[0]?.count).toBe("2");
  });

  it("commits only consumed boundaries and revokes context after permission loss", async () => {
    const fixture = await createProjectFixture();
    const role = await request<{ id: string }>(
      "POST",
      `/api/v1/projects/${fixture.projectId}/roles`,
      {
        name: "Project Viewer",
        permissions: ["read"],
      },
    );
    expect(role.statusCode).toBe(201);
    await database.query(
      `INSERT INTO principals (
         id, kind, display_name, status, status_authority, source,
         version, created_at, updated_at
       ) VALUES (
         'm5-viewer', 'human', 'M5 Viewer', 'active', 'account', 'local',
         1, NOW(), NOW()
       )
       ON CONFLICT (id) DO NOTHING`,
    );
    const member = await request<{ id: string }>(
      "POST",
      `/api/v1/projects/${fixture.projectId}/members`,
      {
        kind: "human",
        actorId: "m5-viewer",
        name: "M5 Viewer",
        responsibility: "Context reader",
        roleIds: [role.body.id],
      },
    );
    expect(member.statusCode).toBe(201);

    const failureTask = await request<Task>("POST", "/api/v1/tasks", {
      projectId: fixture.projectId,
      title: "Failed runtime context boundary",
      description: "Runtime will fail after Context staging.",
      acceptance: [],
      agentId: fixture.agentIds[0],
      dependsOn: [],
      priority: "medium",
      autoSubmit: true,
      autoAccept: false,
      autoRedispatchOnReturn: false,
    });
    expect(failureTask.statusCode).toBe(201);
    const failureDispatch = await request<{ runId: string }>(
      "POST",
      `/api/v1/tasks/${failureTask.body.id}/dispatch`,
    );
    expect(failureDispatch.statusCode).toBe(202);
    await database.query(
      `UPDATE runs
       SET input_snapshot = jsonb_set(
         input_snapshot,
         '{runtimeOptions}',
         '{"fault":"fail"}'::jsonb,
         TRUE
       )
       WHERE id = $1`,
      [failureDispatch.body.runId],
    );
    const failureJob = await repositories.jobs.claimNext(
      "m5-group-worker",
      60,
      failureDispatch.body.runId,
    );
    expect(failureJob).toBeDefined();
    await processJob(failureJob!, true);
    const uncommitted = await database.query<{
      last_context_seq: string;
      status: string;
      receipt_count: string;
      commit_count: string;
    }>(
      `SELECT
         session.last_context_seq,
         session.status,
         (SELECT COUNT(*) FROM scene_context_receipts
          WHERE run_id = $1)::text AS receipt_count,
         (SELECT COUNT(*) FROM scene_context_commit_receipts
          WHERE run_id = $1)::text AS commit_count
       FROM runs AS run
       JOIN scene_context_receipts AS receipt ON receipt.run_id = run.id
       JOIN scene_sessions AS session ON session.id = receipt.scene_session_id
       WHERE run.id = $1`,
      [failureDispatch.body.runId],
    );
    expect(uncommitted.rows[0]).toMatchObject({
      last_context_seq: "0",
      status: "preparing",
      receipt_count: "1",
      commit_count: "0",
    });

    const policy = await request<ContextPolicy>(
      "GET",
      `/api/v1/context-policy?projectId=${fixture.projectId}&sceneType=default`,
    );
    const overridden = await request<ContextPolicy>(
      "PUT",
      "/api/v1/context-policy",
      {
        scopeType: "project",
        projectId: fixture.projectId,
        sceneType: "default",
        expectedVersion: policy.body.revision,
        settings: {
          ...policy.body.settings,
          maxContextChars: 20_000,
        },
      },
    );
    expect(overridden.statusCode).toBe(200);
    const successTask = await request<Task>("POST", "/api/v1/tasks", {
      projectId: fixture.projectId,
      title: "Successful context boundary",
      description: "Runtime consumes and commits the context boundary.",
      acceptance: [],
      agentId: fixture.agentIds[0],
      dependsOn: [],
      priority: "medium",
      autoSubmit: true,
      autoAccept: false,
      autoRedispatchOnReturn: false,
    });
    const successDispatch = await request<{ runId: string }>(
      "POST",
      `/api/v1/tasks/${successTask.body.id}/dispatch`,
    );
    const successJob = await repositories.jobs.claimNext(
      "m5-group-worker",
      60,
      successDispatch.body.runId,
    );
    expect(successJob).toBeDefined();
    await processJob(successJob!);
    const committed = await database.query<{
      last_context_seq: string;
      status: string;
      context_boundary_seq: string;
      context_policy_version: number;
    }>(
      `SELECT
         session.last_context_seq,
         session.status,
         receipt.context_boundary_seq,
         receipt.context_policy_version
       FROM scene_context_commit_receipts AS commit
       JOIN scene_context_receipts AS receipt
         ON receipt.run_id = commit.run_id
       JOIN scene_sessions AS session
         ON session.id = commit.scene_session_id
       WHERE commit.run_id = $1`,
      [successDispatch.body.runId],
    );
    expect(committed.rows[0]).toMatchObject({
      status: "active",
      context_policy_version: overridden.body.revision,
    });
    expect(Number(committed.rows[0]?.last_context_seq)).toBe(
      Number(committed.rows[0]?.context_boundary_seq),
    );
    const contextAudit = await database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM identity_audit_events
       WHERE action = 'context.committed'
         AND metadata ->> 'runId' = $1`,
      [successDispatch.body.runId],
    );
    expect(contextAudit.rows[0]?.count).toBe("1");

    const viewerRead = await request(
      "GET",
      `/api/v1/runs/${successDispatch.body.runId}/scene-context`,
      undefined,
      "m5-viewer",
    );
    expect(viewerRead.statusCode).toBe(200);
    const newPolicy = await request<ContextPolicy>(
      "PUT",
      "/api/v1/context-policy",
      {
        scopeType: "project",
        projectId: fixture.projectId,
        sceneType: "default",
        expectedVersion: overridden.body.revision,
        settings: {
          ...overridden.body.settings,
          warningRatio: 0.5,
        },
      },
    );
    expect(newPolicy.statusCode).toBe(200);
    const policyAudit = await database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM identity_audit_events
       WHERE action = 'context.policy.updated'
         AND metadata ->> 'scopeId' = $1`,
      [fixture.projectId],
    );
    expect(Number(policyAudit.rows[0]?.count)).toBeGreaterThanOrEqual(1);
    const historical = await database.query<{
      context_policy_version: number;
    }>(
      "SELECT context_policy_version FROM context_packs WHERE run_id = $1",
      [successDispatch.body.runId],
    );
    expect(historical.rows[0]?.context_policy_version).toBe(
      overridden.body.revision,
    );
    await expect(
      database.query(
        "UPDATE context_packs SET content_hash = $2 WHERE run_id = $1",
        [successDispatch.body.runId, "f".repeat(64)],
      ),
    ).rejects.toThrow(/immutable/);

    await database.query(
      `UPDATE project_members
       SET status = 'inactive', updated_at = NOW()
       WHERE id = $1`,
      [member.body.id],
    );
    const revoked = await request(
      "GET",
      `/api/v1/runs/${successDispatch.body.runId}/scene-context`,
      undefined,
      "m5-viewer",
    );
    expect(revoked.statusCode).toBe(403);
  });

  it("keeps only source indexes and tool entry points when context exceeds budget", async () => {
    const fixture = await createProjectFixture();
    const policy = await request<ContextPolicy>(
      "GET",
      `/api/v1/context-policy?projectId=${fixture.projectId}&sceneType=default`,
    );
    const tight = await request<ContextPolicy>(
      "PUT",
      "/api/v1/context-policy",
      {
        scopeType: "project",
        projectId: fixture.projectId,
        sceneType: "default",
        expectedVersion: policy.body.revision,
        settings: {
          warningRatio: 0.1,
          compactRatio: 0.2,
          rolloverRatio: 0.3,
          preserveRecentMessages: 2,
          maxTriggerDepth: 3,
          maxConcurrentAgentsPerScene: 3,
          maxContextChars: 1_000,
        },
      },
    );
    expect(tight.statusCode).toBe(200);
    const task = await request<Task>("POST", "/api/v1/tasks", {
      projectId: fixture.projectId,
      title: "Budget rollover task",
      description: "Context budget must not leak full source text.",
      acceptance: [],
      agentId: fixture.agentIds[0],
      dependsOn: [],
      priority: "medium",
      autoSubmit: true,
      autoAccept: false,
      autoRedispatchOnReturn: false,
    });
    const dispatched = await request<{ runId: string }>(
      "POST",
      `/api/v1/tasks/${task.body.id}/dispatch`,
    );
    const run = await repositories.runs.get(dispatched.body.runId);
    const project = await repositories.projects.get(fixture.projectId);
    const agent = await repositories.agents.get(fixture.agentIds[0]);
    const taskRecord = await repositories.tasks.get(task.body.id);
    expect(run).toBeDefined();
    expect(project).toBeDefined();
    expect(agent).toBeDefined();
    expect(taskRecord).toBeDefined();
    const session = await repositories.sceneContext.ensureSession({
      sceneType: "task",
      sceneId: task.body.id,
      projectId: fixture.projectId,
      agentId: agent!.id,
      agentPrincipalId: agent!.principalId ?? agent!.id,
      ownerPrincipalId: null,
    });
    const secret = `BUDGET_SECRET_${"x".repeat(4_000)}`;
    await repositories.sceneContext.addContribution({
      session,
      sourceKey: "manual:oversized-context",
      kind: "manual",
      version: "1",
      authority: "evidence",
      visibility: "project",
      text: secret,
      sourceRefs: [
        {
          type: "task",
          id: task.body.id,
          projectId: fixture.projectId,
          sceneType: "task",
          sceneId: task.body.id,
        },
      ],
      createdBy: "local-admin",
    });
    const prepared = await new SceneContextService(repositories).prepare({
      run: run!,
      project: project!,
      task: taskRecord!,
      agent: agent!,
      meetingContext: null,
      directChatContext: null,
      episodes: [],
    });
    expect(prepared.pack.renderedPrompt).not.toContain("BUDGET_SECRET");
    expect(prepared.pack.renderedPrompt).toContain("Context budget exceeded");
    expect(prepared.pack.renderedPrompt).toContain("entity.read");
    expect(prepared.receipt.excluded).toContainEqual(
      expect.objectContaining({ reason: "budget" }),
    );
    expect(prepared.receipt.contextUsageRatio).toBeGreaterThanOrEqual(0.3);
  });
});
