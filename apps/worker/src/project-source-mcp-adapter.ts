import { createHash } from "node:crypto";
import type {
  RuntimeToolBridgePort,
  RuntimeToolBridgeRequest,
} from "@pluginmax/application";
import {
  BUSINESS_CHAIN_FLAG,
  MCP_PROJECT_SOURCE_FLAG,
  MCP_PROJECT_SOURCE_READ_PROTOCOL,
  MCP_PROVIDER_CONTROL_PLANE_FLAG,
  MCP_RUNTIME_TOOL_BRIDGE_FLAG,
  MCP_TOOL_CATEGORY,
  MCP_TOOL_INVOCATION_FLAG,
  projectSourceMcpReadIntentSchema,
  projectSourceMcpToolArgumentsSchema,
  projectSourceMcpToolDataSchema,
  type ProjectAlertObservation,
  type ProjectSourceFetchResult,
  type ProjectSourceMcpReadIntent,
  type ProjectSourceMcpReadResult,
  type ProjectSourceMcpReadSummary,
  type RuntimeMcpToolResult,
} from "@pluginmax/contracts";
import type {
  PlatformRepositories,
  ResolvedMcpProjectSourceBinding,
} from "@pluginmax/database";

export class ProjectSourceMcpAdapterError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 409,
  ) {
    super(message);
    this.name = "ProjectSourceMcpAdapterError";
  }
}

export interface ProjectSourceMcpReadContext {
  readonly signal?: AbortSignal | undefined;
  readonly assertLease: () => Promise<void>;
}

export class McpProjectSourceAdapter {
  readonly port = "worker-only" as const;
  readonly mode = "read-only" as const;
  private readonly inFlight = new Map<
    string,
    Promise<ProjectSourceMcpReadResult>
  >();

  constructor(
    private readonly repositories: PlatformRepositories,
    private readonly bridge: RuntimeToolBridgePort,
    private readonly options: {
      readonly owner: string;
      readonly leaseSeconds?: number;
      readonly now?: () => Date;
    },
    private readonly log?: (
      event: string,
      data?: Record<string, unknown>,
    ) => void,
  ) {}

  async read(
    input: ProjectSourceMcpReadIntent,
    context: ProjectSourceMcpReadContext,
  ): Promise<ProjectSourceMcpReadResult> {
    const intent = parseIntent(input);
    await this.requireEnabled(intent.projectId);
    const binding = await this.repositories.projectSourceMcp.resolveBinding({
      projectId: intent.projectId,
      refKey: intent.refKey,
      businessChains: this.repositories.projectBusinessChains,
    });
    if (binding === undefined) {
      throw new ProjectSourceMcpAdapterError(
        "project_source_mcp_binding_invalid",
        "The project source binding is missing, changed or not ready",
        409,
      );
    }
    const run = await this.repositories.runs.get(intent.runId);
    if (
      run === undefined ||
      run.projectId !== intent.projectId ||
      run.attempt !== intent.runAttempt ||
      run.status !== "running" ||
      run.taskId === null ||
      run.executionEnvelope === null ||
      run.executionEnvelope.policy.id === null
    ) {
      throw new ProjectSourceMcpAdapterError(
        "project_source_mcp_run_invalid",
        "A running Run on the same Project attempt is required",
        409,
      );
    }
    const [ticket, gate, policy] = await Promise.all([
      this.repositories.actionTickets.getByRun(run.id),
      this.repositories.actionTickets.getGate(intent.gateId),
      this.repositories.taskExecutionPolicies.getRevision(
        run.executionEnvelope.policy.id ?? "",
        run.executionEnvelope.policy.revision,
      ),
    ]);
    if (ticket === undefined || gate === undefined || policy === undefined) {
      throw new ProjectSourceMcpAdapterError(
        "project_source_mcp_authorization_missing",
        "Project source reads require Ticket, Gate and Policy revision",
        403,
      );
    }
    if (
      !ticket.resourceScopes.includes(`tool:${MCP_TOOL_CATEGORY}`) ||
      !ticket.resourceScopes.includes("source:connector-data") ||
      gate.ticketId !== ticket.ticketId ||
      gate.requestedToolCategory !== MCP_TOOL_CATEGORY ||
      gate.enforcement !== "blocking"
    ) {
      throw new ProjectSourceMcpAdapterError(
        "project_source_mcp_scope_mismatch",
        "The Ticket or Gate is not scoped for connector reads",
        403,
      );
    }
    const argumentsValue = projectSourceMcpToolArgumentsSchema.parse({
      protocol: MCP_PROJECT_SOURCE_READ_PROTOCOL,
      projectId: intent.projectId,
      refKey: binding.ref.refKey,
      sourceSystem: binding.ref.sourceSystem,
      objectType: binding.ref.objectType,
      objectId: binding.ref.objectId,
      path: binding.ref.path,
    });
    const requestDigest = digest(
      stableJson({
        intent,
        binding: binding.sourceBindingDigest,
        providerVersionId: binding.providerVersionId,
        providerRevision: binding.providerRevision,
        toolKey: binding.toolKey,
        arguments: argumentsValue,
      }),
    );
    const begun = await this.repositories.projectSourceMcp.begin({
      requestId: intent.requestId,
      binding,
      runId: run.id,
      runAttempt: run.attempt,
      ticketId: ticket.ticketId,
      gateId: gate.gateId,
      policyId: run.executionEnvelope.policy.id!,
      policyRevision: run.executionEnvelope.policy.revision,
      envelopeId: run.executionEnvelope.id,
      envelopeDigest: run.executionEnvelope.digest,
      idempotencyKey: intent.idempotencyKey,
      requestDigest,
      leaseOwner: this.options.owner,
      leaseSeconds: this.leaseSeconds(intent.timeoutMs),
    });
    if (begun.kind === "idempotency_conflict") {
      throw new ProjectSourceMcpAdapterError(
        "project_source_mcp_idempotency_conflict",
        "The idempotency key was used with a different source binding",
        409,
      );
    }
    if (begun.kind === "replay") {
      return resultFromRecord(begun.record, true);
    }
    if (begun.kind === "in_progress") {
      const pending = this.inFlight.get(this.inFlightKey(intent, binding));
      if (pending !== undefined) {
        return {
          ...(await pending),
          deduplicated: true,
        };
      }
      return resultFromRecord(begun.record, true);
    }

    const operation = this.execute({
      intent,
      binding,
      requestDigest,
      leaseToken: begun.leaseToken,
      argumentsValue,
      context,
    });
    const key = this.inFlightKey(intent, binding);
    this.inFlight.set(key, operation);
    try {
      return await operation;
    } finally {
      this.inFlight.delete(key);
    }
  }

  async reconcileExpired(limit = 50): Promise<number> {
    if (
      !(await this.repositories.featureFlags.isEnabled(
        MCP_PROJECT_SOURCE_FLAG,
      ))
    ) {
      return 0;
    }
    return this.repositories.projectSourceMcp.reconcileExpired(limit);
  }

  async summary(): Promise<ProjectSourceMcpReadSummary> {
    return this.repositories.projectSourceMcp.summary();
  }

  private async execute(input: {
    readonly intent: ProjectSourceMcpReadIntent;
    readonly binding: ResolvedMcpProjectSourceBinding;
    readonly requestDigest: string;
    readonly leaseToken: string;
    readonly argumentsValue: ReturnType<
      typeof projectSourceMcpToolArgumentsSchema.parse
    >;
    readonly context: ProjectSourceMcpReadContext;
  }): Promise<ProjectSourceMcpReadResult> {
    this.log?.("project_source_mcp.started", {
      requestId: input.intent.requestId,
      projectId: input.intent.projectId,
      refKey: input.binding.ref.refKey,
      providerId: input.binding.providerId,
      providerVersion: input.binding.providerVersion,
      toolKey: input.binding.toolKey,
    });
    try {
      await input.context.assertLease();
      const bridgeRequest: RuntimeToolBridgeRequest = {
        runId: input.intent.runId,
        runAttempt: input.intent.runAttempt,
        request: {
          requestId: input.intent.requestId,
          toolKey: input.binding.toolKey,
          gateId: input.intent.gateId,
          idempotencyKey: input.intent.idempotencyKey,
          arguments: input.argumentsValue,
          ...(input.intent.timeoutMs === undefined
            ? {}
            : { timeoutMs: input.intent.timeoutMs }),
        },
        ...(input.context.signal === undefined
          ? {}
          : { signal: input.context.signal }),
        assertLease: input.context.assertLease,
      };
      const bridgeResult = await this.bridge.request(bridgeRequest);
      if (bridgeResult.status !== "succeeded") {
        const errorCategory =
          bridgeResult.status === "interrupted" &&
          (bridgeResult.errorCode ?? "").includes("lease")
            ? "interrupted"
            : (bridgeResult.errorCategory ?? "unknown");
        const result = failureFetchResult(
          input.binding,
          bridgeResult,
          this.now(),
          errorCategory,
        );
        return this.complete({
          requestId: input.intent.requestId,
          leaseToken: input.leaseToken,
          status: bridgeResult.status,
          result,
          runtimeRequestId: bridgeResult.requestId,
          callId: bridgeResult.callId,
          errorCategory,
          errorCode: bridgeResult.errorCode ?? "project_source_read_failed",
          errorMessage:
            bridgeResult.errorMessage ?? "The MCP project source read failed",
        });
      }
      if (!bridgeResult.resultAvailable || bridgeResult.result === undefined) {
        throw new ProjectSourceMcpAdapterError(
          "project_source_mcp_result_unavailable",
          "The authorized source result is no longer available in memory",
          409,
        );
      }
      const data = parseSourceData(bridgeResult.result);
      const safePayload = sanitizePayload(data.payload);
      this.log?.("project_source_mcp.protocol_parsed", {
        requestId: input.intent.requestId,
        alertCount: data.alerts.length,
        payloadKeys:
          safePayload !== null &&
          typeof safePayload === "object" &&
          !Array.isArray(safePayload)
            ? Object.keys(safePayload as Record<string, unknown>)
                .sort()
                .slice(0, 20)
            : [],
      });
      const observedAt = new Date(data.observedAt);
      const freshUntil =
        data.freshUntil === null ? null : new Date(data.freshUntil);
      const fetchResult: ProjectSourceFetchResult = {
        refKey: input.binding.ref.refKey,
        sourceKind: "mcp",
        sourceSystem: input.binding.ref.sourceSystem,
        objectType: input.binding.ref.objectType,
        objectId: input.binding.ref.objectId,
        sourceRevision: data.sourceRevision,
        observedAt: observedAt.toISOString(),
        effectiveAt:
          data.effectiveAt === null ? null : new Date(data.effectiveAt).toISOString(),
        freshUntil: freshUntil?.toISOString() ?? null,
        status:
          freshUntil !== null && freshUntil.getTime() > observedAt.getTime()
            ? "fresh"
            : "stale",
        payload: safePayload,
        failureReason: null,
        isMock: false,
      };
      const completed = await this.complete({
        requestId: input.intent.requestId,
        leaseToken: input.leaseToken,
        status: "succeeded",
        result: fetchResult,
        runtimeRequestId: bridgeResult.requestId,
        callId: bridgeResult.callId,
        errorCategory: null,
        errorCode: null,
        errorMessage: null,
      });
      try {
        await this.observeAlerts(
          input.intent,
          input.binding,
          data.alerts,
          observedAt,
        );
      } catch (error) {
        this.log?.("project_source_mcp.alert_projection_failed", {
          requestId: input.intent.requestId,
          projectId: input.intent.projectId,
          refKey: input.binding.ref.refKey,
          errorName: error instanceof Error ? error.name : "unknown",
        });
      }
      return completed;
    } catch (error) {
      this.log?.("project_source_mcp.execute_failed", {
        requestId: input.intent.requestId,
        projectId: input.intent.projectId,
        refKey: input.binding.ref.refKey,
        errorName: error instanceof Error ? error.name : "unknown",
      });
      if (isAborted(input.context.signal)) {
        return this.completeFailure(input, {
          status: "cancelled",
          category: "cancelled",
          code: "project_source_read_cancelled",
          message: "The MCP project source read was cancelled",
        });
      }
      const failure = classifyFailure(error);
      return this.completeFailure(input, failure);
    }
  }

  private async completeFailure(
    input: {
      readonly intent: ProjectSourceMcpReadIntent;
      readonly binding: ResolvedMcpProjectSourceBinding;
      readonly leaseToken: string;
    },
    failure: {
      readonly status:
        | "failed"
        | "timed_out"
        | "cancelled"
        | "interrupted";
      readonly category: string;
      readonly code: string;
      readonly message: string;
    },
  ): Promise<ProjectSourceMcpReadResult> {
    const existing = await this.repositories.projectSourceMcp.get(
      input.intent.requestId,
    );
    if (existing !== undefined && existing.status !== "running") {
      return resultFromRecord(existing, false);
    }
    const call = await this.repositories.mcpToolCalls.findByRunAndIdempotency({
      runId: input.intent.runId,
      idempotencyKey: input.intent.idempotencyKey,
    });
    const result: ProjectSourceFetchResult = {
      refKey: input.binding.ref.refKey,
      sourceKind: "mcp",
      sourceSystem: input.binding.ref.sourceSystem,
      objectType: input.binding.ref.objectType,
      objectId: input.binding.ref.objectId,
      sourceRevision: null,
      observedAt: this.now().toISOString(),
      effectiveAt: null,
      freshUntil: null,
      status: "error",
      payload: null,
      failureReason: `${failure.category}:${failure.code}`,
      isMock: false,
    };
    const completed = await this.repositories.projectSourceMcp.complete({
      requestId: input.intent.requestId,
      leaseOwner: this.options.owner,
      leaseToken: input.leaseToken,
      status: failure.status,
      result,
      runtimeRequestId: null,
      callId: call?.call.id ?? null,
      errorCategory: failure.category,
      errorCode: failure.code,
      errorMessage: failure.message,
    });
    if (completed.kind === "claim_lost") {
      throw new ProjectSourceMcpAdapterError(
        "project_source_mcp_lease_lost",
        "The project source Worker lease was lost",
        409,
      );
    }
    try {
      await this.observeFailureAlert(
        input.intent,
        input.binding,
        failure,
      );
    } catch (error) {
      this.log?.("project_source_mcp.alert_projection_failed", {
        requestId: input.intent.requestId,
        projectId: input.intent.projectId,
        refKey: input.binding.ref.refKey,
        errorName: error instanceof Error ? error.name : "unknown",
      });
    }
    return resultFromRecord(completed.record, false);
  }

  private async complete(input: {
    readonly requestId: string;
    readonly leaseToken: string;
    readonly status: "succeeded" | "failed" | "timed_out" | "cancelled" | "interrupted";
    readonly result: ProjectSourceFetchResult;
    readonly runtimeRequestId: string | null;
    readonly callId: string | null;
    readonly errorCategory: string | null;
    readonly errorCode: string | null;
    readonly errorMessage: string | null;
  }): Promise<ProjectSourceMcpReadResult> {
    const completed = await this.repositories.projectSourceMcp.complete({
      requestId: input.requestId,
      leaseOwner: this.options.owner,
      leaseToken: input.leaseToken,
      status: input.status,
      result: input.result,
      runtimeRequestId: input.runtimeRequestId,
      callId: input.callId,
      errorCategory: input.errorCategory,
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
    });
    if (completed.kind === "claim_lost") {
      throw new ProjectSourceMcpAdapterError(
        "project_source_mcp_lease_lost",
        "The project source Worker lease was lost",
        409,
      );
    }
    this.log?.("project_source_mcp.completed", {
      requestId: completed.record.requestId,
      projectId: completed.record.projectId,
      refKey: completed.record.refKey,
      status: completed.record.status,
      sourceRevision: completed.record.sourceRevision,
      snapshotId: completed.record.snapshotId,
    });
    return resultFromRecord(completed.record, false);
  }

  private async observeAlerts(
    intent: ProjectSourceMcpReadIntent,
    binding: ResolvedMcpProjectSourceBinding,
    alerts: readonly Omit<ProjectAlertObservation, "observedAt">[],
    observedAt: Date,
  ): Promise<void> {
    this.log?.("project_source_mcp.alert_projection_started", {
      requestId: intent.requestId,
      projectId: intent.projectId,
      refKey: binding.ref.refKey,
      alertCount: alerts.length,
    });
    for (const alert of alerts) {
      await this.repositories.projectBusinessChains.observeAlert({
        projectId: intent.projectId,
        actorId: this.options.owner,
        observation: {
          ...alert,
          sourceSystem: binding.ref.sourceSystem,
          sourceObjectType: binding.ref.objectType,
          sourceObjectId: binding.ref.objectId,
          observedAt: observedAt.toISOString(),
        },
      });
    }
    this.log?.("project_source_mcp.alert_projection_completed", {
      requestId: intent.requestId,
      projectId: intent.projectId,
      refKey: binding.ref.refKey,
      alertCount: alerts.length,
    });
  }

  private async observeFailureAlert(
    intent: ProjectSourceMcpReadIntent,
    binding: ResolvedMcpProjectSourceBinding,
    failure: {
      readonly category: string;
      readonly code: string;
      readonly message: string;
    },
  ): Promise<void> {
    await this.repositories.projectBusinessChains.observeAlert({
      projectId: intent.projectId,
      actorId: this.options.owner,
      observation: {
        sourceSystem: binding.ref.sourceSystem,
        sourceObjectType: binding.ref.objectType,
        sourceObjectId: binding.ref.objectId,
        conditionCode: `MCP_SOURCE_${failure.category.toUpperCase()}`,
        title: "项目来源读取失败",
        message: failure.message,
        severity:
          failure.category === "timeout" ||
          failure.category === "interrupted"
            ? "critical"
            : "warning",
        sourceRevision: null,
        observedAt: this.now().toISOString(),
        linkedNodeIds: [],
        linkedTaskIds: [],
        followTargetId: null,
      },
    });
  }

  private async requireEnabled(projectId: string): Promise<void> {
    if (
      !(await this.repositories.featureFlags.isEnabled(
        MCP_PROJECT_SOURCE_FLAG,
      ))
    ) {
      throw new ProjectSourceMcpAdapterError(
        "project_source_mcp_disabled",
        "The MCP project source feature is disabled",
        503,
      );
    }
    const [businessChain, controlPlane, invocation, bridge] = await Promise.all([
      this.repositories.projectBusinessChains.getFeatureFlagState(
        BUSINESS_CHAIN_FLAG,
        projectId,
      ),
      this.repositories.featureFlags.isEnabled(
        MCP_PROVIDER_CONTROL_PLANE_FLAG,
      ),
      this.repositories.featureFlags.isEnabled(MCP_TOOL_INVOCATION_FLAG),
      this.repositories.featureFlags.isEnabled(MCP_RUNTIME_TOOL_BRIDGE_FLAG),
    ]);
    if (!businessChain.enabled) {
      throw new ProjectSourceMcpAdapterError(
        "project_business_chain_disabled",
        "Project business chains are disabled",
        503,
      );
    }
    if (!controlPlane || !invocation || !bridge) {
      throw new ProjectSourceMcpAdapterError(
        "project_source_mcp_execution_disabled",
        "The MCP execution chain is disabled",
        503,
      );
    }
  }

  private leaseSeconds(timeoutMs = 0): number {
    return Math.max(
      this.options.leaseSeconds ?? 300,
      Math.ceil(timeoutMs / 1_000) + 60,
    );
  }

  private inFlightKey(
    intent: ProjectSourceMcpReadIntent,
    binding: ResolvedMcpProjectSourceBinding,
  ): string {
    return `${intent.projectId}:${binding.sourceBindingDigest}:${binding.ref.refKey}:${intent.idempotencyKey}`;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

function parseIntent(input: ProjectSourceMcpReadIntent): ProjectSourceMcpReadIntent {
  try {
    return projectSourceMcpReadIntentSchema.parse(input);
  } catch {
    throw new ProjectSourceMcpAdapterError(
      "project_source_mcp_intent_invalid",
      "The MCP project source read intent is invalid",
      400,
    );
  }
}

function parseSourceData(
  result: Record<string, unknown>,
): ReturnType<typeof projectSourceMcpToolDataSchema.parse> {
  const structured = result.structuredContent;
  if (structured !== undefined) {
    return projectSourceMcpToolDataSchema.parse(structured);
  }
  const content = Array.isArray(result.content) ? result.content : [];
  for (const item of content) {
    if (
      typeof item === "object" &&
      item !== null &&
      (item as { readonly type?: unknown }).type === "text" &&
      typeof (item as { readonly text?: unknown }).text === "string"
    ) {
      try {
        return projectSourceMcpToolDataSchema.parse(
          JSON.parse((item as { readonly text: string }).text),
        );
      } catch {
        continue;
      }
    }
  }
  try {
    return projectSourceMcpToolDataSchema.parse(result);
  } catch {
    throw new ProjectSourceMcpAdapterError(
      "project_source_mcp_protocol_invalid",
      "The MCP source Tool did not return the read-only protocol payload",
      502,
    );
  }
}

function sanitizePayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizePayload);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(
          ([key]) =>
            !/(?:credential|secret|token|authorization|password|private.?key|endpoint|header)/i.test(
              key,
            ),
        )
        .map(([key, item]) => [key, sanitizePayload(item)]),
    );
  }
  if (
    typeof value === "string" &&
    /^(?:env|secret):\/\//.test(value)
  ) {
    return "[redacted]";
  }
  return value;
}

function failureFetchResult(
  binding: ResolvedMcpProjectSourceBinding,
  bridgeResult: RuntimeMcpToolResult,
  now: Date,
  errorCategory: string,
): ProjectSourceFetchResult {
  return {
    refKey: binding.ref.refKey,
    sourceKind: "mcp",
    sourceSystem: binding.ref.sourceSystem,
    objectType: binding.ref.objectType,
    objectId: binding.ref.objectId,
    sourceRevision: null,
    observedAt: now.toISOString(),
    effectiveAt: null,
    freshUntil: null,
    status: "error",
    payload: null,
    failureReason:
      `${errorCategory}:` +
      `${bridgeResult.errorCode ?? "project_source_read_failed"}`,
    isMock: false,
  };
}

function resultFromRecord(
  record: {
    readonly requestId: string;
    readonly status: ProjectSourceMcpReadResult["status"];
    readonly snapshotId: string | null;
    readonly sourceRevision: string | null;
    readonly errorCategory: string | null;
    readonly errorCode: string | null;
    readonly errorMessage: string | null;
  },
  deduplicated: boolean,
): ProjectSourceMcpReadResult {
  return {
    requestId: record.requestId,
    status: record.status,
    deduplicated,
    snapshotId: record.snapshotId,
    sourceRevision: record.sourceRevision,
    errorCategory: record.errorCategory,
    errorCode: record.errorCode,
    errorMessage: record.errorMessage,
  };
}

function classifyFailure(error: unknown): {
  readonly status: "failed" | "timed_out" | "cancelled" | "interrupted";
  readonly category: string;
  readonly code: string;
  readonly message: string;
} {
  if (error instanceof ProjectSourceMcpAdapterError) {
    return {
      status:
        error.code.includes("lease_lost") ? "interrupted" : "failed",
      category:
        error.code.includes("lease_lost")
          ? "interrupted"
          : error.code.includes("timeout")
            ? "timeout"
            : "unknown",
      code: error.code,
      message: error.message,
    };
  }
  const name =
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    typeof (error as { readonly name?: unknown }).name === "string"
      ? (error as { readonly name: string }).name
      : undefined;
  if (name === "RunTimedOutError") {
    return {
      status: "timed_out",
      category: "timeout",
      code: "project_source_read_timeout",
      message: "The MCP project source read timed out",
    };
  }
  if (name === "RunCancelledError") {
    return {
      status: "cancelled",
      category: "cancelled",
      code: "project_source_read_cancelled",
      message: "The MCP project source read was cancelled",
    };
  }
  if (name === "RunLeaseLostError") {
    return {
      status: "interrupted",
      category: "interrupted",
      code: "project_source_lease_lost",
      message: "The project source Worker lease was lost",
    };
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { readonly code?: unknown }).code === "string"
  ) {
    const code = (error as { readonly code: string }).code;
    if (code.includes("timeout") || code === "RunTimedOutError") {
      return {
        status: "timed_out",
        category: "timeout",
        code,
        message: "The MCP project source read timed out",
      };
    }
    if (code.includes("cancel")) {
      return {
        status: "cancelled",
        category: "cancelled",
        code,
        message: "The MCP project source read was cancelled",
      };
    }
    if (code.includes("lease")) {
      return {
        status: "interrupted",
        category: "interrupted",
        code,
        message: "The project source Worker lease was lost",
      };
    }
  }
  return {
    status: "failed",
    category: "unknown",
    code: "project_source_read_failed",
    message: "The MCP project source read failed",
  };
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
