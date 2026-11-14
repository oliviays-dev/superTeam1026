import { createHash } from "node:crypto";
import type {
  CreateDelegationConfirmationInput,
  CreateDelegationInput,
  DecideDelegationConfirmationInput,
  Delegation,
  DelegationAction,
  DelegationActionCheckInput,
  DelegationActionCheckResult,
  DelegationConfirmationRequest,
  DelegationEvent,
  DelegationNotification,
  DelegationOverview,
  DelegationPermissionPreview,
  DelegationReport,
  DelegationRun,
  DelegationStatus,
  DelegationTicketBinding,
  ExtendDelegationInput,
  UpdateDelegationInput,
  MeetingDelegate,
  SceneSessionBinding,
} from "@pluginmax/contracts";
import type {
  DelegationRepository,
  PlatformRepositories,
  ScopedAuthorizationPermission,
} from "@pluginmax/database";
import { delegationContextHash } from "@pluginmax/database";

export class DelegationApplicationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 409,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "DelegationApplicationError";
  }
}

export interface DelegationContextSnapshot {
  readonly delegation: Delegation;
  readonly binding: Omit<SceneSessionBinding, "sceneType" | "ownerPrincipalId"> & {
    readonly sceneType: "delegation";
    readonly ownerPrincipalId: string;
    readonly delegationId: string;
  };
  readonly cursor: Awaited<
    ReturnType<PlatformRepositories["sceneContext"]["cursor"]>
  >;
  readonly contributions: Awaited<
    ReturnType<PlatformRepositories["sceneContext"]["listContributions"]>
  >;
}

interface DelegationContext {
  readonly projectId: string;
  readonly label: string;
}

const implementedRuntimeKinds = new Set([
  "fake",
  "dsh-sdk",
  "codex-jsonl",
  "plain-text",
]);

const externalRuntimeKinds = new Set(["codex-jsonl", "plain-text"]);

const riskyActions = new Set<DelegationAction>([
  "submit_deliverable",
  "update_status",
  "reassign",
  "approve",
  "reject",
  "archive",
  "delete",
]);

function permissionForAction(
  action: DelegationAction,
): ScopedAuthorizationPermission {
  if (action === "read_context" || action === "read_materials") return "read";
  if (action === "approve" || action === "reject") return "approve";
  if (action === "reassign") return "manage_members";
  return "write";
}

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

export function delegationPayloadHash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function terminal(status: DelegationStatus): boolean {
  return ["completed", "revoked", "expired"].includes(status);
}

export class DelegationApplicationService {
  private readonly delegations: DelegationRepository;

  constructor(private readonly repositories: PlatformRepositories) {
    this.delegations = repositories.delegations;
  }

  async list(actorPrincipalId: string): Promise<DelegationOverview> {
    const items = await this.delegations.listForPrincipal(actorPrincipalId);
    const now = Date.now();
    return {
      items,
      counts: {
        active: items.filter((item) => item.status === "active").length,
        paused: items.filter((item) => item.status === "paused").length,
        expiringSoon: items.filter(
          (item) =>
            !terminal(item.status) &&
            new Date(item.expiresAt).getTime() - now <=
              24 * 60 * 60 * 1_000,
        ).length,
        attention: items.filter(
          (item) => item.status === "draft" || item.lastFailure !== null,
        ).length,
        draft: items.filter((item) => item.status === "draft").length,
        completed: items.filter((item) => item.status === "completed").length,
        revoked: items.filter((item) => item.status === "revoked").length,
        expired: items.filter((item) => item.status === "expired").length,
      },
    };
  }

  async get(id: string, actorPrincipalId: string): Promise<Delegation> {
    const delegation = await this.require(id);
    this.assertViewer(delegation, actorPrincipalId);
    return delegation;
  }

  async create(
    input: CreateDelegationInput,
    actorPrincipalId: string,
  ): Promise<Delegation> {
    if (new Date(input.expiresAt).getTime() <= Date.now()) {
      throw new DelegationApplicationError(
        "delegation_expired",
        "A Delegation must expire in the future",
        400,
      );
    }
    const owner = await this.requireActivePrincipal(actorPrincipalId);
    const context = await this.resolveContext(
      input.contextType,
      input.contextId,
    );
    if (
      input.projectId !== undefined &&
      input.projectId !== context.projectId
    ) {
      throw new DelegationApplicationError(
        "delegation_scope_mismatch",
        "The requested Project does not match the context scope",
        409,
      );
    }
    const ownerCapability = await this.projectCapability(
      owner.id,
      owner.source,
      context.projectId,
    );
    if (!ownerCapability.includes("read")) {
      throw new DelegationApplicationError(
        "delegation_owner_conflict",
        "The owner cannot read the Delegation context",
        403,
      );
    }
    const missing = [...new Set(input.allowedActions)].filter(
      (action) => !ownerCapability.includes(permissionForAction(action)),
    );
    if (missing.length > 0) {
      throw new DelegationApplicationError(
        "delegation_action_outside_owner_permission",
        "The Delegation requests actions outside the owner's effective permissions",
        403,
        { actions: missing, ownerPermissions: ownerCapability },
      );
    }
    const representative = await this.resolveRepresentative({
      input,
      ownerPrincipalId: owner.id,
      projectId: context.projectId,
    });
    try {
      return await this.delegations.create({
        ownerPrincipalId: owner.id,
        representativePrincipalId: representative.principalId,
        representativeKind: representative.kind,
        representativeAgentId: representative.agentId,
        workspaceId: input.workspaceId ?? context.projectId,
        projectId: context.projectId,
        actorPrincipalId: owner.id,
        value: input,
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DelegationApplicationError(
          "delegation_duplicate",
          "An open Delegation already exists for this owner, context and representative",
          409,
        );
      }
      throw error;
    }
  }

  async update(
    id: string,
    input: UpdateDelegationInput,
    actorPrincipalId: string,
  ): Promise<Delegation> {
    const current = await this.requireOwned(id, actorPrincipalId);
    const nextAllowed = input.allowedActions ?? current.allowedActions;
    const nextPolicy = input.approvalPolicy ?? current.approvalPolicy;
    if (
      (nextAllowed.includes("approve") || nextAllowed.includes("reject")) &&
      nextPolicy !== "auto-within-rules"
    ) {
      throw new DelegationApplicationError(
        "delegation_action_denied",
        "approve and reject require auto-within-rules",
        403,
      );
    }
    if (
      nextAllowed.includes("archive") ||
      nextAllowed.includes("delete")
    ) {
      throw new DelegationApplicationError(
        "delegation_action_denied",
        "Destructive actions are not available to Human Avatars",
        403,
      );
    }
    if (current.projectId !== null) {
      const owner = await this.requireActivePrincipal(actorPrincipalId);
      const capability = await this.projectCapability(
        owner.id,
        owner.source,
        current.projectId,
      );
      const missing = [...new Set(nextAllowed)].filter(
        (action) => !capability.includes(permissionForAction(action)),
      );
      if (missing.length > 0) {
        throw new DelegationApplicationError(
          "delegation_action_outside_owner_permission",
          "The Delegation requests actions outside the owner's effective permissions",
          403,
          { actions: missing },
        );
      }
    }
    return this.applyTransition(
      await this.delegations.update({
        id,
        actorPrincipalId,
        value: input,
      }),
    );
  }

  async activate(
    id: string,
    actorPrincipalId: string,
    expectedRevision: number,
    reason: string,
  ): Promise<Delegation> {
    await this.requireOwned(id, actorPrincipalId);
    const delegation = this.applyTransition(
      await this.delegations.activate({
        id,
        actorPrincipalId,
        expectedRevision,
        reason,
      }),
    );
    if (delegation.contextType === "meeting") {
      await this.syncMeetingProjection(delegation, actorPrincipalId);
    }
    return delegation;
  }

  async pause(
    id: string,
    actorPrincipalId: string,
    expectedRevision: number,
    reason: string,
  ): Promise<Delegation> {
    await this.requireOwned(id, actorPrincipalId);
    return this.applyTransition(
      await this.delegations.pause({
        id,
        actorPrincipalId,
        expectedRevision,
        reason,
      }),
    );
  }

  async resume(
    id: string,
    actorPrincipalId: string,
    expectedRevision: number,
    reason: string,
  ): Promise<Delegation> {
    await this.requireOwned(id, actorPrincipalId);
    return this.applyTransition(
      await this.delegations.resume({
        id,
        actorPrincipalId,
        expectedRevision,
        reason,
      }),
    );
  }

  async extend(
    id: string,
    actorPrincipalId: string,
    input: ExtendDelegationInput,
  ): Promise<Delegation> {
    await this.requireOwned(id, actorPrincipalId);
    return this.applyTransition(
      await this.delegations.extend({
        id,
        actorPrincipalId,
        value: input,
      }),
    );
  }

  async complete(
    id: string,
    actorPrincipalId: string,
    expectedRevision: number,
    reason: string,
  ): Promise<Delegation> {
    await this.requireOwned(id, actorPrincipalId);
    return this.applyTransition(
      await this.delegations.complete({
        id,
        actorPrincipalId,
        expectedRevision,
        reason,
      }),
    );
  }

  async revoke(
    id: string,
    actorPrincipalId: string,
    expectedRevision: number,
    reason: string,
  ): Promise<Delegation> {
    await this.requireOwned(id, actorPrincipalId);
    return this.applyTransition(
      await this.delegations.revoke({
        id,
        actorPrincipalId,
        expectedRevision,
        reason,
      }),
    );
  }

  async preview(
    id: string,
    actorPrincipalId: string,
  ): Promise<DelegationPermissionPreview> {
    const delegation = await this.require(id);
    this.assertViewer(delegation, actorPrincipalId);
    const owner = await this.requireActivePrincipal(delegation.ownerPrincipalId);
    const ownerPermissions =
      delegation.projectId === null
        ? (["read", "write"] as ScopedAuthorizationPermission[])
        : await this.projectCapability(
            owner.id,
            owner.source,
            delegation.projectId,
          );
    const effectiveAllowedActions = delegation.allowedActions.filter(
      (action) =>
        !delegation.deniedActions.includes(action) &&
        ownerPermissions.includes(permissionForAction(action)),
    );
    const expired =
      new Date(delegation.expiresAt).getTime() <= Date.now() ||
      delegation.status === "expired";
    const blockedReason =
      delegation.status !== "active"
        ? `delegation_${delegation.status}`
        : expired
          ? "delegation_expired"
          : effectiveAllowedActions.includes("read_context") ||
              effectiveAllowedActions.includes("read_materials")
            ? null
            : "delegation_read_not_allowed";
    return {
      delegationId: delegation.id,
      revision: delegation.revision,
      status: delegation.status,
      contextType: delegation.contextType,
      contextId: delegation.contextId,
      effectiveAllowedActions,
      deniedActions: delegation.deniedActions,
      approvalPolicy: delegation.approvalPolicy,
      ownerPermissions,
      canReadNow: blockedReason === null,
      blockedReason,
      expiresAt: delegation.expiresAt,
    };
  }

  async checkAction(
    id: string,
    actorPrincipalId: string,
    input: DelegationActionCheckInput,
  ): Promise<DelegationActionCheckResult> {
    const delegation = await this.require(id);
    this.assertViewer(delegation, actorPrincipalId);
    if (
      input.expectedRevision !== undefined &&
      delegation.revision !== input.expectedRevision
    ) {
      throw new DelegationApplicationError(
        "delegation_revision_conflict",
        "Delegation was revised by another request",
        409,
        { currentRevision: delegation.revision },
      );
    }
    const owner = await this.requireActivePrincipal(delegation.ownerPrincipalId);
    const representative = await this.requireActivePrincipal(
      delegation.representativePrincipalId,
    );
    if (
      delegation.status !== "active" ||
      new Date(delegation.expiresAt).getTime() <= Date.now()
    ) {
      return {
        allowed: false,
        action: input.action,
        effectiveRevision: delegation.revision,
        approvalPolicy: delegation.approvalPolicy,
        requiresConfirmation: false,
        reason:
          delegation.status === "active"
            ? "delegation_expired"
            : `delegation_${delegation.status}`,
        ownerPermissions: [],
      };
    }
    if (
      owner.status !== "active" ||
      representative.status !== "active" ||
      owner.accountStatus === "disabled" ||
      representative.accountStatus === "disabled"
    ) {
      return {
        allowed: false,
        action: input.action,
        effectiveRevision: delegation.revision,
        approvalPolicy: delegation.approvalPolicy,
        requiresConfirmation: false,
        reason: "representative_inactive",
        ownerPermissions: [],
      };
    }
    const ownerPermissions =
      delegation.projectId === null
        ? (["read", "write"] as ScopedAuthorizationPermission[])
        : await this.projectCapability(
            owner.id,
            owner.source,
            delegation.projectId,
          );
    const explicitlyAllowed = delegation.allowedActions.includes(input.action);
    const denied = delegation.deniedActions.includes(input.action);
    const ownerAllows = ownerPermissions.includes(
      permissionForAction(input.action),
    );
    const approvalsAllowed =
      input.action !== "approve" && input.action !== "reject"
        ? true
        : delegation.approvalPolicy === "auto-within-rules";
    const suggestOnlyBlocked =
      delegation.approvalPolicy === "suggest-only" &&
      riskyActions.has(input.action);
    const allowed =
      explicitlyAllowed &&
      !denied &&
      ownerAllows &&
      approvalsAllowed &&
      !suggestOnlyBlocked;
    return {
      allowed,
      action: input.action,
      effectiveRevision: delegation.revision,
      approvalPolicy: delegation.approvalPolicy,
      requiresConfirmation:
        allowed && delegation.approvalPolicy === "require-confirmation",
      reason: allowed
        ? delegation.approvalPolicy === "require-confirmation"
          ? "delegation_approval_required"
          : "delegation_action_allowed"
        : denied
          ? "delegation_action_denied"
          : !explicitlyAllowed
            ? "delegation_action_not_allowed"
            : !ownerAllows
              ? "delegation_owner_permission_missing"
              : !approvalsAllowed
                ? "delegation_approval_policy_denied"
                : suggestOnlyBlocked
                  ? "delegation_suggest_only"
                  : "delegation_action_denied",
      ownerPermissions,
    };
  }

  async context(
    id: string,
    actorPrincipalId: string,
  ): Promise<DelegationContextSnapshot> {
    const delegation = await this.require(id);
    this.assertViewer(delegation, actorPrincipalId);
    await this.assertUsable(delegation, "read_context");
    if (
      delegation.representativeKind !== "ai" ||
      delegation.representativeAgentId === null
    ) {
      throw new DelegationApplicationError(
        "delegation_runtime_binding_missing",
        "A Human Avatar Scene requires an AI representative runtime",
        409,
      );
    }
    const binding = await this.repositories.sceneContext.ensureSession({
      sceneType: "delegation",
      sceneId: delegation.id,
      projectId: delegation.projectId,
      agentId: delegation.representativeAgentId,
      agentPrincipalId: delegation.representativePrincipalId,
      ownerPrincipalId: delegation.ownerPrincipalId,
      delegationId: delegation.id,
    });
    await this.repositories.sceneContext.addContribution({
      session: binding,
      sourceKey: `delegation-brief:${delegation.revision}`,
      kind: "delegation-brief",
      version: String(delegation.revision),
      authority: "instruction",
      visibility: "scene",
      text: [
        `Objective: ${delegation.objective}`,
        delegation.stance === "" ? "" : `Stance: ${delegation.stance}`,
        delegation.watchItems.length === 0
          ? ""
          : `Watch items: ${delegation.watchItems.join("; ")}`,
        `Allowed: ${delegation.allowedActions.join(", ")}`,
        `Denied: ${delegation.deniedActions.join(", ")}`,
      ]
        .filter((line) => line !== "")
        .join("\n")
        .slice(0, 20_000),
      sourceRefs: [
        {
          type: "delegation",
          id: delegation.id,
          label: delegation.displayName,
          version: String(delegation.revision),
          ...(delegation.projectId === null
            ? {}
            : { projectId: delegation.projectId }),
          sceneType: "delegation",
          sceneId: delegation.id,
        },
      ],
      createdBy: actorPrincipalId,
      ownerPrincipalId: delegation.ownerPrincipalId,
    });
    const [cursor, contributions] = await Promise.all([
      this.repositories.sceneContext.cursor(binding.id),
      this.repositories.sceneContext.listContributions({
        session: binding,
        actorPrincipalId: delegation.ownerPrincipalId,
      }),
    ]);
    return {
      delegation,
      binding: {
        ...binding,
        sceneType: "delegation",
        ownerPrincipalId: delegation.ownerPrincipalId,
        delegationId: delegation.id,
      },
      cursor,
      contributions,
    };
  }

  events(id: string, actorPrincipalId: string): Promise<DelegationEvent[]> {
    return this.withViewer(id, actorPrincipalId, () => this.delegations.events(id));
  }

  runs(id: string, actorPrincipalId: string): Promise<DelegationRun[]> {
    return this.withViewer(id, actorPrincipalId, () => this.delegations.runs(id));
  }

  report(
    id: string,
    actorPrincipalId: string,
  ): Promise<DelegationReport | undefined> {
    return this.withViewer(id, actorPrincipalId, () =>
      this.delegations.report(id),
    );
  }

  confirmations(
    id: string,
    actorPrincipalId: string,
  ): Promise<DelegationConfirmationRequest[]> {
    return this.withViewer(id, actorPrincipalId, () =>
      this.delegations.confirmations(id),
    );
  }

  notifications(
    id: string,
    actorPrincipalId: string,
  ): Promise<DelegationNotification[]> {
    return this.withViewer(id, actorPrincipalId, () =>
      this.delegations.notifications(actorPrincipalId, id),
    );
  }

  async createConfirmation(
    id: string,
    actorPrincipalId: string,
    input: CreateDelegationConfirmationInput,
  ): Promise<DelegationConfirmationRequest> {
    const delegation = await this.require(id);
    this.assertViewer(delegation, actorPrincipalId);
    await this.assertUsable(delegation, input.action);
    if (delegation.approvalPolicy !== "require-confirmation") {
      throw new DelegationApplicationError(
        "delegation_confirmation_not_required",
        "This Delegation does not use owner confirmation",
        409,
      );
    }
    const check = await this.checkAction(id, actorPrincipalId, {
      action: input.action,
      expectedRevision: delegation.revision,
    });
    if (!check.allowed) {
      throw new DelegationApplicationError(
        check.reason,
        "The Delegation does not allow this confirmation target",
        403,
      );
    }
    if (new Date(input.expiresAt).getTime() <= Date.now()) {
      throw new DelegationApplicationError(
        "delegation_confirmation_expired",
        "Confirmation expiry must be in the future",
        400,
      );
    }
    return this.delegations.createConfirmation({ delegation, value: input });
  }

  async decideConfirmation(
    id: string,
    requestId: string,
    actorPrincipalId: string,
    input: DecideDelegationConfirmationInput,
  ): Promise<DelegationConfirmationRequest> {
    await this.requireOwned(id, actorPrincipalId);
    const result = await this.delegations.decideConfirmation({
      delegationId: id,
      requestId,
      ownerPrincipalId: actorPrincipalId,
      decision: input.decision,
      reason: input.reason,
    });
    if ("kind" in result) {
      throw new DelegationApplicationError(
        result.kind === "expired"
          ? "delegation_confirmation_expired"
          : result.kind === "not_found"
            ? "delegation_confirmation_not_found"
            : "delegation_confirmation_invalid_state",
        result.kind === "expired"
          ? "The confirmation request expired"
          : result.kind === "not_found"
            ? "Confirmation request not found"
            : "The confirmation request is no longer pending",
        result.kind === "not_found" ? 404 : 409,
      );
    }
    return result;
  }

  async generateReport(id: string): Promise<DelegationReport> {
    const delegation = await this.require(id);
    await this.delegations.ensureReport({ delegationId: id });
    await this.delegations.markReportGenerating(id);
    try {
      const [events, runs] = await Promise.all([
        this.delegations.events(id),
        this.delegations.runs(id),
      ]);
      const lifecycle = events.filter((event) =>
        [
          "created",
          "activated",
          "paused",
          "resumed",
          "extended",
          "completed",
          "revoked",
          "expired",
        ].includes(event.kind),
      );
      const pendingConfirmations = events.filter(
        (event) => event.kind === "confirmation_requested",
      );
      const failedRuns = runs.filter((run) =>
        ["failed", "timeout", "interrupted"].includes(run.status),
      );
      const cursor = events[0] ? events[0].afterRevision : 0;
      return await this.delegations.completeReport({
        delegationId: id,
        summary: `${delegation.displayName} 已执行 ${runs.length} 次代表运行，当前状态为 ${delegation.status}。`,
        keyProcess: lifecycle.map(
          (event) =>
            `${event.kind} · revision ${event.beforeRevision}->${event.afterRevision}`,
        ),
        positions:
          delegation.stance === "" ? [] : [delegation.stance.slice(0, 4_000)],
        risks: [
          ...failedRuns.map(
            (run) => `Run ${run.runId} ended as ${run.status}.`,
          ),
          ...(delegation.lastFailure === null
            ? []
            : [delegation.lastFailure]),
        ],
        openQuestions: pendingConfirmations.map(
          (event) => `Confirmation ${String(event.data.confirmationId ?? "")}`,
        ),
        nextSteps:
          delegation.status === "completed"
            ? ["Review the completed Delegation report."]
            : ["Review current Delegation scope before extending or revoking."],
        informationGaps:
          delegation.materialScopes.length === 0
            ? ["No explicit material scope was attached."]
            : [],
        sourceEventCursor: cursor,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.delegations.failReport({
        delegationId: id,
        errorCode: "delegation_report_generation_failed",
        errorMessage: message.slice(0, 4_000),
      });
      throw new DelegationApplicationError(
        "delegation_report_generation_failed",
        "Delegation report generation failed",
        500,
        { retryable: true },
      );
    }
  }

  async retryReport(
    id: string,
    actorPrincipalId: string,
  ): Promise<DelegationReport> {
    await this.requireOwned(id, actorPrincipalId);
    await this.delegations.resetReportForRetry(id);
    return this.generateReport(id);
  }

  async sweepDue(): Promise<{
    readonly expired: number;
    readonly expiryNotifications: number;
    readonly confirmationsExpired: number;
    readonly reportsGenerated: number;
    readonly reportsFailed: number;
  }> {
    const expired = await this.delegations.expireDue();
    const expiryNotifications =
      await this.delegations.issueExpiryNotifications();
    const confirmationsExpired =
      await this.delegations.expireConfirmations();
    let reportsGenerated = 0;
    let reportsFailed = 0;
    for (const report of await this.delegations.pendingReports()) {
      try {
        await this.generateReport(report.delegationId);
        reportsGenerated += 1;
      } catch {
        reportsFailed += 1;
      }
    }
    return {
      expired: expired.length,
      expiryNotifications,
      confirmationsExpired,
      reportsGenerated,
      reportsFailed,
    };
  }

  ticketBinding(delegation: Delegation): DelegationTicketBinding {
    return {
      delegationId: delegation.id,
      delegationRevision: delegation.revision,
      delegationContextHash: delegationContextHash(delegation),
      ownerPrincipalId: delegation.ownerPrincipalId,
      representativePrincipalId: delegation.representativePrincipalId,
    };
  }

  private async syncMeetingProjection(
    delegation: Delegation,
    actorPrincipalId: string,
  ): Promise<MeetingDelegate | undefined> {
    if (
      delegation.projectId === null ||
      delegation.representativeAgentId === null
    ) {
      return undefined;
    }
    const allowedActions = new Set<
      "speak" | "read_private" | "attach_file" | "summarize"
    >();
    if (
      delegation.allowedActions.includes("comment") &&
      !delegation.deniedActions.includes("comment")
    ) {
      allowedActions.add("speak");
    }
    if (
      (delegation.allowedActions.includes("read_materials") ||
        delegation.allowedActions.includes("read_context")) &&
      !delegation.deniedActions.includes("read_materials")
    ) {
      allowedActions.add("read_private");
    }
    if (
      delegation.allowedActions.includes("summarize") &&
      !delegation.deniedActions.includes("summarize")
    ) {
      allowedActions.add("summarize");
    }
    if (allowedActions.size === 0) return undefined;
    return this.repositories.meetingCollaboration.createDelegate({
      meetingId: delegation.contextId,
      projectId: delegation.projectId,
      delegatorPrincipalId: delegation.ownerPrincipalId,
      actorPrincipalId,
      representativePrincipalId: delegation.representativePrincipalId,
      input: {
        representativeKind:
          delegation.representativeKind === "ai" ? "agent" : "human",
        representativePrincipalId: delegation.representativePrincipalId,
        agentId: delegation.representativeAgentId,
        delegationId: delegation.id,
        allowedActions: [...allowedActions],
        expiresAt: delegation.expiresAt,
        reason: delegation.objective,
      },
    });
  }

  private async resolveContext(
    contextType: Delegation["contextType"],
    contextId: string,
  ): Promise<DelegationContext> {
    if (contextType === "task") {
      const task = await this.repositories.tasks.get(contextId);
      if (task === undefined) {
        throw new DelegationApplicationError(
          "delegation_context_not_found",
          "Delegation task not found",
          404,
        );
      }
      return { projectId: task.projectId, label: task.title };
    }
    if (contextType === "meeting") {
      const meeting = await this.repositories.meetings.detail(contextId);
      if (meeting === undefined) {
        throw new DelegationApplicationError(
          "delegation_context_not_found",
          "Delegation meeting not found",
          404,
        );
      }
      return {
        projectId: meeting.meeting.projectId,
        label: meeting.meeting.title,
      };
    }
    if (contextType === "workflow_instance") {
      const instance = await this.repositories.workflowRuntime.get(contextId);
      if (instance === undefined) {
        throw new DelegationApplicationError(
          "delegation_context_not_found",
          "Delegation workflow instance not found",
          404,
        );
      }
      return { projectId: instance.projectId, label: instance.title };
    }
    const separator = contextId.lastIndexOf(":");
    if (separator <= 0) {
      throw new DelegationApplicationError(
        "delegation_context_invalid",
        "workflow_node contextId must be instanceId:nodeId",
        400,
      );
    }
    const instanceId = contextId.slice(0, separator);
    const nodeId = contextId.slice(separator + 1);
    const instance = await this.repositories.workflowRuntime.get(instanceId);
    const node = instance?.graph?.nodes.find(
      (candidate) => candidate.id === nodeId,
    );
    if (instance === undefined || node === undefined) {
      throw new DelegationApplicationError(
        "delegation_context_not_found",
        "Delegation workflow node not found",
        404,
      );
    }
    return { projectId: instance.projectId, label: node.name };
  }

  private async resolveRepresentative(input: {
    readonly input: CreateDelegationInput;
    readonly ownerPrincipalId: string;
    readonly projectId: string;
  }): Promise<{
    readonly principalId: string;
    readonly kind: "human" | "ai";
    readonly agentId: string | null;
  }> {
    let principalId: string;
    let kind: "human" | "ai";
    let agentId: string | null = null;
    if (input.input.representativeKind === "human") {
      principalId = input.input.representativePrincipalId!;
      kind = "human";
    } else {
      const agent = await this.repositories.agents.get(
        input.input.representativeAgentId!,
      );
      if (agent === undefined) {
        throw new DelegationApplicationError(
          "representative_inactive",
          "The AI representative Agent is unavailable",
          409,
        );
      }
      if (agent.status !== "active") {
        throw new DelegationApplicationError(
          "representative_inactive",
          "The AI representative Agent is disabled",
          403,
        );
      }
      if (!implementedRuntimeKinds.has(agent.runtimeKind)) {
        throw new DelegationApplicationError(
          "delegation_runtime_binding_missing",
          "The AI representative has no executable Runtime",
          409,
        );
      }
      if (externalRuntimeKinds.has(agent.runtimeKind)) {
        const binding =
          await this.repositories.agentRuntimeBindings.getCurrent(agent.id);
        if (binding === undefined) {
          throw new DelegationApplicationError(
            "delegation_runtime_binding_missing",
            "The AI representative has no active Runtime Binding",
            409,
          );
        }
      }
      const principal =
        agent.principalId ??
        (await this.repositories.authorization.getPrincipal(agent.id))?.id;
      if (principal === undefined) {
        throw new DelegationApplicationError(
          "representative_inactive",
          "The AI representative has no active Principal",
          409,
        );
      }
      principalId = principal;
      kind = "ai";
      agentId = agent.id;
    }
    if (principalId === input.ownerPrincipalId) {
      throw new DelegationApplicationError(
        "delegation_self",
        "An owner cannot delegate to itself",
        409,
      );
    }
    const representative = await this.requireActivePrincipal(principalId);
    if (representative.kind !== kind) {
      throw new DelegationApplicationError(
        "representative_kind_mismatch",
        "The representative Principal kind does not match the request",
        409,
      );
    }
    const members = await this.repositories.projectMemberships.listMembers(
      input.projectId,
    );
    const member = members.find(
      (candidate) =>
        candidate.status === "active" &&
        (candidate.principalId === principalId ||
          candidate.actorId === principalId ||
          (agentId !== null && candidate.actorId === agentId)),
    );
    if (member === undefined) {
      throw new DelegationApplicationError(
        "representative_not_project_member",
        "The representative must be an active Project member",
        403,
      );
    }
    const capability = await this.projectCapability(
      representative.id,
      representative.source,
      input.projectId,
    );
    if (!capability.includes("read")) {
      throw new DelegationApplicationError(
        "representative_permission_missing",
        "The representative cannot read the Delegation context",
        403,
      );
    }
    return { principalId, kind, agentId };
  }

  private async projectCapability(
    principalId: string,
    source: string,
    projectId: string,
  ): Promise<ScopedAuthorizationPermission[]> {
    const result = await this.repositories.authorization.getProjectCapability({
      principalId,
      authSource:
        source === "local" ? "local-development" : "bearer",
      projectId,
    });
    if (!result.allowed || result.capability === undefined) {
      return [];
    }
    return result.capability
      .effectivePermissions as ScopedAuthorizationPermission[];
  }

  private async require(id: string): Promise<Delegation> {
    const delegation = await this.delegations.get(id);
    if (delegation === undefined) {
      throw new DelegationApplicationError(
        "delegation_not_found",
        "Delegation not found",
        404,
      );
    }
    return delegation;
  }

  private async requireOwned(
    id: string,
    actorPrincipalId: string,
  ): Promise<Delegation> {
    const delegation = await this.require(id);
    if (delegation.ownerPrincipalId !== actorPrincipalId) {
      throw new DelegationApplicationError(
        "delegation_forbidden",
        "Only the Delegation owner can perform this operation",
        403,
      );
    }
    return delegation;
  }

  private async requireActivePrincipal(id: string) {
    const principal =
      await this.repositories.authorization.getPrincipal(id);
    if (
      principal === undefined ||
      principal.status !== "active" ||
      principal.accountStatus === "disabled"
    ) {
      throw new DelegationApplicationError(
        "representative_inactive",
        "The requested Principal is not active",
        403,
      );
    }
    return principal;
  }

  private assertViewer(
    delegation: Delegation,
    actorPrincipalId: string,
  ): void {
    if (
      delegation.ownerPrincipalId !== actorPrincipalId &&
      delegation.representativePrincipalId !== actorPrincipalId
    ) {
      throw new DelegationApplicationError(
        "delegation_forbidden",
        "The Delegation is private to its owner and representative",
        403,
      );
    }
  }

  private async withViewer<T>(
    id: string,
    actorPrincipalId: string,
    load: () => Promise<T>,
  ): Promise<T> {
    const delegation = await this.require(id);
    this.assertViewer(delegation, actorPrincipalId);
    return load();
  }

  private async assertUsable(
    delegation: Delegation,
    action: DelegationAction,
  ): Promise<void> {
    if (delegation.status !== "active") {
      throw new DelegationApplicationError(
        `delegation_${delegation.status}`,
        `Delegation is ${delegation.status}`,
        409,
      );
    }
    if (new Date(delegation.expiresAt).getTime() <= Date.now()) {
      throw new DelegationApplicationError(
        "delegation_expired",
        "Delegation has expired",
        409,
      );
    }
    if (delegation.deniedActions.includes(action)) {
      throw new DelegationApplicationError(
        "delegation_action_denied",
        `Delegation denies ${action}`,
        403,
      );
    }
    if (!delegation.allowedActions.includes(action)) {
      throw new DelegationApplicationError(
        "delegation_action_denied",
        `Delegation does not allow ${action}`,
        403,
      );
    }
  }

  private applyTransition(
    result: Awaited<ReturnType<DelegationRepository["activate"]>>,
  ): Delegation {
    if (result.kind === "updated") return result.delegation;
    if (result.kind === "revision_conflict") {
      throw new DelegationApplicationError(
        "delegation_revision_conflict",
        "Delegation was revised by another request",
        409,
        { currentRevision: result.currentRevision },
      );
    }
    if (result.kind === "invalid_transition") {
      throw new DelegationApplicationError(
        "delegation_invalid_transition",
        `Delegation cannot transition from ${result.from}`,
        409,
      );
    }
    throw new DelegationApplicationError(
      "delegation_not_found",
      "Delegation not found",
      404,
    );
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  );
}
