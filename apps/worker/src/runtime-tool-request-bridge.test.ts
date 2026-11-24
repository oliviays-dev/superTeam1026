import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  RunLeaseLostError,
  PlatformApplication,
  RunExecutor,
  type AgentRuntimeAdapter,
} from "@pluginmax/application";
import {
  MCP_PROVIDER_CONTROL_PLANE_FLAG,
  MCP_RUNTIME_TOOL_BRIDGE_FLAG,
  MCP_TOOL_CATEGORY,
  MCP_TOOL_INVOCATION_FLAG,
  legacyTaskExecutionPolicy,
  taskExecutionPolicySchema,
  type Agent,
  type CreateMcpProviderInput,
  type CreateTaskInput,
  type McpProviderDetail,
  type Project,
  type RuntimeMcpToolRequest,
  type RuntimeMcpToolResult,
  type Task,
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
import {
  RuntimeToolRequestBridge,
  RuntimeToolRequestBridgeError,
} from "./runtime-tool-request-bridge.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl === undefined ? describe.skip : describe;
const admin = {
  principalId: "local-admin",
  platformAdministrator: true,
} as const;
const credentialRef = "env://M13C_MCP_TEST_TOKEN";
const rawCredential = `m13c-credential-${randomUUID()}`;
const inputSecret = `m13c-input-${randomUUID()}`;
const outputSecret = `m13c-output-${randomUUID()}`;

integration("M13c Agent Runtime MCP Tool Request bridge", () => {
  let database: Database;
  let repositories: PlatformRepositories;
  let application: PlatformApplication;
  let provider: McpProviderDetail;
  let project: Project;
  let agent: Agent;
  let bridge: RuntimeToolRequestBridge;
  let runtimeSummaryBaseline: Awaited<
    ReturnType<PlatformRepositories["runtimeToolRequests"]["summary"]>
  >;
  let workspaceRoot: string;
  let fileStoreRoot: string;
  let transportCalls = 0;
  let transportMode:
    | "success"
    | "timeout"
    | "cancel"
    | "unknown"
    | "deferred" = "success";
  let deferredStarted: (() => void) | undefined;
  let completionOrder: string[] = [];
  const logs: Array<{ readonly event: string; readonly data: unknown }> = [];
  const credentials: McpCredentialResolver = {
    resolve: async () => rawCredential,
  };
  const transport: McpToolCallTransport = {
    callTool: async (input, signal) => {
      transportCalls += 1;
      const orderId = String(input.arguments.orderId ?? "");
      if (orderId === "slow") {
        await new Promise((resolve) => setTimeout(resolve, 80));
      } else if (orderId === "fast") {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      completionOrder.push(orderId);
      if (transportMode === "timeout") {
        throw new McpToolCallFailure(
          "timeout",
          "runtime_tool_timeout",
          "Runtime Tool Request timed out",
        );
      }
      if (transportMode === "unknown") {
        throw new Error(`remote-body-${outputSecret}`);
      }
      if (transportMode === "cancel" || transportMode === "deferred") {
        deferredStarted?.();
        return new Promise<Record<string, unknown>>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () =>
              reject(
                new McpToolCallFailure(
                  "cancelled",
                  "runtime_tool_cancelled",
                  "Runtime Tool Request cancelled",
                ),
              ),
            { once: true },
          );
        });
      }
      return {
        content: [{ type: "text", text: outputSecret }],
        isError: false,
      };
    },
  };

  beforeAll(async () => {
    database = new Database(databaseUrl!);
    workspaceRoot = await mkdtemp(join(tmpdir(), "pluginmax-m13c-workspace-"));
    fileStoreRoot = await mkdtemp(join(tmpdir(), "pluginmax-m13c-files-"));
    repositories = new PlatformRepositories(database);
    application = new PlatformApplication(repositories);
    await migrate(database);
    runtimeSummaryBaseline =
      await repositories.runtimeToolRequests.summary();
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
    project = await application.createProject({
      name: `M13c Runtime ${randomUUID().slice(0, 8)}`,
      description: "M13c Runtime Tool Request fixture",
    });
    agent = await application.createAgent({
      name: `M13c Agent ${randomUUID().slice(0, 8)}`,
      description: "M13c Runtime Tool Request agent",
      soul: "Request governed MCP tools.",
      scenarios: ["M13c"],
      goals: ["Prove Runtime Tool Request bridging"],
      tools: [],
      runtimeKind: "fake",
      source: "platform",
    });
    await application.createProjectMember(project.id, {
      kind: "agent",
      agentId: agent.id,
      responsibility: "M13c Runtime Tool Requests",
      roleIds: [],
    });
    provider = await createActiveProvider();
    const toolCall = new McpToolCallService(
      repositories,
      {
        owner: "m13c-tool-worker",
        leaseSeconds: 30,
      },
      transport,
      credentials,
      (event, data = {}) => {
        logs.push({ event, data });
      },
    );
    bridge = new RuntimeToolRequestBridge(
      repositories,
      toolCall,
      {
        owner: "m13c-runtime-worker",
        leaseSeconds: 60,
      },
      (event, data = {}) => {
        logs.push({ event, data });
      },
    );
  });

  afterAll(async () => {
    await setFlag(MCP_RUNTIME_TOOL_BRIDGE_FLAG, false);
    await setFlag(MCP_TOOL_INVOCATION_FLAG, false);
    await setFlag(MCP_PROVIDER_CONTROL_PLANE_FLAG, false);
    await database.close();
  });

  async function setFlag(flagKey: string, enabled: boolean): Promise<void> {
    await repositories.featureFlags.set({
      flagKey,
      scopeType: "platform",
      scopeId: "platform",
      mode: enabled ? "on" : "off",
      updatedBy: "test:m13c",
    });
  }

  async function createActiveProvider(): Promise<McpProviderDetail> {
    const input: CreateMcpProviderInput = {
      providerKey: `m13c.runtime.${randomUUID().slice(0, 8)}`,
      name: "M13c Runtime Provider",
      description: "M13c Runtime Tool Request provider",
      transport: "streamable-http",
      endpointUrl: "https://m13c-runtime.example.test/mcp",
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
      "m13c-probe-worker",
      30,
    );
    expect(job?.probeId).toBe(requested.probe.id);
    await repositories.mcpProviders.completeProbeJob({
      probeId: requested.probe.id,
      owner: "m13c-probe-worker",
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
      reason: "M13c Runtime bridge activation",
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
        maxToolCalls: 20,
      },
    });
  }

  async function taskWithMcpPolicy(): Promise<Task> {
    const input: CreateTaskInput = {
      projectId: project.id,
      title: `M13c Runtime ${randomUUID().slice(0, 8)}`,
      description: "Runtime Tool Request bridge fixture",
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
        basis: "M13c Runtime bridge integration",
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

  async function executorAuthorizedRun(): Promise<{
    readonly runId: string;
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
        basis: "M13c RunExecutor adapter integration",
      },
      "local-admin",
    );
    const detail = await application.mcpProviders.get(
      admin,
      provider.provider.id,
    );
    return {
      runId: dispatched.runId,
      gateId: gate!.gateId,
      toolKey: detail.tools[0]!.toolKey,
    };
  }

  function runtimeRequest(input: {
    readonly runId: string;
    readonly gateId: string;
    readonly toolKey: string;
    readonly requestId?: string;
    readonly idempotencyKey?: string;
    readonly arguments?: Record<string, unknown>;
    readonly timeoutMs?: number;
  }): RuntimeMcpToolRequest {
    return {
      requestId: input.requestId ?? randomUUID(),
      toolKey: input.toolKey,
      gateId: input.gateId,
      idempotencyKey: input.idempotencyKey ?? `m13c-idem-${randomUUID()}`,
      arguments: input.arguments ?? {
        orderId: "order-42",
        note: inputSecret,
      },
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    };
  }

  it("is inert when the bridge flag is off", async () => {
    const run = await authorizedRun();
    const before = await countRuntimeState();
    const callsBefore = transportCalls;
    await setFlag(MCP_RUNTIME_TOOL_BRIDGE_FLAG, false);
    await expect(
      bridge.request({
        runId: run.runId,
        runAttempt: 1,
        request: runtimeRequest(run),
        assertLease: async () => undefined,
      }),
    ).rejects.toMatchObject({
      code: "mcp_runtime_tool_bridge_disabled",
      statusCode: 503,
    });
    expect(transportCalls).toBe(callsBefore);
    expect(await countRuntimeState()).toBe(before);
    await setFlag(MCP_RUNTIME_TOOL_BRIDGE_FLAG, true);
  });

  it("requires Ticket, Gate and Policy before creating a request", async () => {
    const run = await authorizedRun();
    const before = await countRuntimeState();
    await expect(
      bridge.request({
        runId: run.runId,
        runAttempt: 1,
        request: runtimeRequest({
          ...run,
          gateId: randomUUID(),
        }),
        assertLease: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: "execution_gate_missing" });
    expect(await countRuntimeState()).toBe(before);

    const original = await repositories.runs.get(run.runId);
    const noTicketRunId = randomUUID();
    await repositories.runs.enqueue({
      runId: noTicketRunId,
      task: run.task,
      agentId: agent.id,
      inputSnapshot: original!.inputSnapshot,
      executionEnvelope: original!.executionEnvelope!,
      observability: original!.observability,
    });
    await repositories.runs.markRunning(noTicketRunId);
    await expect(
      bridge.request({
        runId: noTicketRunId,
        runAttempt: 1,
        request: runtimeRequest({
          ...run,
          runId: noTicketRunId,
          gateId: randomUUID(),
        }),
        assertLease: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: "action_ticket_missing" });

    const noPolicyTask = await application.createTask({
      projectId: project.id,
      title: `M13c no policy ${randomUUID().slice(0, 8)}`,
      description: "No policy",
      acceptance: [],
      agentId: agent.id,
      autoSubmit: false,
    });
    const dispatched = await application.dispatchTask(
      noPolicyTask.id,
      undefined,
      "local-admin",
      true,
    );
    await repositories.runs.markRunning(dispatched.runId);
    await expect(
      bridge.request({
        runId: dispatched.runId,
        runAttempt: 1,
        request: runtimeRequest({
          ...run,
          runId: dispatched.runId,
          gateId: randomUUID(),
        }),
        assertLease: async () => undefined,
      }),
    ).rejects.toMatchObject({
      code: "runtime_tool_execution_envelope_missing",
    });
    expect(await countRuntimeState()).toBe(before);
  });

  it("does not turn Provider ownership, admin or Market Binding into authorization", async () => {
    const run = await authorizedRun();
    await bindProviderToMarket();
    const original = await repositories.runs.get(run.runId);
    const noTicketRunId = randomUUID();
    await repositories.runs.enqueue({
      runId: noTicketRunId,
      task: run.task,
      agentId: agent.id,
      inputSnapshot: original!.inputSnapshot,
      executionEnvelope: original!.executionEnvelope!,
      observability: original!.observability,
    });
    await repositories.runs.markRunning(noTicketRunId);
    await expect(
      bridge.request({
        runId: noTicketRunId,
        runAttempt: 1,
        request: runtimeRequest({
          ...run,
          runId: noTicketRunId,
          gateId: randomUUID(),
        }),
        assertLease: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: "action_ticket_missing" });
  });

  it("supports concurrent out-of-order completion and idempotent replay", async () => {
    const fastRun = await authorizedRun();
    const slowRun = await authorizedRun();
    completionOrder = [];
    const fast = bridge.request({
      runId: fastRun.runId,
      runAttempt: 1,
      request: runtimeRequest({
        ...fastRun,
        arguments: { orderId: "fast", note: inputSecret },
      }),
      assertLease: async () => undefined,
    });
    const slow = bridge.request({
      runId: slowRun.runId,
      runAttempt: 1,
      request: runtimeRequest({
        ...slowRun,
        arguments: { orderId: "slow", note: inputSecret },
      }),
      assertLease: async () => undefined,
    });
    const [fastResult, slowResult] = await Promise.all([fast, slow]);
    expect(fastResult.status, JSON.stringify(fastResult)).toBe("succeeded");
    expect(slowResult.status, JSON.stringify(slowResult)).toBe("succeeded");
    expect(completionOrder).toEqual(["fast", "slow"]);

    const replayRun = await authorizedRun();
    const request = runtimeRequest({
      ...replayRun,
      idempotencyKey: "m13c-replay-once",
    });
    const first = await bridge.request({
      runId: replayRun.runId,
      runAttempt: 1,
      request,
      assertLease: async () => undefined,
    });
    const callsAfterFirst = transportCalls;
    const replay = await bridge.request({
      runId: replayRun.runId,
      runAttempt: 1,
      request,
      assertLease: async () => undefined,
    });
    expect(replay.requestId).toBe(first.requestId);
    expect(replay.deduplicated).toBe(true);
    expect(replay.resultAvailable).toBe(false);
    expect(transportCalls).toBe(callsAfterFirst);
    await expect(
      bridge.request({
        runId: replayRun.runId,
        runAttempt: 1,
        request: {
          ...request,
          arguments: { orderId: "different", note: inputSecret },
        },
        assertLease: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: "runtime_tool_idempotency_conflict" });
  });

  it("converges on Run cancellation without another Provider call", async () => {
    transportMode = "deferred";
    const run = await authorizedRun();
    const controller = new AbortController();
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    deferredStarted = () => markStarted?.();
    const pending = bridge.request({
      runId: run.runId,
      runAttempt: 1,
      request: runtimeRequest({
        ...run,
        arguments: { orderId: "cancel-me", note: inputSecret },
      }),
      signal: controller.signal,
      assertLease: async () => undefined,
    });
    await started;
    const callsBeforeCancel = transportCalls;
    await repositories.runs.cancel(run.runId, "local-admin", "M13c cancel");
    controller.abort(new Error("cancelled"));
    const result = await pending;
    expect(result.status).toBe("cancelled");
    expect(transportCalls).toBe(callsBeforeCancel);
    transportMode = "success";
    deferredStarted = undefined;
  });

  it("classifies timeout, remote errors and Worker lease loss", async () => {
    transportMode = "timeout";
    const timeoutRun = await authorizedRun();
    const timeout = await bridge.request({
      runId: timeoutRun.runId,
      runAttempt: 1,
      request: runtimeRequest({
        ...timeoutRun,
        timeoutMs: 1_000,
      }),
      assertLease: async () => undefined,
    });
    expect(timeout).toMatchObject({
      status: "timed_out",
      errorCategory: "timeout",
    });

    transportMode = "cancel";
    const cancelRun = await authorizedRun();
    const controller = new AbortController();
    const cancelledPromise = bridge.request({
      runId: cancelRun.runId,
      runAttempt: 1,
      request: runtimeRequest(cancelRun),
      signal: controller.signal,
      assertLease: async () => undefined,
    });
    setTimeout(() => controller.abort(new Error("cancel tool request")), 20);
    const cancelled = await cancelledPromise;
    expect(cancelled).toMatchObject({
      status: "cancelled",
      errorCategory: "cancelled",
    });

    transportMode = "unknown";
    const failedRun = await authorizedRun();
    const failed = await bridge.request({
      runId: failedRun.runId,
      runAttempt: 1,
      request: runtimeRequest(failedRun),
      assertLease: async () => undefined,
    });
    expect(failed).toMatchObject({
      status: "failed",
      errorCategory: "unknown",
    });

    transportMode = "success";
    const leaseRun = await authorizedRun();
    let checks = 0;
    const leaseLost = await bridge.request({
      runId: leaseRun.runId,
      runAttempt: 1,
      request: runtimeRequest(leaseRun),
      assertLease: async () => {
        checks += 1;
        if (checks >= 2) throw new RunLeaseLostError();
      },
    });
    expect(leaseLost).toMatchObject({
      status: "interrupted",
      errorCode: "runtime_tool_lease_lost",
    });
  });

  it("keeps request receipts and Provider audit append-only and redacted", async () => {
    const run = await authorizedRun();
    const result = await bridge.request({
      runId: run.runId,
      runAttempt: 1,
      request: runtimeRequest(run),
      assertLease: async () => undefined,
    });
    expect(result.status).toBe("succeeded");
    const summary = await repositories.runtimeToolRequests.summary();
    expect(summary).toMatchObject({
      total: runtimeSummaryBaseline.total + 9,
      succeeded: runtimeSummaryBaseline.succeeded + 4,
      failed: runtimeSummaryBaseline.failed + 1,
      timedOut: runtimeSummaryBaseline.timedOut + 1,
      cancelled: runtimeSummaryBaseline.cancelled + 2,
      interrupted: runtimeSummaryBaseline.interrupted + 1,
      staleRunning: runtimeSummaryBaseline.staleRunning,
    });
    const state = await database.query<{ readonly payload: string }>(
      `SELECT (
         COALESCE(
           (SELECT jsonb_agg(to_jsonb(request))::text
            FROM runtime_tool_requests AS request
            WHERE request.run_id = $1),
           '[]'
         ) ||
         COALESCE(
           (SELECT jsonb_agg(to_jsonb(receipt))::text
            FROM runtime_tool_request_receipts AS receipt
            JOIN runtime_tool_requests AS request
              ON request.request_id = receipt.request_id
            WHERE request.run_id = $1),
           '[]'
         ) ||
         COALESCE(
           (SELECT jsonb_agg(to_jsonb(call))::text
            FROM mcp_tool_calls AS call
            WHERE call.run_id = $1),
           '[]'
         ) ||
         COALESCE(
           (SELECT jsonb_agg(to_jsonb(call_receipt))::text
            FROM mcp_tool_call_receipts AS call_receipt
            JOIN mcp_tool_calls AS call ON call.id = call_receipt.call_id
            WHERE call.run_id = $1),
           '[]'
         ) ||
         COALESCE(
           (SELECT jsonb_agg(to_jsonb(audit))::text
            FROM mcp_provider_audit_events AS audit
            WHERE audit.provider_id = $2),
           '[]'
         )
       ) AS payload`,
      [run.runId, provider.provider.id],
    );
    const serialized = JSON.stringify({ state: state.rows, logs });
    expect(serialized).not.toContain(inputSecret);
    expect(serialized).not.toContain(outputSecret);
    expect(serialized).not.toContain(rawCredential);
    expect(serialized).not.toContain(credentialRef);

    const requestReceipt = await database.query<{ readonly id: string }>(
      `SELECT receipt.id
       FROM runtime_tool_request_receipts AS receipt
       JOIN runtime_tool_requests AS request
         ON request.request_id = receipt.request_id
       WHERE request.run_id = $1
       LIMIT 1`,
      [run.runId],
    );
    await expect(
      database.query(
        "UPDATE runtime_tool_request_receipts SET error_code = 'changed' WHERE id = $1",
        [requestReceipt.rows[0]!.id],
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      database.query(
        "UPDATE mcp_provider_audit_events SET reason = 'changed' WHERE provider_id = $1",
        [provider.provider.id],
      ),
    ).rejects.toThrow(/append-only/);

    const events = await repositories.runs.listEvents(run.runId);
    expect(events.some((event) => event.type === "tool.call")).toBe(true);
    expect(events.some((event) => event.type === "tool.result")).toBe(true);
  });

  it("lets a Runtime Adapter consume the Worker Tool Request result", async () => {
    const run = await executorAuthorizedRun();
    const job = await repositories.jobs.claimNext(
      "m13c-executor-worker",
      30,
      run.runId,
    );
    expect(job).toBeDefined();
    const request = runtimeRequest({
      ...run,
      idempotencyKey: "m13c-executor-tool-request",
      arguments: {
        orderId: "executor-order",
        note: inputSecret,
      },
    });
    let deliveredResult: RuntimeMcpToolResult | undefined;
    const adapter: AgentRuntimeAdapter = {
      id: "m13c-structured-tool-request",
      mcpToolRequestProtocol: "structured-v1",
      async *execute(input) {
        yield {
          type: "progress",
          summary: "Preparing a structured MCP Tool Request",
        };
        let complete:
          | ((result: RuntimeMcpToolResult) => void)
          | undefined;
        const result = new Promise<RuntimeMcpToolResult>((resolve) => {
          complete = resolve;
        });
        yield {
          type: "tool.request",
          request,
          complete: (toolResult) => complete?.(toolResult),
        };
        deliveredResult = await result;
        expect(input.requestMcpTool).toBeDefined();
        yield {
          type: "completed",
          output: "Structured MCP Tool Request completed.",
        };
      },
    };
    const executor = new RunExecutor(repositories, {
      workspaceRoot,
      fileStoreRoot,
      runtimeEffectPollIntervalMs: 20,
      runtimeToolBridge: bridge,
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
      jobId: job!.id,
      jobAttempt: job!.attempts,
      owner: "m13c-executor-worker",
      leaseSeconds: 30,
      leaseRenewIntervalMs: 1_000,
      assertLease: async () => {
        const owned = await repositories.jobs.hasLease(
          job!.id,
          "m13c-executor-worker",
          job!.leaseToken,
        );
        if (!owned) throw new RunLeaseLostError();
      },
    });
    expect(deliveredResult).toMatchObject({
      requestId: request.requestId,
      status: "succeeded",
      resultAvailable: true,
    });
    expect(deliveredResult?.result).toMatchObject({
      content: [{ type: "text", text: outputSecret }],
    });
    const stored =
      await repositories.runtimeToolRequests.findByRequestId(
        request.requestId,
      );
    expect(stored?.request).toMatchObject({
      runId: run.runId,
      status: "succeeded",
      callId: deliveredResult?.callId,
    });
    expect(JSON.stringify(stored)).not.toContain(inputSecret);
    expect(JSON.stringify(stored)).not.toContain(outputSecret);
  });

  it("handles a bounded concurrent burst across independent Runs", async () => {
    const runs = [];
    for (let index = 0; index < 12; index += 1) {
      runs.push(await authorizedRun());
    }
    const results = await Promise.all(
      runs.map((run, index) =>
        bridge.request({
          runId: run.runId,
          runAttempt: 1,
          request: runtimeRequest({
            ...run,
            idempotencyKey: `m13c-capacity-${index}`,
            arguments: {
              orderId: `capacity-${index}`,
              note: inputSecret,
            },
          }),
          assertLease: async () => undefined,
        }),
      ),
    );
    expect(results.every((result) => result.status === "succeeded")).toBe(
      true,
    );
    const summary = await repositories.runtimeToolRequests.summary();
    expect(summary.total).toBeGreaterThanOrEqual(22);
    expect(summary.succeeded).toBeGreaterThanOrEqual(17);
    expect(summary.staleRunning).toBe(0);
  });

  it("raises a critical alert for stale Running requests and reconciles them", async () => {
    const run = await authorizedRun();
    const storedRun = await repositories.runs.get(run.runId);
    const ticket = await repositories.actionTickets.getByRun(run.runId);
    expect(storedRun?.executionEnvelope).not.toBeNull();
    expect(ticket).toBeDefined();
    const requestId = randomUUID();
    await database.query(
      `INSERT INTO runtime_tool_requests (
         request_id, run_id, run_attempt, task_id, project_id, agent_id,
         agent_principal_id, tool_key, ticket_id, gate_id, policy_id,
         policy_revision, envelope_id, envelope_digest, idempotency_key,
         request_digest, status, input_summary, lease_owner, lease_token,
         lease_expires_at, started_at, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
         $15, $16, 'running', '{"argumentKeys":[],"argumentCount":0,"inputBytes":0}'::jsonb,
         'm13c-stale-worker', $17, NOW() - INTERVAL '1 minute',
         NOW() - INTERVAL '2 minutes', NOW() - INTERVAL '2 minutes',
         NOW() - INTERVAL '2 minutes'
       )`,
      [
        requestId,
        storedRun!.id,
        storedRun!.attempt,
        storedRun!.taskId,
        storedRun!.projectId,
        storedRun!.agentId,
        storedRun!.executionEnvelope!.agentPrincipalId,
        run.toolKey,
        ticket!.ticketId,
        run.gateId,
        storedRun!.executionEnvelope!.policy.id,
        storedRun!.executionEnvelope!.policy.revision,
        storedRun!.executionEnvelope!.id,
        storedRun!.executionEnvelope!.digest,
        "m13c-stale-request",
        "a".repeat(64),
        randomUUID(),
      ],
    );
    const stale = await repositories.runtimeToolRequests.summary();
    expect(stale).toMatchObject({
      staleRunning: 1,
      alertLevel: "critical",
    });
    expect(stale.alertReasons).toContain("stale_running");
    expect(
      await repositories.runtimeToolRequests.reconcileExpired(),
    ).toBeGreaterThanOrEqual(1);
    const reconciled = await repositories.runtimeToolRequests.summary();
    expect(reconciled.running).toBe(0);
    expect(reconciled.staleRunning).toBe(0);
  });

  it("rejects forged runtime context fields at the contract boundary", async () => {
    const run = await authorizedRun();
    await expect(
      bridge.request({
        runId: run.runId,
        runAttempt: 1,
        request: {
          ...runtimeRequest(run),
          runId: randomUUID(),
        } as RuntimeMcpToolRequest,
        assertLease: async () => undefined,
      }),
    ).rejects.toBeInstanceOf(RuntimeToolRequestBridgeError);
  });

  async function countRuntimeState(): Promise<string> {
    const result = await database.query<{ readonly count: string }>(
      `SELECT (
         (SELECT COUNT(*) FROM runtime_tool_requests) +
         (SELECT COUNT(*) FROM runtime_tool_request_receipts) +
         (SELECT COUNT(*) FROM mcp_tool_calls) +
         (SELECT COUNT(*) FROM mcp_tool_call_receipts) +
         (SELECT COUNT(*) FROM mcp_provider_audit_events)
       )::text AS count`,
    );
    return result.rows[0]?.count ?? "0";
  }

  async function bindProviderToMarket(): Promise<void> {
    const assetId = randomUUID();
    const versionId = randomUUID();
    await database.query(
      `INSERT INTO market_assets (
         id, asset_key, kind, name, description, publisher_principal_id,
         origin, sharing_scope, publication_status, availability_status,
         current_version, revision, created_at, updated_at
       ) VALUES (
         $1, $2, 'skill', 'M13c Market Provider',
         'Binding must not grant Runtime Tool execution', 'local-admin',
         'user', 'private', 'published', 'active', 1, 1, NOW(), NOW()
       )`,
      [assetId, `m13c.market.${randomUUID().slice(0, 12)}`],
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
        provider.provider.id,
        provider.provider.currentVersionId,
      ],
    );
  }
});
