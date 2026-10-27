import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RunExecutor } from "@pluginmax/application";
import type {
  ExecutionHistoryPage,
  ParsedTeammateWorkPlan,
  Project,
  ProjectMember,
  ProjectRole,
  Teammate,
  TeammateQueueItem,
  TeammateRuntimeStatistics,
  TeammateTemplate,
  TeammateWeeklyReport,
} from "@pluginmax/contracts";
import {
  Database,
  JobRepository,
  PlatformRepositories,
  migrate,
} from "@pluginmax/database";
import { buildApi } from "./app.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl === undefined ? describe.skip : describe;

integration("AI Teammate API", () => {
  let database: Database;
  let repositories: PlatformRepositories;
  let app: ReturnType<typeof buildApi>["app"];
  let executor: RunExecutor;
  let project: Project;
  let otherProject: Project;
  let writerRole: ProjectRole;
  let agentId = "";
  let teammate: Teammate;
  let template: TeammateTemplate;
  let taskIds: string[] = [];
  const suffix = randomUUID().slice(0, 8);
  const memberActor = `teammate-member-${suffix}`;
  const transferActor = `teammate-transfer-${suffix}`;
  const outsiderActor = `teammate-outsider-${suffix}`;

  async function request<T>(
    method: "GET" | "POST" | "PATCH" | "PUT",
    url: string,
    payload?: unknown,
    actorId = "local-admin",
  ): Promise<{ statusCode: number; body: T }> {
    const options: InjectOptions = {
      method,
      url,
      headers: { "x-pluginmax-actor": actorId },
    };
    if (payload !== undefined)
      options.payload = payload as Record<string, unknown>;
    const response = await app.inject(options);
    return {
      statusCode: response.statusCode,
      body: response.json() as T,
    };
  }

  async function addHumanMember(projectId: string, actorId: string) {
    await request("GET", "/api/v1/viewer", undefined, actorId);
    const member = await request<ProjectMember>(
      "POST",
      `/api/v1/projects/${projectId}/members`,
      {
        kind: "human",
        actorId,
        responsibility: "AI Teammate governance",
        roleIds: [writerRole.id],
      },
    );
    expect(member.statusCode, JSON.stringify(member.body)).toBe(201);
  }

  async function processRun(runId: string) {
    const job = await new JobRepository(database).claimNext(
      `teammate-worker-${suffix}`,
      30,
      runId,
    );
    expect(job).toBeDefined();
    await executor.execute(runId, {
      jobId: job!.id,
      owner: `teammate-worker-${suffix}`,
      jobAttempt: job!.attempts,
    });
  }

  beforeAll(async () => {
    database = new Database(databaseUrl!);
    repositories = new PlatformRepositories(database);
    await migrate(database);
    const fileStoreRoot = await mkdtemp(
      join(tmpdir(), "pluginmax-teammates-api-"),
    );
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

    const primary = await request<Project>("POST", "/api/v1/projects", {
      name: `AI Teammate ${suffix}`,
      description: "Batch 17B end-to-end fixture",
    });
    expect(primary.statusCode, JSON.stringify(primary.body)).toBe(201);
    project = primary.body;
    const secondary = await request<Project>("POST", "/api/v1/projects", {
      name: `AI Teammate other ${suffix}`,
      description: "Cross workspace fixture",
    });
    expect(secondary.statusCode).toBe(201);
    otherProject = secondary.body;
    const role = await request<ProjectRole>(
      "POST",
      `/api/v1/projects/${project.id}/roles`,
      {
        name: `Teammate Writer ${suffix}`,
        permissions: ["read", "write"],
      },
    );
    expect(role.statusCode, JSON.stringify(role.body)).toBe(201);
    writerRole = role.body;
    await addHumanMember(project.id, memberActor);
    await addHumanMember(project.id, transferActor);
    await request("GET", "/api/v1/viewer", undefined, outsiderActor);
    const agent = await request<{ id: string }>("POST", "/api/v1/agents", {
      name: `Teammate execution ${suffix}`,
      description: "Fake teammate execution",
      runtimeKind: "fake",
    });
    expect(agent.statusCode).toBe(201);
    agentId = agent.body.id;
    const member = await request<ProjectMember>(
      "POST",
      `/api/v1/projects/${project.id}/members`,
      {
        kind: "agent",
        agentId,
        responsibility: "AI Teammate execution",
        roleIds: [writerRole.id],
      },
    );
    expect(member.statusCode, JSON.stringify(member.body)).toBe(201);
  });

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  it("enforces template versions, ownership, queue safety, execution attribution and reporting", async () => {
    const createdTemplate = await request<TeammateTemplate>(
      "POST",
      "/api/v1/teammate-templates",
      {
        projectId: project.id,
        scope: "personal",
        definition: {
          name: `Research teammate ${suffix}`,
          role: "Researcher",
          description: "Produces verified research",
          soul: "Stay evidence-first.",
          scenarios: ["Research"],
          goals: ["Traceable output"],
          tools: ["search", "file-read"],
        },
      },
    );
    expect(
      createdTemplate.statusCode,
      JSON.stringify(createdTemplate.body),
    ).toBe(201);
    template = createdTemplate.body;
    const versionConflict = await request(
      "PATCH",
      `/api/v1/teammate-templates/${template.id}`,
      {
        expectedVersion: 2,
        definition: {
          ...template.definition,
          description: "stale",
        },
      },
    );
    expect(versionConflict.statusCode).toBe(409);
    const revised = await request<TeammateTemplate>(
      "PATCH",
      `/api/v1/teammate-templates/${template.id}`,
      {
        expectedVersion: 1,
        definition: {
          ...template.definition,
          description: "Second immutable version",
        },
      },
    );
    expect(revised.statusCode, JSON.stringify(revised.body)).toBe(200);
    expect(revised.body.currentVersion).toBe(2);
    const stale = await request(
      "PATCH",
      `/api/v1/teammate-templates/${template.id}`,
      {
        expectedVersion: 1,
        definition: template.definition,
      },
    );
    expect(stale.statusCode).toBe(409);
    expect(stale.body).toMatchObject({
      code: "teammate_template_version_conflict",
    });

    const created = await request<Teammate>("POST", "/api/v1/teammates", {
      projectId: project.id,
      templateId: template.id,
      agentId,
      name: `Researcher ${suffix}`,
      autoExecute: true,
    });
    expect(created.statusCode, JSON.stringify(created.body)).toBe(201);
    teammate = created.body;
    expect(teammate).toMatchObject({
      templateVersion: 2,
      ownerPrincipalId: "local-admin",
      status: "active",
    });

    const crossWorkspace = await request("POST", "/api/v1/teammates", {
      projectId: otherProject.id,
      templateId: template.id,
      agentId,
      name: `Cross ${suffix}`,
    });
    expect(crossWorkspace.statusCode).toBe(403);
    expect(crossWorkspace.body).toMatchObject({
      code: "teammate_template_cross_project",
    });
    const outsiderRead = await request(
      "GET",
      `/api/v1/teammates?projectId=${project.id}`,
      undefined,
      outsiderActor,
    );
    expect(outsiderRead.statusCode).toBe(403);
    const nonOwner = await request(
      "POST",
      `/api/v1/teammates/${teammate.id}/status`,
      {
        status: "paused",
        expectedVersion: teammate.version,
        reason: "non-owner",
      },
      memberActor,
    );
    expect(nonOwner.statusCode).toBe(403);
    expect(nonOwner.body).toMatchObject({ code: "teammate_owner_required" });

    const parsed = await request<ParsedTeammateWorkPlan>(
      "POST",
      `/api/v1/teammates/${teammate.id}/work-plans/parse`,
      {
        instruction: "明天 P1 整理竞品证据\nP2 输出对比表",
      },
    );
    expect(parsed.statusCode, JSON.stringify(parsed.body)).toBe(200);
    expect(parsed.body.restricted.autoAccept).toBe(false);
    expect(parsed.body.items).toHaveLength(2);
    const plan = await request<{
      planId: string;
      taskIds: string[];
      queue: TeammateQueueItem[];
    }>("POST", `/api/v1/teammates/${teammate.id}/work-plans`, {
      instruction: parsed.body.instruction,
      items: parsed.body.items,
      autoExecuteEligible: true,
    });
    expect(plan.statusCode, JSON.stringify(plan.body)).toBe(201);
    taskIds = plan.body.taskIds;
    expect(plan.body.queue.every((item) => item.autoEligible)).toBe(true);
    const reordered = await request<{ items: TeammateQueueItem[] }>(
      "POST",
      `/api/v1/teammates/${teammate.id}/work-queue/reorder`,
      { taskIds: [taskIds[1], taskIds[0]] },
    );
    expect(reordered.statusCode).toBe(200);
    expect(reordered.body.items.map((item) => item.taskId)).toEqual([
      taskIds[1],
      taskIds[0],
    ]);

    const gatedPolicy = {
      expectedRevision: 0,
      policy: {
        runtime: {},
        sourcePolicy: {},
        toolPolicy: {
          requireApproval: ["shell"],
        },
        evidence: {},
        humanGates: [],
        budget: {},
      },
    };
    const policy = await request(
      "PUT",
      `/api/v1/tasks/${taskIds[1]}/execution-policy`,
      gatedPolicy,
    );
    expect(policy.statusCode, JSON.stringify(policy.body)).toBe(200);
    const gatedQueue = await request<{ items: TeammateQueueItem[] }>(
      "GET",
      `/api/v1/teammates/${teammate.id}/work-queue`,
    );
    expect(
      gatedQueue.body.items.find((item) => item.taskId === taskIds[1]),
    ).toMatchObject({
      autoEligible: false,
      blockedReasons: expect.arrayContaining(["approval-required"]),
    });
    const skipped = await request<{
      attempted: number;
      dispatched: number;
      skipped: number;
    }>("POST", `/api/v1/teammates/${teammate.id}/auto-run`);
    expect(skipped.body).toMatchObject({
      attempted: 1,
      dispatched: 0,
      skipped: 1,
    });
    expect(await repositories.runs.listByTask(taskIds[1]!)).toHaveLength(0);

    const openPolicy = await request(
      "PUT",
      `/api/v1/tasks/${taskIds[1]}/execution-policy`,
      {
        expectedRevision: 1,
        policy: {
          runtime: {},
          sourcePolicy: {},
          toolPolicy: {},
          evidence: {},
          humanGates: [],
          budget: {},
        },
      },
    );
    expect(openPolicy.statusCode, JSON.stringify(openPolicy.body)).toBe(200);
    const autoRuns = await Promise.all([
      request<{
        attempted: number;
        dispatched: number;
        skipped: number;
      }>("POST", `/api/v1/teammates/${teammate.id}/auto-run`),
      request<{
        attempted: number;
        dispatched: number;
        skipped: number;
      }>("POST", `/api/v1/teammates/${teammate.id}/auto-run`),
    ]);
    expect(
      autoRuns
        .map((item) => item.body.dispatched)
        .reduce((sum, value) => sum + value, 0),
    ).toBe(1);
    expect(
      autoRuns
        .map((item) => item.body.attempted)
        .reduce((sum, value) => sum + value, 0),
    ).toBe(1);
    const runs = await repositories.runs.listByTask(taskIds[1]!);
    expect(runs).toHaveLength(1);
    await processRun(runs[0]!.id);

    const attribution = await repositories.teammates.getRunAttribution(
      runs[0]!.id,
    );
    expect(attribution).toMatchObject({
      teammateId: teammate.id,
      templateVersion: 2,
      aiPrincipalId: teammate.aiPrincipalId,
      ownerPrincipalId: teammate.ownerPrincipalId,
    });
    expect(attribution?.sceneSessionId).not.toBeNull();

    const economics = await request<TeammateRuntimeStatistics>(
      "GET",
      `/api/v1/teammates/${teammate.id}/economics`,
    );
    expect(economics.statusCode, JSON.stringify(economics.body)).toBe(200);
    expect(economics.body).toMatchObject({
      runCount: 1,
      usage: {
        sampleCount: 1,
      },
    });
    expect(economics.body.unknownSamples.token).toBe(1);
    const history = await request<ExecutionHistoryPage>(
      "GET",
      `/api/v1/teammates/${teammate.id}/execution-history?limit=10`,
    );
    expect(history.statusCode, JSON.stringify(history.body)).toBe(200);
    expect(history.body.items).toHaveLength(1);
    const cursorConflict = await request(
      "GET",
      `/api/v1/teammates/${teammate.id}/execution-history?cursor=invalid`,
    );
    expect(cursorConflict.statusCode).toBe(409);
    expect(cursorConflict.body).toMatchObject({
      code: "teammate_execution_history_cursor_conflict",
    });

    const report = await request<TeammateWeeklyReport>(
      "POST",
      `/api/v1/teammates/${teammate.id}/weekly-reports/generate`,
      { weekStart: "2026-10-26" },
    );
    expect(report.statusCode, JSON.stringify(report.body)).toBe(200);
    expect(report.body).toMatchObject({
      teammateId: teammate.id,
      weekStart: "2026-10-26",
      weekEnd: "2026-11-01",
      statistics: { runCount: 1 },
    });

    const detailBeforeTransfer = await request<{
      teammate: Teammate;
    }>("GET", `/api/v1/teammates/${teammate.id}`);
    expect(detailBeforeTransfer.body.teammate.templateVersion).toBe(2);
    const transfer = await request<Teammate>(
      "POST",
      `/api/v1/teammates/${teammate.id}/transfer`,
      {
        toOwnerPrincipalId: transferActor,
        expectedVersion: detailBeforeTransfer.body.teammate.version,
        reason: "Shift ownership",
      },
    );
    expect(transfer.statusCode, JSON.stringify(transfer.body)).toBe(200);
    expect(transfer.body.ownerPrincipalId).toBe(transferActor);
    const paused = await request<Teammate>(
      "POST",
      `/api/v1/teammates/${teammate.id}/status`,
      {
        status: "paused",
        expectedVersion: transfer.body.version,
        reason: "Pause after transfer",
      },
    );
    expect(paused.statusCode, JSON.stringify(paused.body)).toBe(200);
    const archived = await request<Teammate>(
      "POST",
      `/api/v1/teammates/${teammate.id}/status`,
      {
        status: "archived",
        expectedVersion: paused.body.version,
        reason: "Archive",
      },
    );
    expect(archived.statusCode, JSON.stringify(archived.body)).toBe(200);
    expect(archived.body.status).toBe("archived");
    const restored = await request<Teammate>(
      "POST",
      `/api/v1/teammates/${teammate.id}/status`,
      {
        status: "inactive",
        expectedVersion: archived.body.version,
        reason: "Restore for history",
      },
    );
    expect(restored.statusCode, JSON.stringify(restored.body)).toBe(200);
    const detail = await request<{
      transfers: unknown[];
      events: unknown[];
      templateVersion: { version: number };
      template: TeammateTemplate;
    }>("GET", `/api/v1/teammates/${teammate.id}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.body.transfers).toHaveLength(1);
    expect(detail.body.templateVersion.version).toBe(2);
    expect(detail.body.template.currentVersion).toBe(2);
    expect(detail.body.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "transfer" }),
        expect.objectContaining({ kind: "auto-run" }),
        expect.objectContaining({ kind: "archive" }),
      ]),
    );

    const archivedTemplate = await request<TeammateTemplate>(
      "POST",
      `/api/v1/teammate-templates/${template.id}/archive`,
      { expectedVersion: 2 },
    );
    expect(archivedTemplate.statusCode).toBe(200);
    expect(archivedTemplate.body.status).toBe("archived");
    const blockedInstance = await request("POST", "/api/v1/teammates", {
      projectId: project.id,
      templateId: template.id,
      agentId,
      name: `Blocked ${suffix}`,
    });
    expect(blockedInstance.statusCode).toBe(409);
    expect(blockedInstance.body).toMatchObject({
      code: "teammate_template_inactive",
    });
  });
});
