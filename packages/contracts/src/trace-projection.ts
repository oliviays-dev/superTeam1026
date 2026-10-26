import { z } from "zod";
import {
  jobSchema,
  runtimeEffectReceiptSchema,
  runtimeMaintenanceSchema,
} from "./runtime-reliability.js";
import { platformRunEventSchema, runSchema } from "./platform.js";
import { spanIdSchema, traceIdSchema } from "./trace.js";

export const runtimeJobAttemptSchema = z.object({
  id: z.string().uuid(),
  jobId: z.string().uuid(),
  attempt: z.number().int().positive(),
  workerId: z.string(),
  status: z.enum([
    "running",
    "completed",
    "failed",
    "dead_letter",
    "interrupted",
  ]),
  traceId: traceIdSchema.nullable(),
  spanId: spanIdSchema.nullable(),
  error: z.string().nullable(),
  startedAt: z.string().datetime({ offset: true }),
  heartbeatAt: z.string().datetime({ offset: true }),
  endedAt: z.string().datetime({ offset: true }).nullable(),
});
export type RuntimeJobAttempt = z.infer<typeof runtimeJobAttemptSchema>;

export const runtimeTraceSchema = z.object({
  traceId: traceIdSchema,
  runs: z.array(runSchema),
  runEvents: z.array(platformRunEventSchema),
  jobs: z.array(jobSchema),
  jobAttempts: z.array(runtimeJobAttemptSchema),
  runtimeEffects: z.array(runtimeEffectReceiptSchema),
  maintenanceRuns: z.array(runtimeMaintenanceSchema),
});
export type RuntimeTrace = z.infer<typeof runtimeTraceSchema>;
