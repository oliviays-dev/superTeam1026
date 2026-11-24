import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  BusinessChainDefinitionInput,
  Project,
  ProjectAlertDetail,
  ProjectBusinessChainBinding,
  ProjectBusinessChainSettings,
  ProjectProgressOverview,
  ProjectSourceFetchResult,
  WorkflowDefinition,
} from "@pluginmax/contracts";
import {
  MockProjectSourceAdapter,
  type ProjectSourceAdapter,
  type ProjectSourceAdapterInput,
} from "@pluginmax/application";
import {
  Database,
  LATEST_MIGRATION_VERSION,
  PlatformRepositories,
  migrate,
} from "@pluginmax/database";
import { buildApi } from "./app.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl === undefined ? describe.skip : describe;

class ControlledSourceAdapter implements ProjectSourceAdapter {
  readonly kind = "controlled";
  mode: "fresh" | "stale" | "error" = "fresh";
  revision = 0;

  async inspect(
    input: ProjectSourceAdapterInput,
  ): Promise<ProjectSourceFetchResult[]> {
    this.revision += 1;
    return input.refs.map((ref) => ({
      refKey: ref.refKey,
      sourceKind: ref.sourceKind,
      sourceSystem: ref.sourceSystem,
      objectType: ref.objectType,
      objectId: ref.objectId,
      sourceRevision:
        this.mode === "error" ? null : `external-${this.revision}`,
      observedAt: input.now.toISOString(),
      effectiveAt: input.now.toISOString(),
      freshUntil: new Date(
        input.now.getTime() + (this.mode === "stale" ? -60_000 : 300_000),
      ).toISOString(),
      status: this.mode,
      payload: this.mode === "error" ? null : { amount: 120 + this.revision },
      failureReason: this.mode === "error" ? "upstream unavailable" : null,
      isMock: false,
    }));
  }
}

interface ApiEnvelope {
  readonly code: string;
  readonly message: string;
}

integration("M11 project business chain", () => {
  let database: Database;
  let repositories: PlatformRepositories;
  let app: ReturnType<typeof buildApi>["app"];
  const controlled = new ControlledSourceAdapter();

  beforeAll(async () => {
    database = new Database(databaseUrl!);
    await migrate(database);
    repositories = new PlatformRepositories(database);
    const fileStoreRoot = await mkdtemp(
      join(tmpdir(), "pluginmax-m11-business-chain-"),
    );
    const built = buildApi({
      databaseUrl: databaseUrl!,
      database,
      fileStoreRoot,
      logger: false,
      localActorId: "local-admin",
      expectedMigrationVersion: LATEST_MIGRATION_VERSION,
      projectSourceAdapters: [controlled, new MockProjectSourceAdapter()],
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
    status = 200,
  ): Promise<T> {
    const options: InjectOptions = {
      method,
      url,
      headers: { "x-pluginmax-actor": "local-admin" },
    };
    if (payload !== undefined) {
      options.payload = payload as Record<string, unknown>;
    }
    const response = await app.inject(options);
    expect(response.statusCode, response.body).toBe(status);
    return response.body === "" ? (undefined as T) : (response.json() as T);
  }

  async function createProject(label = "M11"): Promise<Project> {
    return request<Project>(
      "POST",
      "/api/v1/projects",
      {
        name: `${label} ${randomUUID().slice(0, 8)}`,
        description: "M11 business chain integration project",
      },
      201,
    );
  }

  async function enableBusinessChain(projectId: string): Promise<void> {
    const settings = await request<ProjectBusinessChainSettings>(
      "GET",
      `/api/v1/projects/${projectId}/business-chain`,
    );
    await request(
      "PATCH",
      `/api/v1/projects/${projectId}/business-chain/flags`,
      {
        businessChainEnabled: true,
        expectedBusinessChainRevision:
          settings.featureFlags.businessChain.revision,
      },
    );
  }

  async function setSourceMock(
    projectId: string,
    enabled: boolean,
  ): Promise<void> {
    const settings = await request<ProjectBusinessChainSettings>(
      "GET",
      `/api/v1/projects/${projectId}/business-chain`,
    );
    await request(
      "PATCH",
      `/api/v1/projects/${projectId}/business-chain/flags`,
      {
        sourceMockEnabled: enabled,
        expectedSourceMockRevision: settings.featureFlags.sourceMock.revision,
      },
    );
  }

  async function createWorkflow(
    projectId: string,
    name = "订单交付工作流",
  ): Promise<WorkflowDefinition> {
    return request<WorkflowDefinition>(
      "POST",
      "/api/v1/workflows",
      {
        projectId,
        name,
        description: "M11 business chain definition",
        stepNames: ["接单", "履约"],
        stepRoleIds: [],
      },
      201,
    );
  }

  function definitionInput(input: {
    readonly revision: number;
    readonly chainKey?: string;
    readonly sourceKind?: string;
    readonly objectId?: string;
  }): BusinessChainDefinitionInput {
    const chainKey = input.chainKey ?? "ORDER_DELIVERY";
    const sourceKind = input.sourceKind ?? "controlled";
    const objectId = input.objectId ?? "order-42";
    return {
      chainKey,
      templateKey: `TEMPLATE_${chainKey}`,
      displayName: "订单交付链路",
      projectTypeCodes: ["ORDER"],
      snapshotPolicy: "pin-at-project-create",
      allowUnboundSources: false,
      nodes: [
        {
          sequence: 1,
          stageCode: "ORDER",
          summaryMetric: "订单金额",
          fields: [
            {
              key: "amount",
              label: "订单金额",
              bindings: [
                {
                  refKey: `${sourceKind}:${objectId}`,
                  sourceKind,
                  sourceSystem: "erp",
                  objectType: "order",
                  objectId,
                  path: "amount",
                  required: true,
                },
              ],
            },
          ],
        },
      ],
      expectedRevision: input.revision,
    };
  }

  async function configureDefinition(
    workflow: WorkflowDefinition,
    input: BusinessChainDefinitionInput,
  ): Promise<WorkflowDefinition> {
    return request<WorkflowDefinition>(
      "POST",
      `/api/v1/workflows/${workflow.id}/business-chain`,
      input,
    );
  }

  async function bind(
    projectId: string,
    workflowDefinitionId: string,
    expectedRevision: number,
    upgrade = false,
  ): Promise<ProjectBusinessChainBinding> {
    return request<ProjectBusinessChainBinding>(
      "POST",
      `/api/v1/projects/${projectId}/business-chain/bind`,
      {
        workflowDefinitionId,
        nodeBindings: [],
        expectedRevision,
        reason: "integration binding",
        upgrade,
      },
      201,
    );
  }

  it("binds with revision CAS and rejects cross-project definition scope", async () => {
    const project = await createProject("M11 CAS");
    const otherProject = await createProject("M11 scope");
    await enableBusinessChain(project.id);
    await enableBusinessChain(otherProject.id);
    const workflow = await createWorkflow(project.id);
    expect(workflow.kind).toBe("workflow");
    const definition = await configureDefinition(
      workflow,
      definitionInput({ revision: workflow.revision }),
    );
    expect(definition.kind).toBe("business-chain");
    expect(definition.businessChainNodes).toHaveLength(1);

    const binding = await bind(project.id, definition.id, 0);
    expect(binding.revision).toBe(1);
    expect(binding.workflowDefinitionVersion).toBe(definition.revision);

    const stale = await request<ApiEnvelope>(
      "POST",
      `/api/v1/projects/${project.id}/business-chain/bind`,
      {
        workflowDefinitionId: definition.id,
        nodeBindings: [],
        expectedRevision: 0,
        reason: "stale write",
        upgrade: true,
      },
      409,
    );
    expect(stale.code).toBe("project_business_chain_revision_conflict");

    const crossProject = await request<ApiEnvelope>(
      "POST",
      `/api/v1/projects/${otherProject.id}/business-chain/bind`,
      {
        workflowDefinitionId: definition.id,
        nodeBindings: [],
        expectedRevision: 0,
        reason: "cross project",
        upgrade: false,
      },
      403,
    );
    expect(crossProject.code).toBe(
      "project_business_chain_candidate_forbidden",
    );
    await expect(
      database.query(
        "DELETE FROM project_business_chain_bindings WHERE project_id = $1",
        [project.id],
      ),
    ).rejects.toThrow(/unbound, not deleted/);
  });

  it("keeps immutable source snapshots, preserves the last valid value, and exposes stale/error coverage", async () => {
    const project = await createProject("M11 source");
    await enableBusinessChain(project.id);
    const workflow = await createWorkflow(project.id);
    const definition = await configureDefinition(
      workflow,
      definitionInput({ revision: workflow.revision }),
    );
    await bind(project.id, definition.id, 0);

    controlled.mode = "fresh";
    const fresh = await request<{
      snapshots: Array<{ id: string; version: number }>;
    }>("POST", `/api/v1/projects/${project.id}/business-chain/refresh`);
    expect(fresh.snapshots).toHaveLength(1);
    const freshVersion = fresh.snapshots[0]!.version;

    controlled.mode = "stale";
    const stale = await request<{ partial: boolean }>(
      "POST",
      `/api/v1/projects/${project.id}/business-chain/refresh`,
    );
    expect(stale.partial).toBe(true);
    const staleOverview = await request<ProjectProgressOverview>(
      "GET",
      `/api/v1/projects/${project.id}/overview`,
    );
    expect(staleOverview.coverage.status).toBe("stale");
    expect(staleOverview.coverage.sources[0]).toMatchObject({
      status: "stale",
      activeVersion: freshVersion + 1,
    });

    controlled.mode = "error";
    await request(
      "POST",
      `/api/v1/projects/${project.id}/business-chain/refresh`,
    );
    const errorOverview = await request<ProjectProgressOverview>(
      "GET",
      `/api/v1/projects/${project.id}/overview`,
    );
    expect(errorOverview.coverage.status).toBe("error");
    expect(errorOverview.coverage.sources[0]).toMatchObject({
      status: "error",
      activeVersion: freshVersion + 1,
      failureReason: "upstream unavailable",
    });
    expect(errorOverview.nodes[0]?.fields[0]?.value).toBe(122);

    const snapshotId = fresh.snapshots[0]!.id;
    await expect(
      database.query(
        "UPDATE project_source_snapshots SET status = 'fresh' WHERE id = $1",
        [snapshotId],
      ),
    ).rejects.toThrow(/immutable/);
    await expect(
      database.query("DELETE FROM project_source_snapshots WHERE id = $1", [
        snapshotId,
      ]),
    ).rejects.toThrow(/immutable/);
  });

  it("binds template-pinned definitions at project creation without silent upgrades", async () => {
    const ownerProject = await createProject("M11 template owner");
    await enableBusinessChain(ownerProject.id);
    const workflow = await createWorkflow(ownerProject.id, "模板链路工作流");
    const definition = await configureDefinition(
      workflow,
      definitionInput({
        revision: workflow.revision,
        chainKey: "TEMPLATE_DELIVERY",
      }),
    );
    await repositories.featureFlags.set({
      flagKey: "workflow.platform_templates",
      scopeType: "platform",
      scopeId: "platform",
      mode: "on",
      updatedBy: "m11-test",
    });
    const published = await request<WorkflowDefinition>(
      "POST",
      `/api/v1/workflows/${definition.id}/publish`,
    );
    expect(published.scope).toBe("platform");

    const template = await request<{
      id: string;
      revision: number;
      businessChainDefinitions: Array<{ version: number }>;
    }>(
      "POST",
      "/api/v1/project-templates",
      {
        name: `M11 template ${randomUUID().slice(0, 6)}`,
        code: `M11-${randomUUID().slice(0, 6).toUpperCase()}`,
        type: "ORDER",
        description: "",
        roleIds: [],
        workflowTemplates: [],
        businessChainPolicy: {
          mode: "required",
          defaultBusinessChainKey: "TEMPLATE_DELIVERY",
          allowedBusinessChainKeys: ["TEMPLATE_DELIVERY"],
          versionPolicy: "pin-at-project-create",
        },
        businessChainDefinitions: [
          {
            workflowDefinitionId: definition.id,
            expectedVersion: published.revision,
            required: true,
          },
        ],
        accessPolicy: "all-members",
        allowedActorIds: [],
      },
      201,
    );
    expect(template.businessChainDefinitions[0]?.version).toBe(
      published.revision,
    );
    await repositories.featureFlags.set({
      flagKey: "project.business_chain",
      scopeType: "platform",
      scopeId: "platform",
      mode: "on",
      updatedBy: "m11-test",
    });
    const materializationKey = randomUUID();
    const materialized = await request<Project>(
      "POST",
      "/api/v1/projects",
      {
        name: `M11 pinned ${randomUUID().slice(0, 6)}`,
        description: "",
        templateId: template.id,
        materializationKey,
      },
      201,
    );
    const settings = await request<ProjectBusinessChainSettings>(
      "GET",
      `/api/v1/projects/${materialized.id}/business-chain`,
    );
    expect(settings.binding).toMatchObject({
      workflowDefinitionId: definition.id,
      workflowDefinitionVersion: published.revision,
      bindingMode: "template",
    });

    const updated = await configureDefinition(
      published,
      definitionInput({
        revision: published.revision,
        chainKey: "TEMPLATE_DELIVERY",
        objectId: "order-updated",
      }),
    );
    expect(updated.revision).toBe(published.revision + 1);
    const afterUpdate = await request<ProjectBusinessChainSettings>(
      "GET",
      `/api/v1/projects/${materialized.id}/business-chain`,
    );
    expect(afterUpdate.binding?.workflowDefinitionVersion).toBe(
      published.revision,
    );
    expect(
      afterUpdate.binding?.nodeBindings[0]?.fieldBindings[0]?.objectId,
    ).toBe("order-42");
    await repositories.featureFlags.set({
      flagKey: "project.business_chain",
      scopeType: "platform",
      scopeId: "platform",
      mode: "off",
      updatedBy: "m11-test",
    });
  });

  it("deduplicates concurrent alerts and records acknowledge, suppress, and resolve history", async () => {
    const project = await createProject("M11 alert");
    const observedAt = new Date().toISOString();
    const results = await Promise.all(
      Array.from({ length: 16 }, () =>
        repositories.projectBusinessChains.observeAlert({
          projectId: project.id,
          actorId: "local-admin",
          observation: {
            sourceSystem: "erp",
            sourceObjectType: "order",
            sourceObjectId: "order-42",
            conditionCode: "PAYMENT_OVERDUE",
            title: "订单付款逾期",
            message: "付款超过承诺账期",
            severity: "critical",
            sourceRevision: "external-1",
            observedAt,
            linkedNodeIds: [],
            linkedTaskIds: [],
            followTargetId: null,
          },
        }),
      ),
    );
    expect(new Set(results.map((result) => result.alert.id)).size).toBe(1);
    const alerts = await repositories.projectBusinessChains.listAlerts(
      project.id,
    );
    expect(alerts).toHaveLength(1);
    const opened = await repositories.projectBusinessChains.getAlertDetail(
      alerts[0]!.id,
    );
    expect(
      opened.events.filter((event) => event.kind === "alert.opened"),
    ).toHaveLength(1);

    const acknowledged = await request<ProjectAlertDetail>(
      "POST",
      `/api/v1/project-alerts/${alerts[0]!.id}/acknowledge`,
      {
        expectedRevision: alerts[0]!.revision,
        note: "recognized",
      },
    );
    expect(acknowledged.alert.lifecycle).toBe("acknowledged");
    const suppressed = await request<ProjectAlertDetail>(
      "POST",
      `/api/v1/project-alerts/${alerts[0]!.id}/suppress`,
      {
        expectedRevision: acknowledged.alert.revision,
        until: new Date(Date.now() + 3_600_000).toISOString(),
        note: "waiting for customer",
      },
    );
    expect(suppressed.alert.lifecycle).toBe("suppressed");
    const resolved = await request<ProjectAlertDetail>(
      "POST",
      `/api/v1/project-alerts/${alerts[0]!.id}/resolve`,
      {
        expectedRevision: suppressed.alert.revision,
        note: "paid",
      },
    );
    expect(resolved.alert.lifecycle).toBe("resolved");
    expect(resolved.events.map((event) => event.kind)).toEqual(
      expect.arrayContaining([
        "alert.opened",
        "alert.acknowledged",
        "alert.suppressed",
        "alert.resolved",
      ]),
    );
    await expect(
      database.query("UPDATE project_alert_events SET summary = 'changed'"),
    ).rejects.toThrow(/append-only/);
    await expect(
      database.query("DELETE FROM project_alerts WHERE id = $1", [
        alerts[0]!.id,
      ]),
    ).rejects.toThrow(/resolved, not deleted/);
  });

  it("computes overview from authoritative task and source facts on every read", async () => {
    const project = await createProject("M11 overview");
    await enableBusinessChain(project.id);
    const workflow = await createWorkflow(project.id);
    const definition = await configureDefinition(
      workflow,
      definitionInput({ revision: workflow.revision }),
    );
    await bind(project.id, definition.id, 0);
    const beforeRefresh = await request<ProjectProgressOverview>(
      "GET",
      `/api/v1/projects/${project.id}/overview`,
    );
    expect(beforeRefresh.coverage.status).toBe("partial");
    expect(beforeRefresh.taskSummary.total).toBe(0);

    await request<TaskLike>(
      "POST",
      "/api/v1/tasks",
      {
        projectId: project.id,
        title: "M11 overview task",
        description: "Overview must compute current task facts",
        acceptance: ["visible in aggregate"],
        agentId: "00000000-0000-4000-8000-000000000001",
      },
      201,
    );
    controlled.mode = "fresh";
    await request(
      "POST",
      `/api/v1/projects/${project.id}/business-chain/refresh`,
    );
    const afterRefresh = await request<ProjectProgressOverview>(
      "GET",
      `/api/v1/projects/${project.id}/overview`,
    );
    expect(afterRefresh.taskSummary.total).toBe(1);
    expect(afterRefresh.coverage.status).toBe("complete");
    expect(afterRefresh.nodes[0]?.fields[0]?.value).not.toBeNull();
  });

  it("returns explicit blocked reasons for unbound and archived projects", async () => {
    const project = await createProject("M11 blocked");
    const unbound = await request<ProjectProgressOverview>(
      "GET",
      `/api/v1/projects/${project.id}/overview`,
    );
    expect(unbound.blockedReasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "business-chain-unbound" }),
        expect.objectContaining({ code: "feature-disabled" }),
      ]),
    );
    await database.query(
      "UPDATE projects SET status = 'archived', updated_at = NOW() WHERE id = $1",
      [project.id],
    );
    const archived = await request<ProjectProgressOverview>(
      "GET",
      `/api/v1/projects/${project.id}/overview`,
    );
    expect(archived.projectStatus).toBe("archived");
    expect(archived.blockedReasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "project-archived" }),
      ]),
    );
  });

  it("does not allow mock source data while project.source.mock is off", async () => {
    const project = await createProject("M11 mock");
    await enableBusinessChain(project.id);
    const workflow = await createWorkflow(project.id, "Mock 来源链路");
    const definition = await configureDefinition(
      workflow,
      definitionInput({
        revision: workflow.revision,
        chainKey: "MOCK_DELIVERY",
        sourceKind: "mock",
        objectId: "mock-order",
      }),
    );
    await bind(project.id, definition.id, 0);
    const denied = await request<ApiEnvelope>(
      "POST",
      `/api/v1/projects/${project.id}/business-chain/refresh`,
      {},
      409,
    );
    expect(denied.code).toBe("project_source_mock_disabled");
    const countBefore = await database.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM project_source_snapshots WHERE project_id = $1",
      [project.id],
    );
    expect(countBefore.rows[0]?.count).toBe("0");

    await setSourceMock(project.id, true);
    const refreshed = await request<{
      snapshots: Array<{ isMock: boolean }>;
    }>("POST", `/api/v1/projects/${project.id}/business-chain/refresh`);
    expect(refreshed.snapshots[0]?.isMock).toBe(true);
  });

  it("does not let the browser execute MCP project sources", async () => {
    const project = await createProject("M11 mcp boundary");
    await enableBusinessChain(project.id);
    const workflow = await createWorkflow(project.id, "MCP 来源链路");
    const input = definitionInput({
      revision: workflow.revision,
      chainKey: "MCP_DELIVERY",
    });
    const field = input.nodes![0]!.fields![0]!;
    field.bindings = [
      {
        ...field.bindings[0]!,
        refKey: "m13d-erp:order:order-42",
        sourceKind: "mcp",
        sourceSystem: "m13d-erp",
        objectId: "order-42",
        providerId: randomUUID(),
        providerVersionId: randomUUID(),
        providerRevision: 1,
        toolKey: "d".repeat(64),
        readOnly: true,
      },
    ];
    const definition = await configureDefinition(workflow, input);
    await bind(project.id, definition.id, 0);
    const before = await database.query<{ readonly count: string }>(
      `SELECT (
         (SELECT COUNT(*) FROM project_source_snapshots WHERE project_id = $1) +
         (SELECT COUNT(*) FROM project_source_mcp_reads WHERE project_id = $1) +
         (SELECT COUNT(*) FROM runtime_tool_requests WHERE project_id = $1) +
         (SELECT COUNT(*) FROM mcp_tool_calls WHERE project_id = $1)
       )::text AS count`,
      [project.id],
    );
    const denied = await request<ApiEnvelope>(
      "POST",
      `/api/v1/projects/${project.id}/business-chain/refresh`,
      {},
      403,
    );
    expect(denied.code).toBe("project_source_mcp_worker_only");
    const after = await database.query<{ readonly count: string }>(
      `SELECT (
         (SELECT COUNT(*) FROM project_source_snapshots WHERE project_id = $1) +
         (SELECT COUNT(*) FROM project_source_mcp_reads WHERE project_id = $1) +
         (SELECT COUNT(*) FROM runtime_tool_requests WHERE project_id = $1) +
         (SELECT COUNT(*) FROM mcp_tool_calls WHERE project_id = $1)
       )::text AS count`,
      [project.id],
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);

    for (const path of [
      `/api/v1/projects/${project.id}/business-chain/mcp-tools/call`,
      `/api/v1/projects/${project.id}/sources/read`,
      `/api/v1/mcp-providers/${randomUUID()}/invoke`,
    ]) {
      const response = await app.inject({
        method: "POST",
        url: path,
        headers: { "x-pluginmax-actor": "local-admin" },
        payload: {
          refKey: "m13d-erp:order:order-42",
          arguments: { forbidden: true },
        },
      });
      expect(response.statusCode).toBe(404);
    }
  });
});

interface TaskLike {
  readonly id: string;
}
