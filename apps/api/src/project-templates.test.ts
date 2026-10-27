import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Database, migrate } from "@pluginmax/database";
import { buildApi } from "./app.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl === undefined ? describe.skip : describe;

interface ApiErrorBody {
  readonly code: string;
  readonly message: string;
}

interface Project {
  readonly id: string;
  readonly name: string;
  readonly sourceTemplateId: string | null;
  readonly sourceTemplateRevision: number | null;
}

interface TemplateRole {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly revision: number;
}

interface WorkflowTemplate {
  readonly id: string;
  readonly version: number;
}

interface ProjectTemplate {
  readonly id: string;
  readonly revision: number;
  readonly status: "active" | "archived";
  readonly roles: TemplateRole[];
  readonly workflowTemplates: Array<{
    readonly workflowTemplateId: string;
    readonly version: number;
  }>;
  readonly materializedProjectCount: number;
}

interface ProjectRole {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly libraryRoleId: string | null;
}

interface WorkflowDefinition {
  readonly id: string;
  readonly projectId: string;
  readonly sourceTemplateId?: string | null;
  readonly sourceTemplateVersion?: number | null;
}

interface ProjectMember {
  readonly actorId: string;
  readonly owner: boolean;
  readonly roles: ProjectRole[];
}

integration("project templates", () => {
  let database: Database;
  let app: ReturnType<typeof buildApi>["app"];

  beforeAll(async () => {
    database = new Database(databaseUrl!);
    await migrate(database);
    const fileStoreRoot = await mkdtemp(
      join(tmpdir(), "pluginmax-project-templates-test-"),
    );
    const built = buildApi({
      databaseUrl: databaseUrl!,
      database,
      fileStoreRoot,
      logger: false,
      localActorId: "local-admin",
      expectedMigrationVersion: 28,
    });
    app = built.app;
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  async function request<T>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
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

  async function createTemplateRole(
    suffix = randomUUID().slice(0, 6).toUpperCase(),
  ): Promise<TemplateRole> {
    const result = await request<TemplateRole>(
      "POST",
      "/api/v1/template-roles",
      {
        code: `ROLE_${suffix}`,
        name: `角色 ${suffix}`,
        category: "execution",
        description: "Batch 11B integration role",
        permissions: ["read", "write"],
      },
    );
    expect(result.statusCode).toBe(201);
    return result.body;
  }

  async function createWorkflowTemplate(
    suffix = randomUUID().slice(0, 6).toUpperCase(),
  ): Promise<WorkflowTemplate> {
    const result = await request<WorkflowTemplate>(
      "POST",
      "/api/v1/workflow-templates",
      {
        key: `FLOW_${suffix}`,
        name: `工作流 ${suffix}`,
        description: "Batch 11B workflow template",
        definition: {
          steps: [
            {
              name: "执行",
              kind: "agent",
              roleCode: `ROLE_${suffix}`,
            },
            { name: "验收", kind: "human" },
          ],
        },
      },
    );
    expect(result.statusCode).toBe(201);
    return result.body;
  }

  async function createProjectTemplate(input?: {
    actorId?: string;
    accessPolicy?: "all-members" | "selected-members";
    allowedActorIds?: string[];
    roleIds?: string[];
    ownerRoleId?: string;
    workflowTemplates?: Array<{
      workflowTemplateId: string;
      expectedVersion: number;
    }>;
  }): Promise<ProjectTemplate> {
    const suffix = randomUUID().slice(0, 6).toUpperCase();
    const result = await request<ProjectTemplate>(
      "POST",
      "/api/v1/project-templates",
      {
        name: `项目模板 ${suffix}`,
        code: `TPL-${suffix}`,
        type: "集成测试",
        description: "Batch 11B project template",
        roleIds: input?.roleIds ?? [],
        ...(input?.ownerRoleId === undefined
          ? {}
          : { ownerRoleId: input.ownerRoleId }),
        workflowTemplates: input?.workflowTemplates ?? [],
        accessPolicy: input?.accessPolicy ?? "all-members",
        allowedActorIds: input?.allowedActorIds ?? [],
      },
      input?.actorId ?? "local-admin",
    );
    expect(result.statusCode).toBe(201);
    return result.body;
  }

  async function materialize(
    templateId: string,
    actorId: string,
    key: string,
    name = `模板项目 ${randomUUID().slice(0, 6)}`,
  ): Promise<{ statusCode: number; body: Project | ApiErrorBody }> {
    return request<Project | ApiErrorBody>(
      "POST",
      "/api/v1/projects",
      {
        name,
        description: "Materialized from Batch 11B template",
        templateId,
        materializationKey: key,
      },
      actorId,
      key,
    );
  }

  it("enforces template administration and selected-member use", async () => {
    const role = await createTemplateRole();
    const deniedCreate = await request<ApiErrorBody>(
      "POST",
      "/api/v1/project-templates",
      {
        name: "Unauthorized template",
        code: `TPL-${randomUUID().slice(0, 6).toUpperCase()}`,
      },
      "member-one",
    );
    expect(deniedCreate.statusCode).toBe(403);
    expect(deniedCreate.body.code).toBe("forbidden");

    const template = await createProjectTemplate({
      accessPolicy: "selected-members",
      allowedActorIds: ["member-one"],
      roleIds: [role.id],
      ownerRoleId: role.id,
    });
    const allowedList = await request<{ items: ProjectTemplate[] }>(
      "GET",
      "/api/v1/project-templates",
      undefined,
      "member-one",
    );
    expect(allowedList.body.items.some((item) => item.id === template.id)).toBe(
      true,
    );
    const deniedList = await request<{ items: ProjectTemplate[] }>(
      "GET",
      "/api/v1/project-templates",
      undefined,
      "member-two",
    );
    expect(deniedList.body.items.some((item) => item.id === template.id)).toBe(
      false,
    );
    const deniedMaterialization = await materialize(
      template.id,
      "member-two",
      `denied-${randomUUID()}`,
    );
    expect(deniedMaterialization.statusCode).toBe(403);
    expect((deniedMaterialization.body as ApiErrorBody).code).toBe(
      "template_forbidden",
    );
    const allowedMaterialization = await materialize(
      template.id,
      "member-one",
      `allowed-${randomUUID()}`,
    );
    expect(allowedMaterialization.statusCode).toBe(201);
  });

  it("copies roles and workflow templates into independent project scope", async () => {
    const suffix = randomUUID().slice(0, 6).toUpperCase();
    const role = await createTemplateRole(suffix);
    const workflow = await createWorkflowTemplate(suffix);
    const template = await createProjectTemplate({
      roleIds: [role.id],
      ownerRoleId: role.id,
      workflowTemplates: [
        {
          workflowTemplateId: workflow.id,
          expectedVersion: workflow.version,
        },
      ],
    });
    const first = await materialize(
      template.id,
      "local-admin",
      `scope-a-${randomUUID()}`,
      `Scope A ${suffix}`,
    );
    const second = await materialize(
      template.id,
      "local-admin",
      `scope-b-${randomUUID()}`,
      `Scope B ${suffix}`,
    );
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    const firstProject = first.body as Project;
    const secondProject = second.body as Project;
    const firstRoles = await request<{ items: ProjectRole[] }>(
      "GET",
      `/api/v1/projects/${firstProject.id}/roles`,
    );
    const secondRoles = await request<{ items: ProjectRole[] }>(
      "GET",
      `/api/v1/projects/${secondProject.id}/roles`,
    );
    expect(firstRoles.body.items[0]?.id).not.toBe(
      secondRoles.body.items[0]?.id,
    );
    expect(firstRoles.body.items[0]?.libraryRoleId).toBe(role.id);

    const firstWorkflows = await request<{ items: WorkflowDefinition[] }>(
      "GET",
      `/api/v1/workflows?projectId=${firstProject.id}`,
    );
    const secondWorkflows = await request<{ items: WorkflowDefinition[] }>(
      "GET",
      `/api/v1/workflows?projectId=${secondProject.id}`,
    );
    expect(firstWorkflows.body.items).toHaveLength(1);
    expect(secondWorkflows.body.items).toHaveLength(1);
    expect(firstWorkflows.body.items[0]?.id).not.toBe(
      secondWorkflows.body.items[0]?.id,
    );
    expect(firstWorkflows.body.items[0]?.projectId).toBe(firstProject.id);
    expect(secondWorkflows.body.items[0]?.projectId).toBe(secondProject.id);

    const roleUpdate = await request<TemplateRole>(
      "PATCH",
      `/api/v1/template-roles/${role.id}`,
      {
        name: "角色库已重命名",
        expectedRevision: role.revision,
      },
    );
    expect(roleUpdate.statusCode).toBe(200);
    const rolesAfterLibraryEdit = await request<{ items: ProjectRole[] }>(
      "GET",
      `/api/v1/projects/${firstProject.id}/roles`,
    );
    expect(rolesAfterLibraryEdit.body.items[0]?.name).toBe(role.name);
  });

  it("replays repeated materialization without creating duplicates", async () => {
    const template = await createProjectTemplate();
    const key = `repeat-${randomUUID()}`;
    const first = await materialize(
      template.id,
      "local-admin",
      key,
      `Repeated ${key}`,
    );
    const second = await materialize(
      template.id,
      "local-admin",
      key,
      `Repeated ${key}`,
    );
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect((second.body as Project).id).toBe((first.body as Project).id);
    const count = await database.query<{ count: number }>(
      `SELECT COUNT(*)::integer AS count
       FROM project_template_materializations
       WHERE template_id = $1 AND idempotency_key = $2`,
      [template.id, key],
    );
    expect(count.rows[0]?.count).toBe(1);
  });

  it("serializes concurrent materialization requests", async () => {
    const template = await createProjectTemplate();
    const key = `concurrent-${randomUUID()}`;
    const responses = await Promise.all(
      Array.from({ length: 6 }, () =>
        materialize(
          template.id,
          "local-admin",
          key,
          `Concurrent ${template.id.slice(0, 8)}`,
        ),
      ),
    );
    expect(responses.every((response) => response.statusCode === 201)).toBe(
      true,
    );
    const projectIds = new Set(
      responses.map((response) => (response.body as Project).id),
    );
    expect(projectIds.size).toBe(1);
    const count = await database.query<{ count: number }>(
      "SELECT COUNT(*)::integer AS count FROM projects WHERE source_template_id = $1",
      [template.id],
    );
    expect(count.rows[0]?.count).toBe(1);
  });

  it("returns an explicit conflict when a referenced role is deleted", async () => {
    const role = await createTemplateRole();
    const template = await createProjectTemplate({
      roleIds: [role.id],
      ownerRoleId: role.id,
    });
    const deletion = await request<ApiErrorBody>(
      "DELETE",
      `/api/v1/template-roles/${role.id}`,
    );
    expect(deletion.statusCode).toBe(409);
    expect(deletion.body.code).toBe("template_role_in_use");
    const detail = await request<ProjectTemplate>(
      "GET",
      `/api/v1/project-templates/${template.id}`,
    );
    expect(detail.body.roles[0]?.id).toBe(role.id);
  });

  it("archives unused templates and rejects archiving materialized templates", async () => {
    const unused = await createProjectTemplate();
    const archived = await request<ProjectTemplate>(
      "POST",
      `/api/v1/project-templates/${unused.id}/archive`,
      { expectedRevision: unused.revision, reason: "no longer offered" },
    );
    expect(archived.statusCode).toBe(200);
    expect(archived.body.status).toBe("archived");
    expect(archived.body.revision).toBe(2);
    const history = await request<{
      items: Array<{ revision: number; status: string }>;
    }>("GET", `/api/v1/project-templates/${unused.id}/history`);
    expect(history.body.items.map((item) => item.revision)).toEqual([2, 1]);
    expect(history.body.items[0]?.status).toBe("archived");

    const used = await createProjectTemplate();
    const materialized = await materialize(
      used.id,
      "local-admin",
      `archive-use-${randomUUID()}`,
    );
    expect(materialized.statusCode).toBe(201);
    const conflict = await request<ApiErrorBody>(
      "POST",
      `/api/v1/project-templates/${used.id}/archive`,
      { expectedRevision: used.revision },
    );
    expect(conflict.statusCode).toBe(409);
    expect(conflict.body.code).toBe("project_template_in_use");
  });

  it("rejects stale template revisions", async () => {
    const template = await createProjectTemplate();
    const first = await request<ProjectTemplate>(
      "PATCH",
      `/api/v1/project-templates/${template.id}`,
      { name: "Revision two", expectedRevision: template.revision },
    );
    expect(first.statusCode).toBe(200);
    expect(first.body.revision).toBe(2);
    const stale = await request<ApiErrorBody>(
      "PATCH",
      `/api/v1/project-templates/${template.id}`,
      { name: "Stale revision", expectedRevision: 1 },
    );
    expect(stale.statusCode).toBe(409);
    expect(stale.body.code).toBe("template_revision_conflict");
  });

  it("materializes an empty template with only the owner rule", async () => {
    const template = await createProjectTemplate();
    const project = await materialize(
      template.id,
      "local-admin",
      `empty-${randomUUID()}`,
    );
    expect(project.statusCode).toBe(201);
    const projectId = (project.body as Project).id;
    const roles = await request<{ items: ProjectRole[] }>(
      "GET",
      `/api/v1/projects/${projectId}/roles`,
    );
    expect(roles.body.items).toHaveLength(1);
    expect(roles.body.items[0]).toMatchObject({
      code: "PROJECT_OWNER",
      name: "项目负责人",
    });
    const members = await request<{ items: ProjectMember[] }>(
      "GET",
      `/api/v1/projects/${projectId}/members`,
    );
    expect(members.body.items).toHaveLength(1);
    expect(members.body.items[0]).toMatchObject({
      actorId: "local-admin",
      owner: true,
    });
    expect(members.body.items[0]?.roles[0]?.code).toBe("PROJECT_OWNER");
    const workflows = await request<{ items: WorkflowDefinition[] }>(
      "GET",
      `/api/v1/workflows?projectId=${projectId}`,
    );
    expect(workflows.body.items).toHaveLength(0);
  });

  it("keeps legacy project creation compatible with migration 18", async () => {
    const result = await request<Project>("POST", "/api/v1/projects", {
      name: `Legacy-compatible ${randomUUID().slice(0, 8)}`,
      description: "No template",
    });
    expect(result.statusCode).toBe(201);
    expect(result.body.sourceTemplateId).toBeNull();
    expect(result.body.sourceTemplateRevision).toBeNull();
    const roles = await request<{ items: ProjectRole[] }>(
      "GET",
      `/api/v1/projects/${result.body.id}/roles`,
    );
    expect(roles.body.items[0]).toMatchObject({
      code: "PROJECT_OWNER",
      category: "management",
    });
  });
});
