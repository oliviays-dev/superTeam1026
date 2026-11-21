import { createHash } from "node:crypto";
import {
  ExecutionGateError,
  ExecutionGateService,
} from "@pluginmax/application";
import {
  MCP_PROVIDER_CONTROL_PLANE_FLAG,
  MCP_TOOL_CATEGORY,
  MCP_TOOL_INVOCATION_FLAG,
  mcpToolCallInputSchema,
  type ActionTicket,
  type ExecutionGateRecord,
  type McpToolCallDetail,
  type McpToolCallErrorCategory,
  type McpToolCallInput,
  type McpToolInputSummary,
  type McpToolOutputSummary,
  type Run,
  type TaskExecutionPolicy,
} from "@pluginmax/contracts";
import {
  McpToolCallRepositoryError,
  type ClaimedMcpToolCatalog,
  type PlatformRepositories,
} from "@pluginmax/database";
import {
  type McpCredentialResolver,
  McpProbeFailure,
  McpToolCallFailure,
  type McpToolCallTransport,
} from "./mcp-provider-probe-service.js";

export class McpToolCallServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 409,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "McpToolCallServiceError";
  }
}

interface ClaimedExecution {
  readonly callId: string;
  readonly leaseToken: string;
  readonly catalog: ClaimedMcpToolCatalog;
  readonly ticket: ActionTicket;
  readonly policy: TaskExecutionPolicy;
}

export interface McpToolCallExecutionResult {
  readonly detail: McpToolCallDetail;
  readonly result: Record<string, unknown> | null;
  readonly deduplicated: boolean;
}

export class McpToolCallService {
  readonly port = "worker-only" as const;
  private readonly executionGates: ExecutionGateService;

  constructor(
    private readonly repositories: PlatformRepositories,
    private readonly options: {
      readonly owner: string;
      readonly leaseSeconds: number;
      readonly now?: () => Date;
    },
    private readonly transport: McpToolCallTransport,
    private readonly credentials: McpCredentialResolver,
    private readonly log?: (
      event: string,
      data?: Record<string, unknown>,
    ) => void,
  ) {
    this.executionGates = new ExecutionGateService(repositories);
  }

  async invoke(
    input: McpToolCallInput,
    options: {
      readonly signal?: AbortSignal;
      readonly timeoutMs?: number;
    } = {},
  ): Promise<McpToolCallDetail> {
    return (await this.execute(input, options)).detail;
  }

  async execute(
    input: McpToolCallInput,
    options: {
      readonly signal?: AbortSignal;
      readonly timeoutMs?: number;
    } = {},
  ): Promise<McpToolCallExecutionResult> {
    const parsed = this.parseInput(input);
    await this.assertEnabled();
    if (isAborted(options.signal)) {
      throw new McpToolCallServiceError(
        "mcp_tool_call_cancelled",
        "MCP Tool call was cancelled before it started",
        409,
      );
    }
    const run = await this.repositories.runs.get(parsed.runId);
    if (run === undefined) {
      throw new McpToolCallServiceError(
        "run_not_found",
        "Run not found",
        404,
      );
    }
    if (run.attempt !== parsed.runAttempt) {
      throw new McpToolCallServiceError(
        "mcp_tool_run_attempt_mismatch",
        "The MCP Tool call does not belong to the current Run attempt",
        409,
      );
    }
    if (run.status !== "running") {
      throw new McpToolCallServiceError(
        "mcp_tool_run_not_running",
        "MCP Tool calls require a running Run",
        409,
      );
    }
    const envelope = run.executionEnvelope;
    if (
      envelope === null ||
      run.taskId === null ||
      run.projectId === null
    ) {
      throw new McpToolCallServiceError(
        "mcp_tool_execution_envelope_missing",
        "MCP Tool calls require a Task-backed Run with an Execution Envelope",
        403,
      );
    }
    const requestDigest = digest(
      stableJson({
        runId: run.id,
        runAttempt: run.attempt,
        toolKey: parsed.toolKey,
        gateId: parsed.gateId,
        idempotencyKey: parsed.idempotencyKey,
        arguments: parsed.arguments,
      }),
    );
    const existing =
      await this.repositories.mcpToolCalls.findByRunAndIdempotency({
        runId: run.id,
        idempotencyKey: parsed.idempotencyKey,
      });
    if (existing !== undefined) {
      if (existing.call.requestDigest !== requestDigest) {
        throw new McpToolCallServiceError(
          "mcp_tool_idempotency_conflict",
          "The idempotency key was used with different MCP Tool arguments",
          409,
        );
      }
      if (existing.call.status === "running") {
        throw new McpToolCallServiceError(
          "mcp_tool_invocation_in_progress",
          "This MCP Tool call is already running",
          409,
        );
      }
      return {
        detail: existing,
        result: null,
        deduplicated: true,
      };
    }

    if (envelope.policy.id === null) {
      throw new McpToolCallServiceError(
        "policy_revision_unavailable",
        "MCP Tool calls require an immutable TaskExecutionPolicy revision",
        403,
      );
    }
    const [ticket, gate, policy] = await Promise.all([
      this.repositories.actionTickets.getByRun(run.id),
      this.repositories.actionTickets.getGate(parsed.gateId),
      this.repositories.taskExecutionPolicies.getRevision(
        envelope.policy.id,
        envelope.policy.revision,
      ),
    ]);
    if (ticket === undefined) {
      throw new McpToolCallServiceError(
        "action_ticket_missing",
        "MCP Tool calls require an Action Ticket",
        403,
      );
    }
    if (gate === undefined) {
      throw new McpToolCallServiceError(
        "execution_gate_missing",
        "MCP Tool calls require an approved Execution Gate",
        403,
      );
    }
    if (policy === undefined) {
      throw new McpToolCallServiceError(
        "policy_revision_unavailable",
        "The MCP Tool execution policy revision is unavailable",
        409,
      );
    }
    this.assertTicket(run, ticket);
    this.assertPolicy(policy.policy, envelope.envelope.resolved);
    this.assertGate(run, ticket, gate);
    await this.assertExecutionGate(run.id);
    if (isAborted(options.signal)) {
      throw new McpToolCallServiceError(
        "mcp_tool_call_cancelled",
        "MCP Tool call was cancelled before it started",
        409,
      );
    }
    const maxToolCalls = policy.policy.budget.maxToolCalls;
    if (maxToolCalls !== undefined) {
      const count = await this.repositories.mcpToolCalls.countByRun(run.id);
      if (count >= maxToolCalls) {
        throw new McpToolCallServiceError(
          "mcp_tool_budget_exhausted",
          "The Run exhausted its MCP Tool call budget",
          429,
        );
      }
    }
    const inputSummary = summarizeArguments(parsed.arguments);
    const begun = await this.repositories.mcpToolCalls
      .begin({
        runId: run.id,
        runAttempt: run.attempt,
        taskId: run.taskId,
        projectId: run.projectId,
        agentId: run.agentId,
        agentPrincipalId: envelope.agentPrincipalId,
        toolKey: parsed.toolKey,
        ticketId: ticket.ticketId,
        gateId: gate.gateId,
        policyId: envelope.policy.id,
        policyRevision: envelope.policy.revision,
        envelopeId: envelope.id,
        envelopeDigest: envelope.digest,
        idempotencyKey: parsed.idempotencyKey,
        requestDigest,
        inputSummary,
        leaseOwner: this.options.owner,
        leaseSeconds: this.options.leaseSeconds,
      })
      .catch((error: unknown) => {
        if (error instanceof McpToolCallRepositoryError) {
          throw new McpToolCallServiceError(
            error.code,
            error.message,
            error.code === "mcp_tool_not_found" ? 404 : 409,
          );
        }
        throw error;
      });
    if (begun.kind === "idempotency_conflict") {
      throw new McpToolCallServiceError(
        "mcp_tool_idempotency_conflict",
        "The idempotency key was used with different MCP Tool arguments",
        409,
      );
    }
    if (begun.kind === "gate_already_used") {
      throw new McpToolCallServiceError(
        "execution_gate_already_used",
        "An Execution Gate can authorize only one MCP Tool call",
        409,
      );
    }
    if (begun.kind === "in_progress") {
      throw new McpToolCallServiceError(
        "mcp_tool_invocation_in_progress",
        "This MCP Tool call is already running",
        409,
      );
    }
    if (begun.kind === "replay") {
      return {
        detail: begun.call,
        result: null,
        deduplicated: true,
      };
    }

    const claimed: ClaimedExecution = {
      callId: begun.call.call.id,
      leaseToken: begun.leaseToken,
      catalog: begun.catalog,
      ticket,
      policy: policy.policy,
    };
    const startedAt = Date.now();
    this.log?.("mcp_tool_call.started", {
      callId: claimed.callId,
      runId: run.id,
      providerId: claimed.catalog.providerId,
      providerVersion: claimed.catalog.providerVersion,
      toolKey: claimed.catalog.toolKey,
    });
    try {
      const credential = await this.resolveCredential(claimed.catalog);
      if (isAborted(options.signal)) {
        throw new McpToolCallFailure(
          "cancelled",
          "tool_call_cancelled",
          "MCP Tool call was cancelled",
        );
      }
      const result = await this.transport.callTool(
        {
          endpointUrl: claimed.catalog.endpointUrl,
          authKind: claimed.catalog.authKind,
          credential,
          credentialHeaderName: claimed.catalog.credentialHeaderName,
          timeoutMs: this.timeoutMs(
            claimed.catalog,
            claimed.policy,
            options.timeoutMs,
          ),
          toolName: claimed.catalog.toolName,
          arguments: parsed.arguments,
        },
        options.signal,
      );
      const outputSummary = summarizeOutput(result);
      const outputDigest = digest(stableJson(result));
      const completed = await this.repositories.mcpToolCalls.complete({
        callId: claimed.callId,
        leaseOwner: this.options.owner,
        leaseToken: claimed.leaseToken,
        status: "succeeded",
        outputSummary,
        outputDigest,
        errorCategory: null,
        errorCode: null,
        errorMessage: null,
      });
      if (completed.kind === "claim_lost") {
        throw new McpToolCallServiceError(
          "mcp_tool_call_lease_lost",
          "The MCP Tool call lease was lost before completion",
          409,
        );
      }
      this.log?.("mcp_tool_call.succeeded", {
        callId: claimed.callId,
        runId: run.id,
        providerId: claimed.catalog.providerId,
        providerVersion: claimed.catalog.providerVersion,
        toolKey: claimed.catalog.toolKey,
        durationMs: Date.now() - startedAt,
        contentCount: outputSummary.contentCount,
        textBytes: outputSummary.textBytes,
      });
      return {
        detail: completed.call,
        result,
        deduplicated: false,
      };
    } catch (error) {
      const failure = classifyError(error, options.signal);
      const terminalStatus =
        failure.category === "timeout"
          ? "timed_out"
          : failure.category === "cancelled"
            ? "cancelled"
            : "failed";
      const completed =
        await this.repositories.mcpToolCalls
          .complete({
            callId: claimed.callId,
            leaseOwner: this.options.owner,
            leaseToken: claimed.leaseToken,
            status: terminalStatus,
            outputSummary: null,
            outputDigest: null,
            errorCategory: failure.category,
            errorCode: failure.code,
            errorMessage: failure.message,
          })
          .catch(() => ({ kind: "claim_lost" as const }));
      this.log?.("mcp_tool_call.failed", {
        callId: claimed.callId,
        runId: run.id,
        providerId: claimed.catalog.providerId,
        providerVersion: claimed.catalog.providerVersion,
        toolKey: claimed.catalog.toolKey,
        category: failure.category,
        code: failure.code,
        durationMs: Date.now() - startedAt,
      });
      if (error instanceof McpToolCallServiceError) throw error;
      if (completed.kind === "claim_lost") {
        throw new McpToolCallServiceError(
          "mcp_tool_call_lease_lost",
          "The MCP Tool call lease was lost while recording failure",
          409,
        );
      }
      throw new McpToolCallServiceError(
        failure.code,
        failure.message,
        failure.statusCode,
      );
    }
  }

  private parseInput(input: McpToolCallInput): McpToolCallInput {
    try {
      return mcpToolCallInputSchema.parse(input);
    } catch (error) {
      throw new McpToolCallServiceError(
        "mcp_tool_call_invalid_input",
        "MCP Tool call input is invalid",
        400,
        error instanceof Error && "issues" in error
          ? (error as { readonly issues: unknown }).issues
          : undefined,
      );
    }
  }

  async assertEnabled(): Promise<void> {
    const [controlPlane, invocation] = await Promise.all([
      this.repositories.featureFlags.isEnabled(
        MCP_PROVIDER_CONTROL_PLANE_FLAG,
      ),
      this.repositories.featureFlags.isEnabled(MCP_TOOL_INVOCATION_FLAG),
    ]);
    if (!controlPlane) {
      throw new McpToolCallServiceError(
        "mcp_provider_control_plane_disabled",
        "MCP Provider control plane is disabled",
        503,
      );
    }
    if (!invocation) {
      throw new McpToolCallServiceError(
        "mcp_tool_invocation_disabled",
        "MCP Tool invocation is disabled",
        503,
      );
    }
  }

  private assertTicket(run: Run, ticket: ActionTicket): void {
    const envelope = run.executionEnvelope!;
    if (
      ticket.runId !== run.id ||
      ticket.taskId !== run.taskId ||
      ticket.principalId !== envelope.principalId ||
      ticket.contextType !== envelope.contextType ||
      ticket.contextId !== envelope.contextId ||
      ticket.workspaceId !== envelope.envelope.workspaceId ||
      ticket.envelopeId !== envelope.id ||
      ticket.envelopeDigest !== envelope.digest ||
      ticket.policyId !== envelope.policy.id ||
      ticket.policyRevision !== envelope.policy.revision ||
      !ticket.allowedActions.includes("agent.execute") ||
      ticket.deniedActions.includes("agent.execute") ||
      !ticket.resourceScopes.includes(`run:${run.id}`) ||
      !ticket.resourceScopes.includes(
        `workspace:${envelope.envelope.workspaceId}`,
      ) ||
      !ticket.resourceScopes.includes(
        `context:${envelope.contextType}:${envelope.contextId}`,
      ) ||
      !ticket.resourceScopes.includes(`tool:${MCP_TOOL_CATEGORY}`) ||
      !ticket.resourceScopes.includes("source:connector-data")
    ) {
      throw new McpToolCallServiceError(
        "action_ticket_scope_mismatch",
        "The Action Ticket is not scoped for this MCP Tool call",
        403,
      );
    }
  }

  private assertPolicy(
    policy: TaskExecutionPolicy,
    resolved: NonNullable<Run["executionEnvelope"]>["envelope"]["resolved"],
  ): void {
    if (
      !policy.toolPolicy.allow.includes(MCP_TOOL_CATEGORY) ||
      policy.toolPolicy.deny.includes(MCP_TOOL_CATEGORY) ||
      !policy.toolPolicy.requireApproval.includes(MCP_TOOL_CATEGORY) ||
      !resolved.allowedToolCategories.includes(MCP_TOOL_CATEGORY) ||
      resolved.deniedToolCategories.includes(MCP_TOOL_CATEGORY) ||
      !resolved.approvalToolCategories.includes(MCP_TOOL_CATEGORY) ||
      !policy.sourcePolicy.allow.includes("connector-data") ||
      policy.sourcePolicy.deny.includes("connector-data")
    ) {
      throw new McpToolCallServiceError(
        "mcp_tool_policy_denied",
        "TaskExecutionPolicy does not allow and require approval for MCP Tool calls",
        403,
      );
    }
  }

  private assertGate(
    run: Run,
    ticket: ActionTicket,
    gate: ExecutionGateRecord,
  ): void {
    const envelope = run.executionEnvelope!;
    if (
      gate.ticketId !== ticket.ticketId ||
      gate.runId !== run.id ||
      gate.taskId !== run.taskId ||
      gate.projectId !== run.projectId ||
      gate.kind !== "tool-approval" ||
      gate.requestedToolCategory !== MCP_TOOL_CATEGORY ||
      gate.enforcement !== "blocking" ||
      gate.policyId !== ticket.policyId ||
      gate.policyRevision !== ticket.policyRevision ||
      gate.envelopeId !== envelope.id ||
      gate.envelopeDigest !== envelope.digest ||
      !gate.resourceScopes.includes(`tool:${MCP_TOOL_CATEGORY}`) ||
      !gate.resourceScopes.includes("source:connector-data") ||
      !gate.resourceScopes.includes(
        `workspace:${envelope.envelope.workspaceId}`,
      )
    ) {
      throw new McpToolCallServiceError(
        "execution_gate_scope_mismatch",
        "The Execution Gate is not bound to this MCP Tool call",
        403,
      );
    }
    if (new Date(gate.expiresAt).getTime() <= this.now().getTime()) {
      throw new McpToolCallServiceError(
        "execution_gate_expired",
        "The MCP Tool Execution Gate expired",
        409,
      );
    }
    if (gate.status === "pending") {
      throw new McpToolCallServiceError(
        "execution_gate_waiting",
        "The MCP Tool Execution Gate is waiting for a decision",
        409,
      );
    }
    if (gate.status !== "approved") {
      throw new McpToolCallServiceError(
        gate.status === "denied"
          ? "execution_gate_denied"
          : gate.status === "cancelled"
            ? "execution_gate_cancelled"
            : "execution_gate_expired",
        "The MCP Tool Execution Gate did not approve this call",
        403,
      );
    }
    if (
      gate.decision === null ||
      gate.decision.decision !== "approve" ||
      gate.decision.envelopeId !== envelope.id ||
      gate.decision.envelopeDigest !== envelope.digest ||
      gate.decision.policyRevision !== gate.policyRevision
    ) {
      throw new McpToolCallServiceError(
        "execution_gate_decision_invalid",
        "The MCP Tool Execution Gate decision is not bound to the current Envelope",
        409,
      );
    }
  }

  private async assertExecutionGate(runId: string): Promise<void> {
    try {
      await this.executionGates.assertRunAction({
        runId,
        action: "agent.execute",
      });
    } catch (error) {
      if (error instanceof ExecutionGateError) {
        throw new McpToolCallServiceError(
          error.code,
          error.message,
          error.statusCode,
          error.details,
        );
      }
      throw error;
    }
  }

  private async resolveCredential(
    catalog: ClaimedMcpToolCatalog,
  ): Promise<string | null> {
    if (catalog.authKind === "none") return null;
    if (catalog.credentialRef === null) {
      throw new McpToolCallFailure(
        "credential",
        "credential_reference_missing",
        "MCP Provider credential reference is missing",
      );
    }
    const credential = await this.credentials.resolve(catalog.credentialRef);
    if (credential === undefined || credential === "") {
      throw new McpToolCallFailure(
        "credential",
        "credential_unavailable",
        "MCP Provider credential reference could not be resolved",
      );
    }
    return credential;
  }

  private timeoutMs(
    catalog: ClaimedMcpToolCatalog,
    policy: TaskExecutionPolicy,
    requestLimitMs?: number,
  ): number {
    return Math.max(
      1_000,
      Math.min(
        catalog.requestTimeoutMs,
        policy.budget.timeoutMs ?? catalog.requestTimeoutMs,
        requestLimitMs ?? catalog.requestTimeoutMs,
      ),
    );
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

function summarizeArguments(
  args: Record<string, unknown>,
): McpToolInputSummary {
  return {
    argumentKeys: Object.keys(args)
      .sort()
      .slice(0, 100)
      .map((key) => key.slice(0, 160)),
    argumentCount: Object.keys(args).length,
    inputBytes: Buffer.byteLength(stableJson(args), "utf8"),
  };
}

function summarizeOutput(result: Record<string, unknown>): McpToolOutputSummary {
  const content = Array.isArray(result.content) ? result.content : [];
  const contentTypes = [
    ...new Set(
      content.flatMap((item) => {
        if (typeof item !== "object" || item === null) return [];
        const type = (item as { readonly type?: unknown }).type;
        return typeof type === "string" ? [type.slice(0, 80)] : [];
      }),
    ),
  ].slice(0, 100);
  const textBytes = content.reduce((total, item) => {
    if (typeof item !== "object" || item === null) return total;
    const text = (item as { readonly text?: unknown }).text;
    return typeof text === "string"
      ? total + Buffer.byteLength(text, "utf8")
      : total;
  }, 0);
  return {
    contentCount: content.length,
    contentTypes,
    textBytes,
    structuredBytes: Buffer.byteLength(stableJson(result), "utf8"),
    toolReportedError: result.isError === true,
  };
}

function classifyError(
  error: unknown,
  signal: AbortSignal | undefined,
): {
  readonly category: McpToolCallErrorCategory;
  readonly code: string;
  readonly message: string;
  readonly statusCode: number;
} {
  if (signal?.aborted === true) {
    return {
      category: "cancelled",
      code: "tool_call_cancelled",
      message: "MCP Tool call was cancelled",
      statusCode: 409,
    };
  }
  if (error instanceof McpToolCallFailure) {
    return {
      category: error.category,
      code: error.code,
      message: error.message,
      statusCode:
        error.category === "timeout"
          ? 504
          : error.category === "cancelled"
            ? 409
            : error.category === "authentication" ||
                error.category === "authorization"
              ? 502
              : 502,
    };
  }
  if (error instanceof McpProbeFailure) {
    return {
      category: mcpProbeCategory(error.category),
      code: error.code,
      message: error.message,
      statusCode: error.category === "timeout" ? 504 : 502,
    };
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { readonly name?: unknown }).name === "AbortError"
  ) {
    return {
      category: "timeout",
      code: "tool_call_timeout",
      message: "MCP Tool call timed out",
      statusCode: 504,
    };
  }
  const networkCode =
    typeof error === "object" && error !== null && "cause" in error
      ? networkErrorCode((error as { readonly cause?: unknown }).cause)
      : undefined;
  if (networkCode === "ENOTFOUND" || networkCode === "EAI_AGAIN") {
    return {
      category: "dns",
      code: "dns_resolution_failed",
      message: "MCP Provider host could not be resolved",
      statusCode: 502,
    };
  }
  if (
    networkCode?.startsWith("CERT_") === true ||
    networkCode === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
    networkCode === "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
  ) {
    return {
      category: "tls",
      code: "tls_validation_failed",
      message: "MCP Provider TLS validation failed",
      statusCode: 502,
    };
  }
  if (
    networkCode === "ECONNREFUSED" ||
    networkCode === "ECONNRESET" ||
    networkCode === "EHOSTUNREACH" ||
    networkCode === "ENETUNREACH" ||
    networkCode === "ETIMEDOUT"
  ) {
    return {
      category: "network",
      code: "network_unreachable",
      message: "MCP Provider network connection failed",
      statusCode: 502,
    };
  }
  return {
    category: "unknown",
    code: "mcp_tool_call_failed",
    message: "MCP Tool call failed",
    statusCode: 502,
  };
}

function mcpProbeCategory(
  category: McpProbeFailure["category"],
): McpToolCallErrorCategory {
  switch (category) {
    case "timeout":
    case "dns":
    case "tls":
    case "authentication":
    case "authorization":
    case "http_status":
    case "protocol":
    case "schema":
    case "network":
    case "credential":
    case "unknown":
      return category;
  }
}

function networkErrorCode(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("code" in value)) {
    return undefined;
  }
  const code = (value as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
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
