import { z } from "zod";
import { taskSchema, type Task, type TaskPriority } from "./platform.js";

export const taskQueueBlockedReasonSchema = z.enum([
  "dependency",
  "paused",
  "blocked",
  "needs-input",
  "active-run",
  "active-claim",
  "project-archived",
]);
export type TaskQueueBlockedReason = z.infer<
  typeof taskQueueBlockedReasonSchema
>;

export const taskQueueItemSchema = z.object({
  task: taskSchema,
  eligible: z.boolean(),
  blockedReasons: z.array(taskQueueBlockedReasonSchema),
  position: z.number().int().positive(),
});
export type TaskQueueItem = z.infer<typeof taskQueueItemSchema>;

export const taskClaimSchema = z.object({
  task: taskSchema,
  claimToken: z.string().uuid(),
  ownerId: z.string().trim().min(1).max(180),
  expiresAt: z.string().datetime({ offset: true }),
  revision: z.number().int().positive(),
});
export type TaskClaim = z.infer<typeof taskClaimSchema>;

export const claimTaskInputSchema = z.object({
  ownerId: z
    .string()
    .trim()
    .min(1)
    .max(180)
    .regex(/^[a-zA-Z0-9_.:-]+$/),
  leaseSeconds: z.number().int().min(5).max(3_600).default(60),
});
export type ClaimTaskInput = z.infer<typeof claimTaskInputSchema>;

export const releaseTaskClaimInputSchema = z.object({
  claimToken: z.string().uuid(),
});
export type ReleaseTaskClaimInput = z.infer<typeof releaseTaskClaimInputSchema>;

const expectedRevisionSchema = z.number().int().positive().optional();

export const pauseTaskInputSchema = z.object({
  reason: z.string().trim().min(1).max(4_000).default("用户暂停任务"),
  expectedRevision: expectedRevisionSchema,
});
export type PauseTaskInput = z.infer<typeof pauseTaskInputSchema>;

export const blockTaskInputSchema = z.object({
  reason: z.string().trim().min(1).max(4_000),
  expectedRevision: expectedRevisionSchema,
});
export type BlockTaskInput = z.infer<typeof blockTaskInputSchema>;

export const requestTaskInputSchema = z.object({
  prompt: z.string().trim().min(1).max(20_000),
  expectedRevision: expectedRevisionSchema,
});
export type RequestTaskInput = z.infer<typeof requestTaskInputSchema>;

export const provideTaskInputSchema = z.object({
  content: z.string().trim().min(1).max(20_000),
  expectedRevision: expectedRevisionSchema,
});
export type ProvideTaskInput = z.infer<typeof provideTaskInputSchema>;

export const resumeTaskInputSchema = z.object({
  note: z.string().trim().max(4_000).default(""),
  expectedRevision: expectedRevisionSchema,
});
export type ResumeTaskInput = z.infer<typeof resumeTaskInputSchema>;

export const submitTaskInputSchema = z.object({
  note: z.string().trim().max(4_000).default(""),
  expectedRevision: expectedRevisionSchema,
});
export type SubmitTaskInput = z.infer<typeof submitTaskInputSchema>;

export const resetTaskSessionInputSchema = z.object({
  reason: z.string().trim().max(4_000).default(""),
});
export type ResetTaskSessionInput = z.infer<typeof resetTaskSessionInputSchema>;

export const sceneSessionResetResultSchema = z.object({
  sceneType: z.literal("task"),
  sceneId: z.string().uuid(),
  previousSessionId: z.string().uuid().nullable(),
  session: z.object({
    id: z.string().uuid(),
    sessionHandle: z.string(),
    generation: z.number().int().nonnegative(),
    status: z.enum(["active", "archived", "reset"]),
    createdAt: z.string().datetime({ offset: true }),
  }),
});
export type SceneSessionResetResult = z.infer<
  typeof sceneSessionResetResultSchema
>;

export const taskDocumentSchema = z.object({
  attachmentId: z.string().uuid(),
  taskId: z.string().uuid(),
  projectId: z.string().uuid(),
  name: z.string(),
  documentPath: z.string(),
  mimeType: z.string(),
  size: z.number().int().nonnegative(),
  sha256: z.string().length(64),
  archivedAt: z.string().datetime({ offset: true }).nullable(),
  createdAt: z.string().datetime({ offset: true }),
});
export type TaskDocument = z.infer<typeof taskDocumentSchema>;

export const taskDocumentDiscoverySchema = z.object({
  items: z.array(taskDocumentSchema),
  scope: z.literal("task"),
  includeArchived: z.boolean(),
});
export type TaskDocumentDiscovery = z.infer<typeof taskDocumentDiscoverySchema>;

export const revealTaskDocumentResultSchema = z.object({
  document: taskDocumentSchema,
  revealPath: z.string(),
  scopedTo: z.object({
    projectId: z.string().uuid(),
    taskId: z.string().uuid(),
  }),
});
export type RevealTaskDocumentResult = z.infer<
  typeof revealTaskDocumentResultSchema
>;

const priorityRank: Record<TaskPriority, number> = {
  low: 1,
  medium: 2,
  high: 3,
  urgent: 4,
};

export function compareTaskQueuePriority(
  left: Pick<Task, "priority" | "createdAt" | "id">,
  right: Pick<Task, "priority" | "createdAt" | "id">,
): number {
  const priority = priorityRank[right.priority] - priorityRank[left.priority];
  if (priority !== 0) return priority;
  const createdAt = left.createdAt.localeCompare(right.createdAt);
  return createdAt === 0 ? left.id.localeCompare(right.id) : createdAt;
}

export function inferDeliveryTarget(input: {
  readonly assigneeAgentId: string;
  readonly mentions: readonly string[];
  readonly explicit?: "receiver" | "collaborators" | "broadcast";
}): "receiver" | "collaborators" | "broadcast" {
  if (input.explicit !== undefined) return input.explicit;
  if (input.mentions.length === 0) return "receiver";
  const mentionsReceiver = input.mentions.includes(input.assigneeAgentId);
  const mentionsCollaborator = input.mentions.some(
    (id) => id !== input.assigneeAgentId,
  );
  if (mentionsReceiver && mentionsCollaborator) return "broadcast";
  if (mentionsCollaborator) return "collaborators";
  return "receiver";
}
