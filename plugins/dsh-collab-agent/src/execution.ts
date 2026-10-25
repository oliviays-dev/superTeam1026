import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  agentExecutionPlanSchema,
  executionEnvelopeSchema,
  executionGateSchema,
  legacyTaskExecutionPolicy,
  runEventSchema,
  runExecutionSnapshotSchema,
  runtimeCapabilityProfileSchema,
  taskExecutionPolicySchema,
  type AgentExecutionPlan,
  type CapabilityGap,
  type CapabilityState,
  type ExecutionEnvelope,
  type ExecutionGate,
  type ExecutionPlanStep,
  type ExecutionPreflightResult,
  type GateEnforcement,
  type PlanVisibility,
  type RunEvent,
  type RunEventType,
  type RunExecutionSnapshot,
  type RuntimeCapabilityProfile,
  type RuntimeRequirement,
  type TaskExecutionPolicy,
  type ToolCategory,
} from "@pluginmax/contracts";

export interface KvTableLike<V> {
  get(key: string): V | undefined;
  entries(): IterableIterator<[string, V]>;
  put(key: string, value: V): Promise<void>;
  delete(key: string): Promise<boolean>;
  readonly size: number;
}

const outboxSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  version: z.literal(1),
  aggregateId: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  status: z.enum(["pending", "published", "failed"]),
  attempts: z.number().int().nonnegative(),
  createdAt: z.string().min(1),
  nextAttemptAt: z.string().min(1).optional(),
});
type ExecutionOutboxRecord = z.infer<typeof outboxSchema>;

export const executionDomainSpec = {
  name: "collab_agent_execution",
  version: 1,
  tables: {
    capabilities: {
      valueSchema:
        runtimeCapabilityProfileSchema as unknown as z.ZodType<unknown>,
    },
    envelopes: {
      valueSchema: executionEnvelopeSchema as unknown as z.ZodType<unknown>,
    },
    plans: {
      valueSchema: agentExecutionPlanSchema as unknown as z.ZodType<unknown>,
    },
    run_events: {
      valueSchema: runEventSchema as unknown as z.ZodType<unknown>,
    },
    gates: {
      valueSchema: executionGateSchema as unknown as z.ZodType<unknown>,
    },
    snapshots: {
      valueSchema: runExecutionSnapshotSchema as unknown as z.ZodType<unknown>,
    },
    outbox: {
      valueSchema: outboxSchema as unknown as z.ZodType<unknown>,
    },
  },
} as const;

export interface ExecutionDomainLike {
  table(name: "capabilities"): KvTableLike<RuntimeCapabilityProfile>;
  table(name: "envelopes"): KvTableLike<ExecutionEnvelope>;
  table(name: "plans"): KvTableLike<AgentExecutionPlan>;
  table(name: "run_events"): KvTableLike<RunEvent>;
  table(name: "gates"): KvTableLike<ExecutionGate>;
  table(name: "snapshots"): KvTableLike<RunExecutionSnapshot>;
  table(name: "outbox"): KvTableLike<ExecutionOutboxRecord>;
  close(): Promise<void>;
}

export interface ExecutionRuntimeLike {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly protocol: "codex-jsonl" | "plain-text";
  readonly args: readonly string[];
  readonly supportedTools?: readonly string[] | undefined;
  readonly supportedModels?: readonly string[] | undefined;
  readonly defaultModel?: string | undefined;
  readonly contextWindowTokens?: number | undefined;
  readonly status: "active" | "disabled" | "archived";
}

export interface ExecutionProfileLike {
  readonly id: string;
  readonly name: string;
  readonly execution?: "builtin" | "external" | undefined;
  readonly externalRuntimeId?: string | undefined;
  readonly allowedTools: readonly string[];
  readonly defaultModel?:
    | {
        readonly provider: string;
        readonly model: string;
        readonly reasoningEffort?: string | undefined;
      }
    | undefined;
}

export interface ExecutionRunLike {
  readonly id: string;
  readonly workspaceId: string;
  readonly source: "workflow" | "task" | "meeting" | "chat";
  readonly instanceId: string;
  readonly agentProfileId: string;
  readonly personaId?: string | undefined;
  readonly principalId?: string | undefined;
  readonly ticketId?: string | undefined;
  readonly contextPackId?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly status:
    | "queued"
    | "running"
    | "waiting_input"
    | "succeeded"
    | "failed"
    | "timeout"
    | "cancelled"
    | "interrupted";
  readonly payload: {
    readonly context: Readonly<
      Record<string, string | number | boolean | undefined>
    >;
  };
  readonly createdAt: string;
  readonly startedAt?: string | undefined;
  readonly endedAt?: string | undefined;
  readonly error?: string | undefined;
  readonly execution?:
    | {
        readonly provider?: string | undefined;
        readonly model?: string | undefined;
        readonly reasoningEffort?: string | undefined;
        readonly runtime?: string | undefined;
        readonly runtimeVersion?: string | undefined;
        readonly authMode?: string | undefined;
        readonly sandbox?: string | undefined;
      }
    | undefined;
  readonly output?: { readonly summary?: string | undefined } | undefined;
}

export interface RuntimeTraceLike {
  readonly kind:
    | "spawn"
    | "stdin"
    | "stdout"
    | "stderr"
    | "error"
    | "close"
    | "session"
    | "thinking"
    | "assistant"
    | "tool_call"
    | "tool_result"
    | "result"
    | "retry";
  readonly data?: string | undefined;
  readonly message?: string | undefined;
  readonly exitCode?: number | null | undefined;
}

export interface SessionEventLike {
  readonly type: string;
  readonly data?: unknown;
}

export interface ExecutionPreflightInput {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly teammateId?: string | undefined;
  readonly policy?: TaskExecutionPolicy | undefined;
  readonly profile: ExecutionProfileLike;
  readonly runtime?: ExecutionRuntimeLike | undefined;
  readonly ticketId?: string | undefined;
}

export interface ExecutionProjection {
  readonly runId: string;
  readonly plan: AgentExecutionPlan;
  readonly snapshot: RunExecutionSnapshot;
  readonly events: readonly RunEvent[];
  readonly gates: readonly ExecutionGate[];
}

export interface RequestExecutionGateInput {
  readonly runId: string;
  readonly kind: ExecutionGate["kind"];
  readonly reason: string;
  readonly requestedToolCategory?: ToolCategory | undefined;
  readonly requestedScope?: readonly string[] | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number | undefined;
}

export type ExecutionGateDecision = "approved" | "denied" | "expired";

const BUILTIN_TOOL_CATEGORIES: readonly ToolCategory[] = [
  "fs.read",
  "fs.write",
  "shell.execute",
  "web.search",
  "web.fetch",
  "browser.control",
];

const SEARCH_TOOL_NAMES = new Set([
  "web_search",
  "web_fetch",
  "search",
  "browse",
]);

function nowIso(now: () => Date): string {
  return now().toISOString();
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function executionToolCategory(name: string): ToolCategory {
  const normalized = name.toLowerCase();
  if (normalized === "web_search" || normalized.includes("search")) {
    return "web.search";
  }
  if (normalized === "web_fetch" || normalized.includes("fetch")) {
    return "web.fetch";
  }
  if (
    normalized === "write" ||
    normalized === "edit" ||
    normalized === "str_replace_editor"
  ) {
    return "fs.write";
  }
  if (
    normalized === "read" ||
    normalized === "read_image" ||
    normalized === "glob" ||
    normalized === "grep"
  ) {
    return "fs.read";
  }
  if (
    normalized === "bash" ||
    normalized === "pwsh" ||
    normalized === "run_code"
  ) {
    return "shell.execute";
  }
  if (normalized.startsWith("terminal_")) return "shell.execute";
  if (normalized.includes("browser")) return "browser.control";
  return `tool.${normalized.replace(/[^a-z0-9._-]/g, "-")}`;
}

const toolCategory = executionToolCategory;

function profileToolCategories(
  profile: ExecutionProfileLike,
): readonly ToolCategory[] {
  if (profile.allowedTools.length === 0) return BUILTIN_TOOL_CATEGORIES;
  return [...new Set(profile.allowedTools.map(toolCategory))];
}

const RUNTIME_TOOL_CATEGORY: Readonly<Record<string, ToolCategory>> = {
  web_search: "web.search",
  web_fetch: "web.fetch",
  read_file: "fs.read",
  write_file: "fs.write",
  run_command: "shell.execute",
  browser: "browser.control",
  mcp: "mcp",
};

function runtimeToolCategories(
  runtime: ExecutionRuntimeLike,
): readonly ToolCategory[] {
  return [
    ...new Set(
      (runtime.supportedTools ?? []).flatMap((name) => {
        const category = RUNTIME_TOOL_CATEGORY[name];
        return category === undefined ? [] : [category];
      }),
    ),
  ];
}

function runtimeDefaultModel(
  runtime: ExecutionRuntimeLike,
): string | undefined {
  if (runtime.defaultModel !== undefined) return runtime.defaultModel;
  for (let index = 0; index < runtime.args.length; index += 1) {
    const token = runtime.args[index];
    if (token !== "--model" && token !== "-m") continue;
    const value = runtime.args[index + 1]?.trim();
    return value === undefined || value === "" ? undefined : value;
  }
  return undefined;
}

function runtimeProtocol(input: {
  readonly profile: ExecutionProfileLike;
  readonly runtime?: ExecutionRuntimeLike | undefined;
}): RuntimeCapabilityProfile["protocol"] {
  if (input.profile.execution === "external" || input.runtime !== undefined) {
    return input.runtime?.protocol ?? "future";
  }
  return "builtin";
}

function capabilityFor(input: {
  readonly profile: ExecutionProfileLike;
  readonly runtime?: ExecutionRuntimeLike | undefined;
  readonly at: string;
}): RuntimeCapabilityProfile {
  const protocol = runtimeProtocol(input);
  const runtimeId =
    input.runtime?.id ??
    input.profile.externalRuntimeId ??
    `builtin:${input.profile.id}`;
  const runtimeRevision = sha256(
    stableJson({
      runtimeId,
      protocol,
      args: input.runtime?.args ?? [],
      supportedTools: input.runtime?.supportedTools ?? [],
      supportedModels: input.runtime?.supportedModels ?? [],
      defaultModel: input.runtime?.defaultModel,
      contextWindowTokens: input.runtime?.contextWindowTokens,
      profile: input.profile.id,
    }),
  ).slice(0, 24);
  const hasDeclaredRuntimeTools =
    input.runtime !== undefined &&
    Array.isArray(input.runtime.supportedTools) &&
    input.runtime.supportedTools.length > 0;
  const configuredTools = hasDeclaredRuntimeTools
    ? runtimeToolCategories(input.runtime!)
    : protocol === "builtin"
      ? profileToolCategories(input.profile)
      : protocol === "codex-jsonl"
        ? (["fs.read", "shell.execute"] as ToolCategory[])
        : [];
  const supportsTool = (
    name: string,
    fallback: CapabilityState,
  ): CapabilityState =>
    hasDeclaredRuntimeTools
      ? input.runtime?.supportedTools?.includes(name) === true
        ? "supported"
        : "unsupported"
      : fallback;
  const searchArgument = input.runtime?.args.includes("--search") === true;
  const search = supportsTool(
    "web_search",
    protocol === "builtin"
      ? configuredTools.includes("web.search") ||
        configuredTools.includes("web.fetch")
        ? "supported"
        : "unsupported"
      : searchArgument
        ? "supported"
        : "unknown",
  );
  const structuredPlan: CapabilityState =
    protocol === "builtin" ? "supported" : "unknown";
  const structuredToolEvents: CapabilityState =
    protocol === "builtin"
      ? "supported"
      : protocol === "codex-jsonl"
        ? "unknown"
        : "unsupported";
  const gateEnforcement: GateEnforcement =
    protocol === "builtin" ? "blocking" : "observe-only";
  return runtimeCapabilityProfileSchema.parse({
    schemaVersion: 1,
    runtimeId,
    runtimeRevision,
    adapterId:
      protocol === "builtin"
        ? "builtin"
        : protocol === "codex-jsonl"
          ? "codex-jsonl"
          : "plain-text",
    provider: input.runtime?.provider ?? "platform",
    protocol,
    capabilities: {
      search,
      network:
        supportsTool(
          "web_search",
          protocol === "builtin" || protocol === "codex-jsonl"
            ? "supported"
            : "unknown",
        ) === "supported" ||
        supportsTool("web_fetch", "unknown") === "supported" ||
        supportsTool("browser", "unknown") === "supported" ||
        supportsTool("mcp", "unknown") === "supported"
          ? "supported"
          : hasDeclaredRuntimeTools
            ? "unsupported"
            : protocol === "builtin" || protocol === "codex-jsonl"
              ? "supported"
              : "unknown",
      fileRead: supportsTool(
        "read_file",
        configuredTools.includes("fs.read") ? "supported" : "supported",
      ),
      fileWrite: supportsTool(
        "write_file",
        protocol === "builtin"
          ? configuredTools.includes("fs.write")
            ? "supported"
            : "unsupported"
          : protocol === "codex-jsonl"
            ? "unsupported"
            : "unknown",
      ),
      shell: supportsTool(
        "run_command",
        protocol === "builtin"
          ? configuredTools.includes("shell.execute")
            ? "supported"
            : "unsupported"
          : protocol === "codex-jsonl"
            ? "supported"
            : "unknown",
      ),
      browser: supportsTool(
        "browser",
        protocol === "builtin" && configuredTools.includes("browser.control")
          ? "supported"
          : "unknown",
      ),
      mcp: supportsTool("mcp", "unknown"),
      sessionResume: protocol === "plain-text" ? "unsupported" : "unknown",
      structuredPlan,
      structuredToolEvents,
      structuredSubagent: "unknown",
    },
    toolCategories: [...configuredTools],
    networkModes:
      protocol === "builtin"
        ? ["restricted", "public"]
        : protocol === "codex-jsonl"
          ? ["restricted"]
          : [],
    gateEnforcement,
    limits: {
      maxDurationMs: 3_600_000,
      ...(input.runtime?.contextWindowTokens === undefined
        ? {}
        : { contextWindowTokens: input.runtime.contextWindowTokens }),
    },
    provenance: {
      adapter: true,
      probe: false,
      config: true,
      observedInRuns: false,
    },
    capturedAt: input.at,
  });
}

function capabilityForRequirement(
  runtime: RuntimeCapabilityProfile,
  requirement: RuntimeRequirement,
): CapabilityState {
  switch (requirement.key) {
    case "search":
      return runtime.capabilities.search;
    case "network":
      return runtime.capabilities.network;
    case "file-read":
      return runtime.capabilities.fileRead;
    case "file-write":
      return runtime.capabilities.fileWrite;
    case "shell":
      return runtime.capabilities.shell;
    case "browser":
      return runtime.capabilities.browser;
    case "mcp":
      return runtime.capabilities.mcp;
    case "structured-plan":
      return runtime.capabilities.structuredPlan;
    case "structured-tool-events":
      return runtime.capabilities.structuredToolEvents;
    case "blocking-gate":
      return runtime.gateEnforcement === "blocking"
        ? "supported"
        : "unsupported";
  }
}

function gapsFor(input: {
  readonly runtime: RuntimeCapabilityProfile;
  readonly runtimeConfig?: ExecutionRuntimeLike | undefined;
  readonly policy: TaskExecutionPolicy;
}): CapabilityGap[] {
  const gaps: CapabilityGap[] = [];
  if (
    input.policy.runtime.allowedRuntimeIds.length > 0 &&
    !input.policy.runtime.allowedRuntimeIds.includes(input.runtime.runtimeId)
  ) {
    gaps.push({
      code: "policy-not-authorized",
      key: "runtime",
      necessity: "required",
      message: `Runtime 不在任务允许列表中：${input.runtime.runtimeId}`,
      remediation: "选择任务允许的 Runtime。",
    });
  }
  const requestedModel = input.policy.runtime.model;
  const supportedModels = input.runtimeConfig?.supportedModels ?? [];
  if (
    requestedModel !== undefined &&
    supportedModels.length > 0 &&
    !supportedModels.includes(requestedModel)
  ) {
    gaps.push({
      code: "runtime-capability-missing",
      key: "model",
      necessity: "required",
      message: `模型「${requestedModel}」不在 Runtime「${input.runtimeConfig?.name ?? input.runtime.runtimeId}」的模型池中`,
      remediation: "从 Runtime 支持的模型池中选择模型，或先更新 Runtime 定义。",
    });
  }
  for (const requirement of input.policy.runtime.requiredCapabilities) {
    const state = capabilityForRequirement(input.runtime, requirement);
    if (state === "supported") continue;
    gaps.push({
      code:
        state === "unknown"
          ? "runtime-capability-missing"
          : "runtime-capability-missing",
      key: requirement.key,
      necessity: requirement.necessity,
      message:
        state === "unknown"
          ? `Runtime capability is unknown: ${requirement.key}`
          : `Runtime does not support: ${requirement.key}`,
      remediation:
        state === "unknown"
          ? "Probe the runtime or select a runtime with an explicit capability profile."
          : "Select a compatible runtime or narrow the task requirements.",
    });
  }
  if (
    input.policy.sourcePolicy.allow.includes("public-web") &&
    input.runtime.capabilities.search === "unsupported"
  ) {
    gaps.push({
      code: "runtime-capability-missing",
      key: "public-web",
      necessity: "required",
      message:
        "The task allows public web sources, but the runtime has no search capability.",
      remediation: "Select a search-capable runtime.",
    });
  }
  return gaps;
}

function effectiveSearch(input: {
  readonly runtime: RuntimeCapabilityProfile;
  readonly policy: TaskExecutionPolicy;
  readonly profile: ExecutionProfileLike;
}): boolean | null {
  if (
    input.policy.sourcePolicy.deny.includes("public-web") ||
    input.runtime.capabilities.search === "unsupported"
  ) {
    return false;
  }
  const builtinEnabled =
    input.runtime.protocol === "builtin" &&
    (input.profile.allowedTools.length === 0 ||
      input.profile.allowedTools.includes("web_search") ||
      input.profile.allowedTools.includes("web_fetch"));
  const externalEnabled =
    input.runtime.protocol !== "builtin" &&
    input.runtime.provenance.config &&
    input.runtime.capabilities.search === "supported";
  if (
    input.policy.sourcePolicy.allow.includes("public-web") &&
    (builtinEnabled || externalEnabled)
  ) {
    return true;
  }
  return input.runtime.capabilities.search === "unknown" ? null : false;
}

function planVisibility(runtime: RuntimeCapabilityProfile): PlanVisibility {
  if (runtime.capabilities.structuredPlan === "supported") {
    return "structured";
  }
  return "summary";
}

function buildEnvelope(input: {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly teammateId?: string | undefined;
  readonly profile: ExecutionProfileLike;
  readonly runtime?: ExecutionRuntimeLike | undefined;
  readonly capability: RuntimeCapabilityProfile;
  readonly policy: TaskExecutionPolicy;
  readonly policyVersion: string;
  readonly ticketId?: string | undefined;
  readonly runId?: string | undefined;
  readonly at: string;
}): ExecutionEnvelope {
  const allowed = [
    ...new Set(
      input.policy.toolPolicy.allow.length === 0
        ? input.capability.toolCategories
        : input.policy.toolPolicy.allow.filter((category) =>
            input.capability.toolCategories.includes(category),
          ),
    ),
  ];
  const denied = [...new Set(input.policy.toolPolicy.deny)];
  const approval = [
    ...new Set([
      ...input.policy.toolPolicy.requireApproval,
      ...input.policy.humanGates.flatMap((gate) =>
        gate.toolCategory === undefined ? [] : [gate.toolCategory],
      ),
    ]),
  ].filter((category) => !denied.includes(category));
  const gaps = gapsFor({
    runtime: input.capability,
    ...(input.runtime === undefined ? {} : { runtimeConfig: input.runtime }),
    policy: input.policy,
  });
  const model =
    input.policy.runtime.model ??
    (input.profile.execution === "external"
      ? input.runtime === undefined
        ? input.profile.defaultModel?.model
        : runtimeDefaultModel(input.runtime)
      : input.profile.defaultModel?.model);
  const reasoningEffort =
    input.policy.runtime.reasoningEffort ??
    input.profile.defaultModel?.reasoningEffort;
  return executionEnvelopeSchema.parse({
    schemaVersion: 1,
    id: `env-${randomUUID()}`,
    taskId: input.taskId,
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    workspaceId: input.workspaceId,
    principalId: input.principalId,
    ...(input.teammateId === undefined ? {} : { teammateId: input.teammateId }),
    runtimeId: input.capability.runtimeId,
    adapterId: input.capability.adapterId,
    runtimeRevision: input.capability.runtimeRevision,
    policyVersion: input.policyVersion,
    ...(input.ticketId === undefined ? {} : { ticketId: input.ticketId }),
    resolved: {
      searchEnabled: effectiveSearch({
        runtime: input.capability,
        policy: input.policy,
        profile: input.profile,
      }),
      networkAccess:
        input.capability.capabilities.network === "unsupported"
          ? "none"
          : input.capability.protocol === "builtin"
            ? "restricted"
            : input.capability.protocol === "codex-jsonl"
              ? "restricted"
              : "unknown",
      allowedToolCategories: allowed.filter(
        (category) => !denied.includes(category),
      ),
      approvalToolCategories: approval,
      deniedToolCategories: denied,
      sandbox:
        input.capability.protocol === "codex-jsonl"
          ? "read-only"
          : input.capability.protocol === "builtin"
            ? "platform-managed"
            : "unknown",
      gateEnforcement: input.capability.gateEnforcement,
      planVisibility: planVisibility(input.capability),
    },
    launch: {
      provider:
        input.runtime?.provider ??
        input.profile.defaultModel?.provider ??
        "platform",
      ...(model === undefined ? {} : { model }),
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      ...(input.runtime === undefined
        ? {}
        : {
            argsDigest: sha256(stableJson(input.runtime.args)).slice(0, 32),
            commandDigest: sha256(input.runtime.id).slice(0, 32),
          }),
      authMode:
        input.capability.protocol === "builtin"
          ? "platform-managed"
          : "unknown",
    },
    unresolved: gaps,
    createdAt: input.at,
  });
}

function taskIdForRun(run: ExecutionRunLike): string {
  const value = run.payload.context.taskId;
  return typeof value === "string" && value !== "" ? value : run.instanceId;
}

function messageText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .flatMap((item) => {
      if (typeof item !== "object" || item === null) return [];
      const record = item as Record<string, unknown>;
      return typeof record.text === "string" ? [record.text] : [];
    })
    .join("\n");
}

function eventSummary(event: SessionEventLike):
  | {
      readonly type: RunEventType;
      readonly summary: string;
      readonly data?: Record<string, unknown>;
    }
  | undefined {
  const data =
    typeof event.data === "object" && event.data !== null
      ? (event.data as Record<string, unknown>)
      : {};
  if (event.type === "todo/write" && Array.isArray(data.todos)) {
    return {
      type: "plan.snapshot",
      summary: `Agent 更新了 ${String(data.todos.length)} 个执行步骤`,
      data: { todos: data.todos },
    };
  }
  if (event.type === "tool/call") {
    const name = typeof data.name === "string" ? data.name : "unknown";
    return {
      type: "tool.call",
      summary: `调用工具：${name}`,
      data: {
        toolName: name,
        toolCategory: toolCategory(name),
        arguments: typeof data.arguments === "string" ? data.arguments : "",
      },
    };
  }
  if (event.type === "tool/result") {
    const callId = typeof data.callId === "string" ? data.callId : "";
    const message = data.message as { readonly content?: unknown } | undefined;
    return {
      type: "tool.result",
      summary: `工具结果：${callId || "unknown"}`,
      data: {
        callId,
        output: messageText(message?.content),
        isError:
          typeof data.error === "object" &&
          data.error !== null &&
          Object.keys(data.error).length > 0,
      },
    };
  }
  if (event.type === "assistant/message") {
    const message = data.message as { readonly content?: unknown } | undefined;
    const text = messageText(message?.content).trim();
    if (text === "") return undefined;
    return {
      type: "progress.summary",
      summary: text.slice(0, 4_000),
    };
  }
  return undefined;
}

export class AgentExecutionService {
  private readonly queueByRun = new Map<string, Promise<unknown>>();
  private readonly pendingGates = new Map<
    string,
    (decision: ExecutionGateDecision) => void
  >();
  private readonly runIdBySession = new Map<string, string>();
  private readonly traceSeqByRun = new Map<string, number>();

  constructor(
    private readonly tables: {
      readonly capabilities: KvTableLike<RuntimeCapabilityProfile>;
      readonly envelopes: KvTableLike<ExecutionEnvelope>;
      readonly plans: KvTableLike<AgentExecutionPlan>;
      readonly runEvents: KvTableLike<RunEvent>;
      readonly gates: KvTableLike<ExecutionGate>;
      readonly snapshots: KvTableLike<RunExecutionSnapshot>;
      readonly outbox: KvTableLike<ExecutionOutboxRecord>;
    },
    private readonly options: {
      readonly now?: () => Date;
    } = {},
  ) {}

  private now(): string {
    return nowIso(this.options.now ?? (() => new Date()));
  }

  private enqueue<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queueByRun.get(runId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    this.queueByRun.set(runId, tail);
    void tail.finally(() => {
      if (this.queueByRun.get(runId) === tail) {
        this.queueByRun.delete(runId);
      }
    });
    return next;
  }

  private events(runId: string): RunEvent[] {
    return [...this.tables.runEvents.entries()]
      .map(([, event]) => event)
      .filter((event) => event.runId === runId)
      .sort((left, right) => left.seq - right.seq);
  }

  private gates(runId: string): ExecutionGate[] {
    return [...this.tables.gates.entries()]
      .map(([, gate]) => gate)
      .filter((gate) => gate.runId === runId)
      .sort((left, right) => left.requestedAt.localeCompare(right.requestedAt));
  }

  private async savePlan(
    plan: AgentExecutionPlan,
  ): Promise<AgentExecutionPlan> {
    const parsed = agentExecutionPlanSchema.parse({
      ...plan,
      updatedAt: this.now(),
    });
    await this.tables.plans.put(parsed.runId, parsed);
    return parsed;
  }

  private async saveSnapshot(
    snapshot: RunExecutionSnapshot,
  ): Promise<RunExecutionSnapshot> {
    const parsed = runExecutionSnapshotSchema.parse(snapshot);
    await this.tables.snapshots.put(parsed.runId, parsed);
    return parsed;
  }

  private enqueueOutbox(input: {
    readonly type: string;
    readonly aggregateId: string;
    readonly payload: Record<string, unknown>;
  }): Promise<void> {
    const record = outboxSchema.parse({
      id: `outbox-${randomUUID()}`,
      type: input.type,
      version: 1,
      aggregateId: input.aggregateId,
      payload: input.payload,
      status: "pending",
      attempts: 0,
      createdAt: this.now(),
    });
    return this.tables.outbox.put(record.id, record);
  }

  private async appendEvent(
    runId: string,
    input: {
      readonly type: RunEventType;
      readonly source: RunEvent["source"];
      readonly sourceEventId?: string | undefined;
      readonly visibility?: RunEvent["visibility"] | undefined;
      readonly summary: string;
      readonly data?: Record<string, unknown> | undefined;
    },
  ): Promise<RunEvent | undefined> {
    if (input.sourceEventId !== undefined) {
      const deterministicId = `evt-${sha256(
        `${runId}:${input.source}:${input.sourceEventId}:${input.type}`,
      ).slice(0, 32)}`;
      if (this.tables.runEvents.get(deterministicId) !== undefined) {
        return undefined;
      }
    }
    const currentEvents = this.events(runId);
    const seq = (currentEvents.at(-1)?.seq ?? 0) + 1;
    const event = runEventSchema.parse({
      schemaVersion: 1,
      id:
        input.sourceEventId === undefined
          ? `evt-${randomUUID()}`
          : `evt-${sha256(
              `${runId}:${input.source}:${input.sourceEventId}:${input.type}`,
            ).slice(0, 32)}`,
      runId,
      seq,
      type: input.type,
      source: input.source,
      ...(input.sourceEventId === undefined
        ? {}
        : { sourceEventId: input.sourceEventId }),
      visibility: input.visibility ?? "public",
      summary: input.summary,
      ...(input.data === undefined ? {} : { data: input.data }),
      createdAt: this.now(),
    });
    await this.tables.runEvents.put(event.id, event);
    const snapshot = this.tables.snapshots.get(runId);
    if (snapshot !== undefined) {
      const toolName =
        event.type === "tool.call" && typeof event.data?.toolName === "string"
          ? event.data.toolName
          : undefined;
      const usedTools =
        toolName === undefined || snapshot.usedTools.includes(toolName)
          ? snapshot.usedTools
          : [...snapshot.usedTools, toolName];
      const searchUsed =
        event.type === "tool.call" &&
        (SEARCH_TOOL_NAMES.has(toolName ?? "") ||
          event.data?.toolCategory === "web.search" ||
          event.data?.toolCategory === "web.fetch")
          ? true
          : snapshot.searchUsed;
      await this.saveSnapshot({
        ...snapshot,
        usedTools,
        searchUsed,
      });
    }
    const plan = this.tables.plans.get(runId);
    if (plan !== undefined) {
      const stepStatus =
        event.type === "step.failed" || event.type === "error"
          ? "failed"
          : event.type === "step.completed"
            ? "completed"
            : (plan.steps[0]?.status ?? "active");
      const steps =
        plan.steps.length === 0
          ? [
              {
                id: "execute",
                ordinal: 0,
                title: "执行",
                status: stepStatus,
                evidenceRefs: [],
              } satisfies ExecutionPlanStep,
            ]
          : plan.steps.map((step, index) =>
              index === 0 ? { ...step, status: stepStatus } : step,
            );
      await this.savePlan({
        ...plan,
        revision: plan.revision + 1,
        steps,
        lastEventSeq: event.seq,
      });
    }
    await this.enqueueOutbox({
      type: "agent.run-event.appended.v1",
      aggregateId: runId,
      payload: {
        runId,
        seq: event.seq,
        eventType: event.type,
      },
    });
    return event;
  }

  private async planFromTodos(
    runId: string,
    todos: readonly unknown[],
  ): Promise<void> {
    const steps: ExecutionPlanStep[] = todos.flatMap((todo, index) => {
      if (typeof todo !== "object" || todo === null) return [];
      const record = todo as Record<string, unknown>;
      const title =
        typeof record.content === "string" ? record.content.trim() : "";
      if (title === "") return [];
      const status =
        record.status === "completed"
          ? "completed"
          : record.status === "in_progress"
            ? "active"
            : "pending";
      return [
        {
          id: `todo-${String(index + 1)}`,
          ordinal: index,
          title,
          status,
          evidenceRefs: [],
        } satisfies ExecutionPlanStep,
      ];
    });
    if (steps.length === 0) return;
    const current = this.tables.plans.get(runId);
    if (current === undefined) return;
    const allCompleted = steps.every((step) => step.status === "completed");
    await this.savePlan({
      ...current,
      source: "explicit",
      visibility: "structured",
      revision: current.revision + 1,
      status: allCompleted ? "completed" : "active",
      steps,
    });
  }

  preflight(input: ExecutionPreflightInput): ExecutionPreflightResult {
    const policy =
      input.policy ??
      taskExecutionPolicySchema.parse(legacyTaskExecutionPolicy());
    const at = this.now();
    const capability = capabilityFor({
      profile: input.profile,
      ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
      at,
    });
    const gaps = gapsFor({
      runtime: capability,
      ...(input.runtime === undefined ? {} : { runtimeConfig: input.runtime }),
      policy,
    });
    const envelope = buildEnvelope({
      taskId: input.taskId,
      workspaceId: input.workspaceId,
      principalId: input.principalId,
      ...(input.teammateId === undefined
        ? {}
        : { teammateId: input.teammateId }),
      profile: input.profile,
      ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
      capability,
      policy,
      policyVersion: `task-execution-v1:${sha256(stableJson(policy)).slice(0, 16)}`,
      ...(input.ticketId === undefined ? {} : { ticketId: input.ticketId }),
      at,
    });
    return {
      compatible: !gaps.some((gap) => gap.necessity === "required"),
      runtime: capability,
      envelopePreview: envelope,
      gaps,
      suggestedRuntimeIds: [],
      warnings:
        capability.gateEnforcement === "observe-only"
          ? ["该 Runtime 不能在动作执行前阻断高风险工具"]
          : [],
    };
  }

  beginRun(input: {
    readonly run: ExecutionRunLike;
    readonly profile: ExecutionProfileLike;
    readonly runtime?: ExecutionRuntimeLike | undefined;
    readonly policy?: TaskExecutionPolicy | undefined;
    readonly teammateId?: string | undefined;
  }): Promise<ExecutionProjection> {
    return this.enqueue(input.run.id, async () => {
      const existing = this.projection(input.run.id);
      if (existing !== undefined) return existing;
      const policy =
        input.policy ??
        taskExecutionPolicySchema.parse(legacyTaskExecutionPolicy());
      const at = this.now();
      const capability = capabilityFor({
        profile: input.profile,
        ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
        at,
      });
      const envelope = buildEnvelope({
        taskId: taskIdForRun(input.run),
        workspaceId: input.run.workspaceId,
        principalId:
          input.run.principalId ??
          input.run.payload.context.principalId?.toString() ??
          input.run.agentProfileId,
        ...(input.teammateId === undefined
          ? {}
          : { teammateId: input.teammateId }),
        ...(input.run.payload.context.taskReceiverId === undefined
          ? {}
          : { teammateId: String(input.run.payload.context.taskReceiverId) }),
        profile: input.profile,
        ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
        capability,
        policy,
        policyVersion: `task-execution-v1:${sha256(stableJson(policy)).slice(0, 16)}`,
        ...(input.run.ticketId === undefined
          ? {}
          : { ticketId: input.run.ticketId }),
        runId: input.run.id,
        at,
      });
      await this.tables.capabilities.put(
        `${capability.runtimeId}:${capability.runtimeRevision}`,
        capability,
      );
      await this.tables.envelopes.put(envelope.id, envelope);
      const visibility = envelope.resolved.planVisibility;
      const plan = agentExecutionPlanSchema.parse({
        schemaVersion: 1,
        id: `plan-${randomUUID()}`,
        runId: input.run.id,
        workspaceId: input.run.workspaceId,
        source: visibility === "opaque" ? "unavailable" : "derived",
        visibility,
        revision: 1,
        status: input.run.status === "queued" ? "pending" : "active",
        summary: "Agent 正在执行",
        steps: [
          {
            id: "execute",
            ordinal: 0,
            title: "执行",
            status: input.run.status === "queued" ? "pending" : "active",
            evidenceRefs: [],
          },
        ],
        subagents: [],
        lastEventSeq: 0,
        createdAt: at,
        updatedAt: at,
      });
      await this.tables.plans.put(plan.runId, plan);
      const snapshot = runExecutionSnapshotSchema.parse({
        schemaVersion: 1,
        runId: input.run.id,
        taskId: envelope.taskId,
        provider: envelope.launch.provider,
        model: envelope.launch.model ?? "unknown",
        ...(envelope.launch.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: envelope.launch.reasoningEffort }),
        runtimeId: capability.runtimeId,
        runtimeName:
          input.runtime?.name ?? `DSH built-in · ${input.profile.name}`,
        runtimeVersion: "unknown",
        adapterId: capability.adapterId,
        authMode: envelope.launch.authMode,
        sandbox: envelope.resolved.sandbox,
        networkAccess: envelope.resolved.networkAccess,
        gateEnforcement: envelope.resolved.gateEnforcement,
        searchEnabled: envelope.resolved.searchEnabled,
        searchUsed: null,
        planVisibility: envelope.resolved.planVisibility,
        toolEventCompleteness:
          capability.capabilities.structuredToolEvents === "supported"
            ? "complete"
            : capability.capabilities.structuredToolEvents === "unknown"
              ? "partial"
              : "none",
        allowedToolCategories: envelope.resolved.allowedToolCategories,
        usedTools: [],
        ...(input.run.ticketId === undefined
          ? {}
          : { ticketId: input.run.ticketId }),
        ...(input.run.contextPackId === undefined
          ? {}
          : { contextPackId: input.run.contextPackId }),
        envelopeId: envelope.id,
        policyVersion: envelope.policyVersion,
        unknownFields: [
          "runtimeVersion",
          ...(capability.capabilities.search === "unknown" ? ["search"] : []),
        ],
        capturedAt: at,
      });
      await this.tables.snapshots.put(snapshot.runId, snapshot);
      if (input.run.sessionId !== undefined) {
        this.bindSession(input.run.id, input.run.sessionId);
      }
      await this.appendEvent(input.run.id, {
        type: "plan.snapshot",
        source: "derived",
        sourceEventId: "begin",
        summary: "已创建 Agent Execution Plan",
        data: { planId: plan.id, visibility },
      });
      await this.enqueueOutbox({
        type: "agent.execution-plan.changed.v1",
        aggregateId: input.run.id,
        payload: { runId: input.run.id, revision: plan.revision },
      });
      return this.projection(input.run.id)!;
    });
  }

  bindSession(runId: string, sessionId: string): void {
    this.runIdBySession.set(sessionId, runId);
  }

  runIdForSession(sessionId: string): string | undefined {
    return this.runIdBySession.get(sessionId);
  }

  envelopeForRun(runId: string): ExecutionEnvelope | undefined {
    const snapshot = this.tables.snapshots.get(runId);
    return snapshot === undefined
      ? undefined
      : this.tables.envelopes.get(snapshot.envelopeId);
  }

  gateDisposition(
    runId: string,
    category: ToolCategory,
  ): "allow" | "approval" | "deny" {
    const envelope = this.envelopeForRun(runId);
    if (envelope === undefined) return "allow";
    if (envelope.resolved.deniedToolCategories.includes(category)) {
      return "deny";
    }
    if (envelope.resolved.approvalToolCategories.includes(category)) {
      return "approval";
    }
    return "allow";
  }

  recordTrace(runId: string, trace: RuntimeTraceLike): Promise<void> {
    return this.enqueue(runId, async () => {
      const sequence = (this.traceSeqByRun.get(runId) ?? 0) + 1;
      this.traceSeqByRun.set(runId, sequence);
      const data = trace.data?.trim() ?? "";
      if (trace.kind === "tool_call") {
        const [name = "unknown"] = data.split(/\s+/, 1);
        await this.appendEvent(runId, {
          type: "tool.call",
          source: "external-trace",
          sourceEventId: `trace:${String(sequence)}`,
          visibility: "public",
          summary: `调用工具：${name}`,
          data: {
            toolName: name,
            toolCategory: toolCategory(name),
            arguments: data.slice(name.length).trim(),
          },
        });
        return;
      }
      if (trace.kind === "tool_result") {
        await this.appendEvent(runId, {
          type: "tool.result",
          source: "external-trace",
          sourceEventId: `trace:${String(sequence)}`,
          visibility: "public",
          summary: data.slice(0, 2_000) || "工具执行完成",
        });
        return;
      }
      if (trace.kind === "error") {
        await this.appendEvent(runId, {
          type: "error",
          source: "external-trace",
          sourceEventId: `trace:${String(sequence)}`,
          visibility: "public",
          summary: (data || trace.message || "Runtime error").slice(0, 4_000),
        });
        return;
      }
      if (trace.kind === "thinking") {
        await this.appendEvent(runId, {
          type: "progress.summary",
          source: "external-trace",
          sourceEventId: `trace:${String(sequence)}`,
          visibility: "restricted",
          summary: "Runtime 报告了新的推理阶段",
        });
        return;
      }
      if (
        trace.kind === "assistant" ||
        trace.kind === "result" ||
        trace.kind === "session" ||
        trace.kind === "retry" ||
        trace.kind === "spawn"
      ) {
        await this.appendEvent(runId, {
          type: trace.kind === "retry" ? "warning" : "progress.summary",
          source: "external-trace",
          sourceEventId: `trace:${String(sequence)}`,
          visibility: "public",
          summary: data.slice(0, 4_000) || `Runtime ${trace.kind}`,
        });
      }
    });
  }

  recordSessionEvents(
    runId: string,
    events: readonly SessionEventLike[],
    startIndex = 0,
  ): Promise<void> {
    return this.enqueue(runId, async () => {
      for (let index = startIndex; index < events.length; index += 1) {
        const raw = events[index];
        if (raw === undefined) continue;
        const mapped = eventSummary(raw);
        if (mapped === undefined) continue;
        const sourceEventId = `session:${String(index)}:${raw.type}`;
        if (
          mapped.type === "plan.snapshot" &&
          Array.isArray(mapped.data?.todos)
        ) {
          await this.planFromTodos(runId, mapped.data.todos as unknown[]);
        }
        await this.appendEvent(runId, {
          type: mapped.type,
          source: "builtin-session",
          sourceEventId,
          visibility: "public",
          summary: mapped.summary,
          ...(mapped.data === undefined ? {} : { data: mapped.data }),
        });
      }
    });
  }

  finalizeRun(run: ExecutionRunLike): Promise<ExecutionProjection> {
    return this.enqueue(run.id, async () => {
      const current = this.projection(run.id);
      if (current === undefined) {
        throw new Error(`execution projection not found: ${run.id}`);
      }
      if (current.snapshot.finalizedAt !== undefined) {
        return current;
      }
      const at = this.now();
      const planStatus =
        run.status === "succeeded"
          ? "completed"
          : run.status === "cancelled"
            ? "cancelled"
            : "failed";
      const stepStatus = run.status === "succeeded" ? "completed" : "failed";
      const planSummary =
        current.plan.source === "explicit"
          ? current.plan.summary
          : planStatus === "completed"
            ? "执行已完成；以下为根据运行事件整理的执行记录。"
            : planStatus === "cancelled"
              ? "执行已取消；以下为取消前观察到的事件。"
              : "执行未完成；请结合事件和错误诊断排查。";
      const plan = await this.savePlan({
        ...current.plan,
        revision: current.plan.revision + 1,
        status: planStatus,
        steps: current.plan.steps.map((step, index) =>
          index === 0
            ? {
                ...step,
                status: stepStatus,
                ...(step.startedAt === undefined
                  ? {}
                  : { startedAt: step.startedAt }),
                endedAt: at,
              }
            : step,
        ),
        ...(planSummary === undefined ? {} : { summary: planSummary }),
      });
      const searchUsed =
        current.snapshot.searchUsed === true
          ? true
          : current.snapshot.toolEventCompleteness === "complete"
            ? false
            : null;
      const snapshot = await this.saveSnapshot({
        ...current.snapshot,
        provider: run.execution?.provider ?? current.snapshot.provider,
        model: run.execution?.model ?? current.snapshot.model,
        ...(run.execution?.reasoningEffort === undefined
          ? current.snapshot.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: current.snapshot.reasoningEffort }
          : { reasoningEffort: run.execution.reasoningEffort }),
        runtimeName: run.execution?.runtime ?? current.snapshot.runtimeName,
        runtimeVersion:
          run.execution?.runtimeVersion ?? current.snapshot.runtimeVersion,
        authMode: run.execution?.authMode ?? current.snapshot.authMode,
        sandbox: run.execution?.sandbox ?? current.snapshot.sandbox,
        searchUsed,
        finalizedAt: at,
      });
      await this.enqueueOutbox({
        type: "agent.run-snapshot.finalized.v1",
        aggregateId: run.id,
        payload: {
          runId: run.id,
          status: run.status,
          planVisibility: plan.visibility,
          searchEnabled: snapshot.searchEnabled,
          searchUsed: snapshot.searchUsed,
        },
      });
      return {
        ...current,
        plan,
        snapshot,
      };
    });
  }

  projection(runId: string): ExecutionProjection | undefined {
    const plan = this.tables.plans.get(runId);
    const snapshot = this.tables.snapshots.get(runId);
    if (plan === undefined || snapshot === undefined) return undefined;
    return {
      runId,
      plan,
      snapshot,
      events: this.events(runId),
      gates: this.gates(runId),
    };
  }

  listEvents(runId: string, afterSeq = 0, limit = 500): readonly RunEvent[] {
    return this.events(runId)
      .filter((event) => event.seq > afterSeq)
      .slice(0, Math.max(1, Math.min(limit, 1_000)));
  }

  listGates(runId: string): readonly ExecutionGate[] {
    return this.gates(runId);
  }

  gate(gateId: string): ExecutionGate | undefined {
    return this.tables.gates.get(gateId);
  }

  async requestGate(
    input: RequestExecutionGateInput,
  ): Promise<ExecutionGateDecision> {
    const projection = this.projection(input.runId);
    if (projection === undefined) return "denied";
    const envelope = this.tables.envelopes.get(projection.snapshot.envelopeId);
    if (envelope === undefined) return "denied";
    const at = this.now();
    const timeoutMs = Math.max(1, input.timeoutMs ?? 300_000);
    const expiresAt = new Date(
      (this.options.now?.().getTime() ?? Date.now()) + timeoutMs,
    ).toISOString();
    const gate = executionGateSchema.parse({
      schemaVersion: 1,
      id: `gate-${randomUUID()}`,
      runId: input.runId,
      taskId: projection.snapshot.taskId,
      workspaceId: envelope.workspaceId,
      kind: input.kind,
      status: "pending",
      reason: input.reason,
      ...(input.requestedToolCategory === undefined
        ? {}
        : { requestedToolCategory: input.requestedToolCategory }),
      requestedScope: [...(input.requestedScope ?? [])],
      enforcement: envelope.resolved.gateEnforcement,
      requestedAt: at,
      expiresAt,
    });
    await this.enqueue(input.runId, async () => {
      await this.tables.gates.put(gate.id, gate);
      await this.appendEvent(input.runId, {
        type: "gate.requested",
        source: "derived",
        sourceEventId: gate.id,
        summary: gate.reason,
        data: {
          gateId: gate.id,
          requestedToolCategory: input.requestedToolCategory,
        },
      });
      await this.enqueueOutbox({
        type: "agent.execution-gate.requested.v1",
        aggregateId: input.runId,
        payload: { runId: input.runId, gateId: gate.id },
      });
    });
    const decision = await new Promise<ExecutionGateDecision>((resolve) => {
      let settled = false;
      const finish = (value: ExecutionGateDecision): void => {
        if (settled) return;
        settled = true;
        this.pendingGates.delete(gate.id);
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const timer = setTimeout(() => {
        void this.expireGate(gate.id);
        finish("expired");
      }, timeoutMs);
      timer.unref?.();
      const onAbort = (): void => {
        void this.cancelGate(gate.id);
        finish("expired");
      };
      if (input.signal?.aborted) {
        onAbort();
        return;
      }
      input.signal?.addEventListener("abort", onAbort, { once: true });
      this.pendingGates.set(gate.id, finish);
    });
    return decision;
  }

  async decideGate(input: {
    readonly gateId: string;
    readonly decision: "approved" | "denied";
    readonly actorPrincipalId: string;
    readonly note?: string | undefined;
  }): Promise<ExecutionGate> {
    const gate = this.tables.gates.get(input.gateId);
    if (gate === undefined) throw new Error("execution gate not found");
    return this.enqueue(gate.runId, async () => {
      const current = this.tables.gates.get(input.gateId);
      if (current === undefined) throw new Error("execution gate not found");
      if (current.status !== "pending") {
        if (
          (input.decision === "approved" && current.status === "approved") ||
          (input.decision === "denied" && current.status === "denied")
        ) {
          return current;
        }
        throw new Error("execution gate already decided");
      }
      const decided = executionGateSchema.parse({
        ...current,
        status: input.decision,
        decidedByPrincipalId: input.actorPrincipalId,
        ...(input.note === undefined ? {} : { decisionNote: input.note }),
        decidedAt: this.now(),
      });
      await this.tables.gates.put(decided.id, decided);
      await this.appendEvent(decided.runId, {
        type: "gate.decided",
        source: "derived",
        sourceEventId: `${decided.id}:decision`,
        summary:
          input.decision === "approved" ? "执行授权已通过" : "执行授权已拒绝",
        data: { gateId: decided.id, decision: input.decision },
      });
      await this.enqueueOutbox({
        type: "agent.execution-gate.decided.v1",
        aggregateId: decided.runId,
        payload: {
          runId: decided.runId,
          gateId: decided.id,
          decision: input.decision,
        },
      });
      this.pendingGates.get(decided.id)?.(input.decision);
      return decided;
    });
  }

  private async expireGate(gateId: string): Promise<void> {
    const gate = this.tables.gates.get(gateId);
    if (gate?.status !== "pending") return;
    const next = executionGateSchema.parse({
      ...gate,
      status: "expired",
      decidedAt: this.now(),
    });
    await this.tables.gates.put(next.id, next);
  }

  private async cancelGate(gateId: string): Promise<void> {
    const gate = this.tables.gates.get(gateId);
    if (gate?.status !== "pending") return;
    const next = executionGateSchema.parse({
      ...gate,
      status: "cancelled",
      decidedAt: this.now(),
    });
    await this.tables.gates.put(next.id, next);
  }
}
