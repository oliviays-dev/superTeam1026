import { createHash, randomUUID } from "node:crypto";
import {
  type ActionTicket,
  type ActionTicketAction,
  type Agent,
  type AgentRuntimePreflightInput,
  type CapabilityGap,
  type ExecutionEnvelope,
  type ExecutionGateRequest,
  type ExternalRunExecutionSnapshot,
  type RuntimeCapabilityProfile,
  type RuntimeRequirement,
  type ReasoningEffort,
  type TaskExecutionPolicy,
  type TaskExecutionPolicyContextType,
  type RunExecutionEnvelope,
  type RunObservability,
} from "@pluginmax/contracts";
import type {
  PlatformRepositories,
  ScopedAuthorizationPermission,
} from "@pluginmax/database";
import { AgentRuntimePreflightService } from "./agent-runtime-preflight.js";

export type ExecutionContextType =
  "task" | "workflow-task" | "meeting" | "direct-chat";

export interface TaskExecutionPreparation {
  readonly executionEnvelope: RunExecutionEnvelope;
  readonly actionTicket: ActionTicket;
  readonly executionGates: readonly ExecutionGateRequest[];
  readonly executionSnapshot?: ExternalRunExecutionSnapshot;
  readonly observability: RunObservability;
  readonly timeoutAt?: string;
}

export class TaskExecutionPreflightError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 409,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "TaskExecutionPreflightError";
  }
}

const capabilityRequirements: Readonly<
  Record<
    RuntimeRequirement["key"],
    keyof RuntimeCapabilityProfile["capabilities"] | null
  >
> = {
  search: "search",
  network: "network",
  "file-read": "fileRead",
  "file-write": "fileWrite",
  shell: "shell",
  browser: "browser",
  mcp: "mcp",
  "structured-plan": "structuredPlan",
  "structured-tool-events": "structuredToolEvents",
  "blocking-gate": null,
};

const preflightCapabilityNames: Readonly<
  Partial<Record<RuntimeRequirement["key"], string>>
> = {
  search: "search",
  network: "network",
  "file-read": "fileRead",
  "file-write": "fileWrite",
  shell: "shell",
  browser: "browser",
  mcp: "mcp",
  "structured-plan": "structuredPlan",
  "structured-tool-events": "structuredToolEvents",
};

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

export function executionEnvelopeDigest(
  envelope: Readonly<Record<string, unknown>>,
): string {
  const { digest: _digest, ...payload } = envelope;
  return createHash("sha256").update(stableJson(payload)).digest("hex");
}

function policyContext(
  type: ExecutionContextType,
): TaskExecutionPolicyContextType {
  return type === "workflow-task"
    ? "task"
    : type === "meeting"
      ? "meeting"
      : type === "direct-chat"
        ? "direct-chat"
        : "task";
}

function builtinCapability(agent: Agent): {
  readonly runtimeId: string;
  readonly runtimeRevision: number;
  readonly profile: RuntimeCapabilityProfile;
} {
  const runtimeId = `builtin:${agent.runtimeKind}`;
  const supported = new Set<keyof RuntimeCapabilityProfile["capabilities"]>([
    "structuredPlan",
    "structuredToolEvents",
  ]);
  const state = (key: keyof RuntimeCapabilityProfile["capabilities"]) =>
    supported.has(key) ? ("supported" as const) : ("unsupported" as const);
  return {
    runtimeId,
    runtimeRevision: 1,
    profile: {
      schemaVersion: 1,
      runtimeId,
      runtimeRevision: "1",
      adapterId: agent.runtimeKind,
      provider: "pluginmax",
      protocol: "builtin",
      capabilities: {
        search: state("search"),
        network: state("network"),
        fileRead: state("fileRead"),
        fileWrite: state("fileWrite"),
        shell: state("shell"),
        browser: state("browser"),
        mcp: state("mcp"),
        sessionResume: state("sessionResume"),
        structuredPlan: state("structuredPlan"),
        structuredToolEvents: state("structuredToolEvents"),
        structuredSubagent: state("structuredSubagent"),
      },
      toolCategories: [],
      networkModes: ["none"],
      gateEnforcement: "blocking",
      limits: {},
      provenance: {
        adapter: true,
        probe: false,
        config: true,
        observedInRuns: false,
      },
      capturedAt: new Date().toISOString(),
    },
  };
}

function policyGaps(
  policy: TaskExecutionPolicy,
  profile: RuntimeCapabilityProfile,
): readonly CapabilityGap[] {
  const gaps: CapabilityGap[] = [];
  for (const requirement of policy.runtime.requiredCapabilities) {
    if (requirement.necessity !== "preferred") continue;
    const capability = capabilityRequirements[requirement.key];
    if (capability === null) continue;
    if (profile.capabilities[capability] !== "supported") {
      gaps.push({
        code: "runtime-capability-missing",
        key: requirement.key,
        necessity: "preferred",
        message: `Runtime does not advertise preferred capability ${requirement.key}`,
      });
    }
  }
  return gaps;
}

function requiredCapabilityInput(
  requirements: readonly RuntimeRequirement[],
): AgentRuntimePreflightInput["requiredCapabilities"] {
  return requirements.flatMap((requirement) => {
    if (requirement.necessity !== "required" || requirement.value === false) {
      return [];
    }
    const capability = preflightCapabilityNames[requirement.key];
    return capability === undefined ? [] : [capability as never];
  });
}

function scopedPermissions(
  values: readonly string[],
): ScopedAuthorizationPermission[] {
  const allowed = new Set<ScopedAuthorizationPermission>([
    "read",
    "write",
    "approve",
    "manage_members",
    "manage_roles",
  ]);
  return values.filter((value): value is ScopedAuthorizationPermission =>
    allowed.has(value as ScopedAuthorizationPermission),
  );
}

function assertPolicyRequirements(
  policy: TaskExecutionPolicy,
  profile: RuntimeCapabilityProfile,
): void {
  for (const requirement of policy.runtime.requiredCapabilities) {
    if (requirement.necessity !== "required" || requirement.value === false) {
      continue;
    }
    const capability = capabilityRequirements[requirement.key];
    if (capability === null && profile.gateEnforcement !== "blocking") {
      throw new TaskExecutionPreflightError(
        "runtime_capability_missing",
        "The Runtime cannot enforce blocking policy gates",
      );
    }
    if (
      capability !== null &&
      profile.capabilities[capability] !== "supported"
    ) {
      throw new TaskExecutionPreflightError(
        "runtime_capability_missing",
        `The Runtime does not satisfy required capability ${requirement.key}`,
      );
    }
  }
  const requiresBlockingGate =
    policy.toolPolicy.requireApproval.length > 0 ||
    policy.humanGates.some(
      (gate) => (gate.enforcement ?? "blocking") === "blocking",
    );
  if (requiresBlockingGate && profile.gateEnforcement !== "blocking") {
    throw new TaskExecutionPreflightError(
      "runtime_capability_missing",
      "The Runtime cannot enforce blocking Execution Gates",
    );
  }
}

function intersectTools(
  policy: TaskExecutionPolicy,
  profile: RuntimeCapabilityProfile,
): {
  readonly allowed: string[];
  readonly denied: string[];
  readonly approval: string[];
} {
  const runtimeTools = new Set(profile.toolCategories);
  const allowed = new Set(
    policy.toolPolicy.allow.length === 0
      ? runtimeTools
      : policy.toolPolicy.allow.filter((tool) => runtimeTools.has(tool)),
  );
  const denied = new Set(policy.toolPolicy.deny);
  for (const tool of denied) allowed.delete(tool);
  const approval = policy.toolPolicy.requireApproval.filter(
    (tool) => allowed.has(tool) && !denied.has(tool),
  );
  return {
    allowed: [...allowed].sort(),
    denied: [...denied].sort(),
    approval,
  };
}

function narrowedEnvelope(input: {
  readonly raw: ExecutionEnvelope;
  readonly policy: TaskExecutionPolicy;
  readonly policyVersion: string;
  readonly profile: RuntimeCapabilityProfile;
}): ExecutionEnvelope {
  const tools = intersectTools(input.policy, input.profile);
  return {
    ...input.raw,
    policyVersion: input.policyVersion,
    resolved: {
      ...input.raw.resolved,
      allowedToolCategories: tools.allowed,
      approvalToolCategories: tools.approval,
      deniedToolCategories: tools.denied,
    },
    sourcePolicy: {
      allow: [...input.policy.sourcePolicy.allow],
      deny: [...input.policy.sourcePolicy.deny],
      citation: input.policy.sourcePolicy.citation,
      requirePublishedAt: input.policy.sourcePolicy.requirePublishedAt,
      requireAccessedAt: input.policy.sourcePolicy.requireAccessedAt,
    },
    budget: { ...input.policy.budget },
  };
}

function builtinEnvelope(input: {
  readonly agent: Agent;
  readonly actorId: string;
  readonly workspaceId: string;
  readonly taskId: string;
  readonly profile: RuntimeCapabilityProfile;
  readonly policyVersion: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
}): ExecutionEnvelope {
  return {
    schemaVersion: 1,
    id: `envelope-${createHash("sha256")
      .update(
        `${input.agent.id}:${input.workspaceId}:${input.taskId}:${input.policyVersion}`,
      )
      .digest("hex")
      .slice(0, 40)}`,
    taskId: input.taskId,
    workspaceId: input.workspaceId,
    principalId: input.actorId,
    teammateId: input.agent.id,
    runtimeId: input.profile.runtimeId,
    adapterId: input.profile.adapterId,
    runtimeRevision: input.profile.runtimeRevision,
    policyVersion: input.policyVersion,
    resolved: {
      searchEnabled:
        input.profile.capabilities.search === "unknown"
          ? null
          : input.profile.capabilities.search === "supported",
      networkAccess: "none",
      allowedToolCategories: input.profile.toolCategories,
      approvalToolCategories: [],
      deniedToolCategories: [],
      sandbox: "workspace",
      gateEnforcement: input.profile.gateEnforcement,
      planVisibility:
        input.profile.capabilities.structuredPlan === "supported"
          ? "structured"
          : "opaque",
    },
    launch: {
      provider: input.profile.provider,
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: input.reasoningEffort }),
      authMode: "platform-managed",
    },
    unresolved: [],
    createdAt: new Date().toISOString(),
  };
}

function runEnvelope(input: {
  readonly runContextType: ExecutionContextType;
  readonly contextId: string;
  readonly projectId: string | null;
  readonly actorId: string;
  readonly actorAuthSource: "bearer" | "local-development";
  readonly agent: Agent;
  readonly agentPrincipalId: string | null;
  readonly policy: Awaited<
    ReturnType<PlatformRepositories["taskExecutionPolicies"]["resolve"]>
  >;
  readonly authorization: {
    readonly scope: "project" | "self";
    readonly grantIds: readonly string[];
    readonly effectivePermissions: readonly ScopedAuthorizationPermission[];
    readonly membershipId: string | null;
  };
  readonly binding: RunExecutionEnvelope["binding"];
  readonly runtime: RunExecutionEnvelope["runtime"];
  readonly envelope: ExecutionEnvelope;
  readonly ticketId: string;
}): RunExecutionEnvelope {
  const createdAt = new Date().toISOString();
  const sealedEnvelope = {
    ...input.envelope,
    ticketId: input.ticketId,
  };
  const withoutDigest = {
    schemaVersion: 1 as const,
    id: `run-envelope-${createHash("sha256")
      .update(
        stableJson({
          contextType: input.runContextType,
          contextId: input.contextId,
          policy: input.policy,
          envelope: sealedEnvelope,
        }),
      )
      .digest("hex")
      .slice(0, 40)}`,
    contextType: input.runContextType,
    contextId: input.contextId,
    projectId: input.projectId,
    principalId: input.actorId,
    agentId: input.agent.id,
    agentPrincipalId: input.agentPrincipalId,
    authorization: {
      scope: input.authorization.scope,
      grantIds: [...input.authorization.grantIds],
      effectivePermissions: [...input.authorization.effectivePermissions],
      membershipId: input.authorization.membershipId,
      authSource: input.actorAuthSource,
    },
    policy: input.policy,
    binding: input.binding,
    runtime: input.runtime,
    envelope: sealedEnvelope,
    createdAt,
  };
  return {
    ...withoutDigest,
    digest: executionEnvelopeDigest(withoutDigest),
  };
}

function observability(profile: RuntimeCapabilityProfile): RunObservability {
  if (profile.protocol === "plain-text") {
    return {
      planVisibility: "opaque",
      toolEventCompleteness: "none",
      textStreaming: "final-only",
      subagentVisibility: "none",
    };
  }
  return {
    planVisibility: "summary",
    toolEventCompleteness: "partial",
    textStreaming: "message",
    subagentVisibility: "none",
  };
}

function writebackAction(
  contextType: ExecutionContextType,
): ActionTicketAction {
  switch (contextType) {
    case "task":
      return "task.writeback";
    case "workflow-task":
      return "workflow.writeback";
    case "meeting":
      return "meeting.writeback";
    case "direct-chat":
      return "direct-chat.writeback";
  }
}

function actionTicketExpiry(input: {
  readonly issuedAt: Date;
  readonly deadlineAt?: string;
}): Date {
  const defaultExpiry = input.issuedAt.getTime() + 2 * 60 * 60 * 1_000;
  const deadlineExpiry =
    input.deadlineAt === undefined
      ? defaultExpiry
      : new Date(input.deadlineAt).getTime() + 5 * 60 * 1_000;
  return new Date(
    Math.min(
      input.issuedAt.getTime() + 24 * 60 * 60 * 1_000,
      Math.max(
        input.issuedAt.getTime() + 5 * 60 * 1_000,
        deadlineExpiry,
      ),
    ),
  );
}

function actionResourceScopes(input: {
  readonly workspaceId: string;
  readonly contextType: ExecutionContextType;
  readonly contextId: string;
  readonly projectId: string | null;
  readonly taskId: string;
  readonly runId: string;
  readonly envelope: ExecutionEnvelope;
}): string[] {
  return [
    `workspace:${input.workspaceId}`,
    `context:${input.contextType}:${input.contextId}`,
    `task:${input.taskId}`,
    `run:${input.runId}`,
    ...(input.projectId === null ? [] : [`project:${input.projectId}`]),
    ...input.envelope.resolved.allowedToolCategories.map(
      (tool) => `tool:${tool}`,
    ),
    ...(input.envelope.sourcePolicy?.allow ?? []).map(
      (source) => `source:${source}`,
    ),
  ];
}

function actionTicket(input: {
  readonly ticketId: string;
  readonly runId: string;
  readonly contextType: ExecutionContextType;
  readonly contextId: string;
  readonly taskId: string;
  readonly projectId: string | null;
  readonly principalId: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly executionEnvelope: RunExecutionEnvelope;
  readonly authorization: {
    readonly scope: "project" | "self";
    readonly grantIds: readonly string[];
    readonly effectivePermissions: readonly ScopedAuthorizationPermission[];
    readonly membershipId: string | null;
  };
}): ActionTicket {
  const writeback = writebackAction(input.contextType);
  const workspaceId = input.executionEnvelope.envelope.workspaceId;
  return {
    schemaVersion: 1,
    ticketId: input.ticketId,
    ticketVersion: 1,
    principalId: input.principalId,
    workspaceId,
    contextType: input.contextType,
    contextId: input.contextId,
    taskId: input.taskId,
    runId: input.runId,
    allowedActions: ["agent.execute", writeback],
    deniedActions: [],
    resourceScopes: actionResourceScopes({
      workspaceId,
      contextType: input.contextType,
      contextId: input.contextId,
      projectId: input.projectId,
      taskId: input.taskId,
      runId: input.runId,
      envelope: input.executionEnvelope.envelope,
    }),
    policyId: input.executionEnvelope.policy.id,
    policyRevision: input.executionEnvelope.policy.revision,
    envelopeId: input.executionEnvelope.id,
    envelopeDigest: input.executionEnvelope.digest,
    authorizationSnapshot: {
      scope: input.authorization.scope,
      principalId: input.principalId,
      grantIds: [...input.authorization.grantIds],
      effectivePermissions: [...input.authorization.effectivePermissions],
      membershipId: input.authorization.membershipId,
    },
    executionEnvelope: input.executionEnvelope,
    issuedAt: input.issuedAt.toISOString(),
    expiresAt: input.expiresAt.toISOString(),
    issuedBy: input.principalId,
  };
}

function executionGateRules(
  policy: TaskExecutionPolicy,
): readonly {
  readonly key: string;
  readonly kind: ExecutionGateRequest["kind"];
  readonly enforcement: ExecutionGateRequest["enforcement"];
  readonly reason: string;
  readonly toolCategory: string | null;
  readonly sourceClass: string | null;
}[] {
  return [
    ...policy.toolPolicy.requireApproval.map((tool) => ({
      key: `tool-approval:${tool}`,
      kind: "tool-approval" as const,
      enforcement: "blocking" as const,
      reason: `Tool category ${tool} requires approval before execution`,
      toolCategory: tool,
      sourceClass: null,
    })),
    ...policy.humanGates.map((gate) => ({
      key: `human-gate:${gate.id}`,
      kind: gate.kind,
      enforcement: gate.enforcement ?? "blocking",
      reason: gate.reason,
      toolCategory: gate.toolCategory ?? null,
      sourceClass: gate.sourceClass ?? null,
    })),
  ];
}

function executionGates(input: {
  readonly ticket: ActionTicket;
  readonly policy: TaskExecutionPolicy;
  readonly projectId: string | null;
  readonly requestedByPrincipalId: string;
  readonly requestedAt: Date;
}): ExecutionGateRequest[] {
  const defaultGateExpiry = Math.min(
    new Date(input.ticket.expiresAt).getTime(),
    input.requestedAt.getTime() + 15 * 60 * 1_000,
  );
  return executionGateRules(input.policy).map((rule) => ({
    gateId: randomUUID(),
    ticketId: input.ticket.ticketId,
    runId: input.ticket.runId,
    taskId: input.ticket.taskId,
    projectId: input.projectId,
    gateKey: rule.key.slice(0, 180),
    kind: rule.kind,
    enforcement: rule.enforcement,
    reason: rule.reason,
    requestedToolCategory: rule.toolCategory,
    requestedSourceClass: rule.sourceClass,
    resourceScopes: [...input.ticket.resourceScopes],
    policyId: input.ticket.policyId,
    policyRevision: input.ticket.policyRevision,
    envelopeId: input.ticket.envelopeId,
    envelopeDigest: input.ticket.envelopeDigest,
    requestedByPrincipalId: input.requestedByPrincipalId,
    requestedAt: input.requestedAt.toISOString(),
    expiresAt: new Date(
      Math.max(input.requestedAt.getTime() + 1_000, defaultGateExpiry),
    ).toISOString(),
  }));
}

export class TaskExecutionPreflightService {
  private readonly runtimePreflight: AgentRuntimePreflightService;

  constructor(private readonly repositories: PlatformRepositories) {
    this.runtimePreflight = new AgentRuntimePreflightService(repositories);
  }

  async prepare(input: {
    readonly agent: Agent;
    readonly actorId: string;
    readonly administrator: boolean;
    readonly projectId: string | null;
    readonly contextType: ExecutionContextType;
    readonly contextId: string;
    readonly taskId: string;
    readonly runId: string;
    readonly model?: string;
    readonly reasoningEffort?: AgentRuntimePreflightInput["reasoningEffort"];
    readonly deadlineAt?: string;
  }): Promise<TaskExecutionPreparation> {
    const principal = await this.repositories.authorization.getPrincipal(
      input.actorId,
    );
    if (
      principal === undefined ||
      principal.status !== "active" ||
      principal.accountStatus === "disabled"
    ) {
      throw new TaskExecutionPreflightError(
        "principal_not_active",
        "The initiating Principal is not active",
        403,
      );
    }
    const authSource =
      principal.source === "local" ? "local-development" : "bearer";
    const authorization =
      input.projectId === null
        ? {
            scope: "self" as const,
            grantIds: [] as string[],
            effectivePermissions: [
              "read",
              "write",
            ] as ScopedAuthorizationPermission[],
            membershipId: null,
          }
        : await this.projectAuthorization(input.actorId, input.projectId);
    const type = policyContext(input.contextType);
    const policy = await this.repositories.taskExecutionPolicies.resolve({
      contextType: type,
      contextId: input.contextId,
      projectId: input.projectId,
    });
    const allowedRuntimeIds = policy.policy.runtime.allowedRuntimeIds;
    const model = policy.policy.runtime.model ?? input.model;
    const reasoningEffort =
      policy.policy.runtime.reasoningEffort ?? input.reasoningEffort;
    const agentPrincipalId =
      input.agent.principalId ??
      (await this.repositories.authorization.getPrincipal(input.agent.id))
        ?.id ??
      null;
    const externalRuntime =
      input.agent.runtimeKind === "codex-jsonl" ||
      input.agent.runtimeKind === "plain-text";
    const currentBinding = externalRuntime
      ? await this.repositories.agentRuntimeBindings.getCurrent(input.agent.id)
      : undefined;
    if (externalRuntime && currentBinding === undefined) {
      throw new TaskExecutionPreflightError(
        "runtime_binding_missing",
        "The agent has no external runtime binding",
      );
    }
    const runtimeId = externalRuntime
      ? currentBinding?.runtimeId
      : `builtin:${input.agent.runtimeKind}`;
    if (
      allowedRuntimeIds.length > 0 &&
      (runtimeId === undefined || !allowedRuntimeIds.includes(runtimeId))
    ) {
      throw new TaskExecutionPreflightError(
        "policy_not_authorized",
        "The selected Runtime is outside the TaskExecutionPolicy allowlist",
        403,
      );
    }

    const requiredCapabilities = requiredCapabilityInput(
      policy.policy.runtime.requiredCapabilities,
    );
    const ticketId = randomUUID();
    const issuedAt = new Date();
    const expiresAt = actionTicketExpiry({
      issuedAt,
      ...(input.deadlineAt === undefined
        ? {}
        : { deadlineAt: input.deadlineAt }),
    });
    let prepared: Omit<
      TaskExecutionPreparation,
      "actionTicket" | "executionGates"
    >;
    if (externalRuntime) {
      prepared = await this.prepareExternal({
        ...input,
        ticketId,
        policy,
        authorization,
        authSource,
        agentPrincipalId,
        ...(model === undefined ? {} : { model }),
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        requiredCapabilities,
      });
    } else {
      prepared = this.prepareBuiltin({
        ...input,
        ticketId,
        policy,
        authorization,
        authSource,
        agentPrincipalId,
        ...(model === undefined ? {} : { model }),
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      });
    }
    const ticket = actionTicket({
      ticketId,
      runId: input.runId,
      contextType: input.contextType,
      contextId: input.contextId,
      taskId: input.taskId,
      projectId: input.projectId,
      principalId: input.actorId,
      issuedAt,
      expiresAt,
      executionEnvelope: prepared.executionEnvelope,
      authorization,
    });
    return {
      ...prepared,
      actionTicket: ticket,
      executionGates: executionGates({
        ticket,
        policy: policy.policy,
        projectId: input.projectId,
        requestedByPrincipalId: input.actorId,
        requestedAt: issuedAt,
      }),
    };
  }

  private async projectAuthorization(
    actorId: string,
    projectId: string,
  ): Promise<{
    readonly scope: "project";
    readonly grantIds: readonly string[];
    readonly effectivePermissions: readonly ScopedAuthorizationPermission[];
    readonly membershipId: string | null;
  }> {
    const principal =
      await this.repositories.authorization.getPrincipal(actorId);
    const decision = await this.repositories.authorization.authorizeProject({
      principalId: actorId,
      authSource:
        principal?.source === "local" ? "local-development" : "bearer",
      projectId,
      permission: "write",
    });
    if (!decision.allowed) {
      throw new TaskExecutionPreflightError(
        decision.reason === "project_archived"
          ? "project_archived"
          : "principal_grant_missing",
        "The initiating Principal lacks project execution permission",
        decision.reason === "project_archived" ? 409 : 403,
        {
          reason: decision.reason,
          projectId,
          effectivePermissions: decision.effectivePermissions,
        },
      );
    }
    return {
      scope: "project",
      grantIds: decision.grantIds,
      effectivePermissions: scopedPermissions(decision.effectivePermissions),
      membershipId: decision.membershipId ?? null,
    };
  }

  private async prepareExternal(input: {
    readonly agent: Agent;
    readonly actorId: string;
    readonly administrator: boolean;
    readonly projectId: string | null;
    readonly contextType: ExecutionContextType;
    readonly contextId: string;
    readonly taskId: string;
    readonly runId: string;
    readonly ticketId: string;
    readonly model?: string;
    readonly reasoningEffort?: AgentRuntimePreflightInput["reasoningEffort"];
    readonly deadlineAt?: string;
    readonly policy: Awaited<
      ReturnType<PlatformRepositories["taskExecutionPolicies"]["resolve"]>
    >;
    readonly authorization: {
      readonly scope: "project" | "self";
      readonly grantIds: readonly string[];
      readonly effectivePermissions: readonly ScopedAuthorizationPermission[];
      readonly membershipId: string | null;
    };
    readonly authSource: "bearer" | "local-development";
    readonly agentPrincipalId: string | null;
    readonly requiredCapabilities: AgentRuntimePreflightInput["requiredCapabilities"];
  }): Promise<Omit<TaskExecutionPreparation, "actionTicket" | "executionGates">> {
    const binding = await this.repositories.agentRuntimeBindings.getCurrent(
      input.agent.id,
    );
    if (binding === undefined) {
      throw new TaskExecutionPreflightError(
        "runtime_binding_missing",
        "The agent has no external runtime binding",
      );
    }
    const evaluation = await this.runtimePreflight.preflight({
      agentId: input.agent.id,
      actorId: input.actorId,
      administrator: input.administrator,
      request: {
        expectedRevision: binding.revision,
        workspaceId: input.projectId ?? `direct-chat/${input.contextId}`,
        taskId: input.taskId,
        requiredCapabilities: input.requiredCapabilities,
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: input.reasoningEffort }),
      },
    });
    if (evaluation.kind === "failed") {
      throw new TaskExecutionPreflightError(
        evaluation.code,
        evaluation.message,
        409,
        {
          bindingRevision: evaluation.bindingRevision,
          runtimeRevision: evaluation.runtimeRevision,
        },
      );
    }
    const runtime = await this.repositories.externalRuntimes.get(
      binding.runtimeId,
    );
    if (runtime === undefined) {
      throw new TaskExecutionPreflightError(
        "runtime_not_found",
        "The bound Runtime is unavailable",
      );
    }
    assertPolicyRequirements(input.policy.policy, evaluation.result.runtime);
    const envelope = narrowedEnvelope({
      raw: evaluation.result.envelopePreview,
      policy: input.policy.policy,
      policyVersion: input.policy.version,
      profile: evaluation.result.runtime,
    });
    const gaps = policyGaps(input.policy.policy, evaluation.result.runtime);
    const finalEnvelope = {
      ...envelope,
      unresolved: [...envelope.unresolved, ...gaps],
    };
    const runEnvelopeValue = runEnvelope({
      ticketId: input.ticketId,
      runContextType: input.contextType,
      contextId: input.contextId,
      projectId: input.projectId,
      actorId: input.actorId,
      actorAuthSource: input.authSource,
      agent: input.agent,
      agentPrincipalId: input.agentPrincipalId,
      policy: input.policy,
      authorization: input.authorization,
      binding: {
        kind: "external",
        id: binding.id,
        revision: binding.revision,
      },
      runtime: {
        id: runtime.id,
        revision: runtime.revision,
        capabilitySnapshotId: evaluation.result.capabilitySnapshotId,
        capability: evaluation.result.runtime,
      },
      envelope: finalEnvelope,
    });
    const reasoningEffort = finalEnvelope.launch.reasoningEffort;
    const executionSnapshot: ExternalRunExecutionSnapshot = {
      schemaVersion: 1,
      runtime: {
        id: runtime.id,
        name: runtime.name,
        revision: runtime.revision,
        provider: runtime.provider,
        protocol: runtime.protocol,
        command: runtime.command,
        managedArgs: runtime.managedArgs,
        customArgs: runtime.customArgs,
        supportedModels: runtime.supportedModels,
        defaultModel: runtime.defaultModel,
        sandboxMode: runtime.sandboxMode,
        networkMode: runtime.networkMode,
        commandDigest: runtime.commandDigest,
        argsDigest: runtime.argsDigest,
      },
      binding: { id: binding.id, revision: binding.revision },
      capabilitySnapshotId: evaluation.result.capabilitySnapshotId,
      capability: evaluation.result.runtime,
      envelope: finalEnvelope,
      ...(finalEnvelope.launch.model === undefined
        ? {}
        : { model: finalEnvelope.launch.model }),
      ...(reasoningEffort === undefined
        ? {}
        : { reasoningEffort: reasoningEffort as ReasoningEffort }),
      capturedAt: evaluation.result.checkedAt,
    };
    return {
      executionEnvelope: runEnvelopeValue,
      executionSnapshot,
      observability: observability(evaluation.result.runtime),
      ...(this.policyTimeout(input.deadlineAt, input.policy.policy) ===
      undefined
        ? {}
        : {
            timeoutAt: this.policyTimeout(
              input.deadlineAt,
              input.policy.policy,
            )!,
          }),
    };
  }

  private prepareBuiltin(input: {
    readonly agent: Agent;
    readonly actorId: string;
    readonly projectId: string | null;
    readonly contextType: ExecutionContextType;
    readonly contextId: string;
    readonly taskId: string;
    readonly runId: string;
    readonly ticketId: string;
    readonly model?: string;
    readonly reasoningEffort?: AgentRuntimePreflightInput["reasoningEffort"];
    readonly deadlineAt?: string;
    readonly policy: Awaited<
      ReturnType<PlatformRepositories["taskExecutionPolicies"]["resolve"]>
    >;
    readonly authorization: {
      readonly scope: "project" | "self";
      readonly grantIds: readonly string[];
      readonly effectivePermissions: readonly ScopedAuthorizationPermission[];
      readonly membershipId: string | null;
    };
    readonly authSource: "bearer" | "local-development";
    readonly agentPrincipalId: string | null;
  }): Omit<TaskExecutionPreparation, "actionTicket" | "executionGates"> {
    const binding = builtinCapability(input.agent);
    assertPolicyRequirements(input.policy.policy, binding.profile);
    const raw = builtinEnvelope({
      agent: input.agent,
      actorId: input.actorId,
      workspaceId: input.projectId ?? `direct-chat/${input.contextId}`,
      taskId: input.taskId,
      profile: binding.profile,
      policyVersion: input.policy.version,
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: input.reasoningEffort }),
    });
    const envelope = {
      ...narrowedEnvelope({
        raw,
        policy: input.policy.policy,
        policyVersion: input.policy.version,
        profile: binding.profile,
      }),
      unresolved: [
        ...raw.unresolved,
        ...policyGaps(input.policy.policy, binding.profile),
      ],
    };
    return {
      executionEnvelope: runEnvelope({
        ticketId: input.ticketId,
        runContextType: input.contextType,
        contextId: input.contextId,
        projectId: input.projectId,
        actorId: input.actorId,
        actorAuthSource: input.authSource,
        agent: input.agent,
        agentPrincipalId: input.agentPrincipalId,
        policy: input.policy,
        authorization: input.authorization,
        binding: {
          kind: "builtin",
          id: null,
          revision: 1,
        },
        runtime: {
          id: binding.runtimeId,
          revision: binding.runtimeRevision,
          capabilitySnapshotId: null,
          capability: binding.profile,
        },
        envelope,
      }),
      observability: observability(binding.profile),
      ...(this.policyTimeout(input.deadlineAt, input.policy.policy) ===
      undefined
        ? {}
        : {
            timeoutAt: this.policyTimeout(
              input.deadlineAt,
              input.policy.policy,
            )!,
          }),
    };
  }

  private policyTimeout(
    deadlineAt: string | undefined,
    policy: TaskExecutionPolicy,
  ): string | undefined {
    const policyDeadline =
      policy.budget.timeoutMs === undefined
        ? undefined
        : new Date(Date.now() + policy.budget.timeoutMs).toISOString();
    if (deadlineAt === undefined) return policyDeadline;
    if (policyDeadline === undefined) return deadlineAt;
    return new Date(
      Math.min(
        new Date(deadlineAt).getTime(),
        new Date(policyDeadline).getTime(),
      ),
    ).toISOString();
  }
}
