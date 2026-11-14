import { z } from "zod";
import { acceptanceEvidenceRefSchema } from "./task-execution-evidence.js";

export const AGENT_TASK_TOOLS_FLAG = "agent.task_tools";
export const AGENT_WORKSPACE_FILES_FLAG = "agent.workspace_files";

export const agentTaskToolNameSchema = z.enum([
  "task_query",
  "task_submit_deliverable",
  "task_request_input",
  "task_comment",
  "read_file",
  "write_file",
  "list_files",
]);
export type AgentTaskToolName = z.infer<typeof agentTaskToolNameSchema>;

export const agentTaskToolCategorySchema = z.enum([
  "task.read",
  "task.write",
  "fs.read",
  "fs.write",
]);
export type AgentTaskToolCategory = z.infer<
  typeof agentTaskToolCategorySchema
>;

export const agentToolRuntimeProofSchema = z
  .object({
    runId: z.string().uuid(),
    runAttempt: z.number().int().positive(),
    sceneSessionId: z.string().uuid(),
  })
  .strict();
export type AgentToolRuntimeProof = z.infer<
  typeof agentToolRuntimeProofSchema
>;

export const taskQueryToolPayloadSchema = z
  .object({
    includeRuns: z.boolean().default(false),
  })
  .strict();
export type TaskQueryToolPayload = z.infer<typeof taskQueryToolPayloadSchema>;

export const taskSubmitDeliverableToolPayloadSchema = z
  .object({
    summary: z.string().trim().min(1).max(8_000),
    items: z
      .array(
        z
          .object({
            acceptanceItemId: z.string().uuid(),
            acceptanceItemRevision: z.number().int().positive(),
            evidenceRefs: z.array(acceptanceEvidenceRefSchema).min(1).max(100),
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict();
export type TaskSubmitDeliverableToolPayload = z.infer<
  typeof taskSubmitDeliverableToolPayloadSchema
>;

export const taskRequestInputToolPayloadSchema = z
  .object({
    prompt: z.string().trim().min(1).max(20_000),
  })
  .strict();
export type TaskRequestInputToolPayload = z.infer<
  typeof taskRequestInputToolPayloadSchema
>;

export const taskCommentToolPayloadSchema = z
  .object({
    content: z.string().trim().min(1).max(20_000),
    isKeyConsensus: z.boolean().default(false),
  })
  .strict();
export type TaskCommentToolPayload = z.infer<
  typeof taskCommentToolPayloadSchema
>;

export const readFileToolPayloadSchema = z
  .object({
    path: z.string().min(1).max(1_000),
  })
  .strict();
export type ReadFileToolPayload = z.infer<typeof readFileToolPayloadSchema>;

export const writeFileToolPayloadSchema = z
  .object({
    path: z.string().min(1).max(1_000),
    content: z.string().max(2_000_000),
  })
  .strict();
export type WriteFileToolPayload = z.infer<typeof writeFileToolPayloadSchema>;

export const listFilesToolPayloadSchema = z
  .object({
    path: z.string().min(1).max(1_000).default("."),
    depth: z.number().int().min(0).max(20).default(1),
  })
  .strict();
export type ListFilesToolPayload = z.infer<typeof listFilesToolPayloadSchema>;

export const agentTaskToolRequestSchema = z.discriminatedUnion("tool", [
  z
    .object({
      tool: z.literal("task_query"),
      idempotencyKey: z.string().trim().min(8).max(240),
      gateId: z.string().uuid().optional(),
      payload: taskQueryToolPayloadSchema,
    })
    .strict(),
  z
    .object({
      tool: z.literal("task_submit_deliverable"),
      idempotencyKey: z.string().trim().min(8).max(240),
      gateId: z.string().uuid().optional(),
      payload: taskSubmitDeliverableToolPayloadSchema,
    })
    .strict(),
  z
    .object({
      tool: z.literal("task_request_input"),
      idempotencyKey: z.string().trim().min(8).max(240),
      gateId: z.string().uuid().optional(),
      payload: taskRequestInputToolPayloadSchema,
    })
    .strict(),
  z
    .object({
      tool: z.literal("task_comment"),
      idempotencyKey: z.string().trim().min(8).max(240),
      gateId: z.string().uuid().optional(),
      payload: taskCommentToolPayloadSchema,
    })
    .strict(),
  z
    .object({
      tool: z.literal("read_file"),
      idempotencyKey: z.string().trim().min(8).max(240),
      gateId: z.string().uuid().optional(),
      payload: readFileToolPayloadSchema,
    })
    .strict(),
  z
    .object({
      tool: z.literal("write_file"),
      idempotencyKey: z.string().trim().min(8).max(240),
      gateId: z.string().uuid().optional(),
      payload: writeFileToolPayloadSchema,
    })
    .strict(),
  z
    .object({
      tool: z.literal("list_files"),
      idempotencyKey: z.string().trim().min(8).max(240),
      gateId: z.string().uuid().optional(),
      payload: listFilesToolPayloadSchema,
    })
    .strict(),
]);
export type AgentTaskToolRequest = z.infer<typeof agentTaskToolRequestSchema>;

export const agentToolWorkspaceLimitsSchema = z
  .object({
    maxReadBytes: z.number().int().positive().max(16 * 1024 * 1024),
    maxWriteBytes: z.number().int().positive().max(16 * 1024 * 1024),
    maxListDepth: z.number().int().nonnegative().max(100),
    maxListEntries: z.number().int().positive().max(100_000),
    maxListOutputBytes: z.number().int().positive().max(16 * 1024 * 1024),
  })
  .strict();
export type AgentToolWorkspaceLimits = z.infer<
  typeof agentToolWorkspaceLimitsSchema
>;

export const DEFAULT_AGENT_TOOL_WORKSPACE_LIMITS: AgentToolWorkspaceLimits = {
  maxReadBytes: 1024 * 1024,
  maxWriteBytes: 1024 * 1024,
  maxListDepth: 4,
  maxListEntries: 1_000,
  maxListOutputBytes: 256 * 1024,
};

export const toolInvocationStatusSchema = z.enum([
  "started",
  "succeeded",
  "failed",
]);
export type ToolInvocationStatus = z.infer<
  typeof toolInvocationStatusSchema
>;

export const toolInvocationRecordSchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  runAttempt: z.number().int().positive(),
  sceneSessionId: z.string().uuid(),
  taskId: z.string().uuid().nullable(),
  projectId: z.string().uuid().nullable(),
  agentId: z.string().uuid(),
  agentPrincipalId: z.string().trim().min(1).max(180).nullable(),
  envelopeId: z.string().trim().min(1).max(180).nullable(),
  envelopeDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  ticketId: z.string().uuid().nullable(),
  gateId: z.string().uuid().nullable(),
  tool: agentTaskToolNameSchema,
  toolCategory: agentTaskToolCategorySchema,
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  idempotencyKey: z.string().trim().min(8).max(240),
  status: toolInvocationStatusSchema,
  result: z.record(z.string(), z.unknown()).nullable(),
  rejectionCode: z.string().trim().min(1).max(180).nullable(),
  rejectionReason: z.string().trim().max(4_000).nullable(),
  pathDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  pathSummary: z.string().max(500).nullable(),
  byteCount: z.number().int().nonnegative().nullable(),
  createdAt: z.string().datetime({ offset: true }),
  completedAt: z.string().datetime({ offset: true }).nullable(),
  updatedAt: z.string().datetime({ offset: true }),
});
export type ToolInvocationRecord = z.infer<typeof toolInvocationRecordSchema>;

export const agentTaskToolExecutionResultSchema = z.object({
  invocationId: z.string().uuid(),
  runId: z.string().uuid(),
  runAttempt: z.number().int().positive(),
  tool: agentTaskToolNameSchema,
  status: z.literal("succeeded"),
  deduplicated: z.boolean(),
  result: z.record(z.string(), z.unknown()),
});
export type AgentTaskToolExecutionResult = z.infer<
  typeof agentTaskToolExecutionResultSchema
>;
