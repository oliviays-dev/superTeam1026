import { z } from "zod";

export const sourceClassSchema = z.enum([
  "workspace",
  "task-attachments",
  "meeting-context",
  "project-memory",
  "enterprise-knowledge",
  "public-web",
  "regulatory-filing",
  "private-local-data",
  "connector-data",
]);
export type SourceClass = z.infer<typeof sourceClassSchema>;

export const toolCategorySchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[a-z][a-z0-9._-]*$/);
export type ToolCategory = z.infer<typeof toolCategorySchema>;

export const runtimeRequirementSchema = z.object({
  key: z.enum([
    "search",
    "network",
    "file-read",
    "file-write",
    "shell",
    "browser",
    "mcp",
    "structured-plan",
    "structured-tool-events",
    "blocking-gate",
  ]),
  necessity: z.enum(["required", "preferred"]).default("required"),
  value: z.union([z.string(), z.boolean()]).optional(),
});
export type RuntimeRequirement = z.infer<typeof runtimeRequirementSchema>;

export const reasoningEffortSchema = z.enum([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;

export const executionGateRuleSchema = z.object({
  id: z.string().trim().min(1).max(160),
  kind: z.enum([
    "preflight",
    "tool-approval",
    "data-source",
    "external-send",
    "budget",
    "runtime-switch",
  ]),
  toolCategory: toolCategorySchema.optional(),
  sourceClass: sourceClassSchema.optional(),
  reason: z.string().trim().min(1).max(1_000),
});
export type ExecutionGateRule = z.infer<typeof executionGateRuleSchema>;

export const taskExecutionPolicySchema = z.object({
  schemaVersion: z.literal(1).default(1),
  runtime: z.object({
    selection: z.enum(["user-selected", "recommended"]).default("recommended"),
    allowedRuntimeIds: z
      .array(z.string().trim().min(1).max(160))
      .max(100)
      .default([]),
    requiredCapabilities: z.array(runtimeRequirementSchema).max(50).default([]),
    /** 本轮任务要使用的模型；必须属于选中 Runtime 的模型池。 */
    model: z.string().trim().min(1).max(160).optional(),
    /** 本轮任务希望 Runtime 使用的推理强度。 */
    reasoningEffort: reasoningEffortSchema.optional(),
  }),
  sourcePolicy: z.object({
    allow: z.array(sourceClassSchema).max(100).default([]),
    deny: z.array(sourceClassSchema).max(100).default([]),
    citation: z.enum(["none", "required-for-factual-claims"]).default("none"),
    requirePublishedAt: z.boolean().default(false),
    requireAccessedAt: z.boolean().default(false),
  }),
  toolPolicy: z.object({
    allow: z.array(toolCategorySchema).max(200).default([]),
    deny: z.array(toolCategorySchema).max(200).default([]),
    requireApproval: z.array(toolCategorySchema).max(200).default([]),
  }),
  evidence: z.object({
    requirePlan: z.boolean().default(true),
    requireToolEvents: z.boolean().default(false),
    requireCitations: z.boolean().default(false),
    requireStructuredSubagents: z.boolean().default(false),
  }),
  humanGates: z.array(executionGateRuleSchema).max(100).default([]),
  budget: z.object({
    timeoutMs: z.number().int().positive().max(3_600_000).optional(),
    maxTurns: z.number().int().positive().max(1_000).optional(),
    maxToolCalls: z.number().int().positive().max(10_000).optional(),
    maxCost: z.number().nonnegative().optional(),
  }),
});
export type TaskExecutionPolicy = z.infer<typeof taskExecutionPolicySchema>;

export function legacyTaskExecutionPolicy(): TaskExecutionPolicy {
  return taskExecutionPolicySchema.parse({
    schemaVersion: 1,
    runtime: {
      selection: "recommended",
      allowedRuntimeIds: [],
      requiredCapabilities: [],
    },
    sourcePolicy: {
      allow: ["workspace", "task-attachments", "project-memory"],
      deny: ["private-local-data"],
      citation: "none",
      requirePublishedAt: false,
      requireAccessedAt: false,
    },
    toolPolicy: {
      allow: [],
      deny: [],
      requireApproval: [],
    },
    evidence: {
      requirePlan: true,
      requireToolEvents: false,
      requireCitations: false,
      requireStructuredSubagents: false,
    },
    humanGates: [],
    budget: {},
  });
}

export const taskExecutionPolicyContextTypeSchema = z.enum([
  "project",
  "task",
  "meeting",
  "direct-chat",
]);
export type TaskExecutionPolicyContextType = z.infer<
  typeof taskExecutionPolicyContextTypeSchema
>;

export const taskExecutionPolicyRecordSchema = z.object({
  id: z.string().uuid(),
  contextType: taskExecutionPolicyContextTypeSchema,
  contextId: z.string().trim().min(1).max(180),
  projectId: z.string().uuid().nullable(),
  revision: z.number().int().positive(),
  policy: taskExecutionPolicySchema,
  createdBy: z.string().trim().min(1).max(180),
  createdAt: z.string().datetime({ offset: true }),
});
export type TaskExecutionPolicyRecord = z.infer<
  typeof taskExecutionPolicyRecordSchema
>;

export const updateTaskExecutionPolicyInputSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    policy: taskExecutionPolicySchema,
  })
  .strict();
export type UpdateTaskExecutionPolicyInput = z.infer<
  typeof updateTaskExecutionPolicyInputSchema
>;

export const taskExecutionPolicySourceSchema = z.enum([
  "context",
  "project-default",
  "legacy",
]);
export type TaskExecutionPolicySource = z.infer<
  typeof taskExecutionPolicySourceSchema
>;

export const resolvedTaskExecutionPolicySchema = z.object({
  id: z.string().uuid().nullable(),
  revision: z.number().int().nonnegative(),
  version: z.string().trim().min(1).max(240),
  contextType: taskExecutionPolicyContextTypeSchema,
  contextId: z.string().trim().min(1).max(180),
  source: taskExecutionPolicySourceSchema,
  policy: taskExecutionPolicySchema,
});
export type ResolvedTaskExecutionPolicy = z.infer<
  typeof resolvedTaskExecutionPolicySchema
>;
