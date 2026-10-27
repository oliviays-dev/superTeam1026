import { z } from "zod";
import { agentSchema, taskPrioritySchema } from "./platform.js";
import {
  executionHistoryQuerySchema,
  runDurationBreakdownSchema,
  runtimeUsageSummarySchema,
  type RuntimeUsageSummary,
} from "./runtime-economics.js";

const idSchema = z.string().trim().min(1).max(180);
const isoTimeSchema = z.string().datetime({ offset: true });

export const teammateTemplateScopeSchema = z.enum(["platform", "personal"]);
export type TeammateTemplateScope = z.infer<typeof teammateTemplateScopeSchema>;

export const teammateTemplateStatusSchema = z.enum([
  "active",
  "disabled",
  "archived",
]);
export type TeammateTemplateStatus = z.infer<
  typeof teammateTemplateStatusSchema
>;

export const teammateStatusSchema = z.enum([
  "active",
  "paused",
  "inactive",
  "archived",
]);
export type TeammateStatus = z.infer<typeof teammateStatusSchema>;

export const teammateDefinitionSchema = z.object({
  name: z.string().trim().min(1).max(120),
  role: z.string().trim().max(120).default(""),
  description: z.string().trim().max(4_000).default(""),
  soul: z.string().max(200_000).default(""),
  scenarios: z.array(z.string().trim().min(1).max(500)).max(50).default([]),
  goals: z.array(z.string().trim().min(1).max(500)).max(50).default([]),
  tools: z.array(z.string().trim().min(1).max(200)).max(100).default([]),
});
export type TeammateDefinition = z.infer<typeof teammateDefinitionSchema>;

export const teammateTemplateSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  workspaceId: idSchema,
  scope: teammateTemplateScopeSchema,
  ownerPrincipalId: idSchema.nullable(),
  status: teammateTemplateStatusSchema,
  currentVersion: z.number().int().positive(),
  definition: teammateDefinitionSchema,
  createdBy: idSchema,
  createdAt: isoTimeSchema,
  updatedAt: isoTimeSchema,
});
export type TeammateTemplate = z.infer<typeof teammateTemplateSchema>;

export const teammateTemplateVersionSchema = z.object({
  id: z.string().uuid(),
  templateId: z.string().uuid(),
  projectId: z.string().uuid(),
  version: z.number().int().positive(),
  definition: teammateDefinitionSchema,
  contentDigest: z.string().length(64),
  createdBy: idSchema,
  createdAt: isoTimeSchema,
});
export type TeammateTemplateVersion = z.infer<
  typeof teammateTemplateVersionSchema
>;

export const createTeammateTemplateInputSchema = z.object({
  projectId: z.string().uuid(),
  scope: teammateTemplateScopeSchema.default("personal"),
  definition: teammateDefinitionSchema,
});
export type CreateTeammateTemplateInput = z.input<
  typeof createTeammateTemplateInputSchema
>;

export const updateTeammateTemplateInputSchema = z.object({
  expectedVersion: z.number().int().positive(),
  definition: teammateDefinitionSchema,
});
export type UpdateTeammateTemplateInput = z.input<
  typeof updateTeammateTemplateInputSchema
>;

export const archiveTeammateTemplateInputSchema = z.object({
  expectedVersion: z.number().int().positive(),
});
export type ArchiveTeammateTemplateInput = z.infer<
  typeof archiveTeammateTemplateInputSchema
>;

export const teammateSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  workspaceId: idSchema,
  templateId: z.string().uuid(),
  templateVersionId: z.string().uuid(),
  templateVersion: z.number().int().positive(),
  agent: agentSchema,
  aiPrincipalId: idSchema,
  ownerPrincipalId: idSchema,
  name: z.string().trim().min(1).max(120),
  status: teammateStatusSchema,
  version: z.number().int().positive(),
  autoExecute: z.boolean(),
  createdAt: isoTimeSchema,
  updatedAt: isoTimeSchema,
});
export type Teammate = z.infer<typeof teammateSchema>;

export const createTeammateInputSchema = z.object({
  projectId: z.string().uuid(),
  templateId: z.string().uuid(),
  name: z.string().trim().min(1).max(120).optional(),
  agentId: z.string().uuid(),
  autoExecute: z.boolean().default(false),
});
export type CreateTeammateInput = z.input<typeof createTeammateInputSchema>;

export const changeTeammateStatusInputSchema = z.object({
  status: z.enum(["active", "paused", "inactive", "archived"]),
  expectedVersion: z.number().int().positive(),
  reason: z.string().trim().max(4_000).default(""),
});
export type ChangeTeammateStatusInput = z.input<
  typeof changeTeammateStatusInputSchema
>;

export const transferTeammateInputSchema = z.object({
  toOwnerPrincipalId: idSchema,
  expectedVersion: z.number().int().positive(),
  reason: z.string().trim().min(1).max(4_000),
});
export type TransferTeammateInput = z.input<typeof transferTeammateInputSchema>;

export const updateTeammateAutoExecuteInputSchema = z.object({
  autoExecute: z.boolean(),
  expectedVersion: z.number().int().positive(),
});
export type UpdateTeammateAutoExecuteInput = z.input<
  typeof updateTeammateAutoExecuteInputSchema
>;

export const teammateTransferSchema = z.object({
  id: z.string().uuid(),
  teammateId: z.string().uuid(),
  fromOwnerPrincipalId: idSchema,
  toOwnerPrincipalId: idSchema,
  transferredByPrincipalId: idSchema,
  reason: z.string(),
  createdAt: isoTimeSchema,
});
export type TeammateTransfer = z.infer<typeof teammateTransferSchema>;

export const teammateEventSchema = z.object({
  id: z.string().uuid(),
  teammateId: z.string().uuid(),
  seq: z.number().int().positive(),
  kind: z.enum([
    "created",
    "template",
    "status",
    "transfer",
    "work-plan",
    "queue",
    "auto-run",
    "report",
    "archive",
  ]),
  actorPrincipalId: idSchema,
  summary: z.string(),
  data: z.record(z.string(), z.unknown()),
  createdAt: isoTimeSchema,
});
export type TeammateEvent = z.infer<typeof teammateEventSchema>;

export const parsedTeammateWorkItemSchema = z.object({
  title: z.string().trim().min(1).max(240),
  description: z.string().trim().min(1).max(20_000),
  acceptance: z.array(z.string().trim().min(1).max(1_000)).max(50),
  priority: taskPrioritySchema,
  due: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});
export type ParsedTeammateWorkItem = z.infer<
  typeof parsedTeammateWorkItemSchema
>;

export const parseTeammateWorkPlanInputSchema = z.object({
  instruction: z.string().trim().min(1).max(20_000),
});
export type ParseTeammateWorkPlanInput = z.infer<
  typeof parseTeammateWorkPlanInputSchema
>;

export const parsedTeammateWorkPlanSchema = z.object({
  instruction: z.string(),
  summary: z.string(),
  items: z.array(parsedTeammateWorkItemSchema).min(1).max(20),
  restricted: z.object({
    assignee: z.literal("teammate"),
    projectId: z.string().uuid(),
    autoAccept: z.literal(false),
    maxItems: z.literal(20),
  }),
});
export type ParsedTeammateWorkPlan = z.infer<
  typeof parsedTeammateWorkPlanSchema
>;

export const createTeammateWorkPlanInputSchema = z.object({
  instruction: z.string().trim().min(1).max(20_000),
  items: z.array(parsedTeammateWorkItemSchema).min(1).max(20),
  autoExecuteEligible: z.boolean().default(false),
});
export type CreateTeammateWorkPlanInput = z.input<
  typeof createTeammateWorkPlanInputSchema
>;

export const teammateWorkPlanSchema = z.object({
  id: z.string().uuid(),
  teammateId: z.string().uuid(),
  projectId: z.string().uuid(),
  instruction: z.string(),
  revision: z.number().int().positive(),
  status: z.enum(["active", "archived"]),
  taskIds: z.array(z.string().uuid()),
  createdBy: idSchema,
  createdAt: isoTimeSchema,
});
export type TeammateWorkPlan = z.infer<typeof teammateWorkPlanSchema>;

export const teammateQueueBlockedReasonSchema = z.enum([
  "instance-inactive",
  "project-inactive",
  "principal-inactive",
  "grant-missing",
  "task-inactive",
  "dependency",
  "active-run",
  "active-claim",
  "auto-disabled",
  "approval-required",
]);
export type TeammateQueueBlockedReason = z.infer<
  typeof teammateQueueBlockedReasonSchema
>;

export const teammateQueueItemSchema = z.object({
  taskId: z.string().uuid(),
  queueSeq: z.number().int().positive(),
  autoEligible: z.boolean(),
  blockedReasons: z.array(teammateQueueBlockedReasonSchema),
  task: z.object({
    id: z.string().uuid(),
    projectId: z.string().uuid(),
    title: z.string(),
    description: z.string(),
    status: z.string(),
    priority: taskPrioritySchema,
    revision: z.number().int().positive(),
    dependsOn: z.array(z.string().uuid()),
    createdAt: isoTimeSchema,
    updatedAt: isoTimeSchema,
  }),
});
export type TeammateQueueItem = z.infer<typeof teammateQueueItemSchema>;

export const reorderTeammateQueueInputSchema = z.object({
  taskIds: z.array(z.string().uuid()).min(1).max(200),
});
export type ReorderTeammateQueueInput = z.infer<
  typeof reorderTeammateQueueInputSchema
>;

export const teammateRuntimeStatisticsSchema = z.object({
  teammateId: z.string().uuid(),
  from: isoTimeSchema.nullable(),
  to: isoTimeSchema.nullable(),
  generatedAt: isoTimeSchema,
  runCount: z.number().int().nonnegative(),
  usage: runtimeUsageSummarySchema,
  durations: runDurationBreakdownSchema,
  reconciliation: z.object({
    reconciled: z.number().int().nonnegative(),
    unknown: z.number().int().nonnegative(),
    incomplete: z.number().int().nonnegative(),
    inconsistent: z.number().int().nonnegative(),
  }),
  unknownSamples: z.object({
    provider: z.number().int().nonnegative(),
    model: z.number().int().nonnegative(),
    token: z.number().int().nonnegative(),
    cost: z.number().int().nonnegative(),
    duration: z.number().int().nonnegative(),
  }),
});
export type TeammateRuntimeStatistics = z.infer<
  typeof teammateRuntimeStatisticsSchema
>;

export const teammateWeeklyReportSchema = z.object({
  id: z.string().uuid(),
  teammateId: z.string().uuid(),
  projectId: z.string().uuid(),
  weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  weekEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  status: z.enum(["generated", "stale"]),
  summary: z.object({
    queued: z.number().int().nonnegative(),
    running: z.number().int().nonnegative(),
    awaitingReview: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    needsInput: z.number().int().nonnegative(),
  }),
  statistics: teammateRuntimeStatisticsSchema,
  generatedBy: idSchema,
  generatedAt: isoTimeSchema,
});
export type TeammateWeeklyReport = z.infer<typeof teammateWeeklyReportSchema>;

export const teammateExecutionHistoryQuerySchema = executionHistoryQuerySchema;
export type TeammateExecutionHistoryQuery = z.infer<
  typeof teammateExecutionHistoryQuerySchema
>;

export function addRuntimeUsageSummaries(
  left: RuntimeUsageSummary,
  right: RuntimeUsageSummary,
): RuntimeUsageSummary {
  return {
    sampleCount: left.sampleCount + right.sampleCount,
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
    costAmount: left.costAmount + right.costAmount,
    costCurrencies: [
      ...new Set([...left.costCurrencies, ...right.costCurrencies]),
    ].sort(),
    unknownFields: [
      ...new Set([...left.unknownFields, ...right.unknownFields]),
    ].sort(),
    unknownSampleCount: left.unknownSampleCount + right.unknownSampleCount,
  };
}
