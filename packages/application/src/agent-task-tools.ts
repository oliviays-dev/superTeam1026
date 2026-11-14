import { createHash } from "node:crypto";
import type {
  ActionTicket,
  AgentTaskToolExecutionResult,
  AgentTaskToolName,
  AgentTaskToolRequest,
  AgentToolRuntimeProof,
  AgentToolWorkspaceLimits,
  ExecutionGateRecord,
  Run,
  SceneSessionBinding,
  ToolInvocationRecord,
} from "@pluginmax/contracts";
import {
  AGENT_TASK_TOOLS_FLAG,
  AGENT_WORKSPACE_FILES_FLAG,
  DEFAULT_AGENT_TOOL_WORKSPACE_LIMITS,
  agentTaskToolRequestSchema,
  agentToolRuntimeProofSchema,
} from "@pluginmax/contracts";
import type {
  PlatformRepositories,
  ToolInvocationIdentity,
} from "@pluginmax/database";
import { AgentToolRepositoryError } from "@pluginmax/database";
import { WorkspaceFileSandbox, WorkspacePathError } from "@pluginmax/files";
import { ApplicationError } from "./errors.js";
import { ExecutionGateError, ExecutionGateService } from "./execution-gate.js";
import { runWorkspacePath } from "./run-workspace.js";
import { TaskAcceptanceService } from "./task-acceptance.js";

type ToolCategory = "task.read" | "task.write" | "fs.read" | "fs.write";
type ToolAction =
  | "agent.execute"
  | "task.writeback"
  | "workflow.writeback"
  | "meeting.writeback"
  | "direct-chat.writeback";

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function toolCategory(tool: AgentTaskToolName): ToolCategory {
  switch (tool) {
    case "task_query":
      return "task.read";
    case "task_submit_deliverable":
    case "task_request_input":
    case "task_comment":
      return "task.write";
    case "read_file":
    case "list_files":
      return "fs.read";
    case "write_file":
      return "fs.write";
  }
}

function writebackAction(run: Run): ToolAction {
  if (run.directChatTurnId !== null) return "direct-chat.writeback";
  if (run.meetingTurnId !== null) return "meeting.writeback";
  if (run.workflowInstanceId !== null) return "workflow.writeback";
  return "task.writeback";
}

function isTaskTool(tool: AgentTaskToolName): boolean {
  return tool.startsWith("task_");
}

function requiresRunningRun(tool: AgentTaskToolName): boolean {
  return tool !== "task_query" && tool !== "task_submit_deliverable";
}

export class AgentTaskToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 403,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AgentTaskToolError";
  }
}

export class AgentTaskToolFacade {
  private readonly executionGates: ExecutionGateService;
  private readonly acceptance: TaskAcceptanceService;

  constructor(
    private readonly repositories: PlatformRepositories,
    private readonly options: {
      readonly workspaceRoot: string;
      readonly limits?: AgentToolWorkspaceLimits;
      readonly now?: () => Date;
    },
  ) {
    this.executionGates = new ExecutionGateService(
      repositories,
      options.now === undefined ? {} : { now: options.now },
    );
    this.acceptance = new TaskAcceptanceService(repositories);
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  async listInvocations(runId: string): Promise<ToolInvocationRecord[]> {
    return this.repositories.agentTools.listByRun(runId);
  }

  async invoke(
    proofInput: AgentToolRuntimeProof,
    requestInput: AgentTaskToolRequest,
  ): Promise<AgentTaskToolExecutionResult> {
    let proof: AgentToolRuntimeProof;
    let request: AgentTaskToolRequest;
    try {
      proof = agentToolRuntimeProofSchema.parse(proofInput);
      request = agentTaskToolRequestSchema.parse(requestInput);
    } catch (error) {
      throw new AgentTaskToolError(
        "agent_tool_invalid_arguments",
        "Tool arguments must use the server-owned runtime context and strict payload schema",
        400,
        {
          issues:
            error instanceof Error && "issues" in error
              ? (error as { issues: unknown }).issues
              : undefined,
        },
      );
    }
    const run = await this.repositories.runs.get(proof.runId);
    if (run === undefined) {
      throw new AgentTaskToolError(
        "agent_tool_run_not_found",
        "Run was not found",
        404,
      );
    }
    if (run.attempt !== proof.runAttempt) {
      throw new AgentTaskToolError(
        "agent_tool_run_attempt_mismatch",
        "Tool invocation does not belong to the current Run attempt",
        403,
      );
    }
    if (run.executionEnvelope === null) {
      await this.appendRunRejection(run.id, request.tool, "execution_envelope_missing");
      throw new AgentTaskToolError(
        "execution_envelope_missing",
        "Protected tools require a current Execution Envelope",
        403,
      );
    }
    const agentPrincipalId = run.executionEnvelope.agentPrincipalId;
    if (agentPrincipalId === null) {
      await this.appendRunRejection(run.id, request.tool, "agent_principal_missing");
      throw new AgentTaskToolError(
        "agent_principal_missing",
        "Protected tools require a server-resolved Agent Principal",
        403,
      );
    }
    const scene = await this.repositories.sceneContext.sessionForRun(run.id);
    if (scene === undefined) {
      await this.appendRunRejection(run.id, request.tool, "scene_session_missing");
      throw new AgentTaskToolError(
        "scene_session_missing",
        "Protected tools require a current Scene Session",
        403,
      );
    }
    if (
      scene.id !== proof.sceneSessionId ||
      scene.agentId !== run.agentId ||
      scene.agentPrincipalId !== agentPrincipalId ||
      scene.status !== "active"
    ) {
      await this.appendRunRejection(
        run.id,
        request.tool,
        "scene_session_identity_mismatch",
      );
      throw new AgentTaskToolError(
        "scene_session_identity_mismatch",
        "Scene Session does not match the current Run and Agent Principal",
        403,
      );
    }
    if (run.taskId === null) {
      throw new AgentTaskToolError(
        "agent_tool_task_context_required",
        "This tool can only run in a Task-backed Run",
        403,
      );
    }
    if (requiresRunningRun(request.tool) && run.status !== "running") {
      throw new AgentTaskToolError(
        "agent_tool_run_not_running",
        "This tool requires a running Run",
        409,
      );
    }

    const category = toolCategory(request.tool);
    const requestDigest = digest(
      stableJson({
        runId: run.id,
        runAttempt: run.attempt,
        sceneSessionId: scene.id,
        tool: request.tool,
        category,
        gateId: request.gateId ?? null,
        payload: request.payload,
      }),
    );
    const ticket = await this.repositories.actionTickets.getByRun(run.id);
    const gate =
      request.gateId === undefined
        ? undefined
        : await this.repositories.actionTickets.getGate(request.gateId);
    const identity = this.failureIdentity({
      run,
      scene,
      request,
      requestDigest,
      agentPrincipalId,
      ticket,
      gate,
    });
    let claimed: ToolInvocationRecord | undefined;
    let pathMetadata: {
      readonly pathDigest?: string;
      readonly pathSummary?: string;
      readonly byteCount?: number;
    } = this.pathMetadata(request);

    try {
      await this.assertFeatureEnabled(run, category);
      if (ticket === undefined) {
        throw new AgentTaskToolError(
          "action_ticket_missing",
          "Protected tools require a current Action Ticket",
          403,
        );
      }
      this.assertTicket(run, ticket, category);
      const gateError = this.gateDecision(run, ticket, gate, category);
      if (gateError !== undefined) throw gateError;
      try {
        await this.executionGates.assertRunAction({
          runId: run.id,
          action: writebackAction(run),
        });
      } catch (error) {
        if (error instanceof ExecutionGateError) {
          throw new AgentTaskToolError(
            error.code,
            error.message,
            error.statusCode,
            error.details,
          );
        }
        throw error;
      }

      const begun = await this.repositories.agentTools.begin({
        runId: run.id,
        runAttempt: run.attempt,
        sceneSessionId: scene.id,
        taskId: run.taskId,
        projectId: run.projectId,
        agentId: run.agentId,
        agentPrincipalId,
        envelopeId: run.executionEnvelope.id,
        envelopeDigest: run.executionEnvelope.digest,
        ticketId: ticket.ticketId,
        gateId: gate!.gateId,
        tool: request.tool,
        toolCategory: category,
        requestDigest,
        idempotencyKey: request.idempotencyKey,
      });
      if (begun.kind === "idempotency_conflict") {
        throw new AgentTaskToolError(
          "agent_tool_idempotency_conflict",
          "The idempotency key was used with different arguments or scope",
          409,
        );
      }
      if (begun.kind === "gate_already_used") {
        await this.appendRunRejection(
          run.id,
          request.tool,
          "execution_gate_already_used",
        );
        throw new AgentTaskToolError(
          "execution_gate_already_used",
          "An Execution Gate can authorize only one tool action",
          409,
        );
      }
      if (begun.kind === "in_progress") {
        throw new AgentTaskToolError(
          "agent_tool_invocation_in_progress",
          "This idempotent tool invocation is already in progress",
          409,
        );
      }
      if (begun.kind === "failed") {
        throw new AgentTaskToolError(
          begun.invocation.rejectionCode ?? "agent_tool_invocation_failed",
          begun.invocation.rejectionReason ?? "Tool invocation previously failed",
          409,
          { invocationId: begun.invocation.id },
        );
      }
      if (begun.kind === "replay") {
        if (begun.invocation.result === null) {
          throw new AgentTaskToolError(
            "agent_tool_replay_missing_result",
            "Completed tool invocation has no replayable result",
            409,
          );
        }
        return {
          invocationId: begun.invocation.id,
          runId: run.id,
          runAttempt: run.attempt,
          tool: request.tool,
          status: "succeeded",
          deduplicated: true,
          result: begun.invocation.result,
        };
      }
      claimed = begun.invocation;

      const outcome = await this.execute({
        run,
        scene,
        taskId: run.taskId,
        agentPrincipalId,
        request,
      });
      pathMetadata = outcome.path;
      const completed = await this.repositories.agentTools.succeed({
        id: claimed.id,
        result: outcome.result,
        eventResult: outcome.eventResult,
        ...(outcome.path.pathDigest === undefined
          ? {}
          : { pathDigest: outcome.path.pathDigest }),
        ...(outcome.path.pathSummary === undefined
          ? {}
          : { pathSummary: outcome.path.pathSummary }),
        ...(outcome.path.byteCount === undefined
          ? {}
          : { byteCount: outcome.path.byteCount }),
      });
      return {
        invocationId: completed.id,
        runId: run.id,
        runAttempt: run.attempt,
        tool: request.tool,
        status: "succeeded",
        deduplicated: false,
        result: outcome.result,
      };
    } catch (error) {
      const normalized = this.normalizeError(error);
      if (claimed !== undefined) {
        await this.repositories.agentTools
          .fail({
            id: claimed.id,
            rejectionCode: normalized.code,
            rejectionReason: normalized.message,
            ...pathMetadata,
          })
          .catch(() => undefined);
      } else if (identity !== undefined && normalized.code !== "agent_tool_invocation_in_progress") {
        await this.repositories.agentTools
          .recordFailure({
            identity,
            rejectionCode: normalized.code,
            rejectionReason: normalized.message,
            ...pathMetadata,
          })
          .catch(() => undefined);
      }
      throw normalized;
    }
  }

  private failureIdentity(input: {
    readonly run: Run;
    readonly scene: SceneSessionBinding;
    readonly request: AgentTaskToolRequest;
    readonly requestDigest: string;
    readonly agentPrincipalId: string;
    readonly ticket: ActionTicket | undefined;
    readonly gate: ExecutionGateRecord | undefined;
  }): ToolInvocationIdentity | undefined {
    if (input.run.executionEnvelope === null || input.run.taskId === null) {
      return undefined;
    }
    return {
      runId: input.run.id,
      runAttempt: input.run.attempt,
      sceneSessionId: input.scene.id,
      taskId: input.run.taskId,
      projectId: input.run.projectId,
      agentId: input.run.agentId,
      agentPrincipalId: input.agentPrincipalId,
      envelopeId: input.run.executionEnvelope.id,
      envelopeDigest: input.run.executionEnvelope.digest,
      ticketId: input.ticket?.ticketId ?? null,
      gateId: input.gate?.gateId ?? null,
      tool: input.request.tool,
      toolCategory: toolCategory(input.request.tool),
      requestDigest: input.requestDigest,
      idempotencyKey: input.request.idempotencyKey,
    };
  }

  private async assertFeatureEnabled(
    run: Run,
    category: ToolCategory,
  ): Promise<void> {
    const flagKey =
      category.startsWith("fs.")
        ? AGENT_WORKSPACE_FILES_FLAG
        : AGENT_TASK_TOOLS_FLAG;
    if (
      !(await this.repositories.featureFlags.isEnabled(flagKey, run.projectId))
    ) {
      throw new AgentTaskToolError(
        "agent_tool_feature_disabled",
        `Feature Flag ${flagKey} is disabled`,
        403,
        { flagKey },
      );
    }
  }

  private assertTicket(
    run: Run,
    ticket: ActionTicket,
    category: ToolCategory,
  ): void {
    const envelope = run.executionEnvelope!;
    const action = writebackAction(run);
    if (
      ticket.runId !== run.id ||
      ticket.taskId !== run.taskId ||
      ticket.contextType !== envelope.contextType ||
      ticket.contextId !== envelope.contextId ||
      ticket.workspaceId !== envelope.envelope.workspaceId ||
      ticket.envelopeId !== envelope.id ||
      ticket.envelopeDigest !== envelope.digest ||
      !ticket.allowedActions.includes(action) ||
      ticket.deniedActions.includes(action) ||
      !ticket.resourceScopes.includes(`run:${run.id}`) ||
      !ticket.resourceScopes.includes(
        `workspace:${envelope.envelope.workspaceId}`,
      ) ||
      !ticket.resourceScopes.includes(
        `context:${envelope.contextType}:${envelope.contextId}`,
      ) ||
      !ticket.resourceScopes.includes(`tool:${category}`) ||
      !envelope.envelope.resolved.allowedToolCategories.includes(category)
    ) {
      throw new AgentTaskToolError(
        "action_ticket_scope_mismatch",
        "Action Ticket is not scoped to this Run, resource and Tool category",
        403,
      );
    }
  }

  private gateDecision(
    run: Run,
    ticket: ActionTicket,
    gate: ExecutionGateRecord | undefined,
    category: ToolCategory,
  ): AgentTaskToolError | undefined {
    const envelope = run.executionEnvelope!;
    if (gate === undefined) {
      return new AgentTaskToolError(
        "execution_gate_missing",
        "Protected tools require an Execution Gate decision",
        403,
      );
    }
    if (
      gate.ticketId !== ticket.ticketId ||
      gate.runId !== run.id ||
      gate.taskId !== run.taskId ||
      gate.projectId !== run.projectId ||
      gate.envelopeId !== envelope.id ||
      gate.envelopeDigest !== envelope.digest ||
      gate.policyRevision !== ticket.policyRevision ||
      gate.requestedToolCategory !== category ||
      gate.enforcement !== "blocking" ||
      !gate.resourceScopes.includes(`tool:${category}`) ||
      !gate.resourceScopes.includes(
        `workspace:${envelope.envelope.workspaceId}`,
      )
    ) {
      return new AgentTaskToolError(
        "execution_gate_scope_mismatch",
        "Execution Gate is not bound to this Run, Ticket and Tool resource",
        403,
        { gateId: gate.gateId },
      );
    }
    if (new Date(gate.expiresAt).getTime() <= this.now().getTime()) {
      return new AgentTaskToolError(
        "execution_gate_expired",
        "Execution Gate expired",
        409,
        { gateId: gate.gateId },
      );
    }
    if (gate.status === "pending") {
      return new AgentTaskToolError(
        "execution_gate_waiting",
        "Execution Gate is still waiting for a decision",
        409,
        { gateId: gate.gateId },
      );
    }
    if (gate.status === "denied") {
      return new AgentTaskToolError(
        "execution_gate_denied",
        "Execution Gate denied this action",
        403,
        { gateId: gate.gateId },
      );
    }
    if (gate.status === "expired") {
      return new AgentTaskToolError(
        "execution_gate_expired",
        "Execution Gate expired",
        409,
        { gateId: gate.gateId },
      );
    }
    if (gate.status === "cancelled") {
      return new AgentTaskToolError(
        "execution_gate_cancelled",
        "Execution Gate was cancelled",
        409,
        { gateId: gate.gateId },
      );
    }
    if (
      gate.decision === null ||
      gate.decision.decision !== "approve" ||
      gate.decision.envelopeId !== envelope.id ||
      gate.decision.envelopeDigest !== envelope.digest ||
      gate.decision.policyRevision !== gate.policyRevision
    ) {
      return new AgentTaskToolError(
        "execution_gate_decision_invalid",
        "Execution Gate decision is not bound to the current Envelope",
        409,
        { gateId: gate.gateId },
      );
    }
    return undefined;
  }

  private async execute(input: {
    readonly run: Run;
    readonly scene: SceneSessionBinding;
    readonly taskId: string;
    readonly agentPrincipalId: string;
    readonly request: AgentTaskToolRequest;
  }): Promise<{
    readonly result: Record<string, unknown>;
    readonly eventResult: Record<string, unknown>;
    readonly path: {
      readonly pathDigest?: string;
      readonly pathSummary?: string;
      readonly byteCount?: number;
    };
  }> {
    const tool = input.request.tool;
    const request = input.request;
    if (isTaskTool(tool)) {
      const agent = await this.repositories.agents.get(input.run.agentId);
      const agentName = agent?.name ?? "Agent";
      const task = await this.repositories.tasks.get(input.taskId);
      if (task === undefined) {
        throw new AgentTaskToolError(
          "agent_tool_task_not_found",
          "Task was not found",
          404,
        );
      }
      if (request.tool === "task_query") {
        const runs = request.payload.includeRuns
          ? (await this.repositories.runs.listByTask(task.id)).map((run) => ({
              id: run.id,
              attempt: run.attempt,
              status: run.status,
              taskExecutionKind: run.taskExecutionKind,
              createdAt: run.createdAt,
            }))
          : [];
        return {
          result: {
            task,
            runs,
          },
          eventResult: {
            taskId: task.id,
            runCount: runs.length,
          },
          path: {},
        };
      }
      if (request.tool === "task_comment") {
        const message = await this.repositories.agentTools.commentTask({
          taskId: task.id,
          agentPrincipalId: input.agentPrincipalId,
          agentName,
          content: request.payload.content,
          isKeyConsensus: request.payload.isKeyConsensus,
        });
        return {
          result: {
            messageId: message.messageId,
            revision: task.revision,
          },
          eventResult: {
            taskId: task.id,
            messageId: message.messageId,
          },
          path: {},
        };
      }
      if (request.tool === "task_request_input") {
        const updated = await this.repositories.agentTools.requestTaskInput({
          taskId: task.id,
          agentPrincipalId: input.agentPrincipalId,
          agentName,
          prompt: request.payload.prompt,
        });
        return {
          result: {
            messageId: updated.messageId,
            revision: updated.revision,
            status: "needs_input",
          },
          eventResult: {
            taskId: task.id,
            messageId: updated.messageId,
            status: "needs_input",
          },
          path: {},
        };
      }
      if (input.run.status !== "completed") {
        throw new AgentTaskToolError(
          "acceptance_evidence_stale_run",
          "Deliverable confirmation requires the current owner Run to be completed",
          409,
        );
      }
      if (request.tool !== "task_submit_deliverable") {
        throw new AgentTaskToolError(
          "agent_tool_unreachable",
          "Task tool routing failed",
          500,
        );
      }
      const projection = await this.acceptance.confirmExecutionEvidence({
        taskId: task.id,
        actorPrincipalId: input.agentPrincipalId,
        evidence: {
          runId: input.run.id,
          items: request.payload.items,
        },
      });
      return {
        result: {
          taskId: task.id,
          runId: input.run.id,
          confirmedItemIds: projection.items
            .filter((item) => item.currentConfirmation !== null)
            .map((item) => item.id),
          allRequiredConfirmed: projection.allRequiredConfirmed,
        },
        eventResult: {
          taskId: task.id,
          runId: input.run.id,
          confirmedItemCount: projection.items.filter(
            (item) => item.currentConfirmation !== null,
          ).length,
          allRequiredConfirmed: projection.allRequiredConfirmed,
        },
        path: {},
      };
    }

    const sandbox = new WorkspaceFileSandbox(
      runWorkspacePath(this.options.workspaceRoot, input.run.id),
      this.options.limits ?? DEFAULT_AGENT_TOOL_WORKSPACE_LIMITS,
    );
    if (request.tool === "read_file") {
      const read = await sandbox.readFile(request.payload.path);
      return {
        result: {
          path: read.relativePath,
          encoding: "utf8",
          content: Buffer.from(read.content).toString("utf8"),
          byteCount: read.byteCount,
          sha256: read.sha256,
        },
        eventResult: {
          pathDigest: read.pathDigest,
          byteCount: read.byteCount,
          status: "read",
        },
        path: {
          pathDigest: read.pathDigest,
          pathSummary: read.pathSummary,
          byteCount: read.byteCount,
        },
      };
    }
    if (request.tool === "write_file") {
      const written = await sandbox.writeFile(
        request.payload.path,
        Buffer.from(request.payload.content, "utf8"),
      );
      return {
        result: {
          path: written.relativePath,
          byteCount: written.byteCount,
          sha256: written.sha256,
          replaced: written.replaced,
          atomic: true,
        },
        eventResult: {
          pathDigest: written.pathDigest,
          byteCount: written.byteCount,
          atomic: true,
          status: "written",
        },
        path: {
          pathDigest: written.pathDigest,
          pathSummary: written.pathSummary,
          byteCount: written.byteCount,
        },
      };
    }
    if (request.tool !== "list_files") {
      throw new AgentTaskToolError(
        "agent_tool_unreachable",
        "File tool routing failed",
        500,
      );
    }
    const listed = await sandbox.listFiles(
      request.payload.path,
      request.payload.depth,
    );
    return {
      result: {
        path: request.payload.path,
        depth: request.payload.depth,
        entries: listed.entries,
        entryCount: listed.entryCount,
        byteCount: listed.byteCount,
      },
      eventResult: {
        pathDigest: listed.pathDigest,
        entryCount: listed.entryCount,
        byteCount: listed.byteCount,
        status: "listed",
      },
      path: {
        pathDigest: listed.pathDigest,
        pathSummary: listed.pathSummary,
        byteCount: listed.byteCount,
      },
    };
  }

  private normalizeError(error: unknown): AgentTaskToolError {
    if (error instanceof AgentTaskToolError) return error;
    if (error instanceof WorkspacePathError) {
      return new AgentTaskToolError(
        error.code,
        error.message,
        403,
        error.details,
      );
    }
    if (error instanceof AgentToolRepositoryError) {
      return new AgentTaskToolError(error.code, error.message, 409);
    }
    if (error instanceof ApplicationError) {
      return new AgentTaskToolError(
        error.code,
        error.message,
        error.statusCode,
        error.details,
      );
    }
    if (error instanceof ExecutionGateError) {
      return new AgentTaskToolError(
        error.code,
        error.message,
        error.statusCode,
        error.details,
      );
    }
    return new AgentTaskToolError(
      "agent_tool_execution_failed",
      error instanceof Error ? error.message : "Tool execution failed",
      500,
    );
  }

  private pathMetadata(request: AgentTaskToolRequest): {
    readonly pathDigest?: string;
    readonly pathSummary?: string;
  } {
    if (
      request.tool !== "read_file" &&
      request.tool !== "write_file" &&
      request.tool !== "list_files"
    ) {
      return {};
    }
    const path = request.payload.path;
    const safePath = [...path]
      .map((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code < 32 || code === 127 ? "?" : character;
      })
      .join("");
    return {
      pathDigest: digest(path),
      pathSummary:
        safePath.length <= 160
          ? safePath
          : `.../${safePath.split("/").slice(-2).join("/")}`,
    };
  }

  private async appendRunRejection(
    runId: string,
    tool: AgentTaskToolName,
    code: string,
  ): Promise<void> {
    await this.repositories.runs
      .appendEvent(runId, "warning", `Tool ${tool} 被拒绝`, {
        tool,
        rejectionCode: code,
      })
      .catch(() => undefined);
  }
}
