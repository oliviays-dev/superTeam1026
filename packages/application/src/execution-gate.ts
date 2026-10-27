import { isDeepStrictEqual } from "node:util";
import type {
  ActionTicket,
  ActionTicketAction,
  ActionTicketBundle,
  ActionTicketUsage,
  ExecutionGateRecord,
  Run,
} from "@pluginmax/contracts";
import type { PlatformRepositories } from "@pluginmax/database";
import { executionEnvelopeDigest } from "./task-execution-preflight.js";

export class ExecutionGateError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 409,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ExecutionGateError";
  }
}

function actionTicketRunMismatch(
  ticket: ActionTicket,
  run: Run,
): string | undefined {
  if (run.executionEnvelope === null) return "execution_envelope_missing";
  const envelope = run.executionEnvelope;
  if (ticket.runId !== run.id) return "ticket_run_mismatch";
  if (ticket.principalId !== envelope.principalId) {
    return "ticket_principal_mismatch";
  }
  if (ticket.contextType !== envelope.contextType) {
    return "ticket_context_mismatch";
  }
  if (ticket.contextId !== envelope.contextId) {
    return "ticket_context_mismatch";
  }
  const runTaskReference =
    run.taskId ?? run.meetingTurnId ?? run.directChatTurnId ?? null;
  if (runTaskReference !== null && ticket.taskId !== runTaskReference) {
    return "ticket_task_mismatch";
  }
  if (ticket.workspaceId !== envelope.envelope.workspaceId) {
    return "ticket_workspace_mismatch";
  }
  if (
    ticket.policyId !== envelope.policy.id ||
    ticket.policyRevision !== envelope.policy.revision
  ) {
    return "ticket_policy_revision_mismatch";
  }
  if (
    ticket.envelopeId !== envelope.id ||
    ticket.envelopeDigest !== envelope.digest
  ) {
    return "ticket_envelope_mismatch";
  }
  if (
    envelope.digest !== executionEnvelopeDigest(envelope) ||
    !isDeepStrictEqual(ticket.executionEnvelope, envelope)
  ) {
    return "ticket_envelope_snapshot_mismatch";
  }
  if (
    !ticket.resourceScopes.includes(`run:${run.id}`) ||
    !ticket.resourceScopes.includes(`workspace:${ticket.workspaceId}`) ||
    !ticket.resourceScopes.includes(
      `context:${ticket.contextType}:${ticket.contextId}`,
    )
  ) {
    return "ticket_resource_scope_incomplete";
  }
  return undefined;
}

export class ExecutionGateService {
  constructor(
    private readonly repositories: PlatformRepositories,
    private readonly options: { readonly now?: () => Date } = {},
  ) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  async getBundle(runId: string): Promise<ActionTicketBundle | undefined> {
    return this.repositories.actionTickets.getBundle(runId);
  }

  async getGate(gateId: string): Promise<ExecutionGateRecord | undefined> {
    return this.repositories.actionTickets.getGate(gateId);
  }

  async expireDue(limit = 50) {
    return this.repositories.actionTickets.expireDue(limit);
  }

  async assertRunAction(input: {
    readonly runId: string;
    readonly action: ActionTicketAction;
    readonly allowExpired?: boolean;
  }): Promise<ActionTicket> {
    const run = await this.repositories.runs.get(input.runId);
    if (run === undefined) {
      throw new ExecutionGateError("run_not_found", "Run not found", 404);
    }
    const ticket = await this.repositories.actionTickets.getByRun(run.id);
    if (ticket === undefined) {
      throw new ExecutionGateError(
        "action_ticket_missing",
        "Run dispatch requires a valid Action Ticket",
      );
    }
    const mismatch = actionTicketRunMismatch(ticket, run);
    if (mismatch !== undefined) {
      throw new ExecutionGateError(
        mismatch,
        "Action Ticket does not match the Run execution snapshot",
      );
    }
    if (
      !ticket.allowedActions.includes(input.action) ||
      ticket.deniedActions.includes(input.action)
    ) {
      throw new ExecutionGateError(
        "action_ticket_denied",
        `Action Ticket does not allow ${input.action}`,
        403,
      );
    }
    if (
      !input.allowExpired &&
      new Date(ticket.expiresAt).getTime() <= this.now().getTime()
    ) {
      throw new ExecutionGateError(
        "action_ticket_expired",
        "Action Ticket has expired",
      );
    }
    const principal =
      await this.repositories.authorization.getPrincipal(ticket.principalId);
    if (
      principal === undefined ||
      principal.status !== "active" ||
      principal.accountStatus === "disabled"
    ) {
      throw new ExecutionGateError(
        "principal_not_active",
        "Action Ticket Principal is no longer active",
        403,
      );
    }
    if (ticket.executionEnvelope.projectId !== null) {
      const decision = await this.repositories.authorization.authorizeProject({
        principalId: ticket.principalId,
        authSource:
          principal.source === "local" ? "local-development" : "bearer",
        projectId: ticket.executionEnvelope.projectId,
        permission: "write",
      });
      if (!decision.allowed) {
        throw new ExecutionGateError(
          decision.reason === "project_archived"
            ? "project_archived"
            : "principal_grant_missing",
          "Action Ticket Principal no longer has Project execution permission",
          decision.reason === "project_archived" ? 409 : 403,
          {
            reason: decision.reason,
            projectId: ticket.executionEnvelope.projectId,
          },
        );
      }
    } else if (
      !(await this.repositories.directChats.canAccessRun(
        run.id,
        ticket.principalId,
      ))
    ) {
      throw new ExecutionGateError(
        "direct_chat_forbidden",
        "Action Ticket Principal does not own this Direct Chat run",
        403,
      );
    }
    if (ticket.policyId !== null) {
      const policy = await this.repositories.taskExecutionPolicies.getRevision(
        ticket.policyId,
        ticket.policyRevision,
      );
      if (policy === undefined) {
        throw new ExecutionGateError(
          "policy_revision_unavailable",
          "Action Ticket policy revision is unavailable",
        );
      }
    }
    const gates = await this.repositories.actionTickets.listGatesByRun(run.id);
    for (const gate of gates) {
      if (gate.status === "pending" && gate.enforcement === "blocking") {
        throw new ExecutionGateError(
          "execution_gate_waiting",
          "Execution is waiting for a blocking Gate decision",
          409,
          { gateId: gate.gateId },
        );
      }
      if (gate.status === "denied") {
        throw new ExecutionGateError(
          "execution_gate_denied",
          "A blocking Execution Gate rejected this Run",
          403,
          { gateId: gate.gateId },
        );
      }
      if (gate.status === "expired") {
        throw new ExecutionGateError(
          "execution_gate_timeout",
          "A blocking Execution Gate expired",
          409,
          { gateId: gate.gateId },
        );
      }
      if (gate.status === "cancelled") {
        throw new ExecutionGateError(
          "execution_gate_cancelled",
          "A blocking Execution Gate was cancelled",
          409,
          { gateId: gate.gateId },
        );
      }
      if (gate.enforcement !== "blocking") continue;
      if (
        gate.decision === null ||
        gate.decision.policyRevision !== gate.policyRevision ||
        gate.decision.envelopeId !== gate.envelopeId ||
        gate.decision.envelopeDigest !== gate.envelopeDigest
      ) {
        throw new ExecutionGateError(
          "execution_gate_decision_invalid",
          "Execution Gate decision is not bound to the Ticket snapshot",
        );
      }
    }
    return ticket;
  }

  async beginRunAction(input: {
    readonly runId: string;
    readonly action: ActionTicketAction;
    readonly idempotencyKey: string;
    readonly allowInProgress?: boolean;
  }): Promise<ActionTicketUsage> {
    const existing = await this.repositories.actionTickets.getUsage(input);
    await this.assertRunAction({
      runId: input.runId,
      action: input.action,
      allowExpired: existing !== undefined,
    });
    const result = await this.repositories.actionTickets.beginUsage({
      runId: input.runId,
      action: input.action,
      idempotencyKey: input.idempotencyKey,
      allowExpired: existing !== undefined,
    });
    if (result.kind === "claimed" || result.kind === "replay") {
      return result.usage;
    }
    if (result.kind === "in_progress" && input.allowInProgress) {
      return result.usage;
    }
    if (result.kind === "ticket_missing") {
      throw new ExecutionGateError(
        "action_ticket_missing",
        "Run dispatch requires a valid Action Ticket",
      );
    }
    if (result.kind === "action_denied") {
      throw new ExecutionGateError(
        result.reason,
        "Action Ticket denied this action",
        403,
      );
    }
    throw new ExecutionGateError(
      "action_ticket_usage_in_progress",
      "This Action Ticket action is already in progress and cannot be replayed",
    );
  }

  async completeRunAction(input: {
    readonly runId: string;
    readonly action: ActionTicketAction;
    readonly idempotencyKey: string;
    readonly result?: Record<string, unknown>;
  }): Promise<ActionTicketUsage | undefined> {
    return this.repositories.actionTickets.completeUsage(input);
  }
}
