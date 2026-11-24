import { z } from "zod";
import { toolCategorySchema } from "./task-execution.js";

export const MCP_TOOL_INVOCATION_FLAG = "mcp.tool_invocation";
export const MCP_TOOL_CATEGORY = "mcp.invoke";
export const mcpToolInvokeCategorySchema = toolCategorySchema.refine(
  (value) => value === MCP_TOOL_CATEGORY,
  { message: `MCP Tool calls require ${MCP_TOOL_CATEGORY}` },
);

export const mcpToolCallStatusSchema = z.enum([
  "running",
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
  "interrupted",
]);
export type McpToolCallStatus = z.infer<typeof mcpToolCallStatusSchema>;

export const mcpToolCallReceiptStatusSchema = z.enum([
  "started",
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
  "interrupted",
]);
export type McpToolCallReceiptStatus = z.infer<
  typeof mcpToolCallReceiptStatusSchema
>;

export const mcpToolCallErrorCategorySchema = z.enum([
  "timeout",
  "cancelled",
  "dns",
  "tls",
  "authentication",
  "authorization",
  "http_status",
  "protocol",
  "schema",
  "tool",
  "network",
  "credential",
  "unknown",
]);
export type McpToolCallErrorCategory = z.infer<
  typeof mcpToolCallErrorCategorySchema
>;

export const mcpToolKeySchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/);
export type McpToolKey = z.infer<typeof mcpToolKeySchema>;

export const mcpToolCallInputSchema = z
  .object({
    runId: z.string().uuid(),
    runAttempt: z.number().int().positive(),
    toolKey: mcpToolKeySchema,
    gateId: z.string().uuid(),
    idempotencyKey: z.string().trim().min(8).max(240),
    arguments: z.record(z.string(), z.unknown()),
  })
  .strict();
export type McpToolCallInput = z.infer<typeof mcpToolCallInputSchema>;

export const mcpToolInputSummarySchema = z.object({
  argumentKeys: z.array(z.string().max(160)).max(100),
  argumentCount: z.number().int().nonnegative(),
  inputBytes: z.number().int().nonnegative(),
});
export type McpToolInputSummary = z.infer<typeof mcpToolInputSummarySchema>;

export const mcpToolOutputSummarySchema = z.object({
  contentCount: z.number().int().nonnegative(),
  contentTypes: z.array(z.string().max(80)).max(100),
  textBytes: z.number().int().nonnegative(),
  structuredBytes: z.number().int().nonnegative(),
  toolReportedError: z.boolean(),
});
export type McpToolOutputSummary = z.infer<
  typeof mcpToolOutputSummarySchema
>;

export const mcpToolCallReceiptSchema = z.object({
  id: z.string().uuid(),
  callId: z.string().uuid(),
  seq: z.number().int().positive(),
  status: mcpToolCallReceiptStatusSchema,
  idempotencyKey: z.string().min(8).max(240),
  inputSummary: mcpToolInputSummarySchema,
  outputSummary: mcpToolOutputSummarySchema.nullable(),
  outputDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  errorCategory: mcpToolCallErrorCategorySchema.nullable(),
  errorCode: z.string().max(160).nullable(),
  errorMessage: z.string().max(2_000).nullable(),
  createdAt: z.string().datetime({ offset: true }),
});
export type McpToolCallReceipt = z.infer<typeof mcpToolCallReceiptSchema>;

export const mcpToolCallSchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  runAttempt: z.number().int().positive(),
  taskId: z.string().uuid(),
  projectId: z.string().uuid(),
  agentId: z.string().uuid(),
  agentPrincipalId: z.string().min(1).max(180).nullable(),
  providerId: z.string().uuid(),
  providerKey: z.string().min(2).max(120),
  providerVersionId: z.string().uuid(),
  providerVersion: z.number().int().positive(),
  providerRevision: z.number().int().positive(),
  toolCatalogId: z.string().uuid(),
  toolKey: mcpToolKeySchema,
  toolName: z.string().min(1).max(240),
  toolSchemaDigest: z.string().regex(/^[a-f0-9]{64}$/),
  ticketId: z.string().uuid(),
  gateId: z.string().uuid(),
  policyId: z.string().uuid().nullable(),
  policyRevision: z.number().int().nonnegative(),
  envelopeId: z.string().min(1).max(180),
  envelopeDigest: z.string().regex(/^[a-f0-9]{64}$/),
  idempotencyKey: z.string().min(8).max(240),
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  status: mcpToolCallStatusSchema,
  inputSummary: mcpToolInputSummarySchema,
  outputSummary: mcpToolOutputSummarySchema.nullable(),
  outputDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  errorCategory: mcpToolCallErrorCategorySchema.nullable(),
  errorCode: z.string().max(160).nullable(),
  errorMessage: z.string().max(2_000).nullable(),
  startedAt: z.string().datetime({ offset: true }),
  completedAt: z.string().datetime({ offset: true }).nullable(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type McpToolCall = z.infer<typeof mcpToolCallSchema>;

export const mcpToolCallDetailSchema = z.object({
  call: mcpToolCallSchema,
  receipts: z.array(mcpToolCallReceiptSchema),
});
export type McpToolCallDetail = z.infer<typeof mcpToolCallDetailSchema>;

export const mcpToolCallListSchema = z.object({
  items: z.array(mcpToolCallDetailSchema),
});
export type McpToolCallList = z.infer<typeof mcpToolCallListSchema>;

export const mcpToolCallReconcileResultSchema = z.object({
  reconciled: z.number().int().nonnegative(),
});
export type McpToolCallReconcileResult = z.infer<
  typeof mcpToolCallReconcileResultSchema
>;

export const mcpToolCallReconcileInputSchema = z
  .object({
    limit: z.number().int().positive().max(500).default(50),
  })
  .strict();
export type McpToolCallReconcileInput = z.infer<
  typeof mcpToolCallReconcileInputSchema
>;
