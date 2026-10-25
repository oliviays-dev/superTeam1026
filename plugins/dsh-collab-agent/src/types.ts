import { z } from "zod";

export const idPattern = /^[a-zA-Z][a-zA-Z0-9._-]*$/;

export const agentModelSelectionSchema = z.object({
  provider: z.string().trim().min(1).max(80),
  model: z.string().trim().min(1).max(160),
  reasoningEffort: z.string().trim().max(40).optional(),
});

export const agentProfileSchema = z.object({
  id: z.string().trim().regex(idPattern),
  workspaceId: z.string().min(1).max(160),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1_000).default(""),
  personaId: z.string().trim().regex(idPattern).optional(),
  execution: z.enum(["builtin", "external"]).optional(),
  externalRuntimeId: z.string().trim().regex(idPattern).optional(),
  runtimeKind: z.enum(["task-worker", "continuable-session", "connector"]),
  defaultModel: agentModelSelectionSchema.optional(),
  allowedTools: z.array(z.string().trim().min(1).max(120)).max(50).default([]),
  ownerUserId: z.string().min(1).max(160),
  visibility: z.enum(["workspace", "platform"]).optional(),
  status: z.enum(["active", "disabled"]).default("active"),
  createdAt: z.string().datetime({ precision: 3 }),
  updatedAt: z.string().datetime({ precision: 3 }),
});

export const agentDeliverableBriefSchema = z.object({
  key: z.string().regex(idPattern),
  title: z.string().min(1).max(160),
  type: z.enum(["file", "text", "link"]),
  required: z.boolean(),
  description: z.string().max(1_000).default(""),
  minTextLength: z.number().int().min(1).max(20_000).optional(),
});

export const agentExecutionMetadataSchema = z.object({
  provider: z.string().trim().min(1).max(120).default("unknown"),
  model: z.string().trim().min(1).max(160).default("unknown"),
  reasoningEffort: z.string().trim().min(1).max(40).optional(),
  runtime: z.string().trim().min(1).max(200).default("unknown"),
  runtimeVersion: z.string().trim().min(1).max(120).default("unknown"),
  authMode: z.string().trim().min(1).max(120).default("unknown"),
  sandbox: z.string().trim().min(1).max(240).default("unknown"),
  searchEnabled: z.boolean().nullable().optional(),
  networkAccess: z.enum(["none", "restricted", "public", "unknown"]).optional(),
  searchUsed: z.boolean().nullable().optional(),
  planVisibility: z.enum(["structured", "summary", "opaque"]).optional(),
});

export const agentRunPayloadSchema = z.object({
  instanceTitle: z.string().min(1).max(160),
  nodeName: z.string().min(1).max(160),
  nodeDescription: z.string().max(2_000).default(""),
  profileName: z.string().min(1).max(120),
  previousFailure: z.string().max(2_000).optional(),
  responsibleId: z.string().max(160).optional(),
  deliverables: z.array(agentDeliverableBriefSchema).max(20).default([]),
  context: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .default({}),
});

export const agentRunStatusSchema = z.enum([
  "queued",
  "running",
  "waiting_input",
  "succeeded",
  "failed",
  "timeout",
  "cancelled",
  "interrupted",
]);

export const agentRunSchema = z.object({
  id: z.string().min(1).max(180),
  workspaceId: z.string().min(1).max(160),
  workspacePath: z.string().max(500).optional(),
  agentProfileId: z.string().regex(idPattern),
  personaId: z.string().regex(idPattern).optional(),
  employeeId: z.string().regex(idPattern).optional(),
  principalId: z.string().min(1).max(180).optional(),
  principalType: z
    .enum(["transitional-agent", "digital-employee", "principal-runtime"])
    .optional(),
  ticketId: z.string().regex(idPattern).optional(),
  source: z.enum(["workflow", "task", "meeting", "chat"]),
  instanceId: z.string().min(1).max(160),
  nodeId: z.string().regex(idPattern),
  dispatchKey: z.string().min(1).max(400),
  trigger: z.enum(["manual-dispatch", "auto-on-ready"]),
  status: agentRunStatusSchema,
  attempt: z.number().int().positive(),
  runSeq: z.number().int().positive(),
  maxAttempts: z.number().int().min(1).max(5),
  timeoutMs: z.number().int().min(1_000).max(3_600_000),
  payload: agentRunPayloadSchema,
  promptSnapshot: z.string().max(60_000).optional(),
  sessionId: z.string().min(1).max(200).optional(),
  sessionBindingId: z.string().min(1).max(240).optional(),
  externalSessionId: z.string().min(1).max(200).optional(),
  contextPackId: z.string().min(1).max(180).optional(),
  execution: agentExecutionMetadataSchema.optional(),
  output: z
    .object({
      summary: z.string().max(60_000),
      /** Original reply retained when the output contract triggered repair. */
      rawOutput: z.string().max(60_000).optional(),
      repairAttempt: z.number().int().positive().optional(),
      rawTranscriptRef: z.string().max(400).optional(),
      endedAt: z.string().datetime({ precision: 3 }).optional(),
      stopReason: z.string().max(120).optional(),
    })
    .optional(),
  /** Provider-reported completion tokens for this run. Input tokens are excluded. */
  outputTokens: z.number().int().nonnegative().optional(),
  error: z.string().max(1_000).optional(),
  startedAt: z.string().datetime({ precision: 3 }).optional(),
  endedAt: z.string().datetime({ precision: 3 }).optional(),
  createdBy: z.string().min(1).max(160),
  createdAt: z.string().datetime({ precision: 3 }),
  updatedAt: z.string().datetime({ precision: 3 }),
  settleDelivered: z.boolean().default(false),
});

export type AgentModelSelection = z.infer<typeof agentModelSelectionSchema>;
export type AgentProfile = z.infer<typeof agentProfileSchema>;

export const EXTERNAL_AGENT_PROVIDERS = [
  "codex",
  "workbuddy",
  "command",
] as const;
export const EXTERNAL_AGENT_PROTOCOLS = ["codex-jsonl", "plain-text"] as const;
export const RUNTIME_TOOL_NAMES = [
  "web_search",
  "web_fetch",
  "read_file",
  "write_file",
  "run_command",
  "browser",
  "mcp",
] as const;
export const REASONING_EFFORT_LEVELS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export const runtimeToolNameSchema = z.enum(RUNTIME_TOOL_NAMES);
export const reasoningEffortSchema = z.enum(REASONING_EFFORT_LEVELS);

const commandSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine((value) => value !== "/" && !value.includes("\0"), {
    message: "command is invalid",
  });

export const externalAgentRuntimeSchema = z
  .object({
    id: z.string().trim().regex(idPattern),
    workspaceId: z.string().min(1).max(160).optional(),
    name: z.string().trim().min(1).max(120),
    provider: z.enum(EXTERNAL_AGENT_PROVIDERS),
    protocol: z.enum(EXTERNAL_AGENT_PROTOCOLS),
    command: commandSchema,
    args: z.array(z.string().min(1).max(1_000)).max(50).default([]),
    /** 用户在高级配置中显式添加的额外 argv，和平台托管参数分开保存。 */
    customArgs: z.array(z.string().min(1).max(1_000)).max(50).optional(),
    /**
     * 用户声明的 Runtime 技术能力上限。空数组表示存量 Runtime 尚未声明，
     * 执行层会按 Provider/协议使用兼容推导，而不是直接视为不支持。
     */
    supportedTools: z
      .array(runtimeToolNameSchema)
      .max(RUNTIME_TOOL_NAMES.length)
      .refine((items) => new Set(items).size === items.length, {
        message: "supportedTools must not contain duplicates",
      })
      .optional(),
    /** Runtime 可接受的模型集合；任务级只能从这里选择覆盖值。 */
    supportedModels: z
      .array(z.string().trim().min(1).max(160))
      .max(50)
      .refine((items) => new Set(items).size === items.length, {
        message: "supportedModels must not contain duplicates",
      })
      .optional(),
    /** Runtime 未收到任务级模型覆盖时使用的默认模型。 */
    defaultModel: z.string().trim().min(1).max(160).optional(),
    /** 上下文装配可用输入预算；不包含模型输出预留。 */
    contextWindowTokens: z.number().int().min(1_000).max(10_000_000).optional(),
    status: z.enum(["active", "disabled", "archived"]).default("active"),
    visibility: z.enum(["workspace", "platform"]).default("platform"),
    ownerUserId: z.string().min(1).max(160),
    createdAt: z.string().datetime({ precision: 3 }),
    updatedAt: z.string().datetime({ precision: 3 }),
    lastProbeAt: z.string().datetime({ precision: 3 }).optional(),
    lastProbeOk: z.boolean().optional(),
    lastProbeMessage: z.string().max(500).optional(),
  })
  .superRefine((runtime, context) => {
    if (
      runtime.defaultModel !== undefined &&
      !(runtime.supportedModels ?? []).includes(runtime.defaultModel)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["defaultModel"],
        message: "defaultModel must be included in supportedModels",
      });
    }
  });

export type ExternalAgentProvider = z.infer<
  typeof externalAgentRuntimeSchema
>["provider"];
export type ExternalAgentProtocol = z.infer<
  typeof externalAgentRuntimeSchema
>["protocol"];
export type RuntimeToolName = z.infer<typeof runtimeToolNameSchema>;
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;
export type ExternalAgentRuntime = z.infer<typeof externalAgentRuntimeSchema>;
export type AgentDeliverableBrief = z.infer<typeof agentDeliverableBriefSchema>;
export type AgentExecutionMetadata = z.infer<
  typeof agentExecutionMetadataSchema
>;
export type AgentRunPayload = z.infer<typeof agentRunPayloadSchema>;
export type AgentRunStatus = z.infer<typeof agentRunStatusSchema>;
export type AgentRun = z.infer<typeof agentRunSchema>;
