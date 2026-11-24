import { z } from "zod";
import {
  mcpToolCallErrorCategorySchema,
  mcpToolKeySchema,
  mcpToolOutputSummarySchema,
  mcpToolInputSummarySchema,
} from "./mcp-tool-call.js";

export const MCP_RUNTIME_TOOL_BRIDGE_FLAG = "mcp.runtime_tool_bridge";

export const runtimeToolRequestStatusSchema = z.enum([
  "running",
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
  "interrupted",
]);
export type RuntimeToolRequestStatus = z.infer<
  typeof runtimeToolRequestStatusSchema
>;

export const runtimeToolRequestTerminalStatusSchema = z.enum([
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
  "interrupted",
]);
export type RuntimeToolRequestTerminalStatus = z.infer<
  typeof runtimeToolRequestTerminalStatusSchema
>;

export const runtimeMcpToolRequestSchema = z
  .object({
    requestId: z.string().uuid(),
    toolKey: mcpToolKeySchema,
    gateId: z.string().uuid(),
    idempotencyKey: z.string().trim().min(8).max(240),
    arguments: z.record(z.string(), z.unknown()),
    timeoutMs: z.number().int().positive().max(3_600_000).optional(),
  })
  .strict();
export type RuntimeMcpToolRequest = z.infer<
  typeof runtimeMcpToolRequestSchema
>;

export const runtimeToolRequestRecordSchema = z.object({
  requestId: z.string().uuid(),
  runId: z.string().uuid(),
  runAttempt: z.number().int().positive(),
  taskId: z.string().uuid(),
  projectId: z.string().uuid(),
  agentId: z.string().uuid(),
  agentPrincipalId: z.string().trim().min(1).max(180).nullable(),
  toolKey: mcpToolKeySchema,
  ticketId: z.string().uuid(),
  gateId: z.string().uuid(),
  policyId: z.string().uuid(),
  policyRevision: z.number().int().nonnegative(),
  envelopeId: z.string().trim().min(1).max(180),
  envelopeDigest: z.string().regex(/^[a-f0-9]{64}$/),
  callId: z.string().uuid().nullable(),
  idempotencyKey: z.string().trim().min(8).max(240),
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  status: runtimeToolRequestStatusSchema,
  inputSummary: mcpToolInputSummarySchema,
  outputSummary: mcpToolOutputSummarySchema.nullable(),
  outputDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  errorCategory: mcpToolCallErrorCategorySchema.nullable(),
  errorCode: z.string().trim().min(1).max(160).nullable(),
  errorMessage: z.string().trim().max(2_000).nullable(),
  startedAt: z.string().datetime({ offset: true }),
  completedAt: z.string().datetime({ offset: true }).nullable(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type RuntimeToolRequestRecord = z.infer<
  typeof runtimeToolRequestRecordSchema
>;

export const runtimeToolRequestReceiptSchema = z.object({
  id: z.string().uuid(),
  requestId: z.string().uuid(),
  seq: z.number().int().positive(),
  status: runtimeToolRequestStatusSchema,
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  inputSummary: mcpToolInputSummarySchema,
  outputSummary: mcpToolOutputSummarySchema.nullable(),
  outputDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  errorCategory: mcpToolCallErrorCategorySchema.nullable(),
  errorCode: z.string().trim().min(1).max(160).nullable(),
  errorMessage: z.string().trim().max(2_000).nullable(),
  createdAt: z.string().datetime({ offset: true }),
});
export type RuntimeToolRequestReceipt = z.infer<
  typeof runtimeToolRequestReceiptSchema
>;

export const runtimeToolRequestDetailSchema = z.object({
  request: runtimeToolRequestRecordSchema,
  receipts: z.array(runtimeToolRequestReceiptSchema),
});
export type RuntimeToolRequestDetail = z.infer<
  typeof runtimeToolRequestDetailSchema
>;

export const runtimeToolRequestListSchema = z.object({
  items: z.array(runtimeToolRequestDetailSchema),
});
export type RuntimeToolRequestList = z.infer<
  typeof runtimeToolRequestListSchema
>;

export const runtimeMcpToolResultSchema = z.object({
  requestId: z.string().uuid(),
  callId: z.string().uuid().nullable(),
  status: runtimeToolRequestTerminalStatusSchema,
  deduplicated: z.boolean(),
  resultAvailable: z.boolean(),
  result: z.record(z.string(), z.unknown()).optional(),
  errorCategory: mcpToolCallErrorCategorySchema.nullable(),
  errorCode: z.string().trim().min(1).max(160).nullable(),
  errorMessage: z.string().trim().max(2_000).nullable(),
});
export type RuntimeMcpToolResult = z.infer<typeof runtimeMcpToolResultSchema>;

export const runtimeToolRequestReconcileResultSchema = z.object({
  reconciled: z.number().int().nonnegative(),
});
export type RuntimeToolRequestReconcileResult = z.infer<
  typeof runtimeToolRequestReconcileResultSchema
>;

export const runtimeToolRequestReconcileInputSchema = z
  .object({
    limit: z.number().int().positive().max(500).default(50),
  })
  .strict();
export type RuntimeToolRequestReconcileInput = z.infer<
  typeof runtimeToolRequestReconcileInputSchema
>;

export const runtimeToolRequestSummarySchema = z.object({
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
      category: mcpToolCallErrorCategorySchema,
      count: z.number().int().positive(),
    }),
  ),
});
export type RuntimeToolRequestSummary = z.infer<
  typeof runtimeToolRequestSummarySchema
>;

export const runtimeToolRequestRetentionQuerySchema = z
  .object({
    retentionDays: z.coerce.number().int().min(7).max(3_650).default(90),
  })
  .strict();
export type RuntimeToolRequestRetentionQuery = z.infer<
  typeof runtimeToolRequestRetentionQuerySchema
>;

export const runtimeToolRequestRetentionResultSchema = z.object({
  retentionDays: z.number().int().positive(),
  eligibleRequests: z.number().int().nonnegative(),
  eligibleReceipts: z.number().int().nonnegative(),
  oldestEligibleCompletedAt: z
    .string()
    .datetime({ offset: true })
    .nullable(),
  dryRun: z.literal(true),
  action: z.literal("archive-before-delete"),
});
export type RuntimeToolRequestRetentionResult = z.infer<
  typeof runtimeToolRequestRetentionResultSchema
>;
