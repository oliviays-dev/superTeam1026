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
  RouterAgent,
  RouterFeatureGate,
  Task,
  Teammate,
  TeammateTemplate,
  WorkflowGraph,
  WorkflowPlanDetail,
  WorkflowPlanDiff,
  WorkflowPlanSettings,
} from "@pluginmax/contracts";
import { planCreationKey } from "@pluginmax/contracts";
import {
  Database,
  LATEST_MIGRATION_VERSION,
  PlatformRepositories,
  migrate,
} from "@pluginmax/database";
import { buildApi } from "./app.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl === undefined ? describe.skip : describe;
const settings: WorkflowPlanSettings = {
  maxNodes: 20,
  maxDepth: 10,
  maxOutDegree: 6,
  maxConcurrency: 4,
};

integration("M3 Router dynamic plans and materialization", () => {
  let database: Database;
  let repositories: PlatformRepositories;
  let app: ReturnType<typeof buildApi>["app"];
  let project: Project;
  let role: ProjectRole;
  let agent: Agent;
  let routerAgent: RouterAgent;
  let routerTemplate: TeammateTemplate;
  let rootTask: Task;

  beforeAll(async () => {
    database = new Database(databaseUrl!);
    await migrate(database);
    repositories = new PlatformRepositories(database);
    const fileStoreRoot = await mkdtemp(
      join(tmpdir(), "pluginmax-m3-plan-files-"),
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

    project = await createProject("M3 plan integration");
    role = await createRole(project.id, "DELIVERY_LEAD");
    agent = await createAgent("M3 worker");
    await addAgent(project.id, agent.id, [role.id]);
    routerTemplate = await request<TeammateTemplate>(
      "POST",
      `/api/v1/projects/${project.id}/router-template`,
      { name: "Protected Router Agent" },
      201,
    );
    const teammate = await request<Teammate>(
      "POST",
      "/api/v1/teammates",
      {
        projectId: project.id,
        templateId: routerTemplate.id,
        name: "M3 Router",
        agentId: agent.id,
        autoExecute: true,
      },
      201,
    );
    routerAgent = await request<RouterAgent>(
      "POST",
      `/api/v1/projects/${project.id}/router-agents`,
      { teammateId: teammate.id },
      201,
    );
    const gate = await request<RouterFeatureGate>(
      "GET",
      `/api/v1/projects/${project.id}/router-gate`,
    );
    await request<RouterFeatureGate>(
      "PUT",
      `/api/v1/projects/${project.id}/router-gate`,
      {
        enabled: true,
        expectedEpoch: gate.epoch,
        reason: "M3 integration",
      },
    );
    rootTask = await createRootTask("M3 root");
  });

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  async function request<T>(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    url: string,
    payload?: unknown,
    expectedStatus?: number,
    actorId = "local-admin",
  ): Promise<T> {
    const options: InjectOptions = {
      method,
      url,
      headers: { "x-pluginmax-actor": actorId },
    };
    if (payload !== undefined) {
      options.payload = payload as Record<string, unknown>;
    }
    const response = await app.inject(options);
    const body =
      response.body === "" ? undefined : (response.json() as unknown);
    if (expectedStatus !== undefined) {
      expect(response.statusCode, JSON.stringify(body)).toBe(expectedStatus);
    } else {
      expect(
        response.statusCode,
        `${method} ${url}: ${JSON.stringify(body)}`,
      ).toBeLessThan(400);
    }
    return body as T;
  }

  async function createProject(name: string): Promise<Project> {
    return request<Project>(
      "POST",
      "/api/v1/projects",
      { name: `${name} ${randomUUID().slice(0, 8)}`, description: "" },
      201,
    );
  }

  async function createRole(
    projectId: string,
    code: string,
  ): Promise<ProjectRole> {
    return request<ProjectRole>(
      "POST",
      `/api/v1/projects/${projectId}/roles`,
      {
        code,
        name: `${code} ${randomUUID().slice(0, 5)}`,
        description: "M3 plan role",
        permissions: ["read", "write"],
      },
      201,
    );
  }

  async function createAgent(name: string): Promise<Agent> {
    return request<Agent>(
      "POST",
      "/api/v1/agents",
      { name: `${name} ${randomUUID().slice(0, 8)}`, runtimeKind: "fake" },
      201,
    );
  }

  async function addAgent(
    projectId: string,
    agentId: string,
    roleIds: string[],
  ): Promise<ProjectMember> {
    return request<ProjectMember>(
      "POST",
      `/api/v1/projects/${projectId}/members`,
      {
        kind: "agent",
        agentId,
        responsibility: "M3 plan worker",
        roleIds,
      },
      201,
    );
  }

  async function createRootTask(title: string): Promise<Task> {
    return request<Task>(
      "POST",
      "/api/v1/tasks",
      {
        projectId: project.id,
        title: `${title} ${randomUUID().slice(0, 6)}`,
        description: "M3 root business task",
        acceptance: ["Root remains business-owned"],
        agentId: agent.id,
      },
      201,
    );
  }

  function planNode(
    id: string,
    start = false,
    description = `${id} description`,
  ): WorkflowGraph["nodes"][number] {
    return {
      id,
      name: id,
      type: "task",
      executor: { kind: "agent", id: agent.id },
      description,
      acceptance: [`${id} accepted`],
      approvers: [],
      approvalPolicy: "all",
      autoDispatch: true,
      start,
      maxAttempts: 1,
      timeoutSeconds: 300,
    };
  }

  function planGraph(
    nodes: WorkflowGraph["nodes"] = [
      planNode("a", true),
      planNode("b"),
      planNode("c"),
    ],
    edges: WorkflowGraph["edges"] = [
      { id: "ab", from: "a", to: "b" },
      { id: "ac", from: "a", to: "c" },
      { id: "bc", from: "b", to: "c" },
    ],
  ): WorkflowGraph {
    return {
      key: "user-supplied-key-is-normalized",
      version: 7,
      name: `M3 graph ${randomUUID().slice(0, 6)}`,
      description: "M3 dynamic plan",
      nodes,
      edges,
      startNodeIds: nodes.some((node) => node.start)
        ? []
        : nodes[0] === undefined
          ? []
          : [nodes[0].id],
      warnings: [],
    };
  }

  async function createPlan(input?: {
    source?: "manual" | "template" | "router";
    graph?: WorkflowGraph;
    routerAgentId?: string | null;
  }): Promise<WorkflowPlanDetail> {
    const source = input?.source ?? "router";
    return request<WorkflowPlanDetail>(
      "POST",
      `/api/v1/tasks/${rootTask.id}/plans`,
      {
        rootTaskId: rootTask.id,
        source,
        graph: input?.graph ?? planGraph(),
        settings,
        reason: "M3 materialization fixture",
        ...(source === "router"
          ? { routerAgentId: input?.routerAgentId ?? routerAgent.id }
          : {}),
      },
      201,
    );
  }

  async function approveAndMaterialize(
    detail: WorkflowPlanDetail,
  ): Promise<WorkflowPlanDetail> {
    const approved = await request<WorkflowPlanDetail>(
      "POST",
      `/api/v1/task-plans/${detail.plan.id}/approve`,
      {
        expectedRevision: detail.plan.revision,
        expectedGateEpoch: detail.plan.gateEpoch ?? undefined,
        role: "DELIVERY_LEAD",
      },
    );
    const gate = await request<RouterFeatureGate>(
      "GET",
      `/api/v1/projects/${project.id}/router-gate`,
    );
    return request<WorkflowPlanDetail>(
      "POST",
      `/api/v1/task-plans/${detail.plan.id}/materialize`,
      {
        expectedRevision: approved.plan.revision,
        expectedGateEpoch: gate.epoch,
      },
    );
  }

  it("G9 materializes each node once under concurrent approve/materialize", async () => {
    const created = await createPlan();
    const approvals = await Promise.all([
      request<WorkflowPlanDetail>(
        "POST",
        `/api/v1/task-plans/${created.plan.id}/approve`,
        {
          expectedRevision: created.plan.revision,
          role: "DELIVERY_LEAD",
        },
      ),
      request<WorkflowPlanDetail>(
        "POST",
        `/api/v1/task-plans/${created.plan.id}/approve`,
        {
          expectedRevision: created.plan.revision,
          role: "DELIVERY_LEAD",
        },
      ),
    ]);
    const approved = approvals[0]!;
    const gate = await request<RouterFeatureGate>(
      "GET",
      `/api/v1/projects/${project.id}/router-gate`,
    );
    const materialized = await Promise.all([
      request<WorkflowPlanDetail>(
        "POST",
        `/api/v1/task-plans/${created.plan.id}/materialize`,
        {
          expectedRevision: approved.plan.revision,
          expectedGateEpoch: gate.epoch,
        },
      ),
      request<WorkflowPlanDetail>(
        "POST",
        `/api/v1/task-plans/${created.plan.id}/materialize`,
        {
          expectedRevision: approved.plan.revision,
          expectedGateEpoch: gate.epoch,
        },
      ),
    ]);
    const detail = materialized[0]!;
    expect(detail.materializations).toHaveLength(3);
    expect(new Set(detail.materializations.map((item) => item.nodeId)).size).toBe(
      3,
    );
    expect(
      detail.materializations.every(
        (item) => item.status === "materialized" && item.taskId !== null,
      ),
    ).toBe(true);
    const taskCount = await database.query<{ count: number }>(
      `SELECT COUNT(*)::integer AS count
       FROM task_origins
       WHERE source_id = $1 AND source_kind = 'router'`,
      [created.plan.id],
    );
    expect(taskCount.rows[0]?.count).toBe(3);
    const ledgerCount = await database.query<{ count: number }>(
      `SELECT COUNT(*)::integer AS count
       FROM plan_materializations
       WHERE plan_id = $1 AND plan_version = $2`,
      [created.plan.id, created.plan.currentVersion],
    );
    expect(ledgerCount.rows[0]?.count).toBe(3);
    const keys = detail.materializations.map((item) => item.creationKey);
    expect(keys.sort()).toEqual(
      ["a", "b", "c"]
        .map((nodeId) =>
          planCreationKey(created.plan.id, created.plan.currentVersion, nodeId),
        )
        .sort(),
    );
    expect(
      detail.plan.workflowInstanceId,
      "approved plan must reuse a Workflow Instance",
    ).not.toBeNull();
    const instance = await repositories.workflowRuntime.get(
      detail.plan.workflowInstanceId!,
    );
    expect(instance?.graph).toEqual(detail.version.graph);
    await database.query(
      `UPDATE tasks
       SET status = 'done', revision = revision + 1, updated_at = NOW()
       WHERE id IN (
         SELECT task_id
         FROM plan_materializations
         WHERE plan_id = $1 AND plan_version = $2
       )`,
      [created.plan.id, created.plan.currentVersion],
    );
    const fin = await Promise.all([
      request<WorkflowPlanDetail>(
        "POST",
        `/api/v1/task-plans/${created.plan.id}/finalize`,
        {
          expectedRevision: detail.plan.revision,
          expectedGateEpoch: gate.epoch,
        },
      ),
      request<WorkflowPlanDetail>(
        "POST",
        `/api/v1/task-plans/${created.plan.id}/finalize`,
        {
          expectedRevision: detail.plan.revision,
          expectedGateEpoch: gate.epoch,
        },
      ),
    ]);
    expect(fin.every((item) => item.plan.status === "completed")).toBe(true);
    const finalMessages = await database.query<{ count: number }>(
      `SELECT COUNT(*)::integer AS count
       FROM workflow_plan_outbox_messages
       WHERE plan_id = $1 AND kind = 'final_draft'`,
      [created.plan.id],
    );
    expect(finalMessages.rows[0]?.count).toBe(1);
  });

  it("G10 repairs a Task created before its origin without duplicating the Task", async () => {
    const created = await createPlan({ source: "manual" });
    const approved = await request<WorkflowPlanDetail>(
      "POST",
      `/api/v1/task-plans/${created.plan.id}/approve`,
      {
        expectedRevision: created.plan.revision,
        role: "DELIVERY_LEAD",
      },
    );
    const creationKey = planCreationKey(
      created.plan.id,
      created.plan.currentVersion,
      "a",
    );
    const orphanTaskId = randomUUID();
    await database.query(
      `INSERT INTO tasks (
         id, project_id, title, description, acceptance, status, agent_id,
         priority, auto_submit, auto_accept, auto_redispatch_on_return,
         creation_key, created_at, updated_at
       ) VALUES (
         $1, $2, 'orphan plan task', 'created before origin', $3::jsonb,
         'queued', $4, 'medium', TRUE, FALSE, FALSE, $5, NOW(), NOW()
       )`,
      [
        orphanTaskId,
        project.id,
        JSON.stringify(["orphan accepted"]),
        agent.id,
        creationKey,
      ],
    );
    const gate = await request<RouterFeatureGate>(
      "GET",
      `/api/v1/projects/${project.id}/router-gate`,
    );
    await request<WorkflowPlanDetail>(
      "POST",
      `/api/v1/task-plans/${created.plan.id}/materialize`,
      {
        expectedRevision: approved.plan.revision,
        expectedGateEpoch: gate.epoch,
      },
    );
    const taskCount = await database.query<{ count: number }>(
      "SELECT COUNT(*)::integer AS count FROM tasks WHERE creation_key = $1",
      [creationKey],
    );
    const originCount = await database.query<{ count: number }>(
      `SELECT COUNT(*)::integer AS count
       FROM task_origins
       WHERE task_id = $1 AND idempotency_key = $2`,
      [orphanTaskId, creationKey],
    );
    expect(taskCount.rows[0]?.count).toBe(1);
    expect(originCount.rows[0]?.count).toBe(1);
  });

  it("rejects an invalid DAG before confirmation", async () => {
    const cyclic = planGraph(
      [planNode("a", true), planNode("b")],
      [
        { id: "ab", from: "a", to: "b" },
        { id: "ba", from: "b", to: "a" },
      ],
    );
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${rootTask.id}/plans`,
      headers: { "x-pluginmax-actor": "local-admin" },
      payload: {
        rootTaskId: rootTask.id,
        source: "manual",
        graph: cyclic,
        settings,
        reason: "invalid",
      },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe("workflow_plan_graph_invalid");
    expect(
      response
        .json()
        .details.issues.some(
          (issue: { code: string }) => issue.code === "cycle_detected",
        ),
    ).toBe(true);
  });

  it("freezes plan versions and returns a graph diff", async () => {
    const created = await createPlan({ source: "manual" });
    const nextGraph = planGraph([
      planNode("a", true),
      planNode("b", false, "changed b"),
      planNode("c"),
    ]);
    const updated = await request<WorkflowPlanDetail>(
      "POST",
      `/api/v1/task-plans/${created.plan.id}/versions`,
      {
        expectedRevision: created.plan.revision,
        graph: nextGraph,
        settings,
        reason: "immutable version fixture",
      },
      201,
    );
    expect(updated.plan.currentVersion).toBe(2);
    expect(updated.version.version).toBe(2);
    await expect(
      database.query(
        `UPDATE workflow_plan_versions
         SET reason = 'tampered'
         WHERE plan_id = $1 AND version = 1`,
        [created.plan.id],
      ),
    ).rejects.toThrow(/immutable/);
    const diff = await request<WorkflowPlanDiff>(
      "GET",
      `/api/v1/task-plans/${created.plan.id}/versions/2/diff?from=1&to=2`,
    );
    expect(diff.nodes.map((node) => node.nodeId)).toContain("b");
  });

  it("projects manual, template and router plans through the same Workflow Graph", async () => {
    const manual = await approveAndMaterialize(
      await createPlan({ source: "manual" }),
    );
    const template = await approveAndMaterialize(
      await createPlan({ source: "template" }),
    );
    const instances = await Promise.all(
      [manual, template].map(async (detail) => {
        expect(detail.plan.workflowInstanceId).not.toBeNull();
        return repositories.workflowRuntime.get(
          detail.plan.workflowInstanceId!,
        );
      }),
    );
    for (const [index, instance] of instances.entries()) {
      const detail = [manual, template][index]!;
      expect(instance).toBeDefined();
      expect(instance?.workflowId).toBe(detail.plan.workflowDefinitionId);
      expect(instance?.graph).toEqual(detail.version.graph);
    }
  });

  it("rejects ordinary Agents and unprotected Teammate Templates as Router Agents", async () => {
    const ordinaryAgent = await createAgent("M3 ordinary");
    await addAgent(project.id, ordinaryAgent.id, [role.id]);
    const ordinaryTemplate = await request<TeammateTemplate>(
      "POST",
      "/api/v1/teammate-templates",
      {
        projectId: project.id,
        scope: "personal",
        definition: {
          name: `Ordinary ${randomUUID().slice(0, 6)}`,
          role: "ordinary",
          description: "not a router",
          soul: "",
          scenarios: [],
          goals: [],
          tools: [],
        },
      },
      201,
    );
    const ordinaryTeammate = await request<Teammate>(
      "POST",
      "/api/v1/teammates",
      {
        projectId: project.id,
        templateId: ordinaryTemplate.id,
        agentId: ordinaryAgent.id,
        autoExecute: false,
      },
      201,
    );
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/router-agents`,
      headers: { "x-pluginmax-actor": "local-admin" },
      payload: { teammateId: ordinaryTeammate.id },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe(
      "router_agent_template_not_protected",
    );
    const agentAsTeammate = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/router-agents`,
      headers: { "x-pluginmax-actor": "local-admin" },
      payload: { teammateId: ordinaryAgent.id },
    });
    expect(agentAsTeammate.statusCode).toBe(409);
    expect(agentAsTeammate.json().code).toBe("router_agent_not_teammate");
  });
});
