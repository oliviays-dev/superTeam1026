import { z } from "zod";

export const externalRuntimeProviderSchema = z.enum([
  "codex",
  "workbuddy",
  "command",
]);
export type ExternalRuntimeProvider = z.infer<
  typeof externalRuntimeProviderSchema
>;

export const externalRuntimeProtocolSchema = z.enum([
  "codex-jsonl",
  "plain-text",
]);
export type ExternalRuntimeProtocol = z.infer<
  typeof externalRuntimeProtocolSchema
>;

export const externalRuntimeStatusSchema = z.enum([
  "disabled",
  "active",
  "archived",
]);
export type ExternalRuntimeStatus = z.infer<
  typeof externalRuntimeStatusSchema
>;

export const externalRuntimeVisibilitySchema = z.enum(["platform", "owner"]);
export type ExternalRuntimeVisibility = z.infer<
  typeof externalRuntimeVisibilitySchema
>;

export const externalRuntimeNetworkModeSchema = z.enum([
  "none",
  "restricted",
  "public",
  "unknown",
]);
export type ExternalRuntimeNetworkMode = z.infer<
  typeof externalRuntimeNetworkModeSchema
>;

export const externalRuntimeSandboxModeSchema = z.enum([
  "read-only",
  "workspace-write",
  "danger-full-access",
  "custom",
  "unknown",
]);
export type ExternalRuntimeSandboxMode = z.infer<
  typeof externalRuntimeSandboxModeSchema
>;

export const runtimeToolNameSchema = z.enum([
  "web_search",
  "web_fetch",
  "read_file",
  "write_file",
  "run_command",
  "browser",
  "mcp",
  "session_resume",
  "structured_plan",
  "structured_tool_events",
  "structured_subagent",
]);
export type RuntimeToolName = z.infer<typeof runtimeToolNameSchema>;

export const externalRuntimeCapabilityNameSchema = z.enum([
  "search",
  "network",
  "fileRead",
  "fileWrite",
  "shell",
  "browser",
  "mcp",
  "sessionResume",
  "structuredPlan",
  "structuredToolEvents",
  "structuredSubagent",
]);
export type ExternalRuntimeCapabilityName = z.infer<
  typeof externalRuntimeCapabilityNameSchema
>;

export const externalRuntimeCapabilityStateSchema = z.enum([
  "supported",
  "unsupported",
  "unknown",
]);
export type ExternalRuntimeCapabilityState = z.infer<
  typeof externalRuntimeCapabilityStateSchema
>;

export const externalRuntimeCapabilitySetSchema = z.object({
  search: externalRuntimeCapabilityStateSchema,
  network: externalRuntimeCapabilityStateSchema,
  fileRead: externalRuntimeCapabilityStateSchema,
  fileWrite: externalRuntimeCapabilityStateSchema,
  shell: externalRuntimeCapabilityStateSchema,
  browser: externalRuntimeCapabilityStateSchema,
  mcp: externalRuntimeCapabilityStateSchema,
  sessionResume: externalRuntimeCapabilityStateSchema,
  structuredPlan: externalRuntimeCapabilityStateSchema,
  structuredToolEvents: externalRuntimeCapabilityStateSchema,
  structuredSubagent: externalRuntimeCapabilityStateSchema,
});
export type ExternalRuntimeCapabilitySet = z.infer<
  typeof externalRuntimeCapabilitySetSchema
>;

export const externalRuntimeCapabilityNames = [
  "search",
  "network",
  "fileRead",
  "fileWrite",
  "shell",
  "browser",
  "mcp",
  "sessionResume",
  "structuredPlan",
  "structuredToolEvents",
  "structuredSubagent",
] as const satisfies ReadonlyArray<ExternalRuntimeCapabilityName>;

export function emptyExternalRuntimeCapabilitySet(
  state: ExternalRuntimeCapabilityState,
): ExternalRuntimeCapabilitySet {
  return Object.fromEntries(
    externalRuntimeCapabilityNames.map((name) => [name, state]),
  ) as ExternalRuntimeCapabilitySet;
}

export function adapterCapabilityProfile(
  protocol: ExternalRuntimeProtocol,
): ExternalRuntimeCapabilitySet {
  if (protocol === "plain-text") {
    return {
      ...emptyExternalRuntimeCapabilitySet("unknown"),
      structuredPlan: "unsupported",
      structuredToolEvents: "unsupported",
      structuredSubagent: "unsupported",
    };
  }
  return {
    ...emptyExternalRuntimeCapabilitySet("unknown"),
    sessionResume: "supported",
    structuredPlan: "supported",
    structuredToolEvents: "supported",
  };
}

const toolCapabilityMapping: Readonly<
  Record<RuntimeToolName, ExternalRuntimeCapabilityName>
> = {
  web_search: "search",
  web_fetch: "network",
  read_file: "fileRead",
  write_file: "fileWrite",
  run_command: "shell",
  browser: "browser",
  mcp: "mcp",
  session_resume: "sessionResume",
  structured_plan: "structuredPlan",
  structured_tool_events: "structuredToolEvents",
  structured_subagent: "structuredSubagent",
};

export function declaredCapabilityProfile(
  tools: readonly RuntimeToolName[],
  networkMode: ExternalRuntimeNetworkMode,
): ExternalRuntimeCapabilitySet {
  const profile = emptyExternalRuntimeCapabilitySet("unsupported");
  profile.network =
    networkMode === "unknown"
      ? "unknown"
      : networkMode === "none"
        ? "unsupported"
        : "supported";
  for (const tool of tools) {
    profile[toolCapabilityMapping[tool]] = "supported";
  }
  return profile;
}

export function mergeCapabilityProfiles(input: {
  readonly adapter: ExternalRuntimeCapabilitySet;
  readonly declared: ExternalRuntimeCapabilitySet;
  readonly probe: ExternalRuntimeCapabilitySet;
}): ExternalRuntimeCapabilitySet {
  const effective = emptyExternalRuntimeCapabilitySet("unknown");
  for (const name of externalRuntimeCapabilityNames) {
    const adapter = input.adapter[name];
    const declared = input.declared[name];
    const probe = input.probe[name];
    if (
      adapter === "unsupported" ||
      declared === "unsupported" ||
      probe === "unsupported"
    ) {
      effective[name] = "unsupported";
    } else if (
      adapter === "supported" &&
      declared === "supported" &&
      (probe === "supported" || probe === "unknown")
    ) {
      effective[name] = "supported";
    }
  }
  return effective;
}

export function canTransitionExternalRuntimeStatus(
  from: ExternalRuntimeStatus,
  to: ExternalRuntimeStatus,
): boolean {
  if (from === to) return false;
  if (from === "archived") return to === "disabled";
  if (to === "archived") return true;
  return (
    (from === "active" && to === "disabled") ||
    (from === "disabled" && to === "active")
  );
}

// oxlint-disable-next-line no-control-regex
const blockedShellCharacters = /[\u0000\r\n;&|<>`$]/;
const shellExecutableNames = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "fish",
  "ksh",
  "csh",
  "tcsh",
  "cmd",
  "cmd.exe",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
]);

export function unsafeRuntimeTokenReason(value: string): string | null {
  if (value.trim() === "") return "must not be empty";
  if (blockedShellCharacters.test(value)) {
    return "must not contain shell control, pipe, redirect, or substitution characters";
  }
  // oxlint-disable-next-line no-control-regex
  if (/\u0000/.test(value)) return "must not contain NUL";
  // oxlint-disable-next-line no-control-regex
  if (/[\u0001-\u001f\u007f]/.test(value)) {
    return "must not contain control characters";
  }
  return null;
}

export function unsafeRuntimeCommandReason(value: string): string | null {
  const unsafe = unsafeRuntimeTokenReason(value);
  if (unsafe !== null) return unsafe;
  if (/\s/.test(value)) {
    return "must be one executable token; put arguments in argv";
  }
  if (value.startsWith("-") || value === "." || value.endsWith("/")) {
    return "must be a concrete executable name or path";
  }
  if (value.split("/").includes("..")) {
    return "must not traverse to a parent directory";
  }
  const basename = value.split(/[\\/]/).at(-1)?.toLowerCase() ?? value;
  if (shellExecutableNames.has(basename)) {
    return "shell interpreters are not allowed";
  }
  return null;
}

export const externalRuntimeCommandSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .superRefine((value, context) => {
    const reason = unsafeRuntimeCommandReason(value);
    if (reason !== null) {
      context.addIssue({ code: "custom", message: reason });
    }
  });

export const externalRuntimeArgvTokenSchema = z
  .string()
  .min(1)
  .max(1_000)
  .superRefine((value, context) => {
    const reason = unsafeRuntimeTokenReason(value);
    if (reason !== null) {
      context.addIssue({ code: "custom", message: reason });
    }
  });

export const externalRuntimeArgvSchema = z
  .array(externalRuntimeArgvTokenSchema)
  .max(100);

const runtimeModelSchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/+-]*$/);

const uniqueRuntimeModelsSchema = z
  .array(runtimeModelSchema)
  .max(100)
  .default([])
  .transform((items) => [...new Set(items)]);

const uniqueRuntimeToolsSchema = z
  .array(runtimeToolNameSchema)
  .max(100)
  .default([])
  .transform((items) => [...new Set(items)]);

function providerProtocolIssue(
  input: {
    readonly provider: ExternalRuntimeProvider;
    readonly protocol: ExternalRuntimeProtocol;
  },
  context: z.RefinementCtx,
): void {
  const allowed =
    input.provider === "codex"
      ? input.protocol === "codex-jsonl"
      : input.protocol === "plain-text";
  if (!allowed) {
    context.addIssue({
      code: "custom",
      path: ["protocol"],
      message:
        input.provider === "codex"
          ? "codex runtimes require codex-jsonl"
          : "this provider requires plain-text",
    });
  }
}

const externalRuntimeFields = {
  name: z.string().trim().min(1).max(160),
  provider: externalRuntimeProviderSchema,
  protocol: externalRuntimeProtocolSchema,
  command: externalRuntimeCommandSchema,
  managedArgs: externalRuntimeArgvSchema.default([]),
  customArgs: externalRuntimeArgvSchema.default([]),
  supportedModels: uniqueRuntimeModelsSchema,
  defaultModel: runtimeModelSchema.nullable().default(null),
  contextWindowTokens: z.number().int().positive().max(10_000_000).nullable()
    .default(null),
  supportedTools: uniqueRuntimeToolsSchema,
  networkMode: externalRuntimeNetworkModeSchema.default("unknown"),
  sandboxMode: externalRuntimeSandboxModeSchema.default("unknown"),
  visibility: externalRuntimeVisibilitySchema.default("owner"),
};

function validateRuntimeDefinition(
  input: {
    readonly provider: ExternalRuntimeProvider;
    readonly protocol: ExternalRuntimeProtocol;
    readonly supportedModels: readonly string[];
    readonly defaultModel: string | null;
  },
  context: z.RefinementCtx,
): void {
  providerProtocolIssue(input, context);
  if (
    input.defaultModel !== null &&
    !input.supportedModels.includes(input.defaultModel)
  ) {
    context.addIssue({
      code: "custom",
      path: ["defaultModel"],
      message: "defaultModel must belong to supportedModels",
    });
  }
}

export const createExternalRuntimeInputSchema = z
  .object({
    ...externalRuntimeFields,
    ownerId: z.string().trim().min(1).max(180).optional(),
  })
  .superRefine(validateRuntimeDefinition);
export type CreateExternalRuntimeInput = z.infer<
  typeof createExternalRuntimeInputSchema
>;

export const updateExternalRuntimeInputSchema = z
  .object({
    name: externalRuntimeFields.name.optional(),
    provider: externalRuntimeProviderSchema.optional(),
    protocol: externalRuntimeProtocolSchema.optional(),
    command: externalRuntimeCommandSchema.optional(),
    managedArgs: externalRuntimeArgvSchema.optional(),
    customArgs: externalRuntimeArgvSchema.optional(),
    supportedModels: uniqueRuntimeModelsSchema.optional(),
    defaultModel: runtimeModelSchema.nullable().optional(),
    contextWindowTokens: z.number().int().positive().max(10_000_000).nullable()
      .optional(),
    supportedTools: uniqueRuntimeToolsSchema.optional(),
    networkMode: externalRuntimeNetworkModeSchema.optional(),
    sandboxMode: externalRuntimeSandboxModeSchema.optional(),
    visibility: externalRuntimeVisibilitySchema.optional(),
    expectedRevision: z.number().int().positive(),
  })
  .strict();
export type UpdateExternalRuntimeInput = z.infer<
  typeof updateExternalRuntimeInputSchema
>;

export const runtimeRevisionInputSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
  })
  .strict();
export type RuntimeRevisionInput = z.infer<typeof runtimeRevisionInputSchema>;

export const externalRuntimeProbeStatusSchema = z.enum([
  "requested",
  "running",
  "passed",
  "failed",
]);
export type ExternalRuntimeProbeStatus = z.infer<
  typeof externalRuntimeProbeStatusSchema
>;

export const externalRuntimeProbeSummarySchema = z.object({
  id: z.string().uuid(),
  runtimeRevision: z.number().int().positive(),
  status: externalRuntimeProbeStatusSchema,
  ok: z.boolean().nullable(),
  message: z.string().nullable(),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  requestedAt: z.string().datetime({ offset: true }),
  startedAt: z.string().datetime({ offset: true }).nullable(),
  completedAt: z.string().datetime({ offset: true }).nullable(),
});
export type ExternalRuntimeProbeSummary = z.infer<
  typeof externalRuntimeProbeSummarySchema
>;

export const externalRuntimeSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(160),
  provider: externalRuntimeProviderSchema,
  protocol: externalRuntimeProtocolSchema,
  command: externalRuntimeCommandSchema,
  managedArgs: externalRuntimeArgvSchema,
  customArgs: externalRuntimeArgvSchema,
  supportedModels: uniqueRuntimeModelsSchema,
  defaultModel: runtimeModelSchema.nullable(),
  contextWindowTokens: z.number().int().positive().nullable(),
  supportedTools: uniqueRuntimeToolsSchema,
  networkMode: externalRuntimeNetworkModeSchema,
  sandboxMode: externalRuntimeSandboxModeSchema,
  status: externalRuntimeStatusSchema,
  visibility: externalRuntimeVisibilitySchema,
  ownerId: z.string().min(1).max(180),
  revision: z.number().int().positive(),
  commandDigest: z.string().length(64),
  argsDigest: z.string().length(64),
  lastProbe: externalRuntimeProbeSummarySchema.nullable(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  archivedAt: z.string().datetime({ offset: true }).nullable(),
});
export type ExternalRuntime = z.infer<typeof externalRuntimeSchema>;

export const externalRuntimeProbeSchema = z.object({
  id: z.string().uuid(),
  runtimeId: z.string().uuid(),
  runtimeRevision: z.number().int().positive(),
  requestedBy: z.string().min(1).max(180),
  status: externalRuntimeProbeStatusSchema,
  commandDigest: z.string().length(64),
  argsDigest: z.string().length(64),
  requestedAt: z.string().datetime({ offset: true }),
  startedAt: z.string().datetime({ offset: true }).nullable(),
  completedAt: z.string().datetime({ offset: true }).nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  runtimeVersion: z.string().max(240).nullable(),
  stdoutExcerpt: z.string().max(2_000).nullable(),
  stderrExcerpt: z.string().max(2_000).nullable(),
  errorCode: z.string().max(160).nullable(),
  errorMessage: z.string().max(2_000).nullable(),
});
export type ExternalRuntimeProbe = z.infer<
  typeof externalRuntimeProbeSchema
>;

export const externalRuntimeCapabilitySnapshotSchema = z.object({
  id: z.string().uuid(),
  runtimeId: z.string().uuid(),
  runtimeRevision: z.number().int().positive(),
  probeId: z.string().uuid(),
  adapterProfile: externalRuntimeCapabilitySetSchema,
  declaredProfile: externalRuntimeCapabilitySetSchema,
  probeProfile: externalRuntimeCapabilitySetSchema,
  effectiveProfile: externalRuntimeCapabilitySetSchema,
  capturedAt: z.string().datetime({ offset: true }),
});
export type ExternalRuntimeCapabilitySnapshot = z.infer<
  typeof externalRuntimeCapabilitySnapshotSchema
>;

export const externalRuntimeEventKindSchema = z.enum([
  "registered",
  "updated",
  "probed",
  "enabled",
  "disabled",
  "archived",
  "restored",
]);
export type ExternalRuntimeEventKind = z.infer<
  typeof externalRuntimeEventKindSchema
>;

export const externalRuntimeEventSchema = z.object({
  id: z.string().uuid(),
  runtimeId: z.string().uuid(),
  kind: externalRuntimeEventKindSchema,
  actorId: z.string().min(1).max(180),
  previousStatus: externalRuntimeStatusSchema.nullable(),
  nextStatus: externalRuntimeStatusSchema,
  changedFields: z.array(z.string().min(1).max(160)).max(100),
  previousState: z.record(z.string(), z.unknown()).nullable(),
  nextState: z.record(z.string(), z.unknown()),
  message: z.string().min(1).max(4_000),
  createdAt: z.string().datetime({ offset: true }),
});
export type ExternalRuntimeEvent = z.infer<typeof externalRuntimeEventSchema>;

export const externalRuntimeDetailSchema = z.object({
  runtime: externalRuntimeSchema,
  latestProbe: externalRuntimeProbeSchema.nullable(),
});
export type ExternalRuntimeDetail = z.infer<
  typeof externalRuntimeDetailSchema
>;

export const externalRuntimeProbeRequestResultSchema = z.object({
  runtime: externalRuntimeSchema,
  probe: externalRuntimeProbeSchema,
  jobId: z.string().uuid(),
});
export type ExternalRuntimeProbeRequestResult = z.infer<
  typeof externalRuntimeProbeRequestResultSchema
>;
