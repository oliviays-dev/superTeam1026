import { z } from "zod";
import { runStatusSchema } from "./platform.js";

export const runtimeContextTypeSchema = z.enum([
  "task",
  "workflow-task",
  "meeting",
  "direct-chat",
]);
export type RuntimeContextType = z.infer<typeof runtimeContextTypeSchema>;

export const runtimeUsageSourceSchema = z.enum([
  "runtime-reported",
  "derived",
  "unavailable",
  "mixed",
]);
export type RuntimeUsageSource = z.infer<typeof runtimeUsageSourceSchema>;

export const normalizedRuntimeUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  totalTokens: z.number().int().nonnegative().nullable(),
  cachedInputTokens: z.number().int().nonnegative().nullable(),
  reasoningTokens: z.number().int().nonnegative().nullable(),
  costAmount: z.number().nonnegative().nullable(),
  costCurrency: z.string().trim().min(1).max(12).nullable(),
  source: runtimeUsageSourceSchema,
  unknownFields: z.array(z.string().trim().min(1).max(120)).max(30),
});
export type NormalizedRuntimeUsage = z.infer<
  typeof normalizedRuntimeUsageSchema
>;

export interface RawRuntimeUsage {
  readonly inputTokens?: number | null | undefined;
  readonly outputTokens?: number | null | undefined;
  readonly totalTokens?: number | null | undefined;
  readonly cachedInputTokens?: number | null | undefined;
  readonly reasoningTokens?: number | null | undefined;
  readonly costAmount?: number | null | undefined;
  readonly costCurrency?: string | null | undefined;
}

function nullableInteger(value: number | null | undefined): number | null {
  return value === null ||
    value === undefined ||
    !Number.isSafeInteger(value) ||
    value < 0
    ? null
    : value;
}

export function normalizeRuntimeUsage(
  raw: RawRuntimeUsage | null | undefined,
): NormalizedRuntimeUsage {
  const inputTokens = nullableInteger(raw?.inputTokens);
  const outputTokens = nullableInteger(raw?.outputTokens);
  let totalTokens = nullableInteger(raw?.totalTokens);
  const cachedInputTokens = nullableInteger(raw?.cachedInputTokens);
  const reasoningTokens = nullableInteger(raw?.reasoningTokens);
  let costAmount =
    raw?.costAmount === null ||
    raw?.costAmount === undefined ||
    !Number.isFinite(raw.costAmount) ||
    raw.costAmount < 0
      ? null
      : raw.costAmount;
  const costCurrency =
    typeof raw?.costCurrency === "string" && raw.costCurrency.trim() !== ""
      ? raw.costCurrency.trim().toUpperCase().slice(0, 12)
      : null;
  if (costAmount !== null && costCurrency === null) {
    costAmount = null;
  }
  let source: RuntimeUsageSource = "unavailable";
  if (totalTokens === null && inputTokens !== null && outputTokens !== null) {
    totalTokens = inputTokens + outputTokens;
    source = "derived";
  } else if (
    totalTokens !== null ||
    inputTokens !== null ||
    outputTokens !== null ||
    costAmount !== null
  ) {
    source = "runtime-reported";
  }
  const knownCount = [
    inputTokens,
    outputTokens,
    totalTokens,
    costAmount,
  ].filter((value) => value !== null).length;
  if (knownCount > 0 && knownCount < 4 && source === "derived") {
    source = "mixed";
  }
  const unknownFields: string[] = [];
  for (const [field, value] of [
    ["inputTokens", inputTokens],
    ["outputTokens", outputTokens],
    ["totalTokens", totalTokens],
    ["costAmount", costAmount],
    ["costCurrency", costAmount === null ? null : costCurrency],
  ] as const) {
    if (value === null) unknownFields.push(field);
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cachedInputTokens,
    reasoningTokens,
    costAmount,
    costCurrency: costAmount === null ? null : costCurrency,
    source,
    unknownFields,
  };
}

export const runtimeUsageReceiptSchema = normalizedRuntimeUsageSchema.extend({
  id: z.string().uuid(),
  workspaceId: z.string().trim().min(1).max(180),
  projectId: z.string().uuid().nullable(),
  runId: z.string().uuid(),
  runAttempt: z.number().int().positive(),
  jobId: z.string().uuid().nullable(),
  jobAttempt: z.number().int().positive().nullable(),
  contextType: runtimeContextTypeSchema,
  contextId: z.string().trim().min(1).max(240),
  runtimeId: z.string().trim().min(1).max(180),
  runtimeRevision: z.number().int().positive().nullable(),
  provider: z.string().trim().min(1).max(120).nullable(),
  model: z.string().trim().min(1).max(160).nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  payloadDigest: z.string().length(64),
  recordedAt: z.string().datetime({ offset: true }),
});
export type RuntimeUsageReceipt = z.infer<typeof runtimeUsageReceiptSchema>;

export const runtimeUsageSummarySchema = z.object({
  sampleCount: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative(),
  costAmount: z.number().nonnegative(),
  costCurrencies: z.array(z.string().trim().min(1).max(12)).max(20),
  unknownSampleCount: z.number().int().nonnegative(),
  unknownFields: z.array(z.string().trim().min(1).max(120)).max(30),
});
export type RuntimeUsageSummary = z.infer<typeof runtimeUsageSummarySchema>;

export const runPhaseSchema = z.enum([
  "queued",
  "claimed",
  "waiting_approval",
  "running",
  "needs_input",
  "retry_wait",
  "recovery",
  "settlement",
  "terminal",
]);
export type RunPhase = z.infer<typeof runPhaseSchema>;

export const runPhaseSegmentSchema = z.object({
  phase: runPhaseSchema,
  startAt: z.string().datetime({ offset: true }),
  endAt: z.string().datetime({ offset: true }),
  durationMs: z.number().int().nonnegative(),
  source: z.enum([
    "run",
    "job-attempt",
    "run-event",
    "task-event",
    "execution-gate",
    "runtime-effect",
  ]),
  sourceId: z.string().nullable(),
});
export type RunPhaseSegment = z.infer<typeof runPhaseSegmentSchema>;

export const runDurationBreakdownSchema = z.object({
  observedTotalMs: z.number().int().nonnegative(),
  queuedMs: z.number().int().nonnegative(),
  claimedMs: z.number().int().nonnegative(),
  waitingApprovalMs: z.number().int().nonnegative(),
  runningMs: z.number().int().nonnegative(),
  needsInputMs: z.number().int().nonnegative(),
  retryWaitMs: z.number().int().nonnegative(),
  recoveryMs: z.number().int().nonnegative(),
  settlementMs: z.number().int().nonnegative(),
  unclassifiedMs: z.number().int().nonnegative(),
});
export type RunDurationBreakdown = z.infer<typeof runDurationBreakdownSchema>;

export const runEconomicsReconciliationIssueSchema = z.object({
  code: z.enum([
    "run_not_settled",
    "run_event_terminal_missing",
    "runtime_effect_missing",
    "job_attempt_missing",
    "usage_receipt_missing",
    "usage_outbox_missing",
    "timeline_out_of_order",
    "duplicate_usage_receipt",
  ]),
  severity: z.enum(["info", "warning", "error"]),
  message: z.string().trim().min(1).max(1_000),
  source: z.enum([
    "run",
    "run-event",
    "job-attempt",
    "runtime-effect",
    "outbox",
    "usage",
    "timeline",
  ]),
});
export type RunEconomicsReconciliationIssue = z.infer<
  typeof runEconomicsReconciliationIssueSchema
>;

export const runEconomicsReconciliationSchema = z.object({
  status: z.enum(["reconciled", "unknown", "inconsistent", "incomplete"]),
  checkedAt: z.string().datetime({ offset: true }),
  issues: z.array(runEconomicsReconciliationIssueSchema),
  sourceCounts: z.object({
    taskEvents: z.number().int().nonnegative(),
    runEvents: z.number().int().nonnegative(),
    jobAttempts: z.number().int().nonnegative(),
    runtimeEffects: z.number().int().nonnegative(),
    outboxMessages: z.number().int().nonnegative(),
    usageReceipts: z.number().int().nonnegative(),
  }),
});
export type RunEconomicsReconciliation = z.infer<
  typeof runEconomicsReconciliationSchema
>;

export const runExecutionEconomicsSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  runId: z.string().uuid(),
  workspaceId: z.string().trim().min(1).max(180),
  projectId: z.string().uuid().nullable(),
  taskId: z.string().uuid().nullable(),
  contextType: runtimeContextTypeSchema,
  contextId: z.string().trim().min(1).max(240),
  status: runStatusSchema,
  runtimeId: z.string().trim().min(1).max(180).nullable(),
  runtimeRevision: z.number().int().positive().nullable(),
  provider: z.string().trim().min(1).max(120).nullable(),
  model: z.string().trim().min(1).max(160).nullable(),
  createdAt: z.string().datetime({ offset: true }),
  startedAt: z.string().datetime({ offset: true }).nullable(),
  endedAt: z.string().datetime({ offset: true }).nullable(),
  usage: runtimeUsageSummarySchema,
  receipts: z.array(runtimeUsageReceiptSchema),
  durations: runDurationBreakdownSchema,
  segments: z.array(runPhaseSegmentSchema),
  claim: z
    .object({
      jobId: z.string().uuid(),
      attempt: z.number().int().positive(),
      workerId: z.string().trim().min(1).max(180),
      startedAt: z.string().datetime({ offset: true }),
      claimLatencyMs: z.number().int().nonnegative(),
    })
    .nullable(),
  reconciliation: runEconomicsReconciliationSchema,
});
export type RunExecutionEconomics = z.infer<typeof runExecutionEconomicsSchema>;

export const executionHistoryQuerySchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().trim().max(2_000).optional(),
  runtimeId: z.string().trim().min(1).max(180).optional(),
  contextType: runtimeContextTypeSchema.optional(),
  status: runStatusSchema.optional(),
});
export type ExecutionHistoryQuery = z.infer<typeof executionHistoryQuerySchema>;

export const executionHistoryItemSchema = z.object({
  runId: z.string().uuid(),
  workspaceId: z.string().trim().min(1).max(180),
  projectId: z.string().uuid().nullable(),
  taskId: z.string().uuid().nullable(),
  contextType: runtimeContextTypeSchema,
  contextId: z.string().trim().min(1).max(240),
  status: runStatusSchema,
  runtimeId: z.string().trim().min(1).max(180).nullable(),
  provider: z.string().trim().min(1).max(120).nullable(),
  model: z.string().trim().min(1).max(160).nullable(),
  createdAt: z.string().datetime({ offset: true }),
  endedAt: z.string().datetime({ offset: true }).nullable(),
  usage: runtimeUsageSummarySchema,
  durations: runDurationBreakdownSchema,
  reconciliationStatus: z.enum([
    "reconciled",
    "unknown",
    "inconsistent",
    "incomplete",
  ]),
});
export type ExecutionHistoryItem = z.infer<typeof executionHistoryItemSchema>;

export const executionHistoryPageSchema = z.object({
  workspaceId: z.string().trim().min(1).max(180),
  items: z.array(executionHistoryItemSchema),
  nextCursor: z.string().nullable(),
  queryFingerprint: z.string().length(64),
});
export type ExecutionHistoryPage = z.infer<typeof executionHistoryPageSchema>;

export const workspaceRuntimeEconomicsQuerySchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  runtimeId: z.string().trim().min(1).max(180).optional(),
});
export type WorkspaceRuntimeEconomicsQuery = z.infer<
  typeof workspaceRuntimeEconomicsQuerySchema
>;

export const runtimeEconomicsBucketSchema = z.object({
  runtimeId: z.string().trim().min(1).max(180),
  provider: z.string().trim().min(1).max(120).nullable(),
  model: z.string().trim().min(1).max(160).nullable(),
  runCount: z.number().int().nonnegative(),
  usage: runtimeUsageSummarySchema,
  durations: runDurationBreakdownSchema,
});
export type RuntimeEconomicsBucket = z.infer<
  typeof runtimeEconomicsBucketSchema
>;

export const workspaceRuntimeEconomicsSchema = z.object({
  workspaceId: z.string().trim().min(1).max(180),
  generatedAt: z.string().datetime({ offset: true }),
  from: z.string().datetime({ offset: true }).nullable(),
  to: z.string().datetime({ offset: true }).nullable(),
  runCount: z.number().int().nonnegative(),
  usage: runtimeUsageSummarySchema,
  durations: runDurationBreakdownSchema,
  runtimes: z.array(runtimeEconomicsBucketSchema),
});
export type WorkspaceRuntimeEconomics = z.infer<
  typeof workspaceRuntimeEconomicsSchema
>;

export function summarizeRuntimeUsage(
  receipts: readonly RuntimeUsageReceipt[],
): RuntimeUsageSummary {
  const sum = (field: keyof RuntimeUsageReceipt): number =>
    receipts.reduce((total, receipt) => {
      const value = receipt[field];
      return typeof value === "number" ? total + value : total;
    }, 0);
  const unknownFields = new Set<string>();
  let unknownSampleCount = 0;
  for (const receipt of receipts) {
    if (receipt.unknownFields.length > 0) unknownSampleCount += 1;
    for (const field of receipt.unknownFields) unknownFields.add(field);
  }
  return {
    sampleCount: receipts.length,
    inputTokens: sum("inputTokens"),
    outputTokens: sum("outputTokens"),
    totalTokens: sum("totalTokens"),
    cachedInputTokens: sum("cachedInputTokens"),
    reasoningTokens: sum("reasoningTokens"),
    costAmount: sum("costAmount"),
    costCurrencies: [
      ...new Set(
        receipts.flatMap((receipt) =>
          receipt.costCurrency === null ? [] : [receipt.costCurrency],
        ),
      ),
    ].sort(),
    unknownSampleCount,
    unknownFields: [...unknownFields].sort(),
  };
}
