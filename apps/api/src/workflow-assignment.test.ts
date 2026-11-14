import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  Agent,
  Project,
  ProjectMember,
  ProjectRole,
  TaskClaim,
  WorkflowDefinition,
  WorkflowInstance,
  WorkflowInstanceBindings,
  WorkflowInstancePreflight,
} from "@pluginmax/contracts";
import {
  Database,
  LATEST_MIGRATION_VERSION,
  PlatformRepositories,
  migrate,
} from "@pluginmax/database";
import { buildApi } from "./app.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl === undefined ? describe.skip : describe;

integration("M2 workflow scope, assignments and preflight", () => {
  let database: Database;
  let repositories: PlatformRepositories;
  let app: ReturnType<typeof buildApi>["app"];

  beforeAll(async () => {
    database = new Database(databaseUrl!);
    await migrate(database);
    repositories = new PlatformRepositories(database);
    const fileStoreRoot = await mkdtemp(
      join(tmpdir(), "pluginmax-m2-workflow-files-"),
    );
    const built = buildApi({
      databaseUrl: databaseUrl!,
      database,
      fileStoreRoot,
      logger: false,
      localActorId: "local-admin",
      expectedMigrationVersion: LATEST_MIGRATION_VERSION,
    });
    app = built.app;
    await app.ready();
    await setWorkflowFlags(true);
  });

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  async function request<T>(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    url: string,
    payload?: unknown,
    actorId = "local-admin",
  ): Promise<{ statusCode: number; body: T }> {
    const headers: Record<string, string> = {
      "x-pluginmax-actor": actorId,
    };
    const options: InjectOptions = { method, url, headers };
    if (payload !== undefined) {
      options.payload = payload as Record<string, unknown>;
    }
    const response = await app.inject(options);
    const text = response.body;
    return {
      statusCode: response.statusCode,
      body: (text === "" ? undefined : response.json()) as T,
    };
  }

  async function setWorkflowFlags(enabled: boolean): Promise<void> {
    for (const flagKey of [
      "workflow.assignment_bindings",
      "workflow.platform_templates",
    ]) {
      await repositories.featureFlags.set({
        flagKey,
        scopeType: "platform",
        scopeId: "platform",
        mode: enabled ? "on" : "off",
        updatedBy: "m2-test",
      });
    }
  }

  async function createProject(label: string): Promise<Project> {
    const response = await request<Project>("POST", "/api/v1/projects", {
      name: `${label} ${randomUUID().slice(0, 8)}`,
      description: "M2 workflow assignment fixture",
    });
    expect(response.statusCode, JSON.stringify(response.body)).toBe(201);
    return response.body;
  }

  async function createRole(
    projectId: string,
    label: string,
    code: string,
    permissions: string[] = ["read", "write"],
  ): Promise<ProjectRole> {
    const response = await request<ProjectRole>(
      "POST",
      `/api/v1/projects/${projectId}/roles`,
      {
        code,
        name: `${label} ${randomUUID().slice(0, 5)}`,
        description: "M2 workflow role",
        permissions,
      },
    );
    expect(response.statusCode, JSON.stringify(response.body)).toBe(201);
    return response.body;
  }

  async function addHuman(
    projectId: string,
    actorId: string,
    roleIds: string[],
  ): Promise<ProjectMember> {
    await request(
      "GET",
      "/api/v1/workflows/platform-templates",
      undefined,
      actorId,
    );
    const response = await request<ProjectMember>(
      "POST",
      `/api/v1/projects/${projectId}/members`,
      {
        kind: "human",
        actorId,
        name: actorId,
        responsibility: "M2 workflow member",
        roleIds,
      },
    );
    expect(response.statusCode, JSON.stringify(response.body)).toBe(201);
    return response.body;
  }

  async function createAgent(label: string): Promise<Agent> {
    const response = await request<Agent>("POST", "/api/v1/agents", {
      name: `${label} ${randomUUID().slice(0, 8)}`,
      runtimeKind: "fake",
    });
    expect(response.statusCode, JSON.stringify(response.body)).toBe(201);
    return response.body;
  }

  async function addAgent(
    projectId: string,
    agentId: string,
    roleIds: string[],
  ): Promise<ProjectMember> {
    const response = await request<ProjectMember>(
      "POST",
      `/api/v1/projects/${projectId}/members`,
      {
        kind: "agent",
        agentId,
        responsibility: "M2 workflow AI member",
        roleIds,
      },
    );
    expect(response.statusCode, JSON.stringify(response.body)).toBe(201);
    return response.body;
  }

  async function importWorkflow(input: {
    projectId: string;
    roleCode?: string;
    nodeType?: "task" | "approval";
  }): Promise<WorkflowDefinition> {
    const role = input.roleCode ?? "DELIVERY_LEAD";
    const nodeType = input.nodeType ?? "task";
    const reviewer =
      nodeType === "approval"
        ? `
### Review

- id: review
- type: approval
- executor: user:local-admin
- approver: user:local-admin
- policy: all
`
        : "";
    const execution =
      nodeType === "task"
        ? `
- execution: task-worker
- trigger: auto-on-ready
`
        : "";
    const response = await request<WorkflowDefinition>(
      "POST",
      "/api/v1/workflows/import",
      {
        projectId: input.projectId,
        markdown: `# 工作流：M2 ${randomUUID().slice(0, 8)}

## 元信息

- key: m2-${randomUUID()}
- version: 1
- description: M2 assignment fixture

## 节点

### Execute

- id: execute
- type: ${nodeType}
- executor: role:${role}
${execution}${reviewer}

## 连接
`,
      },
    );
    expect(response.statusCode, JSON.stringify(response.body)).toBe(201);
    return response.body;
  }

  async function publish(workflowId: string): Promise<WorkflowDefinition> {
    const response = await request<WorkflowDefinition>(
      "POST",
      `/api/v1/workflows/${workflowId}/publish`,
    );
    expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
    expect(response.body.scope).toBe("platform");
    expect(response.body.publishedAt).not.toBeNull();
    return response.body;
  }

  async function counts(): Promise<{
    instances: number;
    tasks: number;
    runs: number;
    assignments: number;
  }> {
    const result = await database.query<{
      instances: string;
      tasks: string;
      runs: string;
      assignments: string;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM workflow_instances) AS instances,
         (SELECT COUNT(*) FROM tasks) AS tasks,
         (SELECT COUNT(*) FROM runs) AS runs,
         (SELECT COUNT(*) FROM workflow_instance_assignments) AS assignments`,
    );
    const row = result.rows[0]!;
    return {
      instances: Number(row.instances),
      tasks: Number(row.tasks),
      runs: Number(row.runs),
      assignments: Number(row.assignments),
    };
  }

  it("separates platform template read, manage and instantiate authorization", async () => {
    const ownerProject = await createProject("M2 owner");
    const ownerRole = await createRole(
      ownerProject.id,
      "Owner delivery",
      "DELIVERY_LEAD",
    );
    const ownerMemberActor = `owner-member-${randomUUID().slice(0, 8)}`;
    const ownerMember = await addHuman(ownerProject.id, ownerMemberActor, [
      ownerRole.id,
    ]);
    const workflow = await importWorkflow({ projectId: ownerProject.id });
    await publish(workflow.id);
    const legacyList = await request<{ items: WorkflowDefinition[] }>(
      "GET",
      `/api/v1/workflows?projectId=${ownerProject.id}`,
      undefined,
      ownerMemberActor,
    );
    expect(legacyList.statusCode, JSON.stringify(legacyList.body)).toBe(200);
    expect(legacyList.body.items.map((item) => item.id)).not.toContain(
      workflow.id,
    );

    const consumerProject = await createProject("M2 consumer");
    const consumerRole = await createRole(
      consumerProject.id,
      "Consumer delivery",
      "DELIVERY_LEAD",
    );
    const consumerActor = `consumer-${randomUUID().slice(0, 8)}`;
    await addHuman(consumerProject.id, consumerActor, [consumerRole.id]);

    const readable = await request<{ items: WorkflowDefinition[] }>(
      "GET",
      "/api/v1/workflows/platform-templates",
      undefined,
      consumerActor,
    );
    expect(readable.statusCode, JSON.stringify(readable.body)).toBe(200);
    expect(readable.body.items.map((item) => item.id)).toContain(workflow.id);

    const consumerEdit = await request(
      "PATCH",
      `/api/v1/workflows/${workflow.id}`,
      {
        description: "non-owner edit",
        expectedRevision: workflow.revision,
      },
      consumerActor,
    );
    expect(consumerEdit.statusCode).toBe(403);
    const consumerUnpublish = await request(
      "POST",
      `/api/v1/workflows/${workflow.id}/unpublish`,
      undefined,
      consumerActor,
    );
    expect(consumerUnpublish.statusCode).toBe(403);

    const ownerEdit = await request(
      "PATCH",
      `/api/v1/workflows/${workflow.id}`,
      {
        description: "owner project ordinary edit",
        expectedRevision: workflow.revision,
      },
      ownerMemberActor,
    );
    expect(ownerEdit.statusCode).toBe(403);
    const ownerUnpublish = await request(
      "POST",
      `/api/v1/workflows/${workflow.id}/unpublish`,
      undefined,
      ownerMemberActor,
    );
    expect(ownerUnpublish.statusCode).toBe(403);

    const noWriteRole = await createRole(
      consumerProject.id,
      "Read only",
      "READ_ONLY",
      ["read"],
    );
    const noWriteActor = `reader-${randomUUID().slice(0, 8)}`;
    await addHuman(consumerProject.id, noWriteActor, [noWriteRole.id]);
    const noWritePreflight = await request<WorkflowInstancePreflight>(
      "POST",
      `/api/v1/workflows/${workflow.id}/instances/preflight`,
      {
        projectId: consumerProject.id,
        title: "No write preflight",
        context: {},
      },
      noWriteActor,
    );
    expect(noWritePreflight.statusCode).toBe(200);
    expect(noWritePreflight.body.canStart).toBe(false);
    expect(
      noWritePreflight.body.blockingRisks.map((item) => item.code),
    ).toContain("workflow_target_project_write_required");
    const noWriteStart = await request(
      "POST",
      `/api/v1/workflows/${workflow.id}/start`,
      {
        projectId: consumerProject.id,
        title: "No write start",
        context: {},
      },
      noWriteActor,
    );
    expect(noWriteStart.statusCode).toBe(403);

    const grant = await request(
      "POST",
      "/api/v1/admin/platform-grants",
      {
        principalId: ownerMember.principalId ?? ownerMemberActor,
        roleKey: "MEMBER",
        permissions: ["manage_workflow_templates"],
      },
    );
    expect(grant.statusCode, JSON.stringify(grant.body)).toBe(201);
    const managed = await request<WorkflowDefinition>(
      "POST",
      `/api/v1/workflows/${workflow.id}/unpublish`,
      undefined,
      ownerMemberActor,
    );
    expect(managed.statusCode, JSON.stringify(managed.body)).toBe(200);
    expect(managed.body.status).toBe("archived");
  });

  it("blocks unresolved required role slots without creating instance side effects", async () => {
    const ownerProject = await createProject("M2 unresolved owner");
    await createRole(ownerProject.id, "Owner role", "MISSING_ROLE");
    const workflow = await importWorkflow({
      projectId: ownerProject.id,
      roleCode: "MISSING_ROLE",
    });
    await publish(workflow.id);
    const targetProject = await createProject("M2 unresolved target");
    const before = await counts();

    const preflight = await request<WorkflowInstancePreflight>(
      "POST",
      `/api/v1/workflows/${workflow.id}/instances/preflight`,
      {
        projectId: targetProject.id,
        title: "Unresolved role",
        context: {},
      },
    );
    expect(preflight.statusCode, JSON.stringify(preflight.body)).toBe(200);
    expect(preflight.body.canStart).toBe(false);
    expect(
      preflight.body.nodes.find((node) => node.nodeId === "execute")
        ?.blockingRisks.map((item) => item.code),
    ).toContain("role_slot_unresolved");
    const afterPreflight = await counts();
    expect(afterPreflight).toEqual(before);

    const start = await request(
      "POST",
      `/api/v1/workflows/${workflow.id}/start`,
      {
        projectId: targetProject.id,
        title: "Unresolved role start",
        context: {},
      },
    );
    expect(start.statusCode).toBe(409);
    expect(await counts()).toEqual(before);
  });

  it("enforces assigned primary uniqueness and keeps instance graph snapshots immutable", async () => {
    const project = await createProject("M2 assigned");
    const role = await createRole(project.id, "Assigned role", "ASSIGNED_ROLE");
    const agent = await createAgent("M2 assigned agent");
    const member = await addAgent(project.id, agent.id, [role.id]);
    const principalId = member.principalId ?? member.actorId;
    const workflow = await importWorkflow({
      projectId: project.id,
      roleCode: "ASSIGNED_ROLE",
    });
    const preset = await request<{
      revision: number;
      assignees: string[];
    }>("POST", `/api/v1/projects/${project.id}/role-mapping-presets`, {
      roleId: role.id,
      assignees: [principalId],
    });
    expect(preset.statusCode, JSON.stringify(preset.body)).toBe(201);
    expect(preset.body).toMatchObject({
      revision: 1,
      assignees: [principalId],
    });
    const revisedPreset = await request<{ revision: number }>(
      "POST",
      `/api/v1/projects/${project.id}/role-mapping-presets`,
      {
        roleId: role.id,
        assignees: [principalId],
        expectedRevision: 1,
      },
    );
    expect(revisedPreset.statusCode, JSON.stringify(revisedPreset.body)).toBe(
      201,
    );
    expect(revisedPreset.body.revision).toBe(2);

    const start = await request<WorkflowInstance>(
      "POST",
      `/api/v1/workflows/${workflow.id}/start`,
      {
        title: "Assigned workflow",
        context: {},
        bindingOverrides: [
          {
            nodeId: "execute",
            dispatchMode: "assigned",
            primaryPrincipalId: principalId,
            candidatePrincipalIds: [principalId],
            approverPrincipalIds: [],
            sourceChangeReason: "assigned fixture",
          },
        ],
      },
    );
    expect(start.statusCode, JSON.stringify(start.body)).toBe(201);
    const bindings = await request<WorkflowInstanceBindings>(
      "GET",
      `/api/v1/workflow-instances/${start.body.id}/bindings`,
    );
    expect(bindings.statusCode).toBe(200);
    expect(bindings.body.assignments).toHaveLength(1);
    expect(bindings.body.assignments[0]).toMatchObject({
      dispatchMode: "assigned",
      status: "overridden",
      primaryPrincipalId: principalId,
    });

    const duplicate = database.query(
      `INSERT INTO workflow_instance_assignments (
         id, instance_id, node_id, source_kind, source_id, dispatch_mode,
         status, primary_principal_id, candidate_pool, resolved_by,
         resolved_at, source_change_reason, revision, created_at, updated_at
       ) VALUES (
         $1, $2, 'execute', 'role', 'duplicate', 'assigned',
         'resolved', $3, '[]'::jsonb, 'test', NOW(), '', 1, NOW(), NOW()
       )`,
      [randomUUID(), start.body.id, principalId],
    );
    await expect(duplicate).rejects.toThrow();

    await database.query(
      `UPDATE workflow_definitions
       SET graph = jsonb_set(graph, '{description}', '"mutated after start"'),
           updated_at = NOW()
       WHERE id = $1`,
      [workflow.id],
    );
    const instance = await request<WorkflowInstance>(
      "GET",
      `/api/v1/workflow-instances/${start.body.id}`,
    );
    expect(instance.statusCode).toBe(200);
    expect(instance.body.graph?.description).toBe("M2 assignment fixture");
  });

  it("allows only one concurrent claim from the workflow candidate pool", async () => {
    const project = await createProject("M2 claim");
    const role = await createRole(project.id, "Claim role", "CLAIM_ROLE");
    const claimantA = `claim-a-${randomUUID().slice(0, 8)}`;
    const claimantB = `claim-b-${randomUUID().slice(0, 8)}`;
    const memberA = await addHuman(project.id, claimantA, [role.id]);
    const memberB = await addHuman(project.id, claimantB, [role.id]);
    const agent = await createAgent("M2 claim agent");
    await addAgent(project.id, agent.id, [role.id]);
    const workflow = await importWorkflow({
      projectId: project.id,
      roleCode: "CLAIM_ROLE",
    });
    const started = await request<WorkflowInstance>(
      "POST",
      `/api/v1/workflows/${workflow.id}/start`,
      { title: "Claim workflow", context: {} },
    );
    expect(started.statusCode, JSON.stringify(started.body)).toBe(201);
    const taskId = started.body.runtime.nodes.find(
      (node) => node.nodeId === "execute",
    )?.taskId;
    expect(taskId).toBeTruthy();

    const [first, second] = await Promise.all([
      request<TaskClaim>(
        "POST",
        `/api/v1/projects/${project.id}/task-queue/claim`,
        {
          ownerId: memberA.principalId ?? memberA.actorId,
          leaseSeconds: 60,
        },
      ),
      request<TaskClaim>(
        "POST",
        `/api/v1/projects/${project.id}/task-queue/claim`,
        {
          ownerId: memberB.principalId ?? memberB.actorId,
          leaseSeconds: 60,
        },
      ),
    ]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 204]);
    const winner = first.statusCode === 200 ? first : second;
    expect(winner.body.task.id).toBe(taskId);
  });

  it("blocks new instances and bindings while the assignment flag is off", async () => {
    await setWorkflowFlags(false);
    const project = await createProject("M2 flag off");
    const role = await createRole(project.id, "Flag role", "FLAG_ROLE");
    const agent = await createAgent("M2 flag agent");
    await addAgent(project.id, agent.id, [role.id]);
    const workflow = await importWorkflow({
      projectId: project.id,
      roleCode: "FLAG_ROLE",
    });
    const before = await counts();
    const preflight = await request<WorkflowInstancePreflight>(
      "POST",
      `/api/v1/workflows/${workflow.id}/instances/preflight`,
      { title: "Flag off", context: {} },
    );
    expect(preflight.statusCode).toBe(200);
    expect(preflight.body.canStart).toBe(false);
    expect(
      preflight.body.blockingRisks.map((item) => item.code),
    ).toContain("workflow_assignment_bindings_disabled");
    const start = await request(
      "POST",
      `/api/v1/workflows/${workflow.id}/start`,
      { title: "Flag off start", context: {} },
    );
    expect(start.statusCode).toBe(409);
    expect(await counts()).toEqual(before);
    await setWorkflowFlags(true);
  });
});
