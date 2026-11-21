import { createHash } from "node:crypto";
import {
  RunCancelledError,
  RunLeaseLostError,
  RunTimedOutError,
  type RuntimeToolBridgePort,
  type RuntimeToolBridgeRequest,
} from "@pluginmax/application";
import {
  MCP_RUNTIME_TOOL_BRIDGE_FLAG,
  runtimeMcpToolRequestSchema,
  type McpToolCall,
  type McpToolCallErrorCategory,
  type McpToolInputSummary,
  type RuntimeMcpToolRequest,
  type RuntimeMcpToolResult,
  type RuntimeToolRequestDetail,
  type RuntimeToolRequestTerminalStatus,
} from "@pluginmax/contracts";
import type { PlatformRepositories } from "@pluginmax/database";
import {
  McpToolCallService,
  McpToolCallServiceError,
} from "./mcp-tool-call-service.js";

export class RuntimeToolRequestBridgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 409,
  ) {
    super(message);
    this.name = "RuntimeToolRequestBridgeError";
  }
}

export class RuntimeToolRequestBridge implements RuntimeToolBridgePort {
  readonly port = "worker-runtime-only" as const;
  private readonly inFlight = new Map<string, Promise<RuntimeMcpToolResult>>();

  constructor(
    private readonly repositories: PlatformRepositories,
    private readonly toolCalls: McpToolCallService,
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

  async request(input: RuntimeToolBridgeRequest): Promise<RuntimeMcpToolResult> {
    const request = this.parseRequest(input.request);
    await this.requireEnabled();
    const run = await this.repositories.runs.get(input.runId);
    if (run === undefined) {
      throw new RuntimeToolRequestBridgeError(
        "runtime_tool_run_not_found",
        "Run not found",
        404,
      );
    }
    if (run.attempt !== input.runAttempt) {
      throw new RuntimeToolRequestBridgeError(
        "runtime_tool_run_attempt_mismatch",
        "The Runtime Tool Request does not belong to the current Run attempt",
        409,
      );
    }
    if (run.status !== "running") {
      throw new RuntimeToolRequestBridgeError(
        "runtime_tool_run_not_running",
        "Runtime Tool Requests require a running Run",
        409,
      );
    }
    const envelope = run.executionEnvelope;
    if (
      envelope === null ||
      run.taskId === null ||
      run.projectId === null ||
      envelope.policy.id === null
    ) {
      throw new RuntimeToolRequestBridgeError(
        "runtime_tool_execution_envelope_missing",
        "Runtime Tool Requests require a Task-backed Run with policy binding",
        403,
      );
    }
    const [ticket, gate, policy] = await Promise.all([
      this.repositories.actionTickets.getByRun(run.id),
      this.repositories.actionTickets.getGate(request.gateId),
      this.repositories.taskExecutionPolicies.getRevision(
        envelope.policy.id,
        envelope.policy.revision,
      ),
    ]);
    if (ticket === undefined) {
      throw new RuntimeToolRequestBridgeError(
        "action_ticket_missing",
        "Runtime Tool Requests require an Action Ticket",
        403,
      );
    }
    if (gate === undefined) {
      throw new RuntimeToolRequestBridgeError(
        "execution_gate_missing",
        "Runtime Tool Requests require an Execution Gate",
        403,
      );
    }
    if (policy === undefined) {
      throw new RuntimeToolRequestBridgeError(
        "policy_revision_unavailable",
        "The Runtime Tool Request policy revision is unavailable",
        409,
      );
    }
    if (isAborted(input.signal)) {
      throw new RuntimeToolRequestBridgeError(
        "runtime_tool_request_cancelled",
        "The Runtime Tool Request was cancelled before it started",
        409,
      );
    }
    await input.assertLease();

    const requestDigest = digest(
      stableJson({
        runId: run.id,
        runAttempt: run.attempt,
        taskId: run.taskId,
        projectId: run.projectId,
        agentId: run.agentId,
        toolKey: request.toolKey,
        ticketId: ticket.ticketId,
        gateId: gate.gateId,
        policyId: envelope.policy.id,
        policyRevision: envelope.policy.revision,
        envelopeId: envelope.id,
        envelopeDigest: envelope.digest,
        idempotencyKey: request.idempotencyKey,
        arguments: request.arguments,
      }),
    );
    const inputSummary = summarizeArguments(request.arguments);
    const begun = await this.repositories.runtimeToolRequests.begin({
      requestId: request.requestId,
      runId: run.id,
      runAttempt: run.attempt,
      taskId: run.taskId,
      projectId: run.projectId,
      agentId: run.agentId,
      agentPrincipalId: envelope.agentPrincipalId,
      toolKey: request.toolKey,
      ticketId: ticket.ticketId,
      gateId: gate.gateId,
      policyId: envelope.policy.id,
      policyRevision: envelope.policy.revision,
      envelopeId: envelope.id,
      envelopeDigest: envelope.digest,
      idempotencyKey: request.idempotencyKey,
      requestDigest,
      inputSummary,
      leaseOwner: this.options.owner,
      leaseSeconds: this.leaseSeconds(
        Math.max(
          request.timeoutMs ?? 0,
          policy.policy.budget.timeoutMs ?? 0,
        ),
      ),
    });
    if (begun.kind === "idempotency_conflict") {
      throw new RuntimeToolRequestBridgeError(
        "runtime_tool_idempotency_conflict",
        "The idempotency key was used with different Runtime Tool arguments",
        409,
      );
    }
    if (begun.kind === "gate_already_used") {
      throw new RuntimeToolRequestBridgeError(
        "runtime_tool_gate_already_used",
        "The Execution Gate already authorized another tool action",
        409,
      );
    }
    if (begun.kind === "replay") {
      return resultFromDetail(begun.detail, {
        deduplicated: true,
        resultAvailable: false,
      });
    }
    if (begun.kind === "in_progress") {
      const pending = this.inFlight.get(this.inFlightKey(run.id, request));
      if (pending !== undefined) {
        return {
          ...(await pending),
          deduplicated: true,
          resultAvailable: false,
          result: undefined,
        };
      }
      throw new RuntimeToolRequestBridgeError(
        "runtime_tool_request_in_progress",
        "This Runtime Tool Request is already running",
        409,
      );
    }

    const leaseToken = begun.leaseToken;
    const key = this.inFlightKey(run.id, request);
    const operation = this.execute({
      request,
      requestDigest,
      inputSummary,
      detail: begun.detail,
      leaseToken,
      runId: run.id,
      runAttempt: run.attempt,
      signal: input.signal,
      assertLease: input.assertLease,
    });
    this.inFlight.set(key, operation);
    try {
      return await operation;
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async execute(input: {
    readonly request: RuntimeMcpToolRequest;
    readonly requestDigest: string;
    readonly inputSummary: McpToolInputSummary;
    readonly detail: RuntimeToolRequestDetail;
    readonly leaseToken: string;
    readonly runId: string;
    readonly runAttempt: number;
    readonly signal?: AbortSignal | undefined;
    readonly assertLease: () => Promise<void>;
  }): Promise<RuntimeMcpToolResult> {
    const record = input.detail.request;
    this.log?.("runtime_tool_request.started", {
      requestId: record.requestId,
      runId: record.runId,
      runAttempt: record.runAttempt,
      toolKey: record.toolKey,
      gateId: record.gateId,
    });
    try {
      if (isAborted(input.signal)) {
        throw new RuntimeToolRequestBridgeError(
          "runtime_tool_request_cancelled",
          "The Runtime Tool Request was cancelled before Provider access",
          409,
        );
      }
      const execution = await this.toolCalls.execute(
        {
          runId: input.runId,
          runAttempt: input.runAttempt,
          toolKey: input.request.toolKey,
          gateId: input.request.gateId,
          idempotencyKey: input.request.idempotencyKey,
          arguments: input.request.arguments,
        },
        {
          ...(input.signal === undefined ? {} : { signal: input.signal }),
          ...(input.request.timeoutMs === undefined
            ? {}
            : { timeoutMs: input.request.timeoutMs }),
        },
      );
      await input.assertLease();
      const status = terminalStatus(execution.detail.call.status);
      const completed =
        await this.repositories.runtimeToolRequests.complete({
          requestId: record.requestId,
          leaseOwner: this.options.owner,
          leaseToken: input.leaseToken,
          status,
          callId: execution.detail.call.id,
          outputSummary: execution.detail.call.outputSummary,
          outputDigest: execution.detail.call.outputDigest,
          errorCategory: execution.detail.call.errorCategory,
          errorCode: execution.detail.call.errorCode,
          errorMessage: execution.detail.call.errorMessage,
        });
      if (completed.kind === "claim_lost") {
        return this.statusOnlyResult(record.requestId);
      }
      this.log?.("runtime_tool_request.succeeded", {
        requestId: record.requestId,
        runId: record.runId,
        runAttempt: record.runAttempt,
        callId: execution.detail.call.id,
        toolKey: record.toolKey,
      });
      return resultFromDetail(completed.detail, {
        deduplicated: execution.deduplicated,
        resultAvailable:
          execution.result !== null && !execution.deduplicated,
        ...(execution.result === null
          ? {}
          : { result: execution.result }),
      });
    } catch (error) {
      const call = await this.repositories.mcpToolCalls.findByRunAndIdempotency(
        {
          runId: input.runId,
          idempotencyKey: input.request.idempotencyKey,
        },
      );
      const failure = classifyFailure(
        error,
        input.signal,
        call?.call,
      );
      const completed =
        await this.repositories.runtimeToolRequests.complete({
          requestId: record.requestId,
          leaseOwner: this.options.owner,
          leaseToken: input.leaseToken,
          status: failure.status,
          callId: call?.call.id ?? null,
          outputSummary: call?.call.outputSummary ?? null,
          outputDigest: call?.call.outputDigest ?? null,
          errorCategory: failure.errorCategory,
          errorCode: failure.errorCode,
          errorMessage: failure.errorMessage,
        });
      this.log?.("runtime_tool_request.failed", {
        requestId: record.requestId,
        runId: record.runId,
        runAttempt: record.runAttempt,
        callId: call?.call.id ?? null,
        toolKey: record.toolKey,
        status: failure.status,
        errorCategory: failure.errorCategory,
        errorCode: failure.errorCode,
      });
      if (completed.kind === "claim_lost") {
        return this.statusOnlyResult(record.requestId);
      }
      return resultFromDetail(completed.detail, {
        deduplicated: false,
        resultAvailable: false,
      });
    }
  }

  private parseRequest(input: RuntimeMcpToolRequest): RuntimeMcpToolRequest {
    try {
      return runtimeMcpToolRequestSchema.parse(input);
    } catch {
      throw new RuntimeToolRequestBridgeError(
        "runtime_tool_request_invalid_input",
        "Runtime Tool Request input is invalid",
        400,
      );
    }
  }

  private async requireEnabled(): Promise<void> {
    if (
      !(await this.repositories.featureFlags.isEnabled(
        MCP_RUNTIME_TOOL_BRIDGE_FLAG,
      ))
    ) {
      throw new RuntimeToolRequestBridgeError(
        "mcp_runtime_tool_bridge_disabled",
        "The Agent Runtime MCP Tool Request bridge is disabled",
        503,
      );
    }
    await this.toolCalls.assertEnabled();
  }

  private async statusOnlyResult(
    requestId: string,
  ): Promise<RuntimeMcpToolResult> {
    const detail =
      await this.repositories.runtimeToolRequests.findByRequestId(requestId);
    if (detail === undefined || detail.request.status === "running") {
      throw new RuntimeToolRequestBridgeError(
        "runtime_tool_request_convergence_pending",
        "The Runtime Tool Request has not converged yet",
        409,
      );
    }
    return resultFromDetail(detail, {
      deduplicated: false,
      resultAvailable: false,
    });
  }

  private leaseSeconds(timeoutMs: number): number {
    const configured = this.options.leaseSeconds ?? 300;
    const timeoutSeconds = Math.ceil(timeoutMs / 1_000);
    return Math.max(configured, timeoutSeconds + 60);
  }

  private inFlightKey(runId: string, request: RuntimeMcpToolRequest): string {
    return `${runId}:${request.idempotencyKey}`;
  }
}

function resultFromDetail(
  detail: RuntimeToolRequestDetail,
  options: {
    readonly deduplicated: boolean;
    readonly resultAvailable: boolean;
    readonly result?: Record<string, unknown>;
  },
): RuntimeMcpToolResult {
  const request = detail.request;
  if (request.status === "running") {
    throw new RuntimeToolRequestBridgeError(
      "runtime_tool_request_still_running",
      "The Runtime Tool Request is still running",
      409,
    );
  }
  return {
    requestId: request.requestId,
    callId: request.callId,
    status: request.status,
    deduplicated: options.deduplicated,
    resultAvailable: options.resultAvailable,
    ...(options.result === undefined ? {} : { result: options.result }),
    errorCategory: request.errorCategory,
    errorCode: request.errorCode,
    errorMessage: request.errorMessage,
  };
}

function classifyFailure(
  error: unknown,
  signal: AbortSignal | undefined,
  call: McpToolCall | undefined,
): {
  readonly status: RuntimeToolRequestTerminalStatus;
  readonly errorCategory: McpToolCallErrorCategory;
  readonly errorCode: string;
  readonly errorMessage: string;
} {
  const reason = signal?.reason;
  if (error instanceof RunLeaseLostError || reason instanceof RunLeaseLostError) {
    return {
      status: "interrupted",
      errorCategory: "unknown",
      errorCode: "runtime_tool_lease_lost",
      errorMessage: "The Runtime Tool Request Worker lease was lost",
    };
  }
  if (error instanceof RunTimedOutError || reason instanceof RunTimedOutError) {
    return {
      status: "timed_out",
      errorCategory: "timeout",
      errorCode: "runtime_tool_request_timeout",
      errorMessage: "The Runtime Tool Request timed out",
    };
  }
  if (error instanceof RunCancelledError || reason instanceof RunCancelledError) {
    return {
      status: "cancelled",
      errorCategory: "cancelled",
      errorCode: "runtime_tool_request_cancelled",
      errorMessage: "The Runtime Tool Request was cancelled",
    };
  }
  if (call !== undefined) {
    if (call.status === "running") {
      return {
        status: "interrupted",
        errorCategory: "unknown",
        errorCode: "runtime_tool_call_unsettled",
        errorMessage: "The MCP Tool call did not reach a terminal state",
      };
    }
    return {
      status: call.status,
      errorCategory: call.errorCategory ?? "unknown",
      errorCode: call.errorCode ?? "mcp_tool_call_failed",
      errorMessage: call.errorMessage ?? "MCP Tool call failed",
    };
  }
  if (error instanceof RuntimeToolRequestBridgeError) {
    return {
      status:
        error.code === "runtime_tool_request_cancelled"
          ? "cancelled"
          : "failed",
      errorCategory:
        error.code === "runtime_tool_request_cancelled"
          ? "cancelled"
          : "unknown",
      errorCode: error.code,
      errorMessage: error.message,
    };
  }
  if (error instanceof McpToolCallServiceError) {
    return {
      status:
        error.code.includes("timeout")
          ? "timed_out"
          : error.code.includes("cancel")
            ? "cancelled"
            : "failed",
      errorCategory: serviceErrorCategory(error.code),
      errorCode: error.code,
      errorMessage: error.message,
    };
  }
  return {
    status: "failed",
    errorCategory: "unknown",
    errorCode: "runtime_tool_request_failed",
    errorMessage: "The Runtime Tool Request failed",
  };
}

function serviceErrorCategory(code: string): McpToolCallErrorCategory {
  if (code.includes("timeout")) return "timeout";
  if (code.includes("cancel")) return "cancelled";
  if (code.includes("credential")) return "credential";
  if (
    code.includes("policy") ||
    code.includes("ticket") ||
    code.includes("gate") ||
    code.includes("scope") ||
    code.includes("forbidden") ||
    code.includes("authorization")
  ) {
    return "authorization";
  }
  if (code.includes("schema") || code.includes("tool_not_ready")) {
    return "tool";
  }
  return "unknown";
}

function terminalStatus(
  status: McpToolCall["status"],
): RuntimeToolRequestTerminalStatus {
  if (status === "running") {
    throw new RuntimeToolRequestBridgeError(
      "runtime_tool_call_unsettled",
      "The MCP Tool call did not reach a terminal state",
      409,
    );
  }
  return status;
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

function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}
