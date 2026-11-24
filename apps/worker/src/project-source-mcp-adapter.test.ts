import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type AgentRuntimeAdapter,
  RunLeaseLostError,
  RunExecutor,
  PlatformApplication,
} from "@pluginmax/application";
import {
  BUSINESS_CHAIN_FLAG,
  MCP_PROJECT_SOURCE_FLAG,
  MCP_PROJECT_SOURCE_READ_PROTOCOL,
  MCP_PROVIDER_CONTROL_PLANE_FLAG,
  MCP_RUNTIME_TOOL_BRIDGE_FLAG,
  MCP_TOOL_CATEGORY,
  MCP_TOOL_INVOCATION_FLAG,
  legacyTaskExecutionPolicy,
  taskExecutionPolicySchema,
  type Agent,
  type BusinessChainDefinitionValue,
  type CreateMcpProviderInput,
  type McpProviderDetail,
  type Project,
  type ProjectSourceMcpReadIntent,
} from "@pluginmax/contracts";
import {
  Database,
  PlatformRepositories,
  migrate,
} from "@pluginmax/database";
import {
  McpToolCallFailure,
  type McpCredentialResolver,
  type McpToolCallTransport,
} from "./mcp-provider-probe-service.js";
import { McpToolCallService } from "./mcp-tool-call-service.js";
import { RuntimeToolRequestBridge } from "./runtime-tool-request-bridge.js";
import { McpProjectSourceAdapter } from "./project-source-mcp-adapter.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl === undefined ? describe.skip : describe;
const admin = {
  principalId: "local-admin",
  platformAdministrator: true,
} as const;
const credentialRef = "env://M13D_MCP_TEST_TOKEN";
const rawCredential = `m13d-credential-${randomUUID()}`;
const outputSecret = `m13d-output-${randomUUID()}`;

integration("M13d read-only MCP project source adapter", () => {
  let database: Database;
  let repositories: PlatformRepositories;
  let application: PlatformApplication;
  let project: Project;
  let agent: Agent;
  let provider: McpProviderDetail;
  let sourceAdapter: McpProjectSourceAdapter;
  let workspaceRoot: string;
  let fileStoreRoot: string;
  let transportCalls = 0;
  let transportMode: "success" | "timeout" | "deferred" | "unknown" =
    "success";
  let deferredStarted: (() => void) | undefined;
  let refKey = "";
  const logs: Array<{ readonly event: string; readonly data: unknown }> = [];
  const credentials: McpCredentialResolver = {
    resolve: async () => rawCredential,
  };
  const transport: McpToolCallTransport = {
    callTool: async (input, signal) => {
      transportCalls += 1;
      if (input.arguments.refKey === refKey) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (transportMode === "timeout") {
        throw new McpToolCallFailure(
          "timeout",
          "source_timeout",
          "Project source timed out",
        );
      }
      if (transportMode === "unknown") {
        throw new Error(`raw remote ${outputSecret}`);
      }
      if (transportMode === "deferred") {
        deferredStarted?.();
        return new Promise<Record<string, unknown>>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () =>
              reject(
                new McpToolCallFailure(
                  "cancelled",
                  "source_cancelled",
                  "Project source cancelled",
                ),
              ),
            { once: true },
          );
        });
      }
      const now = new Date();
      return {
        content: [{ type: "text", text: outputSecret }],
        structuredContent: {
          protocol: MCP_PROJECT_SOURCE_READ_PROTOCOL,
          sourceRevision: `revision-${Date.now()}`,
          observedAt: now.toISOString(),
          effectiveAt: now.toISOString(),
          freshUntil: new Date(now.getTime() + 300_000).toISOString(),
          payload: {
            amount: 420,
            endpoint: "https://must-not-store.example.test",
            credentialRef,
          },
          alerts: [
            {
              sourceSystem: "ignored-overrides-the-binding",
              sourceObjectType: "order",
              sourceObjectId: "ignored",
              conditionCode: "MCP_SOURCE_WARNING",
              title: "来源告警",
              message: "Read-only source reported a warning",
              severity: "warning",
              sourceRevision: "revision-alert",
              linkedNodeIds: [],
              linkedTaskIds: [],
              followTargetId: null,
            },
          ],
        },
        isError: false,
      };
    },
  };

  beforeAll(async () => {
    database = new Database(databaseUrl!);
    workspaceRoot = await mkdtemp(join(tmpdir(), "pluginmax-m13e-workspace-"));
    fileStoreRoot = await mkdtemp(join(tmpdir(), "pluginmax-m13e-files-"));
    repositories = new PlatformRepositories(database);
    application = new PlatformApplication(repositories);
    await migrate(database);
    await database.query(
      `INSERT INTO principals (
         id, kind, display_name, status, status_authority, source,
         version, created_at, updated_at
       ) VALUES (
         'local-admin', 'human', 'Local Admin', 'active', 'system', 'local',
         1, NOW(), NOW()
       )
       ON CONFLICT (id) DO NOTHING`,
    );
    await setFlag(MCP_PROVIDER_CONTROL_PLANE_FLAG, true);
    await setFlag(MCP_TOOL_INVOCATION_FLAG, true);
    await setFlag(MCP_RUNTIME_TOOL_BRIDGE_FLAG, true);
    await setFlag(MCP_PROJECT_SOURCE_FLAG, true);
    project = await application.createProject({
      name: `M13d Source ${randomUUID().slice(0, 8)}`,
      description: "M13d read-only project source fixture",
    });
    const businessChainFlag =
      await repositories.projectBusinessChains.getFeatureFlagState(
        BUSINESS_CHAIN_FLAG,
        project.id,
      );
    await repositories.projectBusinessChains.setProjectFeatureFlag({
      flagKey: BUSINESS_CHAIN_FLAG,
      projectId: project.id,
      enabled: true,
      expectedRevision: businessChainFlag.revision,
      actorId: "local-admin",
    });
    agent = await application.createAgent({
      name: `M13d Agent ${randomUUID().slice(0, 8)}`,
      description: "M13d project source agent",
      soul: "Read governed project sources.",
      scenarios: ["M13d"],
      goals: ["Prove Worker-only project source reads"],
      tools: [],
      runtimeKind: "fake",
      source: "platform",
    });
    await application.createProjectMember(project.id, {
      kind: "agent",
      agentId: agent.id,
      responsibility: "M13d project source reads",
      roleIds: [],
    });
    provider = await createActiveProvider();
    const workflow = await application.createWorkflow({
      projectId: project.id,
      name: `M13d source chain ${randomUUID().slice(0, 6)}`,
      description: "Read-only MCP project source",
      stepNames: ["Source"],
      stepRoleIds: [],
    });
    refKey = `m13d-erp:order:order-42`;
    const definition: BusinessChainDefinitionValue = {
      chainKey: `M13D_SOURCE_${randomUUID().slice(0, 6).toUpperCase()}`,
      templateKey: "M13D_SOURCE",
      displayName: "M13d 订单来源",
      projectTypeCodes: ["ORDER"],
      snapshotPolicy: "pin-at-project-create",
      allowUnboundSources: false,
      nodes: [
        {
          sequence: 1,
          stageCode: "ORDER",
          fields: [
            {
              key: "amount",
              label: "订单金额",
              bindings: [
                {
                  refKey,
                  sourceKind: "mcp",
                  sourceSystem: "m13d-erp",
                  objectType: "order",
                  objectId: "order-42",
                  path: "amount",
                  required: true,
                  providerId: provider.provider.id,
                  providerVersionId: provider.provider.currentVersionId!,
                  providerRevision: provider.provider.revision,
                  toolKey: provider.tools[0]!.toolKey,
                  readOnly: true,
                },
              ],
            },
          ],
        },
      ],
      expectedRevision: workflow.revision,
    };
    const configured = await application.configureWorkflowBusinessChain(
      workflow.id,
      definition,
      "local-admin",
      true,
    );
    await application.bindProjectBusinessChain(
      project.id,
      {
        workflowDefinitionId: configured.id,
        nodeBindings: [],
        expectedRevision: 0,
        reason: "M13d source binding",
        upgrade: false,
      },
      "local-admin",
    );
    const toolCalls = new McpToolCallService(
      repositories,
      { owner: "m13d-tool-worker", leaseSeconds: 30 },
      transport,
      credentials,
      (event, data = {}) => logs.push({ event, data }),
    );
    const bridge = new RuntimeToolRequestBridge(
      repositories,
      toolCalls,
      { owner: "m13d-runtime-worker", leaseSeconds: 60 },
      (event, data = {}) => logs.push({ event, data }),
    );
    sourceAdapter = new McpProjectSourceAdapter(
      repositories,
      bridge,
      { owner: "m13d-source-worker", leaseSeconds: 60 },
      (event, data = {}) => logs.push({ event, data }),
    );
  });

  afterAll(async () => {
    for (const flag of [
      MCP_PROJECT_SOURCE_FLAG,
      MCP_RUNTIME_TOOL_BRIDGE_FLAG,
      MCP_TOOL_INVOCATION_FLAG,
      MCP_PROVIDER_CONTROL_PLANE_FLAG,
    ]) {
      await setFlag(flag, false);
    }
    await database.close();
  });

  async function setFlag(flagKey: string, enabled: boolean): Promise<void> {
    await repositories.featureFlags.set({
      flagKey,
      scopeType: "platform",
      scopeId: "platform",
      mode: enabled ? "on" : "off",
      updatedBy: "test:m13d",
    });
  }

  async function createActiveProvider(): Promise<McpProviderDetail> {
    const input: CreateMcpProviderInput = {
      providerKey: `m13d.source.${randomUUID().slice(0, 8)}`,
      name: "M13d Source Provider",
      description: "M13d read-only project source provider",
      transport: "streamable-http",
      endpointUrl: "https://m13d-source.example.test/mcp",
      authKind: "bearer",
      credentialRef,
      credentialHeaderName: null,
      requestTimeoutMs: 1_000,
    };
    const created = await application.mcpProviders.create(admin, input);
    const requested = await application.mcpProviders.requestProbe(
      admin,
      created.provider.id,
      { expectedRevision: created.provider.revision },
    );
    const job = await repositories.mcpProviders.claimProbeJob(
      "m13d-probe-worker",
      30,
    );
    expect(job?.probeId).toBe(requested.probe.id);
    await repositories.mcpProviders.completeProbeJob({
      probeId: requested.probe.id,
      owner: "m13d-probe-worker",
      leaseToken: job!.leaseToken,
      passed: true,
      durationMs: 10,
      tools: [
        {
          name: "project.source.read",
          description: "Read a project source object",
          inputSchema: {
            type: "object",
            properties: { refKey: { type: "string" } },
          },
          outputSchema: null,
          schemaDigest: "c".repeat(64),
        },
      ],
    });
    const probed = await application.mcpProviders.get(
      admin,
      created.provider.id,
    );
    return application.mcpProviders.activate(admin, created.provider.id, {
      expectedRevision: probed.provider.revision,
      reason: "M13d source activation",
    });
  }

  function mcpPolicy() {
    return taskExecutionPolicySchema.parse({
      ...legacyTaskExecutionPolicy(),
      runtime: {
        selection: "recommended",
        allowedRuntimeIds: ["builtin:fake"],
        requiredCapabilities: [
          { key: "mcp", necessity: "required", value: "supported" },
        ],
      },
      sourcePolicy: {
        allow: [
          "workspace",
          "task-attachments",
          "project-memory",
          "connector-data",
        ],
        deny: ["private-local-data"],
        citation: "none",
        requirePublishedAt: false,
        requireAccessedAt: false,
      },
      toolPolicy: {
        allow: [MCP_TOOL_CATEGORY],
        deny: [],
        requireApproval: [MCP_TOOL_CATEGORY],
      },
      budget: { timeoutMs: 30_000, maxToolCalls: 20 },
    });
  }

  async function authorizedRun(markRunning = true): Promise<{
    readonly runId: string;
    readonly gateId: string;
  }> {
    const task = await application.createTask({
      projectId: project.id,
      title: `M13d source ${randomUUID().slice(0, 8)}`,
      description: "M13d source read",
      acceptance: [],
      agentId: agent.id,
      autoSubmit: false,
    });
    await application.updateTaskExecutionPolicy(
      "task",
      task.id,
      { expectedRevision: 0, policy: mcpPolicy() },
      "local-admin",
    );
    const dispatched = await application.dispatchTask(
      task.id,
      undefined,
      "local-admin",
      true,
    );
    const bundle = await repositories.actionTickets.getBundle(dispatched.runId);
    const gate = bundle?.gates.find(
      (candidate) =>
        candidate.requestedToolCategory === MCP_TOOL_CATEGORY &&
        candidate.enforcement === "blocking",
    );
    expect(gate).toBeDefined();
    await application.decideExecutionGate(
      gate!.gateId,
      {
        decision: "approve",
        basis: "M13d source integration",
      },
      "local-admin",
    );
    if (markRunning) {
      await repositories.runs.markRunning(dispatched.runId);
    }
    return { runId: dispatched.runId, gateId: gate!.gateId };
  }

  function intent(
    run: { readonly runId: string; readonly gateId: string },
    overrides: Partial<ProjectSourceMcpReadIntent> = {},
  ): ProjectSourceMcpReadIntent {
    return {
      projectId: project.id,
      refKey,
      runId: run.runId,
      runAttempt: 1,
      gateId: run.gateId,
      requestId: randomUUID(),
      idempotencyKey: `m13d-idem-${randomUUID()}`,
      timeoutMs: 2_000,
      ...overrides,
    };
  }

  it("reads through the Worker-only bridge, snapshots safely and stays idempotent", async () => {
    const run = await authorizedRun();
    const request = intent(run);
    const first = await sourceAdapter.read(request, {
      assertLease: async () => undefined,
    });
    expect(first).toMatchObject({
      status: "succeeded",
      deduplicated: false,
    });
    expect(first.snapshotId).not.toBeNull();
    expect(
      logs.find(
        (entry) => entry.event === "project_source_mcp.protocol_parsed",
      )?.data,
    ).toMatchObject({ alertCount: 1, payloadKeys: ["amount"] });
    const callsAfterFirst = transportCalls;
    const replay = await sourceAdapter.read(request, {
      assertLease: async () => undefined,
    });
    expect(replay).toMatchObject({
      status: "succeeded",
      deduplicated: true,
      snapshotId: first.snapshotId,
    });
    expect(transportCalls).toBe(callsAfterFirst);

    const overview = await application.getProjectProgressOverview(
      project.id,
      "local-admin",
    );
    expect(overview.coverage.status).toBe("complete");
    expect(overview.nodes[0]?.fields[0]?.value).toBe(420);
    const summary = await sourceAdapter.summary();
    expect(summary).toMatchObject({
      total: 1,
      succeeded: 1,
      staleRunning: 0,
    });
    expect(
      await repositories.projectSourceMcp.retentionPreview(30),
    ).toMatchObject({
      retentionDays: 30,
      eligibleReads: 0,
      eligibleEvents: 0,
      eligibleSnapshots: 0,
      dryRun: true,
      action: "archive-before-delete",
    });
    const alerts = await repositories.projectBusinessChains.listAlerts(
      project.id,
    );
    expect(
      logs.filter(
        (entry) => entry.event === "project_source_mcp.alert_projection_failed",
      ),
    ).toEqual([]);
    expect(
      logs.filter(
        (entry) => entry.event === "project_source_mcp.execute_failed",
      ),
    ).toEqual([]);
    expect(
      logs.find(
        (entry) =>
          entry.event === "project_source_mcp.alert_projection_completed",
      )?.data,
    ).toMatchObject({ alertCount: 1 });
    expect(alerts).toHaveLength(1);

    const stored = await database.query<{ readonly payload: string }>(
      `SELECT (
         COALESCE((SELECT jsonb_agg(to_jsonb(read))::text
                   FROM project_source_mcp_reads AS read
                   WHERE read.project_id = $1), '[]') ||
         COALESCE((SELECT jsonb_agg(to_jsonb(snapshot))::text
                   FROM project_source_snapshots AS snapshot
                   WHERE snapshot.project_id = $1), '[]') ||
         COALESCE((SELECT jsonb_agg(to_jsonb(event))::text
                   FROM project_source_mcp_read_events AS event
                   WHERE event.project_id = $1), '[]')
       ) AS payload`,
      [project.id],
    );
    const serialized = JSON.stringify({ stored: stored.rows, logs });
    expect(serialized).not.toContain(outputSecret);
    expect(serialized).not.toContain(rawCredential);
    expect(serialized).not.toContain(credentialRef);
    expect(serialized).not.toContain("must-not-store");
  });

  it("rejects missing authorization and never lets flags, Owner or Admin stand in for it", async () => {
    const run = await authorizedRun();
    const before = await countSourceState();
    const callsBefore = transportCalls;
    await expect(
      sourceAdapter.read(intent(run, { gateId: randomUUID() }), {
        assertLease: async () => undefined,
      }),
    ).rejects.toMatchObject({
      code: "project_source_mcp_authorization_missing",
    });
    expect(await countSourceState()).toBe(before);
    expect(transportCalls).toBe(callsBefore);

    await setFlag(MCP_PROJECT_SOURCE_FLAG, false);
    await expect(
      sourceAdapter.read(intent(run), {
        assertLease: async () => undefined,
      }),
    ).rejects.toMatchObject({
      code: "project_source_mcp_disabled",
      statusCode: 503,
    });
    expect(await countSourceState()).toBe(before);
    expect(transportCalls).toBe(callsBefore);
    await setFlag(MCP_PROJECT_SOURCE_FLAG, true);
  });

  it("classifies timeout, cancellation, lease loss and concurrent out-of-order reads", async () => {
    transportMode = "timeout";
    const timeoutRun = await authorizedRun();
    const timedOut = await sourceAdapter.read(intent(timeoutRun), {
      assertLease: async () => undefined,
    });
    expect(timedOut).toMatchObject({
      status: "timed_out",
      errorCategory: "timeout",
    });

    transportMode = "deferred";
    const cancelRun = await authorizedRun();
    const controller = new AbortController();
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    deferredStarted = () => markStarted?.();
    const pending = sourceAdapter.read(intent(cancelRun), {
      signal: controller.signal,
      assertLease: async () => undefined,
    });
    await started;
    controller.abort();
    const cancelled = await pending;
    expect(cancelled.status).toBe("cancelled");
    deferredStarted = undefined;

    transportMode = "success";
    const leaseRun = await authorizedRun();
    let checks = 0;
    const interrupted = await sourceAdapter.read(intent(leaseRun), {
      assertLease: async () => {
        checks += 1;
        if (checks >= 2) throw new RunLeaseLostError();
      },
    });
    expect(interrupted).toMatchObject({
      status: "interrupted",
      errorCategory: "interrupted",
    });

    const [firstRun, secondRun] = await Promise.all([
      authorizedRun(),
      authorizedRun(),
    ]);
    const [first, second] = await Promise.all([
      sourceAdapter.read(intent(firstRun), {
        assertLease: async () => undefined,
      }),
      sourceAdapter.read(intent(secondRun), {
        assertLease: async () => undefined,
      }),
    ]);
    expect(first.status).toBe("succeeded");
    expect(second.status).toBe("succeeded");
  });

  it("rejects a stale Provider version before remote access", async () => {
    const stale = await application.mcpProviders.createVersion(
      admin,
      provider.provider.id,
      {
        name: "M13d Source Provider v2",
        description: "A new current version invalidates pinned source reads",
        transport: "streamable-http",
        endpointUrl: "https://m13d-source.example.test/mcp",
        authKind: "bearer",
        credentialRef,
        credentialHeaderName: null,
        requestTimeoutMs: 1_000,
        expectedRevision: provider.provider.revision,
      },
    );
    expect(stale.provider.currentVersionId).not.toBe(
      provider.provider.currentVersionId,
    );
    const run = await authorizedRun();
    const callsBefore = transportCalls;
    await expect(
      sourceAdapter.read(intent(run), {
        assertLease: async () => undefined,
      }),
    ).rejects.toMatchObject({
      code: "project_source_mcp_binding_invalid",
    });
    expect(transportCalls).toBe(callsBefore);
  });

  it("associates new Run artifacts with current project sources", async () => {
    const now = new Date();
    await repositories.projectBusinessChains.recordSourceSnapshot({
      projectId: project.id,
      actorId: "system:project-source-worker",
      result: {
        refKey,
        sourceKind: "mcp",
        sourceSystem: "m13d-erp",
        objectType: "order",
        objectId: "order-42",
        sourceRevision: "m13e-artifact-source",
        observedAt: now.toISOString(),
        effectiveAt: now.toISOString(),
        freshUntil: new Date(now.getTime() + 300_000).toISOString(),
        status: "fresh",
        payload: { amount: 420 },
        failureReason: null,
        isMock: false,
      },
    });
    const run = await authorizedRun(false);
    const job = await repositories.jobs.claimNext(
      "m13e-artifact-worker",
      30,
      run.runId,
    );
    expect(job).toBeDefined();
    const adapter: AgentRuntimeAdapter = {
      id: "m13e-artifact-source",
      mcpToolRequestProtocol: "none",
      async *execute() {
        yield {
          type: "completed",
          output: "M13e artifact source association output.",
        };
      },
    };
    const executor = new RunExecutor(repositories, {
      workspaceRoot,
      fileStoreRoot,
      runtimeEffectPollIntervalMs: 20,
      runtimeAdapterFactory: () => adapter,
      dsh: {
        dshBin: "unused",
        profile: "unused",
        dshHome: "unused",
        provider: "unused",
        model: "unused",
      },
    });
    await executor.execute(run.runId, {
      signal: new AbortController().signal,
      jobId: job!.id,
      owner: "m13e-artifact-worker",
      leaseSeconds: 30,
      leaseRenewIntervalMs: 1_000,
      traceId: job!.traceId,
      jobSpanId: job!.spanId,
      jobAttempt: job!.attempts,
      assertLease: async () => undefined,
    });
    const artifacts = await repositories.artifacts.listByRun(run.runId);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.sourceRefs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "project-source",
          id: refKey,
          projectId: project.id,
        }),
      ]),
    );
  });

  async function countSourceState(): Promise<string> {
    const result = await database.query<{ readonly count: string }>(
      `SELECT (
         (SELECT COUNT(*) FROM project_source_mcp_reads) +
         (SELECT COUNT(*) FROM project_source_mcp_read_events) +
         (SELECT COUNT(*) FROM project_source_snapshots) +
         (SELECT COUNT(*) FROM project_alerts) +
         (SELECT COUNT(*) FROM runtime_tool_requests) +
         (SELECT COUNT(*) FROM mcp_tool_calls) +
         (SELECT COUNT(*) FROM mcp_provider_audit_events
          WHERE action LIKE 'mcp.tool.call.%')
       )::text AS count`,
    );
    return result.rows[0]?.count ?? "0";
  }
});
