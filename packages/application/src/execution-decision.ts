import type {
  ActionDecision,
  ExecutionDecision,
  ExecutionDecisionPermission,
  ExecutionDecisionReason,
} from "@pluginmax/contracts";
import type {
  PlatformRepositories,
  ScopeAuthorizationDecision,
} from "@pluginmax/database";
import { ExecutionGateError, ExecutionGateService } from "./execution-gate.js";

export class ExecutionDecisionError extends Error {
  constructor(
    readonly code:
      | "execution_authorization_denied"
      | "execution_dispatch_ineligible"
      | "execution_runtime_unavailable"
      | "execution_action_resource_mismatch",
    message: string,
    readonly statusCode = 403,
    readonly decision?: ExecutionDecision,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ExecutionDecisionError";
  }
}

function authorizationReasons(
  decision: ScopeAuthorizationDecision,
): ExecutionDecisionReason[] {
  if (decision.allowed) return [];
  return [
    {
      code: decision.reason ?? "permission_missing",
      message: `Project ${decision.permission} permission was not granted`,
      source: "authorization.project",
    },
  ];
}

function runtimeKindNeedsBinding(runtimeKind: string): boolean {
  return runtimeKind === "codex-jsonl" || runtimeKind === "plain-text";
}

export class ExecutionDecisionService {
  private readonly executionGates: ExecutionGateService;

  constructor(private readonly repositories: PlatformRepositories) {
    this.executionGates = new ExecutionGateService(repositories);
  }

  async decideDispatch(input: {
    readonly projectId: string;
    readonly principalId: string;
    readonly authSource: "bearer" | "local-development";
    readonly permission: ExecutionDecisionPermission;
    readonly taskId: string;
    readonly agentId: string;
    readonly expectedRuntimeRevision?: number;
    readonly expectedBindingRevision?: number;
    readonly expectedPolicyRevision?: number;
  }): Promise<ExecutionDecision> {
    const [authorization, project, agent, policy] = await Promise.all([
      this.repositories.authorization.authorizeProject({
        principalId: input.principalId,
        authSource: input.authSource,
        projectId: input.projectId,
        permission: input.permission,
      }),
      this.repositories.projects.get(input.projectId),
      this.repositories.agents.get(input.agentId, true),
      this.repositories.taskExecutionPolicies.resolve({
        contextType: "task",
        contextId: input.taskId,
        projectId: input.projectId,
      }),
    ]);
    const dispatchReasons: ExecutionDecisionReason[] = [];
    let runtimeRevision: number | undefined;
    let bindingRevision: number | undefined;
    if (project === undefined) {
      dispatchReasons.push({
        code: "project_not_found",
        message: "Project was not found",
        source: "dispatch.project",
      });
    } else if (project.status !== "active") {
      dispatchReasons.push({
        code: "project_archived",
        message: "Archived projects cannot dispatch Runs",
        source: "dispatch.project",
      });
    }
    if (agent === undefined || agent.status !== "active") {
      dispatchReasons.push({
        code: "agent_unavailable",
        message: "Assigned Agent is unavailable",
        source: "dispatch.agent",
      });
    } else if (runtimeKindNeedsBinding(agent.runtimeKind)) {
      const binding = await this.repositories.agentRuntimeBindings.getCurrent(
        agent.id,
      );
      if (binding === undefined) {
        dispatchReasons.push({
          code: "runtime_binding_missing",
          message: "External Runtime binding is missing",
          source: "dispatch.runtime",
        });
      } else if (binding.status !== "active") {
        dispatchReasons.push({
          code: "runtime_binding_inactive",
          message: "External Runtime binding is inactive",
          source: "dispatch.runtime",
        });
      } else {
        bindingRevision = binding.revision;
        const runtime = await this.repositories.externalRuntimes.get(
          binding.runtimeId,
        );
        if (runtime === undefined || runtime.status !== "active") {
          dispatchReasons.push({
            code: "runtime_unavailable",
            message: "Bound Runtime is unavailable",
            source: "dispatch.runtime",
          });
        } else {
          runtimeRevision = runtime.revision;
        }
      }
    } else {
      runtimeRevision = 1;
      bindingRevision = 1;
    }
    if (
      input.expectedRuntimeRevision !== undefined &&
      runtimeRevision !== input.expectedRuntimeRevision
    ) {
      dispatchReasons.push({
        code: "runtime_revision_changed",
        message: "Runtime revision changed after preflight",
        source: "dispatch.runtime",
      });
    }
    if (
      input.expectedBindingRevision !== undefined &&
      bindingRevision !== input.expectedBindingRevision
    ) {
      dispatchReasons.push({
        code: "binding_revision_changed",
        message: "Runtime binding changed after preflight",
        source: "dispatch.runtime",
      });
    }
    if (
      input.expectedPolicyRevision !== undefined &&
      policy.revision !== input.expectedPolicyRevision
    ) {
      dispatchReasons.push({
        code: "policy_revision_changed",
        message: "TaskExecutionPolicy changed after preflight",
        source: "dispatch.policy",
      });
    }
    if (
      policy.policy.runtime.allowedRuntimeIds.length > 0 &&
      agent !== undefined &&
      !policy.policy.runtime.allowedRuntimeIds.includes(
        runtimeKindNeedsBinding(agent.runtimeKind)
          ? `runtime:${agent.id}`
          : `builtin:${agent.runtimeKind}`,
      )
    ) {
      // External runtime IDs are checked again by TaskExecutionPreflight.
      if (!runtimeKindNeedsBinding(agent.runtimeKind)) {
        dispatchReasons.push({
          code: "runtime_not_allowed",
          message: "Runtime is outside the TaskExecutionPolicy allowlist",
          source: "dispatch.policy",
        });
      }
    }
    const decision: ExecutionDecision = {
      projectId: input.projectId,
      principalId: input.principalId,
      authorization: {
        allowed: authorization.allowed,
        permission: input.permission,
        grantIds: [...authorization.grantIds],
        ...(authorization.membershipId === undefined
          ? {}
          : { membershipId: authorization.membershipId }),
        reasons: authorizationReasons(authorization),
      },
      dispatchEligibility: {
        allowed:
          authorization.allowed &&
          project?.status === "active" &&
          agent?.status === "active" &&
          dispatchReasons.length === 0,
        runtimeRevision,
        policyRevision: policy.revision,
        bindingRevision,
        reasons: dispatchReasons,
      },
      decidedAt: new Date().toISOString(),
      cacheable: false,
    };
    return decision;
  }

  async assertDispatch(input: Parameters<ExecutionDecisionService["decideDispatch"]>[0]): Promise<ExecutionDecision> {
    const decision = await this.decideDispatch(input);
    if (!decision.authorization.allowed) {
      const reason = decision.authorization.reasons[0];
      throw new ExecutionDecisionError(
        "execution_authorization_denied",
        "Dispatch authorization changed after preflight",
        403,
        decision,
        { reasons: decision.authorization.reasons, reason },
      );
    }
    if (!decision.dispatchEligibility.allowed) {
      const runtimeOnly = decision.dispatchEligibility.reasons.every((reason) =>
        reason.source.startsWith("dispatch.runtime"),
      );
      throw new ExecutionDecisionError(
        runtimeOnly
          ? "execution_runtime_unavailable"
          : "execution_dispatch_ineligible",
        "Task dispatch prerequisites changed after preflight",
        runtimeOnly ? 409 : 403,
        decision,
        { reasons: decision.dispatchEligibility.reasons },
      );
    }
    return decision;
  }

  async assertDispatchAuthorization(
    input: Parameters<ExecutionDecisionService["decideDispatch"]>[0],
  ): Promise<ExecutionDecision> {
    const decision = await this.decideDispatch(input);
    if (!decision.authorization.allowed) {
      const reason = decision.authorization.reasons[0];
      throw new ExecutionDecisionError(
        "execution_authorization_denied",
        "Dispatch authorization changed after preflight",
        403,
        decision,
        { reasons: decision.authorization.reasons, reason },
      );
    }
    return decision;
  }

  async decideAction(input: {
    readonly runId: string;
    readonly principalId: string;
    readonly action: string;
    readonly resourceId: string;
  }): Promise<ActionDecision> {
    const run = await this.repositories.runs.get(input.runId);
    if (run === undefined) {
      return {
        allowed: false,
        action: input.action,
        resourceId: input.resourceId,
        runId: input.runId,
        reasons: [
          {
            code: "run_not_found",
            message: "Run was not found",
            source: "action.run",
          },
        ],
      };
    }
    const ticket = await this.repositories.actionTickets.getByRun(run.id);
    const normalizedResource =
      input.resourceId.includes(":")
        ? input.resourceId
        : `task:${input.resourceId}`;
    const resourceMatches =
      input.resourceId === ticket?.taskId ||
      input.resourceId === ticket?.contextId ||
      input.resourceId === ticket?.runId ||
      ticket?.resourceScopes.includes(input.resourceId) === true ||
      ticket?.resourceScopes.includes(normalizedResource) === true;
    if (!resourceMatches) {
      return {
        allowed: false,
        action: input.action,
        resourceId: input.resourceId,
        runId: input.runId,
        ...(ticket === undefined ? {} : { ticketId: ticket.ticketId }),
        reasons: [
          {
            code: "action_resource_mismatch",
            message:
              "The Action Ticket is not scoped to this action resource",
            source: "action.ticket",
          },
        ],
      };
    }
    if (ticket?.principalId !== input.principalId) {
      return {
        allowed: false,
        action: input.action,
        resourceId: input.resourceId,
        runId: input.runId,
        ...(ticket === undefined ? {} : { ticketId: ticket.ticketId }),
        reasons: [
          {
            code: "action_principal_mismatch",
            message: "The Action Ticket belongs to another Principal",
            source: "action.ticket",
          },
        ],
      };
    }
    try {
      await this.executionGates.assertRunAction({
        runId: input.runId,
        action: input.action as never,
      });
      return {
        allowed: true,
        action: input.action,
        resourceId: input.resourceId,
        runId: input.runId,
        ...(ticket === undefined ? {} : { ticketId: ticket.ticketId }),
        reasons: [],
      };
    } catch (error) {
      const gateError =
        error instanceof ExecutionGateError
          ? error
          : new ExecutionGateError(
              "execution_gate_error",
              error instanceof Error ? error.message : String(error),
            );
      return {
        allowed: false,
        action: input.action,
        resourceId: input.resourceId,
        runId: input.runId,
        ...(ticket === undefined ? {} : { ticketId: ticket.ticketId }),
        reasons: [
          {
            code: gateError.code,
            message: gateError.message,
            source: "action.gate",
          },
        ],
      };
    }
  }

  async assertAction(
    input: Parameters<ExecutionDecisionService["decideAction"]>[0],
  ): Promise<ActionDecision> {
    const decision = await this.decideAction(input);
    if (!decision.allowed) {
      const mismatch = decision.reasons.some(
        (reason) => reason.code === "action_resource_mismatch",
      );
      throw new ExecutionDecisionError(
        mismatch
          ? "execution_action_resource_mismatch"
          : "execution_dispatch_ineligible",
        mismatch
          ? "Action Ticket cannot be reused for another resource"
          : "Execution action was denied",
        mismatch ? 403 : 409,
        undefined,
        { actionDecision: decision },
      );
    }
    return decision;
  }
}
