import { z } from "zod";

export const jobStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "dead_letter",
]);
export type JobStatus = z.infer<typeof jobStatusSchema>;

export const jobSchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  kind: z.string(),
  status: jobStatusSchema,
  attempts: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  availableAt: z.string().datetime({ offset: true }),
  leaseOwner: z.string().nullable(),
  leaseExpiresAt: z.string().datetime({ offset: true }).nullable(),
  lastHeartbeatAt: z.string().datetime({ offset: true }).nullable(),
  lastError: z.string().nullable(),
  recoveryCount: z.number().int().nonnegative(),
  manualRecoveryCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  completedAt: z.string().datetime({ offset: true }).nullable(),
  deadLetterAt: z.string().datetime({ offset: true }).nullable(),
});
export type Job = z.infer<typeof jobSchema>;

export const jobListQuerySchema = z.object({
  status: jobStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type JobListQuery = z.infer<typeof jobListQuerySchema>;

export const jobRecoveryInputSchema = z.object({
  reason: z.string().trim().min(1).max(1_000),
});
export type JobRecoveryInput = z.infer<typeof jobRecoveryInputSchema>;

export const workerStatusSchema = z.enum([
  "starting",
  "running",
  "draining",
  "stopped",
]);
export type WorkerStatus = z.infer<typeof workerStatusSchema>;

export const workerHeartbeatSchema = z.object({
  id: z.string(),
  hostname: z.string(),
  pid: z.number().int().positive(),
  concurrency: z.number().int().positive(),
  status: workerStatusSchema,
  startedAt: z.string().datetime({ offset: true }),
  heartbeatAt: z.string().datetime({ offset: true }),
  stoppingAt: z.string().datetime({ offset: true }).nullable(),
  stoppedAt: z.string().datetime({ offset: true }).nullable(),
  metadata: z.record(z.string(), z.unknown()),
});
export type WorkerHeartbeat = z.infer<typeof workerHeartbeatSchema>;

export const healthCheckSchema = z.object({
  ok: z.boolean(),
  status: z.string(),
  detail: z.string().optional(),
});
export type HealthCheck = z.infer<typeof healthCheckSchema>;

export const livenessResponseSchema = z.object({
  ok: z.literal(true),
  service: z.literal("pluginmax-api"),
  uptimeSeconds: z.number().nonnegative(),
});
export type LivenessResponse = z.infer<typeof livenessResponseSchema>;

export const readinessResponseSchema = z.object({
  ok: z.boolean(),
  status: z.enum(["ready", "not_ready"]),
  checks: z.object({
    database: healthCheckSchema,
    worker: healthCheckSchema,
    migration: healthCheckSchema,
  }),
});
export type ReadinessResponse = z.infer<typeof readinessResponseSchema>;

export const runtimeMaintenanceSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum([
    "idempotency_cleanup",
    "approval_sla",
    "lease_recovery",
  ]),
  status: z.enum(["completed", "failed"]),
  processedCount: z.number().int().nonnegative(),
  archivedCount: z.number().int().nonnegative(),
  deletedCount: z.number().int().nonnegative(),
  error: z.string().nullable(),
  metrics: z.record(z.string(), z.unknown()),
  startedAt: z.string().datetime({ offset: true }),
  completedAt: z.string().datetime({ offset: true }),
});
export type RuntimeMaintenance = z.infer<typeof runtimeMaintenanceSchema>;

export const approvalSlaItemSchema = z.object({
  instanceId: z.string().uuid(),
  nodeId: z.string(),
  round: z.number().int().positive(),
  pendingCount: z.number().int().nonnegative(),
  dueAt: z.string().datetime({ offset: true }).nullable(),
  expiresAt: z.string().datetime({ offset: true }).nullable(),
  overdue: z.boolean(),
});
export type ApprovalSlaItem = z.infer<typeof approvalSlaItemSchema>;

export const runtimeMetricsSchema = z.object({
  generatedAt: z.string().datetime({ offset: true }),
  expectedMigrationVersion: z.number().int().positive(),
  migrationVersion: z.number().int().nonnegative(),
  workerHeartbeatStaleAfterSeconds: z.number().int().positive(),
  activeWorkers: z.number().int().nonnegative(),
  totalWorkerConcurrency: z.number().int().nonnegative(),
  activeJobs: z.number().int().nonnegative(),
  queueDepth: z.number().int().nonnegative(),
  deadLetterCount: z.number().int().nonnegative(),
  jobFailureRate: z.number().min(0).max(1),
  jobSuccessRate: z.number().min(0).max(1),
  runTimeoutRate: z.number().min(0).max(1),
  approvalBacklog: z.number().int().nonnegative(),
  approvalSlaOverdue: z.number().int().nonnegative(),
  approvalSlaExpired24h: z.number().int().nonnegative(),
  archivedIdempotencyReceipts: z.number().int().nonnegative(),
  archiveBytes: z.number().int().nonnegative(),
  completedJobs24h: z.number().int().nonnegative(),
  failedJobs24h: z.number().int().nonnegative(),
  timedOutRuns24h: z.number().int().nonnegative(),
  completedRuns24h: z.number().int().nonnegative(),
  lastMaintenance: runtimeMaintenanceSchema.nullable(),
});
export type RuntimeMetrics = z.infer<typeof runtimeMetricsSchema>;

export const operationsSnapshotSchema = z.object({
  metrics: runtimeMetricsSchema,
  workers: z.array(workerHeartbeatSchema),
  deadLetters: z.array(jobSchema),
  approvalSlaOverdue: z.array(approvalSlaItemSchema),
});
export type OperationsSnapshot = z.infer<typeof operationsSnapshotSchema>;

export const idempotencyCleanupInputSchema = z.object({
  olderThanSeconds: z.number().int().min(1).max(31_536_000).default(604_800),
  batchSize: z.number().int().min(1).max(10_000).default(500),
});
export type IdempotencyCleanupInput = z.infer<
  typeof idempotencyCleanupInputSchema
>;

export const idempotencyCleanupResultSchema = z.object({
  processedCount: z.number().int().nonnegative(),
  archivedCount: z.number().int().nonnegative(),
  deletedCount: z.number().int().nonnegative(),
  cutoff: z.string().datetime({ offset: true }),
  maintenanceId: z.string().uuid().nullable(),
});
export type IdempotencyCleanupResult = z.infer<
  typeof idempotencyCleanupResultSchema
>;

export const approvalSlaSweepResultSchema = z.object({
  reminded: z.number().int().nonnegative(),
  escalated: z.number().int().nonnegative(),
  expired: z.number().int().nonnegative(),
  affectedInstances: z.number().int().nonnegative(),
});
export type ApprovalSlaSweepResult = z.infer<
  typeof approvalSlaSweepResultSchema
>;
