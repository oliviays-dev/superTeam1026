import { z } from "zod";
import { taskPrioritySchema } from "./platform.js";

const identifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .regex(/^[a-zA-Z0-9_.:-]+$/);
const principalIdSchema = z
  .string()
  .trim()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,179}$/);
const dateTimeSchema = z.string().datetime({ offset: true });
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const TASK_CAPTURE_FLAG = "task.capture";

export const taskCaptureSourceTypeSchema = z.enum([
  "direct-chat",
  "meeting",
  "workbench",
  "workflow",
  "manual",
]);
export type TaskCaptureSourceType = z.infer<
  typeof taskCaptureSourceTypeSchema
>;

export const taskCaptureSessionStatusSchema = z.enum([
  "active",
  "archived",
  "expired",
]);
export type TaskCaptureSessionStatus = z.infer<
  typeof taskCaptureSessionStatusSchema
>;

export const taskCaptureCandidateStatusSchema = z.enum([
  "pending",
  "drafting",
  "converted",
  "dismissed",
  "invalidated",
]);
export type TaskCaptureCandidateStatus = z.infer<
  typeof taskCaptureCandidateStatusSchema
>;

export const taskDraftBatchStatusSchema = z.enum([
  "preparing",
  "committing",
  "committed",
  "partial",
  "failed",
]);
export type TaskDraftBatchStatus = z.infer<
  typeof taskDraftBatchStatusSchema
>;

export const taskDraftStatusSchema = z.enum([
  "draft",
  "committing",
  "committed",
  "failed",
  "discarded",
  "invalidated",
]);
export type TaskDraftStatus = z.infer<typeof taskDraftStatusSchema>;

export const taskCaptureSourceRefSchema = z.object({
  type: z.enum([
    "direct-chat-message",
    "meeting-message",
    "minutes-version",
    "workflow-node",
    "task",
    "document",
    "manual",
  ]),
  id: identifierSchema,
  version: z.string().trim().min(1).max(120).nullable().default(null),
  label: z.string().trim().max(300).optional(),
});
export type TaskCaptureSourceRef = z.infer<
  typeof taskCaptureSourceRefSchema
>;

export const taskCaptureSessionSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  sourceType: taskCaptureSourceTypeSchema,
  sourceId: identifierSchema,
  sourceVersion: z.string().trim().min(1).max(120),
  ownerPrincipalId: principalIdSchema,
  status: taskCaptureSessionStatusSchema,
  revision: z.number().int().positive(),
  createdAt: dateTimeSchema,
  updatedAt: dateTimeSchema,
});
export type TaskCaptureSession = z.infer<typeof taskCaptureSessionSchema>;

export const createTaskCaptureSessionInputSchema = z
  .object({
    projectId: z.string().uuid(),
    sourceType: taskCaptureSourceTypeSchema,
    sourceId: identifierSchema,
    sourceVersion: z.string().trim().min(1).max(120).default("1"),
  })
  .strict();
export type CreateTaskCaptureSessionInput = z.infer<
  typeof createTaskCaptureSessionInputSchema
>;

export const taskCaptureCandidateSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  projectId: z.string().uuid(),
  sourceType: taskCaptureSourceTypeSchema,
  sourceId: identifierSchema,
  sourceVersion: z.string().trim().min(1).max(120),
  sourceRefs: z.array(taskCaptureSourceRefSchema).max(100),
  excerpt: z.string().trim().min(1).max(20_000),
  excerptHash: digestSchema,
  status: taskCaptureCandidateStatusSchema,
  invalidationReason: z.string().nullable(),
  invalidatedAt: dateTimeSchema.nullable(),
  revision: z.number().int().positive(),
  createdAt: dateTimeSchema,
  updatedAt: dateTimeSchema,
});
export type TaskCaptureCandidate = z.infer<
  typeof taskCaptureCandidateSchema
>;

export const createTaskCaptureCandidateInputSchema = z
  .object({
    sourceId: identifierSchema,
    sourceVersion: z.string().trim().min(1).max(120),
    excerpt: z.string().trim().min(1).max(20_000),
    sourceRefs: z.array(taskCaptureSourceRefSchema).max(100).default([]),
  })
  .strict();
export type CreateTaskCaptureCandidateInput = z.infer<
  typeof createTaskCaptureCandidateInputSchema
>;

export const invalidateTaskCaptureCandidateInputSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    reason: z.string().trim().min(1).max(2_000),
  })
  .strict();
export type InvalidateTaskCaptureCandidateInput = z.infer<
  typeof invalidateTaskCaptureCandidateInputSchema
>;

export const taskDraftInputSchema = z
  .object({
    candidateId: z.string().uuid(),
    title: z.string().trim().min(1).max(240),
    description: z.string().trim().min(1).max(20_000),
    acceptance: z
      .array(z.string().trim().min(1).max(1_000))
      .max(50)
      .default([]),
    priority: taskPrioritySchema.default("medium"),
    agentId: z.string().uuid().optional(),
    roleId: z.string().uuid().optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.agentId !== undefined && input.roleId !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["roleId"],
        message: "agentId and roleId are mutually exclusive",
      });
    }
  });
export type TaskDraftInput = z.infer<typeof taskDraftInputSchema>;

export const createTaskDraftBatchInputSchema = z
  .object({
    drafts: z.array(taskDraftInputSchema).min(1).max(50),
  })
  .strict();
export type CreateTaskDraftBatchInput = z.infer<
  typeof createTaskDraftBatchInputSchema
>;

export const updateTaskDraftInputSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    title: z.string().trim().min(1).max(240).optional(),
    description: z.string().trim().min(1).max(20_000).optional(),
    acceptance: z
      .array(z.string().trim().min(1).max(1_000))
      .max(50)
      .optional(),
    priority: taskPrioritySchema.optional(),
    agentId: z.string().uuid().nullable().optional(),
    roleId: z.string().uuid().nullable().optional(),
  })
  .strict();
export type UpdateTaskDraftInput = z.infer<
  typeof updateTaskDraftInputSchema
>;

export const taskDraftSchema = z.object({
  id: z.string().uuid(),
  batchId: z.string().uuid(),
  sessionId: z.string().uuid(),
  candidateId: z.string().uuid(),
  projectId: z.string().uuid(),
  title: z.string(),
  description: z.string(),
  acceptance: z.array(z.string()),
  priority: taskPrioritySchema,
  agentId: z.string().uuid().nullable(),
  roleId: z.string().uuid().nullable(),
  creationKey: z.string().trim().min(8).max(300),
  status: taskDraftStatusSchema,
  revision: z.number().int().positive(),
  sourceType: taskCaptureSourceTypeSchema,
  sourceId: identifierSchema,
  sourceVersion: z.string(),
  excerptHash: digestSchema,
  invalidationReason: z.string().nullable(),
  invalidatedAt: dateTimeSchema.nullable(),
  createdAt: dateTimeSchema,
  updatedAt: dateTimeSchema,
});
export type TaskDraft = z.infer<typeof taskDraftSchema>;

export const taskDraftBatchSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  projectId: z.string().uuid(),
  status: taskDraftBatchStatusSchema,
  creationKey: z.string().trim().min(8).max(300),
  revision: z.number().int().positive(),
  createdByPrincipalId: principalIdSchema,
  createdAt: dateTimeSchema,
  updatedAt: dateTimeSchema,
  drafts: z.array(taskDraftSchema),
});
export type TaskDraftBatch = z.infer<typeof taskDraftBatchSchema>;

export const commitTaskDraftBatchInputSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
  })
  .strict();
export type CommitTaskDraftBatchInput = z.infer<
  typeof commitTaskDraftBatchInputSchema
>;

export const taskDraftConversionSchema = z.object({
  id: z.string().uuid(),
  draftId: z.string().uuid(),
  creationKey: z.string(),
  status: z.enum(["processing", "committed", "reused", "failed"]),
  taskId: z.string().uuid().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  attempt: z.number().int().positive(),
  createdAt: dateTimeSchema,
  updatedAt: dateTimeSchema,
});
export type TaskDraftConversion = z.infer<
  typeof taskDraftConversionSchema
>;

export const taskDraftCommitItemSchema = z.object({
  draftId: z.string().uuid(),
  status: z.enum(["created", "reused", "failed"]),
  taskId: z.string().uuid().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
});
export type TaskDraftCommitItem = z.infer<typeof taskDraftCommitItemSchema>;

export const taskDraftCommitResultSchema = z.object({
  batchId: z.string().uuid(),
  status: z.enum(["committed", "partial", "failed"]),
  items: z.array(taskDraftCommitItemSchema),
});
export type TaskDraftCommitResult = z.infer<
  typeof taskDraftCommitResultSchema
>;
