import { createHash } from "node:crypto";
import type {
  AgentRuntimeBinding,
  AgentRuntimePreflightInput,
  AgentRuntimePreflightResult,
  ExecutionEnvelope,
  ExecutionPreflightResult,
  ExternalRuntime,
  ExternalRuntimeCapabilityName,
  ExternalRuntimeCapabilitySnapshot,
  ExternalRuntimeProbe,
  RuntimeCapabilityProfile,
  RuntimePreflightErrorCode,
  RuntimeToolName,
} from "@pluginmax/contracts";
import {
  adapterCapabilityProfile,
  declaredCapabilityProfile,
  runtimePreflightRemediation,
  toolCategorySchema,
} from "@pluginmax/contracts";
import type { PlatformRepositories } from "@pluginmax/database";

export type AgentRuntimePreflightEvaluation =
  | {
      readonly kind: "compatible";
      readonly result: AgentRuntimePreflightResult;
    }
  | {
      readonly kind: "failed";
      readonly code: RuntimePreflightErrorCode;
      readonly message: string;
      readonly remediation: string;
      readonly bindingRevision: number | null;
      readonly runtimeRevision: number | null;
    };

const supportedExternalProtocols = new Set<ExternalRuntime["protocol"]>([
  "codex-jsonl",
  "plain-text",
]);

const toolCategoryByRuntimeTool: Readonly<Record<RuntimeToolName, string>> = {
  web_search: "search.web",
  web_fetch: "network.fetch",
  read_file: "filesystem.read",
  write_file: "filesystem.write",
  run_command: "shell.execute",
  browser: "browser.control",
  mcp: "mcp.invoke",
  session_resume: "runtime.session-resume",
  structured_plan: "runtime.plan",
  structured_tool_events: "runtime.tool-events",
  structured_subagent: "runtime.subagent",
};

function failed(
  code: RuntimePreflightErrorCode,
  message: string,
  bindingRevision: number | null,
  runtimeRevision: number | null,
): AgentRuntimePreflightEvaluation {
  return {
    kind: "failed",
    code,
    message,
    remediation: runtimePreflightRemediation(code),
    bindingRevision,
    runtimeRevision,
  };
}

function safeWorkspaceId(value: string): boolean {
  return (
    value !== "" &&
    !value.startsWith("/") &&
    !value.startsWith("\\") &&
    !/^[a-zA-Z]:/.test(value) &&
    !value
      .split(/[\\/]/)
      .some(
        (segment) => segment === "" || segment === "." || segment === "..",
      ) &&
    // oxlint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function preflightId(input: {
  readonly agentId: string;
  readonly binding: AgentRuntimeBinding;
  readonly runtime: ExternalRuntime;
  readonly capability: ExternalRuntimeCapabilitySnapshot;
  readonly request: AgentRuntimePreflightInput;
  readonly actorId: string;
}): string {
  return `preflight-${createHash("sha256")
    .update(
      JSON.stringify({
        agentId: input.agentId,
        bindingId: input.binding.id,
        bindingRevision: input.binding.revision,
        runtimeId: input.runtime.id,
        runtimeRevision: input.runtime.revision,
        capabilitySnapshotId: input.capability.id,
        actorId: input.actorId,
        request: input.request,
      }),
    )
    .digest("hex")
    .slice(0, 40)}`;
}

function capabilityProfile(input: {
  readonly runtime: ExternalRuntime;
  readonly capability: ExternalRuntimeCapabilitySnapshot;
}): RuntimeCapabilityProfile {
  return {
    schemaVersion: 1,
    runtimeId: input.runtime.id,
    runtimeRevision: String(input.runtime.revision),
    adapterId: input.runtime.protocol,
    provider: input.runtime.provider,
    protocol: input.runtime.protocol,
    capabilities: input.capability.effectiveProfile,
    toolCategories: input.runtime.supportedTools.map(
      (tool) => toolCategoryByRuntimeTool[tool],
    ),
    networkModes:
      input.runtime.networkMode === "unknown"
        ? []
        : [input.runtime.networkMode],
    gateEnforcement: "blocking",
    limits:
      input.runtime.contextWindowTokens === null
        ? {}
        : { contextWindowTokens: input.runtime.contextWindowTokens },
    provenance: {
      adapter: true,
      probe: true,
      config: true,
      observedInRuns: false,
    },
    capturedAt: input.capability.capturedAt,
  };
}

function planVisibility(
  capability: ExternalRuntimeCapabilitySnapshot,
): "structured" | "opaque" {
  return capability.effectiveProfile.structuredPlan === "supported"
    ? "structured"
    : "opaque";
}

function buildEnvelope(input: {
  readonly agentId: string;
  readonly actorId: string;
  readonly binding: AgentRuntimeBinding;
  readonly runtime: ExternalRuntime;
  readonly request: AgentRuntimePreflightInput;
  readonly model: string | undefined;
  readonly capability: ExternalRuntimeCapabilitySnapshot;
}): ExecutionEnvelope {
  const allowedToolCategories = input.runtime.supportedTools.map(
    (tool) => toolCategoryByRuntimeTool[tool],
  );
  return {
    schemaVersion: 1,
    id: preflightId(input),
    taskId: input.request.taskId ?? "preflight",
    workspaceId: input.request.workspaceId,
    principalId: input.actorId,
    teammateId: input.agentId,
    runtimeId: input.runtime.id,
    adapterId: input.runtime.protocol,
    runtimeRevision: String(input.runtime.revision),
    policyVersion: PREFLIGHT_POLICY_VERSION,
    resolved: {
      searchEnabled:
        input.capability.effectiveProfile.search === "unknown"
          ? null
          : input.capability.effectiveProfile.search === "supported",
      networkAccess: input.runtime.networkMode,
      allowedToolCategories,
      approvalToolCategories: [],
      deniedToolCategories: [],
      sandbox: input.runtime.sandboxMode,
      gateEnforcement: "blocking",
      planVisibility: planVisibility(input.capability),
    },
    launch: {
      provider: input.runtime.provider,
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.request.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: input.request.reasoningEffort }),
      argsDigest: input.runtime.argsDigest,
      commandDigest: input.runtime.commandDigest,
      authMode: "provider-managed",
    },
    unresolved: [],
    createdAt: new Date().toISOString(),
  };
}

function selectModel(
  runtime: ExternalRuntime,
  requestedModel: string | undefined,
):
  | { readonly kind: "selected"; readonly model: string | undefined }
  | { readonly kind: "failed"; readonly code: RuntimePreflightErrorCode } {
  const model = requestedModel ?? runtime.defaultModel ?? undefined;
  if (runtime.supportedModels.length === 0) {
    if (model !== undefined) {
      return { kind: "failed", code: "runtime_model_unsupported" };
    }
    return { kind: "selected", model: undefined };
  }
  if (model === undefined) {
    return { kind: "failed", code: "runtime_model_required" };
  }
  if (!runtime.supportedModels.includes(model)) {
    return { kind: "failed", code: "runtime_model_unsupported" };
  }
  return { kind: "selected", model };
}

function missingCapabilities(
  capability: ExternalRuntimeCapabilitySnapshot,
  required: readonly ExternalRuntimeCapabilityName[],
): ExternalRuntimeCapabilityName[] {
  return required.filter(
    (name) => capability.effectiveProfile[name] !== "supported",
  );
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

function sameCapabilitySet(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

export const PREFLIGHT_POLICY_VERSION = "external-runtime-preflight-v1";

export class AgentRuntimePreflightService {
  constructor(private readonly repositories: PlatformRepositories) {}

  async preflight(input: {
    readonly agentId: string;
    readonly actorId: string;
    readonly administrator: boolean;
    readonly request: AgentRuntimePreflightInput;
  }): Promise<AgentRuntimePreflightEvaluation> {
    const agent = await this.repositories.agents.get(input.agentId, true);
    if (agent === undefined) {
      return failed("agent_not_found", "Agent not found", null, null);
    }
    if (agent.status !== "active") {
      return failed("agent_unavailable", "The agent is disabled", null, null);
    }

    const binding = await this.repositories.agentRuntimeBindings.getCurrent(
      input.agentId,
    );
    if (binding === undefined) {
      return failed(
        "runtime_binding_missing",
        "The agent has no external runtime binding",
        null,
        null,
      );
    }
    const runtime = await this.repositories.externalRuntimes.get(
      binding.runtimeId,
    );
    if (runtime === undefined) {
      return failed(
        "runtime_not_found",
        "The bound external runtime no longer exists",
        binding.revision,
        null,
      );
    }
    if (
      !input.administrator &&
      runtime.ownerId !== input.actorId &&
      runtime.visibility !== "platform"
    ) {
      return failed(
        "runtime_forbidden",
        "The actor cannot access this external runtime",
        binding.revision,
        runtime.revision,
      );
    }
    if (runtime.status === "archived") {
      return failed(
        "runtime_archived",
        "The bound external runtime is archived",
        binding.revision,
        runtime.revision,
      );
    }
    if (runtime.status !== "active") {
      return failed(
        "runtime_inactive",
        "The bound external runtime is disabled",
        binding.revision,
        runtime.revision,
      );
    }
    if (binding.status !== "active") {
      return failed(
        "runtime_binding_disabled",
        "The external runtime binding is disabled",
        binding.revision,
        runtime.revision,
      );
    }
    if (binding.revision !== input.request.expectedRevision) {
      return failed(
        "runtime_binding_revision_conflict",
        "The binding was changed by another request",
        binding.revision,
        runtime.revision,
      );
    }
    if (!safeWorkspaceId(input.request.workspaceId)) {
      return failed(
        "runtime_workspace_invalid",
        "The workspace identifier is outside the allowed workspace scope",
        binding.revision,
        runtime.revision,
      );
    }
    if (!supportedExternalProtocols.has(runtime.protocol)) {
      return failed(
        "runtime_protocol_unsupported",
        `Runtime protocol ${runtime.protocol} is not supported`,
        binding.revision,
        runtime.revision,
      );
    }

    const probe = await this.repositories.externalRuntimes.latestProbe(
      runtime.id,
    );
    const probeFailure = preflightProbeFailure(
      runtime,
      probe,
      binding.revision,
    );
    if (probeFailure !== undefined) return probeFailure;
    const capability =
      await this.repositories.externalRuntimes.capabilityForProbe(
        runtime.id,
        probe!.id,
      );
    if (capability === undefined) {
      return failed(
        "runtime_capability_snapshot_missing",
        "The current probe has no capability snapshot",
        binding.revision,
        runtime.revision,
      );
    }
    const expectedAdapter = adapterCapabilityProfile(runtime.protocol);
    const expectedDeclared = declaredCapabilityProfile(
      runtime.supportedTools,
      runtime.networkMode,
    );
    if (
      !sameCapabilitySet(capability.adapterProfile, expectedAdapter) ||
      !sameCapabilitySet(capability.declaredProfile, expectedDeclared)
    ) {
      return failed(
        "runtime_probe_stale",
        "The capability snapshot does not match the current runtime declaration",
        binding.revision,
        runtime.revision,
      );
    }

    const model = selectModel(runtime, input.request.model);
    if (model.kind === "failed") {
      return failed(
        model.code,
        model.code === "runtime_model_required"
          ? "The runtime requires an explicit or default model"
          : "The requested model is not supported by the runtime",
        binding.revision,
        runtime.revision,
      );
    }
    const missing = missingCapabilities(
      capability,
      input.request.requiredCapabilities,
    );
    if (missing.length > 0) {
      return failed(
        "runtime_capability_missing",
        `The runtime does not satisfy required capabilities: ${missing.join(", ")}`,
        binding.revision,
        runtime.revision,
      );
    }
    if (
      input.request.requiredSandboxMode !== undefined &&
      input.request.requiredSandboxMode !== runtime.sandboxMode
    ) {
      return failed(
        "runtime_sandbox_unsupported",
        `Runtime sandbox ${runtime.sandboxMode} does not match ${input.request.requiredSandboxMode}`,
        binding.revision,
        runtime.revision,
      );
    }
    if (
      input.request.requiredNetworkMode !== undefined &&
      input.request.requiredNetworkMode !== runtime.networkMode
    ) {
      return failed(
        "runtime_network_unsupported",
        `Runtime network mode ${runtime.networkMode} does not match ${input.request.requiredNetworkMode}`,
        binding.revision,
        runtime.revision,
      );
    }

    const profile = capabilityProfile({ runtime, capability });
    if (
      !profile.toolCategories.every(
        (value) => toolCategorySchema.safeParse(value).success,
      )
    ) {
      return failed(
        "runtime_capability_missing",
        "The runtime contains a tool category that cannot be represented safely",
        binding.revision,
        runtime.revision,
      );
    }
    const envelope = buildEnvelope({
      agentId: input.agentId,
      actorId: input.actorId,
      binding,
      runtime,
      request: input.request,
      model: model.model,
      capability,
    });
    const execution: ExecutionPreflightResult = {
      compatible: true,
      runtime: profile,
      envelopePreview: envelope,
      gaps: [],
      suggestedRuntimeIds: [],
      warnings:
        runtime.protocol === "plain-text"
          ? ["Plain-text runtimes expose final output only."]
          : [],
    };
    return {
      kind: "compatible",
      result: {
        ...execution,
        bindingRevision: binding.revision,
        runtimeRevision: runtime.revision,
        capabilitySnapshotId: capability.id,
        checkedAt: new Date().toISOString(),
      },
    };
  }
}

function preflightProbeFailure(
  runtime: ExternalRuntime,
  probe: ExternalRuntimeProbe | undefined,
  bindingRevision: number,
): AgentRuntimePreflightEvaluation | undefined {
  if (probe === undefined) {
    return failed(
      "runtime_probe_missing",
      "The runtime has no probe",
      bindingRevision,
      runtime.revision,
    );
  }
  if (probe.id !== runtime.lastProbe?.id) {
    return failed(
      "runtime_probe_stale",
      "The runtime no longer references the latest probe",
      bindingRevision,
      runtime.revision,
    );
  }
  if (probe.commandDigest !== runtime.commandDigest) {
    return failed(
      "runtime_command_digest_mismatch",
      "The latest probe does not match the current runtime command",
      bindingRevision,
      runtime.revision,
    );
  }
  if (probe.argsDigest !== runtime.argsDigest) {
    return failed(
      "runtime_args_digest_mismatch",
      "The latest probe does not match the current runtime arguments",
      bindingRevision,
      runtime.revision,
    );
  }
  if (probe.status === "requested" || probe.status === "running") {
    return failed(
      "runtime_probe_pending",
      "The latest runtime probe is still pending",
      bindingRevision,
      runtime.revision,
    );
  }
  if (probe.status !== "passed") {
    return failed(
      "runtime_probe_failed",
      "The latest runtime probe failed",
      bindingRevision,
      runtime.revision,
    );
  }
  return undefined;
}
