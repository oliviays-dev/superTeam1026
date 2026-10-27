import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RunExecutor } from "@pluginmax/application";
import type {
  ExecutionHistoryPage,
  ExternalRuntime,
  Project,
  RunExecutionEconomics,
  RuntimeAccessProjection,
  WorkspaceRuntimeCatalogItem,
  WorkspaceRuntimeEconomics,
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

integration("Runtime economics and Workspace visibility API", () => {
  let database: Database;
  let repositories: PlatformRepositories;
  let app: ReturnType<typeof buildApi>["app"];
  let executor: RunExecutor;
  let project: Project;
  let otherProject: Project;
  let workspaceRuntime: ExternalRuntime;
  let otherRuntime: ExternalRuntime;
  const suffix = randomUUID().slice(0, 8);
  const memberActor = `runtime-member-${suffix}`;
  const outsiderActor = `runtime-outsider-${suffix}`;

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

  async function createRuntime(
    workspaceId: string,
    label: string,
  ): Promise<ExternalRuntime> {
    const response = await request<ExternalRuntime>(
      "POST",
      "/api/v1/runtimes",
      {
        name: `${label} ${suffix}`,
        provider: "command",
        protocol: "plain-text",
        command: "runtime-fixture",
        managedArgs: [],
        customArgs: [],
        supportedModels: [],
        defaultModel: null,
        contextWindowTokens: null,
        supportedTools: [],
        networkMode: "unknown",
        sandboxMode: "read-only",
        visibility: "workspace",
        workspaceId,
      },
    );
    expect(response.statusCode, JSON.stringify(response.body)).toBe(201);
    return response.body;
  }

  async function addProjectReader(
    projectId: string,
    actorId: string,
  ): Promise<void> {
    await database.query(
      `INSERT INTO principals (
         id, kind, display_name, status, status_authority, source,
         version, created_at, updated_at
       ) VALUES ($1, 'human', $2, 'active', 'legacy', 'local',
                 1, NOW(), NOW())`,
      [actorId, actorId],
    );
    await database.query(
      `INSERT INTO project_members (
         id, project_id, kind, actor_id, principal_id, name, responsibility,
         status, is_owner, created_at, updated_at
       ) VALUES (
         $1, $2, 'human', $3, $3, $3, 'economics reader',
         'active', FALSE, NOW(), NOW()
       )`,
      [randomUUID(), projectId, actorId],
    );
    await database.query(
      `INSERT INTO role_grants (
         id, principal_id, scope_type, scope_id, role_key, permissions,
         status, source_kind, source_ref, granted_at, version,
         created_at, updated_at
       ) VALUES (
         $1, $2, 'project', $3, 'RUNTIME_READER', '["read"]'::jsonb,
         'active', 'project-role', 'batch13.1b-api', NOW(), 1, NOW(), NOW()
       )`,
      [randomUUID(), actorId, projectId],
    );
  }

  beforeAll(async () => {
    database = new Database(databaseUrl!);
    repositories = new PlatformRepositories(database);
    await migrate(database);
    const fileStoreRoot = await mkdtemp(
      join(tmpdir(), "pluginmax-runtime-economics-api-"),
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
      name: `Runtime economics ${suffix}`,
      description: "Workspace runtime visibility",
    });
    expect(primary.statusCode, JSON.stringify(primary.body)).toBe(201);
    project = primary.body;
    const secondary = await request<Project>("POST", "/api/v1/projects", {
      name: `Runtime economics other ${suffix}`,
      description: "Cross-workspace rejection",
    });
    expect(secondary.statusCode).toBe(201);
    otherProject = secondary.body;
    await addProjectReader(project.id, memberActor);
    await database.query(
      `INSERT INTO principals (
         id, kind, display_name, status, status_authority, source,
         version, created_at, updated_at
       ) VALUES ($1, 'human', $1, 'active', 'legacy', 'local',
                 1, NOW(), NOW())`,
      [outsiderActor],
    );
    workspaceRuntime = await createRuntime(project.id, "Workspace runtime");
    otherRuntime = await createRuntime(otherProject.id, "Other runtime");
  });

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  it("projects Workspace Runtime visibility and rejects non-members", async () => {
    const catalog = await request<{ items: WorkspaceRuntimeCatalogItem[] }>(
      "GET",
      `/api/v1/workspaces/${project.id}/runtimes`,
      undefined,
      memberActor,
    );
    expect(catalog.statusCode, JSON.stringify(catalog.body)).toBe(200);
    expect(catalog.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runtime: expect.objectContaining({ id: workspaceRuntime.id }),
          access: expect.objectContaining({
            canRead: true,
            canManage: false,
            source: "project-grant",
          }),
        }),
      ]),
    );
    expect(
      catalog.body.items.some((item) => item.runtime.id === otherRuntime.id),
    ).toBe(false);
    const access = await request<RuntimeAccessProjection>(
      "GET",
      `/api/v1/runtimes/${workspaceRuntime.id}/access`,
      undefined,
      memberActor,
    );
    expect(access.statusCode).toBe(200);
    expect(access.body).toMatchObject({
      runtimeId: workspaceRuntime.id,
      workspaceId: project.id,
      canRead: true,
      canManage: false,
    });
    const crossWorkspace = await request<RuntimeAccessProjection>(
      "GET",
      `/api/v1/runtimes/${otherRuntime.id}/access`,
      undefined,
      memberActor,
    );
    expect(crossWorkspace.statusCode).toBe(403);
    const outsider = await request<{ items: WorkspaceRuntimeCatalogItem[] }>(
      "GET",
      `/api/v1/workspaces/${project.id}/runtimes`,
      undefined,
      outsiderActor,
    );
    expect(outsider.statusCode).toBe(403);
  });

  it("captures unknown Runtime usage and exposes reconciled Run economics", async () => {
    const agent = await request<{ id: string }>("POST", "/api/v1/agents", {
      name: `Economics agent ${suffix}`,
      runtimeKind: "fake",
    });
    expect(agent.statusCode).toBe(201);
    await request("POST", `/api/v1/projects/${project.id}/members`, {
      kind: "agent",
      agentId: agent.body.id,
      responsibility: "Runtime economics",
      roleIds: [],
    });
    const task = await request<{ id: string }>("POST", "/api/v1/tasks", {
      projectId: project.id,
      title: `Economics task ${suffix}`,
      description: "Capture Runtime economics",
      agentId: agent.body.id,
    });
    expect(task.statusCode, JSON.stringify(task.body)).toBe(201);
    const dispatched = await request<{ runId: string }>(
      "POST",
      `/api/v1/tasks/${task.body.id}/dispatch`,
    );
    expect(dispatched.statusCode, JSON.stringify(dispatched.body)).toBe(202);
    const job = await new JobRepository(database).claimNext(
      "runtime-economics-worker",
      30,
      dispatched.body.runId,
    );
    expect(job).toBeDefined();
    await executor.execute(dispatched.body.runId, {
      jobId: job!.id,
      owner: "runtime-economics-worker",
      jobAttempt: job!.attempts,
    });
    const economics = await request<RunExecutionEconomics>(
      "GET",
      `/api/v1/runs/${dispatched.body.runId}/economics`,
    );
    expect(economics.statusCode, JSON.stringify(economics.body)).toBe(200);
    expect(economics.body).toMatchObject({
      runId: dispatched.body.runId,
      workspaceId: project.id,
      contextType: "task",
      usage: {
        sampleCount: 1,
        unknownSampleCount: 1,
        totalTokens: 0,
      },
      reconciliation: {
        status: "reconciled",
      },
    });
    expect(economics.body.usage.unknownFields).toEqual(
      expect.arrayContaining(["inputTokens", "outputTokens", "costAmount"]),
    );
    expect(economics.body.claim).toMatchObject({
      jobId: job!.id,
      workerId: "runtime-economics-worker",
    });
    expect(economics.body.durations.observedTotalMs).toBeGreaterThan(0);
    expect(economics.body.durations.runningMs).toBeGreaterThan(0);
    expect(economics.body.durations.settlementMs).toBeGreaterThanOrEqual(0);
  });

  it("returns Workspace aggregation and rejects Cursor/Workspace conflicts", async () => {
    const statistics = await request<WorkspaceRuntimeEconomics>(
      "GET",
      `/api/v1/workspaces/${project.id}/runtime-economics`,
      undefined,
      memberActor,
    );
    expect(statistics.statusCode, JSON.stringify(statistics.body)).toBe(200);
    expect(statistics.body.runCount).toBeGreaterThanOrEqual(1);
    expect(statistics.body.runtimes.length).toBeGreaterThanOrEqual(1);

    await database.query(
      `INSERT INTO runs (
         id, project_id, task_id, agent_id, status, input_snapshot,
         execution_context_type, execution_context_id,
         execution_envelope_snapshot, observability, attempt,
         created_at, updated_at, ended_at
       ) VALUES (
         $1, $2, NULL, '00000000-0000-4000-8000-000000000001', 'completed',
         '{"taskTitle":"historical","taskDescription":"historical","acceptance":[],"instruction":"historical","agentName":"Fake","runtimeKind":"fake"}'::jsonb,
         'task', $4,
         $3::jsonb,
         '{"planVisibility":"structured","toolEventCompleteness":"complete","textStreaming":"delta","subagentVisibility":"none"}'::jsonb,
         1, NOW() + INTERVAL '1 second', NOW() + INTERVAL '1 second',
         NOW() + INTERVAL '2 seconds'
       )`,
      [
        randomUUID(),
        project.id,
        JSON.stringify({
          workspaceId: project.id,
          contextType: "task",
          contextId: "history",
          runtime: { id: "builtin:fake", revision: 1 },
          envelope: { launch: { provider: "fake" } },
        }),
        randomUUID(),
      ],
    );
    const first = await request<ExecutionHistoryPage>(
      "GET",
      `/api/v1/workspaces/${project.id}/execution-history?limit=1`,
      undefined,
      memberActor,
    );
    expect(first.statusCode, JSON.stringify(first.body)).toBe(200);
    expect(first.body.nextCursor).not.toBeNull();
    const conflict = await request<{ code: string }>(
      "GET",
      `/api/v1/workspaces/${project.id}/execution-history?limit=1&status=completed&cursor=${
        first.body.nextCursor!
      }`,
      undefined,
      memberActor,
    );
    expect(conflict.statusCode).toBe(409);
    expect(conflict.body).toMatchObject({
      code: "execution_history_cursor_conflict",
    });
    const crossWorkspace = await request<{ code: string }>(
      "GET",
      `/api/v1/workspaces/${otherProject.id}/execution-history`,
      undefined,
      memberActor,
    );
    expect(crossWorkspace.statusCode).toBe(403);
  });
});
