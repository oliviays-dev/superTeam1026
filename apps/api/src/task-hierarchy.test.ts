import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Agent, Project, Task, TaskDetail } from "@pluginmax/contracts";
import { Database, migrate, PlatformRepositories } from "@pluginmax/database";
import { buildApi } from "./app.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl === undefined ? describe.skip : describe;

integration("M9 one-level task hierarchy", () => {
  let database: Database;
  let repositories: PlatformRepositories;
  let app: ReturnType<typeof buildApi>["app"];

  beforeAll(async () => {
    database = new Database(databaseUrl!);
    await migrate(database);
    repositories = new PlatformRepositories(database);
    await repositories.authorization.ensureDevelopmentPrincipal(
      "local-admin",
      true,
    );
    const fileStoreRoot = await mkdtemp(
      join(tmpdir(), "pluginmax-m9-hierarchy-files-"),
    );
    const built = buildApi({
      databaseUrl: databaseUrl!,
      database,
      fileStoreRoot,
      logger: false,
      localActorId: "local-admin",
    });
    app = built.app;
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  async function request<T>(
    method: "GET" | "POST" | "PATCH",
    url: string,
    payload?: unknown,
  ): Promise<{ statusCode: number; body: T }> {
    const options: InjectOptions = {
      method,
      url,
      headers: { "x-pluginmax-actor": "local-admin" },
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
      description: "M9 task hierarchy fixture",
    });
    expect(result.statusCode, JSON.stringify(result.body)).toBe(201);
    return result.body;
  }

  async function createAgent(label: string): Promise<Agent> {
    const result = await request<Agent>("POST", "/api/v1/agents", {
      name: `${label} ${randomUUID().slice(0, 8)}`,
      description: "M9 task hierarchy fixture",
      runtimeKind: "fake",
    });
    expect(result.statusCode, JSON.stringify(result.body)).toBe(201);
    return result.body;
  }

  async function createTask(
    projectId: string,
    agentId: string,
    title: string,
    parentTaskId?: string,
  ): Promise<Task> {
    const result = await request<Task>("POST", "/api/v1/tasks", {
      projectId,
      agentId,
      title,
      description: `${title} description`,
      acceptance: [`${title} accepted`],
      dependsOn: [],
      ...(parentTaskId === undefined ? {} : { parentTaskId }),
    });
    expect(result.statusCode, JSON.stringify(result.body)).toBe(201);
    return result.body;
  }

  it("keeps task hierarchy to one project-scoped level", async () => {
    const project = await createProject("Task hierarchy");
    const agent = await createAgent("Task hierarchy agent");
    const member = await request(
      "POST",
      `/api/v1/projects/${project.id}/members`,
      {
        kind: "agent",
        agentId: agent.id,
        responsibility: "Execute hierarchy fixture tasks",
        roleIds: [],
      },
    );
    expect(member.statusCode, JSON.stringify(member.body)).toBe(201);

    const parent = await createTask(project.id, agent.id, "Parent task");
    const child = await createTask(
      project.id,
      agent.id,
      "Child task",
      parent.id,
    );
    expect(child.parentTaskId).toBe(parent.id);

    const grandchild = await request<TaskDetail>("POST", "/api/v1/tasks", {
      projectId: project.id,
      agentId: agent.id,
      parentTaskId: child.id,
      title: "Grandchild task",
      description: "Rejected third level",
      acceptance: [],
      dependsOn: [],
    });
    expect(grandchild.statusCode).toBe(409);
    expect(grandchild.body).toMatchObject({ code: "task_hierarchy_depth" });

    const promoted = await request<TaskDetail>(
      "PATCH",
      `/api/v1/tasks/${parent.id}/parent`,
      { parentTaskId: child.id, expectedRevision: parent.revision },
    );
    expect(promoted.statusCode).toBe(409);
    expect(promoted.body).toMatchObject({ code: "task_hierarchy_depth" });

    const detached = await request<TaskDetail>(
      "PATCH",
      `/api/v1/tasks/${child.id}/parent`,
      { parentTaskId: null, expectedRevision: child.revision },
    );
    expect(detached.statusCode, JSON.stringify(detached.body)).toBe(200);
    expect(detached.body.task.parentTaskId).toBeUndefined();

    const reattached = await request<TaskDetail>(
      "PATCH",
      `/api/v1/tasks/${child.id}/parent`,
      {
        parentTaskId: parent.id,
        expectedRevision: detached.body.task.revision,
      },
    );
    expect(reattached.statusCode, JSON.stringify(reattached.body)).toBe(200);
    expect(reattached.body.task.parentTaskId).toBe(parent.id);

    const stale = await request<TaskDetail>(
      "PATCH",
      `/api/v1/tasks/${child.id}/parent`,
      { parentTaskId: null, expectedRevision: child.revision },
    );
    expect(stale.statusCode).toBe(409);
    expect(stale.body).toMatchObject({ code: "task_revision_conflict" });

    const detail = await request<TaskDetail>(
      "GET",
      `/api/v1/tasks/${child.id}/detail`,
    );
    const hierarchyEvent = detail.body.activity.find(
      (event: { kind: string }) => event.kind === "hierarchy",
    );
    expect(hierarchyEvent).toBeDefined();
  });

  it("rejects parents from another project", async () => {
    const first = await createProject("Task hierarchy first");
    const second = await createProject("Task hierarchy second");
    const agent = await createAgent("Cross project hierarchy agent");
    for (const project of [first, second]) {
      const member = await request(
        "POST",
        `/api/v1/projects/${project.id}/members`,
        {
          kind: "agent",
          agentId: agent.id,
          responsibility: "Cross-project hierarchy fixture",
          roleIds: [],
        },
      );
      expect(member.statusCode, JSON.stringify(member.body)).toBe(201);
    }
    const parent = await createTask(first.id, agent.id, "First project parent");
    const result = await request<TaskDetail>("POST", "/api/v1/tasks", {
      projectId: second.id,
      agentId: agent.id,
      parentTaskId: parent.id,
      title: "Invalid cross-project child",
      description: "Must be rejected",
      acceptance: [],
      dependsOn: [],
    });
    expect(result.statusCode).toBe(404);
    expect(result.body).toMatchObject({ code: "task_parent_not_found" });
  });
});
