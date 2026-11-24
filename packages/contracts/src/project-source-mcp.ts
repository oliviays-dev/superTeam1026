import { z } from "zod";
import { projectAlertObservationSchema } from "./project-business-chain.js";
import { mcpToolKeySchema } from "./mcp-tool-call.js";

export const MCP_PROJECT_SOURCE_FLAG = "project.source.mcp";
export const MCP_PROJECT_SOURCE_READ_PROTOCOL =
  "mcp-project-source-read-v1" as const;

export const projectSourceMcpReadStatusSchema = z.enum([
  "running",
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
  "interrupted",
]);
export type ProjectSourceMcpReadStatus = z.infer<
  typeof projectSourceMcpReadStatusSchema
>;

export const projectSourceMcpReadIntentSchema = z
  .object({
    projectId: z.string().uuid(),
    refKey: z.string().trim().min(1).max(160),
    runId: z.string().uuid(),
    runAttempt: z.number().int().positive(),
    gateId: z.string().uuid(),
    requestId: z.string().uuid(),
    idempotencyKey: z.string().trim().min(8).max(240),
    timeoutMs: z.number().int().min(1_000).max(60_000).optional(),
  })
  .strict();
export type ProjectSourceMcpReadIntent = z.infer<
  typeof projectSourceMcpReadIntentSchema
>;

export const projectSourceMcpToolArgumentsSchema = z
  .object({
    protocol: z.literal(MCP_PROJECT_SOURCE_READ_PROTOCOL),
    projectId: z.string().uuid(),
    refKey: z.string().trim().min(1).max(160),
    sourceSystem: z.string().trim().min(1).max(120),
    objectType: z.string().trim().min(1).max(120),
    objectId: z.string().trim().min(1).max(240),
    path: z.string().trim().min(1).max(300),
  })
  .strict();
export type ProjectSourceMcpToolArguments = z.infer<
  typeof projectSourceMcpToolArgumentsSchema
>;

export const projectSourceMcpToolDataSchema = z
  .object({
    protocol: z.literal(MCP_PROJECT_SOURCE_READ_PROTOCOL),
    sourceRevision: z.string().trim().min(1).max(240).nullable().default(null),
    observedAt: z.string().datetime({ offset: true }),
    effectiveAt: z.string().datetime({ offset: true }).nullable().default(null),
    freshUntil: z.string().datetime({ offset: true }).nullable().default(null),
    payload: z.unknown(),
    alerts: z
      .array(projectAlertObservationSchema.omit({ observedAt: true }))
      .max(100)
      .default([]),
  })
  .strict();
export type ProjectSourceMcpToolData = z.infer<
  typeof projectSourceMcpToolDataSchema
>;

export const projectSourceMcpReadRecordSchema = z.object({
  requestId: z.string().uuid(),
  runtimeRequestId: z.string().uuid().nullable(),
  projectId: z.string().uuid(),
  refKey: z.string(),
  sourceKind: z.string(),
  sourceSystem: z.string(),
  sourceObjectType: z.string(),
  sourceObjectId: z.string(),
  sourcePath: z.string(),
  sourceBindingRevision: z.number().int().positive(),
  sourceBindingDigest: z.string().regex(/^[a-f0-9]{64}$/),
  providerId: z.string().uuid(),
  providerVersionId: z.string().uuid(),
  providerRevision: z.number().int().positive(),
  toolKey: mcpToolKeySchema,
  runId: z.string().uuid(),
  runAttempt: z.number().int().positive(),
  ticketId: z.string().uuid(),
  gateId: z.string().uuid(),
  policyId: z.string().uuid(),
  policyRevision: z.number().int().nonnegative(),
  envelopeId: z.string().min(1).max(180),
  envelopeDigest: z.string().regex(/^[a-f0-9]{64}$/),
  callId: z.string().uuid().nullable(),
  snapshotId: z.string().uuid().nullable(),
  idempotencyKey: z.string().min(8).max(240),
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  status: projectSourceMcpReadStatusSchema,
  sourceRevision: z.string().nullable(),
  errorCategory: z.string().max(80).nullable(),
  errorCode: z.string().max(160).nullable(),
  errorMessage: z.string().max(2_000).nullable(),
  leaseOwner: z.string().max(180).nullable(),
  leaseExpiresAt: z.string().datetime({ offset: true }).nullable(),
  startedAt: z.string().datetime({ offset: true }),
  completedAt: z.string().datetime({ offset: true }).nullable(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type ProjectSourceMcpReadRecord = z.infer<
  typeof projectSourceMcpReadRecordSchema
>;

export const projectSourceMcpReadResultSchema = z.object({
  requestId: z.string().uuid(),
  status: projectSourceMcpReadStatusSchema,
  deduplicated: z.boolean(),
  snapshotId: z.string().uuid().nullable(),
  sourceRevision: z.string().nullable(),
  errorCategory: z.string().max(80).nullable(),
  errorCode: z.string().max(160).nullable(),
  errorMessage: z.string().max(2_000).nullable(),
});
export type ProjectSourceMcpReadResult = z.infer<
  typeof projectSourceMcpReadResultSchema
>;

export const projectSourceMcpReadSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  running: z.number().int().nonnegative(),
  staleRunning: z.number().int().nonnegative(),
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  timedOut: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(),
  interrupted: z.number().int().nonnegative(),
  oldestRunningAgeSeconds: z.number().int().nonnegative(),
  alertLevel: z.enum(["ok", "warning", "critical"]),
  alertReasons: z.array(
    z.enum([
      "stale_running",
      "oldest_running_warning",
      "oldest_running_critical",
      "error_ratio_warning",
      "error_ratio_critical",
    ]),
  ),
  errorCategories: z.array(
    z.object({
      category: z.string().min(1).max(80),
      count: z.number().int().positive(),
    }),
  ),
});
export type ProjectSourceMcpReadSummary = z.infer<
  typeof projectSourceMcpReadSummarySchema
>;

export const projectSourceMcpReconcileResultSchema = z.object({
  reconciled: z.number().int().nonnegative(),
});
export type ProjectSourceMcpReconcileResult = z.infer<
  typeof projectSourceMcpReconcileResultSchema
>;

export const projectSourceMcpReconcileInputSchema = z
  .object({
    limit: z.number().int().positive().max(500).default(50),
  })
  .strict();
export type ProjectSourceMcpReconcileInput = z.infer<
  typeof projectSourceMcpReconcileInputSchema
>;

export const projectSourceMcpRetentionQuerySchema = z
  .object({
    retentionDays: z.coerce.number().int().min(7).max(3_650).default(90),
  })
  .strict();
export type ProjectSourceMcpRetentionQuery = z.infer<
  typeof projectSourceMcpRetentionQuerySchema
>;

export const projectSourceMcpRetentionResultSchema = z.object({
  retentionDays: z.number().int().positive(),
  eligibleReads: z.number().int().nonnegative(),
  eligibleEvents: z.number().int().nonnegative(),
  eligibleSnapshots: z.number().int().nonnegative(),
  oldestEligibleCompletedAt: z
    .string()
    .datetime({ offset: true })
    .nullable(),
  dryRun: z.literal(true),
  action: z.literal("archive-before-delete"),
});
export type ProjectSourceMcpRetentionResult = z.infer<
  typeof projectSourceMcpRetentionResultSchema
>;
