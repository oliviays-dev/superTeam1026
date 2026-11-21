import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  Agent,
  CreateMcpProviderInput,
  CreateTaskInput,
  McpProviderDetail,
  Project,
  Task,
} from "@pluginmax/contracts";
import {
  MCP_PROVIDER_CONTROL_PLANE_FLAG,
  MCP_TOOL_CATEGORY,
  MCP_TOOL_INVOCATION_FLAG,
  legacyTaskExecutionPolicy,
  taskExecutionPolicySchema,
} from "@pluginmax/contracts";
import { PlatformApplication } from "@pluginmax/application";
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
import {
  McpToolCallService,
  McpToolCallServiceError,
} from "./mcp-tool-call-service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl === undefined ? describe.skip : describe;
const admin = {
  principalId: "local-admin",
  platformAdministrator: true,
} as const;
const credentialRef = "env://M13B_MCP_TEST_TOKEN";
const rawCredential = `mcp-token-${randomUUID()}`;
const inputSecret = `input-secret-${randomUUID()}`;
const outputSecret = `output-secret-${randomUUID()}`;

integration("M13b MCP Tool call authorization and receipts", () => {
  let database: Database;
  let repositories: PlatformRepositories;
  let application: PlatformApplication;
  let providerInput: CreateMcpProviderInput;
  let provider: McpProviderDetail;
  let project: Project;
  let agent: Agent;
  let transportCalls = 0;
  let transportMode: "success" | "timeout" | "cancel" | "unknown" =
    "success";
  let transportArguments: Record<string, unknown> | null = null;
  const logs: Array<{ readonly event: string; readonly data: unknown }> = [];
  let service: McpToolCallService;
  const credentials: McpCredentialResolver = {
    resolve: async () => rawCredential,
  };
  const transport: McpToolCallTransport = {
    callTool: async (input, signal) => {
      transportCalls += 1;
      transportArguments = input.arguments;
      if (transportMode === "timeout") {
        throw new McpToolCallFailure(
          "timeout",
          "tool_call_timeout",
          "MCP Tool call timed out",
        );
      }
      if (transportMode === "unknown") {
        throw new Error(`remote body ${outputSecret}`);
      }
      if (transportMode === "cancel") {
        return new Promise<Record<string, unknown>>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () =>
              reject(
                new McpToolCallFailure(
                  "cancelled",
                  "tool_call_cancelled",
                  "MCP Tool call was cancelled",
                ),
              ),
            { once: true },
          );
        });
      }
      return {
        content: [
          { type: "text", text: outputSecret },
          { type: "resource", resource: { uri: "mcp://redacted" } },
        ],
        isError: false,
      };
    },
  };

  beforeAll(async () => {
    database = new Database(databaseUrl!);
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
    project = await application.createProject({
      name: `M13b Tool ${randomUUID().slice(0, 8)}`,
      description: "M13b MCP Tool call fixture",
    });
    agent = await application.createAgent({
      name: `M13b Agent ${randomUUID().slice(0, 8)}`,
      description: "M13b MCP Tool call agent",
      soul: "Execute governed MCP Tool calls.",
      scenarios: ["M13b"],
      goals: ["Prove MCP Tool authorization"],
      tools: [],
      runtimeKind: "fake",
      source: "platform",
    });
    await application.createProjectMember(project.id, {
      kind: "agent",
      agentId: agent.id,
      responsibility: "M13b MCP Tool calls",
      roleIds: [],
    });
    providerInput = {
      providerKey: `m13b.tool.${randomUUID().slice(0, 8)}`,
      name: "M13b Tool Provider",
      description: "M13b Tool execution fixture",
      transport: "streamable-http",
      endpointUrl: "https://m13b-tool.example.test/mcp",
      authKind: "bearer",
      credentialRef,
      credentialHeaderName: null,
      requestTimeoutMs: 1_000,
    };
    provider = await createActiveProvider(providerInput);
    service = new McpToolCallService(
      repositories,
      {
        owner: "m13b-worker",
        leaseSeconds: 30,
      },
      transport,
      credentials,
      (event, data = {}) => {
        logs.push({ event, data });
      },
    );
  });

  afterAll(async () => {
    await appCleanupFlags();
    await database.close();
  });

  async function setFlag(flagKey: string, enabled: boolean): Promise<void> {
    await repositories.featureFlags.set({
      flagKey,
      scopeType: "platform",
      scopeId: "platform",
      mode: enabled ? "on" : "off",
      updatedBy: "test:m13b",
    });
  }

  async function appCleanupFlags(): Promise<void> {
    await setFlag(MCP_TOOL_INVOCATION_FLAG, false);
    await setFlag(MCP_PROVIDER_CONTROL_PLANE_FLAG, false);
  }

  async function createActiveProvider(
    input: CreateMcpProviderInput,
  ): Promise<McpProviderDetail> {
    const created = await application.mcpProviders.create(admin, input);
    const requested = await application.mcpProviders.requestProbe(
      admin,
      created.provider.id,
      { expectedRevision: created.provider.revision },
    );
    const job = await repositories.mcpProviders.claimProbeJob(
      "m13b-probe-worker",
      30,
    );
    expect(job?.probeId).toBe(requested.probe.id);
    await repositories.mcpProviders.completeProbeJob({
      probeId: requested.probe.id,
      owner: "m13b-probe-worker",
      leaseToken: job!.leaseToken,
      passed: true,
      durationMs: 10,
      tools: [
        {
          name: "orders.lookup",
          description: "Lookup an order",
          inputSchema: {
            type: "object",
            properties: { orderId: { type: "string" } },
          },
          outputSchema: null,
          schemaDigest: "a".repeat(64),
        },
      ],
    });
    const probed = await application.mcpProviders.get(
      admin,
      created.provider.id,
    );
    return application.mcpProviders.activate(admin, created.provider.id, {
      expectedRevision: probed.provider.revision,
      reason: "M13b toolbox activation",
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
      budget: {
        timeoutMs: 30_000,
        maxToolCalls: 10,
      },
    });
  }

  async function taskWithMcpPolicy(): Promise<Task> {
    const input: CreateTaskInput = {
      projectId: project.id,
      title: `M13b Tool ${randomUUID().slice(0, 8)}`,
      description: "Server-owned MCP Tool call",
      acceptance: [],
      agentId: agent.id,
      autoSubmit: false,
    };
    const task = await application.createTask(input);
    await application.updateTaskExecutionPolicy(
      "task",
      task.id,
      {
        expectedRevision: 0,
        policy: mcpPolicy(),
      },
      "local-admin",
    );
    return task;
  }

  async function authorizedRun(): Promise<{
    readonly runId: string;
    readonly task: Task;
    readonly gateId: string;
    readonly toolKey: string;
  }> {
    const task = await taskWithMcpPolicy();
    const dispatched = await application.dispatchTask(
      task.id,
      undefined,
      "local-admin",
      true,
    );
    const bundle = await repositories.actionTickets.getBundle(
      dispatched.runId,
    );
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
        basis: "M13b integration authorization",
      },
      "local-admin",
    );
    await repositories.runs.markRunning(dispatched.runId);
    const detail = await application.mcpProviders.get(
      admin,
      provider.provider.id,
    );
    return {
      runId: dispatched.runId,
      task,
      gateId: gate!.gateId,
      toolKey: detail.tools[0]!.toolKey,
    };
  }

  function callInput(input: {
    readonly runId: string;
    readonly gateId: string;
    readonly toolKey: string;
    readonly idempotencyKey?: string;
    readonly arguments?: Record<string, unknown>;
  }) {
    return {
      runId: input.runId,
      runAttempt: 1,
      toolKey: input.toolKey,
      gateId: input.gateId,
      idempotencyKey: input.idempotencyKey ?? `idem-${randomUUID()}`,
      arguments: input.arguments ?? {
        orderId: "order-42",
        note: inputSecret,
      },
    };
  }

  it("executes once, replays idempotently and stores only redacted summaries", async () => {
    const run = await authorizedRun();
    const input = callInput({
      runId: run.runId,
      gateId: run.gateId,
      toolKey: run.toolKey,
      idempotencyKey: "m13b-idempotent-call",
    });
    const first = await service.invoke(input);
    expect(first.call).toMatchObject({
      status: "succeeded",
      providerId: provider.provider.id,
      toolName: "orders.lookup",
      gateId: run.gateId,
    });
    expect(first.receipts.map((receipt) => receipt.status)).toEqual([
      "started",
      "succeeded",
    ]);
    expect(transportArguments).toMatchObject({
      orderId: "order-42",
    });
    const callsAfterFirst = transportCalls;
    const replay = await service.invoke(input);
    expect(replay.call.id).toBe(first.call.id);
    expect(transportCalls).toBe(callsAfterFirst);

    const rows = await database.query<{ readonly payload: string }>(
      `SELECT (
         COALESCE(
           (SELECT jsonb_agg(to_jsonb(call))::text
            FROM mcp_tool_calls AS call WHERE call.run_id = $1),
           '[]'
         ) || COALESCE(
           (SELECT jsonb_agg(to_jsonb(receipt))::text
            FROM mcp_tool_call_receipts AS receipt
            JOIN mcp_tool_calls AS call ON call.id = receipt.call_id
            WHERE call.run_id = $1),
           '[]'
         ) || COALESCE(
           (SELECT jsonb_agg(to_jsonb(audit))::text
            FROM mcp_provider_audit_events AS audit
            WHERE audit.action LIKE 'mcp.tool.call.%'),
           '[]'
         )
       ) AS payload`,
      [run.runId],
    );
    const serialized = JSON.stringify({
      rows: rows.rows,
      logs,
    });
    expect(serialized).not.toContain(inputSecret);
    expect(serialized).not.toContain(outputSecret);
    expect(serialized).not.toContain(rawCredential);
    expect(serialized).not.toContain(credentialRef);
    expect(first.call.inputSummary).toMatchObject({
      argumentKeys: ["note", "orderId"],
      argumentCount: 2,
    });
    expect(first.call.outputSummary).toMatchObject({
      contentCount: 2,
      contentTypes: ["text", "resource"],
      toolReportedError: false,
    });

    const receiptId = first.receipts[0]!.id;
    await expect(
      database.query(
        "UPDATE mcp_tool_call_receipts SET error_code = 'changed' WHERE id = $1",
        [receiptId],
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      database.query(
        "UPDATE mcp_provider_audit_events SET reason = 'changed' WHERE action = 'mcp.tool.call.started'",
      ),
    ).rejects.toThrow(/append-only/);
  });

  it("requires a Ticket and Gate; Market binding never substitutes for authorization", async () => {
    const run = await authorizedRun();
    await bindProviderToMarket(run.toolKey);
    await expect(
      service.invoke(
        callInput({
          runId: run.runId,
          gateId: randomUUID(),
          toolKey: run.toolKey,
        }),
      ),
    ).rejects.toMatchObject({
      code: "execution_gate_missing",
      statusCode: 403,
    });

    const task = await taskWithMcpPolicy();
    const originalRunId = (
      await application.dispatchTask(task.id, undefined, "local-admin", true)
    ).runId;
    const original = await repositories.runs.get(originalRunId);
    const noTicketRunId = randomUUID();
    await repositories.runs.enqueue({
      runId: noTicketRunId,
      task,
      agentId: agent.id,
      inputSnapshot: original!.inputSnapshot,
      executionEnvelope: original!.executionEnvelope!,
      observability: original!.observability,
    });
    await repositories.runs.markRunning(noTicketRunId);
    await expect(
      service.invoke(
        callInput({
          runId: noTicketRunId,
          gateId: randomUUID(),
          toolKey: run.toolKey,
        }),
      ),
    ).rejects.toMatchObject({
      code: "action_ticket_missing",
      statusCode: 403,
    });
  });

  it("distinguishes timeout, cancellation and unknown remote failures", async () => {
    for (const mode of ["timeout", "cancel", "unknown"] as const) {
      transportMode = mode;
      const run = await authorizedRun();
      const input = callInput({
        runId: run.runId,
        gateId: run.gateId,
        toolKey: run.toolKey,
      });
      const controller = new AbortController();
      const pending = service.invoke(input, { signal: controller.signal });
      if (mode === "cancel") {
        setTimeout(() => controller.abort(), 40);
      }
      await expect(pending).rejects.toBeInstanceOf(McpToolCallServiceError);
      const detail = await repositories.mcpToolCalls.findByRunAndIdempotency({
        runId: run.runId,
        idempotencyKey: input.idempotencyKey,
      });
      expect(detail?.call.status).toBe(
        mode === "timeout"
          ? "timed_out"
          : mode === "cancel"
            ? "cancelled"
            : "failed",
      );
      expect(detail?.call.errorCategory).toBe(
        mode === "timeout"
          ? "timeout"
          : mode === "cancel"
            ? "cancelled"
            : "unknown",
      );
      expect(JSON.stringify(detail)).not.toContain(outputSecret);
    }
    transportMode = "success";
  });

  it("enforces idempotency conflicts, one Gate per call and feature-off inertness", async () => {
    const run = await authorizedRun();
    const input = callInput({
      runId: run.runId,
      gateId: run.gateId,
      toolKey: run.toolKey,
      idempotencyKey: "m13b-gate-once",
    });
    await service.invoke(input);
    await expect(
      service.invoke({ ...input, arguments: { orderId: "different" } }),
    ).rejects.toMatchObject({ code: "mcp_tool_idempotency_conflict" });
    await expect(
      service.invoke(
        callInput({
          runId: run.runId,
          gateId: run.gateId,
          toolKey: run.toolKey,
          idempotencyKey: "m13b-gate-reuse",
        }),
      ),
    ).rejects.toMatchObject({ code: "execution_gate_already_used" });

    const disabledRun = await authorizedRun();
    await setFlag(MCP_TOOL_INVOCATION_FLAG, false);
    const before = await countToolCallState();
    const callsBefore = transportCalls;
    await expect(
      service.invoke(
        callInput({
          runId: disabledRun.runId,
          gateId: disabledRun.gateId,
          toolKey: disabledRun.toolKey,
        }),
      ),
    ).rejects.toMatchObject({
      code: "mcp_tool_invocation_disabled",
      statusCode: 503,
    });
    expect(transportCalls).toBe(callsBefore);
    expect(await countToolCallState()).toBe(before);
    await setFlag(MCP_TOOL_INVOCATION_FLAG, true);

    await expect(
      application.mcpToolCalls.reconcilePlatform({
        actor: { principalId: "regular-user", platformAdministrator: false },
      }),
    ).rejects.toMatchObject({ code: "mcp_tool_admin_required" });
  });

  it("rejects a stale Provider Tool identity after version CAS changes", async () => {
    const staleProvider = await createActiveProvider({
      ...providerInput,
      providerKey: `m13b.cas.${randomUUID().slice(0, 8)}`,
      name: "M13b CAS Provider",
    });
    const staleToolKey = staleProvider.tools[0]!.toolKey;
    const run = await authorizedRun();
    await application.mcpProviders.createVersion(
      admin,
      staleProvider.provider.id,
      {
        name: "M13b CAS Provider v2",
        description: providerInput.description,
        transport: providerInput.transport,
        endpointUrl: providerInput.endpointUrl,
        authKind: providerInput.authKind,
        credentialRef: providerInput.credentialRef,
        credentialHeaderName: providerInput.credentialHeaderName,
        requestTimeoutMs: providerInput.requestTimeoutMs,
        expectedRevision: staleProvider.provider.revision,
      },
    );
    await expect(
      service.invoke(
        callInput({
          runId: run.runId,
          gateId: run.gateId,
          toolKey: staleToolKey,
        }),
      ),
    ).rejects.toMatchObject({
      code: "mcp_tool_revision_conflict",
      statusCode: 409,
    });
  });

  async function countToolCallState(): Promise<string> {
    const result = await database.query<{ readonly count: string }>(
      `SELECT (
         (SELECT COUNT(*) FROM mcp_tool_calls) +
         (SELECT COUNT(*) FROM mcp_tool_call_receipts) +
         (SELECT COUNT(*) FROM mcp_provider_audit_events
          WHERE action LIKE 'mcp.tool.call.%')
       )::text AS count`,
    );
    return result.rows[0]?.count ?? "0";
  }

  async function bindProviderToMarket(toolKey: string): Promise<void> {
    const assetId = randomUUID();
    const versionId = randomUUID();
    await database.query(
      `INSERT INTO market_assets (
         id, asset_key, kind, name, description, publisher_principal_id,
         origin, sharing_scope, publication_status, availability_status,
         current_version, revision, created_at, updated_at
       ) VALUES (
         $1, $2, 'skill', 'M13b Market Provider',
         'Binding must not grant execution', 'local-admin',
         'user', 'private', 'published', 'active', 1, 1, NOW(), NOW()
       )`,
      [assetId, `m13b.market.${toolKey.slice(0, 12)}`],
    );
    await database.query(
      `INSERT INTO market_asset_versions (
         id, asset_id, version, digest, publisher_principal_id, manifest,
         compatibility, status, created_at
       ) VALUES (
         $1, $2, 1, $3, 'local-admin',
         '{"summary":"provider identity only"}'::jsonb,
         '{"minHostVersion":"2.0.0"}'::jsonb, 'published', NOW()
       )`,
      [versionId, assetId, "b".repeat(64)],
    );
    await database.query(
      `INSERT INTO market_asset_resource_bindings (
         id, asset_id, asset_version_id, resource_kind, resource_id,
         resource_version_id, created_by_principal_id, created_at
       ) VALUES (
         $1, $2, $3, 'mcp_provider', $4, $5, 'local-admin', NOW()
       )`,
      [
        randomUUID(),
        assetId,
        versionId,
        provider.provider.providerKey,
        provider.provider.currentVersionId,
      ],
    );
  }
});
