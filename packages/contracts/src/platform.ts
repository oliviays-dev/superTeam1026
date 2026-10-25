import { z } from "zod";

export const projectStatusSchema = z.enum(["active", "archived"]);
export type ProjectStatus = z.infer<typeof projectStatusSchema>;

export const projectSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(160),
  code: z.string().trim().min(1).max(40),
  description: z.string().max(2_000).default(""),
  status: projectStatusSchema.default("active"),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type Project = z.infer<typeof projectSchema>;

export const createProjectInputSchema = z.object({
  name: z.string().trim().min(1).max(160),
  code: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .regex(/^[A-Z][A-Z0-9-]*$/)
    .optional(),
  description: z.string().trim().max(2_000).default(""),
});
export type CreateProjectInput = z.infer<typeof createProjectInputSchema>;

export const taskStatusSchema = z.enum([
  "queued",
  "in_progress",
  "review",
  "done",
  "cancelled",
]);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const taskSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  title: z.string().trim().min(1).max(240),
  description: z.string().trim().min(1).max(20_000),
  acceptance: z.array(z.string().trim().min(1).max(1_000)).max(50),
  status: taskStatusSchema,
  agentId: z.string().uuid(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type Task = z.infer<typeof taskSchema>;

export const createTaskInputSchema = z.object({
  projectId: z.string().uuid(),
  title: z.string().trim().min(1).max(240),
  description: z.string().trim().min(1).max(20_000),
  acceptance: z.array(z.string().trim().min(1).max(1_000)).max(50).default([]),
  agentId: z.string().uuid().optional(),
});
export type CreateTaskInput = z.infer<typeof createTaskInputSchema>;

export const runtimeKindSchema = z.enum([
  "fake",
  "dsh-sdk",
  "codex-jsonl",
  "plain-text",
]);
export type RuntimeKind = z.infer<typeof runtimeKindSchema>;

export const agentSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(160),
  description: z.string().max(2_000),
  runtimeKind: runtimeKindSchema,
  status: z.enum(["active", "disabled"]),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type Agent = z.infer<typeof agentSchema>;

export const runStatusSchema = z.enum([
  "queued",
  "running",
  "waiting_approval",
  "completed",
  "failed",
  "cancelled",
  "timeout",
  "interrupted",
]);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const terminalRunStatuses = [
  "completed",
  "failed",
  "cancelled",
  "timeout",
  "interrupted",
] as const satisfies readonly RunStatus[];

export const runObservabilitySchema = z.object({
  planVisibility: z.enum(["structured", "summary", "opaque"]),
  toolEventCompleteness: z.enum(["complete", "partial", "none"]),
  textStreaming: z.enum(["delta", "message", "final-only"]),
  subagentVisibility: z.enum(["structured", "summary", "none"]),
});
export type RunObservability = z.infer<typeof runObservabilitySchema>;

export const runInputSnapshotSchema = z.object({
  taskTitle: z.string(),
  taskDescription: z.string(),
  acceptance: z.array(z.string()),
  instruction: z.string(),
  agentName: z.string(),
  runtimeKind: runtimeKindSchema,
});
export type RunInputSnapshot = z.infer<typeof runInputSnapshotSchema>;

export const runSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  taskId: z.string().uuid(),
  agentId: z.string().uuid(),
  status: runStatusSchema,
  inputSnapshot: runInputSnapshotSchema,
  output: z.string().nullable(),
  error: z.string().nullable(),
  observability: runObservabilitySchema,
  createdAt: z.string().datetime({ offset: true }),
  startedAt: z.string().datetime({ offset: true }).nullable(),
  endedAt: z.string().datetime({ offset: true }).nullable(),
  updatedAt: z.string().datetime({ offset: true }),
});
export type Run = z.infer<typeof runSchema>;

export const platformRunEventTypeSchema = z.enum([
  "run.queued",
  "run.started",
  "input.snapshot",
  "context.ready",
  "plan.snapshot",
  "step.started",
  "step.completed",
  "step.failed",
  "tool.call",
  "tool.result",
  "subagent.started",
  "subagent.completed",
  "approval.requested",
  "approval.decided",
  "artifact.created",
  "progress.summary",
  "warning",
  "error",
  "run.completed",
  "run.failed",
  "run.cancelled",
]);
export type PlatformRunEventType = z.infer<typeof platformRunEventTypeSchema>;

export const platformRunEventSchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  seq: z.number().int().positive(),
  type: platformRunEventTypeSchema,
  visibility: z.enum(["public", "restricted", "admin-only"]),
  summary: z.string().min(1).max(20_000),
  data: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string().datetime({ offset: true }),
});
export type PlatformRunEvent = z.infer<typeof platformRunEventSchema>;

export const runDeltaSchema = z.object({
  runId: z.string().uuid(),
  seq: z.number().int().positive(),
  text: z.string(),
  createdAt: z.string().datetime({ offset: true }),
});
export type RunDelta = z.infer<typeof runDeltaSchema>;

export const runDetailSchema = z.object({
  run: runSchema,
  events: z.array(platformRunEventSchema),
});
export type RunDetail = z.infer<typeof runDetailSchema>;

export const apiErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  requestId: z.string(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
