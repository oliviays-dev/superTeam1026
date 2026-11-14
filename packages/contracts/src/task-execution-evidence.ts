import { z } from "zod";

export const taskEvidenceReviewModeSchema = z.enum([
  "off",
  "observe",
  "enforce",
]);
export type TaskEvidenceReviewMode = z.infer<
  typeof taskEvidenceReviewModeSchema
>;

export const taskAnomalyModeSchema = z.enum(["off", "observe", "enforce"]);
export type TaskAnomalyMode = z.infer<typeof taskAnomalyModeSchema>;

export const taskExecutionHealthSchema = z.enum([
  "healthy",
  "attention",
  "anomaly",
]);
export type TaskExecutionHealth = z.infer<typeof taskExecutionHealthSchema>;

export const taskExecutionAnomalyCodeSchema = z.enum([
  "run_failed",
  "run_timeout",
  "run_interrupted",
  "tool_failed",
  "plan_failed",
  "dependency_unmet",
  "runtime_unavailable",
  "missing_acceptance",
  "missing_execution_evidence",
]);
export type TaskExecutionAnomalyCode = z.infer<
  typeof taskExecutionAnomalyCodeSchema
>;

export const taskExecutionAnomalyStatusSchema = z.enum(["active", "cleared"]);
export type TaskExecutionAnomalyStatus = z.infer<
  typeof taskExecutionAnomalyStatusSchema
>;

export const taskExecutionAnomalySchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  code: taskExecutionAnomalyCodeSchema,
  message: z.string().trim().min(1).max(4_000),
  runId: z.string().uuid().nullable(),
  runAttempt: z.number().int().positive().nullable(),
  eventId: z.string().uuid().nullable(),
  status: taskExecutionAnomalyStatusSchema,
  occurrence: z.number().int().positive(),
  detectedAt: z.string().datetime({ offset: true }),
  clearedAt: z.string().datetime({ offset: true }).nullable(),
  clearedReason: z.string().max(4_000).nullable(),
  revision: z.number().int().positive(),
});
export type TaskExecutionAnomaly = z.infer<
  typeof taskExecutionAnomalySchema
>;

export const acceptanceEvidenceKindSchema = z.enum([
  "artifact",
  "tool-event",
  "run-output",
  "external-resource",
]);
export type AcceptanceEvidenceKind = z.infer<
  typeof acceptanceEvidenceKindSchema
>;

export const acceptanceEvidenceRefSchema = z.object({
  kind: acceptanceEvidenceKindSchema,
  refId: z.string().trim().min(1).max(240),
  version: z.string().trim().min(1).max(240).optional(),
  digest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export type AcceptanceEvidenceRef = z.infer<
  typeof acceptanceEvidenceRefSchema
>;

export const taskAcceptanceItemSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  position: z.number().int().nonnegative(),
  requirement: z.string().trim().min(1).max(1_000),
  required: z.boolean(),
  revision: z.number().int().positive(),
  contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
  deprecatedAt: z.string().datetime({ offset: true }).nullable(),
});
export type TaskAcceptanceItem = z.infer<typeof taskAcceptanceItemSchema>;

export const taskAcceptanceConfirmationSchema = z.object({
  id: z.string().uuid(),
  acceptanceItemId: z.string().uuid(),
  acceptanceItemRevision: z.number().int().positive(),
  taskId: z.string().uuid(),
  runId: z.string().uuid(),
  runAttempt: z.number().int().positive(),
  confirmedByPrincipalId: z.string().trim().min(1).max(180),
  confirmationTool: z.literal("task_submit_deliverable"),
  evidenceRefs: z.array(acceptanceEvidenceRefSchema).min(1).max(100),
  confirmedAt: z.string().datetime({ offset: true }),
  supersededAt: z.string().datetime({ offset: true }).nullable(),
  supersededReason: z.string().max(2_000).nullable(),
});
export type TaskAcceptanceConfirmation = z.infer<
  typeof taskAcceptanceConfirmationSchema
>;

export const confirmAcceptanceItemInputSchema = z.object({
  acceptanceItemId: z.string().uuid(),
  acceptanceItemRevision: z.number().int().positive(),
  evidenceRefs: z.array(acceptanceEvidenceRefSchema).min(1).max(100),
});
export type ConfirmAcceptanceItemInput = z.infer<
  typeof confirmAcceptanceItemInputSchema
>;

export const submitTaskAcceptanceEvidenceInputSchema = z.object({
  runId: z.string().uuid(),
  items: z.array(confirmAcceptanceItemInputSchema).min(1).max(50),
});
export type SubmitTaskAcceptanceEvidenceInput = z.infer<
  typeof submitTaskAcceptanceEvidenceInputSchema
>;

export const taskAcceptanceEvidenceProjectionSchema = z.object({
  taskId: z.string().uuid(),
  mode: taskEvidenceReviewModeSchema,
  items: z.array(
    taskAcceptanceItemSchema.extend({
      currentConfirmation: taskAcceptanceConfirmationSchema.nullable(),
    }),
  ),
  allRequiredConfirmed: z.boolean(),
  currentOwnerRunId: z.string().uuid().nullable(),
});
export type TaskAcceptanceEvidenceProjection = z.infer<
  typeof taskAcceptanceEvidenceProjectionSchema
>;

export const taskExecutionHealthProjectionSchema = z.object({
  taskId: z.string().uuid(),
  health: taskExecutionHealthSchema,
  activeAnomalies: z.array(taskExecutionAnomalySchema),
  requiredAcceptanceTotal: z.number().int().nonnegative(),
  requiredAcceptanceConfirmed: z.number().int().nonnegative(),
  missingAcceptanceCount: z.number().int().nonnegative(),
  mode: z.object({
    evidenceReview: taskEvidenceReviewModeSchema,
    anomaly: taskAnomalyModeSchema,
  }),
});
export type TaskExecutionHealthProjection = z.infer<
  typeof taskExecutionHealthProjectionSchema
>;

export const taskFeatureFlagModeSchema = z.enum([
  "off",
  "observe",
  "enforce",
  "on",
]);
export type TaskFeatureFlagMode = z.infer<typeof taskFeatureFlagModeSchema>;

export const taskFeatureFlagSettingSchema = z.object({
  flagKey: z.string().trim().min(1).max(160),
  scopeType: z.enum(["platform", "project"]),
  scopeId: z.string().trim().min(1).max(180),
  mode: taskFeatureFlagModeSchema,
  revision: z.number().int().positive(),
  updatedBy: z.string().trim().min(1).max(180),
  updatedAt: z.string().datetime({ offset: true }),
});
export type TaskFeatureFlagSetting = z.infer<
  typeof taskFeatureFlagSettingSchema
>;
